import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureWorkingTreeTransient,
  createPairRevertAnchor,
  isolatedCloneAdd,
} from "@claudexor/workspace";
import { checkResultOnTarget, revertInPlaceFromAnchor, verifyAndDeliver } from "./index.js";

// #535 R4 A2: Git's checkout honours the sparse-checkout patterns, so it does not
// write a path outside them, and a snapshot's `add` skips it. An object
// delivery that addresses such a path therefore failed its content proof after
// writing (an addition), deleted a present file the user kept (a modification), or
// applied a deletion its revert could not see; a revert after the user narrowed the
// patterns answered reverted:true over the delivered bytes. Main's `git apply` writes
// an addition, but its later snapshots then fail, and so would this revert. Such a
// path is refused typed before anything is written, the dry run answering the same.
const dirs: string[] = [];
let configDir: string | undefined;
beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-sparse-config-"));
  dirs.push(process.env["CLAUDEXOR_CONFIG_DIR"]);
});
afterEach(() => {
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
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: ENV })
    .toString("utf8")
    .trim();
const read = (repo: string, path: string) =>
  existsSync(join(repo, path)) ? readFileSync(join(repo, path), "utf8") : null;

const PATTERNS = {
  cone: ["--cone", "near"],
  "non-cone": ["--no-cone", "/near/", "/top.txt"],
} as const;

/** near/ inside the patterns, far/ outside; `edit` makes the result in a full clone. */
async function result(edit: (clone: string) => void) {
  const repo = mkdtempSync(join(tmpdir(), "cx-sparse-"));
  const run = mkdtempSync(join(tmpdir(), "cx-sparse-run-"));
  dirs.push(repo, run);
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "near"));
  mkdirSync(join(repo, "far"));
  writeFileSync(join(repo, "near/n.txt"), "n\n");
  writeFileSync(join(repo, "far/x.txt"), "x\n");
  writeFileSync(join(repo, "top.txt"), "t\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const clone = join(mkdtempSync(join(tmpdir(), "cx-sparse-clone-")), "tree");
  dirs.push(join(clone, ".."));
  await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, "rev-parse", "HEAD"));
  edit(clone);
  const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
    projectRoot: repo,
    owner: run,
  });
  expect(captured.captureIncomplete).toBe(false);
  const delivery = { result: captured.result!, renderedPatch: captured.patch };
  return {
    repo,
    delivery,
    apply: () =>
      verifyAndDeliver(repo, delivery, { mode: "apply", projectRoot: repo, owner: run }, []),
  };
}

const outside = (paths: string[]) => ({
  applied: false,
  refused: true,
  treeMutated: false,
  refusal: { code: "delivery_outside_sparse_checkout", paths },
});

