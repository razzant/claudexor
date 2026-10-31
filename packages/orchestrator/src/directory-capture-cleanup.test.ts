import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { captureInspectionActions } from "./captureRefusal.js";
import { captureDirectoryCandidate } from "./directoryCandidate.js";
import { Orchestrator } from "./orchestrator.js";

// #535: a directory capture that fails removes its partial payload (final/files)
// before it answers. A removal that fails must not replace the capture's own cause:
// the refusal still names that cause, the leftover stays (no reader reads it) and is
// named beside the cause, and the live files are untouched. Real capture through the
// compiled workspace owner, a real unreadable output file, and a real POSIX denial: a
// directory inside the payload that refuses the unlink of its entry.
const dirs: string[] = [];
const locked: string[] = [];
afterEach(() => {
  for (const path of locked.splice(0)) if (existsSync(path)) chmodSync(path, 0o700);
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
/** A directory in the partial payload whose entry cannot be removed. */
const stuckIn = (artifactRoot: string) => {
  const stuck = join(artifactRoot, "final/files/leftover");
  mkdirSync(stuck, { recursive: true });
  writeFileSync(join(stuck, "stale"), "left by an earlier capture\n");
  chmodSync(stuck, 0o500);
  locked.push(stuck);
  return stuck;
};
const INSPECT_LEFTOVER = "Inspect Claudexor temporary state: private scratch cleanup failed";
const asRoot = process.getuid?.() === 0;

describe.skipIf(asRoot || process.platform === "win32")(
  "a directory capture whose partial payload cannot be removed",
  () => {
    /** A directory workspace over a selected source, with an unreadable output in it. */
    async function failingCapture(inPlace: boolean) {
      const source = temp("cx-dir-cleanup-src-");
      writeFileSync(join(source, "input.txt"), "selected source\n");
      const manager = new WorkspaceManager(source, { runtimeRoot: temp("cx-dir-cleanup-rt-") });
      const envelope = await manager.create({
        taskId: "t1",
        attemptId: "a01",
        workspaceKind: "directory",
        inPlace,
        scopePaths: ["."],
      });
      unreadable(join(envelope.worktree_path, "out.bin"));
      return { source, manager, envelope, artifactRoot: temp("cx-dir-cleanup-run-") };
    }

    it.each([true, false])(
      "control (in place: %s): the refusal names the unreadable output and the payload is gone",
      async (inPlace) => {
        const f = await failingCapture(inPlace);

        const { refusal, files } = await captureDirectoryCandidate({
          manager: f.manager,
          envelope: f.envelope,
          artifactRoot: f.artifactRoot,
          observedPaths: ["out.bin"],
        });

        expect(files).toBeUndefined();
        expect(refusal).toMatchObject({
          disposition: inPlace ? "manual_cleanup" : "discarded",
          phase: "artifact_security",
          failure: { code: "capture_failed", causeCode: "EACCES" },
        });
        expect(refusal!.failure!.message).toContain("out.bin");
        expect(refusal!.failure!.cleanup).toBeUndefined();
        expect(captureInspectionActions(refusal)).not.toContain(INSPECT_LEFTOVER);
        expect(existsSync(join(f.artifactRoot, "final/files"))).toBe(false);
      },
    );

    it.each([true, false])(
      "in place: %s: the capture's cause stays the answer, the leftover is named beside it",
      async (inPlace) => {
        const f = await failingCapture(inPlace);
        const stuck = stuckIn(f.artifactRoot);

        const { refusal, files } = await captureDirectoryCandidate({
          manager: f.manager,
          envelope: f.envelope,
          artifactRoot: f.artifactRoot,
          observedPaths: ["out.bin"],
        });

        expect(files).toBeUndefined();
        expect(refusal).toMatchObject({
          disposition: inPlace ? "manual_cleanup" : "discarded",
          phase: "artifact_security",
          failure: {
            code: "capture_failed",
            causeCode: "EACCES",
            cleanup: { code: "EACCES" },
          },
        });
        // The cause is the unreadable output, not the payload's removal.
        expect(refusal!.failure!.message).toContain("out.bin");
        expect(refusal!.failure!.message).not.toContain("leftover");
        expect(refusal!.failure!.cleanup!.message).toContain("leftover");
        expect(refusal!.detail).toContain("the capture failed (EACCES)");
        expect(refusal!.detail).toContain("No file payload was published");
        expect(captureInspectionActions(refusal)).toContain(INSPECT_LEFTOVER);
        // What could not be removed stays; the live files stay as the run left them.
        expect(readFileSync(join(stuck, "stale"), "utf8")).toBe("left by an earlier capture\n");
        expect(readFileSync(join(f.source, "input.txt"), "utf8")).toBe("selected source\n");
        expect(existsSync(join(f.envelope.worktree_path, "out.bin"))).toBe(true);
        expect(existsSync(join(f.source, "out.bin"))).toBe(inPlace);
      },
    );

    it("an error that cannot take the diagnostic still answers its own cause", async () => {
      const artifactRoot = temp("cx-dir-cleanup-run-");
      stuckIn(artifactRoot);
      const error = Object.freeze(
        Object.assign(new Error("EIO: i/o error, read '/work/out.bin'"), { code: "EIO" }),
      );
      const manager = {
        captureFiles: async (): Promise<CapturedWorkspaceFiles> => {
          throw error;
        },
      } as unknown as WorkspaceManager;

      const { refusal } = await captureDirectoryCandidate({
        manager,
        envelope: {
          policy_profile: "workspace_write",
          worktree_path: "/work",
          repo_root: "/work",
        } as never,
        artifactRoot,
        observedPaths: [],
      });

      expect(refusal).toMatchObject({
        disposition: "manual_cleanup",
        failure: { code: "capture_failed", causeCode: "EIO" },
      });
      expect(refusal!.failure!.message).toContain("out.bin");
    });
  },
);

/** One author that leaves an unreadable output and, in its own attempt's payload
 * directory, a directory that refuses removal (the run's single run directory). */
function author(runsDir: string) {
  const fake = createFakeHarness("fake-implement");
  const id = "refused-a";
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
      const runs = readdirSync(runsDir).map((name) => join(runsDir, name));
      expect(runs).toHaveLength(1);
      stuckIn(join(runs[0]!, "attempts", "a01"));
      unreadable(join(spec.cwd, "output.bin"));
      yield {
        type: "file_change",
        ts,
        session_id: spec.session_id,
        payload: { path: "output.bin" },
      };
      yield { type: "message", ts, session_id: spec.session_id, text: "Prepared.", final: true };
      yield { type: "completed", ts, session_id: spec.session_id };
    },
  };
  return adapter;
}

