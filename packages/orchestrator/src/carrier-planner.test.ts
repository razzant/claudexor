import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessContinuityCapability } from "@claudexor/core";
import type { SessionCapsule } from "@claudexor/schema";
import {
  decideCarrier,
  prepareCarrier,
  type CarrierFacts,
  type CarrierIo,
} from "./carrier-planner.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const capsule: SessionCapsule = {
  harness: "fake",
  nativeSessionId: "sid-1",
  holderProfileId: "a",
  file: "/stores/a/sid-1.jsonl",
  mtimeMs: 1,
  sidecars: [],
  cwd: "/work",
  requestedModel: "m",
};

function facts(over: Partial<CarrierFacts> = {}): CarrierFacts {
  return {
    capsule,
    acted: true,
    cause: "vendor_limit",
    sourceProfile: { profileId: "a", env: { X: "a" }, storeLocator: "/stores/a" },
    targetProfile: { profileId: "b", env: { X: "b" }, storeLocator: "/stores/b" },
    effectiveModel: "m",
    preference: "auto",
    adapter: { id: "fake", continuity: movable() },
    nativeRejected: false,
    ...over,
  };
}

function movable(over: Partial<HarnessContinuityCapability> = {}): HarnessContinuityCapability {
  return {
    async locate(ref, env) {
      return {
        found: true,
        file: `/stores/${String(env["X"])}/${ref.nativeSessionId}.jsonl`,
        mtimeMs: 2,
        sidecars: [],
      };
    },
    async move(located) {
      return { ok: true, resumeRef: { nativeSessionId: located.nativeSessionId ?? "?" } };
    },
    ...over,
  };
}

describe("decideCarrier (pure truth table)", () => {
  it("hop with a session → native_moved then the acted floor", () => {
    expect(decideCarrier(facts()).ladder).toEqual(["native_moved", "packet"]);
    expect(decideCarrier(facts({ acted: false })).ladder).toEqual(["native_moved", "fresh"]);
    expect(decideCarrier(facts()).hop).toBe(true);
  });
  it("same account → native then the acted floor", () => {
    const same = facts({ targetProfile: facts().sourceProfile });
    expect(decideCarrier(same).ladder).toEqual(["native", "packet"]);
    expect(decideCarrier(same).hop).toBe(false);
    expect(decideCarrier({ ...same, acted: false }).ladder).toEqual(["native", "fresh"]);
  });
  it("sticky acted: never a fresh rung after progress, whatever rejected the session", () => {
    expect(decideCarrier(facts({ nativeRejected: true })).ladder).toEqual(["packet"]);
    expect(decideCarrier(facts({ capsule: null })).ladder).toEqual(["packet"]);
    expect(decideCarrier(facts({ capsule: null, acted: false })).ladder).toEqual(["fresh"]);
  });
  it("a hop without an adapter move capability → packet (1B), fresh only before progress", () => {
    const noMove = facts({ adapter: { id: "fake" } });
    expect(decideCarrier(noMove)).toMatchObject({
      ladder: ["packet"],
      reason: "hop_move_unsupported",
    });
    expect(decideCarrier({ ...noMove, acted: false }).ladder).toEqual(["fresh"]);
    // Same account without the capability still resumes by id (engine id check).
    expect(decideCarrier({ ...noMove, targetProfile: noMove.sourceProfile }).ladder).toEqual([
      "native",
      "packet",
    ]);
  });
  it("packet preference forces the re-brief", () => {
    expect(decideCarrier(facts({ preference: "packet" })).ladder).toEqual(["packet"]);
    expect(decideCarrier(facts({ preference: "packet", acted: false })).ladder).toEqual(["fresh"]);
  });
  it("keeps the attested model so a null hint cannot re-resolve on a new session", () => {
    expect(decideCarrier(facts({ effectiveModel: "attested" })).effectiveModel).toBe("attested");
  });
});

function io(f: CarrierFacts, runDir: string): CarrierIo {
  return {
    facts: f,
    evidence: { runDir, attemptId: "a01", workOrder: "WORK ORDER", steering: [] },
    targetCwd: "/work",
    retainedOutput: "partial answer",
    diffStat: "- src/x.ts",
  };
}

describe("prepareCarrier (I/O ladder walk)", () => {
  it("moves the session into the target store and names the new holder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-planner-"));
    roots.push(dir);
    const calls: string[] = [];
    const f = facts({
      adapter: {
        id: "fake",
        continuity: movable({
          async move(located, fromEnv, toEnv, targetCwd) {
            calls.push(
              `move ${located.file} ${String(fromEnv["X"])}→${String(toEnv["X"])} ${targetCwd}`,
            );
            return { ok: true, resumeRef: { nativeSessionId: "sid-1" } };
          },
        }),
      },
    });
    const prepared = await prepareCarrier(decideCarrier(f), io(f, dir));
    expect(prepared).toMatchObject({
      carrier: "native_moved",
      resumeRef: { nativeSessionId: "sid-1", path: "/stores/b/sid-1.jsonl" },
      capsule: { holderProfileId: "b", file: "/stores/b/sid-1.jsonl" },
    });
    expect(calls).toEqual(["move /stores/a/sid-1.jsonl a→b /work"]);
  });

  it("a locate miss or a refused move falls to the packet rung (1B), never to fresh after progress", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-planner-"));
    roots.push(dir);
    writeFileSync(join(dir, "events.jsonl"), "");
    const miss = facts({
      adapter: {
        id: "fake",
        continuity: movable({
          async locate() {
            return { found: false };
          },
        }),
      },
    });
    const p1 = await prepareCarrier(decideCarrier(miss), io(miss, dir));
    expect(p1.carrier).toBe("packet");
    const refused = facts({
      adapter: {
        id: "fake",
        continuity: movable({
          async move() {
            return { ok: false, reason: "vendor refused" };
          },
        }),
      },
    });
    const p2 = await prepareCarrier(decideCarrier(refused), io(refused, dir));
    expect(p2.carrier).toBe("packet");
    if (p2.carrier !== "packet") throw new Error("unreachable");
    expect(p2.packet.markdown).toContain("WORK ORDER");
    expect(p2.packet.markdown).toContain("partial answer");
    expect(p2.packet.markdown).toContain("- src/x.ts");
    // Before progress the same miss replays fresh (today's rule).
    const p3 = await prepareCarrier(
      decideCarrier({ ...miss, acted: false }),
      io({ ...miss, acted: false }, dir),
    );
    expect(p3.carrier).toBe("fresh");
  });

  it("same account: locate refreshes the holder; no capability resumes by id unverified", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-planner-"));
    roots.push(dir);
    const same = facts({ targetProfile: facts().sourceProfile });
    const p1 = await prepareCarrier(decideCarrier(same), io(same, dir));
    expect(p1).toMatchObject({
      carrier: "native",
      resumeRef: { nativeSessionId: "sid-1", path: "/stores/a/sid-1.jsonl" },
      capsule: { mtimeMs: 2 },
    });
    const byId = { ...same, adapter: { id: "fake" } };
    const p2 = await prepareCarrier(decideCarrier(byId), io(byId, dir));
    expect(p2).toMatchObject({ carrier: "native", resumeRef: { nativeSessionId: "sid-1" } });
  });
});

it("builds the packet floor even when a supplied ladder is exhausted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cx-planner-"));
  roots.push(dir);
  const f = facts();
  const prepared = await prepareCarrier({ ...decideCarrier(f), ladder: [] }, io(f, dir));
  expect(prepared).toMatchObject({
    carrier: "packet",
    packet: { markdown: expect.stringContaining("partial answer") },
  });
});
