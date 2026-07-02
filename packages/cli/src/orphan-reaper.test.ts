import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reapRecordedOrphans, writePidsSnapshot } from "./orphan-reaper.js";

describe("orphan reaper", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("kills a recorded orphan whose command still matches, and skips recycled pids", async () => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-reaper-"));
    const pidsPath = join(dir, "pids.json");
    // A real detached sleeper stands in for a surviving harness child.
    const orphan = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    orphan.unref();
    const orphanPid = orphan.pid as number;
    // A second entry records a pid that now belongs to a DIFFERENT command
    // (this test process) — the recycling guard must skip it.
    writeFileSync(
      pidsPath,
      JSON.stringify({
        pids: [
          { pid: orphanPid, cmd: "sleep" },
          { pid: process.pid, cmd: "definitely-not-node" },
        ],
      }),
    );
    const actions = reapRecordedOrphans(pidsPath);
    expect(actions.some((a) => a.includes(`${orphanPid}`) && a.includes("SIGTERM"))).toBe(true);
    expect(actions.some((a) => a.includes("recycled"))).toBe(true);
    expect(existsSync(pidsPath)).toBe(false); // snapshot consumed
    // The orphan (or its group) dies.
    const deadline = Date.now() + 5_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(orphanPid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 15_000);

  it("writePidsSnapshot writes live children and clears the file when none remain", () => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-reaper-"));
    const pidsPath = join(dir, "pids.json");
    // The registry is process-global; with no live spawnProcess children the
    // snapshot must remove a stale file rather than leave it behind.
    writeFileSync(pidsPath, JSON.stringify({ pids: [{ pid: 1, cmd: "stale" }] }));
    writePidsSnapshot(pidsPath);
    expect(existsSync(pidsPath)).toBe(false);
  });

  it("tolerates a corrupt pids file", () => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-reaper-"));
    const pidsPath = join(dir, "pids.json");
    writeFileSync(pidsPath, "{ nope");
    expect(reapRecordedOrphans(pidsPath)).toEqual([]);
    // Corrupt file stays for manual inspection (no destructive cleanup).
    expect(readFileSync(pidsPath, "utf8")).toContain("nope");
  });
});
