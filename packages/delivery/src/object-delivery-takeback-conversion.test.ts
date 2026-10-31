import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureWorkingTreeTransient, isolatedCloneAdd } from "@claudexor/workspace";
import { verifyAndDeliver } from "./index.js";

// #535 R14 F1: a write taken back restores the target's tree as Git holds it, each
// file written again through the target's checkout conversion. Under
// `core.autocrlf=true` an LF working file (clean to Git) comes back CRLF, and in
// `apply` mode, whose write never touched the user's index, `git status` lists it
// while `git diff` shows nothing. The receipt said "the target is unchanged" with
// no qualification; it now says what holds, and nothing here claims byte-exactness.
const dirs: string[] = [];
let configDir: string | undefined;
beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-takeback-conv-config-"));
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
  execFileSync("git", ["-C", repo, ...args], { env: { ...ENV, GIT_OPTIONAL_LOCKS: "0" } })
    .toString("utf8")
    .trim();

/** A result that changes near/a.txt and adds near/new.weird, whose filter the target
 * configures only after the capture, so the content proof fails and the write is
 * taken back; the target converts line endings and its a.txt is LF. */
async function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "cx-takeback-conv-"));
  const run = mkdtempSync(join(tmpdir(), "cx-takeback-conv-run-"));
  dirs.push(repo, run);
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "near"));
  writeFileSync(join(repo, "near/a.txt"), "line one\nline two\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const clone = join(mkdtempSync(join(tmpdir(), "cx-takeback-conv-clone-")), "tree");
  dirs.push(join(clone, ".."));
  await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, "rev-parse", "HEAD"));
  writeFileSync(join(clone, "near/a.txt"), "line one\nline two delivered\n");
  writeFileSync(join(clone, "near/new.weird"), "new\n");
  const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
    projectRoot: repo,
    owner: run,
  });
  git(repo, "config", "core.autocrlf", "true");
  git(repo, "config", "filter.up.smudge", "tr a-z A-Z");
  git(repo, "config", "filter.up.clean", "cat");
  writeFileSync(join(repo, ".git/info/attributes"), "*.weird filter=up\n");
  expect(git(repo, "status", "--porcelain")).toBe("");
  return {
    repo,
    deliver: (mode: "apply" | "commit") =>
      verifyAndDeliver(
        repo,
        { result: captured.result!, renderedPatch: captured.patch },
        { mode, message: "deliver", projectRoot: repo, owner: run },
        [],
      ),
  };
}

describe("a write taken back through a checkout that converts line endings", () => {
  for (const mode of ["apply", "commit"] as const)
    it(`${mode}: says the target is unchanged as Git holds it, and why its bytes may differ`, async () => {
      const t = await fixture();

      const out = await t.deliver(mode);

      expect(out).toMatchObject({
        applied: false,
        treeMutated: false,
        refusal: { code: "delivery_content_mismatch" },
      });
      expect(out.refusal!.message).toContain("the target is unchanged as Git holds it");
      expect(out.refusal!.message).toContain("can come back with converted bytes");
      // What holds: Git's content is T's, the bytes are the conversion's.
      expect(git(t.repo, "diff", "--stat")).toBe("");
      expect(readFileSync(join(t.repo, "near/a.txt"), "utf8")).toBe("line one\r\nline two\r\n");
      expect(git(t.repo, "status", "--porcelain")).toBe(mode === "apply" ? "M near/a.txt" : "");
    });
});
