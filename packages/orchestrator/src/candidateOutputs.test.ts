import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFileBackedSynthesisInput,
  materializeWinnerOutputs,
  persistCandidateOutputs,
  stageFileBackedContext,
} from "./candidateOutputs.js";

const roots: string[] = [];
const root = (prefix: string) => {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
};

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("candidate produced-output persistence", () => {
  it("keeps giant candidate diffs out of the argv prompt without truncation", () => {
    const huge = "diff-line\n".repeat(100_000);
    const packet = buildFileBackedSynthesisInput({
      instructions: "Combine the candidates.",
      findings: ["fix the blocker"],
      candidates: [{ label: "Candidate A", attemptId: "a01", diff: huge }],
    });
    expect(packet.prompt.length).toBeLessThan(500);
    expect(packet.prompt).not.toContain(huge.slice(0, 1_000));
    expect(packet.content).toContain(huge);
    expect(packet.content).toContain("fix the blocker");
  });

  it("stages synthesis context transiently and cleans it before diffing", () => {
    const worktree = root("claudexor-synthesis-tree-");
    const path = join(worktree, ".claudexor-synthesis-input.md");
    const cleanup = stageFileBackedContext(worktree, "full evidence");
    expect(readFileSync(path, "utf8")).toBe("full evidence");
    cleanup();
    cleanup();
    expect(existsSync(path)).toBe(false);
  });

  it("preserves raster outputs only and materializes winner-relative links", () => {
    const worktree = root("claudexor-output-tree-");
    const runRoot = root("claudexor-output-run-");
    const attemptDir = join(runRoot, "attempts", "a03");
    mkdirSync(join(worktree, "screenshots"), { recursive: true });
    writeFileSync(join(worktree, "screenshots", "race.png"), Buffer.from([0x89, 0x50, 0x4e]));
    writeFileSync(join(worktree, "game.js"), "source");
    const outside = join(worktree, "..", "outside.png");
    writeFileSync(outside, "must not copy");
    symlinkSync(outside, join(worktree, "screenshots", "host-link.png"));

    const paths = persistCandidateOutputs({
      worktreePath: worktree,
      attemptDir,
      changedPaths: [
        "screenshots/race.png",
        "screenshots/host-link.png",
        "game.js",
        "../outside.png",
      ],
    });
    expect(paths).toEqual(["screenshots/race.png"]);
    expect(existsSync(join(attemptDir, "produced", "screenshots", "race.png"))).toBe(true);
    expect(existsSync(join(attemptDir, "produced", "game.js"))).toBe(false);

    materializeWinnerOutputs({ attemptDir, runRoot, paths });
    expect(readFileSync(join(runRoot, "screenshots", "race.png"))).toEqual(
      Buffer.from([0x89, 0x50, 0x4e]),
    );
    rmSync(outside, { force: true });
  });
});
