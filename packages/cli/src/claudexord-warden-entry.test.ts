/** run-deadline/1: the bundled engine's warden role never falls through to daemon startup. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WARDEN_ENTRY_ROLE } from "@claudexor/daemon";
import { dispatchClaudexordEntry } from "./claudexord-entry.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);

const deps = {
  setupAttach: async () => {
    throw new Error("setup must not run");
  },
  beltServe: async () => false,
};

/** Poll `done` every 10 ms; fail after `ms` instead of waiting on the test timeout. */
async function until(done: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("claudexord --run-deadline-warden", () => {
  it("runs the warden for a deadline record and never starts the daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-wre-"));
    dirs.push(dir);
    const state = join(dir, "job.json");
    writeFileSync(
      state,
      JSON.stringify({
        version: 3,
        jobId: "job",
        clock: "monotonic",
        bootId: null,
        // The run ended, but it names no marker, no cgroup and no run-scope index:
        // nothing observes its boundary, so the warden must not confirm it empty.
        // It stays to its (unreachable) deadline unless its record is removed.
        state: "closed",
        revision: 0,
        own: { at: new Date().toISOString(), targetNs: "9000000000000000000" },
        successorOf: null,
        parent: null,
        parentJobId: null,
        inherited: null,
        frozen: null,
        markers: [],
        cgroup: null,
        runScopes: null,
      }),
    );
    const previous = process.exitCode;
    let daemonStarts = 0;
    let settled = false;
    const entry = dispatchClaudexordEntry(
      async () => {
        daemonStarts += 1;
      },
      [WARDEN_ENTRY_ROLE, state],
      deps,
    ).finally(() => {
      settled = true;
    });
    let exitCode = previous;
    try {
      // The warden reports itself ready in this process, then parks in its poll.
      await until(() => existsSync(`${state}.ready`) || settled, "the warden's ready file");
      expect(settled, "the warden left although nothing confirmed its boundary").toBe(false);
      expect(JSON.parse(readFileSync(`${state}.ready`, "utf8"))).toMatchObject({
        pid: process.pid,
      });
    } finally {
      // Its one exit here, also on failure: at its next poll it finds no record and leaves.
      rmSync(state, { force: true });
      await until(() => settled, "the warden to leave after its record was removed");
      exitCode = process.exitCode;
      process.exitCode = previous;
    }
    await entry;
    expect(daemonStarts).toBe(0);
    expect(exitCode).toBe(previous);
  });

  it("refuses a malformed warden invocation with usage, never the daemon", async () => {
    const previous = process.exitCode;
    let daemonStarts = 0;
    try {
      await dispatchClaudexordEntry(
        async () => {
          daemonStarts += 1;
        },
        [WARDEN_ENTRY_ROLE],
        deps,
      );
      expect(process.exitCode).toBe(2);
      expect(daemonStarts).toBe(0);
    } finally {
      process.exitCode = previous;
    }
  });
});
