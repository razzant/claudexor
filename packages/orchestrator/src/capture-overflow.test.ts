import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { CaptureOutputExceeded, type HarnessAdapter } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import {
  ConformanceReport,
  HarnessManifest,
  RunFailure,
  makeOutcomeFacts,
} from "@claudexor/schema";
import {
  GitOperationError,
  WorkspaceManager,
  envelopeBaseOf,
  readEnvelopeCustody,
  retainedEnvelopeBase,
  retainedInspectionEnvelopes,
} from "@claudexor/workspace";
import { classifyBudgetFailure, type BudgetDenial } from "./budgetFailure.js";
import { DelegationBudgetAuthority } from "./delegationBudgetAuthority.js";
import { Orchestrator, type OrchestratorDeps, type RunInput } from "./orchestrator.js";
import { OrchestratorCredentials } from "./orchestrator-credentials.js";
import { InRunContinuity } from "./inrun-continuity.js";
import { clearFailureArtifact, reconcileWorkProductTerminal } from "./terminalOutcome.js";
import { sweepOrphanWorkspaces } from "../../cli/src/orphan-sweeper.js";
import { discardRunResult } from "../../control-api/src/run-discard.js";
import { safeReadStructuredArtifact } from "../../control-api/src/run-artifact-read.js";
import { controlRunResult } from "../../control-api/src/run-delivery-state.js";
import { runRetentionPass } from "../../control-api/src/retention.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function repo() {
  const root = mkdtempSync(join(tmpdir(), "cx-capture-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "file.txt"), "before\r\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-qm",
    "init",
  ]);
  return root;
}
const answer = "The requested work is complete.";
const yaml = (path: string) =>
  new ArtifactStore(dirname(path)).readYaml<Record<string, any>>(path)!;
/** What the workspace's own bounded inventory pass attaches to a refused capture. */
const INVENTORY = {
  exact: false,
  changedFiles: 2,
  largest: [
    { path: "unique.txt", change: "added", sizeBytes: 8 },
    { path: "file.txt", change: "modified", sizeBytes: 7 },
  ],
};
/** #535 phase 2: the typed Git failure classes that remain after object capture. */
const GIT_FAILURES: Record<string, () => Error> = {
  space: () =>
    new GitOperationError("capture_space_insufficient", "capture needs more space", {
      requiredBytes: 2_000_000_000,
      availableBytes: 1_000_000,
    }),
  stall: () =>
    new GitOperationError("capture_git_stalled", "git add -A made no progress", {
      stallMs: 120000,
    }),
  signal: () =>
    new GitOperationError("capture_git_signal", "git add was terminated", { signal: "SIGKILL" }),
  read: () => new GitOperationError("capture_read_failed", "error: unable to index file 'x'"),
  missing: () => new GitOperationError("capture_object_missing", "fatal: bad object 1234"),
  multiline: () =>
    new GitOperationError(
      "capture_read_failed",
      "error: open(\"x\"): Permission denied\nerror: unable to index file 'x'\nfatal: adding files failed\n",
    ),
};
const cause = (kind: string): Error => {
  if (GIT_FAILURES[kind]) return GIT_FAILURES[kind]!();
  if (kind === "overflow") return new CaptureOutputExceeded("stdout");
  if (kind === "inventory")
    return Object.defineProperty(new CaptureOutputExceeded("stdout"), "captureInventory", {
      value: INVENTORY,
    });
  if (kind === "drain")
    return Object.assign(new Error("incomplete pipe"), {
      code: "capture_output_incomplete",
      drain: "truncated",
    });
  const error = Object.assign(new Error("capture failed " + ["sk", "x".repeat(24)].join("-")), {
    code: "EIO",
  });
  return kind === "cleanup"
    ? Object.assign(error, {
        cleanupError: Object.assign(new Error("scratch cleanup failed"), { code: "EACCES" }),
      })
    : error;
};
async function attempt(
  options: Partial<RunInput> = {},
  kind = "error",
  end?: "refusal" | "stop" | "belt",
  deps: Partial<OrchestratorDeps> = {},
) {
  const root = repo();
  const executions: { root: string; intent: string }[] = [];
  const abort = new AbortController();
  const base = createFakeHarness("fake-success");
  const adapter: HarnessAdapter = {
    ...base,
    async *run(spec) {
      executions.push({ root: spec.cwd, intent: spec.intent });
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield {
        ...common,
        type: "started",
        observed_model: "capture-fixture",
        credential_route: "managed_api_key",
      };
      writeFileSync(join(spec.cwd, "file.txt"), "after\r\n");
      writeFileSync(join(spec.cwd, "unique.txt"), `unique-${executions.length}`);
      yield {
        ...common,
        type: "message",
        text: answer,
        final: true,
        payload: { final_source: "fake" },
      };
      yield {
        ...common,
        type: "usage",
        credential_route: "managed_api_key",
        usage: { cost_usd: 0.125 },
      };
      if (end === "refusal")
        yield {
          ...common,
          type: "error",
          error: "request refused",
          request_refusal: {
            kind: "input_too_large",
            scope: "turn_text",
            unit: "unicode_scalars",
            limit: 10,
            actual: 11,
            source: "fixture",
            native_code: "fixture_limit",
          },
        };
      // The required Delegate belt's exact tool fails and never recovers.
      if (end === "belt")
        yield {
          ...common,
          type: "tool_result",
          tool: { name: "mcp__claudexor__claudexor_ask", kind: "mcp", status: "error" },
          text: "child operation failed",
        };
      yield { ...common, type: "completed", exit_code: 0 };
      if (end === "stop") abort.abort("user_cancelled");
    },
  };
  const actual = WorkspaceManager.prototype.captureDiff;
  const envelopes: Parameters<typeof actual>[0][] = [];
  const capture = vi
    .spyOn(WorkspaceManager.prototype, "captureDiff")
    .mockImplementation(async function (this: WorkspaceManager, env) {
      if (kind === "small" || (options.synthesis === "always" && env.attempt_id !== "synth"))
        return actual.call(this, env);
      envelopes.push(env);
      throw cause(kind);
    });
  const served = vi.spyOn(OrchestratorCredentials.prototype, "noteTryServed");
  const afterTry = vi.spyOn(InRunContinuity.prototype, "afterTry");
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [],
    ...deps,
  }).run({
    repoRoot: root,
    mode: "agent",
    prompt: "write the requested file",
    harnesses: [adapter.id],
    n: 1,
    signal: abort.signal,
    ...options,
  });
  return { root, result, envelopes, executions, capture, served, afterTry };
}

/** The belt descriptor that makes the fake harness (which can host MCP servers)
 * an effective Delegate route; the parent registers its budget authority. */
