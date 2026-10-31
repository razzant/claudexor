import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { candidatesFor } from "./candidates.js";
import { controlRunResult } from "./run-delivery-state.js";

// #535 round 8: unknown is not zero. A Git result with no rendered patch has
// no line counts; it must never read as "+0 −0".
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(meta: Record<string, unknown>, attempt?: Record<string, unknown>) {
  const runDir = mkdtempSync(join(tmpdir(), "cx-diffstat-"));
  dirs.push(runDir);
  mkdirSync(join(runDir, "final"));
  writeFileSync(
    join(runDir, "final/work_product.yaml"),
    stringify({ id: "wp", kind: "patch", source_task_id: "t", producer_attempt_id: "a01", meta }),
  );
  if (attempt) {
    mkdirSync(join(runDir, "attempts/a01"), { recursive: true });
    writeFileSync(
      join(runDir, "attempts/a01/attempt.yaml"),
      stringify({ attempt_id: "a01", harness_id: "fake", ...attempt }),
    );
  }
  return { id: "job", runId: "run", state: "succeeded", runDir };
}

describe("the projected diff statistics of a run", () => {
  it("an unrendered Git result has none, whatever its file count", () => {
    const projected = controlRunResult(
      run({
        result_kind: "patch",
        diffstat: { files: 3, additions: null, deletions: null },
        patch_view: { available: false, reason: "exceeds_view_limit" },
      }),
    );
    expect(projected.kind).toBe("patch");
    expect(projected.diffStat).toBeNull();
  });

  it("one unknown side is enough", () => {
    expect(
      controlRunResult(run({ diffstat: { files: 1, additions: 4, deletions: null } })).diffStat,
    ).toBeNull();
  });

  it("a rendered result keeps its numbers, zero included", () => {
    expect(
      controlRunResult(run({ diffstat: { files: 3, additions: 25, deletions: 0 } })).diffStat,
    ).toEqual({ files: 3, additions: 25, deletions: 0 });
  });

  it("a plan's explicit zero and a result with no statistics stay what they are", () => {
    expect(
      controlRunResult(
        run({ result_kind: "plan", diffstat: { files: 0, additions: 0, deletions: 0 } }),
      ).diffStat,
    ).toEqual({ files: 0, additions: 0, deletions: 0 });
    expect(controlRunResult(run({ result_kind: "files" })).diffStat).toBeNull();
  });

  it("a file count that is not a number is unknown on both projections, whatever the sides say", () => {
    const counts = { diffstat: { files: "3", additions: 25, deletions: 4 } };
    const record = run(counts, counts);
    expect(controlRunResult(record).diffStat).toBeNull();
    expect(candidatesFor(record.runDir, null)[0]!.diffstat).toBeNull();
  });

  it("a candidate of an unrendered Git result has none either; a rendered one keeps its numbers", () => {
    const unknown = run({}, { diffstat: { files: 3, additions: null, deletions: null } });
    expect(candidatesFor(unknown.runDir, null)[0]!.diffstat).toBeNull();
    const known = run({}, { diffstat: { files: 3, additions: 25, deletions: 4 } });
    expect(candidatesFor(known.runDir, null)[0]!.diffstat).toEqual({
      files: 3,
      additions: 25,
      deletions: 4,
    });
  });
});
