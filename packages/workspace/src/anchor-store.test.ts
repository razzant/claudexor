import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GIT_OBJECTS_V1, type GitDeliveryPair } from "@claudexor/schema";
import { projectRuntimeDir } from "@claudexor/util";
import {
  createPairRevertAnchor,
  createPairRevertAnchorOrNull,
  readRevertPair,
} from "./anchor-store.js";
import { ensureObjectStore, objectStorePath } from "./object-store.js";

// #535 round 9: a pair anchor is published only with its objects kept. A call
// whose store custody fails leaves no anchor of its own behind, and never
// removes one an earlier call published.
const dirs: string[] = [];
let configDir: string | undefined;
beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = temp("cx-anchor-config-");
});
afterEach(() => {
  if (configDir === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
  else process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
});
afterAll(() => {
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
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
const git = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: ENV })
    .toString("utf8")
    .trim();

/** A repository whose second commit is a delivery's pair (T = its parent, M = its tree). */
function delivered(): { repo: string; pair: GitDeliveryPair } {
  const repo = temp("cx-anchor-repo-");
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "file.txt"), "before\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  const pre = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "file.txt"), "after\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "delivered"]);
  return {
    repo,
    pair: {
      schema: GIT_OBJECTS_V1,
      object_format: "sha1",
      pre_commit: pre,
      pre_tree: git(repo, ["rev-parse", `${pre}^{tree}`]),
      post_tree: git(repo, ["rev-parse", "HEAD^{tree}"]),
    },
  };
}
const anchorFiles = (repo: string) => {
  const dir = join(projectRuntimeDir(repo), "anchors", "objects");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};
/** A store Claudexor refuses to use (it has alternates): every retain into it fails. */
const refusingStore = async (repo: string) => {
  const { store } = await ensureObjectStore(repo, "sha1");
  writeFileSync(join(store, "objects", "info", "alternates"), `${join(repo, ".git", "objects")}\n`);
};

describe("a pair revert anchor", () => {
  it("whose objects could not be kept is not left behind", async () => {
    const { repo, pair } = delivered();
    await refusingStore(repo);

    await expect(createPairRevertAnchor(repo, pair)).rejects.toThrow(/alternates/);

    expect(anchorFiles(repo)).toEqual([]);
    expect(await createPairRevertAnchorOrNull(repo, pair)).toBeNull();
    expect(anchorFiles(repo)).toEqual([]);
  });

  it("published by an earlier call stays when a later call's custody fails", async () => {
    const { repo, pair } = delivered();
    const id = await createPairRevertAnchor(repo, pair);
    writeFileSync(
      join(objectStorePath(repo), "objects", "info", "alternates"),
      `${join(repo, ".git", "objects")}\n`,
    );

    await expect(createPairRevertAnchor(repo, pair)).rejects.toThrow(/alternates/);

    expect(readRevertPair(repo, id)).toEqual(pair);
  });

  it("two concurrent calls for one pair publish one exact anchor and leave no temporary file", async () => {
    const { repo, pair } = delivered();

    const ids = await Promise.all([
      createPairRevertAnchor(repo, pair),
      createPairRevertAnchor(repo, pair),
    ]);

    expect(ids[0]).toBe(ids[1]);
    expect(readRevertPair(repo, ids[0])).toEqual(pair);
    expect(anchorFiles(repo)).toEqual([`${ids[0].slice(7)}.pair`]);
    const anchor = join(projectRuntimeDir(repo), "anchors", "objects", `${ids[0].slice(7)}.pair`);
    expect(readFileSync(anchor, "utf8")).toBe(`${JSON.stringify(pair)}\n`);
  });
});
