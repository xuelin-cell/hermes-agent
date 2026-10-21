import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const WO_MAIL_DAILY_QUOTA = 50;
export const WO_MAIL_QUOTA_FILE = "agent-mail-quota.json";
export interface WoMailQuotaStatus {
  dailyQuota: number;
  todaySent: number;
}
interface QuotaEntry {
  date: string;
  sent: number;
}
interface QuotaDocument {
  version: 1;
  salt: string;
  accounts: Record<string, QuotaEntry>;
}

function localDateKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function assertDirectory(dataDir: string): string {
  const directory = resolve(dataDir);
  const parent = dirname(directory);
  if (!existsSync(parent) || !lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink())
    throw new Error("Invalid Wo Mail quota storage directory.");
  if (existsSync(directory)) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid Wo Mail quota storage directory.");
  } else mkdirSync(directory, { recursive: false, mode: 0o700 });
  return directory;
}

function filePath(dataDir: string): string {
  return join(assertDirectory(dataDir), WO_MAIL_QUOTA_FILE);
}
function accountKey(salt: string, email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error("Wo Mail quota requires an account email.");
  return createHash("sha256").update(`${salt}\0${normalized}`).digest("hex");
}
function fresh(): QuotaDocument {
  return { version: 1, salt: randomBytes(32).toString("hex"), accounts: {} };
}

function readDocument(dataDir: string): QuotaDocument {
  const file = filePath(dataDir);
  if (!existsSync(file)) return fresh();
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error("Invalid Wo Mail quota storage file.");
  const value = JSON.parse(readFileSync(file, "utf8")) as QuotaDocument;
  if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.salt) || !value.accounts || Array.isArray(value.accounts))
    throw new Error("Invalid Wo Mail quota storage data.");
  for (const [key, row] of Object.entries(value.accounts)) {
    if (
      !/^[a-f0-9]{64}$/.test(key) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row?.date) ||
      !Number.isInteger(row?.sent) ||
      row.sent < 0 ||
      row.sent > WO_MAIL_DAILY_QUOTA
    )
      throw new Error("Invalid Wo Mail quota storage data.");
  }
  return value;
}

function writeDocument(dataDir: string, document: QuotaDocument): void {
  const file = filePath(dataDir);
  const temporary = join(dirname(file), `.${WO_MAIL_QUOTA_FILE}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(document)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

async function lock<T>(dataDir: string, operation: () => T): Promise<T> {
  const lockPath = `${filePath(dataDir)}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        return operation();
      } finally {
        closeSync(fd);
        rmSync(lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(lockPath);
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw lockError;
      }

      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid Wo Mail quota lock file.");
      if (Date.now() - stat.mtimeMs > 120_000) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Wo Mail quota ledger is busy.");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function count(document: QuotaDocument, email: string, now: Date): number {
  const row = document.accounts[accountKey(document.salt, email)];
  return row?.date === localDateKey(now) ? row.sent : 0;
}
export function readWoMailQuotaStatus(dataDir: string, email: string, now = new Date()): WoMailQuotaStatus {
  return { dailyQuota: WO_MAIL_DAILY_QUOTA, todaySent: count(readDocument(dataDir), email, now) };
}
async function change(dataDir: string, email: string, delta: 1 | -1, now: Date): Promise<void> {
  await lock(dataDir, () => {
    const document = readDocument(dataDir);
    const key = accountKey(document.salt, email);
    const current = count(document, email, now);
    if (delta === 1 && current >= WO_MAIL_DAILY_QUOTA) throw new WoMailQuotaExceededError();
    document.accounts[key] = { date: localDateKey(now), sent: Math.max(0, current + delta) };
    writeDocument(dataDir, document);
  });
}

/** Reserve before SMTP so a crash cannot silently bypass the daily limit; roll back known failures. */
export async function withWoMailQuota<T>(
  dataDir: string,
  email: string,
  send: () => Promise<{ ok: boolean } & T>,
  now = new Date(),
): Promise<{ ok: boolean } & T> {
  await change(dataDir, email, 1, now);
  try {
    const result = await send();
    if (!result.ok) await change(dataDir, email, -1, now);
    return result;
  } catch (error) {
    await change(dataDir, email, -1, now);
    throw error;
  }
}
export class WoMailQuotaExceededError extends Error {
  constructor() {
    super(`Wo Mail daily sending limit of ${WO_MAIL_DAILY_QUOTA} messages has been reached.`);
  }
}
