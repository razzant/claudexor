import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { RunDeliveryState } from "@claudexor/schema";
import { controlRunResult, markRunApplyState } from "./run-delivery-state.js";

// The overlay's revert anchor has three states: omitted (a state file that never
// spoke about it, or a write with nothing to say: the earlier value stands) and
// explicit null (this delivery left no anchor: nothing older may stand in).
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(metaAnchor: string | null = "sha256:immutable") {
  const runDir = mkdtempSync(join(tmpdir(), "cx-delivery-state-"));
  dirs.push(runDir);
  mkdirSync(join(runDir, "final"));
  writeFileSync(
    join(runDir, "final/work_product.yaml"),
    stringify({
      id: "wp",
      kind: "patch",
      source_task_id: "task",
      producer_attempt_id: "a01",
      meta: { result_kind: "patch", apply_state: "applied", revert_anchor_id: metaAnchor },
    }),
  );
  return { id: "job", runId: "run", runDir, state: "succeeded" } as never;
}
const stateOf = (record: { runDir: string }) =>
  parse(readFileSync(join(record.runDir, "final/delivery_state.yaml"), "utf8"));
const dirOf = (record: unknown) => (record as { runDir: string }).runDir;

describe("the revert anchor of the delivery-state overlay", () => {
  it("a first write with nothing to say carries the work product's anchor", () => {
    const record = run();
    markRunApplyState(record, "applied");
    expect(stateOf({ runDir: dirOf(record) }).revertAnchorId).toBe("sha256:immutable");
    expect(controlRunResult(record)).toMatchObject({
      revertAnchorId: "sha256:immutable",
      revertable: true,
    });
  });

  it("a delivery's own anchor replaces the earlier one", () => {
    const record = run();
    markRunApplyState(record, "applied", undefined, false, "sha256:pair");
    expect(controlRunResult(record)).toMatchObject({ revertAnchorId: "sha256:pair" });
    markRunApplyState(record, "reverted");
    expect(stateOf({ runDir: dirOf(record) }).revertAnchorId).toBe("sha256:pair");
  });

  it("an explicit null clears the earlier anchor and the work product's for every reader", () => {
    const record = run();
    markRunApplyState(record, "applied", undefined, false, "sha256:pair");
    markRunApplyState(record, "applied_review_blocked", undefined, false, null);
    expect(stateOf({ runDir: dirOf(record) }).revertAnchorId).toBeNull();
    expect(controlRunResult(record)).toMatchObject({
      applyState: "applied_review_blocked",
      revertAnchorId: null,
      revertable: false,
    });
  });

  it("a later write with nothing to say keeps the explicit null", () => {
    const record = run();
    markRunApplyState(record, "applied_review_blocked", undefined, false, null);
    markRunApplyState(record, "applied_review_blocked");
    expect(stateOf({ runDir: dirOf(record) }).revertAnchorId).toBeNull();
    expect(controlRunResult(record).revertAnchorId).toBeNull();
  });

  it("a state file that never named an anchor still reads the work product's", () => {
    const record = run();
    writeFileSync(
      join(dirOf(record), "final/delivery_state.yaml"),
      stringify({ applyState: "applied" }),
    );
    expect(RunDeliveryState.parse({ applyState: "applied" }).revertAnchorId).toBeUndefined();
    expect(controlRunResult(record)).toMatchObject({
      revertAnchorId: "sha256:immutable",
      revertable: true,
    });
    markRunApplyState(record, "reverted");
    expect(stateOf({ runDir: dirOf(record) }).revertAnchorId).toBe("sha256:immutable");
  });
});
