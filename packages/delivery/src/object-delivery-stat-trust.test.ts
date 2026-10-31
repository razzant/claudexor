import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureWorkingTreeTransient,
  createPairRevertAnchor,
  isolatedCloneAdd,
} from "@claudexor/workspace";
import { revertInPlaceFromAnchor, verifyAndDeliver } from "./index.js";

// #535 R3 A1: a private proof or snapshot reads the bytes, whatever the user's
// configuration or index says. With `core.ignoreStat=true` the proof's re-added
// entries were assume-valid, so a written file whose bytes differ from the result
// was reported applied; the same setting made every modification refuse "not
// uptodate"; and a status that trusted a mark or a monitor let a revert answer
// reverted:true over the delivered bytes and a commit overwrite a hidden edit.
const dirs: string[] = [];
let configDir: string | undefined;
beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-stat-config-"));
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

/** A project (configured by `setup` before its first commit), a run, and a result. */
async function fixture(
  setup: (repo: string) => void,
  edit: (clone: string) => void,
  after: (repo: string) => void = () => {},
) {
  const repo = mkdtempSync(join(tmpdir(), "cx-stat-trust-"));
  const run = mkdtempSync(join(tmpdir(), "cx-stat-trust-run-"));
  dirs.push(repo, run);
  git(repo, "init", "-q", "-b", "main");
  setup(repo);
  writeFileSync(join(repo, "f.txt"), "hello\n");
  writeFileSync(join(repo, "g.txt"), "other\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  after(repo);
  const clone = join(mkdtempSync(join(tmpdir(), "cx-stat-trust-clone-")), "tree");
  dirs.push(join(clone, ".."));
  await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, "rev-parse", "HEAD"));
  edit(clone);
  const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
    projectRoot: repo,
    owner: run,
  });
  expect(captured.captureIncomplete).toBe(false);
  return { repo, run, delivery: { result: captured.result!, renderedPatch: captured.patch } };
}

const IGNORE_STAT = (repo: string) => git(repo, "config", "core.ignoreStat", "true");

/** A monitor that always answers "nothing changed since my token", recorded in the index. */
function lyingMonitor(repo: string): void {
  const hook = join(mkdtempSync(join(tmpdir(), "cx-stat-fsmonitor-")), "hook.sh");
  dirs.push(join(hook, ".."));
  writeFileSync(hook, "#!/bin/sh\nprintf 'token\\0'\n");
  chmodSync(hook, 0o755);
  git(repo, "config", "core.fsmonitor", hook);
  git(repo, "status", "--porcelain");
  git(repo, "status", "--porcelain");
}

const editF = (clone: string) => writeFileSync(join(clone, "f.txt"), "delivered\n");

describe("core.ignoreStat=true", () => {
  it("a written file whose bytes differ from the result is refused and taken back (the control setting does the same)", async () => {
    for (const ignoreStat of ["true", "false"]) {
      const f = await fixture(
        (repo) => {
          git(repo, "config", "core.ignoreStat", ignoreStat);
          // A checkout filter that does not round-trip: the written bytes are not the result's.
          git(repo, "config", "filter.upper.smudge", "tr a-z A-Z");
          git(repo, "config", "filter.upper.clean", "cat");
          writeFileSync(join(repo, ".git", "info", "attributes"), "new.txt filter=upper\n");
        },
        (clone) => writeFileSync(join(clone, "new.txt"), "lowercase bytes\n"),
      );

      const delivered = await verifyAndDeliver(
        f.repo,
        f.delivery,
        { mode: "apply", projectRoot: f.repo, owner: f.run },
        [],
      );

      expect(delivered, `core.ignoreStat=${ignoreStat}`).toMatchObject({
        applied: false,
        refusal: { code: "delivery_content_mismatch" },
      });
      expect(existsSync(join(f.repo, "new.txt")), `core.ignoreStat=${ignoreStat}`).toBe(false);
    }
  });

  it("a modification of a clean file applies, commits and reverts", async () => {
    const f = await fixture(IGNORE_STAT, editF);

    const delivered = await verifyAndDeliver(
      f.repo,
      f.delivery,
      { mode: "apply", projectRoot: f.repo, owner: f.run },
      [],
    );

    expect(delivered).toMatchObject({ applied: true, treeMutated: true });
    expect(readFileSync(join(f.repo, "f.txt"), "utf8")).toBe("delivered\n");
    const anchor = await createPairRevertAnchor(f.repo, delivered.deliveryPair!, f.repo);
    expect(await revertInPlaceFromAnchor(f.repo, anchor, f.repo)).toMatchObject({
      reverted: true,
    });
    expect(readFileSync(join(f.repo, "f.txt"), "utf8")).toBe("hello\n");

    const committed = await verifyAndDeliver(
      f.repo,
      f.delivery,
      { mode: "commit", message: "deliver", projectRoot: f.repo, owner: f.run },
      [],
    );
    expect(committed).toMatchObject({ applied: true });
    expect(git(f.repo, "show", "HEAD:f.txt")).toBe("delivered");
  });
});

describe.each([
  ["core.ignoreStat=true", IGNORE_STAT, () => {}],
  ["a filesystem monitor that reports nothing", () => {}, lyingMonitor],
  [
    "an assume-unchanged entry",
    () => {},
    (repo: string) => git(repo, "update-index", "--assume-unchanged", "f.txt"),
  ],
] as const)("%s", (_name, setup, after) => {
  it("a revert takes the delivered bytes back instead of calling them gone", async () => {
    const f = await fixture(setup, editF, after);
    const delivered = await verifyAndDeliver(
      f.repo,
      f.delivery,
      { mode: "apply", projectRoot: f.repo, owner: f.run },
      [],
    );
    expect(delivered).toMatchObject({ applied: true });
    expect(readFileSync(join(f.repo, "f.txt"), "utf8")).toBe("delivered\n");

    const anchor = await createPairRevertAnchor(f.repo, delivered.deliveryPair!, f.repo);
    const reverted = await revertInPlaceFromAnchor(f.repo, anchor, f.repo);

    expect(reverted).toMatchObject({ reverted: true });
    expect(readFileSync(join(f.repo, "f.txt"), "utf8")).toBe("hello\n");
  });

  it("a commit never overwrites an edit the user's Git does not report", async () => {
    const f = await fixture(setup, editF, after);
    writeFileSync(join(f.repo, "f.txt"), "the user's own edit\n");
    const head = git(f.repo, "rev-parse", "HEAD");

    const delivered = await verifyAndDeliver(
      f.repo,
      f.delivery,
      { mode: "commit", message: "deliver", projectRoot: f.repo, owner: f.run },
      [],
    );

    expect(delivered).toMatchObject({ applied: false });
    expect(readFileSync(join(f.repo, "f.txt"), "utf8")).toBe("the user's own edit\n");
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(head);
  });
});
