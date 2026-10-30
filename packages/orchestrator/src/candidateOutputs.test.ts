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
  producedOmissionSummaryLine,
  collectArtifactDirMedia,
  materializeWinnerOutputs,
  persistCandidateOutputs,
  stageFileBackedContext,
  writeCandidateAttemptArtifacts,
} from "./candidateOutputs.js";

const roots: string[] = [];
const artifactRelativeDir = ".claudexor-artifacts/env_test";
const root = (prefix: string) => {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
};

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("candidate produced-output persistence", () => {
  it("collects run-owned artifact-child media into the Evidence gallery (F4)", () => {
    const worktree = root("claudexor-art-wt-");
    const attemptDir = root("claudexor-art-attempt-");
    mkdirSync(join(worktree, artifactRelativeDir, "browser"), { recursive: true });
    writeFileSync(
      join(worktree, artifactRelativeDir, "browser", "shot.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    // A symlink inside the artifact dir must never be followed into the host.
    const secret = join(root("claudexor-art-secret-"), "secret.png");
    writeFileSync(secret, "host-bytes");
    symlinkSync(secret, join(worktree, artifactRelativeDir, "evil.png"));
    // A non-media file is left out (only declared raster media is collected).
    writeFileSync(join(worktree, artifactRelativeDir, "notes.txt"), "not media");

    const collected = collectArtifactDirMedia({
      worktreePath: worktree,
      attemptDir,
      artifactRelativeDir,
    });
    expect(collected).toEqual([`${artifactRelativeDir}/browser/shot.png`]);
    expect(
      existsSync(join(attemptDir, "produced", artifactRelativeDir, "browser", "shot.png")),
    ).toBe(true);
    expect(existsSync(join(attemptDir, "produced", artifactRelativeDir, "evil.png"))).toBe(false);
  });

  it("returns nothing when there is no artifact dir (F4)", () => {
    const worktree = root("claudexor-art-none-");
    const attemptDir = root("claudexor-art-none-attempt-");
    expect(
      collectArtifactDirMedia({ worktreePath: worktree, attemptDir, artifactRelativeDir }),
    ).toEqual([]);
  });

  it("does not persist a raster larger than the per-file byte ceiling", () => {
    const worktree = root("claudexor-art-large-");
    const attemptDir = root("claudexor-art-large-attempt-");
    mkdirSync(join(worktree, artifactRelativeDir), { recursive: true });
    writeFileSync(
      join(worktree, artifactRelativeDir, "large.png"),
      Buffer.alloc(16 * 1024 * 1024 + 1),
    );

    expect(
      collectArtifactDirMedia({ worktreePath: worktree, attemptDir, artifactRelativeDir }),
    ).toEqual([]);
    expect(existsSync(join(attemptDir, "produced", artifactRelativeDir, "large.png"))).toBe(false);
  });

  it("rejects raster paths through a symlinked parent directory", () => {
    const worktree = root("claudexor-art-linked-parent-");
    const attemptDir = root("claudexor-art-linked-parent-attempt-");
    const outside = root("claudexor-art-linked-parent-outside-");
    writeFileSync(join(outside, "private.png"), Buffer.from("outside-private-bytes"));
    symlinkSync(outside, join(worktree, "screens"));

    expect(
      persistCandidateOutputs({
        worktreePath: worktree,
        attemptDir,
        changedPaths: ["screens/private.png"],
      }),
    ).toEqual({
      preserved: [],
      omitted: [{ path: "screens/private.png", reason: "unsafe_path", bytes: null }],
    });
    expect(existsSync(join(attemptDir, "produced"))).toBe(false);
  });

  it("rejects a symlinked claudexor artifact root", () => {
    const worktree = root("claudexor-art-linked-root-");
    const attemptDir = root("claudexor-art-linked-root-attempt-");
    const outside = root("claudexor-art-linked-root-outside-");
    writeFileSync(join(outside, "private.png"), Buffer.from("outside-private-bytes"));
    symlinkSync(outside, join(worktree, ".claudexor-artifacts"));

    expect(
      collectArtifactDirMedia({ worktreePath: worktree, attemptDir, artifactRelativeDir }),
    ).toEqual([]);
    expect(existsSync(join(attemptDir, "produced"))).toBe(false);
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

  it("carries complete directory manifest references into synthesis content", () => {
    const packet = buildFileBackedSynthesisInput({
      instructions: "Combine files.",
      findings: [],
      candidates: [
        {
          label: "Files A",
          attemptId: "a01",
          diff: "",
          files: {
            manifestPath: "attempts/a01/files/manifest.json",
            manifestSha256: "sha256:manifest",
            artifactRoot: "/tmp/attempt-a01",
            manifest: { entries: [{ path: "out.bin", after: { kind: "file" } }] },
          },
        },
      ],
    });
    expect(packet.content).toContain("attempts/a01/files/manifest.json");
    expect(packet.content).toContain("/tmp/attempt-a01");
    expect(packet.content).toContain('"out.bin"');
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

    const { preserved: paths, omitted } = persistCandidateOutputs({
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
    expect(omitted).toEqual([
      { path: "screenshots/host-link.png", reason: "symlink", bytes: null },
      { path: "../outside.png", reason: "unsafe_path", bytes: null },
    ]);
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
    const { produced } = writeCandidateAttemptArtifacts({
      store: {
        writeText: () => undefined,
        writePatch: () => undefined,
        writeYaml: (_path: string, value: unknown) => writes.push(value as Record<string, unknown>),
      } as never,
      attemptDir,
      worktreePath: worktree,
      artifactRelativeDir: null,
      diff: "diff --git a/game.js b/game.js\n",
      answerText: "Result: ![race](screenshots/ignored.png)",
      record: { attempt_id: "a01" },
    });
    expect(produced).toEqual(["screenshots/ignored.png"]);
    expect(existsSync(join(attemptDir, "produced", "screenshots", "ignored.png"))).toBe(true);
    expect(writes[0]?.["produced_files"]).toEqual(["screenshots/ignored.png"]);
  });

  it("copies an owned raster linked from markdown exactly once", () => {
    const worktree = root("claudexor-linked-owned-tree-");
    const attemptDir = root("claudexor-linked-owned-attempt-");
    const relative = `${artifactRelativeDir}/browser/shot.png`;
    mkdirSync(join(worktree, artifactRelativeDir, "browser"), { recursive: true });
    writeFileSync(join(worktree, relative), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const { produced } = writeCandidateAttemptArtifacts({
      store: {
        writeText: () => undefined,
        writePatch: () => undefined,
        writeYaml: () => undefined,
      } as never,
      attemptDir,
      worktreePath: worktree,
      artifactRelativeDir,
      diff: "",
      answerText: `![shot](./${relative})`,
      record: { attempt_id: "a01" },
    });

    expect(produced).toEqual([relative]);
    expect(readFileSync(join(attemptDir, "produced", relative))).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it("deduplicates a markdown case alias before writing on case-insensitive filesystems", () => {
    const worktree = root("claudexor-case-alias-tree-");
    const attemptDir = root("claudexor-case-alias-attempt-");
    const relative = `${artifactRelativeDir}/browser/shot.png`;
    const alias = `${artifactRelativeDir}/browser/SHOT.png`;
    mkdirSync(join(worktree, artifactRelativeDir, "browser"), { recursive: true });
    writeFileSync(join(worktree, relative), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // Linux CI commonly uses a case-sensitive filesystem; the production
    // regression is macOS/APFS-specific and is exercised wherever the alias
    // resolves to the owned file.
    if (!existsSync(join(worktree, alias))) return;
    const { produced } = writeCandidateAttemptArtifacts({
      store: {
        writeText: () => undefined,
        writePatch: () => undefined,
        writeYaml: () => undefined,
      } as never,
      attemptDir,
      worktreePath: worktree,
      artifactRelativeDir,
      diff: "",
      answerText: `![shot](${alias})`,
      record: { attempt_id: "a01" },
    });

    expect(produced).toEqual([alias]);
    expect(readFileSync(join(attemptDir, "produced", alias))).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it("enforces one combined byte ceiling across linked and owned rasters", () => {
    const worktree = root("claudexor-combined-cap-tree-");
    const attemptDir = root("claudexor-combined-cap-attempt-");
    mkdirSync(join(worktree, "linked"), { recursive: true });
    mkdirSync(join(worktree, artifactRelativeDir), { recursive: true });
    const bytes = Buffer.alloc(12 * 1024 * 1024);
    writeFileSync(join(worktree, "linked", "first.png"), bytes);
    writeFileSync(join(worktree, artifactRelativeDir, "second.png"), bytes);
    writeFileSync(join(worktree, artifactRelativeDir, "third.png"), bytes);

    const { produced } = writeCandidateAttemptArtifacts({
      store: {
        writeText: () => undefined,
        writePatch: () => undefined,
        writeYaml: () => undefined,
      } as never,
      attemptDir,
      worktreePath: worktree,
      artifactRelativeDir,
      diff: "",
      answerText: "![first](linked/first.png)",
      record: { attempt_id: "a01" },
    });

    expect(produced).toEqual(["linked/first.png", `${artifactRelativeDir}/second.png`]);
    expect(existsSync(join(attemptDir, "produced", artifactRelativeDir, "third.png"))).toBe(false);
  });

  it("persists no produced media for an uncaptured candidate", () => {
    const worktree = root("claudexor-refused-output-tree-");
    const attemptDir = root("claudexor-refused-output-attempt-");
    mkdirSync(join(worktree, artifactRelativeDir), { recursive: true });
    writeFileSync(join(worktree, "clean.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(
      join(worktree, artifactRelativeDir, "clean.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const writes: Record<string, unknown>[] = [];
    const { produced } = writeCandidateAttemptArtifacts({
      store: {
        writeText: () => undefined,
        writePatch: () => undefined,
        writeYaml: (_path: string, value: unknown) => writes.push(value as Record<string, unknown>),
      } as never,
      attemptDir,
      worktreePath: worktree,
      artifactRelativeDir,
      diff: "diff --git a/clean.png b/clean.png\n",
      answerText: "![clean](clean.png)",
      persistPatch: false,
      persistProducedMedia: false,
      record: { attempt_id: "a01", capture_refusal: { disposition: "manual_cleanup" } },
    });
    expect(produced).toEqual([]);
    expect(existsSync(join(attemptDir, "produced"))).toBe(false);
    expect(writes[0]?.["produced_files"]).toEqual([]);
    expect(writes[0]).not.toHaveProperty("diffstat");
  });

  it("writes the exact diff to patch.diff, credential-shaped lines included (#555)", () => {
    const worktree = root("claudexor-copy-output-tree-");
    const attemptDir = root("claudexor-copy-output-attempt-");
    // Assembled at runtime so no secret-shaped literal lives in this file.
    const token = ["sk", "o".repeat(24)].join("-");
    const exact =
      "diff --git a/LEAK.txt b/LEAK.txt\nnew file mode 100644\n--- /dev/null\n+++ b/LEAK.txt\n" +
      `@@ -0,0 +1,2 @@\n+${token}\n+second line\n`;
    const texts: Record<string, string> = {};
    const yamls: Record<string, unknown>[] = [];
    const store = {
      writeText: (path: string, value: string) => void (texts[path] = value),
      writePatch: (path: string, value: string) => void (texts[path] = value),
      writeYaml: (_path: string, value: unknown) => yamls.push(value as Record<string, unknown>),
    } as never;
    writeCandidateAttemptArtifacts({
      store,
      attemptDir,
      worktreePath: worktree,
      artifactRelativeDir: null,
      diff: exact,
      answerText: `answer quoting ${token}`,
      record: { attempt_id: "a01" },
    });
    expect(texts[join(attemptDir, "patch.diff")]).toBe(exact);
    expect(texts[join(attemptDir, "answer.md")]).toBe(`answer quoting ${token}`);
    expect(yamls[0]?.["diffstat"]).toEqual({ files: 1, additions: 2, deletions: 0 });
  });

  it("saves a raster whose bytes look credential-shaped like any other image (#555)", () => {
    const worktree = root("claudexor-mixed-output-tree-");
    const attemptDir = root("claudexor-mixed-output-attempt-");
    const token = ["sk", "m".repeat(24)].join("-");
    writeFileSync(join(worktree, "clean.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const fixture = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from(token)]);
    writeFileSync(join(worktree, "leak.png"), fixture);
    const { produced } = writeCandidateAttemptArtifacts({
      store: {
        writeText: () => undefined,
        writePatch: () => undefined,
        writeYaml: () => undefined,
      } as never,
      attemptDir,
      worktreePath: worktree,
      artifactRelativeDir: null,
      diff: "",
      answerText: "![a](clean.png) ![b](leak.png)",
      record: { attempt_id: "a01" },
    });
    expect(produced.sort()).toEqual(["clean.png", "leak.png"]);
    expect(readFileSync(join(attemptDir, "produced", "leak.png")).equals(fixture)).toBe(true);
  });

  it("records an image it did not save with its size and reason, and names it in the summary line", () => {
    const worktree = root("claudexor-oversized-output-tree-");
    const attemptDir = root("claudexor-oversized-output-attempt-");
    writeFileSync(join(worktree, "big.png"), Buffer.alloc(16 * 1024 * 1024 + 1));
    writeFileSync(join(worktree, "small.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const writes: Record<string, unknown>[] = [];
    const result = writeCandidateAttemptArtifacts({
      store: {
        writeText: () => undefined,
        writePatch: () => undefined,
        writeYaml: (_path: string, value: unknown) => writes.push(value as Record<string, unknown>),
      } as never,
      attemptDir,
      worktreePath: worktree,
      artifactRelativeDir: null,
      diff: "",
      answerText: "![big](big.png) ![small](small.png) ![gone](missing.png)",
      record: { attempt_id: "a01" },
    });
    const omission = { path: "big.png", reason: "over_file_cap", bytes: 16 * 1024 * 1024 + 1 };
    expect(result).toEqual({ produced: ["small.png"], omitted: [omission] });
    expect(writes[0]?.["produced_files"]).toEqual(["small.png"]);
    // A link to a file that does not exist names nothing the run produced.
    expect(writes[0]?.["produced_omitted"]).toEqual([omission]);
    expect(producedOmissionSummaryLine(result.omitted)).toBe(
      "- Images not saved: 1 (big.png: over the 16 MiB per-image cap, 16777217 bytes)",
    );
    expect(producedOmissionSummaryLine([])).toBeNull();
  });
});
