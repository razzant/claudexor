// #694 V17: two read-only quiet reads of the SAME scope marker, started while
// one is in flight, each answer from their OWN sources. A bare read (marker
// census only, as after a scope's index row is gone) must never serve a read
// that also carries the index row's captured member: that member's
// unreadable birth keeps the second read held.
//
// Nothing here starts, probes or signals a process: the platform's census
// reader is replaced by a deterministic one whose census waits on a gate, and
// the process table is an injected object. `preparationQuiet` itself runs
// unchanged, with its production default reaper.
import { describe, expect, it, vi } from "vitest";
import type { ScopeCensusReader, ScopeCensusResult } from "./process-scope-readers.js";
import type { ProcessTableReader } from "./process-table.js";

let openGate: () => void = () => {};
const gate = new Promise<void>((resolve) => {
  openGate = resolve;
});
const censusCalls: string[][] = [];
const gatedReader: ScopeCensusReader = {
  census: async (markers): Promise<ScopeCensusResult> => {
    censusCalls.push([...markers]);
    await gate;
    return { status: "ok", members: new Map(), unreadable: 0 };
  },
  confirm: async () => false,
};
vi.mock("./process-scope-readers.js", async (original) => ({
  ...(await original<typeof import("./process-scope-readers.js")>()),
  createScopeCensusReader: () => gatedReader,
}));

const { preparationQuiet } = await import("./process-scope-quiet.js");
const { mintRunScopeMarker } = await import("./process-scope.js");

const BIRTH = "Sat Nov 15 10:00:00 2026";
/** The index row's captured member is in the table, but its birth cannot be read now. */
const table: ProcessTableReader = {
  snapshot: async () => [{ pid: 30, ppid: 1, pgid: 30, birth: BIRTH }],
  row: async () => "unreadable",
};

describe("overlapping quiet reads of one marker (#694 V17)", () => {
  it("a bare read in flight does not answer a later read that carries the index row's captured member", async () => {
    const marker = mintRunScopeMarker();
    const base = { platform: "linux", table, deadlineMs: 5_000 } as const;
    const bare = preparationQuiet({ marker, groups: [] }, base);
    const rich = preparationQuiet(
      { marker, groups: [] },
      { ...base, sources: { captured: [{ pid: 30, pgid: 30, birth: BIRTH }] } },
    );
    // Both reads reached the census before either finished: each ran its own.
    await vi.waitFor(() => expect(censusCalls).toHaveLength(2));
    openGate();
    expect(await bare).toEqual({ status: "quiet" });
    expect(await rich).toEqual({
      status: "held",
      reasons: ["scope member 30 could not be read (birth_unreadable)"],
    });
  });
});
