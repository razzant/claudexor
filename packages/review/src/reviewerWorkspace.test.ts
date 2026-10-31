import { execFileSync } from "node:child_process";
import {
  chmodSync,
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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { ConformanceReport, HarnessManifest, type HarnessRunSpec } from "@claudexor/schema";
import { type ReviewerSpec, reviewCandidate } from "./reviewEngine.js";

// A file past the runtime's string limit (~512 MiB) cannot be read as one
// string: `readTextSafe` returns null for it. Model exactly that failure for
// `huge.bin` without allocating it (#535 F10, the reviewer's own injection).
vi.mock("@claudexor/util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@claudexor/util")>();
  return {
    ...actual,
    readTextSafe: (path: string) => (path.endsWith("huge.bin") ? null : actual.readTextSafe(path)),
  };
});

const dirs: string[] = [];
const locked: string[] = [];
afterEach(() => {
  for (const path of locked.splice(0)) if (existsSync(path)) chmodSync(path, 0o600);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { cwd: string; evidenceDir: string; artifactsDir: string } {
  const base = mkdtempSync(join(tmpdir(), "claudexor-reviewer-workspace-"));
  dirs.push(base);
  const cwd = join(base, "candidate");
  const evidenceDir = join(base, "evidence");
  mkdirSync(cwd);
  mkdirSync(evidenceDir);
  for (const [name, text] of [
    ["USER_INTENT.md", "review candidate\n"],
    ["FORBIDDEN_FINDINGS.md", "(none)\n"],
    ["PLAN_ACCEPTED.md", "(none)\n"],
    ["TESTS.txt", "(tests not run)\n"],
    ["DECIDED_TRADEOFFS.md", "(none)\n"],
  ])
    writeFileSync(join(evidenceDir, name!), text!);
  return { cwd, evidenceDir, artifactsDir: join(base, "artifacts") };
}

/** A clean reviewer that records what its workspace and prompt hold. */
function probe(id: string, onRun: (spec: HarnessRunSpec) => void): ReviewerSpec {
  const adapter: HarnessAdapter = {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "openai",
        capabilities: { review: true, structured_output: true },
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["review"] });
    },
    async *run(spec) {
      onRun(spec);
      yield {
        type: "message",
        session_id: spec.session_id,
        ts: new Date().toISOString(),
        text: "[]\n",
      };
    },
  };
  return { adapter, providerFamily: "openai" };
}

/** What review reads for an object result without a patch view (#535). */
const UNRENDERED_NOTICE =
  "# Claudexor: this result is too large to render as one patch.\n# Changed paths: 2.\n";

const canLock = process.getuid?.() !== 0;

