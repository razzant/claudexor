import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { BudgetLedger } from "@claudexor/budget";
import { EventLog } from "@claudexor/event-log";
import type { HarnessAdapter } from "@claudexor/core";
import { verifyAndDeliverFiles } from "@claudexor/delivery";
import { createFakeHarness } from "@claudexor/harness-fake";
import { type ReviewerSpec } from "@claudexor/review";
import {
  ConformanceReport,
  HarnessManifest,
  RunFailure,
  WorkProduct,
  WorkspaceFilesManifest,
  type HarnessRunSpec,
} from "@claudexor/schema";
import {
  WorkspaceManager,
  holdsRetainedSources,
  releaseRetainedEnvelope,
  retainedEnvelopeOfRun,
  retainedSourcesOfRun,
} from "@claudexor/workspace";
import { createAttemptTelemetry } from "./attemptTelemetry.js";
import type { CandidateRun } from "./candidateEvidence.js";
import { failAfterCandidates, failedCandidatesResult } from "./candidateTerminals.js";
import { candidateFailureTerminal } from "./delegationFailure.js";
import { Orchestrator, type OrchestratorResult } from "./orchestrator.js";

// #563: the D-16d one-shot continuation reruns in the exhausted candidate's own
// copy. When its final capture refuses, that copy is kept, while the exhausted
// original still leads the run (the continuation did not supersede it). The
// kept copy's exact receipt must reach the run's real readers, under the
// continuation's own attempt id: its completion event, the summary, the failure
// record and the next actions. Model-free: fake harnesses, real filesystem faults.
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const posix = process.platform !== "win32";
const asRoot = process.getuid?.() === 0;
/** The orchestrator's packet line a continuation turn's prompt carries. */
const CONTINUATION = "one-shot continuation after context exhaustion";
const KEPT_NO_EXACT =
  "Decide on those changes yourself: Claudexor kept no exact result to apply or revert";

function project() {
  const root = mkdtempSync(join(tmpdir(), "cx-cont-refusal-"));
  dirs.push(root);
  writeFileSync(join(root, "input.txt"), "selected source\n");
  writeFileSync(join(root, "unselected.txt"), "unselected sibling\n");
  return root;
}

const exhausted = {
  kind: "capacity_exhausted",
  cause: "repeated_refill",
  native_code: "rapid_refill_breaker",
  trigger: "auto",
  pre_tokens: 190000,
};

type Turn = (spec: HarnessRunSpec) => void;

/** An author whose first turn writes partial output and exhausts its context.
 * The continuation turn then does `continuation` and finishes (or crashes). */
function author(
  id: string,
  continuation: Turn,
  finish: "final" | "report" | "crash" = "final",
): HarnessAdapter {
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
      const session = { ts, session_id: spec.session_id };
      yield { type: "started", ...session };
      if (!spec.prompt.includes(CONTINUATION)) {
        writeFileSync(join(spec.cwd, "out.txt"), "partial output\n");
        yield { type: "file_change", ...session, payload: { path: "out.txt" } };
        yield { type: "message", ...session, text: "Partial progress." };
        yield { type: "context", ...session, context: exhausted } as never;
        yield { type: "completed", ...session };
        return;
      }
      continuation(spec);
      yield { type: "file_change", ...session, payload: { path: "continued.txt" } };
      if (finish === "crash") yield { type: "error", ...session, error: "continuation crashed" };
      else
        yield {
          type: "message",
          ...session,
          text:
            finish === "report"
              ? JSON.stringify({
                  work_report: { state: "completed", required_inputs: [] },
                  output: "Completed after a one-shot continuation.",
                })
              : "Continued.",
          final: true,
          payload: { final_source: "fake" },
        };
      yield { type: "completed", ...session };
    },
  };
}

