import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureWorkingTreeTransient } from "./git-transient-capture.js";
import { objectStorePath, pruneObjectStore } from "./object-store.js";
import { materializeSavedFiles } from "./object-saved-files.js";

// Review and synthesis of a result with no patch view read a copy of its saved
// tree, the bytes apply consumes, however the workspace moved on since the capture.
const dirs: string[] = [];
const configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
// The capture reads the test's own environment, as in a run, so the host's Git
// configuration would decide what these fixtures store: git-lfs installed on a CI
// runner defines `filter.lfs.process`, which wins over a repository's own `clean`,
// and `core.safecrlf=true` refuses an `eol=crlf` file. Here it reads no global or
// system configuration, as `git` does.
beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
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

function repository() {
  const root = mkdtempSync(join(tmpdir(), "cx-saved-files-"));
  dirs.push(root);
  process.env["CLAUDEXOR_CONFIG_DIR"] = join(root, "config");
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "kept.txt"), "kept\n");
  writeFileSync(join(repo, "gone.txt"), "gone\n");
  writeFileSync(join(repo, "edited.txt"), "before\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  return { root, repo, into: join(root, "copy") };
}

describe("materializeSavedFiles", () => {
  it("copies exactly what the saved tree changed, not what the workspace holds now", async () => {
    const { repo, into } = repository();
    writeFileSync(join(repo, "edited.txt"), "saved\n");
    writeFileSync(join(repo, "added.txt"), "added\n");
    mkdirSync(join(repo, "deep/er"), { recursive: true });
    writeFileSync(join(repo, "deep/er/file.txt"), "deep\n");
    rmSync(join(repo, "gone.txt"));
    const captured = await captureWorkingTreeTransient(repo, "HEAD");
    // The workspace moves on after the capture.
    writeFileSync(join(repo, "edited.txt"), "rewritten by a gate\n");
    writeFileSync(join(repo, "gone.txt"), "recreated by a gate\n");
    rmSync(join(repo, "added.txt"));

    const saved = await materializeSavedFiles({
      repo,
      projectRoot: repo,
      result: captured.result!,
      changedPaths: captured.changedPaths ?? ["edited.txt"],
      into,
    });

    expect(saved.written.sort()).toEqual(["added.txt", "deep/er/file.txt", "edited.txt"]);
    expect(saved.unavailable).toEqual([]);
    expect(readFileSync(join(into, "edited.txt"), "utf8")).toBe("saved\n");
    expect(readFileSync(join(into, "added.txt"), "utf8")).toBe("added\n");
    expect(readFileSync(join(into, "deep/er/file.txt"), "utf8")).toBe("deep\n");
    expect(existsSync(join(into, "gone.txt"))).toBe(false);
    expect(existsSync(join(into, "kept.txt"))).toBe(false);
  });

  it("resolves attributes from the saved tree alone, not from a rule a gate wrote after the capture", async () => {
    const { repo, into } = repository();
    writeFileSync(join(repo, "new.txt"), "plain utf-8 bytes\n");
    const captured = await captureWorkingTreeTransient(repo, "HEAD");
    // A configured gate adds an attribute rule to the workspace after the capture.
    writeFileSync(join(repo, ".gitattributes"), "new.txt working-tree-encoding=UTF-16LE\n");
    git(repo, "config", "core.autocrlf", "false");

    const saved = await materializeSavedFiles({
      repo,
      projectRoot: repo,
      result: captured.result!,
      changedPaths: ["new.txt"],
      into,
    });

    expect(saved).toEqual({ written: ["new.txt"], unavailable: [] });
    expect(readFileSync(join(into, "new.txt"))).toEqual(Buffer.from("plain utf-8 bytes\n"));
  });

  it("applies the attributes the saved tree itself holds, as a delivery's checkout does", async () => {
    const { repo, into } = repository();
    writeFileSync(join(repo, ".gitattributes"), "crlf.txt eol=crlf\n");
    writeFileSync(join(repo, "crlf.txt"), "one\ntwo\n");
    const captured = await captureWorkingTreeTransient(repo, "HEAD");
    rmSync(join(repo, ".gitattributes"));

    const saved = await materializeSavedFiles({
      repo,
      projectRoot: repo,
      result: captured.result!,
      changedPaths: [".gitattributes", "crlf.txt"],
      into,
    });

    expect(saved.unavailable).toEqual([]);
    expect(readFileSync(join(into, "crlf.txt"), "utf8")).toBe("one\r\ntwo\r\n");
  });

  it.skipIf(process.platform === "win32")("keeps modes and symlinks exactly", async () => {
    const { repo, into } = repository();
    writeFileSync(join(repo, "tool.sh"), "#!/bin/sh\n");
    chmodSync(join(repo, "tool.sh"), 0o755);
    symlinkSync("kept.txt", join(repo, "link.txt"));
    const captured = await captureWorkingTreeTransient(repo, "HEAD");

    await materializeSavedFiles({
      repo,
      projectRoot: repo,
      result: captured.result!,
      changedPaths: [],
      into,
    });

    expect(lstatSync(join(into, "tool.sh")).mode & 0o111).not.toBe(0);
    expect(readlinkSync(join(into, "link.txt"))).toBe("kept.txt");
  });

  it("reads objects only the project store holds", async () => {
    const { root, repo, into } = repository();
    writeFileSync(join(repo, "edited.txt"), "only in the store\n");
    const owner = join(root, "run");
    mkdirSync(owner);
    const captured = await captureWorkingTreeTransient(repo, "HEAD", [], { owner });
    expect(git(repo, "cat-file", "-t", captured.result!.base_tree)).toBe("tree");
    expect(() => git(repo, "cat-file", "-t", captured.result!.candidate_tree)).toThrow();

    const saved = await materializeSavedFiles({
      repo,
      projectRoot: repo,
      result: captured.result!,
      changedPaths: captured.changedPaths ?? ["edited.txt"],
      into,
    });

    expect(saved).toEqual({ written: ["edited.txt"], unavailable: [] });
    expect(readFileSync(join(into, "edited.txt"), "utf8")).toBe("only in the store\n");
    // Its lease ended with it, and the store's own prune is free again.
    expect(readdirSync(join(objectStorePath(repo), "claudexor/pending"))).toEqual([]);
    await expect(
      pruneObjectStore({
        store: objectStorePath(repo),
        graceMs: 60_000,
        objectFormat: "sha1",
      }),
    ).resolves.toMatchObject({ yielded: false });
  });

  it("names every changed path and leaves nothing to read when a checkout fails partway", async () => {
    const { repo, into } = repository();
    writeFileSync(join(repo, "edited.txt"), "saved\n");
    writeFileSync(join(repo, "lost.txt"), "its blob is gone\n");
    const captured = await captureWorkingTreeTransient(repo, "HEAD");
    // The trees stay readable; one blob is lost, so the checkout writes edited.txt first.
    const store = objectStorePath(repo);
    const lost = git(store, "rev-parse", `${captured.result!.candidate_tree}:lost.txt`);
    rmSync(join(store, "objects", lost.slice(0, 2), lost.slice(2)));

    const saved = await materializeSavedFiles({
      repo,
      projectRoot: repo,
      result: captured.result!,
      changedPaths: captured.changedPaths ?? ["edited.txt"],
      into,
    });

    expect(saved.written).toEqual([]);
    expect(saved.unavailable.map(({ path }) => path).sort()).toEqual(["edited.txt", "lost.txt"]);
    expect(new Set(saved.unavailable.map(({ reason }) => reason))).toEqual(new Set(["git_failed"]));
    expect(readdirSync(into)).toEqual([]);
  });

  // #535 R14 A2: the copy ran in the capture's own repository, so `--attr-source` kept
  // the workspace's `.gitattributes` out but not its `.git/info/attributes`, its
  // filter configuration or the user's global settings: a gate that changed them
  // after the capture made review read bytes apply never writes.
  describe("nothing written after the capture reaches the copy", () => {
    it("a filter the workspace's info attributes and configuration name", async () => {
      const { repo, into } = repository();
      writeFileSync(join(repo, "edited.txt"), "after!\n");
      const captured = await captureWorkingTreeTransient(repo, "HEAD");
      git(repo, "config", "filter.upper.smudge", "tr a-z A-Z");
      git(repo, "config", "filter.upper.clean", "cat");
      writeFileSync(join(repo, ".git/info/attributes"), "edited.txt filter=upper\n");

      const saved = await materializeSavedFiles({
        repo,
        projectRoot: repo,
        result: captured.result!,
        changedPaths: ["edited.txt"],
        into,
      });

      expect(saved).toEqual({ written: ["edited.txt"], unavailable: [] });
      expect(readFileSync(join(into, "edited.txt"), "utf8")).toBe("after!\n");
    });

    it("an encoding the workspace's info attributes name", async () => {
      const { repo, into } = repository();
      writeFileSync(join(repo, "edited.txt"), "candidate\n");
      const captured = await captureWorkingTreeTransient(repo, "HEAD");
      writeFileSync(
        join(repo, ".git/info/attributes"),
        "edited.txt working-tree-encoding=UTF-16LE\n",
      );

      await materializeSavedFiles({
        repo,
        projectRoot: repo,
        result: captured.result!,
        changedPaths: ["edited.txt"],
        into,
      });

      expect(readFileSync(join(into, "edited.txt"))).toEqual(Buffer.from("candidate\n"));
    });

    it("the user's global configuration and attributes file", async () => {
      const { root, repo, into } = repository();
      writeFileSync(join(repo, "edited.txt"), "line one\nline two\n");
      const captured = await captureWorkingTreeTransient(repo, "HEAD");
      const xdg = join(root, "xdg");
      mkdirSync(join(xdg, "git"), { recursive: true });
      writeFileSync(join(xdg, "git/attributes"), "edited.txt working-tree-encoding=UTF-16LE\n");
      writeFileSync(join(root, "global-config"), "[core]\n\tautocrlf = true\n");
      const saved = {
        XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"],
        GIT_CONFIG_GLOBAL: process.env["GIT_CONFIG_GLOBAL"],
      };
      process.env["XDG_CONFIG_HOME"] = xdg;
      process.env["GIT_CONFIG_GLOBAL"] = join(root, "global-config");
      try {
        await materializeSavedFiles({
          repo,
          projectRoot: repo,
          result: captured.result!,
          changedPaths: ["edited.txt"],
          into,
        });
      } finally {
        for (const [key, value] of Object.entries(saved))
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
      }

      expect(readFileSync(join(into, "edited.txt"))).toEqual(Buffer.from("line one\nline two\n"));
    });

    it("a filter the result's own attributes name is configuration it does not carry: the stored blob", async () => {
      const { repo, into } = repository();
      writeFileSync(join(repo, ".gitattributes"), "*.bin filter=lfs\n");
      writeFileSync(join(repo, "big.bin"), "version https://git-lfs.github.com/spec/v1\n");
      git(repo, "config", "filter.lfs.clean", "cat");
      git(repo, "config", "filter.lfs.smudge", "tr a-z A-Z");
      git(repo, "config", "filter.lfs.required", "true");
      const captured = await captureWorkingTreeTransient(repo, "HEAD");

      const saved = await materializeSavedFiles({
        repo,
        projectRoot: repo,
        result: captured.result!,
        changedPaths: [".gitattributes", "big.bin"],
        into,
      });

      // The stored blob is what the workspace held: the repository's `clean` is `cat`.
      const blob = `${captured.result!.candidate_tree}:big.bin`;
      const stored = execFileSync("git", ["-C", objectStorePath(repo), "cat-file", "blob", blob], {
        env: ENV,
        encoding: "utf8",
      });
      expect(stored).toBe("version https://git-lfs.github.com/spec/v1\n");
      expect(saved.unavailable).toEqual([]);
      expect(readFileSync(join(into, "big.bin"), "utf8")).toBe(stored);
    });
  });

  it("names every changed path when the objects are gone", async () => {
    const { root, repo, into } = repository();
    writeFileSync(join(repo, "edited.txt"), "only in the store\n");
    const owner = join(root, "run");
    mkdirSync(owner);
    const captured = await captureWorkingTreeTransient(repo, "HEAD", [], { owner });
    rmSync(join(objectStorePath(repo), "objects"), { recursive: true, force: true });

    const saved = await materializeSavedFiles({
      repo,
      projectRoot: repo,
      result: captured.result!,
      changedPaths: captured.changedPaths ?? ["edited.txt"],
      into,
    });

    expect(saved).toEqual({
      written: [],
      unavailable: [{ path: "edited.txt", reason: "git_failed" }],
    });
    expect(readdirSync(into)).toEqual([]);
  });

  it("starts from an empty directory: nothing older passes for the result's content", async () => {
    const { repo, into } = repository();
    mkdirSync(into, { recursive: true });
    writeFileSync(join(into, "edited.txt"), "left by an earlier copy\n");
    writeFileSync(join(into, "stale.txt"), "left by an earlier copy\n");
    writeFileSync(join(repo, "edited.txt"), "saved\n");
    const captured = await captureWorkingTreeTransient(repo, "HEAD");

    const saved = await materializeSavedFiles({
      repo,
      projectRoot: repo,
      result: captured.result!,
      changedPaths: ["edited.txt"],
      into,
    });

    expect(saved).toEqual({ written: ["edited.txt"], unavailable: [] });
    expect(readFileSync(join(into, "edited.txt"), "utf8")).toBe("saved\n");
    expect(existsSync(join(into, "stale.txt"))).toBe(false);
  });

  it("a result with no changes writes nothing", async () => {
    const { repo, into } = repository();
    const captured = await captureWorkingTreeTransient(repo, "HEAD");

    expect(
      await materializeSavedFiles({
        repo,
        projectRoot: repo,
        result: captured.result!,
        changedPaths: [],
        into,
      }),
    ).toEqual({ written: [], unavailable: [] });
    expect(readdirSync(into)).toEqual([]);
  });
});
