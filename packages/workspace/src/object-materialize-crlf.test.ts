import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { GIT_STALL_MS } from "./git-observed.js";
import { materializeTree, proofStallMs } from "./object-materialize.js";

// INV-041: a committed CRLF blob stays CRLF. Git keeps CR when the INDEXED file
// holds one, so its clean conversion is only comparable through an index: the
// content proof reads written paths the way `git status` compares them.
const stallBounds: { label: string; stallMs?: number }[] = [];
vi.mock("./git-observed.js", async (original) => {
  const actual = await original<typeof import("./git-observed.js")>();
  return {
    ...actual,
    gitObserved: async (...args: Parameters<typeof actual.gitObserved>) => {
      const options = args[2];
      stallBounds.push({
        label: options.label,
        ...(options.stallMs === undefined ? {} : { stallMs: options.stallMs }),
      });
      return actual.gitObserved(...args);
    },
  };
});

const dirs: string[] = [];
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
const git = (repo: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...ENV, ...env }, input })
    .toString("utf8")
    .trim();

/** A repository whose committed blob holds CRLF, with `config` set afterwards. */
function crlfRepo(attributes: string | null, config: Record<string, string> = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "cx-crlf-"));
  dirs.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "win.txt"), "one\r\ntwo\r\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "crlf blob"]);
  if (attributes) {
    writeFileSync(join(repo, ".gitattributes"), attributes);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "attributes"]);
  }
  for (const [key, value] of Object.entries(config)) git(repo, ["config", key, value]);
  return repo;
}

/** HEAD's tree with `path` holding exactly `bytes`, through a private index. */
function editedTree(repo: string, path: string, bytes: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "cx-crlf-index-"));
  dirs.push(scratch);
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  git(repo, ["read-tree", "HEAD"], env);
  const oid = git(repo, ["hash-object", "-w", "--no-filters", "--stdin"], env, bytes);
  git(repo, ["update-index", "-z", "--index-info"], env, `100644 ${oid}\t${path}\0`);
  return git(repo, ["write-tree"], env);
}

const head = (repo: string) => git(repo, ["rev-parse", "HEAD^{tree}"]);

describe("the content proof of a CRLF blob", () => {
  it.each([
    ["* text=auto", "* text=auto\n", {}],
    ["core.autocrlf=true", null, { "core.autocrlf": "true" }],
    ["core.autocrlf=input", null, { "core.autocrlf": "input" }],
  ] as const)("%s: an edit that keeps CRLF is proven", async (_name, attributes, config) => {
    const repo = crlfRepo(attributes, config);
    const from = head(repo);
    const to = editedTree(repo, "win.txt", "one\r\nTWO\r\n");

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toEqual({ ok: true, changed: 1, treeMutated: true });
    expect(readFileSync(join(repo, "win.txt"))).toEqual(Buffer.from("one\r\nTWO\r\n"));
    expect(git(repo, ["status", "--porcelain"])).toBe("M win.txt");
  });

  it("a real index move is proven too, and the live index keeps the written tree", async () => {
    const repo = crlfRepo("* text=auto\n");
    const from = head(repo);
    const to = editedTree(repo, "win.txt", "one\r\nTWO\r\n");

    const written = await materializeTree({ worktree: repo, from, to, index: "real" });

    expect(written).toEqual({ ok: true, changed: 1, treeMutated: true });
    expect(git(repo, ["write-tree"])).toBe(to);
    expect(git(repo, ["status", "--porcelain"])).toBe("M  win.txt");
  });

  it("a file that really differs from the written tree still fails the proof", async () => {
    const repo = crlfRepo("*.up filter=up\n", {
      // Not a round trip: what checkout writes never cleans back to the blob.
      "filter.up.clean": "tr a-z A-Z",
      "filter.up.smudge": "cat",
    });
    const from = head(repo);
    const to = editedTree(repo, "new.up", "lower bytes\n");

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toMatchObject({
      ok: false,
      treeMutated: true,
      unproven: ["new.up"],
      refusal: { code: "delivery_content_mismatch", paths: ["new.up"] },
    });
  });

  it("an unrelated edit elsewhere is no mismatch of the written paths", async () => {
    const repo = crlfRepo("* text=auto\n");
    writeFileSync(join(repo, "other.txt"), "tracked\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "another"]);
    const from = head(repo);
    const to = editedTree(repo, "win.txt", "one\r\nTWO\r\n");
    writeFileSync(join(repo, "other.txt"), "edited by the user, not written\n");

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toEqual({ ok: true, changed: 1, treeMutated: true });
    expect(readFileSync(join(repo, "other.txt"), "utf8")).toBe("edited by the user, not written\n");
  });

  it("a real index proof leaves the user's index file itself as the checkout left it", async () => {
    const repo = crlfRepo("* text=auto\n");
    const from = head(repo);
    const to = editedTree(repo, "win.txt", "one\r\nTWO\r\n");
    await materializeTree({ worktree: repo, from, to, index: "real" });
    // Nothing the proof re-added without stat data reached the live index.
    const staged = git(repo, ["ls-files", "--debug", "win.txt"]);
    expect(staged).toMatch(/size: [1-9]/);
  });
});

describe("the proof's stall bound (O4)", () => {
  it("a silent proof child gets its time from the bytes it must read, with no ceiling", () => {
    expect(proofStallMs(0)).toBe(GIT_STALL_MS);
    // Measured: about 64 MiB/s of clean hashing, so 38 GiB took all of a flat ten minutes.
    expect(proofStallMs(38 * 1024 ** 3)).toBeGreaterThan(GIT_STALL_MS * 5);
    expect(proofStallMs(1024 ** 4)).toBeGreaterThan(proofStallMs(38 * 1024 ** 3) * 20);
  });

  it("the refresh that hashes the written bytes runs under that bound", async () => {
    const repo = crlfRepo("* text=auto\n");
    const from = head(repo);
    const body = "x".repeat(1024 * 1024) + "\r\n";
    const to = editedTree(repo, "win.txt", body);
    stallBounds.length = 0;

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toMatchObject({ ok: true });
    const proof = stallBounds.filter((call) => call.label === "update-index --refresh (proof)");
    expect(proof).toEqual([
      { label: "update-index --refresh (proof)", stallMs: proofStallMs(Buffer.byteLength(body)) },
    ]);
  });
});
