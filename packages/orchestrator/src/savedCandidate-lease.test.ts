import child, { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureWorkingTreeTransient, objectStorePath } from "@claudexor/workspace";
import { materializeUnrenderedCandidate, savedForSynthesis } from "./savedCandidate.js";

// #535 teardown: a saved-file copy that fails (here its checkout runs out of space)
// reaches review and synthesis as a failed copy with its cause, even when the store's
// pending lease record cannot be removed afterwards. Real Git through the compiled
// workspace owner, a real POSIX denial (the pending directory made read-only); the one
// seam is node's own spawn, which stands in for the one failing Git child.
const originalSpawn = child.spawn;
const dirs: string[] = [];
const locked: string[] = [];
let configDir: string | undefined;
afterEach(() => {
  child.spawn = originalSpawn;
  syncBuiltinESMExports();
  for (const path of locked.splice(0)) if (existsSync(path)) chmodSync(path, 0o700);
  if (configDir === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
  else process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

/** An unrendered candidate run that changed f.txt, with the project store in place. */
async function unrenderedRun() {
  const root = mkdtempSync(join(tmpdir(), "cx-saved-candidate-lease-"));
  dirs.push(root);
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = join(root, "config");
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"], { env: ENV });
  writeFileSync(join(repo, "kept.txt"), "kept\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { env: ENV });
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"], { env: ENV });
  writeFileSync(join(repo, "f.txt"), "saved\n");
  const captured = await captureWorkingTreeTransient(repo, "HEAD", [], { owner: root });
  const pending = join(objectStorePath(repo), "claudexor", "pending");
  const runDir = join(root, "run");
  mkdirSync(runDir);
  return {
    repo,
    runDir,
    pending,
    run: {
      attemptId: "a01",
      result: captured.result!,
      patchViewUnavailable: {
        reason: "exceeds_view_limit" as const,
        limitBytes: 1,
        estimatedBytes: 6,
      },
      changedPaths: ["f.txt"],
      reviewCwd: repo,
    },
  };
}

/** The copy's checkout fails for want of space; with `lockLease`, the pending directory
 * is read-only from then on, so the lease record cannot be removed. */
function failCheckout(pending: string, lockLease: boolean) {
  child.spawn = function (this: unknown, command: string, args: string[], options: never) {
    if (!args.includes("checkout-index")) return originalSpawn.call(this, command, args, options);
    if (lockLease) {
      locked.push(pending);
      chmodSync(pending, 0o500);
    }
    return originalSpawn.call(
      this,
      "/bin/sh",
      ["-c", "echo 'error: unable to write file f.txt: No space left on device' >&2; exit 128"],
      options,
    );
  } as typeof child.spawn;
  syncBuiltinESMExports();
}

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a failed saved copy whose lease cannot be released",
  () => {
    it.each([false, true])(
      "review gets the failed copy with its cause (lease record locked: %s)",
      async (lockLease) => {
        const f = await unrenderedRun();
        failCheckout(f.pending, lockLease);

        const copy = await materializeUnrenderedCandidate(f.run, join(f.runDir, "copy"), f.repo);

        expect(copy).toMatchObject({
          failed: true,
          unavailable: [{ path: "f.txt", reason: "space_insufficient" }],
        });
        await expect(copy!.dispose()).resolves.toBeUndefined();
        expect(readdirSync(f.pending)).toHaveLength(lockLease ? 1 : 0);
      },
    );

    it("synthesis gets the failed copy with its cause instead of a thrown extraction", async () => {
      const f = await unrenderedRun();
      failCheckout(f.pending, true);

      const saved = await savedForSynthesis([f.run], f.runDir, f.repo);
      try {
        expect(saved.candidates[0]!.savedFiles).toMatchObject({
          failed: true,
          unavailable: [{ path: "f.txt", reason: "space_insufficient" }],
        });
      } finally {
        await saved.dispose();
      }
    });
  },
);
