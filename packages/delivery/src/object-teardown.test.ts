import child, { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureWorkingTreeTransient,
  createPairRevertAnchor,
  isolatedCloneAdd,
  objectStorePath,
  pruneObjectStore,
} from "@claudexor/workspace";
import { checkResultOnTarget } from "./object-check.js";
import { revertInPlaceFromAnchor, verifyAndDeliver } from "./index.js";

// #535 teardown, through the compiled workspace owners the delivery consumers call:
// a disposable scratch or a pending lease record that cannot be removed after the
// operation answered never replaces that answer. Real Git, real POSIX denials (a
// directory made read-only); the one seam is node's own spawn, which the compiled
// process runner calls, to act at the moment a given Git child starts.
const originalSpawn = child.spawn;
let onSpawn: ((args: string[], env: Record<string, string | undefined>) => void) | null = null;
const dirs: string[] = [];
const unlock: string[] = [];
let configDir: string | undefined;

beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-teardown-config-"));
  dirs.push(process.env["CLAUDEXOR_CONFIG_DIR"]);
  child.spawn = function (this: unknown, command: string, args: string[], options: never) {
    onSpawn?.(args, (options as { env?: Record<string, string> } | undefined)?.env ?? {});
    return originalSpawn.call(this, command, args, options);
  } as typeof child.spawn;
  syncBuiltinESMExports();
});
afterEach(() => {
  onSpawn = null;
  child.spawn = originalSpawn;
  syncBuiltinESMExports();
  for (const path of unlock.splice(0)) if (existsSync(path)) chmodSync(path, 0o700);
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
const git = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: ENV })
    .toString("utf8")
    .trim();

function lock(dir: string): void {
  unlock.push(dir);
  chmodSync(dir, 0o500);
}

/** A user repo, a run directory owning the delivery, and a captured object result. */
async function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "cx-teardown-"));
  const run = mkdtempSync(join(tmpdir(), "cx-teardown-run-"));
  dirs.push(repo, run);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  const clone = join(mkdtempSync(join(tmpdir(), "cx-teardown-clone-")), "tree");
  dirs.push(join(clone, ".."));
  await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, ["rev-parse", "HEAD"]));
  writeFileSync(join(clone, "a.txt"), "candidate\n");
  const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
    projectRoot: repo,
    owner: run,
  });
  expect(captured.captureIncomplete).toBe(false);
  const pending = join(objectStorePath(repo), "claudexor", "pending");
  return { repo, run, result: captured.result!, renderedPatch: captured.patch, pending };
}

/** Lock the temporary-index scratch of the next write on `repo` once its checkout has
 * written, at its content proof: only the scratch's removal can fail after that. */
function lockWriteScratchAtProof(): { scratch: () => string | undefined } {
  let scratch: string | undefined;
  onSpawn = (_args, env) => {
    const index = env["GIT_INDEX_FILE"];
    if (index?.includes("claudexor-materialize-")) scratch = dirname(index);
    if (index?.includes("claudexor-proof-") && scratch && !unlock.includes(scratch)) lock(scratch);
  };
  return { scratch: () => scratch };
}

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a completed object write keeps its receipt when its scratch cannot be removed (#535 F1)",
  () => {
    it("control: apply, then revert on the delivery pair", async () => {
      const f = await fixture();
      const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
      expect(delivered).toMatchObject({ applied: true, treeMutated: true });
      const anchor = await createPairRevertAnchor(f.repo, delivered.deliveryPair!, f.repo);
      expect(await revertInPlaceFromAnchor(f.repo, anchor, f.repo)).toEqual({
        reverted: true,
        removed: [],
      });
      expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("base\n");
    });

    it("apply: the write's scratch stays, the receipt says applied with its pair", async () => {
      const f = await fixture();
      const seam = lockWriteScratchAtProof();
      const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
      expect(delivered).toMatchObject({ applied: true, treeMutated: true });
      expect(delivered.refused).toBeFalsy();
      expect(delivered.deliveryPair).toBeDefined();
      expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("candidate\n");
      expect(seam.scratch() && existsSync(seam.scratch()!)).toBe(true);
    });

    it("revert: the restoring write's scratch stays, the receipt says reverted", async () => {
      const f = await fixture();
      const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
      expect(delivered.applied).toBe(true);
      const anchor = await createPairRevertAnchor(f.repo, delivered.deliveryPair!, f.repo);
      const seam = lockWriteScratchAtProof();
      const reverted = await revertInPlaceFromAnchor(f.repo, anchor, f.repo);
      expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("base\n");
      expect(reverted).toEqual({ reverted: true, removed: [] });
      expect(seam.scratch() && existsSync(seam.scratch()!)).toBe(true);
    });
  },
);

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a pending lease that cannot be released never replaces a delivery answer (#535 F2)",
  () => {
    it("check: a missing object stays result_objects_missing, its scratch goes, the record stays", async () => {
      const f = await fixture();
      const missing = { ...f.result, base_tree: "0".repeat(40) };
      let scratch: string | undefined;
      onSpawn = (_args, env) => {
        const objects = env["GIT_OBJECT_DIRECTORY"];
        if (objects?.includes("claudexor-result-check-")) scratch = dirname(objects);
        if (scratch && readdirSync(f.pending).length === 1 && !unlock.includes(f.pending))
          lock(f.pending);
      };
      const checked = await checkResultOnTarget(f.repo, missing);
      expect(checked).toMatchObject({ ok: false, refusal: { code: "result_objects_missing" } });
      expect(unlock).toContain(f.pending);
      expect(scratch && existsSync(scratch)).toBe(false);
      expect(readdirSync(f.pending)).toHaveLength(1);
      expect(
        await pruneObjectStore({
          store: objectStorePath(f.repo),
          graceMs: 0,
          objectFormat: "sha1",
        }),
      ).toEqual({ freedBytes: 0, yielded: true });
    });

    it("control: a check releases its lease", async () => {
      const f = await fixture();
      const checked = await checkResultOnTarget(f.repo, { ...f.result, base_tree: "0".repeat(40) });
      expect(checked).toMatchObject({ ok: false, refusal: { code: "result_objects_missing" } });
      expect(readdirSync(f.pending)).toEqual([]);
    });

    it("apply: a kept pair whose import lease cannot be released still applies", async () => {
      const f = await fixture();
      onSpawn = (args) => {
        // The pair's custody import walks the candidate under its own pending lease.
        if (
          args.includes("rev-list") &&
          args.includes("--objects") &&
          args.includes(f.result.candidate_tree) &&
          readdirSync(f.pending).length === 1 &&
          !unlock.includes(f.pending)
        )
          lock(f.pending);
      };
      const delivered = await verifyAndDeliver(f.repo, f, { mode: "apply", owner: f.run });
      expect(unlock).toContain(f.pending);
      expect(delivered).toMatchObject({ applied: true, treeMutated: true });
      expect(delivered.deliveryPair).toBeDefined();
      expect(readFileSync(join(f.repo, "a.txt"), "utf8")).toBe("candidate\n");
      expect(readdirSync(f.pending)).toHaveLength(1);
    });
  },
);
