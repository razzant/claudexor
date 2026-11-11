import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { digestPendingIdentities } from "./interactions.js";
import { readRunObservations } from "./run-observation.js";

const STORE = "11111111-1111-4111-8111-111111111111";
const record = {
  jobId: "job-a",
  runId: "run-a",
  state: "running",
  partition: "global",
  epoch: "e".repeat(32),
  createdAt: "2026-10-22T00:00:00.000Z",
} as const;
const pending = digestPendingIdentities(["question-a"]);
const facts = [
  "claudexor.run-observation",
  1,
  STORE,
  record.partition,
  record.epoch,
  record.jobId,
  record.runId,
  record.state,
  pending.digest,
];
const digest = createHash("sha256").update(JSON.stringify(facts)).digest("base64url");

async function token() {
  const [row] = await readRunObservations(
    { observationRecords: () => [record] },
    { snapshotPendingIdentities: async (ids) => new Map(ids.map((id) => [id, pending])) },
    STORE,
    ["job-a"],
  );
  return row!.token;
}

describe("observation tokens a caller can echo", () => {
  it("is the stable digest of the observed facts, whatever its bytes look like", async () => {
    expect(await token()).toBe(digest);
    expect(await token()).toBe(digest);
  });
});
