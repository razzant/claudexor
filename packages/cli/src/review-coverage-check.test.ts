import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTouchedFilePack,
  touchedFileSection,
} from "../../../scripts/lib/release-review-contract.mjs";
import {
  GENERATED_ARTIFACT_ALLOWLIST,
  bindCoverageReceipt,
  checkCoverage,
  coverageReceiptBody,
  diffAuthoritativeRule,
  fileCoverage,
  unionWithWholeFileList,
} from "../../../scripts/review-coverage-check.mjs";

/** Build a realistic touched-file pack from a {path: currentText} map. */
function packOf(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([path, text]) => touchedFileSection(path, text))
    .join("\n\n");
}

describe("review-coverage-check", () => {
  const sources = {
    "packages/cli/src/a.ts": "export const a = 1;\n",
    "docs/GUIDE.md": "# Guide\n\nsome text\n",
  };
  const readCurrentText = (path: string): string => {
    const map: Record<string, string> = { ...sources };
    if (!(path in map)) throw new Error(`no fixture for ${path}`);
    return map[path];
  };

  it("passes when every hand-written file's full text is present", () => {
    const pack = packOf(sources);
    const report = checkCoverage({
      files: [{ path: "packages/cli/src/a.ts" }, { path: "docs/GUIDE.md" }],
      readCurrentText,
      packContents: [pack],
    });
    expect(report.ok).toBe(true);
    expect(report.covered.sort()).toEqual(["docs/GUIDE.md", "packages/cli/src/a.ts"]);
    expect(report.uncovered).toEqual([]);
  });

  it("fails when a source file is missing from every pack", () => {
    // Pack omits docs/GUIDE.md entirely.
    const pack = packOf({ "packages/cli/src/a.ts": sources["packages/cli/src/a.ts"] });
    const report = checkCoverage({
      files: [{ path: "packages/cli/src/a.ts" }, { path: "docs/GUIDE.md" }],
      readCurrentText,
      packContents: [pack],
    });
    expect(report.ok).toBe(false);
    expect(report.uncovered.map((u) => u.path)).toEqual(["docs/GUIDE.md"]);
  });

  it("fails a truncated file even when its header is present (omission note)", () => {
    // buildTouchedFilePack drops the big file past the pack budget -> omission note.
    const big = "x".repeat(400);
    const git = (args: string[]): string => {
      const path = args[1].replace(/^HEAD:/, "");
      if (path === "packages/cli/src/a.ts") return sources["packages/cli/src/a.ts"];
      if (path === "docs/GUIDE.md") return big;
      throw new Error("missing");
    };
    const pack = buildTouchedFilePack(
      ["packages/cli/src/a.ts", "docs/GUIDE.md"],
      git,
      1_000_000,
      100, // pack budget forces docs/GUIDE.md into the omission note
    );
    expect(pack).toContain("OMISSION NOTE");
    const report = checkCoverage({
      files: [{ path: "packages/cli/src/a.ts" }, { path: "docs/GUIDE.md" }],
      readCurrentText: (p) => (p === "docs/GUIDE.md" ? big : readCurrentText(p)),
      packContents: [pack],
    });
    expect(report.ok).toBe(false);
    const g = report.uncovered.find((u) => u.path === "docs/GUIDE.md");
    expect(g?.reason).toMatch(/OMISSION NOTE/);
  });

  it("fails a file whose section is present but bytes are altered/truncated", () => {
    // Header present, but the fenced body is not the complete current text.
    const truncated = `### docs/GUIDE.md\n\n\`\`\`\n# Guide\n\`\`\``;
    const report = checkCoverage({
      files: [{ path: "docs/GUIDE.md" }],
      readCurrentText,
      packContents: [truncated],
    });
    expect(report.ok).toBe(false);
    expect(report.uncovered[0].reason).toMatch(/truncated\/altered/);
  });

  it("treats generated/fixture files as diff-authoritative and never requires their full text", () => {
    const report = checkCoverage({
      files: [
        { path: "packages/schema/generated/BudgetLease.schema.json" },
        { path: "docs/reference/endpoints.json" },
        {
          path: "apps/macos/ClaudexorKit/Tests/ClaudexorKitTests/Fixtures/wire/manifest.json",
        },
        { path: "packages/harness-codex/fixtures/transcript.jsonl" },
        { path: "pnpm-lock.yaml" },
        { path: "packages/util/src/version.ts" },
      ],
      readCurrentText: () => {
        throw new Error("diff-authoritative files must not be read for coverage");
      },
      packContents: [""], // empty pack: their absence must still pass
    });
    expect(report.ok).toBe(true);
    expect(report.skipped.map((s) => s.path).sort()).toEqual([
      "apps/macos/ClaudexorKit/Tests/ClaudexorKitTests/Fixtures/wire/manifest.json",
      "docs/reference/endpoints.json",
      "packages/harness-codex/fixtures/transcript.jsonl",
      "packages/schema/generated/BudgetLease.schema.json",
      "packages/util/src/version.ts",
      "pnpm-lock.yaml",
    ]);
  });

  it("never requires coverage for deleted files", () => {
    const report = checkCoverage({
      files: [{ path: "packages/cli/src/gone.ts", deleted: true }],
      readCurrentText: () => {
        throw new Error("deleted files have no current text");
      },
      packContents: [""],
    });
    expect(report.ok).toBe(true);
    expect(report.deleted).toEqual(["packages/cli/src/gone.ts"]);
  });

  it("classifies hand-written source as requiring coverage (null rule)", () => {
    expect(diffAuthoritativeRule("packages/cli/src/index.ts")).toBeNull();
    expect(diffAuthoritativeRule("apps/macos/ClaudexorApp/Sources/App.swift")).toBeNull();
    expect(diffAuthoritativeRule("packages/schema/src/index.ts")).toBeNull();
    expect(diffAuthoritativeRule("packages/schema/generated/X.schema.json")).toBe(
      "generated-schema",
    );
    expect(diffAuthoritativeRule("packages/harness-claude/fixtures/x.json")).toBe(
      "harness-fixture",
    );
    for (const p of GENERATED_ARTIFACT_ALLOWLIST) {
      expect(diffAuthoritativeRule(p)).toBe("generated-artifact-allowlist");
    }
  });

  it("unions FILES_TO_READ_WHOLE entries into the required set (listed-but-unchanged context files)", () => {
    const files = unionWithWholeFileList(
      [{ path: "packages/cli/src/a.ts", deleted: false }],
      "# context demanded in full\npackages/cli/src/a.ts\ndocs/GUIDE.md\n\n",
    );
    expect(files).toEqual([
      { path: "packages/cli/src/a.ts", deleted: false },
      { path: "docs/GUIDE.md", deleted: false },
    ]);
    // A pack that misses the listed-but-unchanged file must now FAIL coverage.
    const report = checkCoverage({
      files,
      readCurrentText,
      packContents: [packOf({ "packages/cli/src/a.ts": sources["packages/cli/src/a.ts"] })],
    });
    expect(report.ok).toBe(false);
    expect(report.uncovered.map((entry: { path: string }) => entry.path)).toEqual([
      "docs/GUIDE.md",
    ]);
    // No list → the changed set passes through untouched.
    expect(unionWithWholeFileList(files, null)).toBe(files);
  });

  it("emits a candidate-bound receipt whose pack digests are the exact reviewed bytes (A-8 seal input)", () => {
    const pack = packOf(sources);
    const report = checkCoverage({
      files: [{ path: "packages/cli/src/a.ts" }, { path: "docs/GUIDE.md" }],
      readCurrentText,
      packContents: [pack],
    });
    const body = coverageReceiptBody(report, {
      base: "9".repeat(40),
      candidate: "a".repeat(40),
      packs: [{ subWave: "engine", path: "/tmp/wave/triad-prompt.md" }],
      packContents: [pack],
      wholeFileList: null,
    });
    expect(body.ok).toBe(true);
    expect(body.candidate).toBe("a".repeat(40));
    expect(body.packs).toEqual([
      {
        subWave: "engine",
        path: "/tmp/wave/triad-prompt.md",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(body.covered).toBe(2);
    expect(body.uncovered).toEqual([]);
  });

  it("bindCoverageReceipt recomputes from disk and refuses a forged receipt (E-C3)", () => {
    // Real git fixture: one repo, one changed file, one honest pack.
    const dir = mkdtempSync(join(tmpdir(), "coverage-bind-"));
    try {
      const g = (...args: string[]) =>
        execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
      g("init", "-q");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
      g("add", "a.ts");
      g("commit", "-qm", "base");
      const base = g("rev-parse", "HEAD");
      writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
      g("add", "a.ts");
      g("commit", "-qm", "change");
      const candidate = g("rev-parse", "HEAD");
      const packPath = join(dir, "triad-prompt.md");
      writeFileSync(packPath, packOf({ "a.ts": "export const a = 2;\n" }));
      const packSha = createHash("sha256")
        .update(packOf({ "a.ts": "export const a = 2;\n" }))
        .digest("hex");
      const honest = {
        schemaVersion: 1,
        ok: true,
        base,
        candidate,
        packs: [{ subWave: "engine", path: packPath, sha256: packSha }],
        wholeFileList: null,
      };
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        // Honest receipt binds; the result carries only recomputed values.
        const bound = bindCoverageReceipt(honest, candidate);
        expect(bound.ok).toBe(true);
        expect(bound.packs).toEqual([{ subWave: "engine", sha256: packSha }]);
        // Forged pack digest → refused (disk bytes win).
        expect(() =>
          bindCoverageReceipt(
            { ...honest, packs: [{ ...honest.packs[0], sha256: "0".repeat(64) }] },
            candidate,
          ),
        ).toThrow(/digest mismatch/);
        // Wrong candidate → refused.
        expect(() => bindCoverageReceipt(honest, base)).toThrow(/not the sealed candidate/);
        // A receipt claiming ok:true over a pack that does NOT cover the
        // change → refused by RECOMPUTATION, not trusted.
        const stalePack = join(dir, "stale-prompt.md");
        writeFileSync(stalePack, packOf({ "a.ts": "export const a = 1;\n" }));
        const staleSha = createHash("sha256")
          .update(packOf({ "a.ts": "export const a = 1;\n" }))
          .digest("hex");
        expect(() =>
          bindCoverageReceipt(
            {
              ...honest,
              packs: [{ subWave: "engine", path: stalePack, sha256: staleSha }],
            },
            candidate,
          ),
        ).toThrow(/coverage recomputation FAILED/);
      } finally {
        process.chdir(cwd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("covers a file when any one of several packs contains it (union of sub-waves)", () => {
    const packA = packOf({ "packages/cli/src/a.ts": sources["packages/cli/src/a.ts"] });
    const packB = packOf({ "docs/GUIDE.md": sources["docs/GUIDE.md"] });
    const report = checkCoverage({
      files: [{ path: "packages/cli/src/a.ts" }, { path: "docs/GUIDE.md" }],
      readCurrentText,
      packContents: [packA, packB],
    });
    expect(report.ok).toBe(true);
  });

  it("fileCoverage reports the covered path directly", () => {
    const pack = touchedFileSection("x/y.ts", "body\n");
    expect(fileCoverage("x/y.ts", "body\n", [pack]).covered).toBe(true);
    expect(fileCoverage("x/y.ts", "different\n", [pack]).covered).toBe(false);
  });
});

describe("buildTouchedFilePack strict omission", () => {
  const git = (args: string[]): string => {
    const path = args[1].replace(/^HEAD:/, "");
    if (path === "small.ts") return "ok\n";
    if (path === "big.ts") return "x".repeat(500);
    throw new Error("missing");
  };

  it("throws instead of silently emitting an omission note under { onOmission: 'throw' }", () => {
    expect(() =>
      buildTouchedFilePack(["small.ts", "big.ts"], git, 1_000_000, 100, {
        onOmission: "throw",
      }),
    ).toThrow(/would drop 1 hand-written file/);
  });

  it("still emits a disclosed note by default (backward compatible)", () => {
    const pack = buildTouchedFilePack(["small.ts", "big.ts"], git, 1_000_000, 100);
    expect(pack).toContain("OMISSION NOTE");
    expect(pack).toContain("ok\n");
  });
});
