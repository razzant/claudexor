import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureWorkingTreeTransient } from "./git-transient-capture.js";
import { materializeSavedFiles } from "./object-saved-files.js";

// #535 R3 B4: the saved files of an unrendered result are copied for review and for
// synthesis. A copy that cannot fit is not started, so a full disk names the files
// unavailable (the review cannot pass clean) instead of ending the run. ESM
// namespaces cannot be spied, so node:fs is wrapped once for this file.
let freeBytes: number | null = null;
// #535 R14 A3: a fault injected where the copy allocates (its scratch, or the copy
// directory itself), and one where its scratch is removed afterwards. #535 R14 A3
// (cleanup): `list` and `remove` fail where the copy directory is emptied.
let faults: {
  scratch?: Error;
  into?: string;
  intoError?: Error;
  cleanup?: Error;
  list?: Error;
  remove?: Error;
} = {};
const SCRATCH = "claudexor-saved-files-";
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    statfsSync: (...args: Parameters<typeof fs.statfsSync>) => {
      const real = fs.statfsSync(...args);
      return freeBytes === null ? real : { ...real, bavail: 1, bsize: freeBytes };
    },
    mkdtempSync: (...args: Parameters<typeof fs.mkdtempSync>) => {
      if (faults.scratch && String(args[0]).includes(SCRATCH)) throw faults.scratch;
      return fs.mkdtempSync(...args);
    },
    mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => {
      if (faults.intoError && String(args[0]) === faults.into) throw faults.intoError;
      return fs.mkdirSync(...args);
    },
    readdirSync: ((...args: Parameters<typeof fs.readdirSync>) => {
      if (faults.list && String(args[0]) === faults.into) throw faults.list;
      return (fs.readdirSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof fs.readdirSync,
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      if (faults.remove && faults.into && String(args[0]).startsWith(faults.into))
        throw faults.remove;
      if (faults.cleanup && String(args[0]).includes(SCRATCH)) throw faults.cleanup;
      return fs.rmSync(...args);
    },
  };
});
const errno = (code: string) =>
  Object.assign(new Error(`${code}: injected at the saved-file copy's allocation`), { code });

