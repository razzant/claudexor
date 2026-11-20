/** The warden loop and the registry's hand-off, with injected clocks and reaper. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScopeReapOptions, ScopeReapOutcome } from "@claudexor/core";
import { afterAll, describe, expect, it } from "vitest";
import { RunDeadlines } from "./run-deadlines.js";
import {
  readWardenOutcome,
  readWardenState,
  runWarden,
  writeJsonAtomic,
  type WardenState,
} from "./run-deadline-warden.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "d-rdw-"));
  dirs.push(dir);
  return dir;
};
const MARKER = `CLAUDEXOR_RUN_SCOPE_${"a".repeat(32)}`;
const state = (patch: Partial<WardenState> = {}): WardenState => ({
  version: 1,
  jobId: "job",
  marker: MARKER,
  at: "2026-11-20T12:00:00.000Z",
  monoTargetNs: "1000000000",
  revision: 0,
  closed: false,
  ...patch,
});
const settled = { settled: true, ended: [{ pid: 1, startToken: "x" }], survivors: [] };

describe("runWarden", () => {
  it("acts only after target + head start, with a full (wall-clock free) census", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, state());
    let mono = 0n;
    const reaps: ScopeReapOptions[] = [];
    const result = await runWarden(path, {
      monoNow: () => mono,
      sleep: async () => {
        mono += 200_000_000n;
      },
      reap: async (opts) => {
        reaps.push(opts);
        expect(mono).toBeGreaterThanOrEqual(2_000_000_000n); // 1s target + 1s head start
        return settled as unknown as ScopeReapOutcome;
      },
    });
    expect(result).toBe("reaped");
    expect(reaps).toEqual([{ marker: MARKER, scopeStartAt: null }]);
    expect(readWardenOutcome(path)).toMatchObject({ settled: true, ended: 1 });
  });

  it("follows a rewritten (extended) target and exits when the daemon closes the run", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, state());
    let mono = 0n;
    let polls = 0;
    const result = await runWarden(path, {
      monoNow: () => mono,
      sleep: async () => {
        polls += 1;
        mono += 200_000_000n;
        if (polls === 2) writeJsonAtomic(path, state({ monoTargetNs: "60000000000" }));
        if (polls === 20)
          writeJsonAtomic(path, state({ monoTargetNs: "60000000000", closed: true }));
      },
      reap: async () => {
        throw new Error("must not reap a closed run");
      },
    });
    expect(result).toBe("closed");
  });

  it("keeps the last good state through an unreadable file and exits when the file is removed", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, state({ monoTargetNs: "100000000000" }));
    let polls = 0;
    const result = await runWarden(path, {
      monoNow: () => 0n,
      sleep: async () => {
        polls += 1;
        if (polls === 1) writeFileSync(path, "{torn");
        if (polls === 3) rmSync(path);
      },
      reap: async () => {
        throw new Error("must not reap");
      },
    });
    expect(result).toBe("removed");
  });
});

describe("RunDeadlines warden hand-off", () => {
  it("refuses the run when its warden cannot start", async () => {
    const deadlines = new RunDeadlines({
      dir: temp(),
      spawnWarden: async () => {
        throw new Error("spawn refused");
      },
    });
    try {
      deadlines.admit(
        "job",
        { deadline: { at: new Date(Date.now() + 60_000).toISOString() } },
        null,
      );
      await expect(deadlines.attachScope("job", MARKER)).rejects.toThrow("spawn refused");
    } finally {
      deadlines.dispose();
    }
  });

  it("writes the effective monotonic target and the closed hand-back", async () => {
    const dir = temp();
    const started: string[] = [];
    const deadlines = new RunDeadlines({
      dir,
      spawnWarden: async (path) => {
        started.push(path);
        return { pid: 1 };
      },
    });
    try {
      deadlines.admit(
        "job",
        { deadline: { at: new Date(Date.now() + 60_000).toISOString() } },
        null,
      );
      await deadlines.attachScope("job", MARKER);
      const written = readWardenState(started[0]!) as WardenState;
      expect(written).toMatchObject({ jobId: "job", marker: MARKER, closed: false, revision: 0 });
      const remainingNs = BigInt(written.monoTargetNs) - process.hrtime.bigint();
      expect(remainingNs).toBeGreaterThan(55_000_000_000n);
      expect(remainingNs).toBeLessThanOrEqual(60_000_000_000n);
      deadlines.close("job");
      expect(readWardenState(started[0]!)).toMatchObject({ closed: true });
    } finally {
      deadlines.dispose();
    }
  });
});

describe("wardenCommand", () => {
  it("runs the sibling entry of an installed package and the engine bundle in its role", async () => {
    const { wardenCommand, WARDEN_ENTRY_ROLE } = await import("./run-deadline-warden.js");
    expect(wardenCommand("file:///opt/cx/dist/run-deadline-warden.js").args).toEqual([
      "/opt/cx/dist/run-deadline-warden-main.js",
    ]);
    expect(wardenCommand("file:///app/Resources/claudexord.bundle.cjs").args).toEqual([
      "/app/Resources/claudexord.bundle.cjs",
      WARDEN_ENTRY_ROLE,
    ]);
    expect(() => wardenCommand("file:///app/Resources/claudexor.bundle.cjs")).toThrow(
      expect.objectContaining({ code: "run_deadline_warden_unavailable" }),
    );
  });
});
