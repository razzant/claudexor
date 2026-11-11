import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claudeStatuslineSnapshotPath,
  ingestClaudeStatuslineQuota,
  parseClaudeStatuslineQuota,
  refreshClaudeStatuslineQuota,
  runClaudeStatuslineCollector,
} from "./claude-statusline.js";

const roots: string[] = [];
const originalConfig = process.env.CLAUDEXOR_CONFIG_DIR;

afterEach(() => {
  if (originalConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = originalConfig;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

describe("Claude official statusline quota source", () => {
  it("persists only allowlisted subscription windows and provenance", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-claude-statusline-"));
    roots.push(root);
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    await expect(refreshClaudeStatuslineQuota()).rejects.toThrow("not available");
    const input = {
      session_id: "must-not-persist",
      cwd: "/private/project",
      api_key: "must-not-persist",
      rate_limits: {
        five_hour: { used_percentage: 12.5, resets_at: 1_800_000_000, extra: "drop" },
        seven_day: { used_percentage: 40, resets_at: 1_800_086_400 },
        unknown_window: { used_percentage: 1 },
      },
    };

    const snapshot = ingestClaudeStatuslineQuota(input, new Date("2026-07-15T12:00:00Z"));
    expect(snapshot).toMatchObject({
      subject: { harness: "claude", credential_route: "vendor_native" },
      source: "claude_statusline",
      constraints: [
        { id: "five_hour", used_ratio: 0.125, window_seconds: 18_000 },
        { id: "seven_day", used_ratio: 0.4, window_seconds: 604_800 },
      ],
    });
    const stored = readFileSync(claudeStatuslineSnapshotPath(), "utf8");
    expect(stored).not.toContain("session_id");
    expect(stored).not.toContain("must-not-persist");
    await expect(refreshClaudeStatuslineQuota()).resolves.toEqual({ snapshots: [snapshot] });
  });

  it("re-stamps the spool snapshot onto the migrated row id (no null-subject resurrection)", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-claude-statusline-mig-"));
    roots.push(root);
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    // Spool written by the statusline collector BEFORE (or after) migration
    // stamps subject_id: null — the default store's session.
    ingestClaudeStatuslineQuota({
      rate_limits: { five_hour: { used_percentage: 25, resets_at: 1_800_000_000 } },
    });
    const { accountsMigrationFilePath } = await import("./accounts-unified-migration.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(accountsMigrationFilePath(), ".."), { recursive: true });
    writeFileSync(
      accountsMigrationFilePath(),
      JSON.stringify({
        claude: {
          phase: "completed",
          row_id: "claude-default",
          legacy_aliases: [null],
          locator: join(root, "native", "claude", "default"),
          backup_ref: null,
        },
      }),
    );
    // Post-migration refresh: the default store IS the migrated row, so the
    // snapshot carries the row id — never {claude, null} again.
    const result = await refreshClaudeStatuslineQuota();
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.subject.subject_id).toBe("claude-default");
    expect(result.snapshots.some((s) => s.subject.subject_id === null)).toBe(false);
  });

  it("stays unknown when the official subscriber fields are absent or invalid", () => {
    expect(parseClaudeStatuslineQuota({ model: { id: "claude" } })).toBeNull();
    expect(
      parseClaudeStatuslineQuota({ rate_limits: { five_hour: { used_percentage: 101 } } }),
    ).toBeNull();
  });

  it("forwards the exact payload to a composed existing statusline", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-claude-compose-"));
    roots.push(root);
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    const upstream = Buffer.from("cat", "utf8").toString("base64url");
    const raw = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 9 } } });

    await runClaudeStatuslineCollector(raw, upstream);

    expect(output).toBe(raw);
  });
});
