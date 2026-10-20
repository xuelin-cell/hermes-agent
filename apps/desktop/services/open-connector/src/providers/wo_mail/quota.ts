import { createHash, randomUUID } from "node:crypto";
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
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

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
  accounts: Record<string, QuotaEntry>;
}

const emptyDocument = (): QuotaDocument => ({ version: 1, accounts: {} });
const quotaQueues = new Map<string, Promise<void>>();

function localDateKey(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function accountKey(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Wo Mail quota requires an account email.");
  }
  return createHash("sha256").update(normalized).digest("hex");
}

function quotaPath(dataDir: string): string {
  if (!dataDir.trim()) {
    throw new Error("Wo Mail quota storage directory is unavailable.");
  }
  return join(dataDir, WO_MAIL_QUOTA_FILE);
}

function readDocument(dataDir: string): QuotaDocument {
  const file = quotaPath(dataDir);
  if (!existsSync(file)) {
    return emptyDocument();
  }

  const fileStat = lstatSync(file);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || statSync(file).size > 1024 * 1024) {
    throw new Error("Invalid Wo Mail quota storage file.");
  }

  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<QuotaDocument>;
  if (parsed.version !== 1 || !parsed.accounts || typeof parsed.accounts !== "object" || Array.isArray(parsed.accounts)) {
    throw new Error("Invalid Wo Mail quota storage data.");
  }

  for (const [key, value] of Object.entries(parsed.accounts)) {
    if (
      !/^[a-f0-9]{64}$/.test(key) ||
      !value ||
      typeof value !== "object" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
      !Number.isInteger(value.sent) ||
      value.sent < 0 ||
      value.sent > WO_MAIL_DAILY_QUOTA
    ) {
      throw new Error("Invalid Wo Mail quota storage data.");
    }
  }

  return parsed as QuotaDocument;
}

function writeDocument(dataDir: string, document: QuotaDocument): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = quotaPath(dataDir);
  const temporary = join(dataDir, `.${WO_MAIL_QUOTA_FILE}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;

  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(document)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    rmSync(temporary, { force: true });
  }
}

function countFor(document: QuotaDocument, email: string, now: Date): number {
  const entry = document.accounts[accountKey(email)];
  return entry?.date === localDateKey(now) ? entry.sent : 0;
}

export function readWoMailQuotaStatus(dataDir: string, email: string, now = new Date()): WoMailQuotaStatus {
  return {
    dailyQuota: WO_MAIL_DAILY_QUOTA,
    todaySent: countFor(readDocument(dataDir), email, now),
  };
}

function writeCount(dataDir: string, email: string, sent: number, now: Date): void {
  const document = readDocument(dataDir);
  document.accounts[accountKey(email)] = { date: localDateKey(now), sent };
  writeDocument(dataDir, document);
}

async function queued<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = quotaQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  quotaQueues.set(key, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (quotaQueues.get(key) === tail) {
      quotaQueues.delete(key);
    }
  }
}

/**
 * Reserve one restart-safe daily slot around a real SMTP operation.
 *
 * The reservation is persisted before network I/O so restarting the process
 * cannot bypass the limit. An ordinary failed send rolls it back; a process
 * crash remains conservatively charged because SMTP delivery is then unknown.
 */
export async function withWoMailQuota<T>(
  dataDir: string,
  email: string,
  send: () => Promise<{ ok: boolean } & T>,
  now = new Date(),
): Promise<{ ok: boolean } & T> {
  const key = `${quotaPath(dataDir)}\0${accountKey(email)}`;
  return queued(key, async () => {
    const sent = readWoMailQuotaStatus(dataDir, email, now).todaySent;
    if (sent >= WO_MAIL_DAILY_QUOTA) {
      throw new WoMailQuotaExceededError();
    }

    writeCount(dataDir, email, sent + 1, now);
    try {
      const result = await send();
      if (!result.ok) {
        writeCount(dataDir, email, sent, now);
      }
      return result;
    } catch (error) {
      writeCount(dataDir, email, sent, now);
      throw error;
    }
  });
}

export class WoMailQuotaExceededError extends Error {
  constructor() {
    super(`Wo Mail daily sending limit of ${WO_MAIL_DAILY_QUOTA} messages has been reached.`);
  }
}
