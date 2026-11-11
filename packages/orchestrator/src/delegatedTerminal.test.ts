import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactStore } from "@claudexor/artifact-store";
import {
  DelegatedEvidenceIncompleteError,
  DelegatedHomeUnavailableError,
  type HarnessAdapter,
} from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import type { ReviewerSpec } from "@claudexor/review";
import {
  ConformanceReport,
  HarnessManifest,
  RunFailure,
  RunFailureCode,
  type ProviderFamily,
} from "@claudexor/schema";
import { WorkspaceManager } from "@claudexor/workspace";
import type { ScopedHarnessHome } from "./delegatedHome.js";
import { Orchestrator, type RunInput } from "./orchestrator.js";
import { declaredFailure } from "./runTerminalResults.js";
describe("delegated evidence refusals and historical codes survive as typed terminals", () => {
  it("keeps the code and category a delegated refusal declared", () => {
    // These travel as exceptions from deep inside the attempt loop. Before they
    // were listed in RunFailureCode, `declaredFailure` validated them away and
    // the terminal said `code: null` — less than the thrower knew.
    expect(declaredFailure(new DelegatedHomeUnavailableError("no scoped home"))).toEqual({
      category: "internal",
      code: "delegated_home_unavailable",
      resetsAt: null,
    });
    expect(declaredFailure(new DelegatedEvidenceIncompleteError("unauditable"))).toEqual({
      category: "internal",
      code: "delegated_evidence_incomplete",
      resetsAt: null,
    });
  });

  it("keeps delegated_confinement_unavailable as a decoder-only historical code", () => {
    expect(RunFailureCode.parse("delegated_confinement_unavailable")).toBe(
      "delegated_confinement_unavailable",
    );
  });
});

// #648: a delegated mutating attempt that failed while it was being prepared,
// before its HOME was decided, started no child. Its own failure is the run's
// (a race sibling still runs); the evidence gate keeps refusing an attempt
// whose adapter did run without stating what it ran under. The real
// Orchestrator, envelopes and gate; only the failing preparation step and the
// stand-in harness are fixtures.
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function repo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `cx-delegated-terminal-${prefix}-`));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "file.txt"), "before\n");
  git("add", ".");
  git("-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "-qm", "base");
  return root;
}

/** Edits its workspace and succeeds; records the envelope (attempt) it ran in. */
function editing(ran: string[]): HarnessAdapter {
  return {
    ...createFakeHarness("fake-success"),
    async *run(spec) {
      ran.push(basename(dirname(spec.cwd)));
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      writeFileSync(join(spec.cwd, "file.txt"), "after\n");
      yield { ...common, type: "message", text: "Done.", final: true };
      yield { ...common, type: "completed" };
    },
  };
}

/** A reviewer whose clean verdict is verified (observed model on a paid route). */
function approving(id: string, providerFamily: ProviderFamily): ReviewerSpec {
  const model = `${id}-model`;
  return {
    providerFamily,
    requestedModel: model,
    adapter: {
      id,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: providerFamily,
          access_profiles_supported: ["readonly"],
          capabilities: { review: true, read_files: true, known_models: [model] },
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
        const base = { session_id: spec.session_id, ts: new Date().toISOString() };
        const route = { credential_route: "managed_api_key" as const };
        yield { ...base, ...route, type: "started", observed_model: model };
        yield { ...base, type: "message", text: "```json\n[]\n```" };
        yield { ...base, ...route, type: "usage", usage: { cost_usd: 0.001 } };
        yield { ...base, type: "completed" };
      },
    },
  };
}

async function delegatedRun(
  ran: string[],
  input: Partial<RunInput> = {},
  reviewers: ReviewerSpec[] = [],
) {
  const result = await new Orchestrator({
    registry: new Map([["fake-success", editing(ran)]]),
    reviewers,
  }).run({
    repoRoot: repo("project"),
    executionRoot: repo("exec"),
    delegated: true,
    mode: "agent",
    prompt: "edit",
    harnesses: ["fake-success"],
    n: 1,
    review: false,
    ...input,
  });
  const store = new ArtifactStore(result.runDir);
  return {
    result,
    failure: () => RunFailure.parse(store.readYaml(join(result.runDir, "final", "failure.yaml"))),
    attempt: (id: string) =>
      store.readYaml<Record<string, unknown>>(join(result.runDir, "attempts", id, "attempt.yaml"))!,
  };
}

type HomeFor = (...args: [unknown, { attempt_id: string }, ...unknown[]]) => ScopedHarnessHome;
const homes = Orchestrator.prototype as unknown as { harnessHomeFor: HomeFor };

