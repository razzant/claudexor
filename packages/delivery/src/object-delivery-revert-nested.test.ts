import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureWorkingTreeTransient,
  createPairRevertAnchor,
  isolatedCloneAdd,
} from "@claudexor/workspace";
import { revertInPlaceFromAnchor, verifyAndDeliver } from "./index.js";

// #535 R4 F3: a revert brings what the delivery added that its snapshot lacks into
// that snapshot with `git add -f`. For a path inside a nested Git repository `add`
// exits 0 and adds nothing, so the revert read the addition as already gone: it
// answered {reverted:true} (a take-back: "the target is unchanged") while the file
// stayed. Main's `git apply --reverse` removes it.
const dirs: string[] = [];
const unreadable: string[] = [];
let configDir: string | undefined;
beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-revert-nested-config-"));
  dirs.push(process.env["CLAUDEXOR_CONFIG_DIR"]);
});
afterEach(() => {
  if (configDir === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
  else process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
  for (const file of unreadable.splice(0)) if (existsSync(file)) chmodSync(file, 0o644);
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

/** A user's own clone or checkout inside the project, which the project does not track. */
function nestedRepository(at: string, committed: boolean): void {
  mkdirSync(at, { recursive: true });
  git(at, "init", "-q", "-b", "main");
  writeFileSync(join(at, "x.c"), "the nested repository's own file\n");
  if (committed) {
    git(at, "add", "-A");
    git(at, "commit", "-qm", "nested");
  }
}

/** A project holding a nested repository at `nested` before the run, and a result that
 * adds `${nested}/new.c` (plus `extra` files). */
async function project(
  nested: string,
  committed: boolean,
  setup: (repo: string) => void = () => {},
) {
  const repo = mkdtempSync(join(tmpdir(), "cx-revert-nested-"));
  const run = mkdtempSync(join(tmpdir(), "cx-revert-nested-run-"));
  dirs.push(repo, run);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "kept.txt"), "kept\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  setup(repo);
  nestedRepository(join(repo, nested), committed);
  const clone = join(mkdtempSync(join(tmpdir(), "cx-revert-nested-clone-")), "tree");
  dirs.push(join(clone, ".."));
  await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, "rev-parse", "HEAD"));
  const result = async (edit: (clone: string) => void = () => {}) => {
    mkdirSync(join(clone, nested), { recursive: true });
    writeFileSync(join(clone, nested, "new.c"), "int added;\n");
    edit(clone);
    const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
      projectRoot: repo,
      owner: run,
    });
    expect(captured.captureIncomplete).toBe(false);
    return verifyAndDeliver(
      repo,
      { result: captured.result!, renderedPatch: captured.patch },
      { mode: "apply", projectRoot: repo, owner: run },
      [],
    );
  };
  return { repo, result };
}

async function deliveredAndRevertible(
  nested: string,
  committed: boolean,
  setup?: (repo: string) => void,
  edit?: (clone: string) => void,
) {
  const p = await project(nested, committed, setup);
  const applied = await p.result(edit);
  expect(applied).toMatchObject({ applied: true });
  expect(readFileSync(join(p.repo, nested, "new.c"), "utf8")).toBe("int added;\n");
  const anchor = await createPairRevertAnchor(p.repo, applied.deliveryPair!, p.repo);
  return { repo: p.repo, revert: () => revertInPlaceFromAnchor(p.repo, anchor, p.repo) };
}

describe("a revert of a file the delivery added inside a nested repository", () => {
  for (const committed of [false, true])
    it(`removes it (the nested repository ${committed ? "has" : "has no"} commit)`, async () => {
      const f = await deliveredAndRevertible("vendor/lib", committed);

      expect(await f.revert()).toMatchObject({ reverted: true });

      expect(existsSync(join(f.repo, "vendor/lib/new.c"))).toBe(false);
      expect(readFileSync(join(f.repo, "vendor/lib/x.c"), "utf8")).toBe(
        "the nested repository's own file\n",
      );
      expect(existsSync(join(f.repo, "vendor/lib/.git"))).toBe(true);
    });

  it("removes it when the nested clone sits under an ignored directory", async () => {
    const f = await deliveredAndRevertible("third_party/lib", true, (repo) =>
      writeFileSync(join(repo, ".git/info/exclude"), "third_party/\n"),
    );

    expect(await f.revert()).toMatchObject({ reverted: true });

    expect(existsSync(join(f.repo, "third_party/lib/new.c"))).toBe(false);
    expect(readFileSync(join(f.repo, "third_party/lib/x.c"), "utf8")).toBe(
      "the nested repository's own file\n",
    );
  });

  it("removes a symlink it added there (read as a link, not as the file it names)", async () => {
    const f = await deliveredAndRevertible("vendor/lib", true, undefined, (clone) =>
      symlinkSync("x.c", join(clone, "vendor/lib/link")),
    );
    expect(lstatSync(join(f.repo, "vendor/lib/link")).isSymbolicLink()).toBe(true);

    expect(await f.revert()).toMatchObject({ reverted: true });

    expect(existsSync(join(f.repo, "vendor/lib/link"))).toBe(false);
    expect(existsSync(join(f.repo, "vendor/lib/new.c"))).toBe(false);
    expect(readFileSync(join(f.repo, "vendor/lib/x.c"), "utf8")).toBe(
      "the nested repository's own file\n",
    );
  });

  it("refuses when the user changed it since, writing nothing", async () => {
    const f = await deliveredAndRevertible("vendor/lib", true);
    writeFileSync(join(f.repo, "vendor/lib/new.c"), "int edited;\n");

    expect(await f.revert()).toMatchObject({
      reverted: false,
      refusal: { code: "revert_conflict" },
    });

    expect(readFileSync(join(f.repo, "vendor/lib/new.c"), "utf8")).toBe("int edited;\n");
  });

  it("refuses typed, naming it and writing nothing, when it cannot be taken into the revert", async () => {
    const f = await deliveredAndRevertible("vendor/lib", true);
    chmodSync(join(f.repo, "vendor/lib/new.c"), 0o000);
    unreadable.push(join(f.repo, "vendor/lib/new.c"));

    const answer = await f.revert();
    chmodSync(join(f.repo, "vendor/lib/new.c"), 0o644);

    expect(answer).toMatchObject({
      reverted: false,
      refusal: { code: "revert_conflict", paths: ["vendor/lib/new.c"] },
    });
    expect(readFileSync(join(f.repo, "vendor/lib/new.c"), "utf8")).toBe("int added;\n");
  });
});

describe("a take-back of a write that added a file inside a nested repository", () => {
  it("removes it before saying the target is unchanged", async () => {
    const p = await project("vendor/lib", true, (repo) => {
      // A checkout filter that does not round-trip: z.txt fails its content proof.
      git(repo, "config", "filter.upper.smudge", "tr a-z A-Z");
      git(repo, "config", "filter.upper.clean", "cat");
      writeFileSync(join(repo, ".git/info/attributes"), "z.txt filter=upper\n");
    });

    const applied = await p.result((clone) => writeFileSync(join(clone, "z.txt"), "lower\n"));

    expect(applied).toMatchObject({
      applied: false,
      treeMutated: false,
      refusal: { code: "delivery_content_mismatch" },
    });
    expect(applied.refusal!.message).toContain("the target is unchanged");
    expect(existsSync(join(p.repo, "vendor/lib/new.c"))).toBe(false);
    expect(existsSync(join(p.repo, "z.txt"))).toBe(false);
    expect(readFileSync(join(p.repo, "vendor/lib/x.c"), "utf8")).toBe(
      "the nested repository's own file\n",
    );
  });
});
