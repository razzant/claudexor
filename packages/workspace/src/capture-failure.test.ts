import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CaptureOutputExceeded, runCaptureRaw } from "@claudexor/core";
import { capturePlainDiff } from "./plain-diff-capture.js";
import { captureFailureEvidence } from "./capture-failure.js";
import { git } from "./git.js";

vi.mock("@claudexor/core", async (original) => ({
  ...(await original<typeof import("@claudexor/core")>()),
  runCaptureRaw: vi.fn(),
}));
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
function baseline() {
  const root = mkdtempSync(join(tmpdir(), "cx-capture-failure-"));
  roots.push(root);
  mkdirSync(join(root, "base"));
  return root;
}
it("refuses the lifecycle owner's available line-capture drain fact at exact Git and plain consumers", async () => {
  const root = baseline();
  // This is runCapture's real additive result shape. Raw does not produce drain
  // on this base; the consumer must still refuse if its capture supplies it.
  vi.mocked(runCaptureRaw).mockResolvedValue({
    code: 0,
    signal: null,
    stdout: "partial",
    stderr: "",
    drain: "truncated",
  } as Awaited<ReturnType<typeof runCaptureRaw>>);
  await expect(git(root, ["diff"])).rejects.toMatchObject({
    code: "capture_output_incomplete",
    drain: "truncated",
  });
  const result = await capturePlainDiff(join(root, "base"), root, null);
  expect(result).toMatchObject({ captureIncomplete: true, diff: "" });
  expect(captureFailureEvidence(result.captureFailure)).toMatchObject({
    code: "capture_output_incomplete",
    drain: "truncated",
  });
});
it("retains typed stderr overflow and its independent cleanup cause through the plain catch", async () => {
  const root = baseline();
  const error = Object.assign(new CaptureOutputExceeded("stderr"), {
    cleanupError: Object.assign(new Error("cleanup failed"), { code: "EIO" }),
  });
  vi.mocked(runCaptureRaw).mockRejectedValue(error);
  const result = await capturePlainDiff(join(root, "base"), root, null);
  expect(captureFailureEvidence(result.captureFailure)).toMatchObject({
    code: "capture_output_exceeded",
    stream: "stderr",
    bufferBudgetBytes: 256 * 1024 * 1024,
    cleanup: { code: "EIO" },
  });
});
it("retains spawn errors and failed diff stderr instead of reporting an empty clean tree", async () => {
  const root = baseline();
  vi.mocked(runCaptureRaw).mockRejectedValueOnce(
    Object.assign(new Error("spawn diff ENOENT"), { code: "ENOENT" }),
  );
  expect(
    captureFailureEvidence((await capturePlainDiff(join(root, "base"), root, null)).captureFailure),
  ).toMatchObject({ code: "capture_failed", causeCode: "ENOENT" });
  vi.mocked(runCaptureRaw).mockResolvedValue({
    code: 2,
    signal: null,
    stdout: "",
    stderr: "unreadable file",
  });
  expect(
    captureFailureEvidence((await capturePlainDiff(join(root, "base"), root, null)).captureFailure),
  ).toMatchObject({ code: "capture_failed", message: expect.stringContaining("unreadable file") });
});