/** The real HOME decision, except that `refuse` decides one attempt's preparation fails. */
function homeDecision(refuse: (attemptId: string, call: number) => boolean, decided?: HomeFor) {
  const original = homes.harnessHomeFor;
  let calls = 0;
  return vi.spyOn(homes, "harnessHomeFor").mockImplementation(function (this: unknown, ...args) {
    calls += 1;
    if (refuse(args[1].attempt_id, calls))
      throw new DelegatedHomeUnavailableError(
        `delegated run cannot start: the scoped harness home for attempt ${args[1].attempt_id} is missing (fixture)`,
      );
    return (decided ?? original).apply(this, args);
  });
}

describe("a delegated attempt that failed before its HOME keeps its own failure (#648)", () => {
  it("race: its typed refusal is the terminal, its adapter never ran, and its record keeps the gap", async () => {
    homeDecision((attemptId) => attemptId === "a01");
    const ran: string[] = [];
    const o = await delegatedRun(ran);
    expect(ran).toEqual([]);
    expect(o.result.lifecycle).toBe("failed");
    expect(o.failure()).toMatchObject({
      category: "internal",
      code: "delegated_home_unavailable",
      attemptId: "a01",
      safeMessage: expect.stringContaining("the scoped harness home for attempt a01 is missing"),
    });
    const applied = o.attempt("a01");
    expect(applied).not.toHaveProperty("harness_home_isolated");
    expect(applied).toMatchObject({ harness_home_dir: null, confinement_unavailable_reason: null });
  });

  it("race: an untyped workspace preparation failure is the terminal, not the evidence gate", async () => {
    const create = WorkspaceManager.prototype.create;
    vi.spyOn(WorkspaceManager.prototype, "create").mockImplementation(function (
      this: WorkspaceManager,
      ...args: Parameters<WorkspaceManager["create"]>
    ) {
      if (args[0].attemptId === "a01") throw new Error("fixture: workspace preparation failed");
      return create.apply(this, args);
    });
    const ran: string[] = [];
    const o = await delegatedRun(ran);
    expect(ran).toEqual([]);
    expect(o.result.lifecycle).toBe("failed");
    expect(o.failure()).toMatchObject({
      phase: "workspace",
      code: null,
      safeMessage: expect.stringContaining(
        "a01/fake-success: fixture: workspace preparation failed",
      ),
    });
  });

  it("race: a healthy sibling still runs and wins", async () => {
    homeDecision((attemptId) => attemptId === "a01");
    const ran: string[] = [];
    // Best-of requests review: a verified clean review lets the healthy winner stand.
    const o = await delegatedRun(ran, { n: 2, review: true, synthesis: "never" }, [
      approving("rev-o", "openai"),
      approving("rev-g", "google"),
    ]);
    expect(ran).toEqual(["a02"]);
    expect(o.result.lifecycle).toBe("succeeded");
    expect(o.result.winner).toBe("a02");
    expect(o.result.candidates).toEqual([
      { attemptId: "a01", harnessId: "fake-success", status: "red" },
      { attemptId: "a02", harnessId: "fake-success", status: "green" },
    ]);
    expect(o.attempt("a01")).not.toHaveProperty("harness_home_isolated");
  });

  it("race: an attempt whose adapter ran without stating its boundary is still refused", async () => {
    const original = homes.harnessHomeFor;
    homeDecision(
      () => false,
      function (this: unknown, ...args) {
        // A decided HOME whose deliberate no-boundary disclosure is missing.
        return { ...original.apply(this, args), outerBoundaryUnavailableReason: null };
      },
    );
    const ran: string[] = [];
    const o = await delegatedRun(ran);
    expect(ran).toEqual(["a01"]);
    expect(o.result.lifecycle).toBe("failed");
    expect(o.failure()).toMatchObject({ code: "delegated_evidence_incomplete", phase: "race" });
  });

  it("convergence: the refusal ends the run as itself, with no further round", async () => {
    homeDecision((_attemptId, call) => call === 1);
    const ran: string[] = [];
    const o = await delegatedRun(ran, { n: undefined, attempts: 2 });
    expect(ran).toEqual([]);
    expect(o.result.lifecycle).toBe("failed");
    expect(o.failure()).toMatchObject({
      phase: "convergence",
      code: "delegated_home_unavailable",
      safeMessage: expect.stringContaining(
        "the scoped harness home for attempt converge is missing",
      ),
    });
    expect(o.attempt("a01")).not.toHaveProperty("harness_home_isolated");
    expect(existsSync(join(o.result.runDir, "attempts", "a02"))).toBe(false);
  });
});
