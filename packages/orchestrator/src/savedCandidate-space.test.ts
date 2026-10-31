import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureWorkingTreeTransient } from "@claudexor/workspace";
import { buildFileBackedSynthesisInput } from "./candidateOutputs.js";
import { materializeUnrenderedCandidate, savedForSynthesis } from "./savedCandidate.js";

// #535 R5 B4: the copy of an unrendered result's saved files named every file it could
// not hold, but not why: a full disk reached review as `saved_file_unavailable` and
// synthesis as a bare list. The copy's own typed cause rides with each path.
let savedCopyFull = false;
// #535 R14 A3 (cleanup): the copy's scratch cannot be allocated, and the leftover in its
// directory cannot be removed afterwards.
let allocFails = false;
let cleanupFails = false;
// #535 R15: removing the copy when its reader is done fails (EIO), and the disk is then
// too full for the record of that failure (ENOSPC); `recordWrites` keeps each attempt.
let removeFails = false;
let recordFull = false;
const recordWrites: string[] = [];
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    mkdtempSync: (...args: Parameters<typeof fs.mkdtempSync>) => {
      if (allocFails && String(args[0]).includes("claudexor-saved-files-"))
        throw Object.assign(new Error("ENOSPC: injected"), { code: "ENOSPC" });
      return fs.mkdtempSync(...args);
    },
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      if (cleanupFails && String(args[0]).endsWith("prior.txt"))
        throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
      return fs.rmSync(...args);
    },
    statfsSync: (...args: Parameters<typeof fs.statfsSync>) => {
      const real = fs.statfsSync(...args);
      return savedCopyFull && String(args[0]).includes("saved-files")
        ? { ...real, bavail: 1, bsize: 1024 }
        : real;
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (recordFull && String(args[0]).endsWith(".cleanup-error.json")) {
        recordWrites.push(String(args[0]));
        throw Object.assign(new Error("ENOSPC: injected"), { code: "ENOSPC" });
      }
      return fs.writeFileSync(...args);
    },
  };
});
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rm: (...args: Parameters<typeof fs.rm>) =>
      removeFails && String(args[0]).endsWith("saved-files")
        ? Promise.reject(Object.assign(new Error("EIO: injected"), { code: "EIO" }))
        : fs.rm(...args),
  };
});

