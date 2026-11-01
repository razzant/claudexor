import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import {
  ConformanceReport,
  HarnessManifest,
  RunFacts,
  RunFailure,
  type HarnessRunSpec,
} from "@claudexor/schema";
import {
  WorkspaceManager,
  holdsRetainedSources,
  readEnvelopeCustody,
  recoverOrphanCustody,
  releaseRetainedEnvelope,
  retainedEnvelopeOfRun,
  retainedSourcesOfRun,
} from "@claudexor/workspace";
import { Orchestrator, type OrchestratorResult } from "./orchestrator.js";

// #563: when the FINAL capture of an isolated directory copy refuses, the copy
// with the authored files is kept for inspection under the existing per-attempt
// custody (not the continuation singleton). No exact result, apply or revert is
// claimed. A superseded per-try capture holds nothing; in place is unchanged.
const dirs: string[] = [];
const locked: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of locked.splice(0)) if (existsSync(path)) chmodSync(path, 0o755);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const asRoot = process.getuid?.() === 0;
const posix = process.platform !== "win32";
const BINARY = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const KEPT_NO_EXACT =
  "Decide on those changes yourself: Claudexor kept no exact result to apply or revert";

function author(id: string, act: (spec: HarnessRunSpec) => void): HarnessAdapter {
  const fake = createFakeHarness("fake-implement");
  return {
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
      act(spec);
      for (const path of ["authored.txt", "nested/deep/report.bin"])
        yield { type: "file_change", ts, session_id: spec.session_id, payload: { path } };
      yield { type: "message", ts, session_id: spec.session_id, text: "Prepared.", final: true };
      yield { type: "completed", ts, session_id: spec.session_id };
    },
  };
}

/** Good text and binary output, plus whatever the case adds. */
function writeGood(cwd: string): void {
  writeFileSync(join(cwd, "authored.txt"), "authored by the executor\n");
  mkdirSync(join(cwd, "nested/deep"), { recursive: true });
  writeFileSync(join(cwd, "nested/deep/report.bin"), BINARY);
}

function project() {
  const root = temp("cx-dir-keep-project-");
  writeFileSync(join(root, "input.txt"), "selected source\n");
  writeFileSync(join(root, "unselected.txt"), "unselected sibling\n");
  return root;
}

async function run(
  root: string,
  adapter: HarnessAdapter,
  extra: { inPlace?: boolean; attempts?: number } = {},
): Promise<OrchestratorResult> {
  return new Orchestrator({ registry: new Map([[adapter.id, adapter]]) }).run({
    repoRoot: root,
    prompt: "Create the output",
    harnesses: [adapter.id],
    workspaceKind: "directory",
    scopePaths: ["input.txt"],
    review: false,
    ...extra,
  });
}

function terminal(result: OrchestratorResult) {
  const store = new ArtifactStore(result.runDir);
  return {
    facts: RunFacts.parse(store.readYaml(join(result.runDir, "final/run_facts.yaml"))),
    failure: RunFailure.parse(store.readYaml(join(result.runDir, "final/failure.yaml"))),
    summary: readFileSync(join(result.runDir, "final/summary.md"), "utf8"),
  };
}

/** The kept copy holds the authored bytes exactly; the original folder does not. */
function expectKeptCopy(result: OrchestratorResult, root: string) {
  const sources = retainedSourcesOfRun(result.runDir, result.runId);
  expect(sources).toHaveLength(1);
  const [source] = sources;
  expect(source!.continuation_eligible).toBe(false);
  expect(source!.envelope.workspace_kind).toBe("directory");
  // Never the singular continuation pointer.
  expect(retainedEnvelopeOfRun(result.runDir, result.runId)).toBeNull();
  const tree = source!.envelope.worktree_path;
  expect(readFileSync(join(tree, "authored.txt"), "utf8")).toBe("authored by the executor\n");
  expect(readFileSync(join(tree, "nested/deep/report.bin")).equals(BINARY)).toBe(true);
  expect(readFileSync(join(tree, "input.txt"), "utf8")).toBe("selected source\n");
  // The original selected and unselected inputs are unchanged, nothing was applied.
  expect(readFileSync(join(root, "input.txt"), "utf8")).toBe("selected source\n");
  expect(readFileSync(join(root, "unselected.txt"), "utf8")).toBe("unselected sibling\n");
  expect(existsSync(join(root, "authored.txt"))).toBe(false);
  expect(existsSync(join(result.runDir, "final/files/manifest.json"))).toBe(false);
  return source!;
}

