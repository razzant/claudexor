import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readContinuationEvidence } from "@claudexor/workspace";
import { admitContinuationRequest } from "./continuation-admission.js";
import type { JobRecord } from "./job-record.js";
vi.mock("@claudexor/workspace", async (original) => {
  const owner = await original<typeof import("@claudexor/workspace")>();
  return { ...owner, readContinuationEvidence: vi.fn(owner.readContinuationEvidence) };
});
const roots: string[] = [];
afterEach(() => {
  vi.mocked(readContinuationEvidence).mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
function records() {
  const root = mkdtempSync(join(tmpdir(), "continuation-expiry-"));
  roots.push(root);
  return ["ancestor", "middle", "head"].map((id, index, ids): JobRecord => {
    const runDir = join(root, id);
    mkdirSync(join(runDir, "final"), { recursive: true });
    return {
      id,
      runId: id,
      runDir,
      createdAt: "2020-01-01",
      state: "failed",
      params: { continueFrom: ids[index - 1] },
    };
  });
}
it("does not reread large evidence bodies during ordinary unexpired admission", () => {
  const chain = records();
  expect(() => admitContinuationRequest({ continueFrom: "head" }, chain)).not.toThrow();
  expect(readContinuationEvidence).not.toHaveBeenCalled();
});
it("can use an intact older source beyond a retired intermediate link", () => {
  const chain = records();
  writeFileSync(join(chain[0]!.runDir!, "final", "answer.md"), "Intact earlier evidence");
  writeFileSync(join(chain[1]!.runDir!, "tombstone.yaml"), "expired");
  expect(() => admitContinuationRequest({ continueFrom: "head" }, chain)).not.toThrow();
  rmSync(join(chain[0]!.runDir!, "final", "answer.md"));
  expect(() => admitContinuationRequest({ continueFrom: "head" }, chain)).toThrow(
    expect.objectContaining({ code: "run_expired_by_retention" }),
  );
});