/** Good output plus a FIFO: the continuation's final capture refuses. */
const leavesFifo: Turn = (spec) => {
  writeFileSync(join(spec.cwd, "continued.txt"), "continued output\n");
  execFileSync("mkfifo", [join(spec.cwd, "pipe")]);
};
const leavesGoodOutput: Turn = (spec) => {
  writeFileSync(join(spec.cwd, "continued.txt"), "continued output\n");
};

/** An ordinary sibling with no context trouble. */
function plain(id: string, act: Turn): HarnessAdapter {
  const base = author(id, () => undefined);
  return {
    ...base,
    async *run(spec) {
      const ts = new Date().toISOString();
      const session = { ts, session_id: spec.session_id };
      yield { type: "started", ...session };
      act(spec);
      yield { type: "file_change", ...session, payload: { path: "out.txt" } };
      yield { type: "message", ...session, text: "Prepared.", final: true };
      yield { type: "completed", ...session };
    },
  };
}

function reviewer(
  id: string,
  providerFamily: "openai" | "anthropic",
  findings: unknown[] = [],
): ReviewerSpec {
  return {
    providerFamily,
    requestedModel: `${id}-model`,
    adapter: {
      id,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: providerFamily,
          access_profiles_supported: ["readonly"],
          capabilities: { review: true, known_models: [`${id}-model`] },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        const route = { credential_route: "managed_api_key" as const };
        yield {
          type: "started",
          ts,
          session_id: spec.session_id,
          observed_model: `${id}-model`,
          ...route,
        };
        yield {
          type: "message",
          ts,
          session_id: spec.session_id,
          text: `\`\`\`json\n${JSON.stringify(findings)}\n\`\`\``,
        };
        yield {
          type: "usage",
          ts,
          session_id: spec.session_id,
          ...route,
          usage: { cost_usd: 0.001 },
        };
        yield { type: "completed", ts, session_id: spec.session_id };
      },
    },
  };
}

