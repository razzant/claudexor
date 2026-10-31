import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { classifyGitFailure, gitObserved, GitOperationError } from "./git-observed.js";
import { gitFaultRefusalCode } from "./object-materialize.js";

// docs/ARCHITECTURE.md: a Git child on an object path runs with no wall clock,
// only a stall bound. Output is activity whether or not a sink receives it: a
// buffered child that keeps printing is working.
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cx-observed-"));
  dirs.push(dir);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  return dir;
}

const alias = (script: string) => ["-c", `alias.child=!${script}`, "child"];

describe.skipIf(process.platform === "win32")("the stall bound of a Git child", () => {
  it("a child that keeps printing into the buffer is not stalled", async () => {
    const printing = await gitObserved(
      repo(),
      alias("for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo $i; sleep 0.2; done"),
      { label: "printing child", stallMs: 800 },
    );
    expect(printing.code).toBe(0);
    expect(printing.stdout.trim().split("\n")).toHaveLength(12);
  });

  it("a child that keeps printing into a sink is not stalled, as before", async () => {
    let bytes = 0;
    const printing = await gitObserved(
      repo(),
      alias("for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo $i; sleep 0.2; done"),
      {
        label: "printing child",
        stallMs: 800,
        stdout: {
          write: (chunk) => void (bytes += chunk.length),
          end: () => "",
        },
      },
    );
    expect(printing.code).toBe(0);
    expect(bytes).toBeGreaterThan(0);
  });

  it("a child that keeps printing to stderr is not stalled either", async () => {
    const printing = await gitObserved(
      repo(),
      alias("for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo $i >&2; sleep 0.2; done"),
      { label: "printing child", stallMs: 800 },
    );
    expect(printing.code).toBe(0);
    expect(printing.stderr.trim().split("\n")).toHaveLength(12);
  });

  it("a truly hung child is still stopped, typed", async () => {
    const hung = gitObserved(repo(), alias("sleep 30"), { label: "hung child", stallMs: 400 });
    await expect(hung).rejects.toMatchObject({ code: "capture_git_stalled", stallMs: 400 });
    await expect(hung).rejects.toBeInstanceOf(GitOperationError);
  });

  it("a child that printed and then hung is stopped too", async () => {
    const hung = gitObserved(repo(), alias("echo first; sleep 30"), {
      label: "hung child",
      stallMs: 400,
    });
    await expect(hung).rejects.toMatchObject({ code: "capture_git_stalled" });
  });
});

// #535 R14 O2: EDQUOT is the same full-disk class whichever libc spells it. macOS's
// strerror says "Disc quota exceeded", which used to read as an untyped failure.
describe("the full-disk class of a Git child's stderr", () => {
  const written = (reason: string) =>
    `error: unable to write file .git/objects/ab/cdef: ${reason}\nfatal: unable to write new index file`;

  it.each([
    ["No space left on device", "ENOSPC"],
    ["Disk quota exceeded", "EDQUOT, Linux spelling"],
    ["Disc quota exceeded", "EDQUOT, macOS spelling"],
  ])("%s is space_insufficient (%s)", (reason) => {
    expect(classifyGitFailure(written(reason))).toBe("capture_space_insufficient");
    expect(gitFaultRefusalCode(classifyGitFailure(written(reason)))).toBe("space_insufficient");
  });

  it.each([
    "Disc quota",
    "Disk quota warning",
    "quota exceeded",
    "Dish quota exceeded",
    "Permission denied",
  ])("%s is not", (reason) => {
    expect(classifyGitFailure(written(reason))).toBe("capture_failed");
  });
});
