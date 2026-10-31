import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureWorkingTreeTransient, stashCreate } from "./git.js";
import * as observed from "./git-observed.js";
import { GIT_STALL_MS } from "./git-observed.js";

// #535 R3 C1: capture's `add -A` and a snapshot's re-hash every tracked file from a
// scratch index. A blob the repository already holds is neither printed nor written
// again, so honest hashing of a very large tree looked like a stall under the flat
// ten-minute bound. The silent-read allowance now grows with the tree's blob bytes,
// read from object headers alone. ESM namespaces cannot be spied, so the module
// that runs Git children is wrapped once to record each child's bound.
const bounds: { label: string; stallMs: number | undefined }[] = [];
vi.mock("./git-observed.js", async (original) => {
  const real = await original<typeof import("./git-observed.js")>();
  return {
    ...real,
    gitObserved: (...args: Parameters<typeof real.gitObserved>) => {
      bounds.push({ label: args[2].label, stallMs: args[2].stallMs });
      return real.gitObserved(...args);
    },
  };
});

const dirs: string[] = [];
const configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
afterEach(() => {
  bounds.splice(0);
  process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
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

const BIG = 3 * 1024 * 1024;

/** A repository whose HEAD holds a 3 MiB file and a small one, with a small edit. */
function repository(): string {
  const repo = mkdtempSync(join(tmpdir(), "cx-capture-stall-"));
  dirs.push(repo);
  process.env["CLAUDEXOR_CONFIG_DIR"] = join(repo, ".config-dir");
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), ".config-dir/\n");
  writeFileSync(join(repo, "big.bin"), Buffer.alloc(BIG, 7));
  writeFileSync(join(repo, "small.txt"), "small\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  writeFileSync(join(repo, "small.txt"), "edited\n");
  return repo;
}

const boundOf = (label: string) => bounds.find((bound) => bound.label === label)?.stallMs;
/** HEAD's blob bytes as `ls-tree -l` lists them, and the bound they give. */
const headBytes = (repo: string) =>
  git(repo, "ls-tree", "-r", "-l", "HEAD")
    .split("\n")
    .reduce((sum, line) => sum + Number(line.split(/\s+/)[3] ?? 0), 0);
const scaled = (repo: string) => GIT_STALL_MS + Math.ceil(headBytes(repo) / 1024);

describe("the silent-read allowance of a re-hash", () => {
  it("counts a tree's blob bytes from object headers", async () => {
    const repo = repository();

    expect(headBytes(repo)).toBe(BIG + "small\n".length + ".config-dir/\n".length);
    expect(await observed.treeBlobBytes(repo, "HEAD")).toBe(headBytes(repo));
    expect(await observed.treeBlobBytes(repo, "no-such-tree")).toBe(0);
  });

  it("grows a capture's add -A bound with the base's bytes", async () => {
    const repo = repository();

    await captureWorkingTreeTransient(repo, "HEAD");

    expect(boundOf("add -A (capture)")).toBe(scaled(repo));
  });

  it("grows a snapshot's add -A bound with HEAD's bytes", async () => {
    const repo = repository();

    expect(await stashCreate(repo)).not.toBeNull();

    expect(boundOf("add -A (snapshot)")).toBe(scaled(repo));
  });
});
