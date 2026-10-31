import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readWoMailQuotaStatus,
  withWoMailQuota,
  WO_MAIL_DAILY_QUOTA,
  WO_MAIL_QUOTA_FILE,
  WoMailQuotaExceededError,
} from "./quota.ts";

const directories: string[] = [];
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "wo-mail-quota-"));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Wo Mail daily quota", () => {
  it("persists successful sends by normalized account without storing the email in plaintext", async () => {
    const directory = fixture();
    const now = new Date(2026, 9, 20, 23, 59);

    await withWoMailQuota(directory, " 13800138000@WO.CN ", async () => ({ ok: true }), now);

    expect(readWoMailQuotaStatus(directory, "13800138000@wo.cn", now)).toEqual({
      dailyQuota: 50,
      todaySent: 1,
    });
    expect(readFileSync(join(directory, WO_MAIL_QUOTA_FILE), "utf8")).not.toContain("13800138000@wo.cn");
  });

  it("rolls back failed sends and resets on the next local calendar day", async () => {
    const directory = fixture();
    const firstDay = new Date(2026, 9, 20, 23, 59);

    await withWoMailQuota(directory, "a@wo.cn", async () => ({ ok: false, error: "smtp" }), firstDay);
    expect(readWoMailQuotaStatus(directory, "a@wo.cn", firstDay).todaySent).toBe(0);

    await withWoMailQuota(directory, "a@wo.cn", async () => ({ ok: true }), firstDay);
    expect(readWoMailQuotaStatus(directory, "a@wo.cn", new Date(2026, 9, 21, 0, 1)).todaySent).toBe(0);
  });

  it("serializes concurrent sends so no caller crosses the daily limit", async () => {
    const directory = fixture();
    const now = new Date(2026, 9, 20, 12);
    const calls = Array.from({ length: WO_MAIL_DAILY_QUOTA + 4 }, () =>
      withWoMailQuota(directory, "a@wo.cn", async () => ({ ok: true }), now),
    );
    const results = await Promise.allSettled(calls);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(WO_MAIL_DAILY_QUOTA);
    expect(
      results.filter(
        (result) => result.status === "rejected" && result.reason instanceof WoMailQuotaExceededError,
      ),
    ).toHaveLength(4);
    expect(readWoMailQuotaStatus(directory, "a@wo.cn", now).todaySent).toBe(WO_MAIL_DAILY_QUOTA);
  });

  it("fails closed instead of replacing corrupted state", () => {
    const directory = fixture();
    const file = join(directory, WO_MAIL_QUOTA_FILE);
    writeFileSync(file, "{broken", { mode: 0o600 });

    expect(() => readWoMailQuotaStatus(directory, "a@wo.cn")).toThrow();
    expect(readFileSync(file, "utf8")).toBe("{broken");
  });
});
