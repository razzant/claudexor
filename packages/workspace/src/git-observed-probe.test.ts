import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gitObserved, GitOperationError } from "./git-observed.js";

const repos: string[] = [];
afterAll(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-git-probe-"));
  repos.push(dir);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  return dir;
}

/** A Git child that prints nothing for `seconds` (a shell alias Git runs and waits for). */
const silentGit = (seconds: number) => ["-c", `alias.idle=!sleep ${seconds}`, "idle"];

describe.runIf(process.platform !== "win32")("git stall watchdog probe (#688)", () => {
  it("never overlaps a pending probe and never counts it as progress", async () => {
    let calls = 0;
    // The baseline completes before the child starts; every later probe hangs.
    const progress = () => {
      calls += 1;
      return calls === 1 ? Promise.resolve(0) : new Promise<number>(() => {});
    };
    const started = Date.now();
    const error = await gitObserved(repo(), silentGit(5), {
      label: "idle",
      stallMs: 200,
      progress,
    }).catch((caught: unknown) => caught);
    // Direction 1: the pending probe is no progress, so the silent child stalls.
    expect(error).toBeInstanceOf(GitOperationError);
    expect((error as GitOperationError).code).toBe("capture_git_stalled");
    expect(Date.now() - started).toBeLessThan(4_000);
    // Direction 2: ticks every 50 ms for at least 200 ms started no second probe
    // while the first was pending: the baseline plus exactly one.
    expect(calls).toBe(2);
  });

  it("keeps a silent child alive while completed probes show progress", async () => {
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const progress = async () => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return calls;
    };
    // Silent three times longer than the stall bound, yet every probe moved.
    const result = await gitObserved(repo(), silentGit(0.6), {
      label: "idle",
      stallMs: 200,
      progress,
    });
    expect(result.code).toBe(0);
    expect(calls).toBeGreaterThan(3);
    expect(maxInFlight).toBe(1);
  });
});