async function expectRecoveryHoldsThenDiscardReleases(
  result: OrchestratorResult,
  root: string,
  source: ReturnType<typeof expectKeptCopy>,
) {
  const tree = source.envelope.worktree_path;
  // A fresh manager's crash recovery keeps it; automatic retention holds the run.
  await new WorkspaceManager(root).disposeOrphan(
    source.envelope.task_id,
    source.envelope.attempt_id,
  );
  expect(readFileSync(join(tree, "authored.txt"), "utf8")).toBe("authored by the executor\n");
  const errors: unknown[] = [];
  expect(holdsRetainedSources(result.runDir, result.runId, (e) => errors.push(e))).toBe(true);
  expect(errors).toEqual([]);
  // The explicit discard owner releases exactly that copy.
  for (const path of locked) if (path.startsWith(tree) && existsSync(path)) chmodSync(path, 0o644);
  await releaseRetainedEnvelope(source);
  expect(existsSync(tree)).toBe(false);
  expect(holdsRetainedSources(result.runDir, result.runId, (e) => errors.push(e))).toBe(false);
  expect(readFileSync(join(root, "input.txt"), "utf8")).toBe("selected source\n");
}

describe.skipIf(asRoot || !posix)("a real filesystem fault in the final directory capture", () => {
  it("an unreadable output (EACCES): the copy with good text and binary output is kept for inspection", async () => {
    const root = project();
    const adapter = author("keep-eacces", (spec) => {
      writeGood(spec.cwd);
      const lockedPath = join(spec.cwd, "locked.bin");
      writeFileSync(lockedPath, "unreadable output\n");
      chmodSync(lockedPath, 0o000);
      locked.push(lockedPath);
    });

    const result = await run(root, adapter);

    const { facts, failure, summary } = terminal(result);
    expect(facts.outcome).toMatchObject({ lifecycle: "failed", reason: "capture_refused" });
    expect(failure.phase).toBe("artifact_security");
    expect(failure.captureFailure).toMatchObject({ code: "capture_failed", causeCode: "EACCES" });
    const source = expectKeptCopy(result, root);
    const tree = source.envelope.worktree_path;
    // The diagnostic path no longer dangles: it names a file that still exists.
    expect(failure.captureFailure!.message).toContain(join(tree, "locked.bin"));
    expect(existsSync(join(tree, "locked.bin"))).toBe(true);
    expect(summary).toContain(`Kept: the isolated copy at ${tree} (not applied).`);
    expect(failure.nextActions).toContain(`Inspect the changed files at ${tree}`);
    expect(failure.nextActions).toContain(KEPT_NO_EXACT);
    expect(failure.nextActions.join("\n")).not.toMatch(/retry|re-run|apply the result/i);
    await expectRecoveryHoldsThenDiscardReleases(result, root, source);
  });

  it("a FIFO special entry: the copy is kept the same way", async () => {
    const root = project();
    const adapter = author("keep-fifo", (spec) => {
      writeGood(spec.cwd);
      execFileSync("mkfifo", [join(spec.cwd, "pipe")]);
    });

    const result = await run(root, adapter);

    const { facts, failure } = terminal(result);
    expect(facts.outcome).toMatchObject({ lifecycle: "failed", reason: "capture_refused" });
    expect(failure.captureFailure!.message).toContain("Unsupported filesystem entry");
    const source = expectKeptCopy(result, root);
    await expectRecoveryHoldsThenDiscardReleases(result, root, source);
  });

  /** Final capture refuses on an unreadable output; `occupy` blocks one retention write. */
  async function refusedWith(occupy: (spec: HarnessRunSpec, runDir: string) => string) {
    const root = project();
    const runsDir = new ArtifactStore(root).runsDir();
    let occupied = "";
    const adapter = author("keep-unrecorded", (spec) => {
      writeGood(spec.cwd);
      const lockedPath = join(spec.cwd, "locked.bin");
      writeFileSync(lockedPath, "unreadable output\n");
      chmodSync(lockedPath, 0o000);
      locked.push(lockedPath);
      const runs = readdirSync(runsDir).map((name) => join(runsDir, name));
      occupied = occupy(spec, runs[0]!);
      mkdirSync(join(occupied, "occupied"), { recursive: true });
    });
    const result = await run(root, adapter);
    const { facts, summary } = terminal(result);
    expect(facts.outcome).toMatchObject({ lifecycle: "failed", reason: "capture_refused" });
    const attempt = new ArtifactStore(result.runDir).readYaml(
      join(result.runDir, "attempts/a01/attempt.yaml"),
    ) as { capture_refusal?: Record<string, unknown> };
    expect(attempt.capture_refusal).toMatchObject({
      disposition: "manual_cleanup",
      phase: "artifact_security",
      retentionFailure: { code: "capture_failed" },
    });
    const tree = attempt.capture_refusal!["sourceRoot"] as string;
    // The hold survived the run's own disposal either way.
    expect(readFileSync(join(tree, "authored.txt"), "utf8")).toBe("authored by the executor\n");
    return { result, summary, tree, occupied };
  }

  it("custody recorded but its run address not written: says setup is incomplete, never process-only", async () => {
    const { result, summary, tree, occupied } = await refusedWith((_spec, runDir) =>
      join(runDir, "attempts/a01/retained-envelope.json"),
    );
    expect(summary).toContain(
      `Kept: the isolated copy at ${tree} (not applied), recorded in durable custody; its address in this run could not be written, so retention setup is incomplete until crash recovery restores that address.`,
    );
    expect(summary).not.toContain("held by this process only");
    expect(readEnvelopeCustody(dirname(tree))).toMatchObject({
      state: "retained",
      continuation_eligible: false,
    });
    // An unreadable address holds the run and is reported, never read as nothing held.
    const errors: unknown[] = [];
    expect(holdsRetainedSources(result.runDir, result.runId, (e) => errors.push(e))).toBe(true);
    expect(errors).toHaveLength(1);
    // With no address the run's owners do not see it until recovery restores it.
    rmSync(occupied, { recursive: true });
    expect(retainedSourcesOfRun(result.runDir, result.runId)).toEqual([]);
    expect(await recoverOrphanCustody(dirname(tree))).toBe("kept");
    expect(retainedSourcesOfRun(result.runDir, result.runId)).toHaveLength(1);
  });

  it("custody itself not written: held by this process only, and says so", async () => {
    const { summary, tree } = await refusedWith((spec) =>
      join(dirname(spec.cwd), "continuation-custody.json"),
    );
    expect(summary).toContain(
      `Kept: the isolated copy at ${tree}, held by this process only (durable retention could not be recorded).`,
    );
    expect(summary).not.toMatch(/durable custody|will be kept/i);
  });
});