const dirs: string[] = [];
const configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
afterEach(() => {
  freeBytes = null;
  faults = {};
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

async function savedResult() {
  const root = mkdtempSync(join(tmpdir(), "cx-saved-space-"));
  dirs.push(root);
  process.env["CLAUDEXOR_CONFIG_DIR"] = join(root, "config");
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "kept.txt"), "kept\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  writeFileSync(join(repo, "big.txt"), "x".repeat(64 * 1024));
  writeFileSync(join(repo, "small.txt"), "small\n");
  const captured = await captureWorkingTreeTransient(repo, "HEAD");
  return { repo, into: join(root, "copy"), result: captured.result! };
}

describe("a saved-file copy and free space", () => {
  it("that cannot fit writes nothing and names every file unavailable", async () => {
    const { repo, into, result } = await savedResult();
    freeBytes = 4096;

    const saved = await materializeSavedFiles({
      repo,
      projectRoot: repo,
      result,
      changedPaths: ["big.txt", "small.txt"],
      into,
    });

    // #535 R5 B4: each named with the copy's own cause, not a generic one.
    expect(saved).toEqual({
      written: [],
      unavailable: [
        { path: "big.txt", reason: "space_insufficient" },
        { path: "small.txt", reason: "space_insufficient" },
      ],
    });
    expect(readdirSync(into)).toEqual([]);
  });

  it("that fits is written", async () => {
    const { repo, into, result } = await savedResult();

    const saved = await materializeSavedFiles({
      repo,
      projectRoot: repo,
      result,
      changedPaths: ["big.txt", "small.txt"],
      into,
    });

    expect(saved).toEqual({ written: ["big.txt", "small.txt"], unavailable: [] });
  });
});

describe("a saved-file copy whose own allocation fails", () => {
  for (const code of ["ENOSPC", "EDQUOT"])
    for (const where of ["scratch", "into"] as const)
      it(`${code} at its ${where === "scratch" ? "first allocation, the scratch" : "copy directory, inside"} names every file unavailable, never a throw`, async () => {
        const { repo, into, result } = await savedResult();
        faults = where === "scratch" ? { scratch: errno(code) } : { into, intoError: errno(code) };

        const saved = await materializeSavedFiles({
          repo,
          projectRoot: repo,
          result,
          changedPaths: ["big.txt", "small.txt"],
          into,
        });

        expect(saved).toEqual({
          written: [],
          unavailable: [
            { path: "big.txt", reason: "space_insufficient" },
            { path: "small.txt", reason: "space_insufficient" },
          ],
        });
      });

  it("a scratch that cannot be removed afterwards does not replace that answer", async () => {
    const { repo, into, result } = await savedResult();
    faults = { into, intoError: errno("ENOSPC"), cleanup: errno("EBUSY") };

    const saved = await materializeSavedFiles({
      repo,
      projectRoot: repo,
      result,
      changedPaths: ["big.txt"],
      into,
    });

    expect(saved.unavailable).toEqual([{ path: "big.txt", reason: "space_insufficient" }]);
  });

  it("any other fault there is no absence: it is thrown as before (control)", async () => {
    const { repo, into, result } = await savedResult();
    for (const fault of [errno("EACCES"), new Error("not a filesystem fault")]) {
      faults = { scratch: fault };
      await expect(
        materializeSavedFiles({
          repo,
          projectRoot: repo,
          result,
          changedPaths: ["big.txt"],
          into,
        }),
      ).rejects.toBe(fault);
    }
  });

  // #535 R14 A3 (cleanup): the copy directory is emptied after the typed fault; a
  // fault there is not the answer, and what stays is never offered as a whole copy.
  describe("whose directory cannot be emptied afterwards", () => {
    async function withPriorFile() {
      const f = await savedResult();
      mkdirSync(f.into, { recursive: true });
      writeFileSync(join(f.into, "prior.txt"), "prior task-owned scratch\n");
      return f;
    }
    const copy = (f: Awaited<ReturnType<typeof savedResult>>) =>
      materializeSavedFiles({
        repo: f.repo,
        projectRoot: f.repo,
        result: f.result,
        changedPaths: ["big.txt"],
        into: f.into,
      });

    it("empties it and answers with the typed cause (control)", async () => {
      const f = await withPriorFile();
      faults = { scratch: errno("ENOSPC") };

      expect(await copy(f)).toEqual({
        written: [],
        unavailable: [{ path: "big.txt", reason: "space_insufficient" }],
      });
      expect(readdirSync(f.into)).toEqual([]);
    });

    // #535 R15: what stays is the failed copy's leftover, no file of the result: it is
    // not named as one (a failed copy is never read), and its owner removes it later.
    for (const code of ["EIO", "EBUSY"])
      it(`${code} removing a leftover keeps the typed cause; the leftover stays, never named as a file of the result`, async () => {
        const f = await withPriorFile();
        faults = { scratch: errno("ENOSPC"), into: f.into, remove: errno(code) };

        expect(await copy(f)).toEqual({
          written: [],
          unavailable: [{ path: "big.txt", reason: "space_insufficient" }],
        });
        expect(existsSync(join(f.into, "prior.txt"))).toBe(true);
      });

    it("EIO listing it keeps the typed cause and removes the directory whole", async () => {
      const f = await withPriorFile();
      faults = { scratch: errno("ENOSPC"), into: f.into, list: errno("EIO") };

      expect(await copy(f)).toEqual({
        written: [],
        unavailable: [{ path: "big.txt", reason: "space_insufficient" }],
      });
      expect(existsSync(f.into)).toBe(false);
    });

    it("EIO listing it and removing it keeps the typed cause", async () => {
      const f = await withPriorFile();
      faults = { scratch: errno("ENOSPC"), into: f.into, list: errno("EIO"), remove: errno("EIO") };

      expect(await copy(f)).toEqual({
        written: [],
        unavailable: [{ path: "big.txt", reason: "space_insufficient" }],
      });
    });
  });
});
