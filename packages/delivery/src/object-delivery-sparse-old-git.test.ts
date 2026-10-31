import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  captureWorkingTreeTransient,
  createPairRevertAnchor,
  isolatedCloneAdd,
  snapshotTree,
} from "@claudexor/workspace";
import { checkResultOnTarget, revertInPlaceFromAnchor, verifyAndDeliver } from "./index.js";

// #535 R5 G1: `git sparse-checkout check-rules` arrived in Git 2.41. An older Git
// answers its usage error (exit 129), which every object delivery, check and revert
// of a sparse checkout met as a bare `git_failed` (apply/check: untyped text) that
// never said why. They now refuse typed before writing, naming the version
// requirement, and a checkout that is not sparse never asks. A `git` in a private
// HOME's ~/.local/bin, which the engine's child PATH searches before the system's,
// stands in for the old one; it is no qualification of a real older Git.
const dirs: string[] = [];
let configDir: string | undefined;
let home: string | undefined;
const fakeHome = mkdtempSync(join(tmpdir(), "cx-old-git-home-"));
const fake = join(fakeHome, ".local", "bin");
const asked = join(fakeHome, "check-rules.log");
beforeAll(() => {
  mkdirSync(fake, { recursive: true });
  const real = execFileSync("sh", ["-c", "command -v git"]).toString("utf8").trim();
  writeFileSync(
    join(fake, "git"),
    [
      "#!/bin/sh",
      'for arg in "$@"; do',
      `  if [ "$arg" = check-rules ]; then echo asked >> '${asked}'; fi`,
      "done",
      'if [ "${CX_OLD_GIT:-}" = 1 ]; then',
      '  for arg in "$@"; do',
      '    case "$arg" in',
      "      check-rules)",
      '        echo "error: unknown subcommand: \\`check-rules\'" >&2',
      '        echo "usage: git sparse-checkout (init | list | set | add | reapply | disable) [<options>]" >&2',
      "        exit 129 ;;",
      '      version) echo "git version 2.39.5"; exit 0 ;;',
      "    esac",
      "  done",
      "fi",
      `exec '${real}' "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(fake, "git"), 0o755);
  home = process.env["HOME"];
  process.env["HOME"] = fakeHome;
});
afterAll(() => {
  process.env["HOME"] = home;
  rmSync(fakeHome, { recursive: true, force: true });
});
beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-old-git-config-"));
  dirs.push(process.env["CLAUDEXOR_CONFIG_DIR"]);
  rmSync(asked, { force: true });
});
afterEach(() => {
  delete process.env["CX_OLD_GIT"];
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
const read = (repo: string, file: string) =>
  existsSync(join(repo, file)) ? readFileSync(join(repo, file), "utf8") : null;
const timesAsked = () =>
  existsSync(asked) ? readFileSync(asked, "utf8").trim().split("\n").length : 0;

/** A result changing near/n.txt, inside the cone of near/ when `sparse`. */
async function fixture(sparse: boolean) {
  const repo = mkdtempSync(join(tmpdir(), "cx-old-git-"));
  const run = mkdtempSync(join(tmpdir(), "cx-old-git-run-"));
  dirs.push(repo, run);
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "near"));
  mkdirSync(join(repo, "far"));
  writeFileSync(join(repo, "near/n.txt"), "n\n");
  writeFileSync(join(repo, "far/x.txt"), "x\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const clone = join(mkdtempSync(join(tmpdir(), "cx-old-git-clone-")), "tree");
  dirs.push(join(clone, ".."));
  await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, "rev-parse", "HEAD"));
  writeFileSync(join(clone, "near/n.txt"), "n delivered\n");
  const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
    projectRoot: repo,
    owner: run,
  });
  if (sparse) git(repo, "sparse-checkout", "set", "--cone", "near");
  const delivery = { result: captured.result!, renderedPatch: captured.patch };
  return {
    repo,
    delivery,
    apply: () =>
      verifyAndDeliver(repo, delivery, { mode: "apply", projectRoot: repo, owner: run }, []),
  };
}

const OLD_GIT = {
  code: "git_failed",
  message: expect.stringMatching(
    /git version 2\.39\.5.*check-rules.*Git 2\.41.*nothing was written/,
  ),
};

describe("a sparse checkout whose Git has no sparse-checkout check-rules", () => {
  it("refuses apply and apply/check typed before writing, naming the Git it needs", async () => {
    const f = await fixture(true);
    process.env["CX_OLD_GIT"] = "1";

    const checked = await checkResultOnTarget(f.repo, f.delivery.result, f.repo);
    const applied = await f.apply();

    expect(checked).toMatchObject({ ok: false, refusal: OLD_GIT });
    expect(applied).toMatchObject({ applied: false, treeMutated: false, refusal: OLD_GIT });
    expect(read(f.repo, "near/n.txt")).toBe("n\n");
  });

  it("refuses the revert the same way, as a cause that goes away, not a later edit", async () => {
    const f = await fixture(true);
    const applied = await f.apply();
    expect(applied).toMatchObject({ applied: true });
    process.env["CX_OLD_GIT"] = "1";

    const anchor = await createPairRevertAnchor(f.repo, applied.deliveryPair!, f.repo);
    const reverted = await revertInPlaceFromAnchor(f.repo, anchor, f.repo);

    expect(reverted).toMatchObject({
      reverted: false,
      reasonCode: "reverse_apply_failed",
      refusal: OLD_GIT,
    });
    expect(read(f.repo, "near/n.txt")).toBe("n delivered\n");
  });

  it("still snapshots the checkout, reading every file instead", async () => {
    const f = await fixture(true);
    process.env["CX_OLD_GIT"] = "1";
    expect(await snapshotTree(f.repo)).toBe(git(f.repo, "rev-parse", "HEAD"));
  });
});

describe("a checkout that is not sparse (the control)", () => {
  it("applies, checks and reverts without asking check-rules", async () => {
    const f = await fixture(false);
    process.env["CX_OLD_GIT"] = "1";

    expect(await checkResultOnTarget(f.repo, f.delivery.result, f.repo)).toMatchObject({
      ok: true,
    });
    const applied = await f.apply();
    expect(applied).toMatchObject({ applied: true });
    const anchor = await createPairRevertAnchor(f.repo, applied.deliveryPair!, f.repo);
    expect(await revertInPlaceFromAnchor(f.repo, anchor, f.repo)).toMatchObject({
      reverted: true,
    });
    expect(read(f.repo, "near/n.txt")).toBe("n\n");
    expect(timesAsked()).toBe(0);
  });
});
