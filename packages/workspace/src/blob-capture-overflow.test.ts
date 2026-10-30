import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureWorkingTreeTransient } from "./git.js";

// Only the binary inspection read is refused; Git still produces a real,
// complete and small binary patch. This differs from patch-output overflow.
vi.mock("@claudexor/core", async (original) => {
  const core = await original<typeof import("@claudexor/core")>();
  return {
    ...core,
    runCaptureRaw: (...args: Parameters<typeof core.runCaptureRaw>) => {
      if (args[0] === "git" && args[1][2] === "show")
        return Promise.reject(new core.CaptureOutputExceeded("stdout"));
      return core.runCaptureRaw(...args);
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("keeps a complete binary patch when only secret inspection exceeds the buffer budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "cx-blob-overflow-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
  git("init", "-q");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "base",
  );
  writeFileSync(join(root, "binary.bin"), Buffer.alloc(4096));
  const captured = await captureWorkingTreeTransient(root, "HEAD");
  expect(captured.captureIncomplete).toBe(false);
  expect(captured.patch).toContain("GIT binary patch");
});
