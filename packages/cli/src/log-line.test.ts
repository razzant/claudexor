import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { processTiming } from "@claudexor/util";
import { logLine } from "./log-line.js";

const root = mkdtempSync(join(tmpdir(), "claudexor-log-line-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

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
});
