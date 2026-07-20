import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFileBackedSynthesisInput,
  collectArtifactDirMedia,
  materializeWinnerOutputs,
  persistCandidateOutputs,
  stageFileBackedContext,
  writeCandidateAttemptArtifacts,
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
  it("collects claudexor-owned artifact-dir media into the Evidence gallery (F4)", () => {
    const worktree = root("claudexor-art-wt-");
    const attemptDir = root("claudexor-art-attempt-");
    mkdirSync(join(worktree, ".claudexor-artifacts", "browser"), { recursive: true });
    writeFileSync(
      join(worktree, ".claudexor-artifacts", "browser", "shot.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    // A symlink inside the artifact dir must never be followed into the host.
    const secret = join(root("claudexor-art-secret-"), "secret.png");
    writeFileSync(secret, "host-bytes");
    symlinkSync(secret, join(worktree, ".claudexor-artifacts", "evil.png"));
    // A non-media file is left out (only declared raster media is collected).
    writeFileSync(join(worktree, ".claudexor-artifacts", "notes.txt"), "not media");

    const collected = collectArtifactDirMedia({ worktreePath: worktree, attemptDir });
    expect(collected).toEqual([".claudexor-artifacts/browser/shot.png"]);
    expect(
      existsSync(join(attemptDir, "produced", ".claudexor-artifacts", "browser", "shot.png")),
    ).toBe(true);
    expect(existsSync(join(attemptDir, "produced", ".claudexor-artifacts", "evil.png"))).toBe(
      false,
    );
  });

  it("returns nothing when there is no artifact dir (F4)", () => {
    const worktree = root("claudexor-art-none-");
    const attemptDir = root("claudexor-art-none-attempt-");
    expect(collectArtifactDirMedia({ worktreePath: worktree, attemptDir })).toEqual([]);
  });

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

  it("restores a pre-existing synthesis sentinel byte- and mode-identically", () => {
    const worktree = root("claudexor-synthesis-sentinel-");
    const path = join(worktree, ".claudexor-synthesis-input.md");
    const sentinel = Buffer.from([0, 1, 2, 0xfe, 0xff]);
    writeFileSync(path, sentinel);
    chmodSync(path, 0o640);
    const cleanup = stageFileBackedContext(worktree, "temporary evidence");
    expect(readFileSync(path, "utf8")).toBe("temporary evidence");
    cleanup();
    expect(readFileSync(path)).toEqual(sentinel);
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it("refuses a pre-existing synthesis symlink instead of writing through it", () => {
    const worktree = root("claudexor-synthesis-symlink-");
    const outside = join(root("claudexor-synthesis-host-"), "host.md");
    writeFileSync(outside, "host sentinel");
    symlinkSync(outside, join(worktree, ".claudexor-synthesis-input.md"));
    expect(() => stageFileBackedContext(worktree, "must not escape")).toThrow(/not a regular file/);
    expect(readFileSync(outside, "utf8")).toBe("host sentinel");
  });

  it("refuses a dangling synthesis symlink without creating its outside target", () => {
    const worktree = root("claudexor-synthesis-dangling-");
    const outside = join(root("claudexor-synthesis-missing-host-"), "missing.md");
    symlinkSync(outside, join(worktree, ".claudexor-synthesis-input.md"));
    expect(() => stageFileBackedContext(worktree, "must not escape")).toThrow(/not a regular file/);
    expect(existsSync(outside)).toBe(false);
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

  it("preserves a linked gitignored screenshot even when absent from the diff", () => {
    const worktree = root("claudexor-linked-output-tree-");
    const runRoot = root("claudexor-linked-output-run-");
    const attemptDir = join(runRoot, "attempts", "a01");
    mkdirSync(join(worktree, "screenshots"), { recursive: true });
    writeFileSync(join(worktree, "screenshots", "ignored.png"), Buffer.from([0x89, 0x50]));
    const writes: Record<string, unknown>[] = [];
    const produced = writeCandidateAttemptArtifacts({
      store: {
        writeText: () => undefined,
        writeYaml: (_path: string, value: unknown) => writes.push(value as Record<string, unknown>),
      } as never,
      attemptDir,
      worktreePath: worktree,
      diff: "diff --git a/game.js b/game.js\n",
      answerText: "Result: ![race](screenshots/ignored.png)",
      record: { attempt_id: "a01" },
    });
    expect(produced).toEqual(["screenshots/ignored.png"]);
    expect(existsSync(join(attemptDir, "produced", "screenshots", "ignored.png"))).toBe(true);
    expect(writes[0]?.["produced_files"]).toEqual(["screenshots/ignored.png"]);
  });
});
