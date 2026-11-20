/** run-deadline/1: the bundled engine's warden role never falls through to daemon startup. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("claudexord --run-deadline-warden", () => {
  it("runs the warden for a state file and never starts the daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-wre-"));
    dirs.push(dir);
    const state = join(dir, "job.json");
    writeFileSync(
      state,
      JSON.stringify({
        version: 2,
        jobId: "job",
        clock: "monotonic",
        bootId: null,
        own: { at: new Date().toISOString(), targetNs: "9000000000000000000" },
        revision: 0,
        parent: null,
        inherited: null,
        frozen: null,
        markers: [],
        cgroup: null,
        runScopes: null,
        // The run ended and owns no marker: the group is confirmed empty at once.
        released: true,
      }),
    );
    let daemonStarts = 0;
    await dispatchClaudexordEntry(
      async () => {
        daemonStarts += 1;
      },
      [WARDEN_ENTRY_ROLE, state],
      deps,
    );
    expect(daemonStarts).toBe(0);
    expect(existsSync(`${state}.ready`)).toBe(true);
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