for (const [mode, patterns] of Object.entries(PATTERNS))
  describe(`a ${mode} sparse checkout`, () => {
    it("refuses a result that adds a file outside the patterns before any write, naming it", async () => {
      const r = await result((clone) => {
        writeFileSync(join(clone, "far/new.txt"), "agent\n");
        writeFileSync(join(clone, "near/n.txt"), "n, by the agent\n");
      });
      git(r.repo, "sparse-checkout", "set", ...patterns);

      expect(await r.apply()).toMatchObject(outside(["far/new.txt"]));

      expect(read(r.repo, "far/new.txt")).toBeNull();
      expect(read(r.repo, "near/n.txt")).toBe("n\n");
    });

    it("answers apply/check with the same refusal", async () => {
      const r = await result((clone) => writeFileSync(join(clone, "far/new.txt"), "agent\n"));
      git(r.repo, "sparse-checkout", "set", ...patterns);

      const checked = await checkResultOnTarget(r.repo, r.delivery.result, r.repo);

      expect(checked).toMatchObject({
        ok: false,
        refusal: { code: "delivery_outside_sparse_checkout", paths: ["far/new.txt"] },
      });
    });

    it("refuses a result that changes an out-of-pattern file kept on disk, keeping the user's bytes", async () => {
      const r = await result((clone) => writeFileSync(join(clone, "far/x.txt"), "agent edit\n"));
      git(r.repo, "sparse-checkout", "set", ...patterns);
      mkdirSync(join(r.repo, "far"), { recursive: true });
      writeFileSync(join(r.repo, "far/x.txt"), "x\n");

      expect(await r.apply()).toMatchObject(outside(["far/x.txt"]));

      expect(read(r.repo, "far/x.txt")).toBe("x\n");
    });

    it("refuses a result that deletes an out-of-pattern file kept on disk, keeping it", async () => {
      const r = await result((clone) => rmSync(join(clone, "far/x.txt")));
      git(r.repo, "sparse-checkout", "set", ...patterns);
      mkdirSync(join(r.repo, "far"), { recursive: true });
      writeFileSync(join(r.repo, "far/x.txt"), "x\n");

      expect(await r.apply()).toMatchObject(outside(["far/x.txt"]));

      expect(read(r.repo, "far/x.txt")).toBe("x\n");
    });

    it("refuses a result that deletes an out-of-pattern file the checkout does not hold, as main does", async () => {
      const r = await result((clone) => {
        rmSync(join(clone, "far/x.txt"));
        writeFileSync(join(clone, "near/n.txt"), "n, by the agent\n");
      });
      git(r.repo, "sparse-checkout", "set", ...patterns);

      expect(await r.apply()).toMatchObject(outside(["far/x.txt"]));

      expect(read(r.repo, "near/n.txt")).toBe("n\n");
      expect(git(r.repo, "ls-files", "-t", "far/x.txt")).toBe("S far/x.txt");
    });

    it("applies and reverts a result inside the patterns (the control)", async () => {
      const r = await result((clone) => {
        writeFileSync(join(clone, "near/new.txt"), "agent\n");
        writeFileSync(join(clone, "near/n.txt"), "n, by the agent\n");
      });
      git(r.repo, "sparse-checkout", "set", ...patterns);

      const applied = await r.apply();
      expect(applied).toMatchObject({ applied: true });
      expect(read(r.repo, "near/new.txt")).toBe("agent\n");
      const anchor = await createPairRevertAnchor(r.repo, applied.deliveryPair!, r.repo);

      expect(await revertInPlaceFromAnchor(r.repo, anchor, r.repo)).toMatchObject({
        reverted: true,
      });
      expect(read(r.repo, "near/new.txt")).toBeNull();
      expect(read(r.repo, "near/n.txt")).toBe("n\n");
      expect(git(r.repo, "ls-files", "-t", "far/x.txt")).toBe("S far/x.txt");
    });
  });

describe("a revert after the user narrowed the sparse checkout", () => {
  it("refuses typed and writes nothing, instead of calling the delivered bytes gone", async () => {
    const r = await result((clone) => writeFileSync(join(clone, "near/n.txt"), "delivered\n"));
    git(r.repo, "sparse-checkout", "set", "--cone", "near", "far");
    const applied = await r.apply();
    expect(applied).toMatchObject({ applied: true });
    const anchor = await createPairRevertAnchor(r.repo, applied.deliveryPair!, r.repo);
    git(r.repo, "sparse-checkout", "set", "--cone", "far");
    expect(read(r.repo, "near/n.txt")).toBe("delivered\n");

    expect(await revertInPlaceFromAnchor(r.repo, anchor, r.repo)).toMatchObject({
      reverted: false,
      refusal: { code: "delivery_outside_sparse_checkout", paths: ["near/n.txt"] },
    });

    expect(read(r.repo, "near/n.txt")).toBe("delivered\n");
  });
});

// #535 R4 F2 on its consumer: the snapshot a delivery starts from threw ENOTDIR.
describe("an untracked file where a cone's excluded directory was", () => {
  it("does not stop a delivery inside the cone", async () => {
    const r = await result((clone) => writeFileSync(join(clone, "near/new.txt"), "agent\n"));
    git(r.repo, "sparse-checkout", "set", "--cone", "near");
    writeFileSync(join(r.repo, "far"), "the user's untracked file\n");

    expect(await r.apply()).toMatchObject({ applied: true });

    expect(read(r.repo, "near/new.txt")).toBe("agent\n");
    expect(read(r.repo, "far")).toBe("the user's untracked file\n");
  });
});
