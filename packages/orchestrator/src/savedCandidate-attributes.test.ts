import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyAndDeliver } from "@claudexor/delivery";
import { captureWorkingTreeTransient, isolatedCloneAdd } from "@claudexor/workspace";
import {
  buildReviewerCandidateInventory,
  prepareReviewerWorkspace,
} from "../../review/src/reviewerWorkspace.js";
import { buildFileBackedSynthesisInput } from "./candidateOutputs.js";
import { savedForSynthesis } from "./savedCandidate.js";

// #535 R14 A2: review and synthesis of a result with no patch view read a copy of its
// saved tree, which ran in the candidate's own repository. A gate that changed that
// repository's `.git/info/attributes` and filter configuration after the capture made
// synthesis and every reviewer read "AFTER!\n" while apply wrote "after!\n", with no
// file named unavailable. The copy, the reviewer workspace and the delivery are now
// compared through the real preparation and delivery owners.
const dirs: string[] = [];
let configDir: string | undefined;
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

/** An unrendered result made in an isolated candidate clone of `repo`. */
async function unrenderedResult(write: (clone: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "cx-saved-attributes-"));
  dirs.push(root);
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = join(root, "config");
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "f.txt"), "before\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const clone = join(root, "clone");
  await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, "rev-parse", "HEAD"));
  write(clone);
  const owner = join(root, "run");
  mkdirSync(owner);
  const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
    projectRoot: repo,
    owner,
    viewLimitBytes: 1,
  });
  expect(captured.captureIncomplete).toBe(false);
  expect(captured.patchViewUnavailable).toBeTruthy();
  return { root, repo, clone, owner, captured };
}

/** What synthesis, a reviewer and the delivery each get of `paths`, as hex. */
async function readThrough(
  fixture: Awaited<ReturnType<typeof unrenderedResult>>,
  paths: readonly string[] = ["f.txt"],
) {
  const { root, repo, clone, owner, captured } = fixture;
  const run = {
    attemptId: "a01",
    label: "candidate",
    diff: "",
    reviewCwd: clone,
    result: captured.result!,
    patchViewUnavailable: captured.patchViewUnavailable!,
    changedPaths: captured.changedPaths ?? [],
  };
  const saved = await savedForSynthesis([run], owner, repo);
  try {
    const copy = saved.candidates[0]!.savedFiles!;
    const synthesis = buildFileBackedSynthesisInput({
      instructions: "inspect the saved result",
      findings: [],
      candidates: saved.candidates,
    });
    const evidence = join(root, "evidence");
    mkdirSync(evidence);
    writeFileSync(join(evidence, "TESTS.txt"), "none\n");
    const inventory = await buildReviewerCandidateInventory(
      copy.dir,
      new Set(),
      false,
      run.changedPaths,
    );
    const reviewer = await prepareReviewerWorkspace({
      sourceRoot: copy.dir,
      sourceEvidenceDir: evidence,
      workspaceBaseDir: join(root, "reviewers"),
      reviewerDirName: "r1",
      excludeRoots: [],
      candidateCopyPaths: inventory.copyPaths,
      candidatePaths: run.changedPaths,
      savedCopy: { unavailable: copy.unavailable },
    });
    const delivered = await verifyAndDeliver(
      repo,
      { result: captured.result!, renderedPatch: null },
      { mode: "apply", projectRoot: repo, owner },
      [],
    );
    expect(delivered.applied).toBe(true);
    const bytes = (dir: string) =>
      Object.fromEntries(
        paths.map((path) => [path, readFileSync(join(dir, path)).toString("hex")]),
      );
    return {
      synthesisNamesCopy: synthesis.content.includes(copy.dir),
      unavailable: copy.unavailable,
      uninspectable: reviewer.uninspectable,
      saved: bytes(copy.dir),
      reviewer: bytes(reviewer.root),
      delivered: bytes(repo),
    };
  } finally {
    await saved.dispose();
  }
}

const hex = (text: string) => Buffer.from(text).toString("hex");

describe("saved review and synthesis files against the delivery of the same result", () => {
  it("a filter a gate wrote into the candidate's info attributes and config after the capture", async () => {
    const fixture = await unrenderedResult((clone) =>
      writeFileSync(join(clone, "f.txt"), "after!\n"),
    );
    git(fixture.clone, "config", "filter.upper.smudge", "tr a-z A-Z");
    git(fixture.clone, "config", "filter.upper.clean", "cat");
    writeFileSync(join(fixture.clone, ".git/info/attributes"), "f.txt filter=upper\n");

    const read = await readThrough(fixture);

    expect(read.synthesisNamesCopy).toBe(true);
    expect(read.unavailable).toEqual([]);
    expect(read.uninspectable).toEqual([]);
    expect(read.saved["f.txt"]).toBe(hex("after!\n"));
    expect(read.reviewer["f.txt"]).toBe(hex("after!\n"));
    expect(read.delivered["f.txt"]).toBe(hex("after!\n"));
  });

  it("an encoding a gate wrote into the candidate's info attributes after the capture", async () => {
    const fixture = await unrenderedResult((clone) =>
      writeFileSync(join(clone, "f.txt"), "candidate\n"),
    );
    writeFileSync(
      join(fixture.clone, ".git/info/attributes"),
      "f.txt working-tree-encoding=UTF-16LE\n",
    );

    const read = await readThrough(fixture);

    expect(read.saved["f.txt"]).toBe(hex("candidate\n"));
    expect(read.reviewer["f.txt"]).toBe(hex("candidate\n"));
    expect(read.delivered["f.txt"]).toBe(hex("candidate\n"));
  });

  it("nothing changed after the capture: the same bytes everywhere (control)", async () => {
    const fixture = await unrenderedResult((clone) =>
      writeFileSync(join(clone, "f.txt"), "after!\n"),
    );

    const read = await readThrough(fixture);

    expect(read.unavailable).toEqual([]);
    expect(read.saved["f.txt"]).toBe(hex("after!\n"));
    expect(read.reviewer["f.txt"]).toBe(hex("after!\n"));
    expect(read.delivered["f.txt"]).toBe(hex("after!\n"));
  });

  it("the result's own tracked attributes still convert, and a live rewrite of them does not (control)", async () => {
    const fixture = await unrenderedResult((clone) => {
      writeFileSync(join(clone, ".gitattributes"), "crlf.txt eol=crlf\n");
      writeFileSync(join(clone, "crlf.txt"), "one\ntwo\n");
    });
    // A gate rewrites the tracked attributes in the workspace after the capture.
    writeFileSync(join(fixture.clone, ".gitattributes"), "crlf.txt -text\n");

    const read = await readThrough(fixture, ["crlf.txt"]);

    expect(read.unavailable).toEqual([]);
    expect(read.saved["crlf.txt"]).toBe(hex("one\r\ntwo\r\n"));
    expect(read.reviewer["crlf.txt"]).toBe(hex("one\r\ntwo\r\n"));
    expect(read.delivered["crlf.txt"]).toBe(hex("one\r\ntwo\r\n"));
  });
});