describe("reviewer workspace copies exactly and names what it cannot read (#535 F10)", () => {
  it("names every changed path its copy excludes by rule, and never a deleted one", async () => {
    const f = fixture();
    mkdirSync(join(f.cwd, ".turbo"), { recursive: true });
    mkdirSync(join(f.cwd, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(f.cwd, ".turbo", "config.json"), "{}\n");
    writeFileSync(join(f.cwd, "node_modules", "dep", "index.js"), "changed\n");
    writeFileSync(join(f.cwd, "app.tsbuildinfo"), "{}\n");
    writeFileSync(join(f.cwd, "small.txt"), "small\n");
    symlinkSync(join(tmpdir(), "outside-the-candidate"), join(f.cwd, "dangling"));
    const excluded = [
      ".turbo/config.json",
      "app.tsbuildinfo",
      "dangling",
      "node_modules/dep/index.js",
    ];
    let prompt = "";
    const res = await reviewCandidate({
      candidateLabel: "Unrendered result",
      diff: UNRENDERED_NOTICE,
      candidatePaths: [...excluded, "small.txt", "deleted-by-the-result.txt"],
      ...f,
      reviewers: [probe("rule-reviewer", (spec) => (prompt = spec.prompt))],
    });
    expect(res.uninspectableFiles).toEqual(
      excluded.map((path) => ({ path, reason: "excluded_from_review_copy" })),
    );
    for (const path of excluded) expect(prompt).toContain(JSON.stringify(path));
    expect(prompt).not.toContain("deleted-by-the-result.txt");
    expect(res.findings.map((finding) => finding.severity)).toEqual(["INSUFFICIENT_EVIDENCE"]);
  });

  it("a directory result keeps FILES.json; only a result with no manifest gets the changed-paths file", async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, "small.txt"), "small\n");
    writeFileSync(join(f.evidenceDir, "FILES.json"), "{}\n");
    const prompts: string[] = [];
    const lists: boolean[] = [];
    const probeIt = probe("manifest-reviewer", (spec) => {
      prompts.push(spec.prompt);
      lists.push(existsSync(join(spec.cwd, ".claudexor-review-evidence", "CHANGED_PATHS.json")));
    });
    await reviewCandidate({
      candidateLabel: "Directory result",
      diff: "",
      candidatePaths: ["small.txt"],
      candidatePathsHaveManifest: true,
      ...f,
      reviewers: [probeIt],
    });
    expect(prompts[0]).toContain("Read FILES.json");
    expect(prompts[0]).not.toContain("CHANGED_PATHS.json");
    expect(lists).toEqual([false]);
  });

  it("copies exactly a candidate file too large to read as one string", async () => {
    const f = fixture();
    // Several stream chunks of binary bytes: inspected with bounded memory.
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 7);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + 7) % 256;
    writeFileSync(join(f.cwd, "huge.bin"), bytes);
    writeFileSync(join(f.cwd, "small.txt"), "small\n");
    let copied = null as Buffer | null;
    let prompt = "";
    const res = await reviewCandidate({
      candidateLabel: "Unrendered result",
      diff: UNRENDERED_NOTICE,
      candidatePaths: ["huge.bin", "small.txt"],
      ...f,
      reviewers: [
        probe("huge-reviewer", (spec) => {
          prompt = spec.prompt;
          const path = join(spec.cwd, "huge.bin");
          copied = existsSync(path) ? readFileSync(path) : null;
        }),
      ],
    });
    expect(copied).not.toBeNull();
    expect(copied!.equals(bytes)).toBe(true);
    expect(prompt).not.toContain("could not be inspected");
    expect(res.uninspectableFiles).toBeUndefined();
    expect(res.findings).toEqual([]);
  });

  it.skipIf(!canLock)(
    "names an unreadable candidate file to the reviewer and in the review facts; an unrendered review is then inconclusive",
    async () => {
      const f = fixture();
      writeFileSync(join(f.cwd, "locked.txt"), "changed but unreadable\n");
      writeFileSync(join(f.cwd, "small.txt"), "small\n");
      chmodSync(join(f.cwd, "locked.txt"), 0o000);
      locked.push(join(f.cwd, "locked.txt"));
      let prompt = "";
      let present = true;
      const res = await reviewCandidate({
        candidateLabel: "Unrendered result",
        diff: UNRENDERED_NOTICE,
        candidatePaths: ["locked.txt", "small.txt"],
        ...f,
        reviewers: [
          probe("locked-reviewer", (spec) => {
            prompt = spec.prompt;
            present = existsSync(join(spec.cwd, "locked.txt"));
          }),
        ],
      });
      // Never copied (its content could not be checked), never silently gone.
      expect(present).toBe(false);
      expect(prompt).toContain("could not be inspected");
      expect(prompt).toContain('"locked.txt" (EACCES)');
      expect(res.uninspectableFiles).toEqual([{ path: "locked.txt", reason: "EACCES" }]);
      // The manifest is this review's whole content: it cannot come back clean.
      const blocking = res.findings.filter((f) => f.severity === "INSUFFICIENT_EVIDENCE");
      expect(blocking).toHaveLength(1);
      expect(blocking[0]!.claim).toContain('"locked.txt"');
    },
  );

  it.skipIf(!canLock)(
    "names an unreadable file of a rendered candidate without blocking: its patch still shows the change",
    async () => {
      const f = fixture();
      // A rendered review copies the candidate's Git-visible files.
      execFileSync("git", ["-c", "init.templateDir=", "init", "--quiet"], { cwd: f.cwd });
      writeFileSync(join(f.cwd, "locked.txt"), "context the reviewer cannot read\n");
      writeFileSync(join(f.cwd, "README.md"), "new\n");
      chmodSync(join(f.cwd, "locked.txt"), 0o000);
      locked.push(join(f.cwd, "locked.txt"));
      let prompt = "";
      const res = await reviewCandidate({
        candidateLabel: "Rendered result",
        diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
        ...f,
        reviewers: [probe("rendered-reviewer", (spec) => (prompt = spec.prompt))],
      });
      expect(prompt).toContain('"locked.txt" (EACCES)');
      expect(res.uninspectableFiles).toEqual([{ path: "locked.txt", reason: "EACCES" }]);
      expect(res.findings).toEqual([]);
    },
  );

  it("copies a credential-shaped candidate file exactly, never withheld (INV-146)", async () => {
    const f = fixture();
    // A credential straddling the first 64 KiB read boundary of a larger file.
    const token = "ghp_" + "a".repeat(36);
    const split = Buffer.concat([
      Buffer.alloc(64 * 1024 - 10, 0x2e),
      Buffer.from(token),
      Buffer.alloc(2 * 1024 * 1024, 0x2e),
    ]);
    writeFileSync(join(f.cwd, "split.txt"), split);
    writeFileSync(join(f.cwd, "clean.txt"), "clean\n");
    let copied: Buffer | null = null;
    let sawClean = false;
    const res = await reviewCandidate({
      candidateLabel: "Unrendered result",
      diff: UNRENDERED_NOTICE,
      candidatePaths: ["split.txt", "clean.txt"],
      ...f,
      reviewers: [
        probe("exact-reviewer", (spec) => {
          copied = readFileSync(join(spec.cwd, "split.txt"));
          sawClean = existsSync(join(spec.cwd, "clean.txt"));
        }),
      ],
    });
    // Working content is kept exact (INV-146): the reviewer reads the same bytes.
    expect(copied !== null && Buffer.compare(copied, split) === 0).toBe(true);
    expect(sawClean).toBe(true);
    expect(res.uninspectableFiles).toBeUndefined();
  });
});