describe.skipIf(asRoot || process.platform === "win32")(
  "a directory run whose partial payload cannot be removed",
  () => {
    it.each([true, false])(
      "in place: %s: failed / capture_refused, naming the capture's cause and the leftover",
      async (inPlace) => {
        const root = temp("cx-dir-cleanup-project-");
        writeFileSync(join(root, "input.txt"), "selected source\n");
        const runsDir = new ArtifactStore(root).runsDir();
        const adapter = author(runsDir);

        const result = await new Orchestrator({
          registry: new Map([[adapter.id, adapter]]),
        }).run({
          repoRoot: root,
          prompt: "Create the output",
          harnesses: [adapter.id],
          workspaceKind: "directory",
          scopePaths: ["input.txt"],
          inPlace,
          review: false,
        });

        const store = new ArtifactStore(result.runDir);
        const facts = RunFacts.parse(store.readYaml(join(result.runDir, "final/run_facts.yaml")));
        const failure = RunFailure.parse(store.readYaml(join(result.runDir, "final/failure.yaml")));
        const summary = readFileSync(join(result.runDir, "final/summary.md"), "utf8");
        expect(facts.outcome).toMatchObject({ lifecycle: "failed", reason: "capture_refused" });
        expect(failure.phase).toBe("artifact_security");
        expect(failure.captureFailure).toMatchObject({
          code: "capture_failed",
          causeCode: "EACCES",
          cleanup: { code: "EACCES" },
        });
        expect(failure.captureFailure!.message).toContain("output.bin");
        expect(failure.captureFailure!.cleanup!.message).toContain("leftover");
        expect(summary).toContain("the capture failed (EACCES)");
        expect(failure.nextActions).toContain(INSPECT_LEFTOVER);
        expect(failure.nextActions.join("\n")).not.toMatch(/retry|re-run/i);
        expect(readFileSync(join(root, "input.txt"), "utf8")).toBe("selected source\n");
        expect(existsSync(join(result.runDir, "attempts/a01/final/files/leftover/stale"))).toBe(
          true,
        );
      },
    );
  },
);
