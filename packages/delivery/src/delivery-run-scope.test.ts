/**
 * run-deadline/1: an in-run delivery's own children (Git here) join the
 * delivering run's boundary. The orchestrator delivers inside
 * `withinRunScope(runScopeMarker, ...)`; every launch of the delivery then
 * carries the run's marker (and enters its cgroup where one is proven).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintRunScopeMarker, onChildProcessRegistered, withinRunScope } from "@claudexor/core";
import { afterAll, describe, expect, it } from "vitest";
import { checkPatch } from "./index.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);

describe("in-run delivery launches", () => {
  it("carry the delivering run's scope marker; outside a run they carry none of it", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cx-delivery-scope-"));
    dirs.push(repo);
    execFileSync("git", ["init", "-q", repo]);
    const marker = mintRunScopeMarker();
    const seen: Array<{ cmd: string; marker: string | undefined }> = [];
    const stop = onChildProcessRegistered((child) =>
      seen.push({ cmd: child.cmd, marker: child.scopeMarker }),
    );
    try {
      await withinRunScope(marker, () => checkPatch(repo, ""));
      const inRun = seen.splice(0);
      expect(inRun.length).toBeGreaterThan(0);
      expect(inRun.every((entry) => entry.marker === marker)).toBe(true);
      await checkPatch(repo, "");
      expect(seen.some((entry) => entry.marker === marker)).toBe(false);
    } finally {
      stop();
    }
  });
});
