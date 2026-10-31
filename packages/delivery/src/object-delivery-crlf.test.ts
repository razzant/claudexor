import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureWorkingTreeTransient,
  createPairRevertAnchor,
  isolatedCloneAdd,
} from "@claudexor/workspace";
import { revertInPlaceFromAnchor, verifyAndDeliver } from "./index.js";

// INV-041 through delivery: a committed CRLF blob under `text=auto` or autocrlf,
// edited in an ordinary way that keeps CRLF. A proof that loads no index called
// the file changed: the fresh verify failed, apply was refused, the take-back
// said RECOVERY REQUIRED, and a revert answered reverted:false after restoring it.
const dirs: string[] = [];
let configDir: string | undefined;
beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-crlf-config-"));
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

/** A project with a committed CRLF blob, a run, and a captured edit that keeps CRLF. */
async function fixture(setup: (repo: string) => void) {
  const repo = mkdtempSync(join(tmpdir(), "cx-delivery-crlf-"));
  const run = mkdtempSync(join(tmpdir(), "cx-delivery-crlf-run-"));
  dirs.push(repo, run);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "win.txt"), "one\r\ntwo\r\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "crlf blob");
  setup(repo);
  const clone = join(mkdtempSync(join(tmpdir(), "cx-delivery-crlf-clone-")), "tree");
  dirs.push(join(clone, ".."));
  await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, "rev-parse", "HEAD"));
  writeFileSync(join(clone, "win.txt"), "one\r\nTWO\r\n");
  const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
    projectRoot: repo,
    owner: run,
  });
  expect(captured.captureIncomplete).toBe(false);
  return { repo, run, delivery: { result: captured.result!, renderedPatch: captured.patch } };
}

const TEXT_AUTO = (repo: string) => {
  writeFileSync(join(repo, ".gitattributes"), "* text=auto\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "attributes");
};
const AUTOCRLF = (repo: string) => git(repo, "config", "core.autocrlf", "true");

describe.each([
  ["* text=auto", TEXT_AUTO],
  ["core.autocrlf=true", AUTOCRLF],
])("%s: a delivery of an edit that keeps CRLF", (_name, setup) => {
  it("verifies, applies and reverts, keeping the bytes and telling the truth", async () => {
    const f = await fixture(setup);

    const delivered = await verifyAndDeliver(
      f.repo,
      f.delivery,
      { mode: "apply", projectRoot: f.repo, owner: f.run },
      [],
    );

    expect(delivered.finalVerify.applied_cleanly).toBe(true);
    expect(delivered).toMatchObject({ applied: true, treeMutated: true });
    expect(delivered.detail ?? "").not.toContain("RECOVERY REQUIRED");
    expect(readFileSync(join(f.repo, "win.txt"))).toEqual(Buffer.from("one\r\nTWO\r\n"));

    const anchor = await createPairRevertAnchor(f.repo, delivered.deliveryPair!, f.repo);
    const reverted = await revertInPlaceFromAnchor(f.repo, anchor, f.repo);

    expect(reverted).toMatchObject({ reverted: true });
    expect(readFileSync(join(f.repo, "win.txt"))).toEqual(Buffer.from("one\r\ntwo\r\n"));
    expect(git(f.repo, "status", "--porcelain")).toBe("");
  });

  it("commits", async () => {
    const f = await fixture(setup);

    const delivered = await verifyAndDeliver(
      f.repo,
      f.delivery,
      { mode: "commit", message: "keep crlf", projectRoot: f.repo, owner: f.run },
      [],
    );

    expect(delivered).toMatchObject({ applied: true });
    expect(execFileSync("git", ["-C", f.repo, "show", "HEAD:win.txt"], { env: ENV })).toEqual(
      Buffer.from("one\r\nTWO\r\n"),
    );
    expect(git(f.repo, "status", "--porcelain")).toBe("");
  });
});
