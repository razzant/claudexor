import { expect, it, vi } from "vitest";
import { checkHarnessPrograms } from "./harness-program-freshness.mjs";
import { newestSource, pickNewest } from "../../packages/cli/src/harness-newest.js";
const program = {
  id: "fixture",
  majorVersion: 1,
  platforms: {
    linux: {
      newest: { url: "https://vendor.example/latest", pick: { kind: "text" } },
      update: { kind: "exec", command: "{program}", args: ["upgrade"] },
      exactVersion: { kind: "exec", command: "{program}", args: ["upgrade", "{version}"] },
      install: { kind: "script", url: "https://vendor.example/install" },
    },
  },
};
function deps() {
  return {
    platform: "linux",
    arch: "x64",
    newestSource,
    pickNewest,
    readVendorBytes: vi.fn(async () => Buffer.from("1.2.3")),
    resolveSelectedProgramAsync: vi.fn(async () => ({ path: "/fixture/vendor" })),
    resolveHarnessBinary: vi.fn(() => null),
    runCapture: vi.fn(async () => ({ code: 0, stdout: "Usage: upgrade", stderr: "" })),
  };
}
it("checks declared source and each distinct verb without running installation operands", async () => {
  const d = deps(),
    checks = await checkHarnessPrograms([program], d);
  expect(checks.filter((c) => c.status === "passed")).toHaveLength(2);
  expect(d.runCapture).toHaveBeenCalledExactlyOnceWith(
    "/fixture/vendor",
    ["upgrade", "--help"],
    expect.anything(),
  );
  expect(checks.find((c) => c.action === "install")?.status).toBe("skipped");
});
it("reports an absent program as skipped and never executes a fallback", async () => {
  const d = deps();
  d.resolveSelectedProgramAsync.mockResolvedValue({ path: null });
  const checks = await checkHarnessPrograms([program], d);
  expect(checks.find((c) => c.action === "update")?.status).toBe("skipped");
  expect(d.runCapture).not.toHaveBeenCalled();
});
it("fails unavailable or wrong-line sources and rejected help", async () => {
  const d = deps();
  d.readVendorBytes.mockResolvedValue(Buffer.from("2.0.0"));
  d.runCapture.mockResolvedValue({ code: 2, stdout: "", stderr: "unknown command" });
  expect(
    (await checkHarnessPrograms([program], d)).filter((c) => c.status === "failed"),
  ).toHaveLength(2);
  d.readVendorBytes.mockRejectedValue(new Error("offline"));
  expect((await checkHarnessPrograms([program], d))[0].status).toBe("failed");
});
it("sources-only never probes installed programs", async () => {
  const d = deps();
  await checkHarnessPrograms([program], d, { sourcesOnly: true });
  expect(d.resolveSelectedProgramAsync).not.toHaveBeenCalled();
  expect(d.runCapture).not.toHaveBeenCalled();
});