async function single(root: string, adapter: HarnessAdapter, extra = {}) {
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

async function race(
  root: string,
  adapters: HarnessAdapter[],
  extra = {},
  findings: unknown[] = [],
) {
  return new Orchestrator({
    registry: new Map(adapters.map((adapter) => [adapter.id, adapter])),
    reviewers: [
      reviewer("review-a", "openai", findings),
      reviewer("review-b", "anthropic", findings),
    ],
  }).run({
    repoRoot: root,
    prompt: "Create the output",
    harnesses: adapters.map((adapter) => adapter.id),
    n: adapters.length,
    workspaceKind: "directory",
    scopePaths: ["input.txt"],
    review: true,
    ...extra,
  });
}

function refusalOf(result: OrchestratorResult, attemptId: string) {
  const attempt = new ArtifactStore(result.runDir).readYaml<{
    capture_refusal?: {
      disposition: string;
      detail: string;
      sourceRoot?: string;
      failure?: { message: string };
    };
  }>(join(result.runDir, "attempts", attemptId, "attempt.yaml"));
  return attempt?.capture_refusal;
}

function events(runDir: string): Array<{ type: string; payload: Record<string, unknown> }> {
  return readFileSync(join(runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

const completion = (result: OrchestratorResult, attemptId: string) =>
  events(result.runDir).find(
    (event) => event.type === "harness.completed" && event.payload["attempt_id"] === attemptId,
  )?.payload;

const failureOf = (result: OrchestratorResult) =>
  RunFailure.parse(
    new ArtifactStore(result.runDir).readYaml(join(result.runDir, "final/failure.yaml")),
  );

const summaryOf = (result: OrchestratorResult) =>
  readFileSync(join(result.runDir, "final/summary.md"), "utf8");

const decisionOf = (result: OrchestratorResult) =>
  new ArtifactStore(result.runDir).readYaml<{ why_winner: string; evidence_facts: string[] }>(
    join(result.runDir, "arbitration/decision.yaml"),
  );

describe.skipIf(!posix || asRoot)(
  "a one-shot continuation whose final capture refuses keeps the copy and says so",
  () => {
    it("single candidate: the interruption leads, and every reader names the kept copy", async () => {
      const root = project();
      const result = await single(root, author("exhausted", leavesFifo));

      // The exhausted original still leads; the failed continuation never supersedes it.
      expect(result.facts).toMatchObject({
        lifecycle: "interrupted",
        reason: "context_capacity_exhausted",
      });
      const refusal = refusalOf(result, "a01c")!;
      expect(refusal).toMatchObject({ disposition: "retained" });
      const tree = refusal.sourceRoot!;
      expect(refusal.failure!.message).toBe(`Unsupported filesystem entry: ${join(tree, "pipe")}`);

      // Its completion event.
      expect(completion(result, "a01c")).toMatchObject({ status: "failed", error: refusal.detail });

      // The summary, the failure record, the decision and the terminal event.
      const receipt = `its continuation a01c: ${refusal.detail}`;
      const failure = failureOf(result);
      expect(failure.attemptId).toBe("a01");
      expect(failure.safeMessage).toContain("context capacity exhausted");
      expect(failure.safeMessage).toContain(receipt);
      expect(summaryOf(result)).toContain(receipt);
      // The earlier exact capture is evidence, not permission to apply an interrupted run.
      const savedFiles = readFileSync(join(result.runDir, "final/files/result.md"), "utf8");
      expect(savedFiles).toContain(
        "application is subject to the run's outcome and a delivery check",
      );
      expect(savedFiles).not.toContain("ready to inspect and apply");
      expect(decisionOf(result)?.why_winner).toContain(receipt);
      expect(decisionOf(result)?.evidence_facts).toContain(
        `a01c capture incomplete: ${refusal.detail}`,
      );
      const failed = events(result.runDir).find((event) => event.type === "run.failed");
      expect(String(failed?.payload["error"])).toContain(receipt);
      expect(failure.captureFailure?.message).toBe(refusal.failure!.message);

      // The next actions: the interruption's remedy, then the kept copy.
      expect(failure.nextActions).toContain(`Inspect the changed files at ${tree}`);
      expect(failure.nextActions).toContain(KEPT_NO_EXACT);
      expect(failure.nextActions).toContain("Retry the run");
      expect(failure.nextActions.indexOf("Retry the run")).toBeLessThan(
        failure.nextActions.indexOf(`Inspect the changed files at ${tree}`),
      );

      // A later edit in that copy is unknown, whatever the first capture saw.
      expect(result.facts.noChanges).toBeNull();

      // The copy really is kept: exact bytes, inspection custody, owned by discard.
      expect(readFileSync(join(tree, "continued.txt"), "utf8")).toBe("continued output\n");
      expect(readFileSync(join(tree, "out.txt"), "utf8")).toBe("partial output\n");
      const sources = retainedSourcesOfRun(result.runDir, result.runId);
      expect(sources.map((source) => source.envelope.attempt_id)).toEqual(["a01"]);
      expect(sources[0]!.continuation_eligible).toBe(false);
      expect(retainedEnvelopeOfRun(result.runDir, result.runId)).toBeNull();
      await new WorkspaceManager(root).disposeOrphan(
        sources[0]!.envelope.task_id,
        sources[0]!.envelope.attempt_id,
      );
      expect(existsSync(join(tree, "continued.txt"))).toBe(true);
      expect(holdsRetainedSources(result.runDir, result.runId, () => undefined)).toBe(true);
      await releaseRetainedEnvelope(sources[0]!);
      expect(existsSync(tree)).toBe(false);

      // Nothing reached the original folder.
      expect(existsSync(join(root, "out.txt"))).toBe(false);
      expect(existsSync(join(root, "continued.txt"))).toBe(false);
      expect(readFileSync(join(root, "input.txt"), "utf8")).toBe("selected source\n");
    });

    it.each([
      ["address", "(not applied), recorded in durable custody; its address in this run"],
      ["custody", ", held by this process only (durable retention could not be recorded)."],
    ] as const)(
      "single candidate, %s write failed: the receipt keeps that stage",
      async (stage, text) => {
        const root = project();
        const runsDir = new ArtifactStore(root).runsDir();
        const result = await single(
          root,
          author("exhausted", (spec) => {
            leavesFifo(spec);
            const base = dirname(spec.cwd);
            const [runDir] = readdirSync(runsDir).map((name) => join(runsDir, name));
            const blocked =
              stage === "address"
                ? join(runDir!, "attempts", basename(base), "retained-envelope.json")
                : join(base, "continuation-custody.json");
            mkdirSync(join(blocked, "occupied"), { recursive: true });
          }),
        );
        expect(result.facts).toMatchObject({
          lifecycle: "interrupted",
          reason: "context_capacity_exhausted",
        });
        const refusal = refusalOf(result, "a01c")!;
        expect(refusal).toMatchObject({ disposition: "manual_cleanup" });
        expect(refusal.detail).toContain(text);
        const failure = failureOf(result);
        expect(failure.safeMessage).toContain(refusal.detail);
        expect(failure.nextActions).toContain(`Inspect the changed files at ${refusal.sourceRoot}`);
        expect(readFileSync(join(refusal.sourceRoot!, "continued.txt"), "utf8")).toBe(
          "continued output\n",
        );
      },
    );

    it("best-of: a healthy sibling still wins and applies, the receipt reaches its summary", async () => {
      const root = project();
      const healthy = plain("healthy", (spec) =>
        writeFileSync(join(spec.cwd, "out.txt"), "healthy output\n"),
      );
      const result = await race(root, [author("exhausted", leavesFifo), healthy]);

      expect(result.facts).toMatchObject({ lifecycle: "succeeded", review: "approved" });
      expect(result.winner).toBe("a02");
      expect(existsSync(join(result.runDir, "final/failure.yaml"))).toBe(false);
      const refusal = refusalOf(result, "a01c")!;
      expect(completion(result, "a01c")).toMatchObject({ status: "failed", error: refusal.detail });
      expect(summaryOf(result)).toContain(
        `- Excluded Candidate A's continuation (a01c, exhausted): ${refusal.detail}`,
      );
      expect(readFileSync(join(refusal.sourceRoot!, "continued.txt"), "utf8")).toBe(
        "continued output\n",
      );
      expect(existsSync(join(root, "out.txt"))).toBe(false);
      const product = WorkProduct.parse(
        new ArtifactStore(root).readYaml(join(result.runDir, "final/work_product.yaml")),
      );
      expect(product.producer_attempt_id).toBe("a02");
      const text = readFileSync(join(result.runDir, product.files.manifest!), "utf8");
      expect(
        await verifyAndDeliverFiles(root, {
          manifest: WorkspaceFilesManifest.parse(JSON.parse(text)),
          manifestSha256: String(product.meta.manifest_sha256),
          artifactRoot: result.runDir,
        }),
      ).toMatchObject({ applied: true });
      expect(readFileSync(join(root, "out.txt"), "utf8")).toBe("healthy output\n");
      expect(existsSync(join(root, "continued.txt"))).toBe(false);
    });

    it.each([
      {
        name: "blocked by its review",
        extra: {},
        findings: [
          {
            severity: "BLOCK",
            category: "correctness",
            claim: "off-by-one in the output",
            evidence: { files: [{ path: "out.txt", lines: "1" }] },
            proposed_fix: "fix the output",
          },
        ],
        lead: "Review the blocking findings on the run's turn",
        facts: { lifecycle: "succeeded", review: "blocked" },
      },
      {
        name: "stopped by final verification",
        extra: { tests: [{ program: "sh", args: ["-c", "false"], envAllowlist: [] as string[] }] },
        findings: [],
        lead: "Inspect arbitration/decision.yaml (final_verify)",
        facts: { lifecycle: "succeeded", checks: "failed" },
      },
    ])(
      "best-of, the winner $name: its own remedy leads, the kept copy follows",
      async ({ extra, findings, lead, facts }) => {
        const root = project();
        const healthy = plain("healthy", (spec) =>
          writeFileSync(join(spec.cwd, "out.txt"), "healthy output\n"),
        );
        const result = await race(
          root,
          [author("exhausted", leavesFifo), healthy],
          extra,
          findings,
        );
        expect(result.facts).toMatchObject(facts);
        expect(result.winner).toBe("a02");
        const refusal = refusalOf(result, "a01c")!;
        const failure = failureOf(result);
        expect(failure.nextActions[0]).toBe(lead);
        expect(failure.nextActions.at(-1)).toBe(
          `Inspect the changed files at ${refusal.sourceRoot}`,
        );
        expect(failure.nextActions).not.toContain(KEPT_NO_EXACT);
        expect(summaryOf(result)).toContain(refusal.detail);
      },
    );

    it.each([
      ["the exhausted candidate first", ["exhausted", "refused"]],
      ["the refused candidate first", ["refused", "exhausted"]],
    ] as const)("all failed, %s: both kept copies are named", async (_order, order) => {
      const root = project();
      const adapters = {
        exhausted: author("exhausted", leavesFifo),
        refused: plain("refused", (spec) => {
          writeFileSync(join(spec.cwd, "out.txt"), "refused output\n");
          execFileSync("mkfifo", [join(spec.cwd, "pipe")]);
        }),
      };
      const result = await race(
        root,
        order.map((id) => adapters[id]),
      );
      const exhaustedAttempt = order[0] === "exhausted" ? "a01" : "a02";
      const refusedAttempt = order[0] === "exhausted" ? "a02" : "a01";
      expect(result.facts).toMatchObject({
        lifecycle: "interrupted",
        reason: "context_capacity_exhausted",
      });
      expect(result.winner).toBeNull();
      const continued = refusalOf(result, `${exhaustedAttempt}c`)!;
      const refused = refusalOf(result, refusedAttempt)!;
      const failure = failureOf(result);
      expect(failure.safeMessage).toContain(
        `its continuation ${exhaustedAttempt}c: ${continued.detail}`,
      );
      expect(failure.safeMessage).toContain(refused.detail);
      expect(failure.nextActions).toContain(`Inspect the changed files at ${continued.sourceRoot}`);
      expect(failure.nextActions).toContain(`Inspect the changed files at ${refused.sourceRoot}`);
      expect(retainedSourcesOfRun(result.runDir, result.runId)).toHaveLength(2);
      expect(existsSync(join(root, "out.txt"))).toBe(false);
    });

    it("cancelled during the continuation: the cancel leads, its event still names the copy", async () => {
      const root = project();
      const controller = new AbortController();
      const result = await single(
        root,
        author("exhausted", (spec) => {
          leavesFifo(spec);
          controller.abort();
        }),
        { signal: controller.signal },
      );
      expect(result.lifecycle).toBe("cancelled");
      const refusal = refusalOf(result, "a01c")!;
      expect(completion(result, "a01c")).toMatchObject({
        status: "cancelled",
        error: refusal.detail,
      });
      expect(readFileSync(join(refusal.sourceRoot!, "continued.txt"), "utf8")).toBe(
        "continued output\n",
      );
      // A race cancellation writes no failure record (the capture contract).
      expect(existsSync(join(result.runDir, "final/failure.yaml"))).toBe(false);
      // The published first capture is exact for its attempt, but the run's
      // changes are unknown: that copy changed after it.
      const product = WorkProduct.parse(
        new ArtifactStore(root).readYaml(join(result.runDir, "final/work_product.yaml")),
      );
      expect(product.producer_attempt_id).toBe("a01");
      expect(product.meta.no_changes).toBe(false);
      expect(product.meta.outcome_facts).toMatchObject({ noChanges: null });
    });
  },
);

describe("a continuation that does not refuse its capture (unchanged)", () => {
  it("one-shot success: the continuation wins, no receipt and nothing kept", async () => {
    const root = project();
    const result = await single(root, author("exhausted", leavesGoodOutput, "report"));
    expect(result.facts.lifecycle).toBe("succeeded");
    expect(result.winner).toBe("a01c");
    expect(retainedSourcesOfRun(result.runDir, result.runId)).toEqual([]);
    expect(completion(result, "a01c")).toMatchObject({ status: "success" });
    expect(completion(result, "a01c")).not.toHaveProperty("error");
    expect(summaryOf(result)).not.toContain("continuation");
    const product = WorkProduct.parse(
      new ArtifactStore(root).readYaml(join(result.runDir, "final/work_product.yaml")),
    );
    const manifest = WorkspaceFilesManifest.parse(
      JSON.parse(readFileSync(join(result.runDir, product.files.manifest!), "utf8")),
    );
    expect(manifest.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["continued.txt", "out.txt"]),
    );
  });

  it("a crashed continuation with a clean capture: the interruption alone leads, nothing kept", async () => {
    const root = project();
    const result = await single(root, author("exhausted", leavesGoodOutput, "crash"));
    expect(result.facts).toMatchObject({
      lifecycle: "interrupted",
      reason: "context_capacity_exhausted",
    });
    expect(refusalOf(result, "a01c")).toBeUndefined();
    expect(retainedSourcesOfRun(result.runDir, result.runId)).toEqual([]);
    const failure = failureOf(result);
    expect(failure.captureFailure).toBeUndefined();
    expect(failure.safeMessage).not.toContain("its continuation");
    expect(failure.nextActions.join("\n")).not.toContain("Inspect the changed files");
  }, 20_000);

  it("a Git candidate's refused continuation reads the same, and still never adopts", async () => {
    const root = project();
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", root, "config", "user.name", "t"]);
    execFileSync("git", ["-C", root, "add", "-A"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "init"]);
    let refuse = false;
    const actual = WorkspaceManager.prototype.captureDiff;
    vi.spyOn(WorkspaceManager.prototype, "captureDiff").mockImplementation(function (
      this: WorkspaceManager,
      ...args
    ) {
      if (refuse)
        return Promise.reject(
          Object.assign(new Error("EIO: i/o error, read 'continued.txt'"), { code: "EIO" }),
        );
      return actual.apply(this, args);
    });
    const adapter = author("exhausted", (spec) => {
      leavesGoodOutput(spec);
      refuse = true;
    });
    const result = await new Orchestrator({ registry: new Map([[adapter.id, adapter]]) }).run({
      repoRoot: root,
      prompt: "Create the output",
      harnesses: [adapter.id],
      review: false,
    });
    expect(result.facts).toMatchObject({
      lifecycle: "interrupted",
      reason: "context_capacity_exhausted",
    });
    const refusal = refusalOf(result, "a01c")!;
    expect(refusal).toMatchObject({ disposition: "retained" });
    expect(completion(result, "a01c")).toMatchObject({ status: "failed", error: refusal.detail });
    const failure = failureOf(result);
    expect(failure.safeMessage).toContain(`its continuation a01c: ${refusal.detail}`);
    expect(failure.nextActions).toContain(`Inspect the changed files at ${refusal.sourceRoot}`);
    expect(existsSync(join(result.runDir, "final/work_product.yaml"))).toBe(false);
    expect(existsSync(join(root, "continued.txt"))).toBe(false);
  });
});

// The other terminals that can lead beside a kept copy: its facts and inspection
// action follow the leading cause and its own remedy, unchanged.
describe("terminal owners with a kept continuation copy", () => {
  const refusal = {
    disposition: "retained" as const,
    phase: "artifact_security" as const,
    sourceRoot: "/runtime/workspaces/task/a01/tree",
    detail:
      "Directory output capture failed … Kept: the isolated copy at /runtime/workspaces/task/a01/tree (not applied).",
    failure: { code: "capture_failed" as const, message: "Unsupported filesystem entry: pipe" },
  };
  const INSPECT = `Inspect the changed files at ${refusal.sourceRoot}`;
  const candidate = (attemptId: string, extra: Partial<CandidateRun> = {}): CandidateRun => ({
    attemptId,
    harnessId: `h-${attemptId}`,
    label: `Candidate ${attemptId}`,
    diff: "",
    gates: [],
    cost: 0,
    errored: true,
    costEstimated: false,
    errors: ["attempt failed"],
    telemetry: createAttemptTelemetry("auto", false),
    ...extra,
  });
  const interrupted = candidate("a01", {
    errored: false,
    errors: [],
    outcomeClass: "interrupted",
    continuationRefusal: { attemptId: "a01c", refusal },
  });
  function context() {
    const root = mkdtempSync(join(tmpdir(), "cx-cont-owner-"));
    dirs.push(root);
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-owner");
    const log = new EventLog(paths.eventsPath, "run-owner", "task-owner");
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    return {
      store,
      paths,
      log,
      ledger,
      runId: "run-owner",
      taskId: "task-owner",
      mode: "agent" as const,
      writeTelemetry: () => undefined,
    };
  }
  const failure = (input: ReturnType<typeof context>) =>
    RunFailure.parse(input.store.readYaml(join(input.paths.finalDir, "failure.yaml")));

  it("a Delegate failure leads; a sibling's kept copy follows its remedy", () => {
    const telemetry = createAttemptTelemetry("auto", false);
    telemetry.delegationBelt.requested = true;
    telemetry.delegationBelt.failed = true;
    const belt = candidate("a02", { telemetry });
    const terminal = candidateFailureTerminal(belt, "race", [interrupted, belt]);
    expect(terminal.phase).toBe("delegation_startup");
    expect(terminal.metadata).toMatchObject({
      captureFailure: refusal.failure,
      followUps: [INSPECT],
    });
    // Without a sibling's copy the record is what it was.
    expect(candidateFailureTerminal(belt, "convergence").metadata).toMatchObject({
      captureFailure: undefined,
      followUps: [],
    });
  });

  it("a candidate's own refusal still leads; a continuation's copy follows", () => {
    const own = { ...refusal, sourceRoot: "/runtime/own/tree", detail: "own refusal" };
    const refused = candidate("a02", { captureRefusal: own });
    const terminal = candidateFailureTerminal(refused, "race", [interrupted, refused]);
    expect(terminal.metadata.captureFailure).toBe(own.failure);
    expect(terminal.metadata.nextActions[0]).toBe("Inspect the changed files at /runtime/own/tree");
    expect(terminal.metadata.followUps).toEqual([INSPECT]);
  });

  it("a review or arbitration failure keeps its cause and its remedy, then names the copy", () => {
    const input = context();
    failAfterCandidates({ ...input, runs: [interrupted] }, "review", new Error("panel crashed"));
    expect(failure(input)).toMatchObject({
      phase: "review",
      safeMessage: "panel crashed",
      captureFailure: refusal.failure,
    });
    expect(failure(input).nextActions).toEqual(["Open diagnostics", "Retry the run", INSPECT]);
  });

  it("a budget denial leads; the copy follows its remedy", async () => {
    const input = context();
    await failedCandidatesResult({
      ...input,
      runs: [interrupted],
      budgetDenial: {
        code: "hard_cap",
        reason: "budget hard cap reached",
        harnessId: "h-a01",
        attemptId: "a01",
      },
    });
    const record = failure(input);
    expect(record.phase).toBe("budget");
    expect(record.nextActions.at(-1)).toBe(INSPECT);
    expect(record.nextActions).not.toContain(
      "Decide on those changes yourself: Claudexor kept no exact result to apply or revert",
    );
  });
});