const dirs: string[] = [];
let configDir: string | undefined;
afterEach(() => {
  savedCopyFull = false;
  allocFails = false;
  cleanupFails = false;
  removeFails = false;
  recordFull = false;
  recordWrites.splice(0);
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

/** An unrendered candidate run that changed big.txt, and a run directory. */
async function unrenderedRun() {
  const root = mkdtempSync(join(tmpdir(), "cx-saved-candidate-space-"));
  dirs.push(root);
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = join(root, "config");
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"], { env: ENV });
  writeFileSync(join(repo, "kept.txt"), "kept\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { env: ENV });
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"], { env: ENV });
  writeFileSync(join(repo, "big.txt"), "x".repeat(64 * 1024));
  const captured = await captureWorkingTreeTransient(repo, "HEAD");
  const runDir = join(root, "run");
  mkdirSync(runDir);
  return {
    repo,
    runDir,
    run: {
      attemptId: "a01",
      label: "A",
      diff: "",
      result: captured.result!,
      patchViewUnavailable: {
        reason: "exceeds_view_limit" as const,
        limitBytes: 1,
        estimatedBytes: 64 * 1024,
      },
      changedPaths: ["big.txt"],
      reviewCwd: repo,
    },
  };
}

describe("a saved-file copy on a full disk", () => {
  it("gives synthesis each unavailable file with its cause", async () => {
    const f = await unrenderedRun();
    savedCopyFull = true;

    const saved = await savedForSynthesis([f.run], f.runDir, f.repo);
    try {
      const copy = saved.candidates[0]!.savedFiles!;
      expect(copy.unavailable).toEqual([{ path: "big.txt", reason: "space_insufficient" }]);
      const input = buildFileBackedSynthesisInput({
        instructions: "synthesize",
        findings: [],
        candidates: saved.candidates,
      });
      expect(input.content).toContain('{"path":"big.txt","reason":"space_insufficient"}');
    } finally {
      await saved.dispose();
    }
  });

  it("gives review each unavailable file with its cause", async () => {
    const f = await unrenderedRun();
    savedCopyFull = true;

    const copy = await materializeUnrenderedCandidate(
      f.run,
      join(f.runDir, "a01-saved-files"),
      f.repo,
    );
    try {
      expect(copy!.unavailable).toEqual([{ path: "big.txt", reason: "space_insufficient" }]);
    } finally {
      await copy!.dispose();
    }
  });

  // #535 R15: the leftover is no file of the result, so it is not named as one; the copy
  // is a failed one, which no reader reads, and synthesis gets no directory for it.
  it("gives synthesis and review the typed cause, and no directory, when the directory cannot be emptied", async () => {
    const f = await unrenderedRun();
    const dir = join(f.runDir, "a01-saved-files");
    mkdirSync(dir);
    writeFileSync(join(dir, "prior.txt"), "prior\n");
    allocFails = true;
    cleanupFails = true;
    const unavailable = [{ path: "big.txt", reason: "space_insufficient" }];

    const copy = await materializeUnrenderedCandidate(f.run, dir, f.repo);
    try {
      expect(copy!.unavailable).toEqual(unavailable);
      expect(copy!.failed).toBe(true);
      const input = buildFileBackedSynthesisInput({
        instructions: "synthesize",
        findings: [],
        candidates: [{ ...f.run, savedFiles: copy }],
      });
      expect(input.content).toContain(JSON.stringify(unavailable));
      expect(input.content).toContain("their content is unknown");
      expect(input.content).not.toContain(dir);
      expect(existsSync(join(dir, "prior.txt"))).toBe(true);
    } finally {
      cleanupFails = false;
      await copy!.dispose();
    }
  });

  it("stays, recorded beside it, when it cannot be removed afterwards; dispose never throws", async () => {
    const f = await unrenderedRun();
    const dir = join(f.runDir, "a01-saved-files");
    allocFails = true;
    const copy = await materializeUnrenderedCandidate(f.run, dir, f.repo);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "prior.txt"), "prior\n");
    removeFails = true;

    await copy!.dispose();

    expect(existsSync(join(dir, "prior.txt"))).toBe(true);
    const record = JSON.parse(readFileSync(`${dir}.cleanup-error.json`, "utf8"));
    expect(record).toMatchObject({ saved_copy_cleanup: "failed", dir });
    expect(record.error).toContain("EIO");
    removeFails = false;
    await copy!.dispose();
    expect(existsSync(dir)).toBe(false);
  });

  it("stays with its cleanup unconfirmed and no record when even the record cannot be written; dispose never throws", async () => {
    const f = await unrenderedRun();
    const dir = join(f.runDir, "a01-saved-files");
    allocFails = true;
    const copy = await materializeUnrenderedCandidate(f.run, dir, f.repo);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "prior.txt"), "prior\n");
    removeFails = true;
    recordFull = true;

    await expect(copy!.dispose()).resolves.toBeUndefined();

    // The record was attempted and refused: the leftover stays, and nothing claims more.
    expect(recordWrites).toEqual([`${dir}.cleanup-error.json`]);
    expect(existsSync(join(dir, "prior.txt"))).toBe(true);
    expect(existsSync(`${dir}.cleanup-error.json`)).toBe(false);
    removeFails = false;
    recordFull = false;
    await copy!.dispose();
    expect(existsSync(dir)).toBe(false);
  });

  it("copies the file when it fits (the control)", async () => {
    const f = await unrenderedRun();
    const copy = await materializeUnrenderedCandidate(
      f.run,
      join(f.runDir, "a01-saved-files"),
      f.repo,
    );
    try {
      expect(copy!.unavailable).toEqual([]);
    } finally {
      await copy!.dispose();
    }
  });
});