const BELT = {
  name: "claudexor",
  command: process.execPath,
  args: ["/cli", "mcp", "serve-belt"],
  env: { CLAUDEXOR_DELEGATION_DEPTH: "0" },
  required: true,
};

/** Every terminal over an incomplete capture is pinned in both strategies
 * (convergence and the n: 1 race), over live effects and an isolated source. */
const LANES = [
  { label: "live convergence", options: { attempts: 2, review: false, inPlace: true } },
  { label: "isolated convergence", options: { attempts: 2, review: false } },
  { label: "live race", options: { attempts: null, inPlace: true } },
  { label: "isolated race", options: { attempts: null } },
] as { label: string; options: Partial<RunInput> }[];

/** A real Delegate parent (effective belt, registered budget authority) whose
 * terminal (convergence unless `attempts: null` selects the race) is held for
 * the child drain, then cancelled while that drain runs: the terminal wrapper's
 * late-cancel path over the real result. `drain: "rejects"` fails the drain
 * itself after the cancel (the wrapper's recovery path); `drain: "fails"` fails
 * it with no cancel at all (the drain failure's own terminal). */
async function delegateParentAtDrain(
  options: Partial<RunInput>,
  kind: string,
  drain: "resolves" | "rejects" | "fails" = "resolves",
  end?: "belt",
) {
  const controller = new AbortController();
  let runId = "";
  let admitted = false;
  const admissionId = "job-late-child";
  const authority = new (class extends DelegationBudgetAuthority {
    override async waitForChildren(parentRunId: string, timeoutMs?: number): Promise<void> {
      if (drain !== "resolves") {
        if (drain === "rejects") controller.abort("user_cancelled");
        throw Object.assign(new Error("delegation child drain timed out"), {
          code: "delegation_child_drain_timeout",
        });
      }
      return super.waitForChildren(parentRunId, timeoutMs);
    }
  })({
    cancelAdmission: (id) => {
      // The host cancel lands while the parent is still draining its child.
      controller.abort("user_cancelled");
      authority.cancelAcceptedChild(runId, id);
    },
  });
  const f = await attempt(
    {
      attempts: 2,
      review: false,
      delegate: true,
      delegationBelt: BELT,
      signal: controller.signal,
      onRunStart: (info) => {
        runId = info.runId;
      },
      onHarnessEvent: (event) => {
        // A child admitted during the attempt keeps the drain open until the
        // barrier cancels that admission.
        if (event.type === "completed" && drain === "resolves" && !admitted) {
          admitted = true;
          authority.noteChildAccepted(runId, admissionId);
        }
      },
      ...options,
    },
    kind,
    end,
    { delegationBudgetAuthority: authority },
  );
  const record = {
    id: f.result.runId,
    runId: f.result.runId,
    state: f.result.lifecycle,
    runDir: f.result.runDir,
  };
  const events = readFileSync(join(f.result.runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> });
  return {
    ...f,
    record,
    events,
    publicFailure: safeReadStructuredArtifact(record, "final/failure.yaml", RunFailure),
  };
}

it.each([
  {
    kind: "space",
    code: "capture_space_insufficient",
    text: "not enough free disk space to keep the exact result (2000000000 bytes needed, 1000000 free)",
  },
  {
    kind: "stall",
    code: "capture_git_stalled",
    text: "Git stopped making progress while recording the result (no progress for 120000 ms)",
  },
  {
    kind: "signal",
    code: "capture_git_signal",
    text: "Git was terminated by SIGKILL while recording the result",
  },
  {
    kind: "read",
    code: "capture_read_failed",
    text: "a changed file could not be read while recording the result",
  },
  {
    kind: "missing",
    code: "capture_object_missing",
    text: "a Git object the result needs was missing",
  },
])(
  "#535: a remaining $kind failure is an honest 'failed' with its exact cause, the answer kept, no retry",
  async ({ kind, code, text }) => {
    for (const options of [{ inPlace: true }, {}] as Partial<RunInput>[]) {
      const f = await attempt(options, kind);
      expect(f.result.lifecycle).toBe("failed");
      expect(f.result.facts).toMatchObject({ reason: "capture_refused", noChanges: null });
      const failure = RunFailure.parse(yaml(join(f.result.runDir, "final/failure.yaml")));
      expect(failure.captureFailure?.code).toBe(code);
      expect(failure.safeMessage).toContain(text);
      expect(failure.safeMessage).not.toContain("workspace_unavailable");
      expect(failure.nextActions.join("\n")).not.toMatch(/retry/i);
      expect(readFileSync(join(f.result.runDir, "attempts/a01/answer.md"), "utf8").trim()).toBe(
        answer,
      );
      expect(failure.safeMessage).toContain("Kept: the final answer, any media the run produced");
      expect(existsSync(join(f.result.runDir, "final", "patch.diff"))).toBe(false);
      vi.restoreAllMocks();
    }
  },
);

it.each([
  { kind: "read", detail: "error: unable to index file 'x'" },
  { kind: "missing", detail: "fatal: bad object 1234" },
  {
    kind: "multiline",
    detail:
      "error: open(\"x\"): Permission denied error: unable to index file 'x' fatal: adding files failed",
  },
  // A generic fault: its secret-like text is redacted before any surface sees it.
  { kind: "error", detail: "capture failed [redacted]" },
])(
  "#535 F11: the human receipt of a $kind refusal carries the typed failure's redacted diagnostic",
  async ({ kind, detail }) => {
    for (const options of [{ inPlace: true }, {}] as Partial<RunInput>[]) {
      const f = await attempt(options, kind);
      const failure = RunFailure.parse(yaml(join(f.result.runDir, "final/failure.yaml")));
      // The human prose shows the same bounded, redacted diagnostic the
      // machine record keeps, on one line (CLI and app print safeMessage).
      expect(failure.captureFailure?.message.replace(/\s+/g, " ").trim()).toBe(detail);
      const summary = readFileSync(join(f.result.runDir, "final/summary.md"), "utf8");
      for (const text of [failure.safeMessage, summary])
        expect(text).toContain(`Detail: ${detail}.`);
      expect(failure.safeMessage).toContain("Kept: the final answer, any media the run produced");
      expect(JSON.stringify(failure) + summary).not.toContain(["sk", "x".repeat(24)].join("-"));
      vi.restoreAllMocks();
    }
  },
);