/** A capture error with a typed code, as a permission failure leaves it. */
const captureError = () =>
  Object.assign(new Error("EACCES: permission denied, open 'locked.bin'"), { code: "EACCES" });

describe("an injected final capture fault (any platform)", () => {
  it("isolated: kept for inspection, then released by discard", async () => {
    const root = project();
    vi.spyOn(WorkspaceManager.prototype, "captureFiles").mockRejectedValue(captureError());
    const result = await run(
      root,
      author("keep-injected", (spec) => writeGood(spec.cwd)),
    );

    expect(terminal(result).facts.outcome).toMatchObject({ reason: "capture_refused" });
    const source = expectKeptCopy(result, root);
    await expectRecoveryHoldsThenDiscardReleases(result, root, source);
  });

  it("a per-try capture fault followed by a clean final capture pins nothing", async () => {
    const root = project();
    const real = WorkspaceManager.prototype.captureFiles;
    const spy = vi
      .spyOn(WorkspaceManager.prototype, "captureFiles")
      .mockImplementationOnce(() => Promise.reject(captureError()))
      .mockImplementation(function (this: WorkspaceManager, ...args) {
        return real.apply(this, args);
      });
    const result = await run(
      root,
      author("clean-final", (spec) => writeGood(spec.cwd)),
    );

    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.lifecycle).toBe("succeeded");
    expect(retainedSourcesOfRun(result.runDir, result.runId)).toEqual([]);
    expect(readdirSync(join(result.runDir, "attempts/a01"))).not.toContain(
      "retained-envelope.json",
    );
    const envelopeTree = spy.mock.calls[0]![0].worktree_path;
    expect(existsSync(envelopeTree)).toBe(false);
    expect(readFileSync(join(result.runDir, "final/files/result.md"), "utf8")).toContain(
      "Files captured from a separate copy. Inspect the captured files; application is subject to the run's outcome and a delivery check.",
    );
  });

  it("in place keeps its live files and claims no kept copy", async () => {
    const root = project();
    vi.spyOn(WorkspaceManager.prototype, "captureFiles").mockRejectedValue(captureError());
    const result = await run(
      root,
      author("live-injected", (spec) => writeGood(spec.cwd)),
      { inPlace: true },
    );

    const { facts, failure } = terminal(result);
    expect(facts.outcome).toMatchObject({ reason: "capture_refused" });
    expect(retainedSourcesOfRun(result.runDir, result.runId)).toEqual([]);
    expect(readFileSync(join(root, "authored.txt"), "utf8")).toBe("authored by the executor\n");
    expect(failure.nextActions).toContain(
      "Inspect the changed files in the project folder directly",
    );
    expect(failure.nextActions.join("\n")).not.toContain("Inspect the changed files at");
  });

  it("the capture after a convergence infrastructure error keeps the copy too", async () => {
    const root = project();
    vi.spyOn(WorkspaceManager.prototype, "captureFiles").mockRejectedValue(captureError());
    vi.spyOn(
      Orchestrator.prototype as unknown as {
        runCandidateInEnvelope: (...args: unknown[]) => Promise<unknown>;
      },
      "runCandidateInEnvelope",
    ).mockImplementationOnce(async (_routed, envelope) => {
      writeGood((envelope as { worktree_path: string }).worktree_path);
      throw new Error("infrastructure failed after the executor wrote files");
    });
    const result = await run(
      root,
      author("converge-infra", () => undefined),
      { attempts: 2 },
    );

    expect(result.lifecycle).toBe("failed");
    const source = expectKeptCopy(result, root);
    expect(source.envelope.attempt_id).toBe("converge");
    await expectRecoveryHoldsThenDiscardReleases(result, root, source);
  });
});
