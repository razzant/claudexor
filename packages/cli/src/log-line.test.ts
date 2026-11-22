import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { processTiming } from "@claudexor/util";
import { logLine } from "./log-line.js";
import { openDaemonStartupDiagnosticsAfterAuthority } from "./startup-diagnostics.js";

const root = mkdtempSync(join(tmpdir(), "claudexor-log-line-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const context = {
  runtimeVersion: "3.3.15",
  buildSha: "a".repeat(40),
  entryPath: join(root, "claudexord.js"),
  pid: 4242,
  dataRoot: root,
  launchSource: "cli_ensure_daemon",
};

describe("logLine (#688)", () => {
  it("appends one timestamped line synchronously and names the append in worstSync", () => {
    const recorded = vi.spyOn(processTiming, "recordSync");
    try {
      const path = join(root, "claudexord.log");
      logLine(path, "first");
      logLine(path, "second");
      // Synchronous: both lines are on disk when the calls return, in order.
      const lines = readFileSync(path, "utf8").trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\] first$/);
      expect(lines[1]).toMatch(/\] second$/);
      expect(recorded.mock.calls.filter(([op]) => op === "daemon.log_line")).toHaveLength(2);
    } finally {
      recorded.mockRestore();
    }
  });

  it("never throws when the log cannot be written", () => {
    expect(() => logLine(join(root, "missing", "dir", "claudexord.log"), "lost")).not.toThrow();
  });

  it("routes through the bounded writer: no generation passes its cap, even after reopen", () => {
    const path = join(root, "owned.log");
    const cap = 4 * 1024;
    const options = { path, maxCurrentBytes: cap, maxRecordBytes: 512 };
    const sizes = () => [path, `${path}.1`].map((p) => (existsSync(p) ? statSync(p).size : 0));
    const exercise = (label: string) => {
      const writer = openDaemonStartupDiagnosticsAfterAuthority(context, options);
      try {
        for (let i = 0; i < 40; i += 1) {
          // The interleaving that once let a plain append push a generation past its cap.
          logLine(path, `${label} quota.observation ${"q".repeat(i * 7)}`);
          for (const size of sizes()) expect(size).toBeLessThanOrEqual(cap);
          expect(writer.record({ stage: "sql_runtime", message: `${label} ${i}` })).toBe(true);
          for (const size of sizes()) expect(size).toBeLessThanOrEqual(cap);
        }
      } finally {
        writer.close();
      }
    };
    exercise("first-life");
    exercise("second-life");
    // A reopen found no oversize generation, so nothing was discarded.
    expect(readFileSync(`${path}.1`, "utf8")).not.toContain("diagnostic_legacy_log_discarded");
    expect(readFileSync(path, "utf8")).toContain("second-life");
    // After its writer closed, the target is not reopened by a plain append.
    const before = sizes();
    logLine(path, "late line after close");
    expect(sizes()).toEqual(before);
  });
});