it.each([
  { label: "live", options: { inPlace: true }, kind: "overflow" },
  { label: "standalone", options: {}, kind: "error" },
  { label: "daemon singleton", options: { continuation: { retain: true } }, kind: "cleanup" },
  { label: "race", options: { n: 2 }, kind: "drain" },
  { label: "convergence", options: { attempts: 2, review: false }, kind: "error" },
  { ...LANES[0]!, kind: "cleanup" },
] as { label: string; options: Partial<RunInput>; kind: string }[])(
  "preserves answer, spend, typed cause and every edited source through $label disposal",
  async ({ options, kind }) => {
    const f = await attempt(options, kind);
    const expected = options.n === 2 ? 2 : 1;
    expect(f.executions).toHaveLength(expected);
    expect(f.result.lifecycle).toBe("failed");
    // Headline A: the run failed for its own capture reason, not a missing workspace.
    expect(f.result.facts).toMatchObject({ reason: "capture_refused", noChanges: null });
    expect(f.result.spendUsd).toBe(0.125 * expected);
    expect(f.envelopes).toHaveLength(expected); // Failed post-try capture is reused.
    expect(f.afterTry).toHaveBeenCalledTimes(expected);
    expect(f.served).toHaveBeenCalledTimes(expected);
    for (const [facts] of f.afterTry.mock.calls) {
      expect(facts).toMatchObject({ workspaceDiffNonEmpty: true, harnessErrored: false });
      expect(facts).not.toHaveProperty("currentDiff");
    }
    const failure = RunFailure.parse(yaml(join(f.result.runDir, "final/failure.yaml")));
    expect(failure).toMatchObject({
      phase: "workspace",
      category: "project",
      captureFailure: {
        code:
          kind === "overflow"
            ? "capture_output_exceeded"
            : kind === "drain"
              ? "capture_output_incomplete"
              : "capture_failed",
      },
    });
    if (kind === "overflow")
      expect(failure.captureFailure).toMatchObject({
        bufferBudgetBytes: 256 * 1024 * 1024,
        stream: "stdout",
      });
    if (kind === "cleanup") {
      expect(failure.captureFailure?.cleanup?.code).toBe("EACCES");
      expect(failure.nextActions.some((action) => action.includes("scratch cleanup failed"))).toBe(
        true,
      );
    }
    if (kind === "drain") expect(failure.captureFailure?.drain).toBe("truncated");
    // Capture runs after the work: no action replays the authoring.
    expect(failure.nextActions.join("\n")).not.toMatch(/retry/i);
    expect(failure.nextActions).toContain(
      "Decide on those changes yourself: Claudexor kept no exact result to apply or revert",
    );
    // The receipt names what was not recorded and what is kept.
    expect(failure.safeMessage).toContain("Not recorded: the exact result");
    expect(failure.safeMessage).toContain("Kept: the final answer, any media the run produced");
    // Since #535 phase 2 there is no per-result size ceiling to announce.
    expect(failure.safeMessage).not.toContain("over the limit");
    // Completed work whose only defect is packaging is not resumable work.
    expect(existsSync(join(f.result.runDir, "final/resumable.yaml"))).toBe(false);
    const terminal = readFileSync(join(f.result.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      .findLast((event) => event.type === "run.failed");
    expect(terminal?.payload).toMatchObject({ reason: "capture_refused" });
    expect(terminal?.payload).not.toHaveProperty("resumable");
    expect(JSON.stringify(failure)).not.toContain(["sk", "x".repeat(24)].join("-"));
    expect(existsSync(join(f.result.runDir, "final/patch.diff"))).toBe(false);
    for (const env of f.envelopes) {
      const attemptId = options.attempts ? "a01" : env.attempt_id;
      const attemptDir = join(f.result.runDir, "attempts", attemptId);
      const record = yaml(join(attemptDir, "attempt.yaml"));
      expect(record.cost_usd).toBe(0.125);
      expect(record.outcome).toMatchObject({ harnessErrored: false, status: "failed" });
      expect(record.capture_refusal).toMatchObject({
        disposition: options.inPlace ? "manual_cleanup" : "retained",
        sourceRoot: env.worktree_path,
      });
      expect(readFileSync(join(attemptDir, "answer.md"), "utf8").trim()).toBe(answer);
      expect(existsSync(join(attemptDir, "patch.diff"))).toBe(false);
      await new WorkspaceManager(f.root).dispose(env);
      expect(readFileSync(join(env.worktree_path, "unique.txt"), "utf8")).toMatch(/^unique-/);
      if (!options.inPlace) {
        expect(readEnvelopeCustody(envelopeBaseOf(env))?.state).toBe("retained");
        // Model a dead original owner. The real startup sweeper must retain it.
        writeFileSync(
          join(envelopeBaseOf(env), "owner.json"),
          JSON.stringify({
            pid: 2147483647,
            started: "gone",
            envelope_id: env.id,
            workspace_mode: "isolated",
          }),
        );
      }
    }
    if (options.inPlace) {
      expect(yaml(join(f.result.runDir, "final/work_product.yaml")).meta).toMatchObject({
        adopted: true,
        apply_state: "applied_review_blocked",
        revert_anchor_id: null,
      });
    } else {
      await sweepOrphanWorkspaces({ knownProjectRoots: () => [f.root] });
      for (const env of f.envelopes)
        expect(existsSync(join(env.worktree_path, "unique.txt"))).toBe(true);
      const record = {
        id: f.result.runId,
        runId: f.result.runId,
        state: "failed",
        runDir: f.result.runDir,
      };
      const receipt = await runRetentionPass(
        { runsMaxAgeDays: 1, reviewsMaxAgeDays: 1, keepLastRunsPerProject: 0 },
        { dry_run: false },
        {
          projects: () => [{ root: f.root, runsDir: dirname(f.result.runDir), reviewsDir: null }],
          records: () => [{ ...record, finishedAt: "2020-01-01T00:00:00Z" }],
          referencedRunIds: () => new Set(),
        },
      );
      expect(receipt.kept.actionable).toBeGreaterThan(0);
      if (options.continuation)
        expect(retainedEnvelopeBase(f.result.runDir)).toBe(envelopeBaseOf(f.envelopes[0]!));
      else {
        expect(retainedEnvelopeBase(f.result.runDir)).toBeNull();
        expect(retainedInspectionEnvelopes(f.result.runDir, f.result.runId)).toHaveLength(expected);
      }
      await discardRunResult(record);
      for (const env of f.envelopes) expect(existsSync(env.worktree_path)).toBe(false);
    }
  },
);

it("retains a failed synthesis source without replacing good candidate output", async () => {
  const f = await attempt({ n: 2, synthesis: "always" }, "error");
  expect(f.executions.some((e) => e.intent === "synthesize")).toBe(true);
  expect(f.envelopes).toHaveLength(1);
  const env = f.envelopes[0]!;
  expect(env.attempt_id).toBe("synth");
  expect(yaml(join(f.result.runDir, "attempts/synth/attempt.yaml"))).toMatchObject({
    cost_usd: 0.125,
    capture_refusal: { disposition: "retained" },
  });
  expect(readFileSync(join(f.result.runDir, "attempts/synth/answer.md"), "utf8").trim()).toBe(
    answer,
  );
  await new WorkspaceManager(f.root).dispose(env);
  expect(existsSync(join(env.worktree_path, "unique.txt"))).toBe(true);
  expect(retainedInspectionEnvelopes(f.result.runDir, f.result.runId)).toHaveLength(1);
  expect(f.result.spendUsd).toBe(0.375);
});

it.each(["refusal", "stop"] as const)(
  "keeps capture evidence and cost when the native terminal is %s",
  async (end) => {
    const f = await attempt({}, "error", end);
    expect(f.result.lifecycle).not.toBe("succeeded");
    expect(f.result.spendUsd).toBe(0.125);
    if (end === "refusal") {
      expect(f.afterTry).not.toHaveBeenCalled(); // Final-only entrance.
      expect(RunFailure.parse(yaml(join(f.result.runDir, "final/failure.yaml")))).toMatchObject({
        code: "input_too_large",
        captureFailure: { causeCode: "EIO" },
        nextActions: expect.arrayContaining([
          `Inspect the changed files at ${f.envelopes[0]!.worktree_path}`,
          "Fit the input to the reported transport limit or supply source references",
        ]),
      });
    }
    expect(f.envelopes).toHaveLength(1);
    const record = yaml(join(f.result.runDir, "attempts/a01/attempt.yaml"));
    expect(record).toMatchObject({
      cost_usd: 0.125,
      capture_refusal: { failure: { causeCode: "EIO" } },
    });
    expect(readFileSync(join(f.result.runDir, "attempts/a01/answer.md"), "utf8").trim()).toBe(
      answer,
    );
    expect(existsSync(f.envelopes[0]!.worktree_path)).toBe(true);
  },
);

it("keeps the budget terminal and still names the retained source and failed scratch cleanup", async () => {
  // A finite cap below the estimate floor admits the first unknown-cost
  // candidate and refuses the second before it starts (estimate_headroom).
  const f = await attempt({ n: 2, paidBudget: { kind: "finite", maxUsd: 0.04 } }, "cleanup");
  expect(f.executions).toHaveLength(1);
  expect(f.envelopes).toHaveLength(1);
  expect(f.result).toMatchObject({ lifecycle: "failed", spendUsd: 0.125 });
  expect(f.result.facts.reason).toBe("budget_exhausted");
  const failure = RunFailure.parse(yaml(join(f.result.runDir, "final/failure.yaml")));
  expect(failure).toMatchObject({
    phase: "budget",
    category: "budget",
    code: "estimate_headroom",
    attemptId: "a02",
    captureFailure: { code: "capture_failed", cleanup: { code: "EACCES" } },
  });
  const denial: BudgetDenial = {
    code: "estimate_headroom",
    reason: "",
    harnessId: null,
    attemptId: null,
  };
  expect(failure.nextActions).toEqual([
    ...classifyBudgetFailure({ denial, terminal: null }).nextActions,
    `Inspect the changed files at ${f.envelopes[0]!.worktree_path}`,
    "Inspect Claudexor temporary state: private scratch cleanup failed",
  ]);
  expect(yaml(join(f.result.runDir, "attempts/a01/attempt.yaml")).capture_refusal).toMatchObject({
    disposition: "retained",
    sourceRoot: f.envelopes[0]!.worktree_path,
  });
  expect(existsSync(join(f.envelopes[0]!.worktree_path, "unique.txt"))).toBe(true);
});

/** The facts and remedies every convergence terminal over an incomplete capture keeps. */
function expectConvergenceCapture(runDir: string, sourceRoot: string, primary: string[]) {
  const failure = RunFailure.parse(yaml(join(runDir, "final/failure.yaml")));
  expect(failure.captureFailure).toMatchObject({
    code: "capture_failed",
    cleanup: { code: "EACCES" },
  });
  expect(failure.nextActions).toEqual([
    ...primary,
    `Inspect the changed files at ${sourceRoot}`,
    "Inspect Claudexor temporary state: private scratch cleanup failed",
  ]);
  expect(JSON.stringify(failure)).not.toContain(["sk", "x".repeat(24)].join("-"));
  // No exact patch was observed, so none (not even an empty one) is published.
  expect(existsSync(join(runDir, "final/patch.diff"))).toBe(false);
  return failure;
}

it.each([
  { label: "isolated", options: {} },
  { label: "live", options: { inPlace: true } },
] as { label: string; options: Partial<RunInput> }[])(
  "convergence keeps cancellation over an incomplete $label capture",
  async ({ options }) => {
    const f = await attempt({ attempts: 2, review: false, ...options }, "cleanup", "stop");
    const env = f.envelopes[0]!;
    expect(f.executions).toHaveLength(1);
    expect(f.result).toMatchObject({ lifecycle: "cancelled", spendUsd: 0.125 });
    expect(f.result.facts).toMatchObject({ reason: "user_cancelled", noChanges: null });
    const failure = expectConvergenceCapture(f.result.runDir, env.worktree_path, [
      "Retry if cancellation was accidental",
    ]);
    expect(failure).toMatchObject({ phase: "convergence", category: "cancelled" });
    const product = join(f.result.runDir, "final/work_product.yaml");
    if (options.inPlace)
      expect(yaml(product).meta).toMatchObject({
        result_kind: "none",
        lifecycle: "cancelled",
        capture_refused: true,
        adopted: true,
        apply_state: "applied_review_blocked",
        revert_anchor_id: null,
      });
    else expect(existsSync(product)).toBe(false);
    expect(readFileSync(join(f.result.runDir, "final/answer.md"), "utf8").trim()).toBe(answer);
    expect(yaml(join(f.result.runDir, "attempts/a01/attempt.yaml")).cost_usd).toBe(0.125);
    await new WorkspaceManager(f.root).dispose(env);
    expect(readFileSync(join(env.worktree_path, "unique.txt"), "utf8")).toBe("unique-1");
  },
);

it.each(LANES)(
  "$label keeps a typed request refusal over an incomplete capture",
  async ({ options }) => {
    const f = await attempt(options, "error", "refusal");
    const env = f.envelopes[0]!;
    expect(f.executions).toHaveLength(1);
    expect(f.result).toMatchObject({ lifecycle: "failed", spendUsd: 0.125 });
    expect(f.result.facts.noChanges).toBeNull();
    const failure = RunFailure.parse(yaml(join(f.result.runDir, "final/failure.yaml")));
    expect(failure).toMatchObject({
      code: "input_too_large",
      captureFailure: { causeCode: "EIO" },
    });
    // The refusal's own remedy leads; nothing points at a patch that does not exist.
    expect(failure.nextActions).toEqual([
      "Fit the input to the reported transport limit or supply source references",
      "Choose another compatible harness if the complete input must remain inline",
      `Inspect the changed files at ${env.worktree_path}`,
      "Decide on those changes yourself: Claudexor kept no exact result to apply or revert",
    ]);
    expect(existsSync(join(f.result.runDir, "final/patch.diff"))).toBe(false);
    const product = join(f.result.runDir, "final/work_product.yaml");
    if (options.inPlace)
      expect(yaml(product).meta).toMatchObject({
        capture_refused: true,
        adopted: true,
        apply_state: "applied_review_blocked",
      });
    else expect(existsSync(product)).toBe(false);
    expect(existsSync(join(env.worktree_path, "unique.txt"))).toBe(true);
  },
);

it.each(LANES)("$label keeps a budget denial over an incomplete capture", async ({ options }) => {
  const root = repo();
  const configDir = mkdtempSync(join(tmpdir(), "cx-capture-config-"));
  roots.push(configDir);
  // The suite setup restores the sandbox config dir after this test.
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  writeFileSync(
    join(configDir, "config.yaml"),
    JSON.stringify({
      routing: { paid_fallback: "allowed_within_cap" },
      credential_profiles: ["a", "b"].map((id) => ({
        profile_id: id,
        harness_id: "limited",
        display_name: id,
        credential_kind: "config_dir_login",
        isolation_locator: join(configDir, `profile-${id}`),
      })),
      harnesses: { limited: { profile_policy: { limit_action: "rotate" } } },
    }),
  );
  const runs: string[] = [];
  // Account a is included and is rate-limited after real work; continuing on
  // paid account b is refused by the $0 cap at its pre-dispatch re-admission.
  const adapter: HarnessAdapter = {
    id: "limited",
    discover: async () =>
      HarnessManifest.parse({
        id: "limited",
        display_name: "limited",
        kind: "local_cli",
        provider_family: "local",
        capabilities: {
          implement: true,
          repair: true,
          read_files: true,
          effort_levels: ["high"],
          known_models: ["same-model"],
        },
        auth_modes: ["local_session"],
        access_profiles_supported: ["workspace_write", "readonly"],
      }),
    doctor: async () =>
      ConformanceReport.parse({
        harness_id: "limited",
        status: "ok",
        enabled_intents: ["implement", "repair"],
        auth_sources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
      }),
    probeCredentialProfile: async (profile) => ({
      profile_id: profile.profile_id,
      harness_id: "limited",
      availability: "available",
      verification: "passed",
      verification_source: "local_store",
      last_verified_at: new Date().toISOString(),
    }),
    models: async () => [{ id: "same-model", label: null, context_window: null, routes: null }],
    prepareProcessing: async (input) => {
      const paid = input.credentialProfile?.profile_id === "b";
      return {
        model: input.model,
        receipt: {
          requested: input.preference ?? null,
          submitted: paid ? "fast" : "standard",
          submittedNative: paid ? "priority" : "default",
          observed: "unknown",
          observedNative: [],
          reason: paid ? null : "fast_unavailable",
          source: "fixture.account.catalog",
        },
        costBasis: {
          nativeMode: paid ? "priority" : "default",
          kind: paid ? "paid_credits" : "included",
          source: "fixture.account.billing",
        },
      };
    },
    async *run(spec) {
      const profile = spec.credential_profile!.profile_id;
      runs.push(profile);
      const common = {
        session_id: spec.session_id,
        ts: new Date().toISOString(),
        credential_route: "vendor_native" as const,
        credential_profile_id: profile,
        processing: spec.processing,
        processing_cost_basis: spec.processing_cost_basis,
      };
      yield { ...common, type: "started" };
      writeFileSync(join(spec.cwd, "file.txt"), "after\r\n");
      writeFileSync(join(spec.cwd, "unique.txt"), `unique-${profile}`);
      yield { ...common, type: "file_change", payload: { path: "unique.txt" } };
      yield {
        ...common,
        type: "status",
        status: { kind: "api_retry", error_category: "rate_limit" },
        rate_limit: { resets_at: null, retry_delay_ms: 60000 },
      };
      yield { ...common, type: "error", error: "fixture capacity exhausted after work" };
      yield { ...common, type: "completed" };
    },
  };
  const envelopes: Parameters<typeof WorkspaceManager.prototype.captureDiff>[0][] = [];
  vi.spyOn(WorkspaceManager.prototype, "captureDiff").mockImplementation(async (env) => {
    envelopes.push(env);
    throw cause("cleanup");
  });
  const result = await new Orchestrator({
    registry: new Map([["limited", adapter]]),
    reviewers: [],
  }).run({
    repoRoot: root,
    mode: "agent",
    prompt: "write the requested file",
    harnesses: ["limited"],
    ...options,
    processingPreference: "fast",
    models: { limited: "same-model" },
    effort: "high",
    authPreference: "subscription",
    paidBudget: { kind: "finite", maxUsd: 0 },
    web: "off",
  });
  expect(runs).toEqual(["a"]);
  // Account a is included, so no cash was observed; nothing is invented.
  expect(result).toMatchObject({ lifecycle: "failed", spendUsd: 0 });
  expect(result.facts).toMatchObject({ reason: "budget_exhausted", noChanges: null });
  const env = envelopes[0]!;
  const denial: BudgetDenial = {
    code: "finite_zero",
    reason: "",
    harnessId: null,
    attemptId: null,
  };
  const failure = expectConvergenceCapture(
    result.runDir,
    env.worktree_path,
    classifyBudgetFailure({ denial, terminal: null }).nextActions,
  );
  expect(failure).toMatchObject({ phase: "budget", category: "budget", code: "finite_zero" });
  const product = join(result.runDir, "final/work_product.yaml");
  // Live effects keep their capture-refused receipt with the same budget facts.
  if (options.inPlace)
    expect(yaml(product).meta).toMatchObject({
      outcome_facts: { reason: "budget_exhausted", noChanges: null },
      capture_refused: true,
      adopted: true,
      apply_state: "applied_review_blocked",
    });
  else expect(existsSync(product)).toBe(false);
  await new WorkspaceManager(root).dispose(env);
  expect(readFileSync(join(env.worktree_path, "unique.txt"), "utf8")).toBe("unique-a");
  expect(retainedInspectionEnvelopes(result.runDir, result.runId)).toHaveLength(
    options.inPlace ? 0 : 1,
  );
});

it.each([
  { label: "live", options: { inPlace: true } },
  { label: "isolated", options: {} },
] as { label: string; options: Partial<RunInput> }[])(
  "race cancellation keeps the capture-refused receipt of $label effects and projects it publicly",
  async ({ options }) => {
    const f = await attempt(options, "cleanup", "stop");
    const env = f.envelopes[0]!;
    expect(f.executions).toHaveLength(1);
    expect(f.result).toMatchObject({ lifecycle: "cancelled", spendUsd: 0.125 });
    expect(f.result.facts.reason).toBe("user_cancelled");
    expect(existsSync(join(f.result.runDir, "final/patch.diff"))).toBe(false);
    expect(existsSync(join(f.result.runDir, "final/failure.yaml"))).toBe(false);
    const record = {
      id: f.result.runId,
      runId: f.result.runId,
      state: "cancelled",
      runDir: f.result.runDir,
    };
    const product = join(f.result.runDir, "final/work_product.yaml");
    if (options.inPlace) {
      // The live tree already changed: the public result says applied (review
      // blocked), not revertable, with the cancellation's own facts.
      expect(readFileSync(join(f.root, "unique.txt"), "utf8")).toBe("unique-1");
      const receipt = {
        result_kind: "none",
        lifecycle: "cancelled",
        outcome_facts: { lifecycle: "cancelled", reason: "user_cancelled", noChanges: null },
        capture_refused: true,
        capture_recovery: "manual_cleanup",
        capture_failure: { code: "capture_failed", cleanup: { code: "EACCES" } },
        execution_root: f.root,
        adopted: true,
        apply_state: "applied_review_blocked",
        revert_anchor_id: null,
      };
      expect(yaml(product).meta).toMatchObject(receipt);
      const projected = { kind: "none", adopted: true, applyState: "applied_review_blocked" };
      expect(controlRunResult(record)).toMatchObject({ ...projected, revertable: false });
      // The Delegate barrier's late cancel reconciles only the terminal axes of
      // this receipt and clears a failure artifact (there is none): the
      // capture-refused facts and the public projection survive it.
      const finalDir = join(f.result.runDir, "final");
      const store = new ArtifactStore(f.result.runDir);
      reconcileWorkProductTerminal(
        { store, paths: { finalDir } },
        makeOutcomeFacts("cancelled", { reason: "user_cancelled", noChanges: null }),
      );
      clearFailureArtifact({ store, paths: { finalDir } }, { summary: "run cancelled" });
      expect(yaml(product).meta).toMatchObject(receipt);
      expect(controlRunResult(record)).toMatchObject({ ...projected, revertable: false });
    } else {
      // An isolated draft is never adopted; its source waits in retained custody.
      expect(existsSync(product)).toBe(false);
      expect(controlRunResult(record)).toMatchObject({ adopted: null, applyState: "not_applied" });
      expect(retainedInspectionEnvelopes(f.result.runDir, f.result.runId)).toHaveLength(1);
    }
    expect(yaml(join(f.result.runDir, "attempts/a01/attempt.yaml"))).toMatchObject({
      cost_usd: 0.125,
      capture_refusal: { sourceRoot: env.worktree_path, failure: { cleanup: { code: "EACCES" } } },
    });
    expect(readFileSync(join(f.result.runDir, "attempts/a01/answer.md"), "utf8").trim()).toBe(
      answer,
    );
    await new WorkspaceManager(f.root).dispose(env);
    expect(readFileSync(join(env.worktree_path, "unique.txt"), "utf8")).toBe("unique-1");
  },
);

it.each(LANES)(
  "$label keeps a settled budget overshoot over an incomplete capture, with the capture facts as follow-ups",
  async ({ options }) => {
    // A positive finite cap admits the first attempt; its typed final answer is
    // followed by an exact 0.125 charge that settles above the cap, then the
    // capture of that same attempt fails.
    const f = await attempt({ ...options, paidBudget: { kind: "finite", maxUsd: 0.1 } }, "cleanup");
    const env = f.envelopes[0]!;
    expect(f.executions).toHaveLength(1);
    expect(f.result).toMatchObject({ lifecycle: "failed", spendUsd: 0.125 });
    expect(f.result.facts).toMatchObject({ reason: "budget_overshoot", noChanges: null });
    // The budget cause and its own remedy lead; the capture facts follow.
    const failure = expectConvergenceCapture(
      f.result.runDir,
      env.worktree_path,
      classifyBudgetFailure({ denial: null, terminal: "budget_overshoot" }).nextActions,
    );
    expect(failure).toMatchObject({
      phase: "budget",
      category: "budget",
      code: "budget_overshoot",
    });
    expect(yaml(join(f.result.runDir, "attempts/a01/attempt.yaml"))).toMatchObject({
      cost_usd: 0.125,
      capture_refusal: { sourceRoot: env.worktree_path },
    });
    expect(readFileSync(join(f.result.runDir, "attempts/a01/answer.md"), "utf8").trim()).toBe(
      answer,
    );
    if (options.attempts)
      expect(readFileSync(join(f.result.runDir, "final/answer.md"), "utf8").trim()).toBe(answer);
    const product = join(f.result.runDir, "final/work_product.yaml");
    if (options.inPlace)
      expect(yaml(product).meta).toMatchObject({
        result_kind: "none",
        lifecycle: "failed",
        outcome_facts: { reason: "budget_overshoot", noChanges: null },
        capture_refused: true,
        adopted: true,
        apply_state: "applied_review_blocked",
        revert_anchor_id: null,
      });
    else {
      expect(existsSync(product)).toBe(false);
      expect(retainedInspectionEnvelopes(f.result.runDir, f.result.runId)).toHaveLength(1);
    }
    await new WorkspaceManager(f.root).dispose(env);
    expect(readFileSync(join(env.worktree_path, "unique.txt"), "utf8")).toBe("unique-1");
  },
);

/** A Delegate tool failure of the same attempt leads; the capture facts ride with it. */
const withBeltFailure = LANES.map((lane) => ({
  ...lane,
  label: `${lane.label} (belt tool failed)`,
  end: "belt" as const,
}));

it.each([
  ...LANES.map((lane) => ({ ...lane, drain: "resolves" })),
  ...withBeltFailure.map((lane) => ({ ...lane, drain: "resolves" })),
  { ...LANES[0]!, label: "live convergence (drain fails)", drain: "rejects" },
] as {
  label: string;
  options: Partial<RunInput>;
  drain: "resolves" | "rejects";
  end?: "belt";
}[])(
  "a Delegate parent's late cancellation keeps the $label capture facts on the public failure surface",
  async ({ options, drain, end }) => {
    const f = await delegateParentAtDrain(options, "cleanup", drain, end);
    const env = f.envelopes[0]!;
    expect(f.executions).toHaveLength(1);
    // Cancellation keeps its priority over the prepared convergence terminal.
    expect(f.result).toMatchObject({ lifecycle: "cancelled", spendUsd: 0.125 });
    expect(f.result.facts).toMatchObject({ reason: "user_cancelled", noChanges: null });
    expect(f.events.at(-1)).toMatchObject({
      type: "run.failed",
      payload: { lifecycle: "cancelled", reason: "user_cancelled" },
    });
    // The capture facts and the inspection/manual-cleanup actions of that
    // terminal stay readable where Control reads a run's failure, under the
    // cancellation's own category and summary (the record keeps the phase of
    // the terminal that wrote it); nothing points at a patch that does not exist.
    expect(f.publicFailure).toMatchObject({
      phase: end ? "delegation_runtime" : "workspace",
      category: "cancelled",
      code: null,
      safeMessage: "run cancelled",
      captureFailure: { code: "capture_failed", cleanup: { code: "EACCES" } },
    });
    expect(f.publicFailure?.nextActions).toEqual(
      expect.arrayContaining([
        `Inspect the changed files at ${env.worktree_path}`,
        "Inspect Claudexor temporary state: private scratch cleanup failed",
        ...(end ? ["Repair the failed Delegate belt operation, then retry the run"] : []),
      ]),
    );
    expect(JSON.stringify(f.publicFailure)).not.toContain(["sk", "x".repeat(24)].join("-"));
    expect(existsSync(join(f.result.runDir, "final/patch.diff"))).toBe(false);
    const product = join(f.result.runDir, "final/work_product.yaml");
    if (options.inPlace) {
      expect(yaml(product).meta).toMatchObject({
        result_kind: "none",
        lifecycle: "cancelled",
        outcome_facts: { lifecycle: "cancelled", reason: "user_cancelled" },
        capture_refused: true,
        capture_recovery: "manual_cleanup",
        execution_root: f.root,
        adopted: true,
        apply_state: "applied_review_blocked",
        revert_anchor_id: null,
      });
      expect(controlRunResult(f.record)).toMatchObject({
        kind: "none",
        adopted: true,
        applyState: "applied_review_blocked",
        revertable: false,
      });
    } else {
      expect(existsSync(product)).toBe(false);
      expect(retainedInspectionEnvelopes(f.result.runDir, f.result.runId)).toHaveLength(1);
    }
    expect(yaml(join(f.result.runDir, "attempts/a01/attempt.yaml"))).toMatchObject({
      cost_usd: 0.125,
      capture_refusal: { sourceRoot: env.worktree_path },
    });
    // The capture terminal keeps the completed answer per attempt (R2); the
    // late cancel does not move or drop it.
    expect(readFileSync(join(f.result.runDir, "attempts/a01/answer.md"), "utf8").trim()).toBe(
      answer,
    );
    await new WorkspaceManager(f.root).dispose(env);
    expect(readFileSync(join(env.worktree_path, "unique.txt"), "utf8")).toBe("unique-1");
  },
);

it.each([...LANES, ...withBeltFailure] as {
  label: string;
  options: Partial<RunInput>;
  end?: "belt";
}[])(
  "a Delegate child drain that fails without a cancel keeps the $label capture facts after its own cause",
  async ({ options, end }) => {
    const f = await delegateParentAtDrain(options, "cleanup", "fails", end);
    const env = f.envelopes[0]!;
    expect(f.result).toMatchObject({ lifecycle: "failed", spendUsd: 0.125 });
    expect(f.result.facts).toMatchObject({ reason: "harness_failed", noChanges: null });
    // The drain failure leads with its own typed cause and remedy; the prepared
    // record's capture facts and actions follow it.
    expect(f.publicFailure).toMatchObject({
      phase: "delegation_drain",
      code: "delegation_child_drain_timeout",
      captureFailure: { code: "capture_failed", cleanup: { code: "EACCES" } },
    });
    // The drain failure leads with its own generic remedy; the capture's
    // inspection and decision actions follow, with no retry of their own.
    expect(f.publicFailure?.nextActions).toEqual([
      "Open diagnostics",
      "Retry the run",
      `Inspect the changed files at ${env.worktree_path}`,
      "Inspect Claudexor temporary state: private scratch cleanup failed",
      "Decide on those changes yourself: Claudexor kept no exact result to apply or revert",
      ...(end
        ? [
            "Inspect attempts/a01/attempt.yaml",
            "Repair the failed Delegate belt operation, then retry the run",
          ]
        : []),
    ]);
    const product = join(f.result.runDir, "final/work_product.yaml");
    if (options.inPlace)
      expect(yaml(product).meta).toMatchObject({
        capture_refused: true,
        adopted: true,
        apply_state: "applied_review_blocked",
      });
    else expect(retainedInspectionEnvelopes(f.result.runDir, f.result.runId)).toHaveLength(1);
    await new WorkspaceManager(f.root).dispose(env);
    expect(readFileSync(join(env.worktree_path, "unique.txt"), "utf8")).toBe("unique-1");
  },
);

it("a Delegate parent's late cancellation over a captured result keeps no failure record (control)", async () => {
  const f = await delegateParentAtDrain({ inPlace: true }, "small");
  expect(f.result).toMatchObject({ lifecycle: "cancelled" });
  expect(f.result.facts.reason).toBe("user_cancelled");
  expect(f.events.at(-1)).toMatchObject({
    type: "run.failed",
    payload: { lifecycle: "cancelled" },
  });
  // Cancellation has no failure payload of its own; the captured patch and its
  // receipt keep their produced-work facts under the cancelled lifecycle.
  expect(f.publicFailure).toBeNull();
  expect(existsSync(join(f.result.runDir, "final/patch.diff"))).toBe(true);
  const meta = yaml(join(f.result.runDir, "final/work_product.yaml")).meta;
  expect(meta).toMatchObject({
    result_kind: "patch",
    lifecycle: "cancelled",
    outcome_facts: { lifecycle: "cancelled", reason: "user_cancelled" },
  });
  expect(meta.capture_refused).toBeUndefined();
});

it("persists a small exact patch that applies with CRLF intact", async () => {
  const f = await attempt({}, "small");
  expect(f.result.lifecycle).toBe("succeeded");
  const patch = readFileSync(join(f.result.runDir, "final/patch.diff"), "utf8");
  execFileSync("git", ["-C", f.root, "apply", "--check", "-"], { input: patch });
  execFileSync("git", ["-C", f.root, "apply", "-"], { input: patch });
  expect(readFileSync(join(f.root, "file.txt"), "utf8")).toBe("after\r\n");
});

it("clears an incomplete post-try capture when a real native continuation succeeds", async () => {
  const { run, seedSession, crash } = await import("./inrun-continuity.test-support.js");
  const actual = WorkspaceManager.prototype.captureDiff;
  const capture = vi
    .spyOn(WorkspaceManager.prototype, "captureDiff")
    .mockRejectedValueOnce(cause("error"));
  capture.mockImplementation(async function (this: WorkspaceManager, env) {
    return actual.call(this, env);
  });
  // once() takes precedence over the steady implementation: the first try
  // refuses, the continued try and final capture use the real Git collector.
  const outcome = await run({
    mode: "agent",
    profiles: ["a"],
    script: function* ({ spec, emit, tryOfProfile }) {
      if (tryOfProfile === 1) {
        seedSession(spec.cwd, "a", "sid-A");
        yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
        writeFileSync(join(spec.cwd, "first.txt"), "partial\n");
        yield emit({ type: "file_change", payload: { path: "first.txt" } });
        yield* crash(emit);
      } else {
        yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
        writeFileSync(join(spec.cwd, "second.txt"), "continued\n");
        yield emit({ type: "message", text: answer, final: true });
        yield emit({ type: "completed" });
      }
    },
  });
  expect(outcome.spawns).toHaveLength(2);
  expect(outcome.result.lifecycle).toBe("succeeded");
  const record = yaml(join(outcome.result.runDir, "attempts/a01/attempt.yaml"));
  expect(record.capture_refusal).toBeUndefined();
  expect(readFileSync(join(outcome.result.runDir, "final/patch.diff"), "utf8")).toContain(
    "second.txt",
  );
});

it("refuses a clipped legacy plain preview at exact consumers and leaves the live source usable", async () => {
  const { captureCandidateWorkspace } = await import("./secretDiff.js");
  const root = mkdtempSync(join(tmpdir(), "cx-plain-capture-"));
  roots.push(root);
  writeFileSync(join(root, "before.txt"), "before\n");
  // Normal orchestration establishes a Git boundary first. Exercise the actual
  // legacy non-Git entrance without replacing explicit directory/file manifests.
  const wsm = new WorkspaceManager(root);
  const envelope = await wsm.create({ taskId: "legacy", attemptId: "a01", inPlace: true });
  writeFileSync(join(root, "large.txt"), "x".repeat(250_000));
  const capture = await captureCandidateWorkspace({
    wsm,
    envelope,
    inPlace: true,
    holder: { runId: "r-legacy", runDir: join(root, "run") },
    contract: { tests: { commands: [] }, review_requested: false },
  });
  expect(capture.diff).toBe("");
  expect(capture.captureRefusal).toMatchObject({
    disposition: "manual_cleanup",
    sourceRoot: root,
    failure: { code: "capture_preview_truncated" },
  });
  await expect(wsm.diff(envelope)).rejects.toMatchObject({ code: "capture_preview_truncated" });
  await new WorkspaceManager(root).dispose(envelope);
  expect(readFileSync(join(root, "large.txt"), "utf8")).toHaveLength(250_000);
});

it("names the refused capture's non-exact inventory, never a patch", async () => {
  const f = await attempt({ inPlace: true, attempts: null }, "inventory");
  expect(f.result.facts).toMatchObject({ lifecycle: "failed", reason: "capture_refused" });
  const failure = RunFailure.parse(yaml(join(f.result.runDir, "final/failure.yaml")));
  expect(failure.captureFailure).toMatchObject({
    code: "capture_output_exceeded",
    inventory: INVENTORY,
  });
  expect(yaml(join(f.result.runDir, "attempts/a01/attempt.yaml")).capture_refusal).toMatchObject({
    failure: { inventory: INVENTORY },
  });
  const summary = readFileSync(join(f.result.runDir, "final/summary.md"), "utf8");
  expect(summary).toContain("- Lifecycle: failed (capture_refused)");
  expect(summary).toContain(
    "Largest changed files (inventory, not exact, not a patch): 2 changed\n- added unique.txt · 8 bytes",
  );
  // Exact-or-nothing: no patch file of any kind is published for the refusal.
  expect(existsSync(join(f.result.runDir, "final/patch.diff"))).toBe(false);
  expect(existsSync(join(f.result.runDir, "attempts/a01/patch.diff"))).toBe(false);
});

it.each([
  { end: "refusal" as const, lifecycle: "failed", cause: "other" },
  { end: "stop" as const, lifecycle: "cancelled", cause: "cancelled" },
])(
  "keeps continuation facts the work itself earned ($end) beside a refused capture",
  async ({ end, lifecycle, cause: resumableCause }) => {
    const f = await attempt({ inPlace: true, attempts: null }, "overflow", end);
    expect(f.result.lifecycle).toBe(lifecycle);
    const terminal = readFileSync(join(f.result.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      .findLast((event) => event.type === "run.failed");
    // An execution error or a cancel leaves unfinished work: it stays continuable.
    expect(terminal?.payload["resumable"]).toMatchObject({
      cause: resumableCause,
      workspace: { kind: "in_place" },
    });
  },
);

it("keeps run-produced media when the capture is refused: a run copy and the live directory", async () => {
  const root = repo();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  let shot = "";
  const base = createFakeHarness("fake-success");
  const adapter: HarnessAdapter = {
    ...base,
    async discover() {
      const manifest = await base.discover();
      return { ...manifest, capabilities: { ...manifest.capabilities, browser_tool: true } };
    },
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "media-fixture" };
      // The browser descriptor names the run-owned (marker-bound) artifact child.
      mkdirSync(spec.browser!.output_dir!, { recursive: true });
      shot = join(spec.browser!.output_dir!, "screenshot.png");
      writeFileSync(shot, png);
      writeFileSync(join(spec.cwd, "file.txt"), "after\r\n");
      yield { ...common, type: "message", text: answer, final: true };
      yield { ...common, type: "completed", exit_code: 0 };
    },
  };
  vi.spyOn(WorkspaceManager.prototype, "captureDiff").mockRejectedValue(
    new CaptureOutputExceeded("stdout"),
  );
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [],
  }).run({
    repoRoot: root,
    mode: "agent",
    prompt: "take a screenshot",
    harnesses: [adapter.id],
    n: 1,
    attempts: null,
    inPlace: true,
    browser: true,
    web: "auto",
  });
  expect(result.facts).toMatchObject({ lifecycle: "failed", reason: "capture_refused" });
  expect(shot).toContain(".claudexor-artifacts/");
  const produced = yaml(join(result.runDir, "attempts/a01/attempt.yaml"))
    .produced_files as string[];
  expect(produced).toHaveLength(1);
  expect(shot.endsWith(produced[0]!)).toBe(true);
  // The run keeps its own copy, and in-place disposal kept the live directory.
  expect(readFileSync(join(result.runDir, "attempts/a01/produced", produced[0]!))).toEqual(png);
  expect(readFileSync(shot)).toEqual(png);
  // The retained answer stays the diagnostic primary output and links the copy.
  const retained = readFileSync(join(result.runDir, "final/retained-output.md"), "utf8");
  expect(retained).toContain(answer);
  expect(retained).toContain(`attempts/a01/produced/${produced[0]}`);
});
