import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import { ConformanceReport, HarnessManifest, RunFacts, RunFailure } from "@claudexor/schema";
import { WorkspaceManager, type CapturedWorkspaceFiles } from "@claudexor/workspace";
import { redactSecrets } from "@claudexor/util";
import { captureDirectoryCandidate } from "./directoryCandidate.js";
import { Orchestrator } from "./orchestrator.js";

// #535 round 9 (R9-8): a directory capture that fails keeps its cause. The
// refusal carries the typed, bounded, redacted `WorkspaceCaptureFailure` the
// Git lane builds, and a terminal whose candidates were all refused this way is
// `failed` / `capture_refused`, naming that cause and advising no retry.
const dirs: string[] = [];
const locked: string[] = [];
afterEach(() => {
  for (const path of locked.splice(0)) if (existsSync(path)) chmodSync(path, 0o644);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
/** An output file the capture cannot read, as a permission error leaves it. */
const unreadable = (path: string) => {
  writeFileSync(path, "authored output\n");
  chmodSync(path, 0o000);
  locked.push(path);
};
const asRoot = process.getuid?.() === 0;

describe("captureDirectoryCandidate", () => {
  it("keeps a bounded, redacted cause when the capture throws, and its disposition and phase", async () => {
    const artifactRoot = temp("cx-dir-refusal-run-");
    mkdirSync(join(artifactRoot, "final/files/content"), { recursive: true });
    const secret = `${"ghp_"}${"a1".repeat(18)}`;
    expect(redactSecrets(secret)).not.toBe(secret);
    const error = Object.assign(
      new Error(`EACCES: permission denied, open '/work/${secret}/out.bin' ${"x".repeat(9000)}`),
      { code: "EACCES", path: `/work/${secret}/out.bin` },
    );
    const manager = {
      captureFiles: async (): Promise<CapturedWorkspaceFiles> => {
        throw error;
      },
    } as unknown as WorkspaceManager;
    for (const inPlace of [true, false]) {
      const envelope = {
        policy_profile: "workspace_write",
        worktree_path: "/work",
        repo_root: inPlace ? "/work" : "/project",
      } as never;

      const { refusal, files } = await captureDirectoryCandidate({
        manager,
        envelope,
        artifactRoot,
        observedPaths: [],
      });

      expect(files).toBeUndefined();
      expect(refusal).toMatchObject({
        disposition: inPlace ? "manual_cleanup" : "discarded",
        phase: "artifact_security",
        failure: { code: "capture_failed", causeCode: "EACCES" },
      });
      expect(refusal!.failure!.message).toContain("EACCES: permission denied");
      expect(refusal!.failure!.message).not.toContain(secret);
      expect(refusal!.failure!.message.length).toBeLessThanOrEqual(4000);
      expect(refusal!.detail).toContain("the capture failed (EACCES)");
      expect(refusal!.detail).not.toContain(secret);
      expect(existsSync(join(artifactRoot, "final/files"))).toBe(false);
    }
  });

  it.skipIf(asRoot || process.platform === "win32")(
    "a real unreadable output file is the cause",
    async () => {
      const source = temp("cx-dir-refusal-src-");
      writeFileSync(join(source, "input.txt"), "selected source\n");
      const manager = new WorkspaceManager(source, { runtimeRoot: temp("cx-dir-refusal-rt-") });
      const envelope = await manager.create({
        taskId: "t1",
        attemptId: "a01",
        workspaceKind: "directory",
        inPlace: true,
        scopePaths: ["."],
      });
      unreadable(join(source, "out.bin"));
      const artifactRoot = temp("cx-dir-refusal-run-");

      const { refusal } = await captureDirectoryCandidate({
        manager,
        envelope,
        artifactRoot,
        observedPaths: ["out.bin"],
      });

      expect(refusal).toMatchObject({
        disposition: "manual_cleanup",
        phase: "artifact_security",
        failure: { code: "capture_failed", causeCode: "EACCES" },
      });
      expect(refusal!.failure!.message).toContain("out.bin");
      expect(existsSync(join(artifactRoot, "final/files"))).toBe(false);
    },
  );
});

function author(id: string, outcome: "unreadable" | "error-no-output") {
  const fake = createFakeHarness("fake-implement");
  const adapter: HarnessAdapter = {
    ...fake,
    id,
    async discover() {
      return HarnessManifest.parse({
        ...(await fake.discover()),
        id,
        kind: "local_cli",
        capabilities: { ...(await fake.discover()).capabilities, review: false, synthesize: false },
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["implement", "repair"],
      });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", ts, session_id: spec.session_id };
      if (outcome === "unreadable") {
        unreadable(join(spec.cwd, "output.bin"));
        yield {
          type: "file_change",
          ts,
          session_id: spec.session_id,
          payload: { path: "output.bin" },
        };
        yield {
          type: "message",
          ts,
          session_id: spec.session_id,
          text: "Prepared the output.",
          final: true,
        };
      } else yield { type: "error", ts, session_id: spec.session_id, error: "fixture failure" };
      yield { type: "completed", ts, session_id: spec.session_id };
    },
  };
  return adapter;
}

function terminal(runDir: string) {
  const store = new ArtifactStore(runDir);
  return {
    facts: RunFacts.parse(store.readYaml(join(runDir, "final/run_facts.yaml"))),
    failure: RunFailure.parse(store.readYaml(join(runDir, "final/failure.yaml"))),
    summary: readFileSync(join(runDir, "final/summary.md"), "utf8"),
  };
}

describe.skipIf(asRoot || process.platform === "win32")(
  "a directory run whose capture fails",
  () => {
    it.each([
      { shape: "isolated", inPlace: false, attempts: undefined, authors: ["refused-a"] },
      { shape: "in-place", inPlace: true, attempts: undefined, authors: ["refused-a"] },
      { shape: "attempts", inPlace: false, attempts: 2, authors: ["refused-a"] },
      {
        shape: "best-of, all refused",
        inPlace: false,
        attempts: undefined,
        authors: ["refused-a", "refused-b"],
      },
    ])(
      "$shape: failed / capture_refused, naming the cause, with no retry advice",
      async ({ inPlace, attempts, authors }) => {
        const root = temp("cx-dir-refusal-project-");
        writeFileSync(join(root, "input.txt"), "selected source\n");
        const adapters = authors.map((id) => author(id, "unreadable"));
        const result = await new Orchestrator({
          registry: new Map(adapters.map((adapter) => [adapter.id, adapter])),
        }).run({
          repoRoot: root,
          prompt: "Create the output",
          harnesses: authors,
          ...(authors.length > 1 ? { n: authors.length } : {}),
          workspaceKind: "directory",
          scopePaths: ["input.txt"],
          inPlace,
          attempts,
          // Best-of admits no review=false: its default review intent stays.
          ...(authors.length > 1 ? {} : { review: false }),
        });

        const { facts, failure, summary } = terminal(result.runDir);
        expect(facts.outcome).toMatchObject({ lifecycle: "failed", reason: "capture_refused" });
        expect(failure.phase).toBe("artifact_security");
        expect(failure.captureFailure).toMatchObject({
          code: "capture_failed",
          causeCode: "EACCES",
        });
        expect(failure.captureFailure!.message).toContain("output.bin");
        expect(summary).toContain("the capture failed (EACCES)");
        expect(summary).toContain("output.bin");
        expect(failure.nextActions.join("\n")).not.toMatch(/retry|re-run/i);
      },
    );

    it("one candidate refused and one errored stays harness_failed, the Git lane's rule, and still names the refusal's cause", async () => {
      const root = temp("cx-dir-refusal-project-");
      writeFileSync(join(root, "input.txt"), "selected source\n");
      const adapters = [author("refused-a", "unreadable"), author("errored-b", "error-no-output")];
      const result = await new Orchestrator({
        registry: new Map(adapters.map((adapter) => [adapter.id, adapter])),
      }).run({
        repoRoot: root,
        prompt: "Create the output",
        harnesses: ["refused-a", "errored-b"],
        n: 2,
        workspaceKind: "directory",
        scopePaths: ["input.txt"],
      });

      const { facts, failure } = terminal(result.runDir);
      expect(facts.outcome).toMatchObject({ lifecycle: "failed", reason: "harness_failed" });
      expect(failure.captureFailure).toMatchObject({ code: "capture_failed", causeCode: "EACCES" });
    });
  },
);
