import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { repoHash } from "@claudexor/config";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { BudgetLedger } from "@claudexor/budget";
import { EventLog } from "@claudexor/event-log";

const shellGate = (command: string) => ({
  program: "sh",
  args: ["-c", command],
  envAllowlist: [] as string[],
});

import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import { runCapture, spawnProcess } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import type {
  AccessProfile,
  ControlReviewerPanelEntry,
  HarnessEvent,
  HarnessRunSpec,
  ProviderFamily,
} from "@claudexor/schema";
import { ConformanceReport, HarnessManifest, RunFacts, makeOutcomeFacts } from "@claudexor/schema";
import { hashJson, noProjectRepoRoot, projectRuntimeDir, sha256 } from "@claudexor/util";
import { writeEvidencePacket } from "@claudexor/context";
import type { ReviewerSpec } from "@claudexor/review";
import { Orchestrator } from "./orchestrator.js";
import type { OrchestratorResult } from "./orchestrator.js";
import { DelegationBudgetAuthority } from "./delegationBudgetAuthority.js";
import { withPlanBrief } from "./planBrief.js";
import { buildRevisePrompt } from "./revisePrompt.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

/**
 * Project a run's D8 axes (lifecycle + facts) back to the LEGACY status word
 * these assertions were written against — the v8-design mapping table applied
 * mechanically. Keeps the existing behavioral coverage intact while the run
 * result speaks the axes vocabulary. New tests should assert `.facts` directly.
 */
function legacyOutcome(r: OrchestratorResult): string {
  const f = r.facts;
  if (r.lifecycle === "cancelled") return "cancelled";
  if (r.lifecycle === "interrupted") return "interrupted_unknown";
  if (r.lifecycle === "failed") {
    const byReason: Record<string, string> = {
      budget_exhausted: "exhausted",
      budget_overshoot: "exhausted_overshoot",
      cost_unverifiable: "cost_unverifiable",
      not_converged: "not_converged",
      stuck_no_progress: "stuck_no_progress",
    };
    return f.reason && byReason[f.reason] ? byReason[f.reason] : "failed";
  }
  // succeeded lifecycle: only a needs-decision block (review blocked / checks
  // failed) is distinct; every other clean succeeded terminal (verified
  // success, empty-diff no_op, or a not-verified read-only/plan run) reads as
  // the legacy "success" these behavioral assertions were written against.
  // Tests that must distinguish no_changes / not-verified assert `.facts`.
  if (f.review === "blocked" || f.checks === "failed") return "blocked";
  return "success";
}

function readRunFacts(repo: string, result: OrchestratorResult): RunFacts {
  return RunFacts.parse(
    new ArtifactStore(repo).readYaml(join(result.runDir, "final", "run_facts.yaml")),
  );
}

async function initRepo(): Promise<string> {
  const repo = reapMk(join(tmpdir(), "claudexor-orch-"));
  await runCapture("git", ["-C", repo, "init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  await runCapture("git", ["-C", repo, "add", "-A"]);
  await runCapture("git", [
    "-C",
    repo,
    "-c",
    "user.email=t@t.dev",
    "-c",
    "user.name=t",
    "commit",
    "-m",
    "init",
  ]);
  return repo;
}

/** Authorize an explicitly requested Full fixture without touching real trust state. */
function grantFullAccess(repo: string): void {
  const configDir = process.env.CLAUDEXOR_CONFIG_DIR;
  if (!configDir) throw new Error("test requires a scoped CLAUDEXOR_CONFIG_DIR");
  mkdirSync(join(configDir, "trust"), { recursive: true });
  writeFileSync(join(configDir, "trust", `${repoHash(repo)}.yaml`), "allow_full_access: true\n");
}

function setAccessDefault(repo: string, access: AccessProfile): void {
  const configDir = process.env.CLAUDEXOR_CONFIG_DIR;
  if (!configDir) throw new Error("test requires a scoped CLAUDEXOR_CONFIG_DIR");
  mkdirSync(join(configDir, "trust"), { recursive: true });
  writeFileSync(
    join(configDir, "trust", `${repoHash(repo)}.yaml`),
    `access_default: ${access}\nallow_full_access: false\n`,
  );
}

function treeContainsBytes(root: string, needle: string): boolean {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (treeContainsBytes(path, needle)) return true;
    } else if (entry.isFile() && readFileSync(path).includes(needle)) {
      return true;
    }
  }
  return false;
}

function gitObjectStoreContains(repo: string, needle: string): boolean {
  const rows = execFileSync(
    "git",
    ["-C", repo, "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
    { encoding: "utf8" },
  );
  for (const row of rows.trim().split("\n")) {
    const [sha, type] = row.split(" ");
    if (type === "blob" && sha) {
      const bytes = execFileSync("git", ["-C", repo, "cat-file", "blob", sha]);
      if (bytes.includes(needle)) {
        return true;
      }
    }
  }
  return false;
}

function cleanReviewer(id: string, family: ProviderFamily): ReviewerSpec {
  const adapter: HarnessAdapter = {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        capabilities: { review: true },
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["review"] });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        observed_model: `${id}-model`,
        credential_route: "managed_api_key",
      };
      yield { type: "message", session_id: spec.session_id, ts, text: "```json\n[]\n```" };
      yield {
        type: "usage",
        session_id: spec.session_id,
        ts,
        credential_route: "managed_api_key",
        usage: { cost_usd: 0.001 },
      };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
  return { adapter, providerFamily: family };
}

function firstCandidateNeedsHumanReviewer(id: string, family: ProviderFamily): ReviewerSpec {
  let calls = 0;
  const reviewer = cleanReviewer(id, family);
  return {
    providerFamily: family,
    adapter: {
      ...reviewer.adapter,
      async *run(spec) {
        calls += 1;
        const ts = new Date().toISOString();
        const findings =
          calls === 1
            ? [
                {
                  severity: "NEEDS_HUMAN",
                  category: "spec_gap",
                  claim: "Only the first candidate needs an operator decision.",
                  evidence: { files: [] },
                  proposed_fix: "Choose the clean alternative.",
                },
              ]
            : [];
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: `${id}-model`,
          credential_route: "managed_api_key",
        } as never;
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: `\`\`\`json\n${JSON.stringify(findings)}\n\`\`\``,
        } as never;
        yield { type: "completed", session_id: spec.session_id, ts } as never;
      },
    },
  };
}

function cleanReviewerWithSideEffect(
  id: string,
  family: ProviderFamily,
  sideEffect: () => void,
): ReviewerSpec {
  const reviewer = cleanReviewer(id, family);
  const run = reviewer.adapter.run.bind(reviewer.adapter);
  const adapter: HarnessAdapter = {
    ...reviewer.adapter,
    async *run(spec) {
      sideEffect();
      yield* run(spec);
    },
  };
  return { adapter, providerFamily: family };
}

/** Run a block with CLAUDEXOR_CONFIG_DIR pointed at a fresh empty dir, so the
 * developer's real ~/.claudexor config can never leak into fixtures. */
async function withScopedConfigDir<T>(fn: () => Promise<T>): Promise<T> {
  const configDir = reapMk(join(tmpdir(), "claudexor-test-config-"));
  const prev = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prev;
  }
}

/** A non-fake adapter that behaves like fake-success (for default-harness resolution). */
function realLikeAdapter(id: string, family: ProviderFamily = "openai"): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        capabilities: {
          implement: true,
          review: true,
          // Manifest truth source for strict model-truth tests: explicit "model-x"
          // requests validate; anything else gets a typed refusal. The
          // *-cheap-model / *-review ids serve the reviewer-override tests.
          known_models: [
            "model-x",
            "model-y",
            "o-cheap-model",
            "a-cheap-model",
            "o-review",
            "a-review",
          ],
        },
        access_profiles_supported: ["readonly", "workspace_write"],
      });
    },
    async probeCredentialProfile(profile) {
      return {
        profile_id: profile.profile_id,
        harness_id: id,
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        detail: "fixture profile verified",
        last_verified_at: new Date().toISOString(),
      };
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["implement", "review"],
      });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        credential_route: "managed_api_key",
      };
      yield {
        type: "usage",
        session_id: spec.session_id,
        ts,
        credential_route: "managed_api_key",
        usage: { cost_usd: 0.01 },
      };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

/** An implementer that writes a REAL file, so the candidate has a non-empty diff
 * and the reviewer panel actually runs (empty-diff candidates skip paid review). */
function diffImplementer(
  id: string,
  family: ProviderFamily = "local",
  browserTool = false,
): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        // Implement-only: it must NOT also qualify as a reviewer (else it would
        // review its own candidate and crowd out a real cross-family reviewer).
        capabilities: { implement: true, browser_tool: browserTool },
        access_profiles_supported: ["workspace_write", "full"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["implement"],
      });
    },
    async probeCredentialProfile(profile) {
      return {
        profile_id: profile.profile_id,
        harness_id: id,
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        detail: "fixture profile verified",
        last_verified_at: new Date().toISOString(),
      };
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        observed_model: `${id}-model`,
        credential_route: "managed_api_key",
      };
      writeFileSync(join(spec.cwd, "CHANGED.txt"), "real change\n");
      yield { type: "message", session_id: spec.session_id, ts, text: "Implemented." };
      yield {
        type: "usage",
        session_id: spec.session_id,
        ts,
        credential_route: "managed_api_key",
        usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.01 },
      };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

function blockAttemptPatchPersistence(repo: string, attemptId: string): void {
  const runsDir = join(projectRuntimeDir(repo), "runs");
  const runId = readdirSync(runsDir)[0];
  if (!runId) throw new Error("fixture run directory was not created");
  mkdirSync(join(runsDir, runId, "attempts", attemptId, "patch.diff"), { recursive: true });
}

function mixedRoutePersistenceAdapter(
  id: string,
  repo: string,
  block: (call: number, intent: string) => string | null,
): HarnessAdapter {
  const base = diffImplementer(id);
  let calls = 0;
  return {
    ...base,
    async *run(spec) {
      calls += 1;
      const ts = new Date().toISOString();
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        credential_route: "vendor_native",
      };
      writeFileSync(join(spec.cwd, "CHANGED.txt"), `change from ${spec.intent}\n`);
      yield { type: "message", session_id: spec.session_id, ts, text: "Implemented." };
      yield {
        type: "usage",
        session_id: spec.session_id,
        ts,
        credential_route: "vendor_native",
        usage: { cost_usd: 0.75, estimated: true },
      };
      yield {
        type: "usage",
        session_id: spec.session_id,
        ts,
        credential_route: "managed_api_key",
        usage: { cost_usd: 0.25 },
      };
      const blockedAttempt = block(calls, spec.intent);
      if (blockedAttempt) blockAttemptPatchPersistence(repo, blockedAttempt);
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

function expectBudgetSplit(runDir: string, cash: number, valuation: number): void {
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          payload: { cash_spend_usd?: number; valuation_usd?: number };
        },
    );
  const cashEvents = events.filter(
    (event) => event.type === "budget.cash" && typeof event.payload.cash_spend_usd === "number",
  );
  expect(
    cashEvents.some(
      (event) =>
        (event.payload.cash_spend_usd ?? Number.NaN) >= cash &&
        (event.payload.cash_spend_usd ?? Number.NaN) < cash + 0.01 &&
        Math.abs((event.payload.valuation_usd ?? Number.NaN) - valuation) < 0.000_001,
    ),
    JSON.stringify(events.filter((event) => event.type.startsWith("budget."))),
  ).toBe(true);
}

function rawPatchImplementer(
  id: string,
  observeAccess?: (access: AccessProfile) => void,
): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "remote_api",
        provider_family: "openai",
        capabilities: {
          implement: true,
          implementation_transport: "git_patch_envelope",
        },
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["implement"],
      });
    },
    async *run(spec) {
      observeAccess?.(spec.access);
      const context = spec.raw_context_packet;
      if (!context) throw new Error("missing raw context packet");
      const readme = context.readable_files.find((file) => file.path === "README.md");
      if (!readme) throw new Error("README.md missing from raw context packet");
      const patch = [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1 +1 @@",
        "-# repo",
        "+# raw implemented",
        "",
      ].join("\n");
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts };
      yield {
        type: "patch_produced",
        session_id: spec.session_id,
        ts,
        patch_envelope: {
          schema_version: 1,
          context_packet_hash: context.packet_hash,
          base_tree_sha: context.base_tree_sha,
          patch,
          patch_hash: sha256(patch),
          touched_paths: [{ path: "README.md", expected_blob_oid: readme.blob_oid }],
        },
      };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

function transientThenDiffImplementer(id: string): {
  adapter: HarnessAdapter;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    adapter: {
      id,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { implement: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        calls += 1;
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        if (calls === 1) {
          yield {
            type: "error",
            session_id: spec.session_id,
            ts,
            error: "network dropped",
            transient: { kind: "network", retry_delay_ms: 0 },
          };
          yield { type: "completed", session_id: spec.session_id, ts };
          return;
        }
        writeFileSync(join(spec.cwd, "RECOVERED.txt"), "ok\n");
        yield { type: "message", session_id: spec.session_id, ts, text: "Recovered." };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    },
  };
}

/** An implementer that discloses a typed vendor auth failure then errors with
 * no deliverable — a NON-retryable category (GH #31) the retry policy must not
 * replay, and whose terminal must carry auth remediation. */
function authFailedImplementer(id: string): {
  adapter: HarnessAdapter;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    adapter: {
      id,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { implement: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        calls += 1;
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        yield {
          type: "status",
          session_id: spec.session_id,
          ts,
          status: { kind: "api_retry", error_category: "authentication_failed" },
        };
        yield {
          type: "error",
          session_id: spec.session_id,
          ts,
          error: "not authenticated",
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    },
  };
}

/** A reviewer/planner-only adapter: cannot implement/edit. */
function noImplementAdapter(id: string, family: ProviderFamily = "openai"): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "remote_api",
        provider_family: family,
        capabilities: { plan: true, review: true, implement: false, edit_files: false },
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["review", "plan"],
      });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

function askAdapter(
  id: string,
  events: (sessionId: string) => AsyncIterable<unknown> | Iterable<unknown>,
  family: ProviderFamily = "openai",
  webPolicy: "native" | "tools" | "uncontrolled" | "none" = "tools",
): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        capabilities: {
          plan: true,
          review: true,
          read_files: true,
          web_policy: webPolicy,
        },
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["explain", "audit", "plan", "review"],
      });
    },
    async probeCredentialProfile(profile) {
      return {
        profile_id: profile.profile_id,
        harness_id: id,
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        detail: "fixture profile verified",
        last_verified_at: new Date().toISOString(),
      };
    },
    async *run(spec) {
      for await (const event of events(spec.session_id) as AsyncIterable<Record<string, unknown>>) {
        yield { credential_route: "managed_api_key", ...event } as never;
      }
    },
  };
}

function nativeAskAdapter(id: string, observe: (spec: HarnessRunSpec) => void): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "anthropic",
        capabilities: { plan: true, review: true, read_files: true, web_policy: "tools" },
        auth_modes: ["local_session"],
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["explain", "audit", "plan", "review"],
        auth_sources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
      });
    },
    async probeCredentialProfile(profile) {
      return {
        profile_id: profile.profile_id,
        harness_id: id,
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        detail: "fixture profile verified",
        last_verified_at: new Date().toISOString(),
      };
    },
    async *run(spec) {
      observe(spec);
      const ts = new Date().toISOString();
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        credential_route: "vendor_native",
        credential_profile_id: spec.credential_profile?.profile_id,
        observed_model: "claude-opus-5",
      };
      yield { type: "message", session_id: spec.session_id, ts, text: "4" };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

const reviewers = () => [
  cleanReviewer("rev-openai", "openai"),
  cleanReviewer("rev-anthropic", "anthropic"),
];

function markdownPlannerAdapter(id: string, planLines: string[]): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "openai",
        capabilities: { plan: true },
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["plan"] });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts };
      yield { type: "message", session_id: spec.session_id, ts, text: planLines.join("\n") };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

/** Deterministically fail one attempt during async session/profile preparation,
 * before a harness process exists. The production method stays private; this
 * fixture only replaces its runtime slot so the public run contract is tested. */
function rejectSessionPreparationFor(orch: Orchestrator, harnessId: string): void {
  const target = orch as unknown as {
    sessionSpecFields: (...args: unknown[]) => Promise<unknown>;
  };
  const original = target.sessionSpecFields.bind(orch);
  target.sessionSpecFields = async (...args: unknown[]) => {
    if (args[1] === harnessId) throw new Error(`${harnessId} profile preparation rejected`);
    return original(...args);
  };
}

describe("Orchestrator", () => {
  it("keeps review evidence external even when a candidate path would block the old in-tree copy", () => {
    const source = reapMk(join(tmpdir(), "claudexor-review-source-"));
    writeEvidencePacket(source, {
      userIntent: "review this candidate",
      diff: "diff --git a/a b/a\n",
      tests: "not run",
    });
    const candidateFile = join(reapMk(join(tmpdir(), "claudexor-review-candidate-")), "not-a-dir");
    writeFileSync(candidateFile, "file blocks candidate evidence dir");
    const orch = new Orchestrator({ registry: new Map() });

    const selected = (
      orch as unknown as {
        prepareReviewEvidenceDir(sourceDir: string, candidateCwd: string): string;
      }
    ).prepareReviewEvidenceDir(source, candidateFile);
    expect(selected).toBe(source);
    expect(readFileSync(candidateFile, "utf8")).toBe("file blocks candidate evidence dir");
  });

  it("terminates agent runs when review evidence setup fails", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["impl", diffImplementer("impl")]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    (
      orch as unknown as {
        prepareReviewEvidenceDir(sourceDir: string, candidateCwd: string): string;
      }
    ).prepareReviewEvidenceDir = () => {
      throw new Error("forced review evidence failure");
    };

    const res = await orch.run({
      repoRoot: repo,
      prompt: "do it",
      mode: "agent",
      harnesses: ["impl"],
      n: 1,
    });

    expect(legacyOutcome(res)).toBe("failed");
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).toContain("phase: review");
    expect(failure).toContain("forced review evidence failure");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"run.failed"');
    expect(events).not.toContain('"type":"arbitration.completed"');
    expect(events).not.toContain('"type":"run.completed"');
  });

  it("runs a best-of-n race end to end and emits a DecisionRecord", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "do it",
      mode: "agent",
      harnesses: ["fake-success"],
      n: 2,
    });
    expect(res.mode).toBe("agent");
    expect(res.candidates.length).toBeGreaterThanOrEqual(2);
    expect(res.facts.noChanges).toBe(true);
    // the winner is always present in the returned candidates (incl. a synthesis candidate)
    expect(res.winner && res.candidates.some((c) => c.attemptId === res.winner)).toBeTruthy();
    expect(res.decisionPath && existsSync(res.decisionPath)).toBe(true);
    expect(existsSync(join(res.runDir, "final", "work_product.yaml"))).toBe(true);
  });

  it("allows a live-policy Agent run to finish without web activity", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const res = await new Orchestrator({ registry, reviewers: reviewers() }).run({
      repoRoot: repo,
      prompt: "do it from the repository context",
      mode: "agent",
      harnesses: ["fake-success"],
      web: "live",
      n: 1,
    });

    expect(res.facts.lifecycle).toBe("succeeded");
    expect(readFileSync(join(res.runDir, "context", "task.yaml"), "utf8")).toContain(
      "web_required: false",
    );
    expect(readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8")).toContain(
      "web_required_unsatisfied: false",
    );
  });

  it("takes decision cash certainty from the ledger on race, convergence, and no-work paths", async () => {
    const nativeEstimated = (id: string): HarnessAdapter => {
      const base = diffImplementer(id);
      return {
        ...base,
        async *run(spec) {
          for await (const event of base.run(spec)) {
            yield {
              ...event,
              credential_route: "vendor_native" as const,
              ...(event.usage ? { usage: { ...event.usage, estimated: true } } : {}),
            };
          }
        },
      };
    };
    const assertExactCashDecision = (runDir: string) => {
      const decision = readFileSync(join(runDir, "arbitration", "decision.yaml"), "utf8");
      expect(decision).toMatch(/estimated: false/);
      expect(decision).toMatch(/valuation_knowledge: estimated/);
    };

    const raceRepo = await initRepo();
    const race = await new Orchestrator({
      registry: new Map([["native", nativeEstimated("native")]]),
      reviewers: reviewers(),
    }).run({
      repoRoot: raceRepo,
      prompt: "do it",
      mode: "agent",
      harnesses: ["native"],
      n: 2,
    });
    assertExactCashDecision(race.runDir);

    const convergenceRepo = await initRepo();
    const convergence = await new Orchestrator({
      registry: new Map([["native", nativeEstimated("native")]]),
      reviewers: reviewers(),
    }).run({
      repoRoot: convergenceRepo,
      prompt: "do it",
      mode: "agent",
      harnesses: ["native"],
      attempts: 2,
    });
    assertExactCashDecision(convergence.runDir);

    const failedPaid: HarnessAdapter = {
      ...realLikeAdapter("paid-failure"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          credential_route: "managed_api_key",
        };
        yield {
          type: "usage",
          session_id: spec.session_id,
          ts,
          credential_route: "managed_api_key",
          usage: { cost_usd: 0.02, estimated: true },
        };
        yield { type: "error", session_id: spec.session_id, ts, error: "failed after usage" };
      },
    };
    const noWorkRepo = await initRepo();
    const noWork = await new Orchestrator({
      registry: new Map([[failedPaid.id, failedPaid]]),
      reviewers: [],
    }).run({
      repoRoot: noWorkRepo,
      prompt: "do it",
      mode: "agent",
      harnesses: [failedPaid.id],
    });
    expect(readFileSync(join(noWork.runDir, "arbitration", "decision.yaml"), "utf8")).toMatch(
      /estimated: true/,
    );
  }, 30_000);

  it("preserves mixed-route settlement when convergence persistence fails", async () => {
    const repo = await initRepo();
    const adapter = mixedRoutePersistenceAdapter("mixed-convergence", repo, (call) =>
      call === 1 ? "a01" : null,
    );
    const res = await new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: reviewers(),
    }).run({
      repoRoot: repo,
      prompt: "do it",
      mode: "agent",
      harnesses: [adapter.id],
      attempts: 2,
    });

    expectBudgetSplit(res.runDir, 0.5, 1.5);
    const attempt = readFileSync(join(res.runDir, "attempts", "a01", "attempt.yaml"), "utf8");
    expect(attempt).toContain("cost_usd: 1");
    expect(attempt).toContain("cost_estimated: true");
    expect(attempt).toContain("errored: true");
    expect(attempt).toContain("phase: harness");
  }, 30_000);

  it("preserves mixed-route settlement when race persistence fails", async () => {
    const repo = await initRepo();
    const adapter = mixedRoutePersistenceAdapter("mixed-race", repo, (call) =>
      call === 1 ? "a01" : null,
    );
    const res = await new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "do it",
      mode: "agent",
      harnesses: [adapter.id],
    });

    expectBudgetSplit(res.runDir, 0.25, 0.75);
    const attempt = readFileSync(join(res.runDir, "attempts", "a01", "attempt.yaml"), "utf8");
    expect(attempt).toContain("cost_usd: 1");
    expect(attempt).toContain("cost_estimated: true");
  }, 30_000);

  it("preserves mixed-route settlement when synthesis persistence fails", async () => {
    const repo = await initRepo();
    const adapter = mixedRoutePersistenceAdapter("mixed-synthesis", repo, (_call, intent) =>
      intent === "synthesize" ? "synth" : null,
    );
    const res = await new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "do it",
      mode: "agent",
      harnesses: [adapter.id],
      n: 2,
      synthesis: "always",
    });

    expectBudgetSplit(res.runDir, 0.75, 2.25);
  }, 30_000);

  it("preserves mixed-route settlement when continuation persistence fails", async () => {
    const repo = await initRepo();
    const base = createFakeHarness("fake-context-then-complete");
    let calls = 0;
    const adapter: HarnessAdapter = {
      ...base,
      async *run(spec) {
        calls += 1;
        const continuation = calls === 2;
        for await (const event of base.run(spec)) {
          if (event.type === "usage") continue;
          if (event.type === "started") {
            yield { ...event, credential_route: "vendor_native" as const };
            continue;
          }
          if (event.type === "completed") {
            const ts = new Date().toISOString();
            yield {
              type: "usage",
              session_id: spec.session_id,
              ts,
              credential_route: "vendor_native" as const,
              usage: { cost_usd: 0.75, estimated: true },
            };
            yield {
              type: "usage",
              session_id: spec.session_id,
              ts,
              credential_route: "managed_api_key" as const,
              usage: { cost_usd: 0.25 },
            };
            if (continuation) blockAttemptPatchPersistence(repo, "a01c");
          }
          yield event;
        }
      },
    };
    const res = await new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "do it",
      mode: "agent",
      harnesses: [adapter.id],
    });

    expectBudgetSplit(res.runDir, 0.5, 1.5);
  }, 30_000);
  it("does not let a losing candidate's NEEDS_HUMAN finding block the clean winner", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["impl", diffImplementer("impl")]]);
    const orch = new Orchestrator({
      registry,
      reviewers: [
        firstCandidateNeedsHumanReviewer("rev-openai", "openai"),
        cleanReviewer("rev-anthropic", "anthropic"),
      ],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "implement the change",
      mode: "agent",
      harnesses: ["impl"],
      n: 2,
    });

    expect(res.winner).toBe("a02");
    expect(res.facts).toMatchObject({ lifecycle: "succeeded", review: "approved" });
    const losingReview = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(losingReview).toContain("NEEDS_HUMAN");
    const runFacts = readRunFacts(repo, res);
    expect(runFacts.review).toEqual({
      state: "approved",
      blocker_ids: [],
      blockers: 0,
    });
  });

  it("D-16 r7: a context-exhausted candidate (partial diff, no completed report) terminalizes interrupted and is NEVER adopted", async () => {
    // The D-16 work-state veto hole: finalizeAttempt returns outcomeClass
    // "interrupted" for a capacity-exhausted attempt with a partial diff and no
    // completed WorkReport, but the candidate race path only elevated
    // "contract_failure" — so the partial candidate laundered into
    // review/arbitration/adoption as a clean succeeded run.
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-context-exhausted", createFakeHarness("fake-context-exhausted")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "do it",
      mode: "agent",
      harnesses: ["fake-context-exhausted"],
    });
    // The finalizer's interrupted outcome now reaches the run terminal (INV-116).
    expect(res.lifecycle).toBe("interrupted");
    expect(res.facts.reason).toBe("context_capacity_exhausted");
    expect(legacyOutcome(res)).toBe("interrupted_unknown");
    // A REAL partial diff was produced by the attempt...
    const producedPartialDiff = res.candidates.some((c) => {
      const patch = join(res.runDir, "attempts", c.attemptId, "patch.diff");
      return existsSync(patch) && readFileSync(patch, "utf8").includes("FAKE_CHANGE.txt");
    });
    expect(producedPartialDiff).toBe(true);
    // ...yet it was NEVER adopted, reviewed, arbitrated, or terminalized clean.
    expect(existsSync(join(res.runDir, "final", "work_product.yaml"))).toBe(false);
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"run.failed"');
    expect(events).not.toContain('"type":"work_product.adopted"');
    expect(events).not.toContain('"type":"run.completed"');
    expect(events).not.toContain('"type":"arbitration.completed"');
    expect(events).not.toContain('"type":"reviewer.started"');
    // The failure record is HONEST about the partial work (never "failed before producing work").
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).toContain("context capacity exhausted");
    expect(failure).not.toContain("failed before producing work");
  }, 20000);

  it("D-16 r7: a FAILED repeated_refill continuation retains the interrupted original — still interrupted, never adopted", async () => {
    // The second live face of the hole: the eligible one-shot continuation
    // launches but FAILS, so the original context-exhausted candidate is
    // retained. That retained interrupted candidate must terminalize the run
    // interrupted, not launder into adoption because the continuation "ran".
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-context-then-error", createFakeHarness("fake-context-then-error")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "do it",
      mode: "agent",
      harnesses: ["fake-context-then-error"],
    });
    expect(res.lifecycle).toBe("interrupted");
    expect(res.facts.reason).toBe("context_capacity_exhausted");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    // The one-shot continuation was launched (and then failed).
    expect(events).toContain('"type":"run.continuation"');
    const continuationLifecycle = readRunEvents(res.runDir).filter(
      (event) =>
        event.payload["attempt_id"] === "a01c" &&
        (event.type === "harness.started" || event.type === "harness.completed"),
    );
    expect(continuationLifecycle.map((event) => event.type)).toEqual([
      "harness.started",
      "harness.completed",
    ]);
    // The retained interrupted candidate is never adopted or terminalized clean.
    expect(existsSync(join(res.runDir, "final", "work_product.yaml"))).toBe(false);
    expect(events).toContain('"type":"run.failed"');
    expect(events).not.toContain('"type":"work_product.adopted"');
    expect(events).not.toContain('"type":"run.completed"');
  }, 20000);

  it("a CREATE run's per-run test command is a runnable trust-free gate (QA-010)", async () => {
    // A fresh project has NO .claudexor trust file. Explicit per-run operator
    // test commands (run input `tests`) are `trust_required:false` and run
    // as deterministic gates for that run's own envelope — the honest rule for
    // Create, where the project (and its test script) does not exist until the
    // run produces it. A passing command yields checks=passed WITHOUT a grant.
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-implement", createFakeHarness("fake-implement")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "create it",
      mode: "agent",
      create: true,
      harnesses: ["fake-implement"],
      tests: [shellGate("true")],
    });
    expect(res.facts.checks).toBe("passed");
    const decision = readFileSync(join(res.runDir, "arbitration", "decision.yaml"), "utf8");
    expect(decision).toContain("checks: passed");
    // The gate ran without any trust grant.
    const evidence = readFileSync(join(res.runDir, "review-evidence", "TESTS.txt"), "utf8");
    expect(evidence).not.toContain("no test commands configured");
    const runFacts = readRunFacts(repo, res);
    expect(runFacts.gates).toMatchObject({
      configured: true,
      required: 1,
      total: 1,
      executed: true,
      state: "passed",
    });
    expect(runFacts.outcome.checks).toBe("passed");
  }, 20000);

  it("no-diff candidate emits review.skipped, never review.started or review_verified (QA-025)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "just answer",
      mode: "agent",
      harnesses: ["fake-success"],
    });
    expect(res.facts.noChanges).toBe(true);
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; payload?: Record<string, unknown> });
    const started = events.filter((e) => e.type === "review.started");
    const skipped = events.filter((e) => e.type === "review.skipped");
    expect(started.length).toBe(0);
    expect(skipped.length).toBe(1);
    expect(skipped[0].payload?.["reason"]).toBe("no_changes");
    // The false preliminary `review_verified:true` claim must not appear on any
    // review lifecycle event.
    for (const e of [...started, ...skipped]) {
      expect(e.payload?.["review_verified"]).toBeUndefined();
    }
    // No reviewer actually ran.
    expect(events.filter((e) => e.type === "reviewer.started").length).toBe(0);
  });

  it("max-attempts converges and delivers to final/ (apply/inspect can use it)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      attempts: 3,
    });
    expect(res.facts.noChanges).toBe(true);
    expect(existsSync(join(res.runDir, "final", "patch.diff"))).toBe(true);
    expect(existsSync(join(res.runDir, "final", "work_product.yaml"))).toBe(true);
    expect(existsSync(join(res.runDir, "arbitration", "decision.yaml"))).toBe(true);
  }, 15000);

  it("D-16 r9: an interrupted planner never delivers final/plan.md as success — the plan terminal is interrupted", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-context-exhausted", createFakeHarness("fake-context-exhausted")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "plan it",
      mode: "plan",
      harnesses: ["fake-context-exhausted"],
    });
    expect(res.lifecycle).toBe("interrupted");
    expect(res.facts.reason).toBe("context_capacity_exhausted");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).not.toContain('"type":"run.completed"');
    // The event contract holds here too.
    const lines = events.trim().split("\n");
    const readyIdx = lines.findIndex((l) => l.includes('"type":"output.ready"'));
    const termIdx = lines.findIndex((l) => l.includes('"type":"run.failed"'));
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    expect(termIdx).toBeGreaterThan(readyIdx);
  }, 15000);

  it("D-16 r8: the convergence loop never converges an interrupted attempt — it terminalizes interrupted", async () => {
    // runConvergence read neither outcomeClass nor contextExhausted, so an
    // interrupted attempt (errored===false) flowed into evaluateConvergence and
    // could CONVERGE its partial diff as an applyable succeeded product.
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-context-exhausted", createFakeHarness("fake-context-exhausted")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "converge it",
      mode: "agent",
      harnesses: ["fake-context-exhausted"],
      attempts: 3,
    });
    expect(res.lifecycle).toBe("interrupted");
    expect(res.facts.reason).toBe("context_capacity_exhausted");
    // Never converged-clean: no adopted product, no arbitration of the partial.
    expect(existsSync(join(res.runDir, "final", "work_product.yaml"))).toBe(false);
    expect(existsSync(join(res.runDir, "arbitration", "decision.yaml"))).toBe(false);
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).not.toContain('"type":"work_product.adopted"');
    // r9: the event contract holds for interrupted too — a diagnostic summary
    // exists, output.ready precedes the terminal, and work_product.emitted is
    // NOT emitted (no product was written).
    expect(existsSync(join(res.runDir, "final", "summary.md"))).toBe(true);
    const lines = events.trim().split("\n");
    const readyIdx = lines.findIndex((l) => l.includes('"type":"output.ready"'));
    const termIdx = lines.findIndex((l) => l.includes('"type":"run.failed"'));
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    expect(termIdx).toBeGreaterThan(readyIdx);
    expect(events).not.toContain('"type":"work_product.emitted"');
  }, 15000);

  it("a non-converged attempt is re-prompted with the buildRevisePrompt contract, not an inline string", async () => {
    // The revise contract is only worth anything if the loop actually delivers
    // it. buildRevisePrompt's own suite proves the text; this pins the single
    // integration point, so reverting the call site to an inline template
    // literal fails here instead of silently shipping.
    const repo = await initRepo();
    const seen: string[] = [];
    const recorder: HarnessAdapter = {
      id: "recorder",
      async discover() {
        return HarnessManifest.parse({
          id: "recorder",
          display_name: "recorder",
          kind: "local_cli",
          provider_family: "local",
          capabilities: { implement: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "recorder",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        seen.push(spec.prompt);
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "recorder-model",
          credential_route: "managed_api_key",
        };
        writeFileSync(join(spec.cwd, "CHANGED.txt"), `attempt ${seen.length}\n`);
        yield { type: "message", session_id: spec.session_id, ts, text: "Implemented." };
        yield {
          type: "usage",
          session_id: spec.session_id,
          ts,
          credential_route: "managed_api_key",
          usage: { cost_usd: 0.001 },
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    function blockingReviewer(id: string, family: ProviderFamily): ReviewerSpec {
      const adapter: HarnessAdapter = {
        id,
        async discover() {
          return HarnessManifest.parse({
            id,
            display_name: id,
            kind: "local_cli",
            provider_family: family,
            capabilities: { review: true },
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
          yield { type: "started", session_id: spec.session_id, ts, observed_model: `${id}-model` };
          yield {
            type: "message",
            session_id: spec.session_id,
            ts,
            text: JSON.stringify([
              {
                severity: "BLOCK",
                category: "correctness",
                claim: "off-by-one in the retry window",
                evidence: { files: [{ path: "CHANGED.txt", lines: "1" }] },
                proposed_fix: "clamp the window",
              },
            ]),
          };
          yield {
            type: "completed",
            session_id: spec.session_id,
            ts,
            observed_model: `${id}-model`,
          };
        },
      };
      return { adapter, providerFamily: family };
    }

    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([["recorder", recorder]]),
      reviewers: [
        blockingReviewer("rev-openai", "openai"),
        blockingReviewer("rev-anthropic", "anthropic"),
      ],
    });
    await orch.run({
      repoRoot: repo,
      prompt: "converge it",
      mode: "agent",
      harnesses: ["recorder"],
      attempts: 2,
    });

    expect(seen.length).toBeGreaterThanOrEqual(2);
    // Attempt 1 is the operator's own prompt, untouched.
    expect(seen[0]).toBe("converge it");
    // Attempt 2 carries every contract sentence buildRevisePrompt emits. Derived
    // from the builder rather than re-typed, so the pin cannot drift from it.
    const revise = seen[1] as string;
    const contractSentences = buildRevisePrompt("__BASE__", [], "")
      .split("\n")
      .filter(
        (line) =>
          line.trim().length > 0 &&
          line !== "__BASE__" &&
          line !== "Review findings:" &&
          line !== "(no findings recorded)",
      );
    expect(contractSentences.length).toBeGreaterThan(0);
    for (const sentence of contractSentences) expect(revise).toContain(sentence);
    // ...on top of the original prompt and the findings that blocked it.
    expect(revise.startsWith("converge it\n\n")).toBe(true);
    expect(revise).toContain("off-by-one in the retry window");
  }, 20000);

  it("until-clean terminates on no-progress (bounded, not infinite)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-fail-tests", createFakeHarness("fake-fail-tests")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      untilClean: true,
      harnesses: ["fake-fail-tests"],
    });
    // The identical-repair-prompt loop detector stops the run as exhausted
    // (3rd identical prompt) before the slower stall detector can mark it failed.
    expect(legacyOutcome(res)).toBe("exhausted");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain("loop_detected");
  }, 20000);

  it("until-clean stops as stuck_no_progress on repeated identical diff plus failing gate", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-implement", createFakeHarness("fake-implement")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "write deterministic file",
      mode: "agent",
      untilClean: true,
      harnesses: ["fake-implement"],
      tests: [shellGate("false")],
    });
    expect(legacyOutcome(res)).toBe("stuck_no_progress");
    const summary = readFileSync(join(res.runDir, "final", "summary.md"), "utf8");
    expect(summary).toContain("No-progress reason");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain("stuck_no_progress");
  }, 20000);

  it("until-clean deadline abort ends cancelled with wall_clock_exceeded, never user_cancelled (QA-041)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-implement", createFakeHarness("fake-implement")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const ac = new AbortController();
    // The daemon's maxSeconds deadline controller aborts with a STRING reason
    // carried through AbortSignal.any; convergence must read it at the source
    // and not hard-code every abort to user_cancelled.
    ac.abort("wall_clock_exceeded");
    const res = await orch.run({
      repoRoot: repo,
      prompt: "write deterministic file",
      mode: "agent",
      untilClean: true,
      harnesses: ["fake-implement"],
      signal: ac.signal,
    });
    expect(legacyOutcome(res)).toBe("cancelled");
    expect(res.facts.reason).toBe("wall_clock_exceeded");
    expect(res.facts.reason).not.toBe("user_cancelled");
    expect(res.cancelReason).toBe("wall_clock_exceeded");
    const summary = readFileSync(join(res.runDir, "final", "summary.md"), "utf8");
    expect(summary).toContain("wall_clock_exceeded");
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).not.toContain("Retry if cancellation was accidental");
    expect(failure).toContain("max-seconds");
  }, 20000);

  it("until-clean plain user cancel stays user_cancelled (QA-041)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-implement", createFakeHarness("fake-implement")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const ac = new AbortController();
    ac.abort();
    const res = await orch.run({
      repoRoot: repo,
      prompt: "write deterministic file",
      mode: "agent",
      untilClean: true,
      harnesses: ["fake-implement"],
      signal: ac.signal,
    });
    expect(legacyOutcome(res)).toBe("cancelled");
    expect(res.facts.reason).toBe("user_cancelled");
    expect(res.cancelReason).toBeUndefined();
  }, 20000);

  it("retries a typed transient candidate failure when no deliverable was produced", async () => {
    const repo = await initRepo();
    const transient = transientThenDiffImplementer("transient-impl");
    const registry = new Map<string, HarnessAdapter>([[transient.adapter.id, transient.adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "write file",
      mode: "agent",
      harnesses: [transient.adapter.id],
      n: 1,
    });
    expect(transient.calls()).toBe(2);
    expect(legacyOutcome(res)).not.toBe("failed");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain("route.transient.retry_scheduled");
    const attempt = readFileSync(join(res.runDir, "attempts", "a01", "attempt.yaml"), "utf8");
    expect(attempt).toContain("transient_failures");
    expect(attempt).toContain("network");
    // GH #31: the retry event carries the typed category, not only the fine kind.
    expect(events).toContain('"category":"unknown_harness_error"');
  });

  it("does NOT retry a non-retryable classified failure and attaches auth remediation only on auth_failed (GH #31)", async () => {
    const repo = await initRepo();
    const authFail = authFailedImplementer("auth-impl");
    const registry = new Map<string, HarnessAdapter>([[authFail.adapter.id, authFail.adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "write file",
      mode: "agent",
      harnesses: [authFail.adapter.id],
      n: 1,
    });
    // A deterministic auth refusal is never replayed by the transient policy.
    expect(authFail.calls()).toBe(1);
    expect(legacyOutcome(res)).toBe("failed");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).not.toContain("route.transient.retry_scheduled");
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    // Auth guidance appears ONLY because the classified category is auth_failed.
    expect(failure).toMatch(/[Rr]e-authenticate/);
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toContain("auth_failed");
  });

  it("delivers per-run instructions to a task-producing candidate lane (W5)", async () => {
    const repo = await initRepo();
    const captured: (string | undefined)[] = [];
    const base = createFakeHarness("fake-implement");
    // Record what the candidate lane's spec actually carries.
    const recording: HarnessAdapter = {
      ...base,
      async *run(spec) {
        captured.push(spec.instructions);
        yield* base.run(spec);
      },
    };
    const registry = new Map<string, HarnessAdapter>([["fake-implement", recording]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "write deterministic file",
      instructions: "always add a trailing newline",
      mode: "agent",
      harnesses: ["fake-implement"],
      n: 1,
    });
    expect(legacyOutcome(res)).not.toBe("failed");
    // The candidate (task-producing) lane received the caller's instructions;
    // synthesis (intent === "synthesize") and reviewers build their own specs
    // and are excluded by harnessSpecKnobs / the review engine.
    expect(captured).toContain("always add a trailing newline");
  }, 20000);

  it("omits instructions from a candidate lane when the run declares none (W5 control)", async () => {
    const repo = await initRepo();
    const captured: (string | undefined)[] = [];
    const base = createFakeHarness("fake-implement");
    const recording: HarnessAdapter = {
      ...base,
      async *run(spec) {
        captured.push(spec.instructions);
        yield* base.run(spec);
      },
    };
    const registry = new Map<string, HarnessAdapter>([["fake-implement", recording]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    await orch.run({
      repoRoot: repo,
      prompt: "write deterministic file",
      mode: "agent",
      harnesses: ["fake-implement"],
      n: 1,
    });
    expect(captured.every((i) => i === undefined)).toBe(true);
  }, 20000);

  it("HARD-BLOCKS a secret-like value in per-run instructions at the engine boundary (W5/INV-062)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-implement", createFakeHarness("fake-implement")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const jwt = "eyJ" + "a".repeat(12) + "." + "b".repeat(12) + "." + "c".repeat(8);
    // A direct embedder reaches Orchestrator.run() without any surface fence;
    // instructions are durable (they land in the TaskContract), so the engine
    // boundary must block them exactly like the prompt.
    await expect(
      orch.run({
        repoRoot: repo,
        prompt: "write file",
        instructions: `always send header ${jwt}`,
        mode: "agent",
        harnesses: ["fake-implement"],
        n: 1,
      }),
    ).rejects.toThrow(/secret-like/);
  });

  it("redacts a secret-like token in the winning candidate's answer before final/answer.md (INV-062: candidate lane parity with read-only/deep-scan)", async () => {
    const repo = await initRepo();
    // Assembled at runtime so the source (and any sealed review diff of it) never
    // holds a contiguous secret-like token at rest.
    const token = ["sk-or-v1", "c".repeat(40)].join("-");
    const base = createFakeHarness("fake-success");
    // An answer-only (no file change) candidate whose FINAL deliverable carries a
    // live-looking token — exactly the payload-sourced text runCandidateInEnvelope
    // unwraps into answerText and writes to final/answer.md. The read-only lane and
    // deepScanReducer already redact their unwrapped deliverable; this proves the
    // candidate lane now matches.
    const leaky: HarnessAdapter = {
      ...base,
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "leaky-model",
          credential_route: "managed_api_key",
        };
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          // Leading/trailing whitespace is deliberate: the X119 fix must persist the
          // deliverable VERBATIM (redacted), trimming ONLY for the emptiness check.
          text: `\n\n  Here is the key you asked for: ${token}  \n`,
          final: true,
          payload: { final_source: "fake" },
        };
        yield {
          type: "usage",
          session_id: spec.session_id,
          ts,
          credential_route: "managed_api_key",
          usage: { cost_usd: 0.001 },
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    // Register under the base adapter's own id so the requested harness resolves
    // to this lane (a mismatched key would drop it before it can produce a diff).
    const registry = new Map<string, HarnessAdapter>([["fake-success", leaky]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      n: 1,
    });
    const answer = readFileSync(join(res.runDir, "final", "answer.md"), "utf8");
    expect(answer).not.toContain(token);
    expect(answer).toContain("[redacted]");
    // X119: the leading/trailing whitespace survives — the deliverable is persisted
    // verbatim (redacted), not trimmed. (answer.md carries a single appended "\n".)
    expect(answer.startsWith("\n\n  Here is the key")).toBe(true);
    expect(answer).toContain("for: [redacted]  \n");
  }, 20000);

  it("plan mode produces a plan without mutating", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "map the repo",
      mode: "plan",
      harnesses: ["fake-success"],
    });
    expect(legacyOutcome(res)).toBe("success");
    expect(existsSync(join(res.runDir, "final", "plan.md"))).toBe(true);
  });

  it("redacts a secret-like token in the plan deliverable before final/plan.md (X119 plan-lane symmetry)", async () => {
    const repo = await initRepo();
    const token = ["sk-or-v1", "d".repeat(40)].join("-");
    const base = createFakeHarness("fake-success");
    // A plan whose deliverable text carries a live-looking token — the outcome.text
    // → finalizePlanRun → final/plan.md path had no lane-level redaction, unlike the
    // other three unwrap lanes. This proves the plan lane now matches.
    const leaky: HarnessAdapter = {
      ...base,
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "leaky-model",
          credential_route: "managed_api_key",
        };
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: `Plan step 1: reuse the key ${token} then continue`,
          final: true,
          payload: { final_source: "fake" },
        };
        yield {
          type: "usage",
          session_id: spec.session_id,
          ts,
          credential_route: "managed_api_key",
          usage: { cost_usd: 0.001 },
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([["fake-success", leaky]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "map the repo",
      mode: "plan",
      harnesses: ["fake-success"],
    });
    const plan = readFileSync(join(res.runDir, "final", "plan.md"), "utf8");
    expect(plan).not.toContain(token);
    expect(plan).toContain("[redacted]");
  }, 20000);

  it("enforces an explicit project mandatory_files contract UNIFORMLY across modes (P1)", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, ".claudexor"), { recursive: true });
    writeFileSync(
      join(repo, ".claudexor", "config.yaml"),
      "version: 1\ncontext:\n  mandatory_files:\n    - MISSING.md\n",
    );
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    // ask (skips ContextPack), plan (builds it), and agent (never built it) must
    // now ALL fail the same way on a missing explicit mandatory file — the P1 bug
    // was that one mode failed while others silently passed the same repo state.
    for (const mode of ["ask", "plan", "agent"] as const) {
      await expect(
        orch.run({ repoRoot: repo, prompt: "x", mode, harnesses: ["fake-success"] }),
      ).rejects.toThrow(/mandatory context missing\/unreadable/);
    }
  });

  it("enforces the budget cap mid-flight: no candidate beyond the wave spawns and the cap abort is evidenced", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({
      registry,
      reviewers: reviewers(),
      paidBudget: { kind: "finite", maxUsd: 0.005 },
    });
    // Each fake streams 0.01 usage (> 0.005 cap). With amount-bearing holds the
    // FIRST usage event already drives the tier hard: in-flight candidates abort
    // mid-stream (no silent overshoot), pre-start wave slots are skipped, and the
    // queued slots beyond the parallel wave (a05, a06) are never spawned.
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      n: 6,
    });
    const primary = res.candidates.filter((c) => /^a\d+$/.test(c.attemptId));
    expect(primary.length).toBeGreaterThanOrEqual(1);
    expect(primary.length).toBeLessThanOrEqual(4);
    expect(primary.some((c) => c.attemptId === "a05" || c.attemptId === "a06")).toBe(false);
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toMatch(/hard cap/);
  });

  it("accounts for estimated parallel candidates without crossing reserved headroom", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({
      registry,
      reviewers: reviewers(),
      paidBudget: { kind: "finite", maxUsd: 0.1 },
    });
    const res = await withScopedConfigDir(async () =>
      orch.run({ repoRoot: repo, prompt: "x", mode: "agent", harnesses: ["fake-success"], n: 4 }),
    );
    const primary = res.candidates.filter((c) => /^a\d+$/.test(c.attemptId));
    expect(primary.length).toBe(2);
    expect(legacyOutcome(res)).not.toBe("exhausted_overshoot");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain("insufficient headroom for estimated cost");
  });

  it("QA-043: an EXPLICIT pool with an intent-incompatible lane refuses loudly (no silent self-race)", async () => {
    // Legacy behavior (pre-QA-043) silently dropped raw-ish and modulo-filled
    // fake-success TWICE — a self-race masquerading as best-of-2. An explicitly
    // selected lane that cannot perform the intent is now a loud typed refusal
    // BEFORE any candidate starts, never a silent substitution.
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["raw-ish", noImplementAdapter("raw-ish")],
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["raw-ish", "fake-success"],
      n: 2,
    });
    // Loud typed refusal at routing preflight, surfaced as a failed run naming
    // the lane — NEVER a silent drop + fake-success run twice.
    expect(res.lifecycle).toBe("failed");
    expect(res.summary).toMatch(/raw-ish.*cannot/i);
    expect(res.candidates.filter((c) => /^a\d+$/.test(c.attemptId))).toHaveLength(0);
  });

  it("QA-043: an EXPLICIT pool with an access-incompatible lane refuses loudly, naming the lane", async () => {
    const repo = await initRepo();
    // codex supports full; cursor does not (only readonly/workspace_write).
    const codexFull: HarnessAdapter = {
      ...realLikeAdapter("codex", "openai"),
      async discover() {
        return HarnessManifest.parse({
          id: "codex",
          display_name: "codex",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { implement: true, review: true },
          access_profiles_supported: ["readonly", "workspace_write"],
        });
      },
    };
    const cursorNoFull: HarnessAdapter = {
      ...realLikeAdapter("cursor", "google"),
      async discover() {
        return HarnessManifest.parse({
          id: "cursor",
          display_name: "cursor",
          kind: "local_cli",
          provider_family: "google",
          capabilities: { implement: true, review: true },
          access_profiles_supported: ["readonly"],
        });
      },
    };
    const registry = new Map<string, HarnessAdapter>([
      ["codex", codexFull],
      ["cursor", cursorNoFull],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await withScopedConfigDir(async () =>
      orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["codex", "cursor"],
        access: "workspace_write",
        n: 2,
      }),
    );
    // Adding a surviving codex lane must NOT convert cursor's refusal into a
    // silent omission — the explicit pool fails loudly, naming cursor.
    expect(res.lifecycle).toBe("failed");
    expect(res.summary).toMatch(/cursor.*cannot enforce workspace_write/i);
    expect(res.candidates.filter((c) => /^a\d+$/.test(c.attemptId))).toHaveLength(0);
  });

  it("QA-043: an AUTO pool drops an access-incompatible lane, discloses it, and never self-races", async () => {
    const repo = await initRepo();
    const codexFull: HarnessAdapter = {
      ...realLikeAdapter("codex", "openai"),
      async discover() {
        return HarnessManifest.parse({
          id: "codex",
          display_name: "codex",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { implement: true, review: true },
          access_profiles_supported: ["readonly", "workspace_write"],
        });
      },
    };
    const cursorNoFull: HarnessAdapter = {
      ...realLikeAdapter("cursor", "google"),
      async discover() {
        return HarnessManifest.parse({
          id: "cursor",
          display_name: "cursor",
          kind: "local_cli",
          provider_family: "google",
          capabilities: { implement: true, review: true },
          access_profiles_supported: ["readonly"],
        });
      },
    };
    const registry = new Map<string, HarnessAdapter>([
      ["codex", codexFull],
      ["cursor", cursorNoFull],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    // AUTO pool (no explicit --harness): the engine considers both, drops cursor
    // for access, and runs codex ONCE — NOT codex twice via modulo self-fill.
    const res = await withScopedConfigDir(async () =>
      orch.run({ repoRoot: repo, prompt: "x", mode: "agent", access: "workspace_write", n: 2 }),
    );
    const primary = res.candidates.filter((c) => /^a\d+$/.test(c.attemptId));
    expect(primary.every((c) => c.harnessId === "codex")).toBe(true);
    // The dropped cursor slot is NOT refilled by a duplicate codex.
    expect(primary.length).toBe(1);
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain("route.pool.degraded");
    const degraded = events
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.type === "route.pool.degraded");
    expect(degraded).toBeTruthy();
    expect(degraded.payload.effective_n).toBe(1);
    expect(degraded.payload.requested_n).toBe(2);
    expect(degraded.payload.effective_harnesses).toEqual(["codex"]);
    expect(degraded.payload.dropped_lanes[0].harness_id).toBe("cursor");
    expect(degraded.payload.dropped_lanes[0].stage).toBe("access");
  });

  it("applies configured eligible pool, primary harness, model, and routing goal defaults", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, ".claudexor"), { recursive: true });
    writeFileSync(
      join(repo, ".claudexor", "config.yaml"),
      ["version: 1", "budget:", "  routing_goal: economy", ""].join("\n"),
    );
    const seen: { id: string; model: string | null }[] = [];
    const adapterA: HarnessAdapter = {
      ...realLikeAdapter("codex", "openai"),
      async *run(spec) {
        seen.push({ id: "codex", model: spec.model_hint });
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const adapterB: HarnessAdapter = {
      ...realLikeAdapter("claude", "anthropic"),
      async *run(spec) {
        seen.push({ id: "claude", model: spec.model_hint });
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const registry = new Map<string, HarnessAdapter>([
      ["codex", adapterA],
      ["claude", adapterB],
    ]);
    // Scope the global config away from the developer's real ~/.claudexor:
    // strict model preflight now judges per-harness settings defaults, so an
    // operator's own `harnesses.codex.default_model` would leak into fixtures.
    const res = await withScopedConfigDir(async () => {
      const orch = new Orchestrator({ registry, reviewers: [] });
      return orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["codex", "claude"],
        primaryHarness: "claude",
        model: "model-x",
        n: 2,
      });
    });
    expect(legacyOutcome(res)).not.toBe("failed");
    const taskYaml = readFileSync(join(res.runDir, "context", "task.yaml"), "utf8");
    // INV-103: the scalar model expands to the RESOLVED PRIMARY only. The
    // other pool member must NOT be poisoned by the primary's model id (the
    // old crash class: one vendor's model forwarded to every harness).
    expect(seen.find((s) => s.id === "claude")?.model).toBe("model-x");
    expect(seen.find((s) => s.id === "codex")?.model).toBeNull();
    expect(taskYaml).toContain("routing_goal: economy");
    // The contract records the resolved harness-scoped map.
    expect(taskYaml).toContain("routing_models");
    expect(taskYaml).toContain("claude: model-x");
  });

  it("infers an explicit singleton pool as primary ahead of a conflicting configured primary", async () => {
    const repo = await initRepo();
    const seen: { id: string; model: string | null }[] = [];
    const observedAdapter = (id: string, family: ProviderFamily): HarnessAdapter => ({
      ...realLikeAdapter(id, family),
      async *run(spec) {
        seen.push({ id, model: spec.model_hint });
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    });
    const registry = new Map<string, HarnessAdapter>([
      ["codex", observedAdapter("codex", "openai")],
      ["claude", observedAdapter("claude", "anthropic")],
    ]);
    const res = await withScopedConfigDir(async () => {
      writeFileSync(
        join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml"),
        "routing:\n  primary_harness: codex\n",
      );
      const orch = new Orchestrator({ registry, reviewers: [] });
      return orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["claude"],
        model: "model-x",
        n: 1,
      });
    });
    expect(res.lifecycle).toBe("succeeded");
    expect(seen).toEqual([{ id: "claude", model: "model-x" }]);
  });

  it("REFUSES a run whose resolved model fails the harness truth source (typed preflight, no CLI spawn)", async () => {
    const repo = await initRepo();
    let spawned = false;
    const adapter: HarnessAdapter = {
      ...realLikeAdapter("codex", "openai"),
      async *run(spec) {
        spawned = true;
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const registry = new Map<string, HarnessAdapter>([["codex", adapter]]);
    const res = await withScopedConfigDir(async () => {
      const orch = new Orchestrator({ registry, reviewers: [] });
      return orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["codex"],
        model: "gpt-nonexistent",
        n: 1,
      });
    });
    expect(legacyOutcome(res)).toBe("failed");
    expect(spawned).toBe(false);
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).toContain("gpt-nonexistent");
    expect(failure).toContain("codex");
    expect(failure).toContain("truth source");
  });

  it("REJECTS a scalar model when no primary harness is resolvable (ambiguous pool)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["codex", realLikeAdapter("codex", "openai")],
      ["claude", realLikeAdapter("claude", "anthropic")],
    ]);
    await withScopedConfigDir(async () => {
      const orch = new Orchestrator({ registry, reviewers: [] });
      await expect(
        orch.run({
          repoRoot: repo,
          prompt: "x",
          mode: "agent",
          harnesses: ["codex", "claude"],
          model: "model-x",
          n: 2,
        }),
      ).rejects.toThrow(/scalar model .* ambiguous without a primary harness/);
    });
  });

  it("auto-protects test and package surfaces when deterministic gates are configured", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      tests: [shellGate("node --test test/*.test.js")],
    });
    const taskYaml = readFileSync(join(res.runDir, "context", "task.yaml"), "utf8");
    expect(taskYaml).toContain("auto_protected_paths");
    expect(taskYaml).toContain("package.json");
    expect(taskYaml).toContain("test/**");
    expect(taskYaml).toContain("test/*.test.js");
  });

  it("emits a deterministic BLOCK when a candidate edits a protected gate path", async () => {
    const repo = await initRepo();
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }, null, 2),
    );
    await runCapture("git", ["-C", repo, "add", "package.json"]);
    await runCapture("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "add package",
    ]);
    const adapter: HarnessAdapter = {
      ...diffImplementer("tamper-impl"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts, observed_model: "tamper-model" };
        writeFileSync(
          join(spec.cwd, "package.json"),
          JSON.stringify({ scripts: { test: "true" } }, null, 2),
        );
        yield { type: "message", session_id: spec.session_id, ts, text: "changed package script" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([[adapter.id, adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "fix implementation only",
      mode: "agent",
      harnesses: [adapter.id],
      tests: [shellGate("true")],
      n: 1,
    });
    expect(legacyOutcome(res)).toBe("blocked");
    const review = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(review).toContain("level: critical");
    expect(review).toContain("candidate changed protected path");
    expect(review).toContain("severity: BLOCK");
    const decision = readFileSync(join(res.runDir, "arbitration", "decision.yaml"), "utf8");
    expect(decision).toContain("lifecycle: succeeded");
    expect(decision).toContain("checks: passed");
    expect(decision).toContain("review: blocked");
    expect(decision).toContain("reason: review_blocked");
    const runFacts = readRunFacts(repo, res);
    expect(runFacts.review.blockers).toBeGreaterThan(0);
    expect(runFacts.apply.eligibility?.state).toBe("needs_review");
    expect(runFacts.required_actions.map((action) => action.id)).toEqual([
      "resolve_review_block",
      "record_operator_decision",
    ]);
  });

  it("allows explicitly approved existing protected gate path changes", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, "test"), { recursive: true });
    writeFileSync(
      join(repo, "test", "math.test.js"),
      "import test from 'node:test';\ntest('old', () => {});\n",
    );
    await runCapture("git", ["-C", repo, "add", "test/math.test.js"]);
    await runCapture("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "add test",
    ]);
    const adapter: HarnessAdapter = {
      ...diffImplementer("approved-test-edit-impl"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "approved-test-edit-model",
        };
        writeFileSync(
          join(spec.cwd, "test", "math.test.js"),
          "import test from 'node:test';\ntest('updated', () => {});\n",
        );
        yield { type: "message", session_id: spec.session_id, ts, text: "updated test" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([[adapter.id, adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "update the tests",
      mode: "agent",
      harnesses: [adapter.id],
      tests: [shellGate("true")],
      protectedPathApprovals: [{ path: "test/**", reason: "test authoring requested" }],
      n: 1,
    });
    expect(legacyOutcome(res)).not.toBe("blocked");
    const taskYaml = readFileSync(join(res.runDir, "context", "task.yaml"), "utf8");
    expect(taskYaml).toContain("protected_path_approvals");
    expect(taskYaml).toContain("test/**");
    const review = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(review).not.toContain("candidate changed protected gate/test path");
  });

  it("does not let protected path approval bypass built-in human paths", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: release\n");
    await runCapture("git", ["-C", repo, "add", ".github/workflows/release.yml"]);
    await runCapture("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "add workflow",
    ]);
    const adapter: HarnessAdapter = {
      ...diffImplementer("approved-critical-edit-impl"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "approved-critical-edit-model",
        };
        writeFileSync(
          join(spec.cwd, ".github", "workflows", "release.yml"),
          "name: release\non: push\n",
        );
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: "updated release workflow",
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([[adapter.id, adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "update workflow",
      mode: "agent",
      harnesses: [adapter.id],
      tests: [shellGate("true")],
      protectedPathApprovals: [
        { path: ".github/workflows/**", reason: "operator approved test path changes" },
      ],
      n: 1,
    });
    expect(legacyOutcome(res)).toBe("blocked");
    const review = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(review).toContain("protected-path change requires human approval");
    expect(review).toContain(".github/workflows/release.yml");
  });

  it("blocks renaming a built-in human path out of the protected glob", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: release\n");
    await runCapture("git", ["-C", repo, "add", ".github/workflows/release.yml"]);
    await runCapture("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "add workflow",
    ]);
    const adapter: HarnessAdapter = {
      ...diffImplementer("rename-critical-edit-impl"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "rename-critical-edit-model",
        };
        mkdirSync(join(spec.cwd, "scripts"), { recursive: true });
        await runCapture("git", [
          "-C",
          spec.cwd,
          "mv",
          ".github/workflows/release.yml",
          "scripts/release.yml",
        ]);
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: "moved release workflow",
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([[adapter.id, adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "move workflow",
      mode: "agent",
      harnesses: [adapter.id],
      tests: [shellGate("true")],
      n: 1,
    });
    expect(legacyOutcome(res)).toBe("blocked");
    const review = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(review).toContain("protected-path change requires human approval");
    expect(review).toContain(".github/workflows/release.yml");
  });

  it("does not treat newly-created package/test files as protected-path tamper", async () => {
    const repo = await initRepo();
    const adapter: HarnessAdapter = {
      ...diffImplementer("create-test-impl"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "create-test-model",
        };
        mkdirSync(join(spec.cwd, "test"), { recursive: true });
        writeFileSync(
          join(spec.cwd, "package.json"),
          JSON.stringify({ type: "module", scripts: { test: "node --test" } }, null, 2),
        );
        writeFileSync(
          join(spec.cwd, "test", "hello.test.js"),
          "import test from 'node:test';\ntest('ok', () => {});\n",
        );
        yield { type: "message", session_id: spec.session_id, ts, text: "created test scaffold" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([[adapter.id, adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "create test scaffold",
      mode: "agent",
      harnesses: [adapter.id],
      tests: [shellGate("true")],
      n: 1,
    });
    expect(legacyOutcome(res)).not.toBe("blocked");
    const review = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(review).not.toContain("candidate changed protected gate/test path");
  });

  it("flows project protected paths into policy for every diff operation and ignores run approvals", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, ".claudexor"), { recursive: true });
    mkdirSync(join(repo, "protected"), { recursive: true });
    mkdirSync(join(repo, "public"), { recursive: true });
    writeFileSync(
      join(repo, ".claudexor", "config.yaml"),
      "version: 1\nconstraints:\n  protected_paths:\n    - protected/**\n",
    );
    writeFileSync(join(repo, "protected", "modify.txt"), "before\n");
    writeFileSync(join(repo, "protected", "delete.txt"), "delete me\n");
    writeFileSync(join(repo, "protected", "rename-out.txt"), "move out\n");
    writeFileSync(join(repo, "public", "rename-in.txt"), "move in\n");
    await runCapture("git", ["-C", repo, "add", "-A"]);
    await runCapture("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "add protected-path fixtures",
    ]);

    const adapter: HarnessAdapter = {
      ...diffImplementer("project-protected-impl"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "project-protected-model",
        };
        writeFileSync(join(spec.cwd, "protected", "create.txt"), "created\n");
        writeFileSync(join(spec.cwd, "protected", "modify.txt"), "after\n");
        unlinkSync(join(spec.cwd, "protected", "delete.txt"));
        renameSync(
          join(spec.cwd, "protected", "rename-out.txt"),
          join(spec.cwd, "public", "renamed-out.txt"),
        );
        renameSync(
          join(spec.cwd, "public", "rename-in.txt"),
          join(spec.cwd, "protected", "renamed-in.txt"),
        );
        yield { type: "message", session_id: spec.session_id, ts, text: "changed files" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([[adapter.id, adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "exercise protected-path operations",
      mode: "agent",
      harnesses: [adapter.id],
      protectedPathApprovals: [
        { path: "protected/**", reason: "approval must narrow only auto-protected paths" },
      ],
      n: 1,
    });

    expect(legacyOutcome(res)).toBe("blocked");
    const taskYaml = readFileSync(join(res.runDir, "context", "task.yaml"), "utf8");
    expect(taskYaml).toContain("protected_paths:\n    - protected/**");
    const review = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    for (const path of [
      "protected/create.txt",
      "protected/modify.txt",
      "protected/delete.txt",
      "protected/rename-out.txt",
      "protected/renamed-in.txt",
    ]) {
      expect(review).toContain(path);
    }
    expect(review).toContain("protected-path change requires human approval");
  });

  it("refuses live in-place protected-path runs before adapter spawn", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, ".claudexor"), { recursive: true });
    mkdirSync(join(repo, "protected"), { recursive: true });
    writeFileSync(
      join(repo, ".claudexor", "config.yaml"),
      "version: 1\nconstraints:\n  protected_paths:\n    - protected/**\n",
    );
    writeFileSync(join(repo, "protected", "live.txt"), "before\n");
    let spawned = false;
    const adapter: HarnessAdapter = {
      ...diffImplementer("project-protected-live"),
      async *run(spec) {
        spawned = true;
        writeFileSync(join(spec.cwd, "protected", "live.txt"), "after\n");
        yield {
          type: "completed",
          session_id: spec.session_id,
          ts: new Date().toISOString(),
        };
      },
    };
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([[adapter.id, adapter]]),
      reviewers: [],
    });

    await expect(
      orch.run({
        repoRoot: repo,
        prompt: "edit protected live file",
        mode: "agent",
        harnesses: [adapter.id],
        inPlace: true,
        n: 1,
      }),
    ).rejects.toThrow(/protected_paths require an isolated execution root/);
    expect(spawned).toBe(false);
    expect(readFileSync(join(repo, "protected", "live.txt"), "utf8")).toBe("before\n");
  });

  it("allows protected-path policy inside a distinct persistent execution root", async () => {
    const repo = await initRepo();
    const isolated = await initRepo();
    mkdirSync(join(repo, ".claudexor"), { recursive: true });
    writeFileSync(
      join(repo, ".claudexor", "config.yaml"),
      "version: 1\nconstraints:\n  protected_paths:\n    - protected/**\n",
    );
    mkdirSync(join(isolated, "protected"), { recursive: true });
    writeFileSync(join(isolated, "protected", "thread.txt"), "before\n");
    await runCapture("git", ["-C", isolated, "add", "protected/thread.txt"]);
    await runCapture("git", [
      "-C",
      isolated,
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "add protected fixture",
    ]);
    const adapter: HarnessAdapter = {
      ...diffImplementer("project-protected-isolated"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        writeFileSync(join(spec.cwd, "protected", "thread.txt"), "after\n");
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([[adapter.id, adapter]]),
      reviewers: [],
    });
    const result = await orch.run({
      repoRoot: repo,
      executionRoot: isolated,
      prompt: "edit protected thread file",
      mode: "agent",
      harnesses: [adapter.id],
      inPlace: true,
      n: 1,
    });

    expect(legacyOutcome(result)).toBe("blocked");
    expect(readFileSync(join(isolated, "protected", "thread.txt"), "utf8")).toBe("after\n");
    expect(existsSync(join(repo, "protected", "thread.txt"))).toBe(false);
  });

  it("does not gate a candidate that misses project protected-path globs", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, ".claudexor"), { recursive: true });
    writeFileSync(
      join(repo, ".claudexor", "config.yaml"),
      "version: 1\nconstraints:\n  protected_paths:\n    - protected/**\n",
    );
    await runCapture("git", ["-C", repo, "add", "-A"]);
    await runCapture("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "add protected-path config",
    ]);
    const adapter = diffImplementer("project-protected-nonmatch");
    const registry = new Map<string, HarnessAdapter>([[adapter.id, adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "change an unrelated file",
      mode: "agent",
      harnesses: [adapter.id],
      n: 1,
    });

    expect(legacyOutcome(res)).not.toBe("blocked");
    const taskYaml = readFileSync(join(res.runDir, "context", "task.yaml"), "utf8");
    expect(taskYaml).toContain("protected_paths:\n    - protected/**");
  });

  it("blocks renaming an existing protected gate path out of the protected glob", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, "test"), { recursive: true });
    writeFileSync(
      join(repo, "test", "math.test.js"),
      "import test from 'node:test';\ntest('ok', () => {});\n",
    );
    await runCapture("git", ["-C", repo, "add", "test/math.test.js"]);
    await runCapture("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "add test",
    ]);
    const adapter: HarnessAdapter = {
      ...diffImplementer("rename-test-impl"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "rename-test-model",
        };
        mkdirSync(join(spec.cwd, "src"), { recursive: true });
        await runCapture("git", ["-C", spec.cwd, "mv", "test/math.test.js", "src/math-check.js"]);
        yield { type: "message", session_id: spec.session_id, ts, text: "renamed test" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([[adapter.id, adapter]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "do not edit tests",
      mode: "agent",
      harnesses: [adapter.id],
      tests: [shellGate("true")],
      n: 1,
    });
    expect(legacyOutcome(res)).toBe("blocked");
    const review = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(review).toContain("test/math.test.js");
    expect(review).toContain("severity: BLOCK");
  });

  it("rejects a primary harness outside the selected eligible pool", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["codex", realLikeAdapter("codex", "openai")],
      ["claude", realLikeAdapter("claude", "anthropic")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    await expect(
      orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["codex"],
        primaryHarness: "claude",
      }),
    ).rejects.toThrow(/primary harness 'claude'/);
  });

  it("GH #25: a multi-harness pool missing its configured primary is a structured ambiguity error with a copy-pasteable fix", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["claude", realLikeAdapter("claude", "anthropic")],
      ["cursor", realLikeAdapter("cursor", "google")],
    ]);
    const configDir = reapMk(join(tmpdir(), "claudexor-gh25-"));
    // Configured default primary is codex, which is NOT in the selected pool.
    writeFileSync(join(configDir, "config.yaml"), "routing:\n  primary_harness: codex\n");
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const orch = new Orchestrator({ registry, reviewers: [] });
      await expect(
        orch.run({
          repoRoot: repo,
          prompt: "x",
          mode: "agent",
          harnesses: ["claude", "cursor"],
          n: 2,
        }),
      ).rejects.toThrow(
        // Names the missing primary, the pool, and the exact copy-pasteable flag.
        /ambiguous primary.*codex.*\[claude, cursor\][\s\S]*--primary-harness claude/i,
      );
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    }
  });

  it("GH #25: an explicit --primary-harness inside a multi-harness pool is honored without a duplicate flag", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["claude", realLikeAdapter("claude", "anthropic")],
      ["cursor", realLikeAdapter("cursor", "google")],
    ]);
    const configDir = reapMk(join(tmpdir(), "claudexor-gh25-ok-"));
    writeFileSync(join(configDir, "config.yaml"), "routing:\n  primary_harness: codex\n");
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const orch = new Orchestrator({ registry, reviewers: [] });
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["claude", "cursor"],
        primaryHarness: "claude",
        n: 2,
      });
      // Pinning the primary resolves the ambiguity — the run proceeds.
      expect(res.lifecycle).not.toBe("failed");
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    }
  });

  it("does not persist secret-like tokens from generated patch diffs", async () => {
    const repo = await initRepo();
    const secret = "sk-" + "a".repeat(24);
    const adapter: HarnessAdapter = {
      id: "leaky",
      async discover() {
        return HarnessManifest.parse({
          id: "leaky",
          display_name: "leaky",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { implement: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "leaky",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        writeFileSync(join(spec.cwd, ".env"), `OPENAI_API_KEY=${secret}\n`);
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const orch = new Orchestrator({ registry: new Map([["leaky", adapter]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["leaky"],
      n: 1,
    });
    // The leaky candidate is refused before any artifact persists; with zero
    // working candidates the run fails with the ROOT CAUSE (no corpse review,
    // no empty final patch pretending to be a work product).
    expect(legacyOutcome(res)).toBe("failed");
    expect(res.summary).toContain("could not be proven secret-safe");
    expect(existsSync(join(res.runDir, "final", "patch.diff"))).toBe(false);
    expect(existsSync(join(res.runDir, "attempts", "a01", "patch.diff"))).toBe(false);
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).not.toContain(secret);
  });

  it("fails loudly when no available harness can perform the intent", async () => {
    const repo = await initRepo();
    let configuredPrimaryRan = false;
    const configuredPrimary: HarnessAdapter = {
      ...realLikeAdapter("codex"),
      async *run(spec) {
        configuredPrimaryRan = true;
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const registry = new Map<string, HarnessAdapter>([
      ["raw-ish", noImplementAdapter("raw-ish")],
      ["codex", configuredPrimary],
    ]);
    const res = await withScopedConfigDir(async () => {
      writeFileSync(
        join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml"),
        "routing:\n  primary_harness: codex\n",
      );
      const orch = new Orchestrator({ registry, reviewers: [] });
      return orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["raw-ish"],
        n: 1,
      });
    });
    expect(legacyOutcome(res)).toBe("failed");
    expect(res.candidates).toEqual([]);
    expect(configuredPrimaryRan).toBe(false);
    // QA-043: an explicitly selected incompatible lane now fails loudly by NAME
    // at routing preflight (a per-lane refusal), not the generic empty-pool
    // "no harness can perform" message.
    expect(res.summary).toMatch(/raw-ish.*cannot/i);
    expect(readFileSync(join(res.runDir, "context", "context_error.md"), "utf8")).toMatch(
      /raw-ish.*cannot/i,
    );
  });

  it("records an ask routing failure as inspectable artifacts instead of crashing the run", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["raw-ish", noImplementAdapter("raw-ish")]]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "2+2?",
      mode: "ask",
      harnesses: ["raw-ish"],
    });
    expect(legacyOutcome(res)).toBe("failed");
    // QA-043: explicit single-lane refusal is a loud per-lane message by name.
    expect(res.summary).toMatch(/raw-ish.*cannot/i);
    expect(existsSync(join(res.runDir, "context", "context_error.md"))).toBe(true);
    expect(readFileSync(join(res.runDir, "final", "summary.md"), "utf8")).toContain(
      "Lifecycle: failed",
    );
  });

  it("treats a whitespace-only ask answer exactly like an empty one (no phantom deliverable)", async () => {
    // Symmetry with the plan path's trim: on a constrained route the D-16
    // envelope's `output` slot arrives VERBATIM, and the artifact wrapper
    // heading makes final/answer.md non-empty by construction — an untrimmed
    // whitespace answer used to claim deliverable_present=true for
    // effectively no output.
    const repo = await initRepo();
    const base = askAdapter("asker", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield {
        type: "message",
        session_id: sessionId,
        ts,
        text: JSON.stringify({
          work_report: { state: "completed", required_inputs: [] },
          output: "   \n\t ",
        }),
      };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const asker: HarnessAdapter = {
      ...base,
      async discover() {
        return HarnessManifest.parse({
          id: "asker",
          display_name: "asker",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: {
            plan: true,
            review: true,
            read_files: true,
            web_policy: "tools",
            work_report_transport: "constrained",
            json_schema_output: true,
            structured_output_channel: "final_message",
          },
          access_profiles_supported: ["readonly"],
        });
      },
    };
    const res = await new Orchestrator({
      registry: new Map([["asker", asker]]),
      reviewers: [],
    }).run({ repoRoot: repo, prompt: "2+2?", mode: "ask", harnesses: ["asker"] });

    // The effectively empty answer is normalized to the same honest marker an
    // empty answer gets — raw whitespace is never shipped as content.
    expect(readFileSync(join(res.runDir, "final", "answer.md"), "utf8")).toContain("(no output)");
    const telemetry = new ArtifactStore(repo).readYaml<{
      attempts?: Array<{ outcome?: { deliverable_present?: boolean; status?: string } }>;
    }>(join(res.runDir, "final", "telemetry.yaml"));
    expect(telemetry?.attempts?.[0]?.outcome?.deliverable_present).toBe(false);
    // Terminal axes: the adapter completed CLEANLY with an honestly empty
    // answer — that is a succeeded run with no deliverable, never a fake
    // harness failure (the trim fix must not convert a phantom deliverable
    // into a phantom harness error). The attempt record agrees: a clean
    // empty completion is a success, not a fake contract failure.
    expect(telemetry?.attempts?.[0]?.outcome?.status).toBe("success");
    expect(res.lifecycle).toBe("succeeded");
    expect(res.facts.reason ?? null).toBeNull();
  });

  it("an ask harness ERROR with no deliverable still fails the run (honest-empty never masks a real failure)", async () => {
    const repo = await initRepo();
    const asker = askAdapter("asker", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield { type: "error", session_id: sessionId, ts, error: "vendor process crashed" };
    });
    const res = await new Orchestrator({
      registry: new Map([["asker", asker]]),
      reviewers: [],
    }).run({ repoRoot: repo, prompt: "2+2?", mode: "ask", harnesses: ["asker"] });
    expect(res.lifecycle).toBe("failed");
    expect(res.facts.reason).toBe("harness_failed");
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "vendor process crashed",
    );
  });

  it("a deliverable-less ask still hard-fails on an unrecovered tool error", async () => {
    // The honest-empty completion (previous tests) applies only to a CLEAN
    // attempt: with no deliverable, the first unrecovered tool error stays a
    // hard harness failure (INV-043/INV-044 deliverable exception).
    const repo = await initRepo();
    const asker = askAdapter("asker", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield {
        type: "tool_call",
        session_id: sessionId,
        ts,
        text: "Bash",
        tool: { name: "Bash", kind: "command", use_id: "t1", target: "cat notes.md" },
      };
      yield {
        type: "tool_result",
        session_id: sessionId,
        ts,
        tool: {
          name: "Bash",
          kind: "command",
          use_id: "t1",
          status: "error",
          error_summary: "command not found",
        },
      };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const res = await new Orchestrator({
      registry: new Map([["asker", asker]]),
      reviewers: [],
    }).run({ repoRoot: repo, prompt: "2+2?", mode: "ask", harnesses: ["asker"] });
    expect(res.lifecycle).toBe("failed");
    expect(res.facts.reason).toBe("harness_failed");
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "failed without recovery",
    );
  });

  it("QA-050: a zero-budget Ask refusal is a typed budget failure (phase=budget, code=finite_zero, route preserved) with budget remediation, never auth/setup", async () => {
    const repo = await initRepo();
    const asker = askAdapter("asker", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield { type: "message", session_id: sessionId, ts, text: "should never run" };
      yield { type: "completed", session_id: sessionId, ts };
    });
    let started = false;
    const inner = asker.run.bind(asker);
    asker.run = (spec) => {
      started = true;
      return inner(spec);
    };
    const res = await new Orchestrator({
      registry: new Map([["asker", asker]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "Answer only ZERO_BUDGET_CANARY",
      mode: "ask",
      harnesses: ["asker"],
      paidBudget: { kind: "finite", maxUsd: 0 },
    });
    // The safety gate refused BEFORE the harness spawned.
    expect(started).toBe(false);
    expect(res.lifecycle).toBe("failed");
    expect(res.facts.reason).toBe("budget_exhausted");
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).toMatch(/phase: budget/);
    expect(failure).toMatch(/category: budget/);
    expect(failure).toMatch(/code: finite_zero/);
    // The refused route/slot is named, not null (QA-050 lost these).
    expect(failure).toMatch(/harnessId: asker/);
    expect(failure).toMatch(/attemptId: a01/);
    // The remediation names the budget control and NEVER auth/setup.
    expect(failure).toMatch(/--max-usd|Budget/);
    expect(failure).not.toMatch(/[Cc]heck harness authentication/);
    expect(failure).not.toMatch(/Retry after setup/);
    // The diagnostic heading is the budget cause, not "Harness Error".
    expect(readFileSync(join(res.runDir, "context", "context_error.md"), "utf8")).toMatch(
      /Budget Denied/,
    );
  });

  it("forwards attachments into read-only ask harness specs", async () => {
    const repo = await initRepo();
    const note = join(repo, "note.txt");
    writeFileSync(note, "hello\n");
    const attachment = {
      resource_id: "res-1",
      kind: "file" as const,
      mime: "text/plain",
      name: "note.txt",
      sha256: `sha256:${createHash("sha256").update("hello\n").digest("hex")}`,
      size_bytes: 6,
      path: note,
    };
    let observedAttachments: unknown;
    const adapter: HarnessAdapter = {
      id: "asker",
      async discover() {
        return HarnessManifest.parse({
          id: "asker",
          display_name: "asker",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { read_files: true },
          capability_profile: {
            attachment_inputs: [
              {
                kind: "file",
                mime_types: ["text/plain"],
                max_bytes: 1024,
                max_count: 1,
                transport: "text_inline",
              },
            ],
          },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "asker",
          status: "ok",
          enabled_intents: ["explain"],
        });
      },
      async *run(spec) {
        observedAttachments = spec.attachments;
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        yield { type: "message", session_id: spec.session_id, ts, text: "saw the note" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const res = await new Orchestrator({
      registry: new Map([["asker", adapter]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "Read this attachment",
      mode: "ask",
      harnesses: ["asker"],
      attachments: [attachment],
    });
    expect(legacyOutcome(res)).toBe("success");
    expect(observedAttachments).toEqual([attachment]);
  });

  it("forwards Plan attachments to the planner HarnessRunSpec with readable source bytes", async () => {
    const repo = await initRepo();
    const brief = join(repo, "brief.txt");
    const bytes = "PLAN_ATTACHMENT_SENTINEL\n";
    writeFileSync(brief, bytes);
    const attachment = {
      resource_id: "res-plan-1",
      kind: "file" as const,
      mime: "text/plain",
      name: "brief.txt",
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size_bytes: Buffer.byteLength(bytes),
      path: brief,
    };
    let observedAttachments: unknown;
    let observedBytes = "";
    const planner: HarnessAdapter = {
      id: "planner",
      async discover() {
        return HarnessManifest.parse({
          id: "planner",
          display_name: "planner",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { plan: true, read_files: true },
          capability_profile: {
            attachment_inputs: [
              {
                kind: "file",
                mime_types: ["text/plain"],
                max_bytes: 1024,
                max_count: 1,
                transport: "text_inline",
              },
            ],
          },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "planner",
          status: "ok",
          enabled_intents: ["plan"],
        });
      },
      async *run(spec) {
        observedAttachments = spec.attachments;
        observedBytes = readFileSync(spec.attachments[0]!.path, "utf8");
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        yield { type: "message", session_id: spec.session_id, ts, text: "Plan from brief" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const res = await new Orchestrator({
      registry: new Map([["planner", planner]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "Plan from the attached brief",
      mode: "plan",
      harnesses: ["planner"],
      attachments: [attachment],
    });
    expect(legacyOutcome(res)).toBe("success");
    expect(observedAttachments).toEqual([attachment]);
    expect(observedBytes).toBe(bytes);
  });

  it("refuses an unknown or disabled --profile LOUDLY instead of falling into the default auto-pool", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-profile-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: off",
        "    harness_id: asker",
        "    display_name: Off",
        "    credential_kind: api_key",
        "    secret_ref: 'openai:off'",
        "    enabled: false",
        "",
      ].join("\n"),
    );
    try {
      const asker = askAdapter("asker", function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        yield { type: "message", session_id: sessionId, ts, text: "4" };
        yield { type: "completed", session_id: sessionId, ts };
      });
      const orchestrator = new Orchestrator({
        registry: new Map([["asker", asker]]),
        reviewers: [],
      });
      const ghost = await orchestrator.run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        credentialProfileId: "ghost",
      });
      expect(legacyOutcome(ghost)).toBe("failed");
      expect(ghost.summary).toMatch(/credential profile "ghost" is not registered/);
      const off = await orchestrator.run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        credentialProfileId: "off",
      });
      expect(legacyOutcome(off)).toBe("failed");
      expect(off.summary).toMatch(/credential profile "off" is disabled/);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("stamps the resolved credential profile on BOTH the read-only and candidate lane specs (INV-135)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-profile-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: work",
        "    harness_id: asker",
        "    display_name: Work",
        "    credential_kind: api_key",
        "    secret_ref: 'openai:work'",
        "  - profile_id: work",
        "    harness_id: fake-impl",
        "    display_name: Work",
        "    credential_kind: api_key",
        "    secret_ref: 'openai:work'",
        "",
      ].join("\n"),
    );
    try {
      const askSeen: unknown[] = [];
      const asker = askAdapter("asker", function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        yield { type: "message", session_id: sessionId, ts, text: "4" };
        yield { type: "completed", session_id: sessionId, ts };
      });
      const askerRun = asker.run.bind(asker);
      asker.run = (spec) => {
        askSeen.push(spec.credential_profile);
        return askerRun(spec);
      };
      const askRes = await new Orchestrator({
        registry: new Map([["asker", asker]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        credentialProfileId: "work",
      });
      expect(legacyOutcome(askRes)).toBe("success");
      expect(askSeen).toHaveLength(1);
      expect(askSeen[0]).toMatchObject({ profile_id: "work", credential_kind: "api_key" });

      const implSeen: unknown[] = [];
      const impl = diffImplementer("fake-impl");
      const implRun = impl.run.bind(impl);
      impl.run = (spec) => {
        implSeen.push(spec.credential_profile);
        return implRun(spec);
      };
      const agentRes = await new Orchestrator({
        registry: new Map([["fake-impl", impl]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "do it",
        mode: "agent",
        harnesses: ["fake-impl"],
        n: 1,
        credentialProfileId: "work",
      });
      expect(legacyOutcome(agentRes)).not.toBe("failed");
      expect(implSeen.length).toBeGreaterThan(0);
      expect(implSeen[0]).toMatchObject({ profile_id: "work", credential_kind: "api_key" });
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("routes an unpinned run to the native default (no profile); an explicit pin selects a profile (INV-135; F1: Active removed)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-active-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: work",
        "    harness_id: asker",
        "    display_name: Work",
        "    credential_kind: api_key",
        "    secret_ref: 'openai:work'",
        "  - profile_id: alt",
        "    harness_id: asker",
        "    display_name: Alt",
        "    credential_kind: api_key",
        "    secret_ref: 'openai:alt'",
        "harnesses:",
        "  asker: {}",
        "",
      ].join("\n"),
    );
    const stamp = () => {
      const seen: unknown[] = [];
      const asker = askAdapter("asker", function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        yield { type: "message", session_id: sessionId, ts, text: "4" };
        yield { type: "completed", session_id: sessionId, ts };
      });
      const inner = asker.run.bind(asker);
      asker.run = (spec) => {
        seen.push(spec.credential_profile);
        return inner(spec);
      };
      return { asker, seen };
    };
    try {
      // No pin → the native default subject (no credential profile). Enabled
      // profiles never become a silent auto-default (F1: Active removed).
      const a = stamp();
      const activeRes = await new Orchestrator({
        registry: new Map([["asker", a.asker]]),
        reviewers: [],
      }).run({ repoRoot: repo, prompt: "2+2?", mode: "ask", harnesses: ["asker"] });
      expect(legacyOutcome(activeRes)).toBe("success");
      expect(a.seen[0] ?? null).toBeNull();

      // An explicit --profile pin selects that profile.
      const b = stamp();
      const pinnedRes = await new Orchestrator({
        registry: new Map([["asker", b.asker]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        credentialProfileId: "alt",
      });
      expect(legacyOutcome(pinnedRes)).toBe("success");
      expect(b.seen[0]).toMatchObject({ profile_id: "alt" });
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("excludes the native/CLI login when native_credentials_enabled=false; an unpinned run refuses naming the setting; an explicit pin still routes (INV-135; F1)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-native-off-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    const mkAsker = () => {
      const seen: unknown[] = [];
      const prefs: string[] = [];
      const asker = askAdapter("asker", function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        yield { type: "message", session_id: sessionId, ts, text: "4" };
        yield { type: "completed", session_id: sessionId, ts };
      });
      const inner = asker.run.bind(asker);
      asker.run = (spec) => {
        seen.push(spec.credential_profile);
        prefs.push(spec.auth_preference ?? "auto");
        return inner(spec);
      };
      return { asker, seen, prefs };
    };
    try {
      // Native disabled, no rows, no pin, SUBSCRIPTION-only preference →
      // nothing routable, refuse LOUDLY naming the setting; never silently
      // fall back into the login (INV-135).
      writeFileSync(
        join(configDir, "config.yaml"),
        ["harnesses:", "  asker:", "    native_credentials_enabled: false", ""].join("\n"),
      );
      const off = mkAsker();
      const refused = await new Orchestrator({
        registry: new Map([["asker", off.asker]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        authPreference: "subscription",
      });
      expect(legacyOutcome(refused)).toBe("failed");
      expect(refused.summary).toMatch(/native_credentials_enabled=false/);
      expect(off.seen).toHaveLength(0);

      // Same exclusion under the default `auto` preference (Q3=A): auto never
      // silently takes the paid route — the run refuses typed instead of
      // spawning, and nothing ever falls back INTO the disabled login.
      const autoOff = mkAsker();
      const autoRefused = await new Orchestrator({
        registry: new Map([["asker", autoOff.asker]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
      });
      expect(legacyOutcome(autoRefused)).toBe("failed");
      expect(autoOff.seen).toHaveLength(0);

      // Only the EXPLICIT api_key preference opts the run onto the typed
      // PAID route (INV-061) — the spec carries auth_preference=api_key so
      // the adapter can never spawn back INTO the disabled login, and the
      // fallback is disclosed.
      const paid = mkAsker();
      const paidEvents: string[] = [];
      const paidRes = await new Orchestrator({
        registry: new Map([["asker", paid.asker]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        authPreference: "api_key",
        onEvent: (event) => paidEvents.push(event.type),
      });
      expect(legacyOutcome(paidRes)).toBe("success");
      expect(paid.seen).toEqual([null]);
      expect(paid.prefs).toEqual(["api_key"]);
      expect(paidEvents).toContain("route.account.pool_exhausted");

      // Native disabled but an explicit --profile pin is given → the pin routes.
      writeFileSync(
        join(configDir, "config.yaml"),
        [
          "credential_profiles:",
          "  - profile_id: work",
          "    harness_id: asker",
          "    display_name: Work",
          "    credential_kind: api_key",
          "    secret_ref: 'openai:work'",
          "harnesses:",
          "  asker:",
          "    native_credentials_enabled: false",
          "",
        ].join("\n"),
      );
      const on = mkAsker();
      const routed = await new Orchestrator({
        registry: new Map([["asker", on.asker]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        credentialProfileId: "work",
      });
      expect(legacyOutcome(routed)).toBe("success");
      expect(on.seen[0]).toMatchObject({ profile_id: "work" });
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("reactively rotates an UNPINNED pool row on a TYPED vendor limit — new session, new profile, provenance (W5.4, unified model)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-reactive-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: a",
        "    harness_id: limited",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profile-a")}'`,
        "  - profile_id: b",
        "    harness_id: limited",
        "    display_name: B",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profile-b")}'`,
        "  - profile_id: c",
        "    harness_id: limited",
        "    display_name: C",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profile-c")}'`,
        "harnesses:",
        "  limited:",
        "    profile_policy:",
        "      limit_action: rotate",
        "",
      ].join("\n"),
    );
    try {
      const spawns: Array<{ profile: string | null; session: string }> = [];
      const probedProfiles: string[] = [];
      const adapter: HarnessAdapter = {
        id: "limited",
        async discover() {
          return HarnessManifest.parse({
            id: "limited",
            display_name: "limited",
            kind: "local_cli",
            provider_family: "local",
            capabilities: { implement: true },
            access_profiles_supported: ["workspace_write"],
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: "limited",
            status: "ok",
            enabled_intents: ["implement"],
          });
        },
        async probeCredentialProfile(profile) {
          probedProfiles.push(profile.profile_id);
          return {
            profile_id: profile.profile_id,
            harness_id: "limited",
            availability: profile.profile_id === "b" ? "unavailable" : "available",
            verification: profile.profile_id === "b" ? "failed" : "passed",
            verification_source: "local_store",
            detail:
              profile.profile_id === "b" ? "profile login expired" : "fixture profile verified",
            last_verified_at: new Date().toISOString(),
          };
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          spawns.push({
            profile: spec.credential_profile?.profile_id ?? null,
            session: spec.session_id,
          });
          yield {
            type: "started",
            session_id: spec.session_id,
            ts,
            credential_profile_id: spec.credential_profile?.profile_id,
            payload: { native_session_id: `native-${spawns.length}` },
          };
          if (spawns.length === 1) {
            // The TYPED vendor-limit signal, then a terminating error with an
            // EMPTY deliverable — exactly the rotation_retry_eligible shape.
            yield {
              type: "status",
              session_id: spec.session_id,
              ts,
              text: "api_retry: rate limited",
              status: { kind: "api_retry", error_category: "rate_limit" },
              rate_limit: { resets_at: null, retry_delay_ms: 60_000 },
            };
            yield {
              type: "error",
              session_id: spec.session_id,
              ts,
              error: "vendor rate limit exhausted",
            };
            yield { type: "completed", session_id: spec.session_id, ts };
            return;
          }
          writeFileSync(join(spec.cwd, "CHANGED.txt"), "made it\n");
          yield { type: "message", session_id: spec.session_id, ts, text: "Implemented." };
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      };
      const events: string[] = [];
      const res = await new Orchestrator({
        registry: new Map([["limited", adapter]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "do it",
        mode: "agent",
        harnesses: ["limited"],
        n: 1,
        onEvent: (event) => events.push(event.type),
      });
      expect(legacyOutcome(res)).not.toBe("failed");
      // The UNPINNED pool selects "a" (deterministic id tie-break among
      // unknown-quota rows); the typed vendor limit rotates to the next READY
      // pool sibling — b's expired login is skipped, c spawns fresh.
      expect(spawns.map((s) => s.profile)).toEqual(["a", "c"]);
      // A7's SIBLING differential probe of the CURRENT subject fires on the
      // rotation-eligible failure — a doctor probe, never a spawned attempt
      // (the spawn pin above stays two runs).
      expect(probedProfiles).toContain("a");
      expect(probedProfiles).toContain("c");
      // Failover is a NEW vendor session under the new credential.
      expect(new Set(spawns.map((s) => s.session)).size).toBe(2);
      expect(events).toContain("route.profile.rotated");
      // The run's auth-route receipt carries the EFFECTIVE profile of the
      // deciding attempt (release scope review, cross_module_bugs): after the
      // a→b failover the receipt must say "b", never the requested "a".
      const telemetry = new ArtifactStore(repo).readYaml<{
        auth_route?: { profile_id?: string | null };
      }>(join(res.runDir, "final", "telemetry.yaml"));
      expect(telemetry?.auth_route?.profile_id).toBe("c");
      // The APPLIED facts must agree with the route receipt. This block is
      // derived once before spawn, so a rotation left it naming the requested
      // "a" — a run's own record claiming a credential that never ran it.
      const attempt = new ArtifactStore(repo).readYaml<{
        credential_profile_applied?: string | null;
      }>(join(res.runDir, "attempts", "a01", "attempt.yaml"));
      expect(attempt?.credential_profile_applied).toBe("c");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("an UNPINNED thread turn stays on its bound account; an unusable binding switches with a DISCLOSED lane switch (D-U1 order 2, Q1=A)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-binding-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: a",
        "    harness_id: asker",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profile-a")}'`,
        "  - profile_id: b",
        "    harness_id: asker",
        "    display_name: B",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profile-b")}'`,
        "",
      ].join("\n"),
    );
    try {
      const mk = (unreadyId: string | null) => {
        const seen: Array<string | null> = [];
        const asker = askAdapter("asker", function* (sessionId) {
          const ts = new Date().toISOString();
          yield { type: "started", session_id: sessionId, ts };
          yield { type: "message", session_id: sessionId, ts, text: "4" };
          yield { type: "completed", session_id: sessionId, ts };
        });
        asker.probeCredentialProfile = async (profile) => ({
          profile_id: profile.profile_id,
          harness_id: "asker",
          availability: profile.profile_id === unreadyId ? "unavailable" : "available",
          verification: profile.profile_id === unreadyId ? "failed" : "passed",
          verification_source: "local_store",
          detail: profile.profile_id === unreadyId ? "login expired" : "fixture verified",
          last_verified_at: new Date().toISOString(),
        });
        const inner = asker.run.bind(asker);
        asker.run = (spec) => {
          seen.push(spec.credential_profile?.profile_id ?? null);
          return inner(spec);
        };
        return { asker, seen };
      };
      // Healthy binding: the thread stays on "b" even though the pool's
      // deterministic tie-break would pick "a" — stickiness beats ranking.
      const sticky = mk(null);
      const stickyEvents: string[] = [];
      const stickyRes = await new Orchestrator({
        registry: new Map([["asker", sticky.asker]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        threadAccountBindings: { asker: "b" },
        onEvent: (event) => stickyEvents.push(event.type),
      });
      expect(legacyOutcome(stickyRes)).toBe("success");
      expect(sticky.seen).toEqual(["b"]);
      expect(stickyEvents).not.toContain("route.account.lane_switch");

      // The bound account became unusable: the run switches to the pool
      // sibling and DISCLOSES the lane switch — never silent (Q1=A).
      const switched = mk("b");
      const switchedEvents: string[] = [];
      const switchedRes = await new Orchestrator({
        registry: new Map([["asker", switched.asker]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        threadAccountBindings: { asker: "b" },
        onEvent: (event) => switchedEvents.push(event.type),
      });
      expect(legacyOutcome(switchedRes)).toBe("success");
      expect(switched.seen).toEqual(["a"]);
      expect(switchedEvents).toContain("route.account.lane_switch");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("an EXPLICIT pin never rotates on a typed vendor limit — strict, the attempt fails with its evidence (D-U6)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-pin-strict-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: a",
        "    harness_id: limited",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profile-a")}'`,
        "  - profile_id: c",
        "    harness_id: limited",
        "    display_name: C",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profile-c")}'`,
        "harnesses:",
        "  limited:",
        "    profile_policy:",
        "      limit_action: rotate",
        "",
      ].join("\n"),
    );
    try {
      const spawns: Array<string | null> = [];
      const adapter: HarnessAdapter = {
        id: "limited",
        async discover() {
          return HarnessManifest.parse({
            id: "limited",
            display_name: "limited",
            kind: "local_cli",
            provider_family: "local",
            capabilities: { implement: true },
            access_profiles_supported: ["workspace_write"],
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: "limited",
            status: "ok",
            enabled_intents: ["implement"],
          });
        },
        async probeCredentialProfile(profile) {
          return {
            profile_id: profile.profile_id,
            harness_id: "limited",
            availability: "available",
            verification: "passed",
            verification_source: "local_store",
            detail: "fixture profile verified",
            last_verified_at: new Date().toISOString(),
          };
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          spawns.push(spec.credential_profile?.profile_id ?? null);
          yield { type: "started", session_id: spec.session_id, ts };
          yield {
            type: "status",
            session_id: spec.session_id,
            ts,
            text: "api_retry: rate limited",
            status: { kind: "api_retry", error_category: "rate_limit" },
            rate_limit: { resets_at: null, retry_delay_ms: 60_000 },
          };
          yield { type: "error", session_id: spec.session_id, ts, error: "vendor rate limit" };
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      };
      const events: string[] = [];
      const res = await new Orchestrator({
        registry: new Map([["limited", adapter]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "do it",
        mode: "agent",
        harnesses: ["limited"],
        n: 1,
        credentialProfileId: "a",
        onEvent: (event) => events.push(event.type),
      });
      // The pinned account hit its vendor limit: no silent rotation onto "c",
      // and the attempt terminalizes TYPED (`subscription_window_exhausted`)
      // instead of burning same-profile transient retries on the refused
      // subject (D-U6 strict pin + the A5 ordering, preserved for pins).
      expect(legacyOutcome(res)).toBe("failed");
      expect(spawns).toEqual(["a"]);
      expect(events).not.toContain("route.profile.rotated");
      expect(events).not.toContain("route.transient.retry_scheduled");
      const failure = new ArtifactStore(repo).readYaml<Record<string, unknown>>(
        join(res.runDir, "final", "failure.yaml"),
      );
      expect(failure).toMatchObject({
        category: "harness_unavailable",
        code: "subscription_window_exhausted",
      });
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("resume never crosses profiles at the ENGINE boundary — A→B, A→default, default→A (INV-135)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-resume-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: b",
        "    harness_id: asker",
        "    display_name: B",
        "    credential_kind: api_key",
        "    secret_ref: 'openai:b'",
        "",
      ].join("\n"),
    );
    try {
      const resumes: Array<string | null> = [];
      const asker = askAdapter("asker", function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        yield { type: "message", session_id: sessionId, ts, text: "4" };
        yield { type: "completed", session_id: sessionId, ts };
      });
      const askerRun = asker.run.bind(asker);
      asker.run = (spec) => {
        resumes.push(spec.resume_session_id);
        return askerRun(spec);
      };
      const orch = () => new Orchestrator({ registry: new Map([["asker", asker]]), reviewers: [] });
      // A→B: session cached under profile "a", turn runs as profile "b" → fresh.
      await orch().run({
        repoRoot: repo,
        prompt: "q1",
        mode: "ask",
        harnesses: ["asker"],
        credentialProfileId: "b",
        resumeSessions: { asker: { sessionId: "sess-a", profileId: "a" } },
      });
      // A→default: cached under "a", turn runs as engine default → fresh.
      await orch().run({
        repoRoot: repo,
        prompt: "q2",
        mode: "ask",
        harnesses: ["asker"],
        resumeSessions: { asker: { sessionId: "sess-a", profileId: "a" } },
      });
      // default→A(b): cached under default, turn runs as "b" → fresh.
      await orch().run({
        repoRoot: repo,
        prompt: "q3",
        mode: "ask",
        harnesses: ["asker"],
        credentialProfileId: "b",
        resumeSessions: { asker: { sessionId: "sess-default", profileId: null } },
      });
      // Exact match (b→b) resumes.
      await orch().run({
        repoRoot: repo,
        prompt: "q4",
        mode: "ask",
        harnesses: ["asker"],
        credentialProfileId: "b",
        resumeSessions: { asker: { sessionId: "sess-b", profileId: "b" } },
      });
      expect(resumes).toEqual([null, null, null, "sess-b"]);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("read-only THREAD ask records its native session per lane and the NEXT lane turn resumes it in the SAME durable home (INV-034)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-lane-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const spawns: Array<{ resume: string | null; home?: string; codexHome?: string }> = [];
      const asker = askAdapter("asker", function* (sessionId) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: sessionId,
          ts,
          payload: { native_session_id: "nat-asker-1" },
        };
        yield { type: "message", session_id: sessionId, ts, text: "4" };
        yield { type: "completed", session_id: sessionId, ts };
      });
      const askerRun = asker.run.bind(asker);
      asker.run = (spec) => {
        spawns.push({
          resume: spec.resume_session_id,
          home: spec.env?.["HOME"],
          codexHome: spec.env?.["CODEX_HOME"],
        });
        return askerRun(spec);
      };
      // A minimal in-memory stand-in for the daemon's per-lane session store.
      const store: Record<string, { sessionId: string; profileId: string | null }> = {};
      const onSessionObserved = (
        harnessId: string,
        nativeSessionId: string,
        _model?: string | null,
        profileId?: string | null,
      ) => {
        store[harnessId] = { sessionId: nativeSessionId, profileId: profileId ?? null };
      };
      const resumeMap = (profileId: string | null) => {
        const out: Record<string, { sessionId: string; profileId: string | null }> = {};
        for (const [h, s] of Object.entries(store)) {
          if ((s.profileId ?? null) === profileId) out[h] = s;
        }
        return out;
      };
      const orch = () => new Orchestrator({ registry: new Map([["asker", asker]]), reviewers: [] });

      // Turn 1: nothing to resume; records nat-asker-1 under the null-default lane.
      await orch().run({
        repoRoot: repo,
        prompt: "q1",
        mode: "ask",
        harnesses: ["asker"],
        threadId: "th-lane",
        resumeSessions: resumeMap(null),
        onSessionObserved,
      });
      // Turn 2: the same lane resumes the recorded native session id.
      await orch().run({
        repoRoot: repo,
        prompt: "q2",
        mode: "ask",
        harnesses: ["asker"],
        threadId: "th-lane",
        resumeSessions: resumeMap(null),
        onSessionObserved,
      });

      expect(spawns[0]?.resume).toBeNull();
      expect(spawns[1]?.resume).toBe("nat-asker-1");
      // Both turns spawned in the SAME durable per-lane home.
      const laneHome = join(projectRuntimeDir(repo), "lanes", "th-lane", "asker-default", "home");
      expect(spawns[0]?.home).toBe(laneHome);
      expect(spawns[1]?.home).toBe(laneHome);
      expect(spawns[0]?.codexHome).toBe(join(laneHome, ".codex"));
      // The lane home PERSISTS after the run (never disposed with it).
      expect(existsSync(laneHome)).toBe(true);

      // A NON-thread read-only ask still gets a DISPOSABLE throwaway home that
      // is deleted after the run.
      await orch().run({
        repoRoot: repo,
        prompt: "q3",
        mode: "ask",
        harnesses: ["asker"],
      });
      const oneShotHome = spawns[2]?.home;
      expect(oneShotHome).toBeDefined();
      expect(oneShotHome).not.toBe(laneHome);
      expect(oneShotHome?.includes("claudexor-ro-")).toBe(true);
      expect(existsSync(oneShotHome as string)).toBe(false);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("an IMPLICIT pool with --profile routes to the PROFILE's harness even when its default store is logged out (round-18 BLOCK)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-implicit-pool-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: b",
        "    harness_id: asker",
        "    display_name: B",
        "    credential_kind: api_key",
        "    secret_ref: 'openai:b'",
        "",
      ].join("\n"),
    );
    try {
      const answered: string[] = [];
      const mkAsker = (id: string) =>
        askAdapter(id, function* (sessionId) {
          const ts = new Date().toISOString();
          answered.push(id);
          yield { type: "started", session_id: sessionId, ts };
          yield { type: "message", session_id: sessionId, ts, text: "4" };
          yield { type: "completed", session_id: sessionId, ts };
        });
      const asker = mkAsker("asker");
      // The profile's harness has a LOGGED-OUT default store...
      asker.doctor = async () =>
        ConformanceReport.parse({
          harness_id: "asker",
          status: "unavailable",
          enabled_intents: [],
          reasons: ["not authenticated (default store logged out)"],
        });
      asker.probeCredentialProfile = async (profile) => ({
        profile_id: profile.profile_id,
        harness_id: "asker",
        availability: "available",
        verification: "not_run",
        verification_source: "local_store",
        detail: "secret stored",
        last_verified_at: null,
      });
      // ...while an UNRELATED harness is doctor-OK. The old pool derivation
      // excluded asker (not doctor-OK) and kept other (which would later
      // fail profile resolution) — breaking `--profile` without `--harness`.
      const other = mkAsker("other");
      const res = await new Orchestrator({
        registry: new Map([
          ["asker", asker],
          ["other", other],
        ]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        credentialProfileId: "b",
        // NO harnesses: the implicit pool must be derived FROM the profile.
      });
      expect(legacyOutcome(res), res.summary).toBe("success");
      expect(answered).toEqual(["asker"]);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("an UNPINNED run routes through an enabled account row when the default doctor is unavailable (row-aware admission)", async () => {
    // After the cursor host-Keychain retirement the cursor default doctor can
    // never be OK from rows alone (and a named-rows-only claude/codex install
    // has a logged-out default store) — admission must overlay row readiness
    // into the harness status for UNPINNED runs exactly the way explicit pins
    // already do, for both the auto pool and an explicit --harness lane.
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-row-admission-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    const rowDir = join(configDir, "profiles", "asker-default");
    mkdirSync(rowDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: asker-default",
        "    harness_id: asker",
        "    display_name: Default row",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${rowDir}'`,
        "",
      ].join("\n"),
    );
    try {
      const answered: string[] = [];
      const mkAsker = () => {
        const adapter = askAdapter("asker", function* (sessionId) {
          const ts = new Date().toISOString();
          answered.push("asker");
          yield { type: "started", session_id: sessionId, ts };
          yield { type: "message", session_id: sessionId, ts, text: "4" };
          yield { type: "completed", session_id: sessionId, ts };
        });
        // The DEFAULT store is unavailable (host logins are not used); the
        // enabled registry row is signed in and probeable (askAdapter's
        // probeCredentialProfile answers available/passed).
        adapter.doctor = async () =>
          ConformanceReport.parse({
            harness_id: "asker",
            status: "unavailable",
            enabled_intents: [],
            reasons: ["host CLI logins are not used (unified account model)"],
          });
        return adapter;
      };
      // Auto pool: no --harness, no pin — the row-bearing harness must join.
      const auto = await new Orchestrator({
        registry: new Map([["asker", mkAsker()]]),
        reviewers: [],
      }).run({ repoRoot: repo, prompt: "2+2?", mode: "ask" });
      expect(legacyOutcome(auto), auto.summary).toBe("success");
      // Explicit --harness, still unpinned: the unavailable default status
      // must not refuse while an enabled row can serve the lane.
      const explicit = await new Orchestrator({
        registry: new Map([["asker", mkAsker()]]),
        reviewers: [],
      }).run({ repoRoot: repo, prompt: "2+2?", mode: "ask", harnesses: ["asker"] });
      expect(legacyOutcome(explicit), explicit.summary).toBe("success");
      expect(answered).toEqual(["asker", "asker"]);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("never rotates INTO a profile the vendor already rejected (auth_revoked)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-revoked-rotation-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: a",
        "    harness_id: limited",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", "limited-a"))}`,
        "  - profile_id: c",
        "    harness_id: limited",
        "    display_name: C",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", "limited-c"))}`,
        "harnesses:",
        "  limited:",
        "    profile_policy:",
        "      limit_action: rotate",
        "      rotation_eligible: [c]",
        "",
      ].join("\n"),
    );
    try {
      const spawns: string[] = [];
      const adapter: HarnessAdapter = {
        id: "limited",
        async discover() {
          return HarnessManifest.parse({
            id: "limited",
            display_name: "limited",
            kind: "local_cli",
            provider_family: "local",
            capabilities: { implement: true },
            access_profiles_supported: ["workspace_write"],
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: "limited",
            status: "ok",
            enabled_intents: ["implement"],
          });
        },
        // Both logins are present locally — c looks like a perfect failover.
        async probeCredentialProfile(profile) {
          return {
            profile_id: profile.profile_id,
            harness_id: "limited",
            availability: "available",
            verification: "passed",
            verification_source: "local_store",
            detail: "fixture profile verified",
            last_verified_at: new Date().toISOString(),
          };
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          spawns.push(spec.credential_profile?.profile_id ?? "none");
          yield {
            type: "started",
            session_id: spec.session_id,
            ts,
            credential_profile_id: spec.credential_profile?.profile_id,
            payload: { native_session_id: `native-${spawns.length}` },
          };
          yield {
            type: "status",
            session_id: spec.session_id,
            ts,
            text: "api_retry: rate limited",
            status: { kind: "api_retry", error_category: "rate_limit" },
            rate_limit: { resets_at: null, retry_delay_ms: 60_000 },
          };
          yield {
            type: "error",
            session_id: spec.session_id,
            ts,
            error: "vendor rate limit exhausted",
          };
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      };
      const events: string[] = [];
      await new Orchestrator({
        registry: new Map([["limited", adapter]]),
        reviewers: [],
        // The poller's authenticated call with c's own token was rejected.
        quotaAbsences: () => [
          {
            subject: {
              harness: "limited",
              credential_route: "vendor_native",
              plan_label: null,
              subject_id: "c",
            },
            reason: "auth_revoked",
            detail: "vendor rejected this key",
            observed_at: new Date().toISOString(),
          },
        ],
      }).run({
        repoRoot: repo,
        prompt: "do it",
        mode: "agent",
        harnesses: ["limited"],
        n: 1,
        onEvent: (event) => events.push(event.type),
      });
      // Rotating into a known-dead credential would spend a whole attempt to
      // rediscover the 401 the poller already reported.
      expect(spawns).not.toContain("c");
      expect(events).not.toContain("route.profile.rotated");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("refuses to dispatch into a profile the vendor already rejected (auth_revoked)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-revoked-profile-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: work",
        "    harness_id: asker",
        "    display_name: Work",
        "    credential_kind: config_dir_login",
        "    isolation_locator: /tmp/p/work",
        "",
      ].join("\n"),
    );
    try {
      const answered: string[] = [];
      const asker = askAdapter("asker", function* (sessionId) {
        const ts = new Date().toISOString();
        answered.push("asker");
        yield { type: "started", session_id: sessionId, ts };
        yield { type: "message", session_id: sessionId, ts, text: "4" };
        yield { type: "completed", session_id: sessionId, ts };
      });
      // The LOCAL store is perfectly happy: a login file is present.
      asker.probeCredentialProfile = async (profile) => ({
        profile_id: profile.profile_id,
        harness_id: "asker",
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        detail: "login present in the profile config dir",
        last_verified_at: null,
      });
      // The quota poller's last AUTHENTICATED vendor call with this profile's
      // own token was rejected. Admission must read that, not the login file.
      const run = () =>
        new Orchestrator({
          registry: new Map([["asker", asker]]),
          reviewers: [],
          quotaAbsences: () => [
            {
              subject: {
                harness: "asker",
                credential_route: "vendor_native",
                plan_label: null,
                subject_id: "work",
              },
              reason: "auth_revoked",
              detail: "oauth/usage responded 401",
              observed_at: new Date().toISOString(),
            },
          ],
        }).run({
          repoRoot: repo,
          prompt: "2+2?",
          mode: "ask",
          harnesses: ["asker"],
          credentialProfileId: "work",
        });
      const res = await run();
      expect(res.lifecycle).toBe("failed");
      expect(res.summary).toContain("credential profile is not ready");
      expect(res.summary).toContain("oauth/usage responded 401");
      // Nothing was spawned: the refusal happened before any spend.
      expect(answered).toEqual([]);
      expect(res.spendUsd).toBe(0);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("a selected api_key profile classifies the route by ITS kind — the default subscription cooldown does not apply (round-18 #2)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-profile-route-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: b",
        "    harness_id: asker",
        "    display_name: B",
        "    credential_kind: api_key",
        "    secret_ref: 'openai:b'",
        "  - profile_id: b",
        "    harness_id: helper",
        "    display_name: B2",
        "    credential_kind: api_key",
        "    secret_ref: 'openai:b'",
        "",
      ].join("\n"),
    );
    try {
      const asker = askAdapter("asker", function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        yield { type: "message", session_id: sessionId, ts, text: "4" };
        yield { type: "completed", session_id: sessionId, ts };
      });
      const base = asker.discover.bind(asker);
      asker.discover = async () =>
        HarnessManifest.parse({
          ...(await base()),
          // A native session exists, so WITHOUT the profile the estimated
          // route is local_session — under which the api_key-only model
          // below is NOT in the manifest truth and the run refuses.
          auth_modes: ["local_session"],
          capabilities: {
            plan: true,
            review: true,
            read_files: true,
            web_policy: "tools",
            known_models: [{ id: "m-key-only", routes: ["api_key"] }],
          },
        });
      const res = await new Orchestrator({
        registry: new Map([["asker", asker]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        credentialProfileId: "b",
        models: { asker: "m-key-only" },
      });
      // The api_key profile IS the route: the route-annotated model is valid
      // under it. A stale default-route classification (local_session from
      // auth_modes) would refuse the model against the manifest truth.
      expect(legacyOutcome(res), res.summary).toBe("success");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("a selected profile is authenticated by ITS store, not the default doctor verdict (round-13)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-override-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: b",
        "    harness_id: asker",
        "    display_name: B",
        "    credential_kind: api_key",
        "    secret_ref: 'openai:b'",
        "",
      ].join("\n"),
    );
    try {
      const asker = askAdapter("asker", function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        yield { type: "message", session_id: sessionId, ts, text: "4" };
        yield { type: "completed", session_id: sessionId, ts };
      });
      // The DEFAULT store is logged out: doctor says unavailable.
      asker.doctor = async () =>
        ConformanceReport.parse({
          harness_id: "asker",
          status: "unavailable",
          enabled_intents: [],
          reasons: ["not authenticated (default store logged out)"],
        });
      asker.probeCredentialProfile = async (profile) => ({
        profile_id: profile.profile_id,
        harness_id: "asker",
        availability: "available",
        verification: "not_run",
        verification_source: "local_store",
        detail: "secret stored",
        last_verified_at: null,
      });
      const res = await new Orchestrator({
        registry: new Map([["asker", asker]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        credentialProfileId: "b",
      });
      // The profile's own probe is the auth verdict — the logged-out default
      // must not reject a valid isolated profile.
      expect(legacyOutcome(res)).toBe("success");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("keeps an explicitly selected config-dir profile through bounded stale readiness", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-stale-profile-preflight-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: work",
        "    harness_id: asker",
        "    display_name: Work",
        "    credential_kind: config_dir_login",
        "    isolation_locator: /tmp/p/work",
        "",
      ].join("\n"),
    );
    try {
      const asker = askAdapter("asker", function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        yield { type: "message", session_id: sessionId, ts, text: "4" };
        yield { type: "completed", session_id: sessionId, ts };
      });
      asker.doctor = async () =>
        ConformanceReport.parse({
          harness_id: "asker",
          status: "unavailable",
          enabled_intents: [],
          reasons: ["default store probe failed"],
        });
      asker.probeCredentialProfile = async (profile) => ({
        profile_id: profile.profile_id,
        harness_id: profile.harness_id,
        availability: "unknown",
        verification: "not_run",
        verification_source: "local_store",
        stale: true,
        stale_age_ms: 42,
        detail: "auth-status probe is stale",
        last_verified_at: null,
      });
      const res = await new Orchestrator({
        registry: new Map([["asker", asker]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        credentialProfileId: "work",
      });
      expect(legacyOutcome(res), res.summary).toBe("success");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("does not dispatch a stale explicit pin whose credential ledger is condemned", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-stale-revoked-profile-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: work",
        "    harness_id: asker",
        "    display_name: Work",
        "    credential_kind: config_dir_login",
        "    isolation_locator: /tmp/p/work",
        "",
      ].join("\n"),
    );
    try {
      let starts = 0;
      const asker = askAdapter("asker", function* (sessionId) {
        starts += 1;
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        yield { type: "message", session_id: sessionId, ts, text: "4" };
        yield { type: "completed", session_id: sessionId, ts };
      });
      asker.doctor = async () =>
        ConformanceReport.parse({
          harness_id: "asker",
          status: "unavailable",
          enabled_intents: [],
          reasons: ["default auth-status probe failed"],
        });
      asker.probeCredentialProfile = async (profile) => ({
        profile_id: profile.profile_id,
        harness_id: profile.harness_id,
        availability: "unknown",
        verification: "not_run",
        verification_source: "local_store",
        stale: true,
        stale_age_ms: 42,
        detail: "auth-status probe is stale",
        last_verified_at: null,
      });
      const res = await new Orchestrator({
        registry: new Map([["asker", asker]]),
        reviewers: [],
        credentialUnusable: () => [
          {
            harness_id: "asker",
            profile_id: "work",
            model: null,
            code: "auth_revoked",
            source: "attempt_stream",
            detail: "the prior attempt was rejected by the vendor",
            observed_at: "2026-01-01T00:00:00.000Z",
            expires_at: "2099-01-01T00:00:00.000Z",
          },
        ],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        credentialProfileId: "work",
      });
      expect(legacyOutcome(res)).toBe("failed");
      expect(res.summary).toContain("credential is unusable");
      expect(res.summary).toContain("auth_revoked");
      expect(starts).toBe(0);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("a doctor-OK harness still refuses an unready selected profile before spawn", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-profile-preflight-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: work",
        "    harness_id: asker",
        "    display_name: Work",
        "    credential_kind: api_key",
        "    secret_ref: 'openai:work'",
        "",
      ].join("\n"),
    );
    try {
      let starts = 0;
      const asker = askAdapter("asker", function* (sessionId) {
        starts += 1;
        yield { type: "started", session_id: sessionId, ts: new Date().toISOString() };
      });
      asker.probeCredentialProfile = async (profile) => ({
        profile_id: profile.profile_id,
        harness_id: "asker",
        availability: "unavailable",
        verification: "failed",
        verification_source: "local_store",
        detail: "profile login expired",
        last_verified_at: null,
      });
      const orchestrator = new Orchestrator({
        registry: new Map([["asker", asker]]),
        reviewers: [],
      });
      const result = await orchestrator.run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        credentialProfileId: "work",
      });
      expect(legacyOutcome(result)).toBe("failed");
      expect(result.summary).toContain("profile login expired");
      expect(starts).toBe(0);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("reactively rotates in the READ-ONLY lane too (release wave round-13; unpinned pool)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-ro-rotate-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: a",
        "    harness_id: asker",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profile-a")}'`,
        "  - profile_id: b",
        "    harness_id: asker",
        "    display_name: B",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profile-b")}'`,
        "harnesses:",
        "  asker:",
        "    profile_policy:",
        "      limit_action: rotate",
        "",
      ].join("\n"),
    );
    try {
      const profilesSeen: Array<string | null> = [];
      const probedProfiles: string[] = [];
      const asker = askAdapter("asker", function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        if (profilesSeen.length === 1) {
          yield {
            type: "status",
            session_id: sessionId,
            ts,
            text: "api_retry: rate limited",
            status: { kind: "api_retry", error_category: "rate_limit" },
            rate_limit: { resets_at: null, retry_delay_ms: 60_000 },
          };
          yield { type: "error", session_id: sessionId, ts, error: "vendor rate limit exhausted" };
          yield { type: "completed", session_id: sessionId, ts };
          return;
        }
        yield { type: "message", session_id: sessionId, ts, text: "4" };
        yield { type: "completed", session_id: sessionId, ts };
      });
      asker.probeCredentialProfile = async (profile) => {
        probedProfiles.push(profile.profile_id);
        return {
          profile_id: profile.profile_id,
          harness_id: "asker",
          availability: "available",
          verification: "passed",
          verification_source: "local_store",
          detail: "fixture profile verified",
          last_verified_at: new Date().toISOString(),
        };
      };
      const askerRun = asker.run.bind(asker);
      asker.run = (spec) => {
        profilesSeen.push(spec.credential_profile?.profile_id ?? null);
        return askerRun(spec);
      };
      const events: string[] = [];
      const res = await new Orchestrator({
        registry: new Map([["asker", asker]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        onEvent: (event) => events.push(event.type),
      });
      expect(legacyOutcome(res)).toBe("success");
      // Unpinned pool selects "a" (id tie-break); the typed limit rotates the
      // read-only lane onto the next ready pool sibling. A7's sibling
      // differential probe of the current subject rides the same decision
      // (doctor probe only — profilesSeen proves no third attempt ran).
      expect(profilesSeen).toEqual(["a", "b"]);
      expect(probedProfiles).toContain("a");
      expect(probedProfiles).toContain("b");
      expect(events).toContain("route.profile.rotated");
      expect(events).toContain("route.account.pool_selected");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("mid-turn rotation re-keys the LANE home to the rotated row and the next turn resumes its session (INV-137)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-rot-lane-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: a",
        "    harness_id: asker",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profile-a")}'`,
        "  - profile_id: b",
        "    harness_id: asker",
        "    display_name: B",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profile-b")}'`,
        "harnesses:",
        "  asker:",
        "    profile_policy:",
        "      limit_action: rotate",
        "",
      ].join("\n"),
    );
    try {
      const spawns: Array<{ profile: string | null; home?: string; resume: string | null }> = [];
      const asker = askAdapter("asker", function* () {
        /* replaced below */
      });
      asker.run = async function* (spec) {
        const ts = new Date().toISOString();
        const profile = spec.credential_profile?.profile_id ?? null;
        spawns.push({ profile, home: spec.env?.["HOME"], resume: spec.resume_session_id ?? null });
        if (spawns.length === 1) {
          yield { type: "started", session_id: spec.session_id, ts } as never;
          yield {
            type: "status",
            session_id: spec.session_id,
            ts,
            text: "api_retry: rate limited",
            status: { kind: "api_retry", error_category: "rate_limit" },
            rate_limit: { resets_at: null, retry_delay_ms: 60_000 },
          } as never;
          yield {
            type: "error",
            session_id: spec.session_id,
            ts,
            error: "vendor rate limit exhausted",
          } as never;
          yield { type: "completed", session_id: spec.session_id, ts } as never;
          return;
        }
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          credential_profile_id: profile,
          payload: { native_session_id: "nat-rot-1" },
        } as never;
        yield { type: "message", session_id: spec.session_id, ts, text: "4" } as never;
        yield { type: "completed", session_id: spec.session_id, ts } as never;
      };
      const store: Record<string, { sessionId: string; profileId: string | null }> = {};
      const onSessionObserved = (
        harnessId: string,
        nativeSessionId: string,
        _model?: string | null,
        profileId?: string | null,
      ) => {
        store[harnessId] = { sessionId: nativeSessionId, profileId: profileId ?? null };
      };
      const orch = () => new Orchestrator({ registry: new Map([["asker", asker]]), reviewers: [] });
      // Turn 1: the pool selects "a"; its typed vendor limit rotates the turn
      // onto "b" MID-ATTEMPT.
      await orch().run({
        repoRoot: repo,
        prompt: "q1",
        mode: "ask",
        harnesses: ["asker"],
        threadId: "th-rot",
        resumeSessions: {},
        onSessionObserved,
      });
      const laneHomeA = join(projectRuntimeDir(repo), "lanes", "th-rot", "asker-a", "home");
      const laneHomeB = join(projectRuntimeDir(repo), "lanes", "th-rot", "asker-b", "home");
      expect(spawns[0]).toMatchObject({ profile: "a", home: laneHomeA });
      // INV-137 (the fix): the rotated attempt spawns in the ROTATED row's
      // OWN lane home — its recorded native session lands exactly where the
      // next "b" turn will look, never in the previous row's lane store.
      expect(spawns[1]).toMatchObject({ profile: "b", home: laneHomeB });
      expect(store["asker"]).toEqual({ sessionId: "nat-rot-1", profileId: "b" });
      // Turn 2 (daemon-shaped: binding + resume map point at the rotated
      // row): the SAME lane home, and --resume reaches the recorded session.
      await orch().run({
        repoRoot: repo,
        prompt: "q2",
        mode: "ask",
        harnesses: ["asker"],
        threadId: "th-rot",
        threadAccountBindings: { asker: "b" },
        resumeSessions: { asker: store["asker"] },
        onSessionObserved,
      });
      expect(spawns[2]).toMatchObject({ profile: "b", home: laneHomeB, resume: "nat-rot-1" });
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("never rotates on a plain transient — typed-limit signals only (W5.4)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-transient-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: a",
        "    harness_id: limited",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", "limited-a"))}`,
        "  - profile_id: b",
        "    harness_id: limited",
        "    display_name: B",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", "limited-b"))}`,
        "harnesses:",
        "  limited:",
        "    profile_policy:",
        "      limit_action: rotate",
        "",
      ].join("\n"),
    );
    try {
      const profilesSeen: Array<string | null> = [];
      const adapter: HarnessAdapter = {
        id: "limited",
        async discover() {
          return HarnessManifest.parse({
            id: "limited",
            display_name: "limited",
            kind: "local_cli",
            provider_family: "local",
            capabilities: { implement: true },
            access_profiles_supported: ["workspace_write"],
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: "limited",
            status: "ok",
            enabled_intents: ["implement"],
          });
        },
        async probeCredentialProfile(profile) {
          return {
            profile_id: profile.profile_id,
            harness_id: "limited",
            availability: "available",
            verification: "passed",
            verification_source: "local_store",
            detail: "fixture profile verified",
            last_verified_at: new Date().toISOString(),
          };
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          profilesSeen.push(spec.credential_profile?.profile_id ?? null);
          yield { type: "started", session_id: spec.session_id, ts };
          if (profilesSeen.length === 1) {
            // Ordinary network transient: NO typed rate_limit field.
            yield {
              type: "status",
              session_id: spec.session_id,
              ts,
              text: "connection reset",
              transient: { kind: "network", retry_delay_ms: 100 },
            };
            yield { type: "error", session_id: spec.session_id, ts, error: "network flake" };
            yield { type: "completed", session_id: spec.session_id, ts };
            return;
          }
          writeFileSync(join(spec.cwd, "CHANGED.txt"), "made it\n");
          yield { type: "message", session_id: spec.session_id, ts, text: "Implemented." };
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      };
      const events: string[] = [];
      const res = await new Orchestrator({
        registry: new Map([["limited", adapter]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "do it",
        mode: "agent",
        harnesses: ["limited"],
        n: 1,
        onEvent: (event) => events.push(event.type),
      });
      expect(legacyOutcome(res)).not.toBe("failed");
      // The transient retry stays on the SAME profile; rotation never fires.
      expect(profilesSeen).toEqual(["a", "a"]);
      expect(events).not.toContain("route.profile.rotated");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("rotates STRUCTURALLY on an untyped pre-progress terminal death (A2, owner 7=A)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-structural-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: a",
        "    harness_id: limited",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", "limited-a"))}`,
        "  - profile_id: b",
        "    harness_id: limited",
        "    display_name: B",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", "limited-b"))}`,
        "harnesses:",
        "  limited:",
        "    profile_policy:",
        "      limit_action: rotate",
        "",
      ].join("\n"),
    );
    try {
      const profilesSeen: Array<string | null> = [];
      const adapter: HarnessAdapter = {
        id: "limited",
        async discover() {
          return HarnessManifest.parse({
            id: "limited",
            display_name: "limited",
            kind: "local_cli",
            provider_family: "local",
            capabilities: { implement: true },
            access_profiles_supported: ["workspace_write"],
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: "limited",
            status: "ok",
            enabled_intents: ["implement"],
          });
        },
        async probeCredentialProfile(profile) {
          return {
            profile_id: profile.profile_id,
            harness_id: "limited",
            availability: "available",
            verification: "passed",
            verification_source: "local_store",
            detail: "fixture profile verified",
            last_verified_at: new Date().toISOString(),
          };
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          profilesSeen.push(spec.credential_profile?.profile_id ?? null);
          yield { type: "started", session_id: spec.session_id, ts };
          if (profilesSeen.length === 1) {
            // UNTYPED terminal death before ANY agent output: no rate_limit,
            // no transient signal — the incident shape (an unclassifiable
            // vendor refusal / invalid flag / missing binary). Owner 7=A: any
            // such pre-progress non-transient death tries the pool.
            yield {
              type: "error",
              session_id: spec.session_id,
              ts,
              error: "ActionRequiredError: unclassifiable vendor refusal",
            };
            yield { type: "completed", session_id: spec.session_id, ts };
            return;
          }
          writeFileSync(join(spec.cwd, "CHANGED.txt"), "made it\n");
          yield { type: "message", session_id: spec.session_id, ts, text: "Implemented." };
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      };
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const res = await new Orchestrator({
        registry: new Map([["limited", adapter]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "do it",
        mode: "agent",
        harnesses: ["limited"],
        n: 1,
        onEvent: (event) =>
          events.push({ type: event.type, payload: event.payload as Record<string, unknown> }),
      });
      expect(legacyOutcome(res)).not.toBe("failed");
      expect(profilesSeen).toEqual(["a", "b"]);
      // Honest provenance: the rotation names the STRUCTURAL reason — no
      // typed vendor limit was observed, so vendor_limit_rejected would lie.
      const rotated = events.find((e) => e.type === "route.profile.rotated");
      expect(rotated?.payload["reason"]).toBe("structural_pre_progress_failure");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("a tool_call before the death blocks the structural branch (sol amendment: side effects)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-structural-progress-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: a",
        "    harness_id: limited",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", "limited-a"))}`,
        "  - profile_id: b",
        "    harness_id: limited",
        "    display_name: B",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", "limited-b"))}`,
        "harnesses:",
        "  limited:",
        "    profile_policy:",
        "      limit_action: rotate",
        "",
      ].join("\n"),
    );
    try {
      const profilesSeen: Array<string | null> = [];
      const adapter: HarnessAdapter = {
        id: "limited",
        async discover() {
          return HarnessManifest.parse({
            id: "limited",
            display_name: "limited",
            kind: "local_cli",
            provider_family: "local",
            capabilities: { implement: true },
            access_profiles_supported: ["workspace_write"],
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: "limited",
            status: "ok",
            enabled_intents: ["implement"],
          });
        },
        async probeCredentialProfile(profile) {
          return {
            profile_id: profile.profile_id,
            harness_id: "limited",
            availability: "available",
            verification: "passed",
            verification_source: "local_store",
            detail: "fixture profile verified",
            last_verified_at: new Date().toISOString(),
          };
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          profilesSeen.push(spec.credential_profile?.profile_id ?? null);
          yield { type: "started", session_id: spec.session_id, ts };
          // The agent demonstrably started working (a tool call may already
          // have external side effects) — then died untyped. The structural
          // branch must NOT silently replay this under another credential.
          yield {
            type: "tool_call",
            session_id: spec.session_id,
            ts,
            tool: { name: "bash", kind: "command" },
          };
          yield { type: "error", session_id: spec.session_id, ts, error: "untyped death" };
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      };
      const events: string[] = [];
      const res = await new Orchestrator({
        registry: new Map([["limited", adapter]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "do it",
        mode: "agent",
        harnesses: ["limited"],
        n: 1,
        onEvent: (event) => events.push(event.type),
      });
      expect(legacyOutcome(res)).toBe("failed");
      expect(profilesSeen).toEqual(["a"]);
      expect(events).not.toContain("route.profile.rotated");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("REGRESSION (final-review fix): the claude org-disabled incident — message-first prose — rotates STRUCTURALLY to a sibling subscription profile; answer.md never carries the prose", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-org-disabled-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: a",
        "    harness_id: limited",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profile-a")}'`,
        "  - profile_id: b",
        "    harness_id: limited",
        "    display_name: B",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profile-b")}'`,
        "harnesses:",
        "  limited:",
        "    profile_policy:",
        "      limit_action: rotate",
        "",
      ].join("\n"),
    );
    // Replay the COMMITTED incident fixture (live 2026-08-17, run-ea06645118d7):
    // the entitlement prose arrives as a mid-stream ASSISTANT MESSAGE, again on
    // the is_error result, then exit 1 — no api_retry frame, no typed
    // rate_limit. Frames map onto the claude parser's pinned contract
    // (harness-claude signals.test.ts): init → started; the assistant message
    // KEEPS flowing as a `message` event (it is model output); the non-success
    // result rides STATUS events (typed oauth_org_not_allowed + the prose as
    // non_success_result, never a message); the shared runloop folds exit 1
    // into a terminal error event.
    const fixtureFrames = readFileSync(
      fileURLToPath(
        new URL(
          "../../harness-claude/fixtures/signals/org-disabled-subscription.jsonl",
          import.meta.url,
        ),
      ),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const orgDisabledEvents = (sessionId: string): Array<Record<string, unknown>> => {
      const ts = new Date().toISOString();
      const out: Array<Record<string, unknown>> = [];
      for (const frame of fixtureFrames) {
        if (frame["type"] === "system") out.push({ type: "started", session_id: sessionId, ts });
        if (frame["type"] === "assistant") {
          const content = (frame["message"] as { content: Array<{ text?: string }> }).content;
          out.push({ type: "message", session_id: sessionId, ts, text: content[0]?.text ?? "" });
        }
        if (frame["type"] === "result") {
          const prose = String(frame["result"] ?? "");
          out.push({
            type: "status",
            session_id: sessionId,
            ts,
            text: `entitlement: ${prose}`,
            status: { kind: "api_retry", error_category: "oauth_org_not_allowed" },
            payload: { entitlement_denied: true },
          });
          out.push({
            type: "status",
            session_id: sessionId,
            ts,
            text: prose,
            payload: { non_success_result: true },
          });
        }
      }
      out.push({ type: "error", session_id: sessionId, ts, error: "claude exited with code 1" });
      return out;
    };
    // Guard against fixture drift: the replay must still be the incident shape.
    expect(fixtureFrames.some((f) => f["type"] === "assistant")).toBe(true);
    try {
      const profilesSeen: Array<string | null> = [];
      const adapter: HarnessAdapter = {
        id: "limited",
        async discover() {
          return HarnessManifest.parse({
            id: "limited",
            display_name: "limited",
            kind: "local_cli",
            provider_family: "local",
            capabilities: { implement: true },
            access_profiles_supported: ["workspace_write"],
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: "limited",
            status: "ok",
            enabled_intents: ["implement"],
          });
        },
        async probeCredentialProfile(profile) {
          return {
            profile_id: profile.profile_id,
            harness_id: "limited",
            availability: "available",
            verification: "passed",
            verification_source: "local_store",
            detail: "fixture profile verified",
            last_verified_at: new Date().toISOString(),
          };
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          profilesSeen.push(spec.credential_profile?.profile_id ?? null);
          if (profilesSeen.length === 1) {
            for (const ev of orgDisabledEvents(spec.session_id)) yield ev as HarnessEvent;
            yield { type: "completed", session_id: spec.session_id, ts };
            return;
          }
          yield { type: "started", session_id: spec.session_id, ts };
          writeFileSync(join(spec.cwd, "CHANGED.txt"), "made it\n");
          yield { type: "message", session_id: spec.session_id, ts, text: "Implemented." };
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      };
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const res = await new Orchestrator({
        registry: new Map([["limited", adapter]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "do it",
        mode: "agent",
        harnesses: ["limited"],
        n: 1,
        // UNPINNED (unified account model, D-U6: an explicit pin never
        // rotates): the quota-aware pool deterministically selects "a" first
        // (tie-break ascending), and the reactive lane owns the failover.
        onEvent: (event) =>
          events.push({ type: event.type, payload: event.payload as Record<string, unknown> }),
      });
      // The incident class is CLOSED only when the sibling actually spawns:
      // before this fix the mid-stream prose filled the assembly, the raw
      // in-loop emptiness read "deliverable present", and the structural
      // branch never fired.
      expect(legacyOutcome(res)).not.toBe("failed");
      expect(profilesSeen).toEqual(["a", "b"]);
      const rotated = events.find((e) => e.type === "route.profile.rotated");
      expect(rotated?.payload["reason"]).toBe("structural_pre_progress_failure");
      const answer = readFileSync(join(res.runDir, "final", "answer.md"), "utf8");
      expect(answer).toContain("Implemented.");
      expect(answer).not.toContain("organization has disabled");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("per-try markers (final-review fix): try-A progress never suppresses try-B's structural rotation", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-per-try-markers-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        // SUBSCRIPTION rows (unified account model): the quota-aware pool
        // holds subscription kinds only — an api_key row is a paid route,
        // never silently rotated — and pool tie-break starts on "a".
        ...["a", "b", "c"].flatMap((id) => [
          `  - profile_id: ${id}`,
          "    harness_id: limited",
          `    display_name: ${id.toUpperCase()}`,
          "    credential_kind: config_dir_login",
          `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", `limited-${id}`))}`,
        ]),
        "harnesses:",
        "  limited:",
        "    profile_policy:",
        "      limit_action: rotate",
        "",
      ].join("\n"),
    );
    try {
      const profilesSeen: Array<string | null> = [];
      const adapter: HarnessAdapter = {
        id: "limited",
        async discover() {
          return HarnessManifest.parse({
            id: "limited",
            display_name: "limited",
            kind: "local_cli",
            provider_family: "local",
            capabilities: { implement: true },
            access_profiles_supported: ["workspace_write"],
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: "limited",
            status: "ok",
            enabled_intents: ["implement"],
          });
        },
        async probeCredentialProfile(profile) {
          return {
            profile_id: profile.profile_id,
            harness_id: "limited",
            availability: "available",
            verification: "passed",
            verification_source: "local_store",
            detail: "fixture profile verified",
            last_verified_at: new Date().toISOString(),
          };
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          profilesSeen.push(spec.credential_profile?.profile_id ?? null);
          yield { type: "started", session_id: spec.session_id, ts };
          if (profilesSeen.length === 1) {
            // Try A: the agent demonstrably THINKS, then hits a TYPED limit —
            // the typed branch rotates regardless of progress (W5.4 canon).
            yield { type: "thinking", session_id: spec.session_id, ts, text: "assessing repo" };
            yield {
              type: "status",
              session_id: spec.session_id,
              ts,
              text: "api_retry: rate limited",
              status: { kind: "api_retry", error_category: "rate_limit" },
              rate_limit: { resets_at: null, retry_delay_ms: 60_000 },
            };
            yield {
              type: "error",
              session_id: spec.session_id,
              ts,
              error: "vendor rate limit exhausted",
            };
            yield { type: "completed", session_id: spec.session_id, ts };
            return;
          }
          if (profilesSeen.length === 2) {
            // Try B: untyped pre-progress terminal death. Cumulative markers
            // would still carry try-A's thinking and suppress the structural
            // branch — per-try markers must let B rotate to C.
            yield { type: "error", session_id: spec.session_id, ts, error: "untyped death" };
            yield { type: "completed", session_id: spec.session_id, ts };
            return;
          }
          writeFileSync(join(spec.cwd, "CHANGED.txt"), "made it\n");
          yield { type: "message", session_id: spec.session_id, ts, text: "Implemented." };
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      };
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const res = await new Orchestrator({
        registry: new Map([["limited", adapter]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "do it",
        mode: "agent",
        harnesses: ["limited"],
        n: 1,
        // UNPINNED (D-U6: an explicit pin never rotates): the pool starts on
        // "a" by deterministic tie-break; reactive rotation walks b then c.
        onEvent: (event) =>
          events.push({ type: event.type, payload: event.payload as Record<string, unknown> }),
      });
      expect(legacyOutcome(res)).not.toBe("failed");
      expect(profilesSeen).toEqual(["a", "b", "c"]);
      expect(
        events.filter((e) => e.type === "route.profile.rotated").map((e) => e.payload["reason"]),
      ).toEqual(["vendor_limit_rejected", "structural_pre_progress_failure"]);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("a typed limit whose vendor prose rides a STATUS event still rotates, and the prose never lands in answer.md (A3+A2)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-limit-prose-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: a",
        "    harness_id: asker",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", "asker-a"))}`,
        "  - profile_id: b",
        "    harness_id: asker",
        "    display_name: B",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", "asker-b"))}`,
        "harnesses:",
        "  asker:",
        "    profile_policy:",
        "      limit_action: rotate",
        "",
      ].join("\n"),
    );
    try {
      const profilesSeen: Array<string | null> = [];
      // The post-A3 adapter shape for a limit-killed run: the vendor prose is
      // a STATUS event (never a message), the limit is a TYPED rate_limit on
      // the terminal error. Rotation must fire — before A3 the same prose
      // arrived as a message, became "the deliverable", and blocked it.
      const asker = askAdapter("asker", function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        if (profilesSeen.length === 1) {
          yield {
            type: "status",
            session_id: sessionId,
            ts,
            text: "You've hit your usage limit. Your usage limits will reset on 9/12/2026.",
            payload: { non_success_result: true },
          };
          yield {
            type: "error",
            session_id: sessionId,
            ts,
            error: "result subtype: error",
            status: { kind: "api_retry", error_category: "rate_limit" },
            rate_limit: { resets_at: null, retry_delay_ms: 60_000 },
          };
          yield { type: "completed", session_id: sessionId, ts };
          return;
        }
        yield { type: "message", session_id: sessionId, ts, text: "4" };
        yield { type: "completed", session_id: sessionId, ts };
      });
      const askerRun = asker.run.bind(asker);
      asker.run = (spec) => {
        profilesSeen.push(spec.credential_profile?.profile_id ?? null);
        return askerRun(spec);
      };
      const events: string[] = [];
      const res = await new Orchestrator({
        registry: new Map([["asker", asker]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        onEvent: (event) => events.push(event.type),
      });
      expect(legacyOutcome(res)).toBe("success");
      expect(profilesSeen).toEqual(["a", "b"]);
      expect(events).toContain("route.profile.rotated");
      const answer = readFileSync(join(res.runDir, "final", "answer.md"), "utf8");
      expect(answer).toContain("4");
      expect(answer).not.toContain("usage limit");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("rotates STRUCTURALLY in the READ-ONLY lane too (A2 lane parity)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-ro-structural-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: a",
        "    harness_id: asker",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", "asker-a"))}`,
        "  - profile_id: b",
        "    harness_id: asker",
        "    display_name: B",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", "asker-b"))}`,
        "harnesses:",
        "  asker:",
        "    profile_policy:",
        "      limit_action: rotate",
        "",
      ].join("\n"),
    );
    try {
      const profilesSeen: Array<string | null> = [];
      const asker = askAdapter("asker", function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        if (profilesSeen.length === 1) {
          // Untyped pre-progress terminal death, read-only lane.
          yield { type: "error", session_id: sessionId, ts, error: "untyped vendor refusal" };
          yield { type: "completed", session_id: sessionId, ts };
          return;
        }
        yield { type: "message", session_id: sessionId, ts, text: "4" };
        yield { type: "completed", session_id: sessionId, ts };
      });
      const askerRun = asker.run.bind(asker);
      asker.run = (spec) => {
        profilesSeen.push(spec.credential_profile?.profile_id ?? null);
        return askerRun(spec);
      };
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const res = await new Orchestrator({
        registry: new Map([["asker", asker]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        onEvent: (event) =>
          events.push({ type: event.type, payload: event.payload as Record<string, unknown> }),
      });
      expect(legacyOutcome(res)).toBe("success");
      expect(profilesSeen).toEqual(["a", "b"]);
      const rotated = events.find((e) => e.type === "route.profile.rotated");
      expect(rotated?.payload["reason"]).toBe("structural_pre_progress_failure");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  // A5: one config shape shared by the pool-exhausted terminal tests — a
  // single rotate-policy profile, so any rotation-eligible failure exhausts
  // the pool immediately.
  const soloRotateConfig = (harness: string) =>
    [
      "credential_profiles:",
      "  - profile_id: solo",
      `    harness_id: ${harness}`,
      "    display_name: Solo",
      "    credential_kind: config_dir_login",
      `    isolation_locator: ${JSON.stringify(join(tmpdir(), "claudexor-solo-locator", harness))}`,
      "harnesses:",
      `  ${harness}:`,
      "    profile_policy:",
      "      limit_action: rotate",
      "",
    ].join("\n");

  const A5_RESETS = "2099-01-01T00:00:00.000Z";

  /** Implement-capable adapter that hits a typed (or untyped) terminal limit
   * on EVERY spawn — a transient retry or a rotation would grow `spawns`. */
  const limitedSoloAdapter = (spawns: Array<string | null>, typed: boolean): HarnessAdapter => ({
    id: "limited",
    async discover() {
      return HarnessManifest.parse({
        id: "limited",
        display_name: "limited",
        kind: "local_cli",
        provider_family: "local",
        capabilities: { implement: true },
        access_profiles_supported: ["workspace_write"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "limited",
        status: "ok",
        enabled_intents: ["implement"],
      });
    },
    async probeCredentialProfile(profile) {
      return {
        profile_id: profile.profile_id,
        harness_id: "limited",
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        detail: "fixture profile verified",
        last_verified_at: new Date().toISOString(),
      };
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      spawns.push(spec.credential_profile?.profile_id ?? null);
      yield { type: "started", session_id: spec.session_id, ts };
      yield {
        type: "error",
        session_id: spec.session_id,
        ts,
        error: typed ? "vendor rate limit exhausted" : "untyped vendor refusal",
        ...(typed
          ? {
              status: { kind: "api_retry", error_category: "rate_limit" },
              rate_limit: { resets_at: A5_RESETS, retry_delay_ms: 60_000 },
            }
          : {}),
      };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  });

  it("a typed limit with an EXHAUSTED pool terminalizes TYPED before any transient retry (A5)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-pool-exhausted-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(join(configDir, "config.yaml"), soloRotateConfig("limited"));
    try {
      const spawns: Array<string | null> = [];
      const events: string[] = [];
      const res = await new Orchestrator({
        registry: new Map([["limited", limitedSoloAdapter(spawns, true)]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "do it",
        mode: "agent",
        harnesses: ["limited"],
        n: 1,
        onEvent: (event) => events.push(event.type),
      });
      // The typed limit is retryable-transient by class — without the A5
      // ordering the gate would burn maxRetries same-profile spawns on the
      // subject the vendor just refused.
      expect(spawns).toEqual(["solo"]);
      expect(events).toContain("route.profile.rotation_exhausted");
      expect(events).not.toContain("route.transient.retry_scheduled");
      expect(events).not.toContain("route.transient.exhausted");
      expect(legacyOutcome(res)).toBe("failed");
      const failure = new ArtifactStore(repo).readYaml<Record<string, unknown>>(
        join(res.runDir, "final", "failure.yaml"),
      );
      expect(failure).toMatchObject({
        category: "harness_unavailable",
        code: "credential_pool_exhausted",
        // The stream's own typed reset is the subject's evidence in the fold.
        resetsAt: A5_RESETS,
      });
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("a STRUCTURAL death over an EVIDENCE-FREE pool keeps its TRUE failure (evidence-gated terminal)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-pool-structural-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(join(configDir, "config.yaml"), soloRotateConfig("limited"));
    try {
      const spawns: Array<string | null> = [];
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const res = await new Orchestrator({
        registry: new Map([["limited", limitedSoloAdapter(spawns, false)]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "do it",
        mode: "agent",
        harnesses: ["limited"],
        n: 1,
        onEvent: (event) =>
          events.push({ type: event.type, payload: event.payload as Record<string, unknown> }),
      });
      expect(spawns).toEqual(["solo"]);
      // Rotation WAS consulted and had nowhere to go — the provenance event
      // stays...
      const exhausted = events.find((e) => e.type === "route.profile.rotation_exhausted");
      expect(exhausted?.payload["reason"]).toBe("structural_pre_progress_failure");
      expect(legacyOutcome(res)).toBe("failed");
      const failure = new ArtifactStore(repo).readYaml<Record<string, unknown>>(
        join(res.runDir, "final", "failure.yaml"),
      );
      // ...but the TERMINAL is evidence-gated: neither the untyped death nor
      // any candidate row carries limit/unusable evidence, so claiming
      // "credential pool exhausted" would relabel an ordinary structural
      // failure as a credential refusal. The true failure survives instead.
      expect(failure?.["code"]).not.toBe("credential_pool_exhausted");
      expect(String(failure?.["safeMessage"] ?? "")).toContain("untyped vendor refusal");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("a VANILLA user's untyped pre-progress death is never pool-coded (empty registry, auto default)", async () => {
    const repo = await initRepo();
    // NO config at all: empty profile registry, absent limit_action (= auto).
    const configDir = reapMk(join(tmpdir(), "claudexor-pool-vanilla-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const spawns: Array<string | null> = [];
      const adapter = limitedSoloAdapter(spawns, false);
      // A subscription-shaped default route (native session available): the
      // A6 auto default resolves to `rotate`, so the rotation decision RUNS —
      // and must still fail as-is over the empty, evidence-free pool.
      adapter.doctor = async () =>
        ConformanceReport.parse({
          harness_id: "limited",
          status: "ok",
          enabled_intents: ["implement"],
          auth_sources: [
            { source: "native_session", availability: "available", verification: "passed" },
          ],
        });
      const events: string[] = [];
      const res = await new Orchestrator({
        registry: new Map([["limited", adapter]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "do it",
        mode: "agent",
        harnesses: ["limited"],
        n: 1,
        onEvent: (event) => events.push(event.type),
      });
      expect(spawns).toEqual([null]);
      // The rotation decision DID run and found the pool empty — the gate we
      // are pinning is past that point, not an earlier ineligibility exit.
      expect(events).toContain("route.profile.rotation_exhausted");
      expect(legacyOutcome(res)).toBe("failed");
      const failure = new ArtifactStore(repo).readYaml<Record<string, unknown>>(
        join(res.runDir, "final", "failure.yaml"),
      );
      expect(failure?.["code"]).not.toBe("credential_pool_exhausted");
      expect(String(failure?.["safeMessage"] ?? "")).toContain("untyped vendor refusal");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("the READ-ONLY lane's pool-exhausted terminal is typed too (A5 lane parity)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-ro-pool-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(join(configDir, "config.yaml"), soloRotateConfig("asker"));
    try {
      const profilesSeen: Array<string | null> = [];
      const asker = askAdapter("asker", function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        yield {
          type: "error",
          session_id: sessionId,
          ts,
          error: "vendor rate limit exhausted",
          status: { kind: "api_retry", error_category: "rate_limit" },
          rate_limit: { resets_at: A5_RESETS, retry_delay_ms: 60_000 },
        };
        yield { type: "completed", session_id: sessionId, ts };
      });
      const askerRun = asker.run.bind(asker);
      asker.run = (spec) => {
        profilesSeen.push(spec.credential_profile?.profile_id ?? null);
        return askerRun(spec);
      };
      const res = await new Orchestrator({
        registry: new Map([["asker", asker]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
      });
      expect(profilesSeen).toEqual(["solo"]);
      expect(legacyOutcome(res)).toBe("failed");
      const failure = new ArtifactStore(repo).readYaml<Record<string, unknown>>(
        join(res.runDir, "final", "failure.yaml"),
      );
      expect(failure).toMatchObject({
        category: "harness_unavailable",
        code: "credential_pool_exhausted",
        resetsAt: A5_RESETS,
      });
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("the CONVERGENCE last-result terminal lifts the typed pool refusal (A5)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-conv-pool-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(join(configDir, "config.yaml"), soloRotateConfig("limited"));
    try {
      const spawns: Array<string | null> = [];
      const res = await new Orchestrator({
        registry: new Map([["limited", limitedSoloAdapter(spawns, true)]]),
        reviewers: reviewers(),
      }).run({
        repoRoot: repo,
        prompt: "do it",
        mode: "agent",
        harnesses: ["limited"],
        attempts: 2,
      });
      // One spawn per convergence attempt — never transient same-profile burns.
      expect(spawns).toEqual(["solo", "solo"]);
      expect(res.lifecycle).toBe("failed");
      const failure = new ArtifactStore(repo).readYaml<Record<string, unknown>>(
        join(res.runDir, "final", "failure.yaml"),
      );
      expect(failure).toMatchObject({
        category: "harness_unavailable",
        code: "credential_pool_exhausted",
        resetsAt: A5_RESETS,
      });
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("A6 auto default: with NO profile_policy configured, a SUBSCRIPTION subject rotates and the A5 pool terminal is reachable by default users", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-auto-default-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    // The config has NO harnesses/profile_policy section at all — the stored
    // default is `auto` — and the pinned subject is a subscription
    // (config_dir_login) identity, so auto resolves to rotate.
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: solo",
        "    harness_id: limited",
        "    display_name: Solo",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", "limited-solo"))}`,
        "",
      ].join("\n"),
    );
    try {
      const spawns: Array<string | null> = [];
      const events: string[] = [];
      const res = await new Orchestrator({
        registry: new Map([["limited", limitedSoloAdapter(spawns, true)]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: "do it",
        mode: "agent",
        harnesses: ["limited"],
        n: 1,
        onEvent: (event) => events.push(event.type),
      });
      // Rotation engaged WITHOUT any configuration: the typed limit on the
      // solo subscription pool terminalizes typed instead of burning
      // same-profile transient retries — the default-user path.
      expect(spawns).toEqual(["solo"]);
      expect(events).toContain("route.profile.rotation_exhausted");
      expect(events).not.toContain("route.transient.retry_scheduled");
      expect(events).not.toContain("route.transient.exhausted");
      expect(legacyOutcome(res)).toBe("failed");
      const failure = new ArtifactStore(repo).readYaml<Record<string, unknown>>(
        join(res.runDir, "final", "failure.yaml"),
      );
      expect(failure).toMatchObject({
        category: "harness_unavailable",
        code: "credential_pool_exhausted",
        resetsAt: A5_RESETS,
      });
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("the unpinned pool skips exhausted and unready rows and spawns the best ready sibling; a PIN refuses typed (D-U1/D-U6)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-rotate-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: a",
        "    harness_id: asker",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profile-a")}'`,
        "  - profile_id: b",
        "    harness_id: asker",
        "    display_name: B",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profile-b")}'`,
        "  - profile_id: c",
        "    harness_id: asker",
        "    display_name: C",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profile-c")}'`,
        "  - profile_id: d",
        "    harness_id: asker",
        "    display_name: D",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profile-d")}'`,
        "harnesses:",
        "  asker:",
        "    profile_policy:",
        "      limit_action: rotate",
        "",
      ].join("\n"),
    );
    try {
      const seen: string[] = [];
      const probedProfiles: string[] = [];
      const asker = askAdapter("asker", function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        yield { type: "message", session_id: sessionId, ts, text: "4" };
        yield { type: "completed", session_id: sessionId, ts };
      });
      asker.probeCredentialProfile = async (profile) => {
        probedProfiles.push(profile.profile_id);
        return {
          profile_id: profile.profile_id,
          harness_id: "asker",
          availability: profile.profile_id === "b" ? "unavailable" : "available",
          verification: profile.profile_id === "b" ? "failed" : "passed",
          verification_source: "local_store",
          detail: profile.profile_id === "b" ? "profile login expired" : "fixture profile verified",
          last_verified_at: new Date().toISOString(),
        };
      };
      const askerRun = asker.run.bind(asker);
      asker.run = (spec) => {
        seen.push(spec.credential_profile?.profile_id ?? "(none)");
        return askerRun(spec);
      };
      const saturatedA = () => [
        {
          subject: {
            harness: "asker",
            credential_route: "vendor_native" as const,
            plan_label: null,
            subject_id: "a",
          },
          constraints: [
            {
              id: "five_hour",
              label: "5 hour",
              used_ratio: 0.97,
              window_seconds: 18000,
              resets_at: null,
              cooldown_until: null,
            },
          ],
          source: "claude_oauth_usage" as const,
          observed_at: new Date().toISOString(),
          freshness: "fresh" as const,
        },
      ];
      const events: string[] = [];
      const res = await new Orchestrator({
        registry: new Map([["asker", asker]]),
        reviewers: [],
        quotaSnapshots: saturatedA,
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        onEvent: (event) => events.push(event.type),
      });
      expect(legacyOutcome(res)).toBe("success");
      // The unpinned pool skips exhausted "a" (fresh breach) and unready "b"
      // (expired login) and lands on the best ready sibling deterministically.
      expect(seen).toEqual(["c"]);
      expect(probedProfiles).toContain("a");
      expect(probedProfiles).toContain("b");
      expect(probedProfiles).toContain("c");
      expect(events).toContain("route.account.pool_selected");
      expect(events).not.toContain("route.profile.rotated");

      // An EXPLICIT pin on the exhausted "a" refuses TYPED before any spawn
      // (D-U6) — never a silent rotation onto the ready siblings.
      seen.length = 0;
      const pinnedEvents: string[] = [];
      const pinned = await new Orchestrator({
        registry: new Map([["asker", asker]]),
        reviewers: [],
        quotaSnapshots: saturatedA,
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        credentialProfileId: "a",
        onEvent: (event) => pinnedEvents.push(event.type),
      });
      expect(legacyOutcome(pinned)).toBe("failed");
      expect(pinned.summary).toMatch(/over its headroom threshold/);
      expect(seen).toEqual([]);
      expect(pinnedEvents).toContain("route.profile.headroom_exceeded");
      expect(pinnedEvents).not.toContain("route.profile.rotated");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("limit_action fail REFUSES a fresh headroom breach before spawn (W5.4 + release wave)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-nofail-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: a",
        "    harness_id: asker",
        "    display_name: A",
        "    credential_kind: api_key",
        "    secret_ref: 'openai:a'",
        "  - profile_id: b",
        "    harness_id: asker",
        "    display_name: B",
        "    credential_kind: api_key",
        "    secret_ref: 'openai:b'",
        "",
      ].join("\n"),
    );
    try {
      const seen: string[] = [];
      const asker = askAdapter("asker", function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        yield { type: "message", session_id: sessionId, ts, text: "4" };
        yield { type: "completed", session_id: sessionId, ts };
      });
      const askerRun = asker.run.bind(asker);
      asker.run = (spec) => {
        seen.push(spec.credential_profile?.profile_id ?? "(none)");
        return askerRun(spec);
      };
      const events: string[] = [];
      const res = await new Orchestrator({
        registry: new Map([["asker", asker]]),
        reviewers: [],
        quotaSnapshots: () => [
          {
            subject: {
              harness: "asker",
              credential_route: "managed_api_key",
              plan_label: null,
              subject_id: "a",
            },
            constraints: [
              {
                id: "five_hour",
                label: "5 hour",
                used_ratio: 0.97,
                window_seconds: 18000,
                resets_at: null,
                cooldown_until: null,
              },
            ],
            source: "claude_oauth_usage",
            observed_at: new Date().toISOString(),
            freshness: "fresh",
          },
        ],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        credentialProfileId: "a",
        onEvent: (event) => events.push(event.type),
      });
      // Default policy = fail FAILS (release wave tier1 #4): a FRESH breach
      // refuses before spawn with typed evidence; no adapter ever launches.
      expect(legacyOutcome(res)).toBe("failed");
      expect(seen).toEqual([]);
      expect(events).toContain("route.profile.headroom_exceeded");
      expect(events).not.toContain("route.profile.rotated");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("admits a native-default Claude route when only Fable's scoped quota is exhausted", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-native-default-model-quota-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(join(configDir, "config.yaml"), "version: 1\n");
    try {
      const seenModels: Array<string | null> = [];
      const asker = nativeAskAdapter("asker", (spec) => seenModels.push(spec.model_hint ?? null));
      const result = await new Orchestrator({
        registry: new Map([["asker", asker]]),
        reviewers: [],
        quotaSnapshots: () => [
          {
            subject: {
              harness: "asker",
              credential_route: "vendor_native",
              plan_label: "max",
              subject_id: null,
            },
            constraints: [
              {
                id: "weekly_scoped:Fable",
                label: "7 day (Fable)",
                applies_to_models: ["fable", "claude-fable-5", "best"],
                used_ratio: 1,
                window_seconds: 7 * 24 * 60 * 60,
                resets_at: new Date(Date.now() + 3_600_000).toISOString(),
                cooldown_until: null,
              },
            ],
            source: "claude_oauth_usage",
            observed_at: new Date().toISOString(),
            freshness: "fresh",
          },
        ],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
      });
      expect(legacyOutcome(result)).toBe("success");
      expect(seenModels).toEqual([null]);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it.each([
    { action: "rotate" as const, expectedProfile: "release-sol", expectedStarts: 1 },
    { action: "fail" as const, expectedProfile: "release-sol", expectedStarts: 1 },
  ])(
    "an unpinned run routes to the ready pool row regardless of limit_action=$action (unified model: the saturated legacy default subject is not a row)",
    async ({ action, expectedProfile, expectedStarts }) => {
      const repo = await initRepo();
      const configDir = reapMk(join(tmpdir(), `claudexor-default-${action}-quota-`));
      const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
      process.env.CLAUDEXOR_CONFIG_DIR = configDir;
      writeFileSync(
        join(configDir, "config.yaml"),
        [
          "credential_profiles:",
          "  - profile_id: release-sol",
          "    harness_id: asker",
          "    display_name: Release Sol",
          "    credential_kind: config_dir_login",
          `    isolation_locator: '${join(configDir, "release-sol")}'`,
          "harnesses:",
          "  asker:",
          "    profile_policy:",
          `      limit_action: ${action}`,
          "",
        ].join("\n"),
      );
      try {
        const profilesSeen: Array<string | null> = [];
        const events: string[] = [];
        const asker = nativeAskAdapter("asker", (spec) =>
          profilesSeen.push(spec.credential_profile?.profile_id ?? null),
        );
        const result = await new Orchestrator({
          registry: new Map([["asker", asker]]),
          reviewers: [],
          quotaSnapshots: () => [
            {
              subject: {
                harness: "asker",
                credential_route: "vendor_native",
                plan_label: "plus",
                subject_id: null,
              },
              constraints: [
                {
                  id: "five_hour",
                  label: "5 hour",
                  used_ratio: 1,
                  window_seconds: 18_000,
                  resets_at: new Date(Date.now() + 3_600_000).toISOString(),
                  cooldown_until: null,
                },
              ],
              source: "codex_rollout",
              observed_at: new Date().toISOString(),
              freshness: "fresh",
            },
          ],
        }).run({
          repoRoot: repo,
          prompt: "2+2?",
          mode: "ask",
          harnesses: ["asker"],
          onEvent: (event) => events.push(event.type),
        });
        expect(profilesSeen).toHaveLength(expectedStarts);
        // The registered row IS the pool; the saturated null-subject snapshot
        // belongs to the legacy default subject (not a row) and cannot demote
        // the ready row — no rotation event fires, the pool simply selects.
        expect(legacyOutcome(result)).toBe("success");
        expect(profilesSeen).toEqual([expectedProfile]);
        expect(events).toContain("route.account.pool_selected");
        expect(events).not.toContain("route.profile.rotated");
      } finally {
        if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
        else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
      }
    },
  );

  it("keeps convergence cooldown checks bound to the admitted model and profile", async () => {
    const cases: Array<{
      name: string;
      model: string | null;
      profile: boolean;
      initialDefaultConstraint: boolean;
      liveScopedConstraint: boolean;
      expectedStarts: number;
    }> = [
      {
        name: "native default",
        model: null,
        profile: false,
        initialDefaultConstraint: false,
        liveScopedConstraint: true,
        expectedStarts: 2,
      },
      {
        name: "explicit Opus",
        model: "claude-opus-5",
        profile: false,
        initialDefaultConstraint: false,
        liveScopedConstraint: true,
        expectedStarts: 2,
      },
      {
        name: "explicit Fable",
        model: "claude-fable-5",
        profile: false,
        initialDefaultConstraint: false,
        liveScopedConstraint: true,
        expectedStarts: 1,
      },
      {
        name: "different profile subject",
        model: "claude-fable-5",
        profile: true,
        initialDefaultConstraint: true,
        liveScopedConstraint: false,
        expectedStarts: 2,
      },
    ];
    for (const testCase of cases) {
      const repo = await initRepo();
      const configDir = reapMk(join(tmpdir(), "claudexor-convergence-quota-"));
      const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
      process.env.CLAUDEXOR_CONFIG_DIR = configDir;
      writeFileSync(
        join(configDir, "config.yaml"),
        testCase.profile
          ? [
              "credential_profiles:",
              "  - profile_id: alt",
              "    harness_id: worker",
              "    display_name: Alt",
              "    credential_kind: config_dir_login",
              `    isolation_locator: '${join(configDir, "alt")}'`,
              "",
            ].join("\n")
          : "version: 1\n",
      );
      try {
        let starts = 0;
        const worker: HarnessAdapter = {
          id: "worker",
          async discover() {
            return HarnessManifest.parse({
              id: "worker",
              display_name: "worker",
              kind: "local_cli",
              provider_family: "anthropic",
              capabilities: {
                implement: true,
                known_models: ["claude-opus-5", "claude-fable-5"],
              },
              auth_modes: ["local_session"],
              access_profiles_supported: ["workspace_write"],
            });
          },
          async doctor() {
            return ConformanceReport.parse({
              harness_id: "worker",
              status: "ok",
              enabled_intents: ["implement"],
              auth_sources: [
                {
                  source: "native_session",
                  availability: "available",
                  verification: "passed",
                },
              ],
            });
          },
          async probeCredentialProfile(profile) {
            return {
              profile_id: profile.profile_id,
              harness_id: "worker",
              availability: "available",
              verification: "passed",
              verification_source: "local_store",
              detail: "fixture profile verified",
              last_verified_at: new Date().toISOString(),
            };
          },
          async *run(spec) {
            starts += 1;
            const ts = new Date().toISOString();
            yield {
              type: "started",
              session_id: spec.session_id,
              ts,
              credential_route: "vendor_native",
              credential_profile_id: spec.credential_profile?.profile_id,
            };
            if (testCase.liveScopedConstraint) {
              yield {
                type: "status",
                session_id: spec.session_id,
                ts,
                credential_route: "vendor_native",
                quota: {
                  source: "claude_oauth_usage",
                  plan_label: "max",
                  subject_id: null,
                  constraints: [
                    {
                      id: "weekly_scoped:Fable",
                      label: "7 day (Fable)",
                      applies_to_models: ["fable", "claude-fable-5", "best"],
                      used_ratio: 1,
                      window_seconds: 7 * 24 * 60 * 60,
                      resets_at: new Date(Date.now() + 3_600_000).toISOString(),
                      cooldown_until: new Date(Date.now() + 3_600_000).toISOString(),
                    },
                  ],
                },
              };
            }
            yield { type: "error", session_id: spec.session_id, ts, error: "fixture failure" };
            yield { type: "completed", session_id: spec.session_id, ts };
          },
        };
        const initialSnapshots = testCase.initialDefaultConstraint
          ? [
              {
                subject: {
                  harness: "worker",
                  credential_route: "vendor_native" as const,
                  plan_label: "max",
                  subject_id: null,
                },
                constraints: [
                  {
                    id: "weekly_scoped:Fable",
                    label: "7 day (Fable)",
                    applies_to_models: ["fable", "claude-fable-5", "best"],
                    used_ratio: 1,
                    window_seconds: 7 * 24 * 60 * 60,
                    resets_at: new Date(Date.now() + 3_600_000).toISOString(),
                    cooldown_until: null,
                  },
                ],
                source: "claude_oauth_usage" as const,
                observed_at: new Date().toISOString(),
                freshness: "fresh" as const,
              },
            ]
          : [];
        const result = await new Orchestrator({
          registry: new Map([["worker", worker]]),
          reviewers: reviewers(),
          quotaSnapshots: () => initialSnapshots,
        }).run({
          repoRoot: repo,
          prompt: `repair ${testCase.name}`,
          mode: "agent",
          harnesses: ["worker"],
          attempts: 2,
          ...(testCase.model ? { models: { worker: testCase.model } } : {}),
          ...(testCase.profile ? { credentialProfileId: "alt" } : {}),
        });
        expect(starts, `${testCase.name}: ${result.summary}`).toBe(testCase.expectedStarts);
      } finally {
        if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
        else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
      }
    }
  }, 30000);

  it("checks a read-only fallback model against that model's scoped quota before spawn", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-fallback-model-quota-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: work",
        "    harness_id: asker",
        "    display_name: Work",
        "    credential_kind: api_key",
        "    secret_ref: 'openai:work'",
        "harnesses:",
        "  asker:",
        "    default_model: claude-opus-5",
        "    fallback_model: claude-fable-5",
        "",
      ].join("\n"),
    );
    try {
      const seenModels: Array<string | null> = [];
      const asker = askAdapter("asker", function* () {});
      asker.discover = async () =>
        HarnessManifest.parse({
          id: "asker",
          display_name: "asker",
          kind: "local_cli",
          provider_family: "anthropic",
          capabilities: {
            plan: true,
            review: true,
            read_files: true,
            web_policy: "tools",
            known_models: ["claude-opus-5", "claude-fable-5"],
          },
          access_profiles_supported: ["readonly"],
        });
      asker.run = (spec) => {
        seenModels.push(spec.model_hint ?? null);
        return (async function* () {
          const ts = new Date().toISOString();
          yield {
            type: "started" as const,
            session_id: spec.session_id,
            ts,
            credential_route: "managed_api_key" as const,
          };
          if (spec.model_hint === "claude-opus-5") {
            yield {
              type: "error" as const,
              session_id: spec.session_id,
              ts,
              error: "primary model failed",
            };
          } else {
            yield {
              type: "message" as const,
              session_id: spec.session_id,
              ts,
              text: "fallback should not run",
            };
          }
          yield { type: "completed" as const, session_id: spec.session_id, ts };
        })();
      };
      const eventTypes: string[] = [];
      const result = await new Orchestrator({
        registry: new Map([["asker", asker]]),
        reviewers: [],
        quotaSnapshots: () => [
          {
            subject: {
              harness: "asker",
              credential_route: "managed_api_key",
              plan_label: null,
              subject_id: "work",
            },
            constraints: [
              {
                id: "weekly_scoped:Fable",
                label: "7 day (Fable)",
                applies_to_models: ["fable", "claude-fable-5", "best"],
                used_ratio: 1,
                window_seconds: 7 * 24 * 60 * 60,
                resets_at: new Date(Date.now() + 3_600_000).toISOString(),
                cooldown_until: null,
              },
            ],
            source: "claude_oauth_usage",
            observed_at: new Date().toISOString(),
            freshness: "fresh",
          },
        ],
      }).run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        harnesses: ["asker"],
        credentialProfileId: "work",
        onEvent: (event) => eventTypes.push(event.type),
      });
      expect(result.lifecycle).toBe("failed");
      expect(seenModels, JSON.stringify({ summary: result.summary, facts: result.facts })).toEqual([
        "claude-opus-5",
      ]);
      expect(eventTypes).toContain("route.profile.headroom_exceeded");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("checks a budget downgrade model against that model's scoped quota before spawn", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-downgrade-model-quota-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: work",
        "    harness_id: worker",
        "    display_name: Work",
        "    credential_kind: api_key",
        "    secret_ref: 'openai:work'",
        "harnesses:",
        "  worker:",
        "    default_model: claude-opus-5",
        "    fallback_model: claude-fable-5",
        "",
      ].join("\n"),
    );
    const authority = new DelegationBudgetAuthority();
    const parentRunId = "run-parent-model-downgrade";
    const admissionId = "job-child-model-downgrade";
    const parentLedger = new BudgetLedger({ kind: "finite", maxUsd: 0.0555 });
    authority.registerParent(parentRunId, parentLedger);
    authority.noteChildAccepted(parentRunId, admissionId);
    try {
      const seenModels: Array<string | null> = [];
      const worker: HarnessAdapter = {
        id: "worker",
        async discover() {
          return HarnessManifest.parse({
            id: "worker",
            display_name: "worker",
            kind: "local_cli",
            provider_family: "anthropic",
            capabilities: {
              implement: true,
              known_models: ["claude-opus-5", "claude-fable-5"],
            },
            access_profiles_supported: ["workspace_write"],
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: "worker",
            status: "ok",
            enabled_intents: ["implement"],
          });
        },
        async probeCredentialProfile(profile) {
          return {
            profile_id: profile.profile_id,
            harness_id: "worker",
            availability: "available",
            verification: "passed",
            verification_source: "local_store",
            detail: "fixture profile verified",
            last_verified_at: new Date().toISOString(),
          };
        },
        async *run(spec) {
          seenModels.push(spec.model_hint ?? null);
          const ts = new Date().toISOString();
          yield { type: "started", session_id: spec.session_id, ts };
          writeFileSync(join(spec.cwd, "UNEXPECTED.txt"), "fallback should not run\n");
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      };
      const eventTypes: string[] = [];
      const result = await new Orchestrator({
        registry: new Map([["worker", worker]]),
        reviewers: [],
        delegationBudgetAuthority: authority,
        quotaSnapshots: () => [
          {
            subject: {
              harness: "worker",
              credential_route: "managed_api_key",
              plan_label: null,
              subject_id: "work",
            },
            constraints: [
              {
                id: "weekly_scoped:Fable",
                label: "7 day (Fable)",
                applies_to_models: ["fable", "claude-fable-5", "best"],
                used_ratio: 1,
                window_seconds: 7 * 24 * 60 * 60,
                resets_at: new Date(Date.now() + 3_600_000).toISOString(),
                cooldown_until: null,
              },
            ],
            source: "claude_oauth_usage",
            observed_at: new Date().toISOString(),
            freshness: "fresh",
          },
        ],
      }).run({
        repoRoot: repo,
        prompt: "make one change",
        mode: "agent",
        harnesses: ["worker"],
        models: { worker: "claude-opus-5" },
        credentialProfileId: "work",
        runId: "run-child-model-downgrade",
        delegatedFromRunId: parentRunId,
        delegationAdmissionId: admissionId,
        onEvent: (event) => eventTypes.push(event.type),
      });
      expect(result.lifecycle).toBe("failed");
      expect(seenModels).toEqual([]);
      expect(eventTypes).toContain("route.profile.headroom_exceeded");
    } finally {
      authority.beginParentClose(parentRunId);
      await authority.waitForChildren(parentRunId, 100);
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("an agent run's spent subscription window reaches failure.yaml as a typed code + reset time", async () => {
    // The mutating (agent) path never reaches the run terminal by throwing: the
    // per-slot catch turns the refusal into an attempt error string, and the run
    // ends through the no-working-candidates terminal. Without the candidate
    // carrying its typed refusal, a host would be left parsing prose for the
    // one thing it needs — when to come back.
    const repo = await initRepo();
    const resetsAt = "2026-08-02T18:00:00.000Z";
    const configDir = reapMk(join(tmpdir(), "claudexor-agent-window-config-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: spent",
        "    harness_id: impl",
        "    display_name: Spent",
        "    credential_kind: api_key",
        "    secret_ref: 'openai:spent'",
        "",
      ].join("\n"),
    );
    try {
      const res = await new Orchestrator({
        registry: new Map<string, HarnessAdapter>([["impl", diffImplementer("impl")]]),
        reviewers: reviewers(),
        quotaSnapshots: () => [
          {
            subject: {
              harness: "impl",
              credential_route: "managed_api_key",
              plan_label: null,
              subject_id: "spent",
            },
            constraints: [
              {
                id: "weekly_scoped:Fable",
                label: "7 day (Fable)",
                used_ratio: 0.97,
                window_seconds: 604800,
                resets_at: resetsAt,
                cooldown_until: null,
              },
            ],
            source: "claude_oauth_usage",
            observed_at: new Date().toISOString(),
            freshness: "fresh",
          },
        ],
      }).run({
        repoRoot: repo,
        prompt: "do it",
        mode: "agent",
        harnesses: ["impl"],
        credentialProfileId: "spent",
        n: 1,
      });

      expect(legacyOutcome(res)).toBe("failed");
      const failure = new ArtifactStore(repo).readYaml<Record<string, unknown>>(
        join(res.runDir, "final", "failure.yaml"),
      );
      expect(failure).toMatchObject({
        category: "harness_unavailable",
        code: "subscription_window_exhausted",
        resetsAt,
      });
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("an unknown explicit credential profile refuses before any adapter launches (INV-135)", async () => {
    const repo = await initRepo();
    let launches = 0;
    const asker = askAdapter("asker", function* (sessionId) {
      launches += 1;
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const res = await new Orchestrator({
      registry: new Map([["asker", asker]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "2+2?",
      mode: "ask",
      harnesses: ["asker"],
      credentialProfileId: "ghost",
    });
    expect(legacyOutcome(res)).toBe("failed");
    expect(launches).toBe(0);
  });

  it("readonly routing probes readiness in the SAME scoped env its run spawns with (W3.3)", async () => {
    const repo = await initRepo();
    let ranSpecEnv: Record<string, string> | undefined;
    let probedEnv: Record<string, string | null | undefined> | undefined;
    const adapter: HarnessAdapter = {
      id: "asker",
      async discover() {
        return HarnessManifest.parse({
          id: "asker",
          display_name: "asker",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { read_files: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor(spec) {
        // The route-admitting point-probe carries the run's scoped env; the
        // host-level statusAll probe carries none.
        if (spec.env) probedEnv = spec.env;
        return ConformanceReport.parse({
          harness_id: "asker",
          status: "ok",
          enabled_intents: ["explain"],
        });
      },
      async *run(spec) {
        ranSpecEnv = spec.env;
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        yield { type: "message", session_id: spec.session_id, ts, text: "4" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const res = await new Orchestrator({
      registry: new Map([["asker", adapter]]),
      reviewers: [],
    }).run({ repoRoot: repo, prompt: "2+2?", mode: "ask", harnesses: ["asker"] });
    expect(legacyOutcome(res)).toBe("success");
    // The readiness truth that admitted the route was derived in the exact
    // env the run then received (TZ-1 §B: probe env === run env)…
    expect(probedEnv).toBeDefined();
    expect(ranSpecEnv).toEqual(probedEnv);
    // …and that env is the scoped throwaway HOME, not the operator's host env.
    expect(ranSpecEnv?.HOME).toBeDefined();
    expect(ranSpecEnv?.HOME).not.toBe(process.env.HOME);
  });

  it("readonly routing drops a route whose auth truth dies in the run's scoped env (W3.3)", async () => {
    const repo = await initRepo();
    let ran = false;
    const adapter: HarnessAdapter = {
      id: "asker",
      async discover() {
        return HarnessManifest.parse({
          id: "asker",
          display_name: "asker",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { read_files: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor(spec) {
        // Host env says ok; the run's scoped env cannot see the credentials —
        // the pre-W3.3 router would admit this route and the run would die.
        if (spec.env) {
          return ConformanceReport.parse({
            harness_id: "asker",
            status: "unavailable",
            reasons: ["subscription session is not visible in the scoped run env"],
          });
        }
        return ConformanceReport.parse({
          harness_id: "asker",
          status: "ok",
          enabled_intents: ["explain"],
        });
      },
      async *run(spec) {
        ran = true;
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const res = await new Orchestrator({
      registry: new Map([["asker", adapter]]),
      reviewers: [],
    }).run({ repoRoot: repo, prompt: "2+2?", mode: "ask", harnesses: ["asker"] });
    expect(legacyOutcome(res)).toBe("failed");
    expect(ran).toBe(false);
    expect(res.summary).toMatch(/scoped run env/);
  });

  it("mandatory attachment routing refuses an explicit mixed pool before providers and degrades an auto pool without refill", async () => {
    const repo = await initRepo();
    const image = join(repo, "shot.png");
    writeFileSync(image, "png-bytes\n");
    const attachment = {
      resource_id: "res-img",
      kind: "image" as const,
      mime: "image/png",
      name: "shot.png",
      sha256: `sha256:${createHash("sha256").update("png-bytes\n").digest("hex")}`,
      size_bytes: 10,
      path: image,
    };
    const runCounts = new Map<string, number>();
    const families: Record<string, ProviderFamily> = {
      blind: "openai",
      "sighted-a": "anthropic",
      "sighted-b": "google",
    };
    const mk = (id: string, acceptsImage: boolean): HarnessAdapter => ({
      id,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: families[id],
          capabilities: { implement: true, review: true, read_files: true },
          capability_profile: {
            attachment_inputs: acceptsImage
              ? [
                  {
                    kind: "image",
                    mime_types: ["image/png"],
                    max_bytes: 1024,
                    max_count: 1,
                    transport: "file_path",
                  },
                ]
              : [],
          },
          access_profiles_supported: ["readonly", "workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          enabled_intents: ["implement", "review", "explain"],
        });
      },
      async *run(spec) {
        runCounts.set(id, (runCounts.get(id) ?? 0) + 1);
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        yield { type: "message", session_id: spec.session_id, ts, text: `answered by ${id}` };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    });
    const registry = new Map<string, HarnessAdapter>([
      ["blind", mk("blind", false)],
      ["sighted-a", mk("sighted-a", true)],
      ["sighted-b", mk("sighted-b", true)],
    ]);
    // An explicit mixed pool is atomic: one incompatible member refuses the
    // entire request before even the compatible provider can start.
    const explicit = await new Orchestrator({ registry, reviewers: [] }).run({
      repoRoot: repo,
      prompt: "what is in this image?",
      mode: "agent",
      harnesses: ["blind", "sighted-a"],
      n: 2,
      attachments: [attachment],
    });
    expect(legacyOutcome(explicit)).toBe("failed");
    expect(explicit.summary).toMatch(/blind.*cannot receive every mandatory attachment/);
    expect(Object.fromEntries(runCounts)).toEqual({});

    // An auto pool may drop the incompatible lane, but it must disclose the
    // attachment stage and clamp to the two distinct survivors, never refill
    // the third slot by running either survivor twice.
    const auto = await new Orchestrator({ registry, reviewers: [] }).run({
      repoRoot: repo,
      prompt: "what is in this image?",
      mode: "agent",
      n: 3,
      attachments: [attachment],
    });
    expect(runCounts.get("blind") ?? 0).toBe(0);
    expect(runCounts.get("sighted-a")).toBe(1);
    expect(runCounts.get("sighted-b")).toBe(1);
    const degraded = readRunEvents(auto.runDir).find(
      (event) => event.type === "route.pool.degraded",
    );
    expect(degraded?.payload).toMatchObject({
      requested_harnesses: ["blind", "sighted-a", "sighted-b"],
      effective_harnesses: ["sighted-a", "sighted-b"],
      requested_n: 3,
      effective_n: 2,
      dropped_lanes: [expect.objectContaining({ harness_id: "blind", stage: "attachment" })],
    });
  });

  it("keeps an optional WebSearch error as warning evidence without blocking the answer", async () => {
    const repo = await initRepo();
    const adapter = askAdapter("web-bad", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield {
        type: "tool_call",
        session_id: sessionId,
        ts,
        text: "WebSearch",
        tool: {
          name: "WebSearch",
          kind: "web",
          use_id: "toolu_web",
          target: "current Node.js LTS version",
        },
      };
      yield {
        type: "tool_result",
        session_id: sessionId,
        ts,
        text: "tool_result: error: permission denied",
        tool: {
          name: "WebSearch",
          kind: "web",
          use_id: "toolu_web",
          status: "error",
          error_summary: "permission denied",
        },
      };
      yield { type: "message", session_id: sessionId, ts, text: "Memory answer only." };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const orch = new Orchestrator({ registry: new Map([["web-bad", adapter]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "google this",
      mode: "ask",
      harnesses: ["web-bad"],
      web: "auto",
      n: 1,
    });
    expect(legacyOutcome(res)).toBe("success");
    expect(readFileSync(join(res.runDir, "final", "answer.md"), "utf8")).toContain(
      "Memory answer only.",
    );
    const eventLog = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(eventLog).not.toContain("route.fallback.started");
    expect(eventLog).toContain("run.completed");
    // single-owner telemetry artifact records the web evidence
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toContain("status: failed");
    expect(telemetry).toContain("permission denied");
    expect(telemetry).toContain("status: success_with_warnings");
  });

  it("does not require a live-policy run to attempt web", async () => {
    const repo = await initRepo();
    const adapter = askAdapter("no-web", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield {
        type: "message",
        session_id: sessionId,
        ts,
        text: "Answer from memory, no web call made.",
      };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const orch = new Orchestrator({ registry: new Map([["no-web", adapter]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "google this",
      mode: "ask",
      harnesses: ["no-web"],
      web: "live",
      n: 1,
    });
    expect(legacyOutcome(res)).toBe("success");
    expect(readFileSync(join(res.runDir, "final", "answer.md"), "utf8")).toContain(
      "Answer from memory",
    );
    expect(readFileSync(join(res.runDir, "context", "task.yaml"), "utf8")).toContain(
      "web_required: false",
    );
  });

  it("does not block on a tool error later recovered by the same invocation", async () => {
    const repo = await initRepo();
    const adapter = askAdapter("recovers", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield {
        type: "tool_call",
        session_id: sessionId,
        ts,
        text: "Bash",
        tool: { name: "Bash", kind: "command", use_id: "t1", target: "pnpm test" },
      };
      yield {
        type: "tool_result",
        session_id: sessionId,
        ts,
        tool: {
          name: "Bash",
          kind: "command",
          use_id: "t1",
          status: "error",
          error_summary: "2 tests failed",
        },
      };
      yield {
        type: "tool_result",
        session_id: sessionId,
        ts,
        tool: {
          name: "Bash",
          kind: "command",
          use_id: "t1",
          status: "ok",
          content_summary: "all green",
        },
      };
      yield { type: "message", session_id: sessionId, ts, text: "Recovered and finished." };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const orch = new Orchestrator({ registry: new Map([["recovers", adapter]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "do it",
      mode: "ask",
      harnesses: ["recovers"],
      n: 1,
    });
    expect(legacyOutcome(res)).toBe("success");
    expect(readFileSync(join(res.runDir, "final", "answer.md"), "utf8")).toContain(
      "Recovered and finished.",
    );
    expect(readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8")).toContain(
      "unrecovered_tool_errors: 0",
    );
  });

  it("keeps a readonly answer with an unrecovered non-web tool warning usable", async () => {
    const repo = await initRepo();
    const adapter = askAdapter("warns", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield {
        type: "tool_call",
        session_id: sessionId,
        ts,
        text: "Bash",
        tool: { name: "Bash", kind: "command", use_id: "t1", target: "make it" },
      };
      yield {
        type: "tool_result",
        session_id: sessionId,
        ts,
        tool: {
          name: "Bash",
          kind: "command",
          use_id: "t1",
          status: "error",
          error_summary: "command not found",
        },
      };
      yield { type: "message", session_id: sessionId, ts, text: "Claimed done anyway." };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const orch = new Orchestrator({ registry: new Map([["warns", adapter]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "do it",
      mode: "ask",
      harnesses: ["warns"],
      n: 1,
    });
    expect(legacyOutcome(res)).toBe("success");
    expect(readFileSync(join(res.runDir, "final", "answer.md"), "utf8")).toContain(
      "Claimed done anyway.",
    );
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toContain("tool_warnings_total: 1");
    expect(telemetry).toContain("status: success_with_warnings");
  });

  it("budget-degraded race keeps envelope isolation + adoption (requested semantics stick)", async () => {
    const repo = await initRepo();
    // Cap sized so the wave guard denies the SECOND slot: requested
    // n=2, granted 1. The surviving candidate must still run in an isolated
    // envelope (never silently in-place) and its work be ADOPTED after.
    const configDir = reapMk(join(tmpdir(), "claudexor-degraded-race-"));
    writeFileSync(join(configDir, "config.yaml"), "budget:\n  estimate_usd_floor: 5\n");
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const orch = new Orchestrator({
        registry: new Map([
          ["a", diffImplementer("a", "local")],
          ["b", diffImplementer("b", "openai")],
        ]),
        reviewers: reviewers(),
      });
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["a", "b"],
        n: 2,
        inPlace: true,
        paidBudget: { kind: "finite", maxUsd: 5 },
      });
      expect(res.candidates.length).toBe(1); // wave guard trimmed the wave
      const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
      // The surviving slot ran ISOLATED: its work reached the live tree via
      // ADOPTION (work_product.adopted event), not direct in-place mutation.
      expect(events).toContain("work_product.adopted");
      expect(existsSync(join(repo, "CHANGED.txt"))).toBe(true);
      const wp = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
      expect(wp).toContain("adopted: true");
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    }
  });

  it("FinalVerifier: a winner whose gates fail on a FRESH verify tree is blocked, not shipped", async () => {
    const repo = await initRepo();
    // fake-implement writes IMPLEMENTED.md into its worktree -> real patch.
    // The gate greps the file CONTENT on the verify tree: it passes only if
    // the patch actually applied there (proves the fresh-tree mechanics),
    // and we then flip expectations with an impossible gate.
    const orchGreen = new Orchestrator({
      registry: new Map([
        ["a", diffImplementer("a", "local")],
        ["b", diffImplementer("b", "openai")],
      ]),
      reviewers: reviewers(),
    });
    const green = await orchGreen.run({
      repoRoot: repo,
      prompt: "implement",
      mode: "agent",
      harnesses: ["a", "b"],
      n: 2,
      tests: [shellGate("test -f CHANGED.txt")],
    });
    expect(["success", "ungated"]).toContain(legacyOutcome(green));
    const greenDecision = readFileSync(join(green.runDir, "arbitration", "decision.yaml"), "utf8");
    expect(greenDecision).toContain("final_verify");
    expect(greenDecision).toContain("applied_cleanly: true");
    expect(greenDecision).toContain("gates_passed: true");

    // Direct verdict coverage on the same repo (private method, cast):
    const { finalVerifyPatch } = await import("@claudexor/delivery");
    const noopVerifyLog = { emit: () => undefined };
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const goodPatch = [
      "diff --git a/v.txt b/v.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/v.txt",
      "@@ -0,0 +1 @@",
      "+verified",
      "",
    ].join("\n");
    const failingGates = [{ id: "g1", ...shellGate("exit 3"), required: true }];
    const gatesFail = await finalVerifyPatch(
      repo,
      { baseSha, diff: goodPatch },
      failingGates,
      noopVerifyLog,
    );
    expect(gatesFail).toMatchObject({
      attempted: true,
      applied_cleanly: true,
      gates_passed: false,
    });
    // A patch built against content the base never had -> apply refusal.
    const conflictPatch = [
      "diff --git a/math.js b/math.js",
      "index 000..111 100644",
      "--- a/math.js",
      "+++ b/math.js",
      "@@ -1 +1 @@",
      "-CONTENT THE BASE NEVER HAD",
      "+patched",
      "",
    ].join("\n");
    const conflict = await finalVerifyPatch(
      repo,
      { baseSha, diff: conflictPatch },
      failingGates,
      noopVerifyLog,
    );
    expect(conflict.attempted).toBe(true);
    expect(conflict.applied_cleanly).toBe(false);
    // No base sha at the HELPER level FAILS CLOSED (the in-place exemption
    // is a caller decision): an envelope patch without a recorded base
    // cannot be proven and must block, never silently bypass INV-115.
    const noBase = await finalVerifyPatch(repo, { diff: goodPatch }, failingGates, noopVerifyLog);
    expect(noBase.attempted).toBe(true);
    expect(noBase.applied_cleanly).toBeNull();
    const { finalVerifyBlocks } = await import("@claudexor/delivery");
    expect(finalVerifyBlocks(noBase)).toBe(true);
  });

  it("inactivity watchdog: a wedged harness stream ends as a typed failure, never a forever-running run (INV-116)", async () => {
    const repo = await initRepo();
    // One event, then silence with no exit: only the abort the watchdog
    // fires can end this stream (mirrors a wedged vendor CLI).
    const hangingAdapter: HarnessAdapter = {
      ...askAdapter("wedged", function* () {
        /* unused */
      }),
      async *run(spec) {
        yield { type: "started", session_id: spec.session_id, ts: new Date().toISOString() };
        const abort = spec.extra?.["abortSignal"] as AbortSignal | undefined;
        await new Promise<void>((resolve) => {
          if (abort?.aborted) return resolve();
          abort?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const prev = process.env["CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS"];
    process.env["CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS"] = "400";
    try {
      const orch = new Orchestrator({
        registry: new Map([["wedged", hangingAdapter]]),
        reviewers: [],
      });
      const started = Date.now();
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "ask",
        harnesses: ["wedged"],
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(legacyOutcome(res)).toBe("failed");
      expect(res.summary).toContain("inactivity watchdog");
      const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
      expect(events).toContain('"run.failed"');
    } finally {
      if (prev === undefined) delete process.env["CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS"];
      else process.env["CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS"] = prev;
    }
  });

  it("terminal net: a throw escaping an ANNOUNCED strategy still ends the run with failure.yaml + run.failed", async () => {
    const repo = await initRepo();
    const { guardAnnouncedRun } = await import("./runTerminals.js");
    const guard = guardAnnouncedRun as unknown as (
      signal: AbortSignal | undefined,
      body: (announce: (a: unknown) => void) => Promise<unknown>,
    ) => Promise<OrchestratorResult>;
    const { ArtifactStore } = await import("@claudexor/artifact-store");
    const { EventLog } = await import("@claudexor/event-log");

    // Pre-announce throws keep the loud-request contract (no run dir → rethrow).
    await expect(
      guard(undefined, async () => {
        throw new Error("pre-announce boom");
      }),
    ).rejects.toThrow("pre-announce boom");

    // Post-announce throws stamp terminal artifacts instead of orphaning the run.
    const store = new ArtifactStore(repo);
    const runId = "run-netted";
    const paths = store.createRun(runId);
    const log = new EventLog(paths.eventsPath, runId, "task-netted");
    const res = await guard(undefined, async (announce) => {
      log.emit("run.created", { mode: "agent", prompt: "x" });
      announce({ log, store, paths, runId, taskId: "task-netted", mode: "agent", phase: "race" });
      throw new Error("escaped mid-strategy");
    });
    expect(legacyOutcome(res)).toBe("failed");
    expect(res.summary).toContain("escaped mid-strategy");
    const events = readFileSync(paths.eventsPath, "utf8");
    expect(events).toContain("run.failed");
    expect(readFileSync(join(paths.root, "final", "failure.yaml"), "utf8")).toContain(
      "escaped mid-strategy",
    );

    // An abort mid-strategy is a CANCELLED terminal, not an internal failure.
    const ctrl = new AbortController();
    ctrl.abort();
    const paths2 = store.createRun("run-net-cancel");
    const log2 = new EventLog(paths2.eventsPath, "run-net-cancel", "task-nc");
    const res2 = await guard(ctrl.signal, async (announce) => {
      log2.emit("run.created", { mode: "agent", prompt: "x" });
      announce({
        log: log2,
        store,
        paths: paths2,
        runId: "run-net-cancel",
        taskId: "task-nc",
        mode: "agent",
        phase: "race",
      });
      throw new Error("abort surfaced as throw");
    });
    expect(res2.lifecycle).toBe("cancelled");
    expect(readFileSync(paths2.eventsPath, "utf8")).toContain('"lifecycle":"cancelled"');
  });

  it("terminalization hook fires with the runId on EVERY announced terminal, never pre-announce (QA-034 map leak)", async () => {
    const repo = await initRepo();
    const { guardAnnouncedRun } = await import("./runTerminals.js");
    const guard = guardAnnouncedRun as unknown as (
      signal: AbortSignal | undefined,
      body: (announce: (a: unknown) => void) => Promise<unknown>,
      beforeTerminal?: (context: unknown) => void | Promise<void>,
      onSettled?: (runId: string) => void,
    ) => Promise<OrchestratorResult>;
    const { ArtifactStore } = await import("@claudexor/artifact-store");
    const { EventLog } = await import("@claudexor/event-log");
    const store = new ArtifactStore(repo);

    // Pre-announce throw: no runId was ever assigned, so the hook must NOT fire
    // (there is nothing to release; the caller gets the loud error).
    const settled: string[] = [];
    await expect(
      guard(
        undefined,
        async () => {
          throw new Error("pre-announce boom");
        },
        undefined,
        (id) => settled.push(id),
      ),
    ).rejects.toThrow("pre-announce boom");
    expect(settled).toEqual([]);

    // Announced-then-throw: the run died before any telemetry writer — the hook
    // is exactly what releases per-run state here (the leak this closes).
    const p1 = store.createRun("hook-throw");
    const l1 = new EventLog(p1.eventsPath, "hook-throw", "t1");
    await guard(
      undefined,
      async (announce) => {
        l1.emit("run.created", { mode: "agent", prompt: "x" });
        announce({
          log: l1,
          store,
          paths: p1,
          runId: "hook-throw",
          taskId: "t1",
          mode: "agent",
          phase: "race",
        });
        throw new Error("mid-strategy");
      },
      undefined,
      (id) => settled.push(id),
    );
    expect(settled).toEqual(["hook-throw"]);

    // Normal return also settles (idempotent with the telemetry writer's own delete).
    const p2 = store.createRun("hook-ok");
    const l2 = new EventLog(p2.eventsPath, "hook-ok", "t2");
    await guard(
      undefined,
      async (announce) => {
        announce({
          log: l2,
          store,
          paths: p2,
          runId: "hook-ok",
          taskId: "t2",
          mode: "agent",
          phase: "race",
        });
        return {
          runId: "hook-ok",
          taskId: "t2",
          mode: "agent",
          lifecycle: "completed",
          facts: makeOutcomeFacts("succeeded"),
          winner: null,
          runDir: p2.root,
          summary: "ok",
          candidates: [],
        } as unknown as OrchestratorResult;
      },
      undefined,
      (id) => settled.push(id),
    );
    expect(settled).toEqual(["hook-throw", "hook-ok"]);
  });

  it("discloses a requested effort on a harness with no declared ladder via ignored_settings (INV-105)", async () => {
    const repo = await initRepo();
    // realLikeAdapter declares NO effort_levels — a configured per-harness
    // effort must be DISCLOSED as ignored on harness.started, never silently
    // dropped (and never forwarded to a CLI that has no such flag).
    const registry = new Map<string, HarnessAdapter>([
      ["codex", realLikeAdapter("codex", "openai")],
    ]);
    const configDir = reapMk(join(tmpdir(), "claudexor-effort-disclosure-"));
    writeFileSync(join(configDir, "config.yaml"), "harnesses:\n  codex:\n    effort: high\n");
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const orch = new Orchestrator({ registry, reviewers: [] });
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["codex"],
        n: 1,
      });
      const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
      expect(events).toContain("ignored_settings");
      expect(events).toContain("effort=high");
      expect(events).toContain("effort_levels is empty");
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    }
  });

  it("QA-035: freezes the config-derived default model and effort into the immutable TaskContract", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["codex", realLikeAdapter("codex", "openai")],
    ]);
    const configDir = reapMk(join(tmpdir(), "claudexor-qa035-freeze-"));
    // The user relies on Settings-level defaults instead of restating per turn.
    writeFileSync(
      join(configDir, "config.yaml"),
      "harnesses:\n  codex:\n    default_model: model-x\n    effort: high\n",
    );
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const orch = new Orchestrator({ registry, reviewers: [] });
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["codex"],
        n: 1,
      });
      const task = new ArtifactStore(repo).readYaml<{
        routing_models: Record<string, string>;
        routing_efforts: Record<string, string>;
      }>(join(res.runDir, "context", "task.yaml"));
      // Without the freeze these are {} and an Exact Retry re-resolves both
      // against whatever settings say at retry time (the QA-035 route drift).
      expect(task?.routing_models["codex"]).toBe("model-x");
      expect(task?.routing_efforts["codex"]).toBe("high");
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    }
  });

  it("QA-035: freezes Settings routes for a pure Auto pool without materializing an explicit pool", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["codex", realLikeAdapter("codex", "openai")],
    ]);
    const configDir = reapMk(join(tmpdir(), "claudexor-qa035-auto-freeze-"));
    writeFileSync(
      join(configDir, "config.yaml"),
      "harnesses:\n  codex:\n    default_model: auto-model\n    effort: high\n",
    );
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const orch = new Orchestrator({ registry, reviewers: [] });
      const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "agent", n: 1 });
      const task = new ArtifactStore(repo).readYaml<{
        routing_models: Record<string, string>;
        routing_efforts: Record<string, string>;
      }>(join(res.runDir, "context", "task.yaml"));

      expect(task?.routing_models).toEqual({ codex: "auto-model" });
      expect(task?.routing_efforts).toEqual({ codex: "high" });
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    }
  });

  it("lifts readiness-preferred auth route disclosures into typed run events", async () => {
    const repo = await initRepo();
    const adapter = askAdapter("authy", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield {
        type: "message",
        session_id: sessionId,
        ts,
        text: "[auth] auto selected api_key route because doctor smoke-proved it",
        payload: {
          auth_switched: true,
          from_auth_mode: "local_session",
          to_auth_mode: "api_key",
          reason: "readiness_preferred",
        },
      };
      yield { type: "message", session_id: sessionId, ts, text: "Answered." };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const orch = new Orchestrator({ registry: new Map([["authy", adapter]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "do it",
      mode: "ask",
      harnesses: ["authy"],
      n: 1,
    });
    expect(legacyOutcome(res)).toBe("success");
    const eventLog = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(eventLog).toContain("route.fallback.auth_switched");
    expect(eventLog).toContain("readiness_preferred");
    expect(eventLog).toContain('"from_auth_mode":"local_session"');
    expect(eventLog).toContain('"to_auth_mode":"api_key"');
    const answer = readFileSync(join(res.runDir, "final", "answer.md"), "utf8");
    expect(answer).toContain("Answered.");
    expect(answer).not.toContain("[auth]");
  });

  it("settles exact API cash when the readiness disclosure precedes started", async () => {
    const repo = await initRepo();
    const adapter = askAdapter("authy", function* (sessionId) {
      const ts = new Date().toISOString();
      yield {
        type: "message",
        session_id: sessionId,
        ts,
        credential_route: undefined,
        text: "[auth] auto selected api_key route because doctor smoke-proved it",
        payload: {
          auth_switched: true,
          from_auth_mode: "local_session",
          to_auth_mode: "api_key",
          reason: "readiness_preferred",
        },
      };
      yield { type: "started", session_id: sessionId, ts };
      yield { type: "message", session_id: sessionId, ts, text: "Answered." };
      yield {
        type: "usage",
        session_id: sessionId,
        ts,
        usage: { cost_usd: 0.08005475 },
      };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const orch = new Orchestrator({ registry: new Map([["authy", adapter]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "do it",
      mode: "ask",
      harnesses: ["authy"],
      n: 1,
      paidBudget: { kind: "finite", maxUsd: 1.5 },
    });

    expect(legacyOutcome(res)).toBe("success");
    expect(res.facts.reason).toBeNull();
    expectBudgetSplit(res.runDir, 0.08005475, 0);
  });

  it("does not start a fallback solely because optional web failed", async () => {
    const repo = await initRepo();
    const bad = askAdapter("web-bad", function* (sessionId) {
      const ts = new Date().toISOString();
      yield {
        type: "tool_call",
        session_id: sessionId,
        ts,
        text: "WebSearch",
        tool: {
          name: "WebSearch",
          kind: "web",
          use_id: "toolu_web",
          target: "current Node.js LTS version",
        },
      };
      yield {
        type: "tool_result",
        session_id: sessionId,
        ts,
        tool: {
          name: "WebSearch",
          kind: "web",
          use_id: "toolu_web",
          status: "error",
          error_summary: "permission denied",
        },
      };
      yield { type: "message", session_id: sessionId, ts, text: "Memory answer only." };
    });
    const good = askAdapter(
      "web-good",
      function* (sessionId) {
        const ts = new Date().toISOString();
        yield {
          type: "tool_call",
          session_id: sessionId,
          ts,
          text: "WebSearch",
          tool: {
            name: "WebSearch",
            kind: "web",
            use_id: "toolu_web2",
            target: "current Node.js LTS version",
          },
        };
        yield {
          type: "tool_result",
          session_id: sessionId,
          ts,
          tool: {
            name: "WebSearch",
            kind: "web",
            use_id: "toolu_web2",
            status: "ok",
            content_summary: "search result",
          },
        };
        yield { type: "message", session_id: sessionId, ts, text: "Web-backed answer." };
      },
      "anthropic",
    );
    const orch = new Orchestrator({
      registry: new Map([
        ["web-bad", bad],
        ["web-good", good],
      ]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "google this",
      mode: "ask",
      harnesses: ["web-bad", "web-good"],
      web: "auto",
    });
    expect(legacyOutcome(res)).toBe("success");
    expect(readFileSync(join(res.runDir, "final", "answer.md"), "utf8")).toContain(
      "Memory answer only.",
    );
    const eventLog = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(eventLog).not.toContain("route.fallback.started");
    expect(eventLog).not.toContain("route.fallback.completed");
  });

  it("stores no-project Ask artifacts in the user config store, not the synthetic repo root", async () => {
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    const configDir = reapMk(join(tmpdir(), "claudexor-orch-config-"));
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const noProjectRoot = noProjectRepoRoot();
      mkdirSync(noProjectRoot, { recursive: true });
      const registry = new Map<string, HarnessAdapter>([
        ["fake-success", createFakeHarness("fake-success")],
      ]);
      const orch = new Orchestrator({ registry, reviewers: [] });
      const res = await orch.run({
        repoRoot: noProjectRoot,
        prompt: "2+2?",
        mode: "ask",
        contextMode: "off",
        harnesses: ["fake-success"],
      });
      expect(legacyOutcome(res)).toBe("success");
      expect(res.runDir.startsWith(join(configDir, "runs"))).toBe(true);
      expect(existsSync(join(res.runDir, "final", "answer.md"))).toBe(true);
      expect(existsSync(join(noProjectRoot, ".claudexor"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    }
  });

  it("rejects contextMode off outside no-project Ask", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    await expect(
      orch.run({
        repoRoot: repo,
        prompt: "2+2?",
        mode: "ask",
        contextMode: "off",
        harnesses: ["fake-success"],
      }),
    ).rejects.toThrow("contextMode 'off' is only supported for Ask without a repoRoot");
  });

  it("runs deep scan as a bounded read-only scout sweep with a synthesis reducer and per-explorer artifacts", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "map auth and run storage",
      mode: "ask",
      deepScan: true,
      harnesses: ["fake-success"],
      n: 2,
    });
    expect(legacyOutcome(res)).toBe("success");
    // The scouts are the run's candidate roster (the reducer is a telemetry-only
    // attempt, not a scout candidate).
    expect(res.candidates).toHaveLength(2);
    // The raw scout reports remain as per-attempt artifacts.
    expect(existsSync(join(res.runDir, "findings", "a01.md"))).toBe(true);
    expect(existsSync(join(res.runDir, "findings", "a02.md"))).toBe(true);
    // The final report is the reducer's real merge, not a raw concatenation.
    const report = readFileSync(join(res.runDir, "final", "report.md"), "utf8");
    expect(report).toContain("Merged synthesis");
    expect(report).not.toContain("Raw scout bundle");
    expect(existsSync(join(res.runDir, "final", "explore-findings.yaml"))).toBe(true);
    expect(existsSync(join(res.runDir, "final", "omissions.md"))).toBe(true);
    expect(
      readRunEvents(res.runDir).find(
        (event) => event.type === "output.ready" && event.payload["path"] === "final/report.md",
      )?.payload["kind"],
    ).toBe("report");
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toContain("status: succeeded");
  });

  it("deep scan records a pre-stream scout failure without disposing a slow admitted sibling's HOME", async () => {
    const repo = await initRepo();
    const rejected = askAdapter("scout-setup-fail", () => []);
    const slowBase = askAdapter("scout-slow", () => []);
    let scopedHome: string | null = null;
    let observedHomeAlive = false;
    const slow: HarnessAdapter = {
      ...slowBase,
      async *run(spec) {
        scopedHome = spec.env["HOME"] ?? null;
        await new Promise((resolve) => setTimeout(resolve, 60));
        observedHomeAlive = scopedHome !== null && existsSync(scopedHome);
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: "Slow scout report",
          final: true,
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([
        [rejected.id, rejected],
        [slow.id, slow],
      ]),
      reviewers: [],
    });
    rejectSessionPreparationFor(orch, rejected.id);

    const res = await orch.run({
      repoRoot: repo,
      prompt: "map the repository",
      mode: "ask",
      deepScan: true,
      n: 2,
      harnesses: [rejected.id, slow.id],
    });

    expect(legacyOutcome(res)).toBe("success");
    expect(observedHomeAlive).toBe(true);
    expect(scopedHome).not.toBeNull();
    expect(existsSync(scopedHome ?? "")).toBe(false);
    expect(readFileSync(join(res.runDir, "final", "report.md"), "utf8")).toContain(
      "Slow scout report",
    );
    expect(
      readRunEvents(res.runDir).some(
        (event) => event.type === "harness.started" && event.payload["harness_id"] === rejected.id,
      ),
    ).toBe(false);
  });

  it("QA-019: n>1 subscription deep-scan scouts admit under a finite cap via the estimate floor (both scouts run)", async () => {
    const repo = await initRepo();
    // A subscription scout: vendor-native route, no cash usage. Without the
    // estimate floor the SECOND parallel scout reserves an unknown-cost paid unit
    // under the finite cap and is refused (unknown_paid_in_flight); the idx>0
    // floor gives it a bounded estimate so it admits.
    const subScout = (id: string): HarnessAdapter =>
      askAdapter(id, function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts, credential_route: "vendor_native" };
        yield {
          type: "message",
          session_id: sessionId,
          ts,
          text: "Subscription scout analysis.",
          credential_route: "vendor_native",
        };
        yield { type: "completed", session_id: sessionId, ts, credential_route: "vendor_native" };
      });
    const registry = new Map<string, HarnessAdapter>([["sub-scout", subScout("sub-scout")]]);
    const orch = new Orchestrator({
      registry,
      reviewers: [],
      paidBudget: { kind: "finite", maxUsd: 5 },
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "map auth and run storage",
      mode: "ask",
      deepScan: true,
      harnesses: ["sub-scout"],
      n: 2,
    });
    expect(legacyOutcome(res)).toBe("success");
    const findings = readFileSync(join(res.runDir, "final", "report.md"), "utf8");
    expect(findings).toContain("Explorers succeeded: 2/2");
  });

  it("QA-019: a still-denied scout in a partial scan is disclosed in the denominator (1/2) and omissions", async () => {
    const repo = await initRepo();
    // Subscription scouts (vendor-native, no cash). A cap BELOW the estimate
    // floor (0.05) admits the first unknown-cost scout but refuses the second
    // even with its floor estimate (estimate_headroom) — a genuine 1/2 partial.
    const subScout = (id: string): HarnessAdapter =>
      askAdapter(id, function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts, credential_route: "vendor_native" };
        yield {
          type: "message",
          session_id: sessionId,
          ts,
          text: "Subscription scout analysis.",
          credential_route: "vendor_native",
        };
        yield { type: "completed", session_id: sessionId, ts, credential_route: "vendor_native" };
      });
    const registry = new Map<string, HarnessAdapter>([["sub-scout", subScout("sub-scout")]]);
    const orch = new Orchestrator({
      registry,
      reviewers: [],
      paidBudget: { kind: "finite", maxUsd: 0.04 },
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "map auth and run storage",
      mode: "ask",
      deepScan: true,
      harnesses: ["sub-scout"],
      n: 2,
    });
    // Denominator is honest: 1 of 2, not 1 of 1 — the denied scout is disclosed.
    const report = readFileSync(join(res.runDir, "final", "report.md"), "utf8");
    expect(report).toContain("Explorers succeeded: 1/2");
    const omissions = readFileSync(join(res.runDir, "final", "omissions.md"), "utf8");
    expect(omissions).toContain("budget denied before spawn");
    const findings = readFileSync(join(res.runDir, "final", "explore-findings.yaml"), "utf8");
    expect(findings).toMatch(/status: failed/);
  });

  it("QA-019/QA-050: an all-denied scan names budget in the terminal (classifier), never harness_error/auth", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({
      registry,
      reviewers: [],
      // A $0 finite cap refuses every non-proven-free scout before spawn.
      paidBudget: { kind: "finite", maxUsd: 0 },
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "map auth and run storage",
      mode: "ask",
      deepScan: true,
      harnesses: ["fake-success"],
      n: 2,
    });
    expect(legacyOutcome(res)).not.toBe("success");
    // The terminal routes through the QA-050 budget classifier: phase budget and
    // budget remediation — never a harness auth/setup template. The budget-denied
    // markers on the recorded attempts keep this classifier eligible.
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).toMatch(/phase: budget/);
    expect(failure).not.toMatch(/harness authentication/);
  });

  it("QA-034: the pool ordering rationale is recorded once as run telemetry evidence (order + decisive reason + per-candidate entries)", async () => {
    const repo = await initRepo();
    const a = askAdapter("route-a", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield { type: "message", session_id: sessionId, ts, text: "Answer from route-a." };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const b = askAdapter(
      "route-b",
      function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        yield { type: "message", session_id: sessionId, ts, text: "Answer from route-b." };
        yield { type: "completed", session_id: sessionId, ts };
      },
      "anthropic",
    );
    const registry = new Map<string, HarnessAdapter>([
      ["route-a", a],
      ["route-b", b],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "2+2?",
      mode: "ask",
      routingGoal: "economy",
      harnesses: ["route-a", "route-b"],
    });
    expect(legacyOutcome(res)).toBe("success");
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toContain("routing_rationale");
    // A real typed tuple: goal, a decisive reason, and per-candidate entries for
    // BOTH pooled routes — not a reconstruction from prose.
    expect(telemetry).toMatch(/goal: economy/);
    expect(telemetry).toMatch(
      /reason: (subscription_entitlement_first|lowest_incremental_cash|all_incremental_cash_unknown|declared_order)/,
    );
    expect(telemetry).toContain("route-a");
    expect(telemetry).toContain("route-b");
  });

  it("keeps warning-bearing explorers in deep-scan synthesis when they produced a report", async () => {
    const repo = await initRepo();
    const warned = askAdapter("warned", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield {
        type: "tool_call",
        session_id: sessionId,
        ts,
        text: "Grep",
        tool: { name: "Grep", kind: "search", use_id: "g1", target: "packages/*/package.json" },
      };
      yield {
        type: "tool_result",
        session_id: sessionId,
        ts,
        tool: {
          name: "Grep",
          kind: "search",
          use_id: "g1",
          status: "error",
          error_summary: "bad glob",
        },
      };
      yield { type: "message", session_id: sessionId, ts, text: "Useful repository analysis." };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const clean = askAdapter(
      "clean",
      function* (sessionId) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: sessionId, ts };
        yield { type: "message", session_id: sessionId, ts, text: "Second useful analysis." };
        yield { type: "completed", session_id: sessionId, ts };
      },
      "anthropic",
    );
    const orch = new Orchestrator({
      registry: new Map([
        ["warned", warned],
        ["clean", clean],
      ]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "map auth and run storage",
      mode: "ask",
      deepScan: true,
      harnesses: ["warned", "clean"],
      n: 2,
    });
    expect(legacyOutcome(res)).toBe("success");
    const explore = readFileSync(join(res.runDir, "final", "report.md"), "utf8");
    expect(explore).toContain("Explorers succeeded: 2/2");
    expect(explore).toContain("Useful repository analysis.");
    expect(explore).toContain("Tool warnings");
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toContain("tool_warnings_total: 1");
  });

  // A synthesize-capable read-only adapter (#27 / D-6). It answers the audit
  // (scout) intent with a distinct per-scout report and, on the synthesize
  // (reducer) intent, either merges or errors — driving the reducer stories.
  function reducerAdapter(
    id: string,
    opts: {
      synthOutcome: "merge" | "error";
      scoutCostUsd?: number;
      /** Abort the run's OUTER signal MID-reducer (after the merge message, before
       * completion) — the cancel-during-synthesis race (INV-116). */
      abortMidSynth?: AbortController;
    },
  ): HarnessAdapter {
    return {
      id,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { plan: true, review: true, read_files: true, synthesize: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          enabled_intents: ["explain", "audit", "plan", "review", "synthesize"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          credential_route: "managed_api_key",
        } as never;
        if (spec.intent === "synthesize") {
          if (opts.synthOutcome === "error") {
            yield {
              type: "error",
              session_id: spec.session_id,
              ts,
              error: "reducer model crashed",
              credential_route: "managed_api_key",
            } as never;
          } else {
            yield {
              type: "message",
              session_id: spec.session_id,
              ts,
              text: "MERGED-SYNTHESIS: deduped scout findings, attributed disagreements, kept omissions.",
              credential_route: "managed_api_key",
            } as never;
            // The run is cancelled WHILE the reducer streams: the scouts already
            // finished, so the pre-synthesis abort check passed and only the
            // post-synthesis re-check can catch this (INV-116).
            opts.abortMidSynth?.abort();
          }
          yield { type: "completed", session_id: spec.session_id, ts } as never;
          return;
        }
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: `Scout analysis from ${spec.session_id}.`,
          credential_route: "managed_api_key",
        } as never;
        if (opts.scoutCostUsd)
          yield {
            type: "usage",
            session_id: spec.session_id,
            ts,
            usage: { cost_usd: opts.scoutCostUsd },
            credential_route: "managed_api_key",
          } as never;
        yield { type: "completed", session_id: spec.session_id, ts } as never;
      },
    };
  }

  it("#27: a multi-scout deep scan runs a bounded synthesis reducer whose merge becomes the final report", async () => {
    const repo = await initRepo();
    // fake-implement declares synthesize; its reducer branch emits a distinct
    // MERGED report when it sees the deep-scan reducer marker.
    const registry = new Map<string, HarnessAdapter>([
      ["fake-implement", createFakeHarness("fake-implement")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "map auth and run storage",
      mode: "ask",
      deepScan: true,
      harnesses: ["fake-implement"],
      n: 2,
    });
    expect(legacyOutcome(res)).toBe("success");
    // The reducer output IS the final report — not a raw concatenation.
    const report = readFileSync(join(res.runDir, "final", "report.md"), "utf8");
    expect(report).toContain("Merged synthesis");
    expect(report).not.toContain("Explorers succeeded");
    expect(report).not.toContain("Raw scout bundle");
    // Raw scout reports remain as per-attempt artifacts.
    expect(existsSync(join(res.runDir, "findings", "a01.md"))).toBe(true);
    expect(existsSync(join(res.runDir, "findings", "a02.md"))).toBe(true);
    // The reducer is a normal attempt in telemetry (roster/cost visible) and the
    // typed synthesis status is succeeded.
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toContain("status: succeeded");
    expect(telemetry).toContain("reducer_attempt_id: synth");
    expect(telemetry).toMatch(/attempt_id: synth/);
    const workProduct = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
    expect(workProduct).toContain("producer_attempt_id: synth");
    expect(readRunFacts(repo, res).deliverable.producer_attempt_id).toBe("synth");
  });

  it("INV-116: a cancel that lands WHILE the deep-scan reducer runs is a cancelled terminal, never a laundered success", async () => {
    const repo = await initRepo();
    const ac = new AbortController();
    // The scouts finish while the signal is live (pre-synthesis abort check
    // passes); the reducer then aborts the OUTER signal mid-merge, so only the
    // post-synthesis re-check can catch it.
    const registry = new Map<string, HarnessAdapter>([
      [
        "synth-cancel",
        reducerAdapter("synth-cancel", { synthOutcome: "merge", abortMidSynth: ac }),
      ],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "map auth and run storage",
      mode: "ask",
      deepScan: true,
      harnesses: ["synth-cancel"],
      n: 2,
      signal: ac.signal,
    });
    // The run terminalizes CANCELLED — not the succeeded read-only report path.
    expect(legacyOutcome(res)).toBe("cancelled");
    expect(res.lifecycle).toBe("cancelled");
    // No success artifact: the merged report.md is never written on the cancel.
    expect(existsSync(join(res.runDir, "final", "report.md"))).toBe(false);
    const summary = readFileSync(join(res.runDir, "final", "summary.md"), "utf8");
    expect(summary).toContain("Lifecycle: cancelled");
    expect(summary).not.toContain("Merged synthesis");
  });

  it("#27: a failed reducer degrades to an HONEST raw scout bundle, never a fake synthesis", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["synth-crash", reducerAdapter("synth-crash", { synthOutcome: "error" })],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "map auth and run storage",
      mode: "ask",
      deepScan: true,
      harnesses: ["synth-crash"],
      n: 2,
    });
    // The run still SUCCEEDS — the scouts produced reports; only the merge failed.
    expect(legacyOutcome(res)).toBe("success");
    const report = readFileSync(join(res.runDir, "final", "report.md"), "utf8");
    expect(report).toContain("Raw scout bundle — NOT a merged synthesis");
    expect(report).toContain("Explorers succeeded: 2/2");
    expect(report).toContain("Scout analysis from");
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toContain("status: failed");
    expect(telemetry).toContain("reducer model crashed");
    // The reducer attempt is still on the roster (its cost/route are visible).
    expect(telemetry).toMatch(/attempt_id: synth/);
  });

  it("#27/QA-050: a budget-denied reducer degrades honestly with a budget reason (classifier)", async () => {
    const repo = await initRepo();
    // Two metered scouts settle 4.98 of a $5 cap; the reducer's finite estimate
    // floor (0.05) then exceeds the 0.02 headroom and is refused before spawn.
    const registry = new Map<string, HarnessAdapter>([
      [
        "metered-synth",
        reducerAdapter("metered-synth", { synthOutcome: "merge", scoutCostUsd: 2.49 }),
      ],
    ]);
    const orch = new Orchestrator({
      registry,
      reviewers: [],
      paidBudget: { kind: "finite", maxUsd: 5 },
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "map auth and run storage",
      mode: "ask",
      deepScan: true,
      harnesses: ["metered-synth"],
      n: 2,
    });
    expect(legacyOutcome(res)).toBe("success");
    const report = readFileSync(join(res.runDir, "final", "report.md"), "utf8");
    expect(report).toContain("Raw scout bundle — NOT a merged synthesis");
    expect(report).toContain("Explorers succeeded: 2/2");
    // The merged text must NOT appear — the reducer never spawned.
    expect(report).not.toContain("MERGED-SYNTHESIS");
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toContain("status: failed");
    expect(telemetry).toMatch(/reason:.*budget/i);
  });

  it("#27: a width-1 deep scan skips the reducer (single report needs no merge)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-implement", createFakeHarness("fake-implement")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "map auth and run storage",
      mode: "ask",
      deepScan: true,
      harnesses: ["fake-implement"],
      n: 1,
    });
    expect(legacyOutcome(res)).toBe("success");
    const report = readFileSync(join(res.runDir, "final", "report.md"), "utf8");
    // No reducer ran; the single scout report is presented honestly, not as a merge.
    expect(report).not.toContain("Merged synthesis");
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toContain("status: skipped");
    expect(telemetry).not.toMatch(/attempt_id: synth/);
  });

  it("runs deterministic gates from the tests input (test-driven, not vacuous)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });

    // A failing gate must make the candidate red (gates are no longer vacuous).
    const failed = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      n: 1,
      tests: [shellGate("exit 1")],
    });
    expect(failed.candidates[0]?.status).toBe("red");

    // A passing gate keeps the candidate green.
    const passed = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      n: 1,
      tests: [shellGate("true")],
    });
    expect(passed.candidates[0]?.status).toBe("green");
  });

  it("does not leak a worktree when a candidate errors", async () => {
    const repo = await initRepo();
    const throwing: HarnessAdapter = {
      id: "throwing",
      async discover() {
        return HarnessManifest.parse({
          id: "throwing",
          display_name: "throwing",
          kind: "local_cli",
          capabilities: { implement: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({ harness_id: "throwing", status: "ok" });
      },
      async *run() {
        throw new Error("boom");
      },
    };
    const registry = new Map<string, HarnessAdapter>([["throwing", throwing]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["throwing"],
      n: 1,
    });
    expect(legacyOutcome(res)).toBe("failed");
    expect(existsSync(join(res.runDir, "final", "failure.yaml"))).toBe(true);
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "attempts/a01/attempt.yaml",
    );
    expect(existsSync(join(repo, ".claudexor", "workspaces", res.taskId, "a01"))).toBe(false);
  });

  it("applies a per-family reviewer model override (cheaper reviewer)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-impl", diffImplementer("fake-impl")],
      ["rev-openai", realLikeAdapter("rev-openai", "openai")],
      ["rev-anthropic", realLikeAdapter("rev-anthropic", "anthropic")],
    ]);
    const orch = new Orchestrator({
      registry,
      reviewerModels: { openai: "o-cheap-model", anthropic: "a-cheap-model" },
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-impl"],
      n: 1,
    });
    const reviewYaml = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(reviewYaml).toContain("o-cheap-model");
    expect(reviewYaml).toContain("a-cheap-model");
  });

  it("applies per-family reviewer effort overrides", async () => {
    const repo = await initRepo();
    const seen: { id: string; model: string | null; effort: string | null }[] = [];
    function reviewer(id: string, family: ProviderFamily): HarnessAdapter {
      return {
        id,
        async discover() {
          return HarnessManifest.parse({
            id,
            display_name: id,
            kind: "local_cli",
            provider_family: family,
            capabilities: {
              review: true,
              effort_levels: family === "anthropic" ? ["max"] : [],
            },
            access_profiles_supported: ["readonly"],
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: id,
            status: "ok",
            enabled_intents: ["review"],
          });
        },
        async models() {
          const ids =
            family === "anthropic"
              ? ["claude-opus-4-8", "opus"]
              : ["gemini-3.1-pro", "gemini-3.5-flash", "gpt-5.5-xhigh-1M", "o-review"];
          return ids.map((modelId) => ({
            id: modelId,
            label: null,
            context_window: null,
            routes: null,
          }));
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          seen.push({ id, model: spec.model_hint, effort: spec.effort_hint });
          yield {
            type: "started",
            session_id: spec.session_id,
            ts,
            observed_model: `${id}-observed`,
          };
          yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
        },
      };
    }
    const registry = new Map<string, HarnessAdapter>([
      ["fake-impl", diffImplementer("fake-impl")],
      ["rev-openai", reviewer("rev-openai", "openai")],
      ["rev-anthropic", reviewer("rev-anthropic", "anthropic")],
    ]);
    const orch = new Orchestrator({
      registry,
      reviewerModels: { openai: "o-review", anthropic: "opus" },
      reviewerEfforts: { anthropic: "max" },
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-impl"],
      n: 1,
    });
    expect(seen).toEqual(
      expect.arrayContaining([
        { id: "rev-openai", model: "o-review", effort: null },
        { id: "rev-anthropic", model: "opus", effort: "max" },
      ]),
    );
    const reviewYaml = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(reviewYaml).toContain("reviewer_requests:");
    expect(reviewYaml).toContain("requested_effort: max");
  });

  it("honors an explicit reviewer panel with repeated same-harness model entries", async () => {
    const repo = await initRepo();
    const seen: { id: string; model: string | null; effort: string | null }[] = [];
    function reviewer(id: string, family: ProviderFamily): HarnessAdapter {
      return {
        id,
        async discover() {
          return HarnessManifest.parse({
            id,
            display_name: id,
            kind: "local_cli",
            provider_family: family,
            capabilities: {
              review: true,
              effort_levels: family === "anthropic" ? ["max"] : [],
            },
            access_profiles_supported: ["readonly"],
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: id,
            status: "ok",
            enabled_intents: ["review"],
          });
        },
        async models() {
          const ids =
            family === "anthropic"
              ? ["claude-opus-4-8"]
              : ["gemini-3.1-pro", "gemini-3.5-flash", "gpt-5.5-xhigh-1M"];
          return ids.map((modelId) => ({
            id: modelId,
            label: null,
            context_window: null,
            routes: null,
          }));
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          seen.push({ id, model: spec.model_hint, effort: spec.effort_hint });
          yield {
            type: "started",
            session_id: spec.session_id,
            ts,
            observed_model: spec.model_hint ?? `${id}-observed`,
          };
          yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      };
    }
    const registry = new Map<string, HarnessAdapter>([
      ["fake-impl", diffImplementer("fake-impl")],
      ["rev-claude", reviewer("rev-claude", "anthropic")],
      ["rev-cursor", reviewer("rev-cursor", "cursor")],
    ]);
    const orch = new Orchestrator({
      registry,
      reviewerPanel: [
        { harness: "rev-claude", model: "claude-opus-4-8", effort: "max" },
        { harness: "rev-cursor", model: "gemini-3.1-pro" },
        { harness: "rev-cursor", model: "gemini-3.5-flash" },
        { harness: "rev-cursor", model: "gpt-5.5-xhigh-1M" },
      ],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-impl"],
      n: 1,
    });
    expect(legacyOutcome(res)).toBe("success");
    expect(seen).toHaveLength(4);
    expect(seen).toEqual(
      expect.arrayContaining([
        { id: "rev-claude", model: "claude-opus-4-8", effort: "max" },
        { id: "rev-cursor", model: "gemini-3.1-pro", effort: null },
        { id: "rev-cursor", model: "gemini-3.5-flash", effort: null },
        { id: "rev-cursor", model: "gpt-5.5-xhigh-1M", effort: null },
      ]),
    );
    const reviewYaml = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(reviewYaml).toContain("reviewer_requests:");
    expect(reviewYaml).toContain("claude-opus-4-8");
    expect(reviewYaml).toContain("gemini-3.1-pro");
    expect(reviewYaml).toContain("gemini-3.5-flash");
    expect(reviewYaml).toContain("gpt-5.5-xhigh-1M");
  });

  it("rejects explicit reviewer panel effort hints unsupported by the harness", async () => {
    const repo = await initRepo();
    const reviewer: HarnessAdapter = {
      id: "rev-cursor",
      async discover() {
        return HarnessManifest.parse({
          id: "rev-cursor",
          display_name: "rev cursor",
          kind: "local_cli",
          provider_family: "cursor",
          capabilities: { review: true, effort_levels: [] },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "rev-cursor",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async models() {
        return [{ id: "gemini-3.1-pro", label: null, context_window: null, routes: null }];
      },
      async *run() {
        throw new Error("reviewer should not run when effort validation fails");
      },
    };
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev-cursor", reviewer],
      ]),
      reviewerPanel: [{ harness: "rev-cursor", model: "gemini-3.1-pro", effort: "max" }],
    });

    const effortRes = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-impl"],
      n: 1,
    });
    expect(legacyOutcome(effortRes)).toBe("failed");
    expect(effortRes.summary).toContain(
      "reviewer harness 'rev-cursor' does not support requested effort 'max' (harness declares no effort controls)",
    );
  });

  it("uses configured default model for harness-only explicit reviewer panel entries", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-reviewer-panel-default-config-"));
    writeFileSync(
      join(configDir, "config.yaml"),
      "harnesses:\n  rev:\n    default_model: configured-review-model\n",
    );
    const seen: { model: string | null; effort: string | null }[] = [];
    const reviewer: HarnessAdapter = {
      id: "rev",
      async discover() {
        return HarnessManifest.parse({
          id: "rev",
          display_name: "rev",
          kind: "local_cli",
          provider_family: "cursor",
          capabilities: { review: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "rev",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async models() {
        return [{ id: "configured-review-model", label: null, context_window: null, routes: null }];
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        seen.push({ model: spec.model_hint, effort: spec.effort_hint });
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: spec.model_hint ?? "rev-observed",
        };
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const registry = new Map<string, HarnessAdapter>([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer],
      ]);
      const orch = new Orchestrator({ registry, reviewerPanel: [{ harness: "rev" }] });
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["fake-impl"],
        n: 1,
      });
      expect(res.facts.review).toBe("not_run");
      expect(seen).toEqual([{ model: "configured-review-model", effort: null }]);
      const reviewYaml = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
      expect(reviewYaml).toContain("requested_model: configured-review-model");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("validates explicit reviewer models against the scoped per-run auth route", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-reviewer-panel-config-"));
    writeFileSync(
      join(configDir, "config.yaml"),
      "harnesses:\n  rev:\n    auth_preference: subscription\n",
    );
    const modelSpecs: DoctorSpec[] = [];
    const doctorSpecs: DoctorSpec[] = [];
    const runSpecs: Array<{ auth: string; home: string | undefined }> = [];
    const reviewer: HarnessAdapter = {
      id: "rev",
      async discover() {
        return HarnessManifest.parse({
          id: "rev",
          display_name: "rev",
          kind: "local_cli",
          provider_family: "cursor",
          capabilities: { review: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor(spec) {
        doctorSpecs.push(spec);
        return ConformanceReport.parse({
          harness_id: "rev",
          status: spec.env?.["HOME"] && spec.authPreference === "api_key" ? "ok" : "unavailable",
          enabled_intents:
            spec.env?.["HOME"] && spec.authPreference === "api_key" ? ["review"] : [],
        });
      },
      async models(spec) {
        modelSpecs.push(spec ?? { cwd: "" });
        return spec?.env?.["HOME"] && spec.authPreference === "api_key"
          ? [{ id: "scoped-api-model", label: null, context_window: null, routes: null }]
          : [{ id: "native-model", label: null, context_window: null, routes: null }];
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        runSpecs.push({ auth: spec.auth_preference, home: spec.env?.["HOME"] });
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: spec.model_hint ?? "rev-observed",
        };
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const registry = new Map<string, HarnessAdapter>([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer],
      ]);
      const orch = new Orchestrator({
        registry,
        reviewerPanel: [{ harness: "rev", model: "scoped-api-model" }],
      });
      await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["fake-impl"],
        authPreference: "api_key",
        n: 1,
      });
      const scopedDoctorSpec = doctorSpecs.find(
        (spec) => spec.authPreference === "api_key" && Boolean(spec.env?.["HOME"]),
      );
      expect(scopedDoctorSpec).toBeTruthy();
      expect(modelSpecs).toHaveLength(1);
      expect(modelSpecs[0]?.authPreference).toBe("api_key");
      expect(modelSpecs[0]?.env?.["HOME"]).toBeTruthy();
      expect(runSpecs).toHaveLength(1);
      expect(runSpecs[0]?.auth).toBe("api_key");
      expect(runSpecs[0]?.home).toBeTruthy();
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("selects automatic reviewers using scoped per-run auth readiness", async () => {
    const repo = await initRepo();
    const doctorSpecs: DoctorSpec[] = [];
    const runSpecs: Array<{ auth: string; home: string | undefined }> = [];
    const reviewer: HarnessAdapter = {
      id: "rev",
      async discover() {
        return HarnessManifest.parse({
          id: "rev",
          display_name: "rev",
          kind: "local_cli",
          provider_family: "cursor",
          capabilities: { review: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor(spec) {
        doctorSpecs.push(spec);
        const scopedSubscription = spec.env?.["HOME"] && spec.authPreference === "subscription";
        return ConformanceReport.parse({
          harness_id: "rev",
          status: scopedSubscription ? "ok" : "unavailable",
          enabled_intents: scopedSubscription ? ["review"] : [],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        runSpecs.push({ auth: spec.auth_preference, home: spec.env?.["HOME"] });
        yield { type: "started", session_id: spec.session_id, ts };
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([
      ["fake-impl", diffImplementer("fake-impl")],
      ["rev", reviewer],
    ]);
    const orch = new Orchestrator({ registry });

    await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-impl"],
      authPreference: "subscription",
      n: 1,
    });

    expect(doctorSpecs).toContainEqual(
      expect.objectContaining({
        authPreference: "subscription",
        env: expect.objectContaining({ HOME: expect.any(String) }),
      }),
    );
    expect(runSpecs).toEqual([{ auth: "subscription", home: expect.any(String) }]);
  });

  it("skips disabled automatic reviewers before doctor probes", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-disabled-reviewer-config-"));
    writeFileSync(join(configDir, "config.yaml"), "harnesses:\n  rev:\n    enabled: false\n");
    let doctorCalls = 0;
    const reviewer: HarnessAdapter = {
      id: "rev",
      async discover() {
        return HarnessManifest.parse({
          id: "rev",
          display_name: "rev",
          kind: "local_cli",
          provider_family: "cursor",
          capabilities: { review: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        doctorCalls += 1;
        return ConformanceReport.parse({
          harness_id: "rev",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run() {
        throw new Error("disabled reviewer should not run");
      },
    };
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const orch = new Orchestrator({
        registry: new Map([
          ["fake-impl", diffImplementer("fake-impl")],
          ["rev", reviewer],
        ]),
      });
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["fake-impl"],
        n: 1,
      });
      expect(["success", "ungated", "review_not_run"]).toContain(legacyOutcome(res));
      expect(doctorCalls).toBe(0);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("retries transient explicit reviewer model inventory failures before failing the panel", async () => {
    const repo = await initRepo();
    let modelCalls = 0;
    const modelCallTimes: number[] = [];
    const seenModels: Array<string | null> = [];
    const reviewer: HarnessAdapter = {
      id: "rev",
      async discover() {
        return HarnessManifest.parse({
          id: "rev",
          display_name: "rev",
          kind: "local_cli",
          provider_family: "cursor",
          capabilities: { review: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "rev",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async models() {
        modelCalls += 1;
        modelCallTimes.push(Date.now());
        if (modelCalls === 1) throw new Error("transient inventory crash");
        return [{ id: "retry-model", label: null, context_window: null, routes: null }];
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        seenModels.push(spec.model_hint ?? null);
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: spec.model_hint ?? "rev-observed",
        };
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([
      ["fake-impl", diffImplementer("fake-impl")],
      ["rev", reviewer],
    ]);
    const orch = new Orchestrator({
      registry,
      reviewerPanel: [{ harness: "rev", model: "retry-model" }],
    });

    await orch.run({ repoRoot: repo, prompt: "x", mode: "agent", harnesses: ["fake-impl"], n: 1 });

    expect(modelCalls).toBe(2);
    expect((modelCallTimes[1] ?? 0) - (modelCallTimes[0] ?? 0)).toBeGreaterThanOrEqual(200);
    expect(seenModels).toEqual(["retry-model"]);
  });

  it("retries empty explicit reviewer model inventories before failing the panel", async () => {
    const repo = await initRepo();
    let modelCalls = 0;
    const modelCallTimes: number[] = [];
    const reviewer: HarnessAdapter = {
      id: "rev",
      async discover() {
        return HarnessManifest.parse({
          id: "rev",
          display_name: "rev",
          kind: "local_cli",
          provider_family: "cursor",
          capabilities: { review: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "rev",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async models() {
        modelCalls += 1;
        modelCallTimes.push(Date.now());
        return [];
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: spec.model_hint ?? "rev-observed",
        };
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const registry = new Map<string, HarnessAdapter>([
      ["fake-impl", diffImplementer("fake-impl")],
      ["rev", reviewer],
    ]);
    const orch = new Orchestrator({
      registry,
      reviewerPanel: [{ harness: "rev", model: "retry-model" }],
    });

    const emptyRes = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-impl"],
      n: 1,
    });
    expect(legacyOutcome(emptyRes)).toBe("failed");
    expect(emptyRes.summary).toMatch(
      /model inventory call failed after retry: model inventory was empty/,
    );
    expect(modelCalls).toBe(2);
    expect((modelCallTimes[1] ?? 0) - (modelCallTimes[0] ?? 0)).toBeGreaterThanOrEqual(200);
  });

  it("validates explicit reviewer panel entries and model evidence loudly", async () => {
    function reviewer(
      id: string,
      opts: {
        kind?: "local_cli" | "fake";
        status?: "ok" | "degraded" | "unavailable";
        enabledIntents?: string[];
        reviewCapability?: boolean;
        accessProfiles?: string[];
        discoverThrows?: boolean;
        models?: string[];
        modelsThrow?: boolean;
        omitModels?: boolean;
        knownModels?: string[];
      } = {},
    ): HarnessAdapter {
      const adapter: HarnessAdapter = {
        id,
        async discover() {
          if (opts.discoverThrows) throw new Error("missing reviewer");
          return HarnessManifest.parse({
            id,
            display_name: id,
            kind: opts.kind ?? "local_cli",
            provider_family: "cursor",
            capabilities: {
              review: opts.reviewCapability ?? true,
              known_models: opts.knownModels ?? [],
            },
            access_profiles_supported: opts.accessProfiles ?? ["readonly"],
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: id,
            status: opts.status ?? "ok",
            enabled_intents: opts.enabledIntents ?? ["review"],
            reasons: opts.status && opts.status !== "ok" ? ["doctor said no"] : [],
          });
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          yield {
            type: "started",
            session_id: spec.session_id,
            ts,
            observed_model: spec.model_hint ?? "ok",
          };
          yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      };
      if (!opts.omitModels) {
        adapter.models = async () => {
          if (opts.modelsThrow) throw new Error("inventory crashed");
          return (opts.models ?? []).map((id) => ({
            id,
            label: null,
            context_window: null,
            routes: null,
          }));
        };
      }
      return adapter;
    }

    async function expectRejected(
      registry: Map<string, HarnessAdapter>,
      message: RegExp,
      configYaml = "",
      reviewerPanel: ControlReviewerPanelEntry[] = [{ harness: "rev" }],
    ): Promise<void> {
      const repo = await initRepo();
      const configDir = reapMk(join(tmpdir(), "claudexor-reviewer-panel-config-"));
      if (configYaml) writeFileSync(join(configDir, "config.yaml"), configYaml);
      const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
      process.env.CLAUDEXOR_CONFIG_DIR = configDir;
      try {
        const orch = new Orchestrator({ registry, reviewerPanel });
        // A doomed panel ends the run as a TYPED failure WITH artifacts
        // (failure.yaml naming the refusal) — after run-dir creation, before
        // any candidate spends money. Never a bare pre-announce throw.
        const res = await orch.run({
          repoRoot: repo,
          prompt: "x",
          mode: "agent",
          harnesses: ["fake-impl"],
          n: 1,
        });
        expect(legacyOutcome(res)).toBe("failed");
        expect(res.summary).toMatch(message);
        const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
        expect(failure).toContain("review_preflight");
      } finally {
        if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
        else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
      }
    }

    await expectRejected(
      new Map([["fake-impl", diffImplementer("fake-impl")]]),
      /unknown reviewer harness 'rev'/,
    );
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { discoverThrows: true })],
      ]),
      /reviewer harness 'rev' is unavailable/,
    );
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { kind: "fake" })],
      ]),
      /fake harness/,
    );
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { status: "degraded" })],
      ]),
      /not doctor-ok: doctor said no/,
    );
    let disabledDoctorCalls = 0;
    const disabledReviewer = reviewer("rev");
    disabledReviewer.doctor = async () => {
      disabledDoctorCalls += 1;
      return ConformanceReport.parse({
        harness_id: "rev",
        status: "ok",
        enabled_intents: ["review"],
      });
    };
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", disabledReviewer],
      ]),
      /disabled in settings/,
      "harnesses:\n  rev:\n    enabled: false\n",
    );
    expect(disabledDoctorCalls).toBe(0);
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { enabledIntents: ["plan"] })],
      ]),
      /cannot perform readonly review/,
    );
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { reviewCapability: false })],
      ]),
      /cannot perform readonly review/,
    );
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { accessProfiles: ["workspace_write"] })],
      ]),
      /cannot perform readonly review/,
    );
    {
      const repo = await initRepo();
      const registry = new Map<string, HarnessAdapter>([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { omitModels: true, knownModels: ["manifest-model"] })],
      ]);
      const orch = new Orchestrator({
        registry,
        reviewerPanel: [{ harness: "rev", model: "manifest-model" }],
      });
      await expect(
        orch.run({ repoRoot: repo, prompt: "x", mode: "agent", harnesses: ["fake-impl"], n: 1 }),
      ).resolves.toMatchObject({ lifecycle: "succeeded", facts: { review: "not_run" } });
    }
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { models: ["gpt-5.5-extra-high"] })],
      ]),
      /does not support requested model 'gpt-5.5-xhigh-1M'.*claudexor models --harness rev/,
      "",
      [{ harness: "rev", model: "gpt-5.5-xhigh-1M" }],
    );
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { models: [] })],
      ]),
      /could not verify requested model 'gpt-5.5-xhigh-1M'.*model inventory call failed after retry: model inventory was empty.*claudexor models --harness rev/,
      "",
      [{ harness: "rev", model: "gpt-5.5-xhigh-1M" }],
    );
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { modelsThrow: true })],
      ]),
      /could not verify requested model 'gpt-5.5-xhigh-1M'.*model inventory call failed after retry: inventory crashed.*claudexor models --harness rev/,
      "",
      [{ harness: "rev", model: "gpt-5.5-xhigh-1M" }],
    );
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { omitModels: true })],
      ]),
      /refused requested model 'gpt-5.5-xhigh-1M'.*cannot verify models.*claudexor models --harness rev/,
      "",
      [{ harness: "rev", model: "gpt-5.5-xhigh-1M" }],
    );
    // STRICT: a manifest MISS is a typed refusal naming the truth source
    // (previously a warn-through for non-authoritative manifests).
    await expectRejected(
      new Map([
        ["fake-impl", diffImplementer("fake-impl")],
        ["rev", reviewer("rev", { omitModels: true, knownModels: ["manifest-model"] })],
      ]),
      /refused requested model 'ghost-model'.*manifest known-model list.*claudexor models --harness rev/,
      "",
      [{ harness: "rev", model: "ghost-model" }],
    );
  });

  it("persists convergence review artifacts with reviewer effort metadata", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const anthropic = cleanReviewer("rev-anthropic", "anthropic");
    const orch = new Orchestrator({
      registry,
      reviewers: [
        cleanReviewer("rev-openai", "openai"),
        { ...anthropic, requestedModel: "opus", requestedEffort: "max" },
      ],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      attempts: 1,
      tests: [shellGate("true")],
    });
    const reviewYaml = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(reviewYaml).toContain("reviewer_requests:");
    expect(reviewYaml).toContain("requested_effort: max");
    expect(reviewYaml).toContain("findings:");
    expect(reviewYaml).toContain("route_proofs:");
    const testsEvidence = readFileSync(
      join(res.runDir, "reviews", "a01-reviewers", "evidence", "TESTS.txt"),
      "utf8",
    );
    expect(testsEvidence).toContain("Gate results:");
    expect(testsEvidence).toContain("- gate-1: passed");
    expect(testsEvidence).toContain('command: ["sh","-c","true"]');
  });

  it("in-place agent turn runs in the LIVE tree and resumes the native session (v0.10 chat)", async () => {
    const repo = await initRepo();
    let sawResume: string | null | undefined;
    const impl: HarnessAdapter = {
      id: "impl",
      async discover() {
        return HarnessManifest.parse({
          id: "impl",
          display_name: "impl",
          kind: "local_cli",
          provider_family: "local",
          capabilities: { implement: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "impl",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        sawResume = spec.resume_session_id; // in-place turns pass the native resume id
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "impl-model",
          payload: { native_session_id: "vendor-sess-9" },
        };
        writeFileSync(join(spec.cwd, "LIVE.txt"), "in place\n");
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const observed: Record<string, string> = {};
    const orch = new Orchestrator({ registry: new Map([["impl", impl]]), reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "edit it",
      mode: "agent",
      harnesses: ["impl"],
      n: 1,
      inPlace: true,
      threadId: "th-1",
      resumeSessions: { impl: { sessionId: "vendor-sess-prev", profileId: null } },
      onSessionObserved: (h, nid) => {
        observed[h] = nid;
      },
    });
    // The file landed in the LIVE project tree (no isolated worktree), and the
    // candidate ran in-place (spec.cwd === repo).
    expect(existsSync(join(repo, "LIVE.txt"))).toBe(true);
    // In-place turns RESUME the native session and RECORD the new one.
    expect(sawResume).toBe("vendor-sess-prev");
    expect(observed["impl"]).toBe("vendor-sess-9");
    expect(res.mode).toBe("agent");
  });

  it("admits a production-style readonly raw patch adapter for default agent delivery", async () => {
    const repo = await initRepo();
    const userBytes = Buffer.from("concurrent user edit\n", "utf8");
    let observedAccess: AccessProfile | null = null;
    const raw = rawPatchImplementer("raw-patch", (access) => {
      observedAccess = access;
    });
    const orch = new Orchestrator({
      registry: new Map([[raw.id, raw]]),
      reviewers: [
        cleanReviewerWithSideEffect("rev-openai", "openai", () => {
          writeFileSync(join(repo, "USER.txt"), userBytes);
        }),
        cleanReviewer("rev-anthropic", "anthropic"),
      ],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "edit README",
      mode: "agent",
      harnesses: [raw.id],
      n: 1,
      inPlace: true,
      tests: [shellGate('test "$(cat README.md)" = "# raw implemented"')],
    });
    expect(legacyOutcome(res)).toBe("success");
    expect(observedAccess).toBe("readonly");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# raw implemented\n");
    expect(readFileSync(join(res.runDir, "context", "task.yaml"), "utf8")).toContain(
      "effective_profile: workspace_write",
    );
    const finalPatch = readFileSync(join(res.runDir, "final", "patch.diff"), "utf8");
    expect(finalPatch).toContain("+# raw implemented");
    expect(finalPatch).not.toContain("RawGitPatchEnvelope");
    const workProduct = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
    const anchorId = workProduct.match(/revert_anchor_id:\s+['"]?(sha256:[0-9a-f]{64})/)?.[1];
    expect(anchorId).toBeDefined();
    const { revertInPlaceFromAnchor } = await import("@claudexor/delivery");
    expect(await revertInPlaceFromAnchor(repo, anchorId!)).toMatchObject({ reverted: true });
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# repo\n");
    expect(readFileSync(join(repo, "USER.txt"))).toEqual(userBytes);
  });

  it("race leaves an ungated winner as an artifact without mutating the live tree", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([
        ["a", diffImplementer("a", "local")],
        ["b", diffImplementer("b", "openai")],
      ]),
      reviewers: [cleanReviewer("rev-openai", "openai")],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["a", "b"],
      n: 2,
      inPlace: true,
    });
    expect(res.facts.review).toBe("not_run");
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(false);
    const wp = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
    expect(wp).toContain("adopted: null");
  });

  it("race auto-adopts a verified successful winner into the live in-place tree", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([
        ["a", diffImplementer("a", "local")],
        ["b", diffImplementer("b", "openai")],
      ]),
      reviewers: reviewers(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["a", "b"],
      n: 2,
      inPlace: true,
      tests: [shellGate("true")],
    });
    expect(legacyOutcome(res)).toBe("success");
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(true);
    const wp = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
    expect(wp).toContain("adopted: true");
  });

  it("race revert removes only the adopted winner patch and preserves a concurrent user edit", async () => {
    const repo = await initRepo();
    const userBytes = Buffer.from("user-owned bytes\n", "utf8");
    const orch = new Orchestrator({
      registry: new Map([
        ["a", diffImplementer("a", "local")],
        ["b", diffImplementer("b", "openai")],
      ]),
      reviewers: [
        cleanReviewerWithSideEffect("rev-openai", "openai", () => {
          writeFileSync(join(repo, "USER.txt"), userBytes);
        }),
        cleanReviewer("rev-anthropic", "anthropic"),
      ],
    });

    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["a", "b"],
      n: 2,
      inPlace: true,
      tests: [shellGate("true")],
    });

    expect(legacyOutcome(res)).toBe("success");
    expect(readFileSync(join(repo, "USER.txt"))).toEqual(userBytes);
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(true);
    const wp = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
    const anchorId = wp.match(/revert_anchor_id:\s+['"]?(sha256:[0-9a-f]{64})/)?.[1];
    expect(anchorId).toBeDefined();

    const { revertInPlaceFromAnchor } = await import("@claudexor/delivery");
    const reverted = await revertInPlaceFromAnchor(repo, anchorId!);
    expect(reverted.reverted).toBe(true);
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(false);
    expect(readFileSync(join(repo, "USER.txt"))).toEqual(userBytes);
  });

  it("race blocks instead of claiming adoption when a reviewer-side user edit conflicts", async () => {
    const repo = await initRepo();
    const userBytes = Buffer.from("user conflict\n", "utf8");
    const orch = new Orchestrator({
      registry: new Map([
        ["a", diffImplementer("a", "local")],
        ["b", diffImplementer("b", "openai")],
      ]),
      reviewers: [
        cleanReviewerWithSideEffect("rev-openai", "openai", () => {
          writeFileSync(join(repo, "CHANGED.txt"), userBytes);
        }),
        cleanReviewer("rev-anthropic", "anthropic"),
      ],
    });

    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["a", "b"],
      n: 2,
      inPlace: true,
      tests: [shellGate("true")],
    });

    expect(legacyOutcome(res)).toBe("blocked");
    expect(readFileSync(join(repo, "CHANGED.txt"))).toEqual(userBytes);
    const wp = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
    expect(wp).toContain("adopted: false");
    const decision = readFileSync(join(res.runDir, "arbitration", "decision.yaml"), "utf8");
    expect(decision).toContain("final_verify:");
    expect(decision).toContain("applied_cleanly: false");
  });

  it("race records a blocked delivery receipt when the live target changes after fresh verification", async () => {
    const repo = await initRepo();
    const concurrentPath = join(repo, "USER.txt");
    const orch = new Orchestrator({
      registry: new Map([
        ["a", diffImplementer("a", "local")],
        ["b", diffImplementer("b", "openai")],
      ]),
      reviewers: reviewers(),
    });
    const gateScript = [
      'const fs = require("node:fs")',
      'const path = require("node:path")',
      `if (process.cwd().includes(${JSON.stringify("claudexor-verify-")})) fs.writeFileSync(${JSON.stringify(concurrentPath)}, "concurrent user edit\\n")`,
    ].join(";");

    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["a", "b"],
      n: 2,
      inPlace: true,
      tests: [{ program: process.execPath, args: ["-e", gateScript], envAllowlist: [] }],
    });

    expect(legacyOutcome(res), res.summary).toBe("blocked");
    expect(readFileSync(concurrentPath, "utf8")).toBe("concurrent user edit\n");
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(false);
    const receipt = readFileSync(join(res.runDir, "final", "delivery_receipt.yaml"), "utf8");
    expect(receipt).toContain("applied: false");
    expect(receipt).toContain("target changed after final verify");
    expect(receipt).toContain("gates_passed: true");
    const decision = readFileSync(join(res.runDir, "arbitration", "decision.yaml"), "utf8");
    // D8: a refused live delivery lands on the CHECKS axis (needs-decision).
    expect(decision).toContain("checks: failed");
    expect(decision).toContain("delivery_receipt: final/delivery_receipt.yaml");
    const runFacts = readRunFacts(repo, res);
    expect(runFacts.outcome).toMatchObject({
      lifecycle: "succeeded",
      checks: "failed",
      reason: "checks_failed",
    });
    expect(runFacts.gates).toMatchObject({
      executed: true,
      state: "skipped",
      receipt_attempt_id: "final-verify",
    });
    const terminals = readFileSync(join(res.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string })
      .filter((event) => ["run.completed", "run.blocked", "run.failed"].includes(event.type));
    expect(terminals.map((event) => event.type)).toEqual(["run.blocked"]);
  });

  it("plan mode writes the pure plan body and engine-parsed questions.json", async () => {
    const repo = await initRepo();
    const planner = markdownPlannerAdapter("planner", [
      "# Plan body",
      "1. Do the thing in src/a.ts",
      "",
      "## Open Questions",
      "- [single] Which store? :: sqlite :: json",
      "- [text] Anything else ambiguous?",
    ]);
    const orch = new Orchestrator({ registry: new Map([["planner", planner]]), reviewers: [] });
    let announcedRunDir = "";
    let receiptVisibleAtTerminal = false;
    const res = await orch.run({
      repoRoot: repo,
      prompt: "make a racing game",
      mode: "plan",
      harnesses: ["planner"],
      onRunStart: ({ runDir }) => {
        announcedRunDir = runDir;
      },
      onEvent: (event) => {
        if (
          event.type === "run.completed" ||
          event.type === "run.blocked" ||
          event.type === "run.failed"
        ) {
          receiptVisibleAtTerminal = existsSync(join(announcedRunDir, "final", "run_facts.yaml"));
        }
      },
    });
    expect(legacyOutcome(res)).toBe("success");
    expect(receiptVisibleAtTerminal).toBe(true);
    // PURE body: the wrapper (goal/status) lives in summary.md — implement
    // freezes and hashes plan.md, so it must be the plan and nothing else.
    const plan = readFileSync(join(res.runDir, "final", "plan.md"), "utf8");
    expect(plan).toContain("# Plan body");
    expect(plan).not.toContain("## Goal");
    const questions = JSON.parse(
      readFileSync(join(res.runDir, "final", "questions.json"), "utf8"),
    ) as { parse: string; questions: Array<Record<string, unknown>> };
    expect(questions.parse).toBe("found");
    expect(questions.questions).toHaveLength(2);
    expect(questions.questions[0]).toMatchObject({
      kind: "single",
      options: [
        { id: "o1", label: "sqlite" },
        { id: "o2", label: "json" },
      ],
    });
    const wp = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
    expect(wp).toContain("result_kind: plan");
    const summary = readFileSync(join(res.runDir, "final", "summary.md"), "utf8");
    expect(summary).toContain("Open questions: 2");
    expect(summary).toContain("Goal: make a racing game");
    const telemetry = new ArtifactStore(repo).readYaml<{
      final_attempt_id: string | null;
      run_facts?: unknown;
      attempts: Array<{
        attempt_id: string;
        outcome: { deliverable_present: boolean; status: string };
      }>;
    }>(join(res.runDir, "final", "telemetry.yaml"));
    expect(telemetry).toMatchObject({
      final_attempt_id: "p01",
      attempts: [{ attempt_id: "p01", outcome: { deliverable_present: true, status: "success" } }],
    });
    const runFacts = readRunFacts(repo, res);
    expect(runFacts.deliverable).toMatchObject({
      present: true,
      kind: "plan",
      path: "final/plan.md",
      producer_attempt_id: "p01",
    });
    expect(JSON.stringify(telemetry?.run_facts)).toBe(JSON.stringify(runFacts));
  });

  it("an untagged plan is DISCLOSED as unverified, never silently ready", async () => {
    const repo = await initRepo();
    const planner = markdownPlannerAdapter("planner", ["# Plan body without the tagged block"]);
    const orch = new Orchestrator({ registry: new Map([["planner", planner]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "vague ask",
      mode: "plan",
      harnesses: ["planner"],
    });
    expect(legacyOutcome(res)).toBe("success");
    const questions = JSON.parse(
      readFileSync(join(res.runDir, "final", "questions.json"), "utf8"),
    ) as { parse: string };
    expect(questions.parse).toBe("none_found");
    expect(readFileSync(join(res.runDir, "final", "summary.md"), "utf8")).toContain("unverified");
    expect(res.summary).toContain("unverified");
  });

  it("solo planning falls back to the next pool member when the primary planner fails", async () => {
    const repo = await initRepo();
    const failing: HarnessAdapter = {
      ...markdownPlannerAdapter("planner-a", []),
      async *run(spec) {
        yield {
          type: "error",
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          error: "planner-a exploded",
        };
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const succeeding = markdownPlannerAdapter("planner-b", [
      "# Plan B",
      "",
      "## Open Questions",
      "- (none)",
    ]);
    const eventTypes: string[] = [];
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([
        ["planner-a", failing],
        ["planner-b", succeeding],
      ]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "plan it",
      mode: "plan",
      harnesses: ["planner-a", "planner-b"],
      onEvent: (event) => eventTypes.push(event.type),
    });
    expect(legacyOutcome(res)).toBe("success");
    expect(readFileSync(join(res.runDir, "final", "plan.md"), "utf8")).toContain("# Plan B");
    // Zero open questions with a FOUND tagged block => ready.
    const questions = JSON.parse(
      readFileSync(join(res.runDir, "final", "questions.json"), "utf8"),
    ) as { parse: string; questions: unknown[] };
    expect(questions.parse).toBe("found");
    expect(questions.questions).toHaveLength(0);
    expect(eventTypes).toContain("route.fallback.started");
    expect(eventTypes).toContain("route.fallback.completed");
    expect(res.candidates.map((c) => c.status)).toEqual(["failed", "success"]);
    const telemetry = new ArtifactStore(repo).readYaml<{
      final_attempt_id: string | null;
      attempts: Array<{
        attempt_id: string;
        outcome: { deliverable_present: boolean; harness_errored: boolean; status: string };
      }>;
    }>(join(res.runDir, "final", "telemetry.yaml"));
    expect(telemetry).toMatchObject({
      final_attempt_id: "p02",
      attempts: [
        {
          attempt_id: "p01",
          outcome: { deliverable_present: false, harness_errored: true, status: "failed" },
        },
        {
          attempt_id: "p02",
          outcome: { deliverable_present: true, harness_errored: false, status: "success" },
        },
      ],
    });
  });

  // Planner attempts share the explorer path's deliverable exception
  // (INV-043/INV-044): a delivered plan downgrades a benign unrecovered tool
  // error to warning evidence instead of discarding the plan. The deliverable
  // is read from the UNWRAPPED D-16 envelope, so the finalizer's own classes
  // (veto / contract failure / interrupted) still outrank the exception.
  const TOOL_ERROR_PLAN = [
    "# Plan despite the failed check",
    "1. Do the thing in src/a.ts",
    "",
    "## Open Questions",
    "- (none)",
  ].join("\n");

  function toolErrorPlannerAdapter(
    id: string,
    opts: {
      /** Final message text; null emits no message at all (no deliverable). */
      finalText: string | null;
      /** Arm the constrained_json WorkReport envelope for this lane. */
      constrained?: boolean;
      /** Emit the unrecovered tool error (default true). */
      toolError?: boolean;
      /** Emit a terminal capacity_exhausted context signal. */
      contextExhausted?: boolean;
    },
  ): HarnessAdapter {
    return {
      ...markdownPlannerAdapter(id, []),
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: "openai",
          capabilities: {
            plan: true,
            ...(opts.constrained === true
              ? {
                  work_report_transport: "constrained",
                  json_schema_output: true,
                  structured_output_channel: "final_message",
                }
              : {}),
          },
          access_profiles_supported: ["readonly"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        if (opts.toolError !== false) {
          yield {
            type: "tool_call",
            session_id: spec.session_id,
            ts,
            text: "pnpm test",
            tool: { name: "command", kind: "command", use_id: "t1", target: "pnpm test" },
          };
          yield {
            type: "tool_result",
            session_id: spec.session_id,
            ts,
            tool: {
              name: "command",
              kind: "command",
              use_id: "t1",
              status: "error",
              error_summary: "command exited with code 1",
            },
          };
        }
        if (opts.contextExhausted === true) {
          yield {
            type: "context",
            session_id: spec.session_id,
            ts,
            context: {
              kind: "capacity_exhausted",
              cause: "window_exceeded",
              native_code: null,
              trigger: "auto",
              pre_tokens: null,
            },
          };
        }
        if (opts.finalText !== null) {
          yield { type: "message", session_id: spec.session_id, ts, text: opts.finalText };
        }
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
  }

  function terminalPlanAdapter(id: string, terminal: "usable" | "interrupted"): HarnessAdapter {
    return {
      id,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { plan: true, web_policy: "tools" },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          enabled_intents: ["plan", "synthesize"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        if (terminal === "usable") {
          yield { type: "message", session_id: spec.session_id, ts, text: TOOL_ERROR_PLAN };
        } else {
          yield {
            type: "tool_result",
            session_id: spec.session_id,
            ts,
            tool: {
              name: "WebSearch",
              kind: "web",
              status: "ok",
              target: "optional evidence",
            },
          };
          yield {
            type: "context",
            session_id: spec.session_id,
            ts,
            context: {
              kind: "capacity_exhausted",
              cause: "window_exceeded",
              native_code: null,
              trigger: "auto",
              pre_tokens: null,
            },
          };
        }
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
  }

  function expectMixedPlanSuccess(res: OrchestratorResult): void {
    expect(res.facts).toMatchObject({
      lifecycle: "succeeded",
      review: "not_run",
      reason: null,
    });
    expect(readFileSync(join(res.runDir, "final", "plan.md"), "utf8")).toContain(
      "# Plan despite the failed check",
    );
    const terminals = readRunEvents(res.runDir).filter((event) =>
      ["run.completed", "run.blocked", "run.failed"].includes(event.type),
    );
    expect(terminals.map((event) => event.type)).toEqual(["run.completed"]);
  }

  async function runToolErrorPlan(
    planner: HarnessAdapter,
    extra: { web?: "live" } = {},
  ): Promise<{ res: OrchestratorResult; outcome: Record<string, unknown> }> {
    const repo = await initRepo();
    const orch = new Orchestrator({ registry: new Map([["planner", planner]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "plan it",
      mode: "plan",
      harnesses: ["planner"],
      ...extra,
    });
    const telemetry = new ArtifactStore(repo).readYaml<{
      attempts: Array<{ attempt_id: string; outcome: Record<string, unknown> }>;
    }>(join(res.runDir, "final", "telemetry.yaml"));
    const attempt = telemetry?.attempts?.[0];
    expect(attempt?.attempt_id).toBe("p01");
    return { res, outcome: attempt?.outcome ?? {} };
  }

  it("a delivered plan survives an unrecovered tool error as success_with_warnings", async () => {
    const { res, outcome } = await runToolErrorPlan(
      toolErrorPlannerAdapter("planner", { finalText: TOOL_ERROR_PLAN }),
    );
    // The contracted deliverable landed — the unrecovered non-web tool error is
    // disclosed as a warning, never a discarded plan (explorer parity).
    expect(legacyOutcome(res)).toBe("success");
    expect(readFileSync(join(res.runDir, "final", "plan.md"), "utf8")).toContain(
      "# Plan despite the failed check",
    );
    expect(outcome).toMatchObject({
      deliverable_present: true,
      harness_errored: false,
      tool_warnings_count: 1,
      status: "success_with_warnings",
    });
  });

  it("a deliverable-less planner still hard-fails on an unrecovered tool error", async () => {
    const { res, outcome } = await runToolErrorPlan(
      toolErrorPlannerAdapter("planner", { finalText: null }),
    );
    expect(legacyOutcome(res)).toBe("failed");
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "failed without recovery",
    );
    expect(outcome).toMatchObject({
      deliverable_present: false,
      status: "failed",
    });
  });

  it("delivers a Plan under live policy even when optional web was unused", async () => {
    const planner: HarnessAdapter = {
      ...toolErrorPlannerAdapter("planner", { finalText: TOOL_ERROR_PLAN, toolError: false }),
      async discover() {
        return HarnessManifest.parse({
          id: "planner",
          display_name: "planner",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { plan: true, web_policy: "tools" },
          access_profiles_supported: ["readonly"],
        });
      },
    };
    const { res, outcome } = await runToolErrorPlan(planner, { web: "live" });
    expect(legacyOutcome(res)).toBe("success");
    expect(res.facts.lifecycle).toBe("succeeded");
    expect(readFileSync(join(res.runDir, "final", "plan.md"), "utf8")).toContain(
      "# Plan despite the failed check",
    );
    const terminalEvents = readRunEvents(res.runDir).filter((event) =>
      ["run.completed", "run.blocked", "run.failed"].includes(event.type),
    );
    expect(terminalEvents.map((event) => event.type)).toEqual(["run.completed"]);
    expect(outcome).toMatchObject({
      web_required_unsatisfied: false,
      status: "success",
    });
  });

  it("keeps a useful no-web plan instead of falling through to an interrupted route", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([
        ["usable", terminalPlanAdapter("usable", "usable")],
        ["interrupted", terminalPlanAdapter("interrupted", "interrupted")],
      ]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "plan without mandatory web",
      mode: "plan",
      web: "live",
      harnesses: ["usable", "interrupted"],
    });
    expectMixedPlanSuccess(res);
  });

  it("a needs_input work_report veto still rides a delivered plan with a tool error", async () => {
    // D-16 (INV-116): the plan DELIVERS and the tool error stays a warning, but
    // the model-attested veto must survive on the work_state axis — the softened
    // tool-error path must not launder a veto into a clean success.
    const { res, outcome } = await runToolErrorPlan(
      toolErrorPlannerAdapter("planner", {
        constrained: true,
        finalText: JSON.stringify({
          work_report: {
            state: "needs_input",
            required_inputs: [
              { kind: "decision", locator: "db-backend", description: "which db?" },
            ],
          },
          output: TOOL_ERROR_PLAN,
        }),
      }),
    );
    expect(readFileSync(join(res.runDir, "final", "plan.md"), "utf8")).toContain(
      "# Plan despite the failed check",
    );
    expect(outcome).toMatchObject({
      deliverable_present: true,
      harness_errored: false,
      tool_warnings_count: 1,
      status: "success_with_warnings",
    });
    expect(outcome["work_state"]).toMatchObject({ state: "needs_input" });
    expect(res.facts.reason).toBe("input_required");
  });

  it("a malformed work_report is still a contract failure on a plan with a tool error", async () => {
    // The tool error must NOT pre-empt the finalizer's contract failure: an
    // active envelope that carried no valid report fails the attempt, and the
    // failure names the contract, not the shell command.
    const { res, outcome } = await runToolErrorPlan(
      toolErrorPlannerAdapter("planner", {
        constrained: true,
        finalText: JSON.stringify({ work_report: { state: "bogus" }, output: TOOL_ERROR_PLAN }),
      }),
    );
    expect(legacyOutcome(res)).toBe("failed");
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).toContain("work_report");
    expect(failure).not.toContain("failed without recovery");
    expect(outcome).toMatchObject({
      deliverable_present: false,
      harness_errored: true,
      status: "failed",
    });
  });

  it("context exhaustion still outranks a delivered plan with a tool error", async () => {
    // An interrupted planner is never a clean plan: terminal capacity
    // exhaustion outranks both the deliverable exception and the tool warning.
    const { res, outcome } = await runToolErrorPlan(
      toolErrorPlannerAdapter("planner", {
        finalText: TOOL_ERROR_PLAN,
        contextExhausted: true,
      }),
    );
    expect(res.lifecycle).not.toBe("succeeded");
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "context capacity exhausted",
    );
    expect(outcome).toMatchObject({ harness_errored: true, status: "failed" });
  });

  it("a planner that throws an EMPTY error still FAILS with a reportable message", async () => {
    // `new Error("").message` is "", and a bare thrown "" stringifies to "". The
    // error axes below the throw are decided by nullishness (`harnessError ??=`)
    // and truthiness (`if (attemptError)`), which both read "" as "no error", so
    // a harness that genuinely THREW could terminalize as a clean plan with
    // nothing to show the operator. safeErrorMessage keeps the blank out of
    // those tests at the source instead of patching one guard.
    const { res, outcome } = await runToolErrorPlan({
      ...toolErrorPlannerAdapter("planner", { finalText: null, toolError: false }),
      async *run(): AsyncIterable<never> {
        throw new Error("");
      },
    });
    expect(legacyOutcome(res)).toBe("failed");
    expect(outcome).toMatchObject({ harness_errored: true, status: "failed" });
    // The attempt terminal must carry real text, not an empty string.
    const completed = readRunEvents(res.runDir).find(
      (e) => e.type === "harness.completed" && e.payload["attempt_id"] === "p01",
    );
    expect(completed?.payload["status"]).toBe("failed");
    expect(String(completed?.payload["error"] ?? "").trim().length).toBeGreaterThan(0);
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "thrown error carried no message",
    );
  });

  // Council (INV-031): a planner that emits DRAFT questions on intent=plan and
  // a DIFFERENT merged set on intent=synthesize, so the "parser runs on the
  // merge output only" promise is verifiable — draft questions must not leak.
  function councilPlannerAdapter(id: string, draftMarker: string): HarnessAdapter {
    return {
      id,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { plan: true },
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          enabled_intents: ["plan", "synthesize"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        const text =
          spec.intent === "synthesize"
            ? [
                "# Merged plan",
                "1. Unified step",
                "",
                "## Open Questions",
                "- [single] Merged decision? :: keep :: drop",
              ].join("\n")
            : [
                `# Draft ${draftMarker}`,
                "1. Draft step",
                "",
                "## Open Questions",
                `- [text] Draft-only question ${draftMarker}?`,
              ].join("\n");
        yield { type: "message", session_id: spec.session_id, ts, text };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
  }

  it("council: parallel drafts + primary merge produce ONE question set (drafts do not leak)", async () => {
    const repo = await initRepo();
    const eventTypes: string[] = [];
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([
        ["planner-a", councilPlannerAdapter("planner-a", "A")],
        ["planner-b", councilPlannerAdapter("planner-b", "B")],
      ]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "design the feature",
      mode: "plan",
      council: true,
      harnesses: ["planner-a", "planner-b"],
      paidBudget: { kind: "finite", maxUsd: 1.5 },
      onEvent: (event) => eventTypes.push(event.type),
    });
    expect(legacyOutcome(res)).toBe("success");
    // Drafts landed as FILE-backed artifacts, one per member.
    expect(existsSync(join(res.runDir, "council", "draft-planner-a.md"))).toBe(true);
    expect(existsSync(join(res.runDir, "council", "draft-planner-b.md"))).toBe(true);
    // final/plan.md is the MERGE output, not a draft.
    const plan = readFileSync(join(res.runDir, "final", "plan.md"), "utf8");
    expect(plan).toContain("# Merged plan");
    expect(plan).not.toContain("# Draft");
    // The parser ran on the MERGE only: exactly the merged question, no drafts.
    const questions = JSON.parse(
      readFileSync(join(res.runDir, "final", "questions.json"), "utf8"),
    ) as { parse: string; questions: Array<{ prompt: string }> };
    expect(questions.parse).toBe("found");
    expect(questions.questions).toHaveLength(1);
    expect(questions.questions[0]?.prompt).toBe("Merged decision?");
    expect(questions.questions.some((q) => q.prompt.startsWith("Draft-only"))).toBe(false);
    // Membership projection artifact.
    const membership = readFileSync(join(res.runDir, "council", "membership.yaml"), "utf8");
    expect(membership).toContain("mergedBy: planner-a");
    expect(membership).toContain("requested: 2");
    expect(membership).toContain("drafted: 2");
    expect(eventTypes).toContain("council.started");
    expect(eventTypes).toContain("council.draft");
    expect(eventTypes).toContain("council.merged");
    const telemetry = new ArtifactStore(repo).readYaml<{
      final_attempt_id: string | null;
      attempts: Array<{
        attempt_id: string;
        outcome: { deliverable_present: boolean; status: string };
      }>;
    }>(join(res.runDir, "final", "telemetry.yaml"));
    expect(telemetry?.final_attempt_id).toBe("p03");
    expect(telemetry?.attempts.map((attempt) => attempt.attempt_id)).toEqual(["p01", "p02", "p03"]);
    expect(
      telemetry?.attempts.every(
        (attempt) => attempt.outcome.deliverable_present && attempt.outcome.status === "success",
      ),
    ).toBe(true);
    const workProduct = new ArtifactStore(repo).readYaml<{ meta: { planners: number } }>(
      join(res.runDir, "final", "work_product.yaml"),
    );
    expect(workProduct?.meta.planners).toBe(2);
    const runFacts = readRunFacts(repo, res);
    expect(runFacts.participants.planners).toBe(2);
    expect(
      runFacts.participants.attempts.map(({ attempt_id, role }) => ({ attempt_id, role })),
    ).toEqual([
      { attempt_id: "p01", role: "planner" },
      { attempt_id: "p02", role: "planner" },
      { attempt_id: "p03", role: "merge" },
    ]);
    expect(telemetry).toMatchObject({ run_facts: runFacts });
  });

  it("council discloses an estimate-headroom member refusal below the floor", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([
        ["planner-a", councilPlannerAdapter("planner-a", "A")],
        ["planner-b", councilPlannerAdapter("planner-b", "B")],
      ]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "design the feature",
      mode: "plan",
      council: true,
      harnesses: ["planner-a", "planner-b"],
      paidBudget: { kind: "finite", maxUsd: 0.04 },
    });

    expect(legacyOutcome(res)).toBe("success");
    const membership = new ArtifactStore(repo).readYaml<{
      requested: number;
      drafted: number;
      degraded: boolean;
      members: Array<{ status: string }>;
    }>(join(res.runDir, "council", "membership.yaml"));
    expect(membership).toMatchObject({ requested: 2, drafted: 1, degraded: true });
    expect(membership?.members.filter((member) => member.status === "failed")).toHaveLength(1);
    expect(
      readRunEvents(res.runDir).some(
        (event) =>
          event.type === "budget.lease.created" && event.payload["denied"] === "estimate_headroom",
      ),
    ).toBe(true);
  });

  it("council degrades honestly when a member fails but the merge still runs", async () => {
    const repo = await initRepo();
    const failing: HarnessAdapter = {
      ...councilPlannerAdapter("planner-a", "A"),
      async *run(spec) {
        yield {
          type: "error",
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          error: "planner-a exploded",
        };
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([
        ["planner-a", failing],
        ["planner-b", councilPlannerAdapter("planner-b", "B")],
      ]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "design the feature",
      mode: "plan",
      council: true,
      // planner-a is primary AND fails — the merge must fall to a survivor's
      // work but still runs on the (surviving) primary lane.
      harnesses: ["planner-b", "planner-a"],
    });
    expect(legacyOutcome(res)).toBe("success");
    const membership = readFileSync(join(res.runDir, "council", "membership.yaml"), "utf8");
    expect(membership).toContain("degraded: true");
    expect(membership).toContain("drafted: 1");
    // The surviving primary (planner-b, listed first) merges.
    expect(readFileSync(join(res.runDir, "final", "plan.md"), "utf8")).toContain("# Merged plan");
    const summary = readFileSync(join(res.runDir, "final", "summary.md"), "utf8");
    expect(summary).toContain("council degraded");
    const workProduct = new ArtifactStore(repo).readYaml<{ meta: { planners: number } }>(
      join(res.runDir, "final", "work_product.yaml"),
    );
    expect(workProduct?.meta.planners).toBe(2);
  });

  it("council records a native session per member lane on a thread turn", async () => {
    const repo = await initRepo();
    // Each member emits its own native session id in the started event; a
    // thread turn (threadId set) must record each lane for round-2 resume.
    const laneAdapter = (id: string): HarnessAdapter => {
      const base = councilPlannerAdapter(id, id);
      return {
        ...base,
        async *run(spec) {
          const ts = new Date().toISOString();
          yield {
            type: "started",
            session_id: spec.session_id,
            ts,
            payload: { native_session_id: `native-${id}` },
          };
          const text =
            spec.intent === "synthesize"
              ? "# Merged plan\n\n## Open Questions\n- (none)"
              : `# Draft ${id}\n\n## Open Questions\n- (none)`;
          yield { type: "message", session_id: spec.session_id, ts, text };
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      };
    };
    const observed: string[] = [];
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([
        ["planner-a", laneAdapter("planner-a")],
        ["planner-b", laneAdapter("planner-b")],
      ]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "design the feature",
      mode: "plan",
      council: true,
      threadId: "thr_council",
      harnesses: ["planner-a", "planner-b"],
      onSessionObserved: (harnessId, nativeSessionId) => {
        observed.push(`${harnessId}:${nativeSessionId}`);
      },
    });
    expect(legacyOutcome(res)).toBe("success");
    // Each member's lane recorded its native session (primary also records the
    // merge session under the same lane).
    expect(observed).toContain("planner-a:native-planner-a");
    expect(observed).toContain("planner-b:native-planner-b");
  });

  it("council merges on a surviving member when the nominal primary fails its draft", async () => {
    const repo = await initRepo();
    const failing: HarnessAdapter = {
      ...councilPlannerAdapter("planner-a", "A"),
      async *run(spec) {
        yield {
          type: "error",
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          error: "planner-a exploded",
        };
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([
        ["planner-a", failing],
        ["planner-b", councilPlannerAdapter("planner-b", "B")],
      ]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "design the feature",
      mode: "plan",
      council: true,
      // planner-a is the NOMINAL primary (listed first) but fails its draft —
      // the merge must fall to the surviving member rather than sink.
      harnesses: ["planner-a", "planner-b"],
    });
    expect(legacyOutcome(res)).toBe("success");
    expect(readFileSync(join(res.runDir, "final", "plan.md"), "utf8")).toContain("# Merged plan");
    const membership = readFileSync(join(res.runDir, "council", "membership.yaml"), "utf8");
    expect(membership).toContain("mergedBy: planner-b");
  });

  it("council fails typed when ALL members fail", async () => {
    const repo = await initRepo();
    const explode = (id: string): HarnessAdapter => ({
      ...councilPlannerAdapter(id, id),
      async *run(spec) {
        yield {
          type: "error",
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          error: `${id} exploded`,
        };
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    });
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([
        ["planner-a", explode("planner-a")],
        ["planner-b", explode("planner-b")],
      ]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "design the feature",
      mode: "plan",
      council: true,
      harnesses: ["planner-a", "planner-b"],
    });
    expect(legacyOutcome(res)).toBe("failed");
    expect(existsSync(join(res.runDir, "final", "plan.md"))).toBe(false);
    expect(res.candidates.every((c) => c.status !== "success")).toBe(true);
  });

  it("council contains a pre-stream member failure and keeps the shared HOME through a slow sibling", async () => {
    const repo = await initRepo();
    const base = councilPlannerAdapter("planner-slow", "slow");
    const homeObservations: boolean[] = [];
    let scopedHome: string | null = null;
    const slow: HarnessAdapter = {
      ...base,
      async *run(spec) {
        scopedHome = spec.env["HOME"] ?? null;
        await new Promise((resolve) => setTimeout(resolve, 60));
        homeObservations.push(scopedHome !== null && existsSync(scopedHome));
        yield* base.run(spec);
      },
    };
    const rejected = councilPlannerAdapter("planner-setup-fail", "fail");
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([
        [rejected.id, rejected],
        [slow.id, slow],
      ]),
      reviewers: [],
    });
    rejectSessionPreparationFor(orch, rejected.id);

    const res = await orch.run({
      repoRoot: repo,
      prompt: "design the feature",
      mode: "plan",
      council: true,
      n: 2,
      harnesses: [rejected.id, slow.id],
    });

    expect(legacyOutcome(res)).toBe("success");
    expect(homeObservations.length).toBeGreaterThanOrEqual(1);
    expect(homeObservations.every(Boolean)).toBe(true);
    expect(scopedHome).not.toBeNull();
    expect(existsSync(scopedHome ?? "")).toBe(false);
    expect(
      readRunEvents(res.runDir).some(
        (event) => event.type === "harness.started" && event.payload["harness_id"] === rejected.id,
      ),
    ).toBe(false);
    expect(readFileSync(join(res.runDir, "council", "membership.yaml"), "utf8")).toContain(
      "degraded: true",
    );
  });

  it("plan failure uses the dominant typed harness remediation and redacts the composed error", async () => {
    const repo = await initRepo();
    const token = `sk-${"a".repeat(48)}`;
    const timeoutPlanner: HarnessAdapter = {
      ...councilPlannerAdapter("planner-timeout", "timeout"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        yield {
          type: "status",
          session_id: spec.session_id,
          ts,
          transient: { kind: "timeout", retry_delay_ms: 0 },
        };
        yield {
          type: "error",
          session_id: spec.session_id,
          ts,
          error: `planner timed out with ${token}`,
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const res = await new Orchestrator({
      registry: new Map([[timeoutPlanner.id, timeoutPlanner]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "design the feature",
      mode: "plan",
      harnesses: [timeoutPlanner.id],
    });
    expect(legacyOutcome(res)).toBe("failed");
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).toContain("went silent");
    expect(failure).not.toMatch(/[Rr]e-authenticate/);
    expect(failure).not.toContain(token);
    expect(readFileSync(join(res.runDir, "final", "summary.md"), "utf8")).not.toContain(token);
  });

  it("keeps a useful no-web Council plan when its peer is interrupted", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([
        ["usable", terminalPlanAdapter("usable", "usable")],
        ["interrupted", terminalPlanAdapter("interrupted", "interrupted")],
      ]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "merge plans without mandatory web",
      mode: "plan",
      council: true,
      n: 2,
      web: "live",
      harnesses: ["usable", "interrupted"],
    });
    expectMixedPlanSuccess(res);
  });

  it("QA-047: an EXPLICIT council with an unavailable (no-manifest) member fails loudly, naming it", async () => {
    const repo = await initRepo();
    // opencode is unavailable: discover throws (no manifest) and doctor is
    // unavailable — exactly the branch that silently vanished before QA-047.
    const ghost: HarnessAdapter = {
      id: "opencode",
      async discover() {
        throw new Error("opencode not found on PATH");
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "opencode",
          status: "unavailable",
          reasons: ["opencode not found", "opencode provider auth not configured"],
        });
      },
      async *run(spec) {
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([
        ["planner-a", councilPlannerAdapter("planner-a", "A")],
        ["opencode", ghost],
      ]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "design the feature",
      mode: "plan",
      council: true,
      harnesses: ["planner-a", "opencode"],
      n: 2,
    });
    // The explicit unavailable member must fail the run loudly at routing
    // preflight — NOT vanish while planner-a drafts and the run reads
    // "degraded" with no representation of who disappeared or why.
    expect(legacyOutcome(res)).toBe("failed");
    expect(res.summary).toMatch(/opencode/i);
    // No draft/merge spend after the deterministic refusal.
    expect(existsSync(join(res.runDir, "council", "draft-planner-a.md"))).toBe(false);
  });

  it("QA-047: the council merge reuses the SAME admitted route HOME as the primary's draft", async () => {
    const repo = await initRepo();
    // Root cause 2: a fresh disposable merge HOME re-probes cold native status
    // and times out. The merge must run in the SAME scoped context whose
    // readiness admitted the primary and in which its draft just succeeded.
    const homesByIntent: Record<string, string | undefined> = {};
    const capturing: HarnessAdapter = {
      ...councilPlannerAdapter("cursor", "C"),
      async *run(spec) {
        homesByIntent[spec.intent] = spec.env?.["HOME"];
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        const text =
          spec.intent === "synthesize"
            ? ["# Merged plan", "1. step", "", "## Open Questions", "- [single] q? :: a :: b"].join(
                "\n",
              )
            : ["# Draft C", "1. step", "", "## Open Questions", "- [text] q?"].join("\n");
        yield { type: "message", session_id: spec.session_id, ts, text };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([["cursor", capturing]]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "design the feature",
      mode: "plan",
      council: true,
      harnesses: ["cursor"],
      n: 1,
    });
    expect(legacyOutcome(res)).toBe("success");
    expect(homesByIntent["plan"]).toBeTruthy();
    // The merge (synthesize) HOME is byte-identical to the draft (plan) HOME.
    expect(homesByIntent["synthesize"]).toBe(homesByIntent["plan"]);
  });

  it("QA-047: a failed council merge never relabels the successful draft as failed, and the member card stays clean", async () => {
    const repo = await initRepo();
    // Single-member council: p01 draft succeeds; p02 merge (synthesize) fails.
    const draftOkMergeFails: HarnessAdapter = {
      ...councilPlannerAdapter("cursor", "C"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        if (spec.intent === "synthesize") {
          yield {
            type: "error",
            session_id: spec.session_id,
            ts,
            error: "merge native status probe timed out",
          };
          yield { type: "completed", session_id: spec.session_id, ts };
          return;
        }
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: ["# Draft C", "1. Draft step", "", "## Open Questions", "- [text] q?"].join("\n"),
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const orch = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([["cursor", draftOkMergeFails]]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "design the feature",
      mode: "plan",
      council: true,
      harnesses: ["cursor"],
      n: 1,
    });
    expect(legacyOutcome(res)).toBe("failed");
    // Root cause 3: the proven-success p01 draft is NEVER labeled failed.
    expect(res.summary).not.toMatch(/p01\/cursor: failed/);
    expect(res.summary).toMatch(/p02\/cursor:/);
    expect(res.summary).toMatch(/Preserved drafts: p01\/cursor/);
    // The surviving draft artifact is preserved.
    expect(existsSync(join(res.runDir, "council", "draft-cursor.md"))).toBe(true);
    // Root cause 4: the merge error is NOT attached to the drafted member card;
    // the member reads `drafted` with a null draft error (CouncilMember.error
    // is null unless the member failed to DRAFT).
    const membership = readFileSync(join(res.runDir, "council", "membership.yaml"), "utf8");
    expect(membership).toContain("status: drafted");
    expect(membership).not.toContain("merge native status probe timed out");
    const runFacts = readRunFacts(repo, res);
    expect(runFacts.participants.planners).toBe(1);
    expect(
      runFacts.participants.attempts.map(({ attempt_id, role }) => ({ attempt_id, role })),
    ).toEqual([
      { attempt_id: "p01", role: "planner" },
      { attempt_id: "p02", role: "merge" },
    ]);
  });

  it("reviews the candidate worktree rather than the unchanged base repo", async () => {
    const repo = await initRepo();
    const writer: HarnessAdapter = {
      id: "writer",
      async discover() {
        return HarnessManifest.parse({
          id: "writer",
          display_name: "writer",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: {
            implement: true,
            edit_files: true,
            review: true,
          },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "writer",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        writeFileSync(join(spec.cwd, "README.md"), "OK\n");
        yield { type: "started", session_id: spec.session_id, ts, observed_model: "writer-model" };
        yield {
          type: "completed",
          session_id: spec.session_id,
          ts,
          observed_model: "writer-model",
        };
      },
    };
    function cwdAwareReviewer(id: string, family: ProviderFamily): ReviewerSpec {
      const adapter: HarnessAdapter = {
        id,
        async discover() {
          return HarnessManifest.parse({
            id,
            display_name: id,
            kind: "local_cli",
            provider_family: family,
            capabilities: { review: true },
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
          const readme = readFileSync(join(spec.cwd, "README.md"), "utf8");
          const findings =
            readme === "OK\n"
              ? "[]"
              : JSON.stringify([
                  {
                    severity: "BLOCK",
                    category: "correctness",
                    claim: "Reviewer did not see the candidate README.md content.",
                    evidence: { files: [{ path: "README.md", lines: "1" }] },
                    proposed_fix: "Run reviewers against the candidate worktree.",
                  },
                ]);
          yield { type: "started", session_id: spec.session_id, ts, observed_model: `${id}-model` };
          yield { type: "message", session_id: spec.session_id, ts, text: findings };
          yield {
            type: "completed",
            session_id: spec.session_id,
            ts,
            observed_model: `${id}-model`,
          };
        },
      };
      return { adapter, providerFamily: family };
    }

    const registry = new Map<string, HarnessAdapter>([["writer", writer]]);
    const orch = new Orchestrator({
      registry,
      reviewers: [
        cwdAwareReviewer("rev-openai", "openai"),
        cwdAwareReviewer("rev-anthropic", "anthropic"),
      ],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "change README.md to OK",
      mode: "agent",
      harnesses: ["writer"],
      n: 1,
      tests: [shellGate("grep -qx OK README.md")],
    });
    expect(legacyOutcome(res)).toBe("success");
    const reviewYaml = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(reviewYaml).not.toContain("Reviewer did not see");
  });

  it("auto-resolves available real harnesses when --harness is omitted", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["realish", realLikeAdapter("realish")]]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({ repoRoot: repo, prompt: "x", mode: "agent", n: 2 });
    expect(res.candidates.length).toBeGreaterThanOrEqual(2);
    expect(res.candidates.every((c) => c.harnessId === "realish")).toBe(true);
  });

  it("surfaces runId early and streams events via in-proc hooks (agent)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry });
    const runEvents: string[] = [];
    const harnessEvents: string[] = [];
    let startedRunId: string | null = null;
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      onRunStart: (i) => {
        startedRunId = i.runId;
      },
      onEvent: (e) => runEvents.push(e.type),
      onHarnessEvent: (e) => harnessEvents.push(e.type),
    });
    expect(startedRunId).toBe(res.runId);
    expect(runEvents).toContain("run.created");
    expect(runEvents).toContain("run.completed");
    expect(harnessEvents).toContain("message");
    const eventLog = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(eventLog).toContain('"type":"harness.event"');
    expect(eventLog).toContain('"harness_id":"fake-success"');
    expect(eventLog).toContain('"attempt_id":"a01"');
  });

  it("honors a pre-aborted signal (agent -> cancelled, no harness work forwarded)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry });
    const ac = new AbortController();
    ac.abort();
    const harnessEvents: string[] = [];
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      signal: ac.signal,
      onHarnessEvent: (e) => harnessEvents.push(e.type),
    });
    expect(legacyOutcome(res)).toBe("cancelled");
    expect(harnessEvents.length).toBe(0);
  });

  it("a wall-clock deadline abort ends cancelled with reason + output.ready before terminal (W6)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry });
    const ac = new AbortController();
    // The daemon aborts the deadline controller with a STRING reason; a plain
    // user cancel aborts with a DOMException and stays a bare cancel.
    ac.abort("wall_clock_exceeded");
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      signal: ac.signal,
    });
    expect(legacyOutcome(res)).toBe("cancelled");
    expect(res.cancelReason).toBe("wall_clock_exceeded");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; payload?: Record<string, unknown> });
    const outIdx = events.map((e) => e.type).lastIndexOf("output.ready");
    const failIdx = events.map((e) => e.type).lastIndexOf("run.failed");
    expect(outIdx).toBeGreaterThan(-1);
    // output.ready precedes the terminal (INV-116), even on the cancel path.
    expect(failIdx).toBeGreaterThan(outIdx);
    expect(events[failIdx].payload?.["reason"]).toBe("wall_clock_exceeded");
    // The announced diagnostic summary is MATERIALIZED, not a dangling path.
    const summary = readFileSync(join(res.runDir, "final", "summary.md"), "utf8");
    expect(summary).toContain("cancelled");
    expect(summary).toContain("wall_clock_exceeded");
  });

  it("aggregates token usage into run telemetry and keeps unreported fields null (W9)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-implement", createFakeHarness("fake-implement")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "write deterministic file",
      mode: "agent",
      harnesses: ["fake-implement"],
      n: 1,
    });
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    // fake-implement reports input/output but no cached tokens.
    expect(telemetry).toMatch(/input_tokens: 100/);
    expect(telemetry).toMatch(/output_tokens: 50/);
    // Unreported cached stays null — never a false 0 (money stays in the ledger).
    expect(telemetry).toMatch(/cached_input_tokens: null/);
  });

  it("blocks an envelope candidate that touches a denied path and discloses postdiff_only receipts (W7)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-implement", createFakeHarness("fake-implement")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "write deterministic file",
      mode: "agent",
      harnesses: ["fake-implement"],
      tests: [shellGate("true")],
      n: 1,
      // fake-implement creates FAKE_CHANGE.txt: creating a denied file is a
      // violation (distinct from protected paths, which produce a human gate).
      denyPaths: ["FAKE_*.txt"],
    });
    expect(legacyOutcome(res)).toBe("blocked");
    const review = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(review).toContain("candidate touched denied path(s) (deny_paths): FAKE_CHANGE.txt");
    expect(review).toContain("severity: BLOCK");
    expect(review).toContain("level: critical");
    // The contract carries the constraint; the lane receipt is honest about
    // enforcement: no native pre-write deny, the post-diff gate is authoritative.
    expect(readFileSync(join(res.runDir, "context", "task.yaml"), "utf8")).toContain("FAKE_*.txt");
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toContain("capability: path_deny");
    expect(telemetry).toContain("reason: postdiff_only");
  });

  it("blocks a rename OUT of a denied path — the deletion side is not a bypass (W7/G1)", async () => {
    const repo = await initRepo();
    // Seed a committed file inside the soon-to-be-denied directory.
    mkdirSync(join(repo, "secrets"), { recursive: true });
    writeFileSync(join(repo, "secrets", "key.txt"), "old\n");
    await runCapture("git", ["-C", repo, "add", "secrets/key.txt"]);
    await runCapture("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "seed",
    ]);
    // The adapter renames the denied file OUT to an allowed path. stats.paths
    // would carry only the new (allowed) side; the deny gate must still catch
    // the denied SOURCE via existingPaths.
    const adapter: HarnessAdapter = {
      ...diffImplementer("rename-out"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        renameSync(join(spec.cwd, "secrets", "key.txt"), join(spec.cwd, "public.txt"));
        yield { type: "message", session_id: spec.session_id, ts, text: "moved it" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const res = await new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "reorganize",
      mode: "agent",
      harnesses: [adapter.id],
      tests: [shellGate("true")],
      n: 1,
      denyPaths: ["secrets/**"],
    });
    expect(legacyOutcome(res)).toBe("blocked");
    const review = readFileSync(join(res.runDir, "reviews", "a01.yaml"), "utf8");
    expect(review).toContain("secrets/key.txt");
    expect(review).toContain("severity: BLOCK");
  });

  it("refuses denyPaths on an in-place run at preflight (W7)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-implement", createFakeHarness("fake-implement")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    await expect(
      orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["fake-implement"],
        inPlace: true,
        denyPaths: ["secrets/**"],
      }),
    ).rejects.toThrow(/denyPaths requires an isolated\/envelope run/);
  });

  it("validates a conforming structured answer into final/output.json with a passed receipt (W8)", async () => {
    const repo = await initRepo();
    let seenSchema: unknown;
    const adapter: HarnessAdapter = {
      id: "schema-capable",
      async discover() {
        return HarnessManifest.parse({
          id: "schema-capable",
          display_name: "schema-capable",
          kind: "local_cli",
          provider_family: "local",
          capabilities: { implement: true, json_schema_output: true },
          access_profiles_supported: ["workspace_write", "full"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "schema-capable",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        seenSchema = spec.output_schema;
        yield { type: "started", session_id: spec.session_id, ts };
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: JSON.stringify({ verdict: "ok", score: 7 }),
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const orch = new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
    });
    const outputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        verdict: { $ref: "#/$defs/verdict" },
        score: { type: "number" },
      },
      required: ["verdict", "score"],
      $defs: { verdict: { type: "string" } },
      unevaluatedProperties: false,
    };
    const res = await orch.run({
      repoRoot: repo,
      prompt: "grade this repo",
      mode: "agent",
      harnesses: [adapter.id],
      n: 1,
      outputSchema,
    });
    // An answer-only agent run (no diff) ends no_op with the answer delivered.
    expect(res.facts.noChanges).toBe(true);
    // The lane received the NORMALIZED (strictified) schema.
    expect(seenSchema).toMatchObject({
      type: "object",
      properties: { verdict: { type: "string" }, score: { type: "number" } },
      additionalProperties: false,
    });
    expect(seenSchema).not.toHaveProperty("$schema");
    expect(seenSchema).not.toHaveProperty("$defs");
    expect(seenSchema).not.toHaveProperty("unevaluatedProperties");
    expect(JSON.stringify(seenSchema)).not.toContain("$ref");
    const output = JSON.parse(readFileSync(join(res.runDir, "final", "output.json"), "utf8"));
    expect(output).toEqual({ verdict: "ok", score: 7 });
    const receipt = readFileSync(join(res.runDir, "final", "structured_output.yaml"), "utf8");
    expect(receipt).toContain("status: passed");
    expect(receipt).toContain("schema_dialect: draft-2020-12");
    expect(receipt).toContain(hashJson(outputSchema));
    const types = readRunEvents(res.runDir).map((e) => e.type);
    expect(types).toContain("output.ready");
  });

  it("reports a failed conformance receipt for a non-conformant answer without failing the run (W8)", async () => {
    const repo = await initRepo();
    const adapter: HarnessAdapter = {
      id: "schema-capable",
      async discover() {
        return HarnessManifest.parse({
          id: "schema-capable",
          display_name: "schema-capable",
          kind: "local_cli",
          provider_family: "local",
          capabilities: { implement: true, json_schema_output: true },
          access_profiles_supported: ["workspace_write", "full"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "schema-capable",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: JSON.stringify({ verdict: 42 }),
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const orch = new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "grade this repo",
      mode: "agent",
      harnesses: [adapter.id],
      n: 1,
      outputSchema: {
        type: "object",
        properties: { verdict: { type: "string" } },
        required: ["verdict"],
      },
    });
    // Non-conformant answer = the run TERMINAL is unaffected (the receipt is
    // the warning); an answer-only run stays no_op, never a hard fail.
    expect(res.facts.noChanges).toBe(true);
    const receipt = readFileSync(join(res.runDir, "final", "structured_output.yaml"), "utf8");
    expect(receipt).toContain("status: failed");
    expect(receipt).toContain("/verdict");
    // G4: a non-conformant answer is NEVER the primary output.json — it goes to
    // the diagnostic sidecar so a consumer never receives known-invalid data.
    expect(existsSync(join(res.runDir, "final", "output.json"))).toBe(false);
    expect(existsSync(join(res.runDir, "final", "output.invalid.json"))).toBe(true);
  });

  it("validates the ORIGINAL schema, not the strictified transport form (W8/G3)", async () => {
    const repo = await initRepo();
    const makeAdapter = (answer: string): HarnessAdapter => ({
      id: "schema-capable",
      async discover() {
        return HarnessManifest.parse({
          id: "schema-capable",
          display_name: "schema-capable",
          kind: "local_cli",
          provider_family: "local",
          capabilities: { implement: true, json_schema_output: true },
          access_profiles_supported: ["workspace_write", "full"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "schema-capable",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        yield { type: "message", session_id: spec.session_id, ts, text: answer };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    });
    // `note` is OPTIONAL string in the CALLER's schema. Strictify would make it
    // `string|null` required, so `{"note":null}` would falsely PASS the vendor
    // form. Validated against the ORIGINAL, null is not a string → failed.
    const schema = {
      type: "object",
      properties: { note: { type: "string" } },
      required: [],
    };
    const bad = await new Orchestrator({
      registry: new Map([["schema-capable", makeAdapter(JSON.stringify({ note: null }))]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["schema-capable"],
      n: 1,
      outputSchema: schema,
    });
    expect(readFileSync(join(bad.runDir, "final", "structured_output.yaml"), "utf8")).toContain(
      "status: failed",
    );
    // The same schema with the field ABSENT (its optionality) is conformant.
    const ok = await new Orchestrator({
      registry: new Map([["schema-capable", makeAdapter(JSON.stringify({}))]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["schema-capable"],
      n: 1,
      outputSchema: schema,
    });
    expect(readFileSync(join(ok.runDir, "final", "structured_output.yaml"), "utf8")).toContain(
      "status: passed",
    );
    expect(existsSync(join(ok.runDir, "final", "output.json"))).toBe(true);
  });

  it("refuses outputSchema at preflight when a selected lane cannot constrain natively (W8)", async () => {
    const repo = await initRepo();
    const adapter = diffImplementer("no-schema-lane");
    const orch = new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
    });
    // Post-announce preflight refusals terminalize as failure ARTIFACTS
    // (loud-request contract), not bare throws.
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: [adapter.id],
      n: 1,
      outputSchema: { type: "object", properties: {} },
    });
    expect(legacyOutcome(res)).toBe("failed");
    expect(res.summary).toContain("cannot constrain output natively");
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "json_schema_output",
    );
  });

  it("refuses an unsupported outputSchema shape at the boundary (W8)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-implement", createFakeHarness("fake-implement")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: [] });
    await expect(
      orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["fake-implement"],
        outputSchema: {
          type: "object",
          properties: { item: { $ref: "#/definitions/thing" } },
        },
      }),
    ).rejects.toThrow(/\$ref/);
    await expect(
      orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "plan",
        harnesses: ["fake-implement"],
        outputSchema: { type: "object", properties: {} },
      }),
    ).rejects.toThrow(/applies to agent\/ask/);
    // `format` is refused while the pinned claude (<2.1.205) silently drops
    // the whole schema when it is present (doc-verified).
    await expect(
      orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["fake-implement"],
        outputSchema: {
          type: "object",
          properties: { when: { type: "string", format: "date-time" } },
        },
      }),
    ).rejects.toThrow(/format/);
  });

  it("writes an auth route receipt from the disclosing attempt (native_first + fallback reason) (W10)", async () => {
    const repo = await initRepo();
    const disclose = (
      id: string,
      route: "vendor_native" | "managed_api_key",
      source: "native_session" | "api_key_env",
    ): HarnessAdapter => ({
      ...diffImplementer(id),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          credential_route: route,
          credential_source: source,
        };
        writeFileSync(join(spec.cwd, "CHANGED.txt"), "change\n");
        yield {
          type: "file_change",
          session_id: spec.session_id,
          ts,
          payload: { path: "CHANGED.txt", action: "create" },
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    });
    // auto + native session disclosed → native_first (INV-061).
    const native = disclose("native-lane", "vendor_native", "native_session");
    const res1 = await new Orchestrator({
      registry: new Map([[native.id, native]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: [native.id],
      tests: [shellGate("true")],
      n: 1,
    });
    const t1 = readFileSync(join(res1.runDir, "final", "telemetry.yaml"), "utf8");
    expect(t1).toContain("requested: auto");
    expect(t1).toContain("effective: local_session");
    expect(t1).toContain("source: native_session");
    expect(t1).toContain("reason: native_first");
    // auto + api key route disclosed → the honest fallback reason.
    const api = disclose("api-lane", "managed_api_key", "api_key_env");
    const res2 = await new Orchestrator({
      registry: new Map([[api.id, api]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: [api.id],
      tests: [shellGate("true")],
      n: 1,
    });
    const t2 = readFileSync(join(res2.runDir, "final", "telemetry.yaml"), "utf8");
    expect(t2).toContain("effective: api_key");
    expect(t2).toContain("reason: no_native_session_fallback");
  });

  it("records a typed model mismatch when observed differs from requested (W11)", async () => {
    const repo = await initRepo();
    const adapter: HarnessAdapter = {
      ...diffImplementer("drifting-lane"),
      async discover() {
        return HarnessManifest.parse({
          id: "drifting-lane",
          display_name: "drifting-lane",
          kind: "local_cli",
          provider_family: "local",
          capabilities: { implement: true, known_models: ["model-x"] },
          access_profiles_supported: ["workspace_write", "full"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        // The stream discloses a DIFFERENT model than the hint it was sent.
        yield { type: "started", session_id: spec.session_id, ts, observed_model: "model-y" };
        writeFileSync(join(spec.cwd, "CHANGED.txt"), "change\n");
        yield {
          type: "file_change",
          session_id: spec.session_id,
          ts,
          payload: { path: "CHANGED.txt", action: "create" },
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const orch = new Orchestrator({ registry: new Map([[adapter.id, adapter]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: [adapter.id],
      models: { "drifting-lane": "model-x" },
      tests: [shellGate("true")],
      n: 1,
    });
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toContain("requested_model: model-x");
    expect(telemetry).toContain("model_mismatch:");
    expect(telemetry).toContain("observed: model-y");
  });

  it("refuses a route-scoped model on an undecidable route, fail-closed (W11)", async () => {
    const repo = await initRepo();
    const adapter: HarnessAdapter = {
      ...diffImplementer("route-scoped-lane"),
      async discover() {
        return HarnessManifest.parse({
          id: "route-scoped-lane",
          display_name: "route-scoped-lane",
          kind: "local_cli",
          provider_family: "local",
          capabilities: {
            implement: true,
            known_models: [{ id: "sub-model", routes: ["local_session"] }],
          },
          access_profiles_supported: ["workspace_write", "full"],
        });
      },
    };
    const orch = new Orchestrator({ registry: new Map([[adapter.id, adapter]]), reviewers: [] });
    // The fixture adapter's doctor reports no usable auth sources → the route
    // estimate is null → a local_session-scoped model must be refused.
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: [adapter.id],
      models: { "route-scoped-lane": "sub-model" },
      n: 1,
    });
    expect(legacyOutcome(res)).toBe("failed");
    expect(res.summary).toContain("sub-model");
    expect(res.summary).toContain("route");
  });

  it("run-level maxTurns beats settings and is disclosed when unsupported (W13)", async () => {
    const repo = await initRepo();
    let seenMaxTurns: number | null | undefined;
    const supported: HarnessAdapter = {
      ...diffImplementer("turns-lane"),
      async discover() {
        return HarnessManifest.parse({
          id: "turns-lane",
          display_name: "turns-lane",
          kind: "local_cli",
          provider_family: "local",
          capabilities: { implement: true, max_turns: true },
          access_profiles_supported: ["workspace_write", "full"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        seenMaxTurns = spec.max_turns;
        yield { type: "started", session_id: spec.session_id, ts };
        writeFileSync(join(spec.cwd, "CHANGED.txt"), "change\n");
        yield {
          type: "file_change",
          session_id: spec.session_id,
          ts,
          payload: { path: "CHANGED.txt", action: "create" },
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    await new Orchestrator({ registry: new Map([[supported.id, supported]]), reviewers: [] }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: [supported.id],
      maxTurns: 7,
      tests: [shellGate("true")],
      n: 1,
    });
    expect(seenMaxTurns).toBe(7);
    // A lane without native max_turns support never receives the cap; the
    // contract still records the caller's request.
    const unsupported: HarnessAdapter = {
      ...diffImplementer("no-turns-lane"),
      async *run(spec) {
        const ts = new Date().toISOString();
        seenMaxTurns = spec.max_turns;
        yield { type: "started", session_id: spec.session_id, ts };
        writeFileSync(join(spec.cwd, "CHANGED.txt"), "change\n");
        yield {
          type: "file_change",
          session_id: spec.session_id,
          ts,
          payload: { path: "CHANGED.txt", action: "create" },
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const res = await new Orchestrator({
      registry: new Map([[unsupported.id, unsupported]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: [unsupported.id],
      maxTurns: 7,
      tests: [shellGate("true")],
      n: 1,
    });
    expect(seenMaxTurns ?? null).toBe(null);
    expect(readFileSync(join(res.runDir, "context", "task.yaml"), "utf8")).toContain(
      "max_turns: 7",
    );
  });

  it("forwards abort into the harness process for silent active runs", async () => {
    const repo = await initRepo();
    const marker = join(repo, "survived.txt");
    const adapter: HarnessAdapter = {
      id: "silent-process",
      async discover() {
        return HarnessManifest.parse({
          id: "silent-process",
          display_name: "silent-process",
          kind: "local_cli",
          capabilities: { implement: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "silent-process",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        const signal = spec.extra["abortSignal"] as AbortSignal | undefined;
        const script = [
          "console.log('ready')",
          "process.on('SIGINT', () => {})",
          `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1500)`,
          "setTimeout(() => {}, 5000)",
        ].join(";");
        for await (const ev of spawnProcess(process.execPath, ["-e", script], {
          abortSignal: signal,
          cancelKillDelayMs: 100,
        })) {
          if (ev.type === "stdout" && ev.line === "ready") {
            yield { type: "started", session_id: spec.session_id, ts: new Date().toISOString() };
          }
        }
      },
    };
    const ac = new AbortController();
    const orch = new Orchestrator({ registry: new Map([["silent-process", adapter]]) });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["silent-process"],
      signal: ac.signal,
      onHarnessEvent: (e) => {
        if (e.type === "started") ac.abort();
      },
    });
    expect(legacyOutcome(res)).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(existsSync(marker)).toBe(false);
  }, 10000);

  it("isolates a throwing onHarnessEvent observer (agent stays terminal no-op)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      onHarnessEvent: () => {
        throw new Error("observer boom");
      },
    });
    expect(res.facts.noChanges).toBe(true);
  });

  it("isolates a throwing onHarnessEvent observer in best_of_n (candidate not failed by observer)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      n: 1,
      onHarnessEvent: () => {
        throw new Error("observer boom");
      },
    });
    expect(res.facts.noChanges).toBe(true);
  });

  it("a pre-aborted signal yields a cancelled result (plan + best_of_n, no misleading errors)", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-success", createFakeHarness("fake-success")],
    ]);
    const orch = new Orchestrator({ registry, reviewers: reviewers() });
    const ac = new AbortController();
    ac.abort();
    const plan = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "plan",
      harnesses: ["fake-success"],
      signal: ac.signal,
    });
    expect(legacyOutcome(plan)).toBe("cancelled");
    const race = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fake-success"],
      n: 2,
      signal: ac.signal,
    });
    expect(legacyOutcome(race)).toBe("cancelled");
  });

  it("harness.completed after a mid-stream cancel is status=cancelled, never success (QA-027)", async () => {
    const repo = await initRepo();
    const midAbort: HarnessAdapter = {
      ...createFakeHarness("fake-success"),
      id: "mid-abort",
      async *run(spec) {
        yield { type: "started", session_id: spec.session_id, ts: new Date().toISOString() };
        yield {
          type: "tool_call",
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          text: "sleep",
          tool: { name: "command", kind: "command", target: "sleep 60" },
        };
        const signal = spec.extra["abortSignal"] as AbortSignal | undefined;
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const controller = new AbortController();
    const orch = new Orchestrator({
      registry: new Map([["mid-abort", midAbort]]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "long tool",
      mode: "agent",
      harnesses: ["mid-abort"],
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "harness.event") controller.abort();
      },
    });
    expect(legacyOutcome(res)).toBe("cancelled");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; payload?: Record<string, unknown> });
    const completed = events.filter((e) => e.type === "harness.completed");
    for (const e of completed) {
      expect(e.payload?.["status"]).not.toBe("success");
      expect(e.payload?.["status"]).toBe("cancelled");
    }
  }, 15000);

  it("cancels plan mode mid-planner instead of writing a success plan", async () => {
    const repo = await initRepo();
    let plannerStarted = false;
    const slow: HarnessAdapter = {
      ...markdownPlannerAdapter("slow-planner", []),
      async *run(spec) {
        plannerStarted = true;
        yield { type: "started", session_id: spec.session_id, ts: new Date().toISOString() };
        const signal = spec.extra["abortSignal"] as AbortSignal | undefined;
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const controller = new AbortController();
    const orch = new Orchestrator({
      registry: new Map([["slow-planner", slow]]),
      reviewers: [],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "map cancellation",
      mode: "plan",
      harnesses: ["slow-planner"],
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "harness.event") controller.abort();
      },
    });
    expect(plannerStarted).toBe(true);
    expect(legacyOutcome(res)).toBe("cancelled");
    expect(existsSync(join(res.runDir, "final", "plan.md"))).toBe(false);
    const telemetry = new ArtifactStore(repo).readYaml<{
      final_attempt_id: string | null;
      attempts: Array<{
        outcome: { deliverable_present: boolean; harness_errored: boolean; status: string };
      }>;
    }>(join(res.runDir, "final", "telemetry.yaml"));
    expect(telemetry).toMatchObject({
      final_attempt_id: null,
      attempts: [
        {
          outcome: { deliverable_present: false, harness_errored: false, status: "failed" },
        },
      ],
    });
  });

  it("cancels agent mode after a reviewer-panel abort instead of continuing to arbitration", async () => {
    const repo = await initRepo();
    let reviewerStarted = false;
    const reviewer: ReviewerSpec = {
      providerFamily: "anthropic",
      adapter: {
        id: "slow-agent-reviewer",
        async discover() {
          return HarnessManifest.parse({
            id: "slow-agent-reviewer",
            display_name: "slow agent reviewer",
            kind: "local_cli",
            provider_family: "anthropic",
            capabilities: { review: true },
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: "slow-agent-reviewer",
            status: "ok",
            enabled_intents: ["review"],
          });
        },
        async *run(spec) {
          reviewerStarted = true;
          const ts = new Date().toISOString();
          yield {
            type: "started",
            session_id: spec.session_id,
            ts,
            observed_model: "slow-agent-reviewer-model",
          };
          const signal = spec.extra["abortSignal"] as AbortSignal | undefined;
          await new Promise<void>((resolve) => {
            if (!signal || signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    };
    const controller = new AbortController();
    const eventTypes: string[] = [];
    const orch = new Orchestrator({
      registry: new Map([["diff-impl", diffImplementer("diff-impl")]]),
      reviewers: [reviewer],
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "change then cancel review",
      mode: "agent",
      harnesses: ["diff-impl"],
      signal: controller.signal,
      onEvent: (event) => {
        eventTypes.push(event.type);
        if (event.type === "reviewer.first_event") controller.abort();
      },
    });

    expect(reviewerStarted).toBe(true);
    expect(eventTypes).toContain("reviewer.first_event");
    expect(eventTypes).not.toContain("arbitration.completed");
    expect(legacyOutcome(res)).toBe("cancelled");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"run.failed"');
    expect(events).toContain('"lifecycle":"cancelled"');
    expect(events).not.toContain('"type":"arbitration.completed"');
    expect(events).not.toContain('"type":"run.completed"');
  });

  it("in-place convergence runs against a non-git live dir and never deletes it", async () => {
    // A plain (non-git) directory standing in for a stateful external environment.
    const dir = reapMk(join(tmpdir(), "claudexor-orch-inplace-"));
    writeFileSync(join(dir, "task.txt"), "do the thing\n");
    // access=full requires a USER-LEVEL trust allow (TrustConfig wire-in); the
    // test scopes the config dir so it never touches the developer's real home.
    const configDir = reapMk(join(tmpdir(), "claudexor-orch-trust-"));
    mkdirSync(join(configDir, "trust"), { recursive: true });
    writeFileSync(join(configDir, "trust", `${repoHash(dir)}.yaml`), "allow_full_access: true\n");
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const registry = new Map<string, HarnessAdapter>([
        ["fake-success", createFakeHarness("fake-success")],
      ]);
      // Two clean cross-family reviewers -> review-only convergence succeeds on attempt 1.
      const orch = new Orchestrator({ registry, reviewers: reviewers() });
      const res = await orch.run({
        repoRoot: dir,
        prompt: "x",
        mode: "agent",
        harnesses: ["fake-success"],
        attempts: 2,
        inPlace: true,
        access: "full",
      });
      expect(res.facts.noChanges).toBe(true);
      // The live dir and its file survive (dispose must not delete the tree in-place).
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, "task.txt"))).toBe(true);
      // No scoped envelope leaks after dispose.
      expect(existsSync(join(dir, ".claudexor", "workspaces", res.taskId, "converge"))).toBe(false);
    } finally {
      delete process.env.CLAUDEXOR_CONFIG_DIR;
    }
  });

  it("in-place convergence records honest apply-state + revert fence in work_product", async () => {
    // An in-place convergence run mutates the LIVE tree directly across attempts,
    // so its work_product must carry adopted/apply_state/pre_turn_sha/post_turn_sha
    // (parity with runRace) — otherwise the control-api projects applyState
    // "not_applied"/revertable=false and the Revert affordance is lost.
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([["impl", diffImplementer("impl", "local")]]),
      reviewers: reviewers(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["impl"],
      attempts: 2,
      inPlace: true,
    });
    expect(["success", "ungated"]).toContain(legacyOutcome(res));
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(true);
    const wp = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
    expect(wp).toContain("adopted: true");
    expect(wp).toMatch(/apply_state: (applied|applied_review_blocked)/);
    // Both fences are real SHAs (not null) so the server-owned revert can run.
    expect(wp).toMatch(/pre_turn_sha: ['"]?[0-9a-f]{6,}/);
    expect(wp).toMatch(/post_turn_sha: ['"]?[0-9a-f]{6,}/);
  });

  it("refuses in-place raw patch convergence before the first harness attempt", async () => {
    const repo = await initRepo();
    let runs = 0;
    const raw = rawPatchImplementer("raw-patch", () => {
      runs += 1;
    });
    const res = await new Orchestrator({
      registry: new Map([[raw.id, raw]]),
      reviewers: reviewers(),
    }).run({
      repoRoot: repo,
      prompt: "edit README",
      mode: "agent",
      harnesses: [raw.id],
      attempts: 2,
      inPlace: true,
    });

    expect(legacyOutcome(res)).toBe("failed");
    expect(runs).toBe(0);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# repo\n");
    expect(res.summary).toContain("in-place convergence is unavailable");
  });

  it("refuses access=full without a user-level trust allow (loud, no silent downgrade)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-orch-notrust-"));
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const registry = new Map<string, HarnessAdapter>([
        ["fake-success", createFakeHarness("fake-success")],
      ]);
      const orch = new Orchestrator({ registry, reviewers: reviewers() });
      await expect(
        orch.run({
          repoRoot: repo,
          prompt: "x",
          mode: "agent",
          harnesses: ["fake-success"],
          n: 1,
          access: "full",
        }),
      ).rejects.toThrow(/allow_full_access/);
    } finally {
      delete process.env.CLAUDEXOR_CONFIG_DIR;
    }
  });

  it("keeps every non-off policy optional and refuses only off on an uncontrolled harness", async () => {
    const repo = await initRepo();
    const answer = (sessionId: string) => [
      { type: "started", session_id: sessionId, ts: new Date().toISOString() },
      {
        type: "message",
        session_id: sessionId,
        ts: new Date().toISOString(),
        text: "local answer",
      },
      { type: "completed", session_id: sessionId, ts: new Date().toISOString() },
    ];
    // `none` (no web at ALL) trivially satisfies --web off.
    const noWeb = new Map<string, HarnessAdapter>([
      ["no-web", askAdapter("no-web", answer, "openai", "none")],
    ]);
    for (const web of ["off", "auto", "cached", "live"] as const) {
      const ok = await new Orchestrator({ registry: noWeb, reviewers: [] }).run({
        repoRoot: repo,
        prompt: "q",
        mode: "ask",
        harnesses: ["no-web"],
        web,
      });
      expect(legacyOutcome(ok), web).toBe("success");
      expect(readFileSync(join(ok.runDir, "context", "task.yaml"), "utf8")).toContain(
        "web_required: false",
      );
    }
    // `uncontrolled` (web exists, no switch) cannot enforce off: explicit selection fails loudly.
    const uncontrolled = new Map<string, HarnessAdapter>([
      ["wild-web", askAdapter("wild-web", answer, "openai", "uncontrolled")],
    ]);
    const blocked = await new Orchestrator({ registry: uncontrolled, reviewers: [] }).run({
      repoRoot: repo,
      prompt: "q",
      mode: "ask",
      harnesses: ["wild-web"],
      web: "off",
    });
    expect(legacyOutcome(blocked)).toBe("failed");
    expect(blocked.summary).toContain("cannot guarantee web is disabled");
    expect(blocked.summary).toContain("rerun with --web auto, --web cached, or --web live");
    expect(blocked.summary).toContain("select a harness that can enforce --web off");
    expect(readRunEvents(blocked.runDir).some((event) => event.type === "harness.started")).toBe(
      false,
    );
    expect(readFileSync(join(blocked.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "category: harness_unavailable",
    );

    for (const web of ["auto", "cached", "live"] as const) {
      const optional = await new Orchestrator({ registry: uncontrolled, reviewers: [] }).run({
        repoRoot: repo,
        prompt: "q",
        mode: "ask",
        harnesses: ["wild-web"],
        web,
      });
      expect(legacyOutcome(optional), web).toBe("success");
    }
  });

  it("applies the configured global paid_budget_per_run as the default run cap", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-orch-budgetcfg-"));
    writeFileSync(
      join(configDir, "config.yaml"),
      "budget:\n  paid_budget_per_run:\n    kind: finite\n    maxUsd: 0.005\n",
    );
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const registry = new Map<string, HarnessAdapter>([
        ["fake-success", createFakeHarness("fake-success")],
      ]);
      const orch = new Orchestrator({ registry, reviewers: reviewers() });
      // No explicit --max-usd: the configured default cap must bind (each fake
      // candidate costs 0.01 > 0.005, so the wave settles into the hard tier
      // and queued slots are denied — same shape as the explicit-cap test).
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["fake-success"],
        n: 6,
      });
      const contract = readFileSync(join(res.runDir, "context", "task.yaml"), "utf8");
      expect(contract).toContain("paid_budget:");
      expect(contract).toContain("maxUsd: 0.005");
      const primary = res.candidates.filter((c) => /^a\d+$/.test(c.attemptId));
      expect(primary.length).toBeLessThan(6);
    } finally {
      delete process.env.CLAUDEXOR_CONFIG_DIR;
    }
  });
});

function readRunEvents(
  runDir: string,
): { seq?: number; type: string; payload: Record<string, unknown> }[] {
  return readFileSync(join(runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { seq?: number; type: string; payload: Record<string, unknown> });
}

/** Lifecycle invariant: output.ready precedes the terminal event (non-cancelled). */
function expectOutputReadyBeforeTerminal(runDir: string): void {
  const events = readRunEvents(runDir);
  const terminalIdx = events.findIndex((e) =>
    ["run.completed", "run.failed", "run.blocked"].includes(e.type),
  );
  expect(terminalIdx).toBeGreaterThan(-1);
  const terminal = events[terminalIdx]!;
  if (terminal.type === "run.failed" && terminal.payload["lifecycle"] === "cancelled") return; // cancelled runs promise no output
  const readyIdx = events.findIndex((e) => e.type === "output.ready");
  expect(readyIdx).toBeGreaterThan(-1);
  expect(readyIdx).toBeLessThan(terminalIdx);
}

describe("Orchestrator v0.8 honesty & streaming", () => {
  it("stamps a strictly monotonic seq on every run event", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["impl", realLikeAdapter("impl")]]);
    const res = await new Orchestrator({ registry, reviewers: reviewers() }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["impl"],
      n: 1,
    });
    const events = readRunEvents(res.runDir);
    expect(events.length).toBeGreaterThan(3);
    for (const [idx, ev] of events.entries()) {
      expect(ev.seq).toBe(idx + 1);
    }
  });

  it("emits output.ready before the terminal event in every mode", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([["impl", realLikeAdapter("impl")]]);
    const answer = (sessionId: string) => [
      { type: "started", session_id: sessionId, ts: new Date().toISOString() },
      { type: "message", session_id: sessionId, ts: new Date().toISOString(), text: "An answer." },
      { type: "completed", session_id: sessionId, ts: new Date().toISOString() },
    ];
    const askRegistry = new Map<string, HarnessAdapter>([["asker", askAdapter("asker", answer)]]);

    const race = await new Orchestrator({ registry, reviewers: reviewers() }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["impl"],
      n: 1,
    });
    expectOutputReadyBeforeTerminal(race.runDir);

    const converge = await new Orchestrator({ registry, reviewers: reviewers() }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["impl"],
      attempts: 1,
    });
    expectOutputReadyBeforeTerminal(converge.runDir);

    const ask = await new Orchestrator({ registry: askRegistry, reviewers: [] }).run({
      repoRoot: repo,
      prompt: "q",
      mode: "ask",
      harnesses: ["asker"],
    });
    expectOutputReadyBeforeTerminal(ask.runDir);

    const plan = await new Orchestrator({ registry: askRegistry, reviewers: [] }).run({
      repoRoot: repo,
      prompt: "q",
      mode: "plan",
      harnesses: ["asker"],
    });
    expectOutputReadyBeforeTerminal(plan.runDir);
  });

  it("skips review/synthesis/arbitration entirely when no candidate produced work", async () => {
    const repo = await initRepo();
    const crashing: HarnessAdapter = {
      id: "crasher",
      async discover() {
        return HarnessManifest.parse({
          id: "crasher",
          display_name: "crasher",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { implement: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "crasher",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(): AsyncIterable<never> {
        throw new Error("adapter exploded before any work");
      },
    };
    const res = await new Orchestrator({
      registry: new Map([["crasher", crashing]]),
      reviewers: reviewers(),
    }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["crasher"],
      n: 2,
    });
    expect(legacyOutcome(res)).toBe("failed");
    expect(res.summary).toContain("adapter exploded");
    const events = readRunEvents(res.runDir);
    const types = events.map((e) => e.type);
    // No reviewer money, no synthesis, no arbitration over corpses.
    expect(types).not.toContain("review.started");
    expect(types).not.toContain("reviewer.started");
    expect(types).not.toContain("synthesis.started");
    expect(types).not.toContain("arbitration.completed");
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).toContain("adapter exploded");
    expect(failure).not.toContain("attempts/a02/attempt.yaml\n"); // rawDetailRef must reference an EXISTING file
    expect(existsSync(join(res.runDir, "attempts", "a01", "attempt.yaml"))).toBe(true);
    expectOutputReadyBeforeTerminal(res.runDir);
  });

  it("initializes a git boundary automatically for write modes on a non-git folder", async () => {
    const dir = reapMk(join(tmpdir(), "claudexor-nongit-"));
    writeFileSync(join(dir, "notes.txt"), "pre-existing file\n");
    const registry = new Map<string, HarnessAdapter>([["impl", realLikeAdapter("impl")]]);
    const res = await new Orchestrator({ registry, reviewers: reviewers() }).run({
      repoRoot: dir,
      prompt: "x",
      mode: "agent",
      harnesses: ["impl"],
      n: 1,
    });
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    const events = readRunEvents(res.runDir);
    const initEvent = events.find((e) => e.type === "project.git.initialized");
    expect(initEvent).toBeDefined();
    expect(initEvent?.payload["baseline_committed"]).toBe(true);
    const log = await runCapture("git", ["-C", dir, "log", "--oneline"]);
    expect(log.stdout).toContain("claudexor: initialize repository baseline");
    // The baseline includes user files; runtime lives outside the repository.
    const tracked = await runCapture("git", ["-C", dir, "ls-files"]);
    expect(tracked.stdout).toContain("notes.txt");
    expect(tracked.stdout).not.toContain(".claudexor/runs");
  });

  it("runs delegated readonly agents without Git, bridge, capture, or synthesis prep", async () => {
    const dir = reapMk(join(tmpdir(), "claudexor-readonly-nongit-"));
    writeFileSync(join(dir, "notes.txt"), "source stays untouched\n");
    writeFileSync(join(dir, "AGENTS.md"), "# project instructions\n");
    let calls = 0;
    const readonlyAdapter = (id: string): HarnessAdapter => ({
      ...realLikeAdapter(id),
      async *run(spec) {
        calls += 1;
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        yield { type: "message", session_id: spec.session_id, ts, text: `answer from ${id}` };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    });
    const res = await new Orchestrator({
      registry: new Map([
        ["reader-a", readonlyAdapter("reader-a")],
        ["reader-b", readonlyAdapter("reader-b")],
      ]),
      reviewers: [],
    }).run({
      repoRoot: dir,
      executionRoot: dir,
      prompt: "inspect only",
      mode: "agent",
      harnesses: ["reader-a", "reader-b"],
      n: 2,
      synthesis: "always",
      access: "readonly",
      inPlace: true,
      delegated: true,
    });

    expect(res.lifecycle).toBe("succeeded");
    expect(calls).toBe(2);
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("source stays untouched\n");
    const events = readRunEvents(res.runDir);
    expect(events.some((event) => event.type === "project.git.initialized")).toBe(false);
    expect(events.some((event) => event.type === "project.claude_bridge.created")).toBe(false);
    expect(events.filter((event) => event.type === "harness.started")).toHaveLength(2);
    expect(existsSync(join(res.runDir, "final", "answer.md"))).toBe(true);
    expect(existsSync(join(res.runDir, "final", "summary.md"))).toBe(true);
    expect(existsSync(join(res.runDir, "final", "patch.diff"))).toBe(false);
    expect(existsSync(join(res.runDir, "final", "work_product.yaml"))).toBe(false);
    expect(existsSync(join(res.runDir, "final", "delivery_receipt.yaml"))).toBe(false);
    expect(events.some((event) => event.type === "work_product.emitted")).toBe(false);
    expect(events.some((event) => event.type === "work_product.adopted")).toBe(false);
    for (const attemptId of ["a01", "a02"]) {
      expect(existsSync(join(res.runDir, "attempts", attemptId, "patch.diff"))).toBe(false);
      const attempt = new ArtifactStore(dir).readYaml<Record<string, unknown>>(
        join(res.runDir, "attempts", attemptId, "attempt.yaml"),
      );
      expect(attempt).not.toHaveProperty("diffstat");
    }
    const synthesis = readFileSync(join(res.runDir, "arbitration", "synthesis.yaml"), "utf8");
    expect(synthesis).toContain("synthesize: false");
    expect(synthesis).toContain("readonly access has no write-backed synthesis lifecycle");
  });

  it("keeps readonly artifact-security failures diagnostic-only", async () => {
    const dir = reapMk(join(tmpdir(), "claudexor-readonly-artifact-failure-"));
    const secret = `sk-${"r".repeat(24)}`;
    writeFileSync(join(dir, "secret.png"), Buffer.concat([Buffer.from([0]), Buffer.from(secret)]));
    const adapter: HarnessAdapter = {
      ...realLikeAdapter("reader"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: "![secret](secret.png)",
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const res = await new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
    }).run({
      repoRoot: dir,
      executionRoot: dir,
      prompt: "inspect only",
      mode: "agent",
      harnesses: [adapter.id],
      access: "readonly",
      inPlace: true,
      delegated: true,
    });

    expect(res.lifecycle).toBe("failed");
    expect(existsSync(join(res.runDir, "final", "patch.diff"))).toBe(false);
    expect(existsSync(join(res.runDir, "final", "work_product.yaml"))).toBe(false);
    expect(existsSync(join(res.runDir, "final", "delivery_receipt.yaml"))).toBe(false);
    expect(existsSync(join(res.runDir, "final", "summary.md"))).toBe(true);
    expect(existsSync(join(res.runDir, "final", "telemetry.yaml"))).toBe(true);
    const events = readRunEvents(res.runDir);
    expect(events.some((event) => event.type === "work_product.emitted")).toBe(false);
    expect(events.some((event) => event.type === "work_product.adopted")).toBe(false);
  });

  it("refuses fresh delegated live writes without a caller-owned execution tree", async () => {
    const dir = reapMk(join(tmpdir(), "claudexor-delegated-workspace-required-"));
    writeFileSync(join(dir, "source.txt"), "unchanged\n");
    let harnessCalls = 0;
    const adapter: HarnessAdapter = {
      ...realLikeAdapter("writer"),
      async *run(): AsyncIterable<never> {
        harnessCalls += 1;
        throw new Error("missing execution workspace must refuse before spawn");
      },
    };
    const orchestrator = new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
    });

    await expect(
      orchestrator.run({
        repoRoot: dir,
        prompt: "edit",
        mode: "agent",
        harnesses: [adapter.id],
        access: "workspace_write",
        inPlace: true,
        delegated: true,
      }),
    ).rejects.toMatchObject({ code: "execution_workspace_required", status: 400 });
    expect(harnessCalls).toBe(0);
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(readFileSync(join(dir, "source.txt"), "utf8")).toBe("unchanged\n");
  });

  it("refuses readonly convergence before Git, run artifacts, or harness work", async () => {
    const explicitRoot = reapMk(join(tmpdir(), "claudexor-readonly-convergence-explicit-"));
    const defaultRoot = reapMk(join(tmpdir(), "claudexor-readonly-convergence-default-"));
    writeFileSync(join(explicitRoot, "source.txt"), "unchanged\n");
    writeFileSync(join(defaultRoot, "source.txt"), "unchanged\n");
    setAccessDefault(defaultRoot, "readonly");
    let harnessCalls = 0;
    const adapter: HarnessAdapter = {
      ...realLikeAdapter("impl"),
      async *run(): AsyncIterable<never> {
        harnessCalls += 1;
        throw new Error("readonly convergence must refuse before spawn");
      },
    };
    const orchestrator = new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
    });

    for (const input of [
      { repoRoot: explicitRoot, access: "readonly" as const, attempts: 2 },
      { repoRoot: defaultRoot, untilClean: true },
      {
        repoRoot: explicitRoot,
        access: "readonly" as const,
        tests: [shellGate("printf ran > gate-ran.txt")],
      },
      {
        repoRoot: defaultRoot,
        tests: [shellGate("printf ran > gate-ran.txt")],
      },
    ]) {
      await expect(
        orchestrator.run({
          ...input,
          prompt: "repair without write access",
          mode: "agent",
          harnesses: [adapter.id],
          inPlace: true,
        }),
      ).rejects.toMatchObject({
        status: 400,
        code: "strategy_access_incompatible",
        retryable: false,
      });
    }

    expect(harnessCalls).toBe(0);
    for (const root of [explicitRoot, defaultRoot]) {
      expect(existsSync(join(root, ".git"))).toBe(false);
      expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(root, "gate-ran.txt"))).toBe(false);
      expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("unchanged\n");
    }
  });

  it("leaves dirty Git metadata byte-stable for a delegated readonly agent", async () => {
    const repo = await initRepo();
    writeFileSync(join(repo, "dirty.txt"), "pre-existing user work\n");
    writeFileSync(join(repo, "AGENTS.md"), "# project instructions\n");
    const indexPath = join(repo, ".git", "index");
    const indexBefore = readFileSync(indexPath);
    const objectsBefore = (await runCapture("git", ["-C", repo, "count-objects", "-v"])).stdout;
    const headBefore = (await runCapture("git", ["-C", repo, "rev-parse", "HEAD"])).stdout;
    const reader: HarnessAdapter = {
      ...realLikeAdapter("reader"),
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        yield { type: "message", session_id: spec.session_id, ts, text: "read-only answer" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };

    const res = await new Orchestrator({
      registry: new Map([["reader", reader]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      executionRoot: repo,
      prompt: "inspect only",
      mode: "agent",
      harnesses: ["reader"],
      n: 1,
      access: "readonly",
      inPlace: true,
      delegated: true,
    });

    expect(res.lifecycle).toBe("succeeded");
    expect(readFileSync(indexPath).equals(indexBefore)).toBe(true);
    expect((await runCapture("git", ["-C", repo, "count-objects", "-v"])).stdout).toBe(
      objectsBefore,
    );
    expect((await runCapture("git", ["-C", repo, "rev-parse", "HEAD"])).stdout).toBe(headBefore);
    expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);
    expect(readFileSync(join(repo, "dirty.txt"), "utf8")).toBe("pre-existing user work\n");
  });

  it("announces project initialization prepared for an isolated read-only turn", async () => {
    const repo = await initRepo();
    const head = (await runCapture("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    const asker = askAdapter("asker", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield { type: "message", session_id: sessionId, ts, text: "answer" };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const res = await new Orchestrator({
      registry: new Map([["asker", asker]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      executionRoot: repo,
      projectGitInitialization: {
        initialized: true,
        baselineCommitted: true,
        gitignoreSeeded: false,
        headSha: head,
      },
      prompt: "read",
      mode: "ask",
      harnesses: ["asker"],
    });
    const events = readRunEvents(res.runDir);
    const created = events.findIndex((event) => event.type === "run.created");
    const initialized = events.findIndex((event) => event.type === "project.git.initialized");
    expect(initialized).toBe(created + 1);
    expect(events[initialized]?.payload).toMatchObject({
      repo_root: repo,
      initialized: true,
      baseline_committed: true,
      head_sha: head,
    });
  });

  it("bridges an AGENTS.md-only project to CLAUDE.md and announces it (D-14/INV-113)", async () => {
    const dir = reapMk(join(tmpdir(), "claudexor-agents-bridge-"));
    writeFileSync(join(dir, "AGENTS.md"), "# project instructions\n");
    const registry = new Map<string, HarnessAdapter>([["impl", realLikeAdapter("impl")]]);
    const res = await new Orchestrator({ registry, reviewers: reviewers() }).run({
      repoRoot: dir,
      prompt: "x",
      mode: "agent",
      harnesses: ["impl"],
      n: 1,
    });
    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("@AGENTS.md");
    expect(claude).toContain("claudexor:generated claude-bridge");
    const events = readRunEvents(res.runDir);
    const bridge = events.find((e) => e.type === "project.claude_bridge.created");
    expect(bridge).toBeDefined();
    expect(bridge?.payload["path"]).toBe("CLAUDE.md");
    expect(bridge?.payload["source"]).toBe("AGENTS.md");
  });

  it("never overwrites an existing CLAUDE.md and emits no bridge event", async () => {
    const dir = reapMk(join(tmpdir(), "claudexor-agents-nobridge-"));
    writeFileSync(join(dir, "AGENTS.md"), "# a\n");
    writeFileSync(join(dir, "CLAUDE.md"), "# hand-written\n");
    const registry = new Map<string, HarnessAdapter>([["impl", realLikeAdapter("impl")]]);
    const res = await new Orchestrator({ registry, reviewers: reviewers() }).run({
      repoRoot: dir,
      prompt: "x",
      mode: "agent",
      harnesses: ["impl"],
      n: 1,
    });
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("# hand-written\n");
    const types = readRunEvents(res.runDir).map((e) => e.type);
    expect(types).not.toContain("project.claude_bridge.created");
  });

  it("delivers interactive answers into the harness and logs the lifecycle", async () => {
    const repo = await initRepo();
    const seen: unknown[] = [];
    const interactive: HarnessAdapter = {
      id: "asker",
      async discover() {
        return HarnessManifest.parse({
          id: "asker",
          display_name: "asker",
          kind: "local_cli",
          provider_family: "anthropic",
          capabilities: { implement: true, interactive: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "asker",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        const channel = (spec.extra as Record<string, unknown>)["interactionChannel"] as
          { request(req: unknown): Promise<unknown> } | undefined;
        if (channel) {
          const answers = await channel.request({
            interaction_id: "int-1",
            source_tool: "AskUserQuestion",
            questions: [
              {
                id: "q1",
                question: "Which flavor?",
                header: null,
                options: [{ label: "vanilla", description: null }],
                multi_select: false,
              },
            ],
          });
          seen.push(answers);
        }
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const res = await new Orchestrator({
      registry: new Map([["asker", interactive]]),
      reviewers: reviewers(),
    }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["asker"],
      n: 1,
      onInteraction: async (ctx) => ({
        interaction_id: ctx.request.interaction_id,
        answers: [{ question_id: "q1", selected_labels: ["vanilla"], free_text: null }],
      }),
    });
    expect(legacyOutcome(res)).not.toBe("failed");
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).toContain("vanilla");
    const types = readRunEvents(res.runDir).map((e) => e.type);
    expect(types).toContain("interaction.requested");
    expect(types).toContain("interaction.answered");
  });

  it("declines benignly when the interactive answer times out", async () => {
    const repo = await initRepo();
    const seen: unknown[] = [];
    const interactive: HarnessAdapter = {
      id: "asker",
      async discover() {
        return HarnessManifest.parse({
          id: "asker",
          display_name: "asker",
          kind: "local_cli",
          provider_family: "anthropic",
          capabilities: { implement: true, interactive: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "asker",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        const channel = (spec.extra as Record<string, unknown>)["interactionChannel"] as
          { request(req: unknown): Promise<unknown> } | undefined;
        if (channel) {
          seen.push(
            await channel.request({
              interaction_id: "int-t",
              source_tool: "AskUserQuestion",
              questions: [],
            }),
          );
        }
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const res = await new Orchestrator({
      registry: new Map([["asker", interactive]]),
      reviewers: reviewers(),
    }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["asker"],
      n: 1,
      interactionTimeoutMs: 50,
      onInteraction: () => new Promise(() => {}), // never answers
    });
    expect(legacyOutcome(res)).not.toBe("failed");
    expect(seen).toEqual([null]);
    const types = readRunEvents(res.runDir).map((e) => e.type);
    expect(types).toContain("interaction.requested");
    expect(types).toContain("interaction.timeout");
    expect(types).not.toContain("interaction.answered");
  });

  it("releases an interaction wait immediately when the run is cancelled (no timeout sit-out)", async () => {
    const repo = await initRepo();
    const interactive: HarnessAdapter = {
      id: "asker",
      async discover() {
        return HarnessManifest.parse({
          id: "asker",
          display_name: "asker",
          kind: "local_cli",
          provider_family: "anthropic",
          capabilities: { implement: true, interactive: true },
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "asker",
          status: "ok",
          enabled_intents: ["implement"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        const channel = (spec.extra as Record<string, unknown>)["interactionChannel"] as
          { request(req: unknown): Promise<unknown> } | undefined;
        if (channel) {
          await channel.request({
            interaction_id: "int-c",
            source_tool: "AskUserQuestion",
            questions: [],
          });
        }
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const controller = new AbortController();
    const startedAt = Date.now();
    const res = await new Orchestrator({
      registry: new Map([["asker", interactive]]),
      reviewers: reviewers(),
    }).run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["asker"],
      n: 1,
      interactionTimeoutMs: 60_000, // the wait must NOT sit this out
      signal: controller.signal,
      // Abort only once the question is actually parked (a wall-clock timer
      // can fire before the run even reaches the harness on a cold CI host,
      // cancelling everything before interaction.requested exists).
      onInteraction: () => {
        setTimeout(() => controller.abort(), 25);
        return new Promise(() => {}); // never answers
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    const events = readRunEvents(res.runDir);
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);
  });
});

describe("interaction late-answer honesty", () => {
  it("emits interaction.answer_discarded when the answer arrives after the timeout", async () => {
    const { interactionChannelFor } = await import("./interaction.js");
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const log = {
      emit: (type: string, payload: Record<string, unknown>) => events.push({ type, payload }),
    };
    let releaseAnswer: (v: { answers: { question_id: string; answer: string }[] }) => void = () =>
      undefined;
    const channel = interactionChannelFor(
      {
        onInteraction: () =>
          new Promise((resolve) => {
            releaseAnswer = resolve;
          }),
        interactionTimeoutMs: 100,
      } as never,
      log as never,
      "run-late",
      "task-late",
      "a01",
      "harness-x",
      true,
      900_000,
    );
    expect(channel).toBeTruthy();
    const res = await channel!.request({
      interaction_id: "int-1",
      source_tool: "ask_user",
      questions: [{ id: "q1", question: "answer me?" }],
    } as never);
    expect(res).toBeNull(); // timed out
    expect(events.some((e) => e.type === "interaction.timeout")).toBe(true);
    // The user answers AFTER the decline.
    releaseAnswer({ answers: [{ question_id: "q1", answer: "too late" }] });
    await new Promise((r) => setTimeout(r, 20));
    const discarded = events.find((e) => e.type === "interaction.answer_discarded");
    expect(discarded).toBeTruthy();
    expect(discarded?.payload["reason"]).toBe("timed_out");
  });
});

describe("interaction channel registration order", () => {
  it("invokes the answer handler SYNCHRONOUSLY before emitting interaction.requested (registry-population contract)", async () => {
    const { interactionChannelFor } = await import("./interaction.js");
    const order: string[] = [];
    const log = {
      emit: (type: string) => {
        order.push(type);
      },
    } as never;
    const channel = interactionChannelFor(
      {
        onInteraction: () => {
          order.push("handler");
          return new Promise(() => undefined); // never answers
        },
        interactionTimeoutMs: 30,
      },
      log,
      "run-x",
      "task-x",
      "a01",
      "h1",
      true,
      30,
    );
    await channel!.request({
      interaction_id: "int-1",
      source_tool: "AskUserQuestion",
      questions: [{ id: "q1", prompt: "?", options: [], allow_text: true }],
    } as never);
    expect(order[0]).toBe("handler"); // BEFORE interaction.requested
    expect(order).toContain("interaction.requested");
  });

  it("releases the watchdog suspension even when the handler throws synchronously", async () => {
    const { interactionChannelFor } = await import("./interaction.js");
    const channel = interactionChannelFor(
      {
        onInteraction: () => {
          throw new Error("sync boom");
        },
        interactionTimeoutMs: 20,
      },
      { emit: () => undefined } as never,
      "run-x",
      "task-x",
      "a01",
      "h1",
      true,
      20,
    );
    const res = await channel!.request({
      interaction_id: "int-2",
      source_tool: "AskUserQuestion",
      questions: [{ id: "q1", prompt: "?", options: [], allow_text: true }],
    } as never);
    expect(res).toBeNull();
    expect(channel!.pendingCount!()).toBe(0); // suspension released
    expect(channel!.suspensionVersion!()).toBe(2); // begin + end are both observable
  });
});

describe("auth-route attempt telemetry (route evidence)", () => {
  it("captures the adapter's first-class credential route (first-wins) into the record", async () => {
    const { attemptTelemetryRecord, createAttemptTelemetry, observeAttemptTelemetry } =
      await import("./attemptTelemetry.js");
    const t = createAttemptTelemetry("auto", false);
    const ts = new Date().toISOString();
    observeAttemptTelemetry(t, {
      type: "started",
      session_id: "s",
      ts,
      credential_route: "vendor_native",
    } as never);
    // A later conflicting value must not overwrite the decided route.
    observeAttemptTelemetry(t, {
      type: "message",
      session_id: "s",
      ts,
      text: "x",
      credential_route: "managed_api_key",
    } as never);
    expect(t.authMode).toBe("local_session");
    expect(attemptTelemetryRecord("a1", "codex", t).auth_mode).toBe("local_session");
  });

  it("an absent credential route stays undisclosed (never guessed from payload)", async () => {
    const { attemptTelemetryRecord, createAttemptTelemetry, observeAttemptTelemetry } =
      await import("./attemptTelemetry.js");
    const t = createAttemptTelemetry("auto", false);
    const ts = new Date().toISOString();
    observeAttemptTelemetry(t, { type: "started", session_id: "s", ts } as never);
    observeAttemptTelemetry(t, {
      type: "started",
      session_id: "s",
      ts,
      payload: { auth_route: "local_session" },
    } as never);
    expect(t.authMode).toBeNull();
    expect(attemptTelemetryRecord("a1", "codex", t).auth_mode).toBeNull();
  });
});

describe("durable quota projection routing (QP3)", () => {
  const quotaAdapter = (id: string): HarnessAdapter => ({
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: id === "codex" ? "openai" : "anthropic",
        capabilities: { read_files: true },
        access_profiles_supported: ["readonly"],
        auth_modes: ["local_session"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["explain"],
      });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        credential_route: "vendor_native",
      };
      yield { type: "message", session_id: spec.session_id, ts, text: `from ${id}` };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  });

  it("seeds a new root ledger before initial route ordering", async () => {
    await withScopedConfigDir(async () => {
      const repo = await initRepo();
      const reset = new Date(Date.now() + 9_000_000).toISOString();
      const observed = new Date().toISOString();
      const snapshots = [
        {
          subject: {
            harness: "codex",
            credential_route: "vendor_native" as const,
            plan_label: "Plus",
            subject_id: null,
          },
          constraints: [
            {
              id: "five-hour",
              label: "5 hour",
              used_ratio: 0.1,
              window_seconds: 18_000,
              resets_at: reset,
              cooldown_until: null,
            },
          ],
          source: "codex_app_server" as const,
          observed_at: observed,
          freshness: "fresh" as const,
        },
        {
          subject: {
            harness: "claude",
            credential_route: "vendor_native" as const,
            plan_label: null,
            subject_id: null,
          },
          constraints: [
            {
              id: "five-hour",
              label: "5 hour",
              used_ratio: 0.8,
              window_seconds: 18_000,
              resets_at: reset,
              cooldown_until: null,
            },
          ],
          source: "claude_api_retry" as const,
          observed_at: observed,
          freshness: "fresh" as const,
        },
      ];
      const result = await new Orchestrator({
        registry: new Map([
          ["claude", quotaAdapter("claude")],
          ["codex", quotaAdapter("codex")],
        ]),
        reviewers: [],
        quotaSnapshots: () => snapshots,
      }).run({
        repoRoot: repo,
        prompt: "route by durable quota",
        mode: "ask",
        harnesses: ["claude", "codex"],
        authPreference: "subscription",
        web: "off",
      });

      expect(legacyOutcome(result), result.summary).toBe("success");
      expect(result.candidates).toEqual([
        expect.objectContaining({ harnessId: "codex", status: "success" }),
      ]);
    });
  });

  it.each(["paid fallback never", "active quota cooldown"])(
    "refuses cleanly when %s removes the entire ordered pool",
    async (scenario) => {
      await withScopedConfigDir(async () => {
        const repo = await initRepo();
        if (scenario === "paid fallback never") {
          writeFileSync(
            join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml"),
            "routing:\n  paid_fallback: never\n",
          );
        }
        const cooldown = new Date(Date.now() + 60_000).toISOString();
        const snapshots =
          scenario === "active quota cooldown"
            ? ["claude", "codex"].map((harness) => ({
                subject: {
                  harness,
                  credential_route: "vendor_native" as const,
                  plan_label: null,
                  subject_id: null,
                },
                constraints: [
                  {
                    id: "cooldown",
                    label: "Cooldown",
                    used_ratio: null,
                    window_seconds: null,
                    resets_at: null,
                    cooldown_until: cooldown,
                  },
                ],
                source: "codex_app_server" as const,
                observed_at: new Date().toISOString(),
                freshness: "fresh" as const,
              }))
            : [];
        const orchestrator = new Orchestrator({
          registry: new Map([
            ["claude", quotaAdapter("claude")],
            ["codex", quotaAdapter("codex")],
          ]),
          reviewers: [],
          quotaSnapshots: () => snapshots,
        });

        const result = await orchestrator.run({
          repoRoot: repo,
          prompt: "route or refuse",
          mode: "ask",
          harnesses: ["claude", "codex"],
          authPreference: "subscription",
          web: "off",
        });
        expect(legacyOutcome(result)).toBe("failed");
        expect(result.summary).toMatch(/no harness remains eligible.*budget and quota routing/);
        expect(result.candidates).toEqual([]);
      });
    },
  );

  it("discloses route.primary.diverged when the sticky primary is quota-dropped and another harness runs (round-3 item 1b)", async () => {
    await withScopedConfigDir(async () => {
      const repo = await initRepo();
      // ONLY claude is in cooldown; codex is free. The sticky primary is claude.
      const cooldown = new Date(Date.now() + 60_000).toISOString();
      const snapshots = [
        {
          subject: {
            harness: "claude",
            credential_route: "vendor_native" as const,
            plan_label: null,
            subject_id: null,
          },
          constraints: [
            {
              id: "cooldown",
              label: "Cooldown",
              used_ratio: null,
              window_seconds: null,
              resets_at: null,
              cooldown_until: cooldown,
            },
          ],
          source: "codex_app_server" as const,
          observed_at: new Date().toISOString(),
          freshness: "fresh" as const,
        },
      ];
      const orchestrator = new Orchestrator({
        registry: new Map([
          ["claude", quotaAdapter("claude")],
          ["codex", quotaAdapter("codex")],
        ]),
        reviewers: [],
        quotaSnapshots: () => snapshots,
      });
      const result = await orchestrator.run({
        repoRoot: repo,
        prompt: "route or disclose",
        mode: "ask",
        harnesses: ["claude", "codex"],
        primaryHarness: "claude",
        authPreference: "subscription",
        web: "off",
      });
      // The run SUCCEEDS on codex — but the divergence from the pinned primary
      // must be disclosed as a typed, evidence-backed event (never silent).
      const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
      const diverged = events.find((e) => e.type === "route.primary.diverged");
      expect(diverged).toBeDefined();
      expect(diverged!.payload.requested).toBe("claude");
      expect(diverged!.payload.effective).toBe("codex");
      expect(diverged!.payload.reason).toBe("quota_exhausted");
      expect(typeof diverged!.payload.detail).toBe("string");
    });
  });

  it("does NOT emit route.primary.diverged when the sticky primary actually runs", async () => {
    await withScopedConfigDir(async () => {
      const repo = await initRepo();
      const orchestrator = new Orchestrator({
        registry: new Map([
          ["claude", quotaAdapter("claude")],
          ["codex", quotaAdapter("codex")],
        ]),
        reviewers: [],
        quotaSnapshots: () => [],
      });
      const result = await orchestrator.run({
        repoRoot: repo,
        prompt: "route to the primary",
        mode: "ask",
        harnesses: ["claude", "codex"],
        primaryHarness: "claude",
        authPreference: "subscription",
        web: "off",
      });
      const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8");
      expect(events).not.toContain("route.primary.diverged");
    });
  });
});

describe("resolved auth preference in routing evidence (#121 part 1)", () => {
  /** A lane whose doctor discloses BOTH a native session and a managed-key
   * source, mirroring the real degraded-key shape (harness-codex reports
   * provider_auth_file verification 'failed' when the key is present but its
   * isolated smoke failed). Tests use an EXPLICIT single-harness pool: an
   * auto pool drops the degraded lane and would pass for the wrong reason. */
  const keyedAdapter = (
    id: string,
    keySmoke: "failed" | "passed",
    nativeSmoke: "failed" | "passed",
    specs: HarnessRunSpec[],
  ): HarnessAdapter => ({
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "openai",
        capabilities: { read_files: true },
        auth_modes: ["local_session", "api_key"],
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: keySmoke === "failed" || nativeSmoke === "failed" ? "degraded" : "ok",
        enabled_intents: ["explain"],
        auth_sources: [
          { source: "native_session", availability: "available", verification: nativeSmoke },
          { source: "provider_auth_file", availability: "available", verification: keySmoke },
        ],
      });
    },
    async *run(spec) {
      specs.push(spec);
      const ts = new Date().toISOString();
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        credential_route: "managed_api_key",
      };
      yield { type: "message", session_id: spec.session_id, ts, text: `from ${id}` };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  });

  it("survives a vendor-native cooldown when config-level auth_preference=api_key rides a degraded key (#121 repro)", async () => {
    await withScopedConfigDir(async () => {
      const repo = await initRepo();
      writeFileSync(
        join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml"),
        "harnesses:\n  lane:\n    auth_preference: api_key\n",
      );
      const cooldown = new Date(Date.now() + 60_000).toISOString();
      const snapshots = [
        {
          subject: {
            harness: "lane",
            credential_route: "vendor_native" as const,
            plan_label: null,
            subject_id: null,
          },
          constraints: [
            {
              id: "cooldown",
              label: "Cooldown",
              used_ratio: null,
              window_seconds: null,
              resets_at: null,
              cooldown_until: cooldown,
            },
          ],
          source: "codex_app_server" as const,
          observed_at: new Date().toISOString(),
          freshness: "fresh" as const,
        },
      ];
      const specs: HarnessRunSpec[] = [];
      const result = await new Orchestrator({
        registry: new Map([["lane", keyedAdapter("lane", "failed", "passed", specs)]]),
        reviewers: [],
        quotaSnapshots: () => snapshots,
      }).run({
        repoRoot: repo,
        prompt: "route on the configured key",
        mode: "ask",
        harnesses: ["lane"],
        web: "off",
      });
      // The configured api_key preference classifies the lane on the managed
      // key route, so the vendor_native cooldown must not eliminate it.
      expect(legacyOutcome(result), result.summary).toBe("success");
      expect(result.candidates).toEqual([
        expect.objectContaining({ harnessId: "lane", status: "success" }),
      ]);
      // The spawned spec carries the RESOLVED preference, never raw "auto".
      expect(specs).toHaveLength(1);
      expect(specs[0]?.auth_preference).toBe("api_key");
    });
  });

  it("classifies an auto-preference lane by its actually-selected managed-key route in billing rationale", async () => {
    await withScopedConfigDir(async () => {
      const repo = await initRepo();
      const specs: HarnessRunSpec[] = [];
      // Native readiness FAILED, managed key VERIFIED: the route estimate
      // selects api_key, and billing evidence must follow that selection
      // instead of a manifest-guessed subscription classification.
      const result = await new Orchestrator({
        registry: new Map([["lane", keyedAdapter("lane", "passed", "failed", specs)]]),
        reviewers: [],
        quotaSnapshots: () => [],
      }).run({
        repoRoot: repo,
        prompt: "bill me honestly",
        mode: "ask",
        harnesses: ["lane"],
        web: "off",
      });
      expect(legacyOutcome(result), result.summary).toBe("success");
      const telemetry = readFileSync(join(result.runDir, "final", "telemetry.yaml"), "utf8");
      // routing_rationale billing_knowledge matches the selected route.
      expect(telemetry).toContain("routing_rationale");
      expect(telemetry).toMatch(/billing_knowledge: metered/);
      expect(telemetry).not.toMatch(/billing_knowledge: subscription_entitlement/);
    });
  });

  it("honestly excludes a config-keyed lane under paid_fallback: never even when the key smoke passes", async () => {
    await withScopedConfigDir(async () => {
      const repo = await initRepo();
      writeFileSync(
        join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml"),
        "routing:\n  paid_fallback: never\nharnesses:\n  lane:\n    auth_preference: api_key\n",
      );
      const specs: HarnessRunSpec[] = [];
      const result = await new Orchestrator({
        registry: new Map([["lane", keyedAdapter("lane", "passed", "passed", specs)]]),
        reviewers: [],
        quotaSnapshots: () => [],
      }).run({
        repoRoot: repo,
        prompt: "never pay",
        mode: "ask",
        harnesses: ["lane"],
        web: "off",
      });
      // DELIBERATE visible change: a config-level api_key preference with a
      // verified key is a metered route — paid_fallback: never must exclude
      // it instead of letting it ride a stale subscription classification
      // (and then actually spawn on the paid key).
      expect(legacyOutcome(result)).toBe("failed");
      expect(result.summary).toMatch(/no harness remains eligible.*budget and quota routing/);
      expect(specs).toHaveLength(0);
    });
  });

  it("keeps no-config-preference routing unchanged (regression guard)", async () => {
    await withScopedConfigDir(async () => {
      const repo = await initRepo();
      const specs: HarnessRunSpec[] = [];
      // No config at all: auto preference over healthy native+key sources.
      // The doctrine estimate keeps the native route; billing stays
      // subscription_entitlement (never metered) and the lane spawns as before.
      const result = await new Orchestrator({
        registry: new Map([["lane", keyedAdapter("lane", "passed", "passed", specs)]]),
        reviewers: [],
        quotaSnapshots: () => [],
      }).run({
        repoRoot: repo,
        prompt: "default routing",
        mode: "ask",
        harnesses: ["lane"],
        web: "off",
      });
      expect(legacyOutcome(result), result.summary).toBe("success");
      expect(specs[0]?.auth_preference).toBe("auto");
      const telemetry = readFileSync(join(result.runDir, "final", "telemetry.yaml"), "utf8");
      expect(telemetry).toMatch(/billing_knowledge: subscription_entitlement/);
      expect(telemetry).not.toMatch(/billing_knowledge: metered/);
    });
  });
});

describe("convergence preflight remediation text (#133c)", () => {
  it("pins the battery-matched first sentence and the honest second sentence", async () => {
    const repo = await initRepo();
    const registry = new Map<string, HarnessAdapter>([
      ["fake-implement", createFakeHarness("fake-implement")],
    ]);
    const res = await new Orchestrator({
      registry,
      reviewers: [cleanReviewer("rev-openai", "openai")],
    }).run({
      repoRoot: repo,
      prompt: "converge",
      mode: "agent",
      untilClean: true,
      harnesses: ["fake-implement"],
    });
    expect(legacyOutcome(res)).toBe("failed");
    // The FIRST sentence is byte-stable: scripts/lib/real-harness-battery-state.mjs
    // isCrossFamilyConvergenceRefusal matches exactly this prefix. The SECOND
    // sentence names only reachable remediations (no convergence-predicate
    // knob exists on any run surface — INV-022).
    expect(res.summary).toBe(
      "convergence requires a cross-family clean review (>=2 healthy reviewer provider families); found 1. " +
        "Configure reviewers from a second provider family and check `claudexor doctor` for reviewer readiness.",
    );
  });
});

describe("web evidence recovery keying (INV-043)", () => {
  it("records optional denied web as a non-blocking warning", async () => {
    const {
      createAttemptTelemetry,
      observeAttemptTelemetry,
      setAttemptOutcome,
      toolWarnings,
      webUnsatisfied,
    } = await import("./attemptTelemetry.js");
    const t = createAttemptTelemetry("live", false);
    observeAttemptTelemetry(t, {
      type: "tool_result",
      session_id: "s",
      ts: new Date().toISOString(),
      tool: {
        name: "WebFetch",
        kind: "web",
        status: "denied",
        target: "https://example.com",
        content_summary: "User Rejected",
      },
    } as never);

    expect(t.web).toMatchObject({ attempted: true, failed: true, satisfied: false });
    expect(webUnsatisfied(t)).toBe(false);
    expect(toolWarnings(t)).toMatchObject([
      {
        tool: "WebFetch",
        kind: "web",
        target: "https://example.com",
        summary: "User Rejected",
        recovered: false,
      },
    ]);
    setAttemptOutcome(t, {
      deliverablePresent: true,
      gatesPassed: null,
      harnessErrored: false,
      webRequiredUnsatisfied: webUnsatisfied(t),
    });
    expect(t.outcome).toMatchObject({ status: "success_with_warnings", toolWarningsCount: 1 });
  });

  it("keeps the failure DISCLOSED when an unrelated-target web success satisfies the evidence gate", async () => {
    const { createAttemptTelemetry, observeAttemptTelemetry, webUnsatisfied } =
      await import("./attemptTelemetry.js");
    const t = createAttemptTelemetry("auto", false);
    const ts = new Date().toISOString();
    observeAttemptTelemetry(t, {
      type: "tool_result",
      session_id: "s",
      ts,
      tool: {
        name: "WebSearch",
        kind: "web",
        status: "error",
        target: "query-A",
        error_summary: "search A failed",
      },
    } as never);
    expect(t.web.failed).toBe(true);
    // Success on a DIFFERENT target: evidence obtained (satisfied — the gate
    // asks for evidence, and reformulated queries are legitimate recovery),
    // but the A-failure stays disclosed (failed remains true).
    observeAttemptTelemetry(t, {
      type: "tool_result",
      session_id: "s",
      ts,
      tool: { name: "WebSearch", kind: "web", status: "ok", target: "query-B" },
    } as never);
    expect(t.web.satisfied).toBe(true);
    expect(t.web.failed).toBe(true); // disclosure survives
    expect(t.web.errorSummary).toContain("search A failed");
    expect(webUnsatisfied(t)).toBe(false); // evidence gate: satisfied
    // The unrecovered web failure counts as a WARNING on a satisfied route
    // (green becomes success_with_warnings, never a silent clean success).
    const { toolWarnings } = await import("./attemptTelemetry.js");
    expect(toolWarnings(t).some((e) => e.kind === "web" && e.target === "query-A")).toBe(true);
    // A second failure on another target: BOTH stay disclosed until each
    // recovers (the rollup derives from the tool+target-keyed store).
    observeAttemptTelemetry(t, {
      type: "tool_result",
      session_id: "s",
      ts,
      tool: {
        name: "WebFetch",
        kind: "web",
        status: "error",
        target: "https://c",
        error_summary: "fetch C failed",
      },
    } as never);
    observeAttemptTelemetry(t, {
      type: "tool_result",
      session_id: "s",
      ts,
      tool: { name: "WebFetch", kind: "web", status: "ok", target: "https://c" },
    } as never);
    expect(t.web.failed).toBe(true); // query-A is STILL unrecovered
    // Success on the SAME target is the attributable recovery that clears it.
    observeAttemptTelemetry(t, {
      type: "tool_result",
      session_id: "s",
      ts,
      tool: { name: "WebSearch", kind: "web", status: "ok", target: "query-A" },
    } as never);
    expect(t.web.failed).toBe(false);
  });

  it("a same-name same-target success of a DIFFERENT kind does not recover a web error", async () => {
    const { createAttemptTelemetry, observeAttemptTelemetry } =
      await import("./attemptTelemetry.js");
    const t = createAttemptTelemetry("auto", false);
    const ts = new Date().toISOString();
    observeAttemptTelemetry(t, {
      type: "tool_result",
      session_id: "s",
      ts,
      tool: {
        name: "fetch",
        kind: "web",
        status: "error",
        target: "https://a",
        error_summary: "net down",
      },
    } as never);
    observeAttemptTelemetry(t, {
      type: "tool_result",
      session_id: "s",
      ts,
      tool: { name: "fetch", kind: "command", status: "ok", target: "https://a" },
    } as never);
    expect(t.toolErrors.filter((e) => !e.recovered).length).toBe(1); // web error NOT laundered
  });

  it("an explicitly persisted web_required contract with only failures stays blocking", async () => {
    const { createAttemptTelemetry, observeAttemptTelemetry, webUnsatisfied } =
      await import("./attemptTelemetry.js");
    const t = createAttemptTelemetry("live", true);
    const ts = new Date().toISOString();
    observeAttemptTelemetry(t, {
      type: "tool_result",
      session_id: "s",
      ts,
      tool: {
        name: "WebFetch",
        kind: "web",
        status: "error",
        target: "https://x",
        error_summary: "boom",
      },
    } as never);
    expect(webUnsatisfied(t)).toBe(true);
  });
});

describe("final verify fail-closed + spend accounting (exit-gate criticals)", () => {
  it("verifier infra error yields applied_cleanly=null (attempted), never a silent pass", async () => {
    const repo = await initRepo();
    const { finalVerifyPatch } = await import("@claudexor/delivery");
    const rec = await finalVerifyPatch(
      repo,
      { baseSha: "0000000000000000000000000000000000000000", diff: "diff --git a/x b/x\n" },
      [],
      { emit: () => undefined },
    );
    // worktreeAdd cannot check out a nonexistent sha -> the verifier ERRORED.
    expect(rec).toMatchObject({ attempted: true, applied_cleanly: null });
    expect(rec.reason).toBeTruthy();
  });

  it("ask results carry spendUsd so the aggregate budget can charge them", async () => {
    const repo = await initRepo();
    const adapter = askAdapter("spender", function* (sessionId) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: sessionId, ts };
      yield { type: "message", session_id: sessionId, ts, text: "the answer" };
      yield { type: "usage", session_id: sessionId, ts, usage: { cost_usd: 0.01 } };
      yield { type: "completed", session_id: sessionId, ts };
    });
    const res = await new Orchestrator({
      registry: new Map([["spender", adapter]]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "2+2?",
      mode: "ask",
      harnesses: ["spender"],
    });
    expect(legacyOutcome(res)).toBe("success");
    expect(res.spendUsd).toBeCloseTo(0.01, 5);
  });

  it("watchdog re-arms while a question is awaiting the user (isSuspended) instead of killing the run", async () => {
    const { withInactivityWatchdog, HarnessInactivityTimeoutError } =
      await import("@claudexor/core");
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let suspended = true;
    async function* slowSource() {
      yield "first";
      await sleep(200); // 4x the 50ms window, but suspended -> must survive
      suspended = false;
      yield "second";
    }
    const seen: string[] = [];
    for await (const v of withInactivityWatchdog(slowSource(), {
      timeoutMs: 50,
      countsAsProgress: () => true,
      onTimeout: () => undefined,
      isSuspended: () => suspended,
    })) {
      seen.push(v);
    }
    expect(seen).toEqual(["first", "second"]);
    // Control: the same silence WITHOUT suspension times out.
    async function* wedged() {
      yield "only";
      await sleep(60_000);
    }
    await expect(async () => {
      for await (const v of withInactivityWatchdog(wedged(), {
        timeoutMs: 50,
        countsAsProgress: () => true,
        onTimeout: () => undefined,
      })) {
        void v;
      }
    }).rejects.toThrow(HarnessInactivityTimeoutError);
  });
});

describe("FinalVerifier scope (INV-115 completeness)", () => {
  it("in-place single-candidate turns are EXEMPT: no final_verify attempted (their diff is against the live tree)", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([["impl", diffImplementer("impl", "local")]]),
      reviewers: reviewers(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "edit the live tree",
      mode: "agent",
      harnesses: ["impl"],
      inPlace: true,
      tests: [shellGate('node -e "process.exit(0)"')],
    });
    // The turn mutated the live tree; a fresh snapshot worktree would lack
    // gitignored deps — verification must NOT have been attempted.
    const decision = readFileSync(join(res.runDir, "arbitration", "decision.yaml"), "utf8");
    expect(decision).not.toMatch(/final_verify:\s*\n\s*attempted: true/);
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(true);
  });

  it("an ENVELOPE convergence patch passes through the verifier (final_verify recorded on the decision)", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([["a", diffImplementer("a", "local")]]),
      reviewers: reviewers(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "converge",
      mode: "agent",
      harnesses: ["a"],
      attempts: 2,
      tests: [shellGate('node -e "process.exit(0)"')],
    });
    expect(legacyOutcome(res)).toBe("success");
    const decision = readFileSync(join(res.runDir, "arbitration", "decision.yaml"), "utf8");
    expect(decision).toContain("final_verify:");
    expect(decision).toContain("attempted: true");
    expect(decision).toContain("applied_cleanly: true");
  });
});

describe("browser preflight truth (INV-066 / P1-09)", () => {
  function observeBrowserSpec(
    adapter: HarnessAdapter,
    observe: (browser: unknown) => void,
  ): HarnessAdapter {
    return {
      ...adapter,
      async *run(spec) {
        observe(spec.browser);
        yield* adapter.run(spec);
      },
    };
  }

  it("keeps mixed lanes participating and records requested/effective browser asymmetry", async () => {
    const repo = await initRepo();
    grantFullAccess(repo);
    const seen = new Map<string, unknown>();
    const capable = observeBrowserSpec(diffImplementer("capable", "local", true), (browser) =>
      seen.set("capable", browser),
    );
    const incapable = observeBrowserSpec(diffImplementer("incapable", "openai"), (browser) =>
      seen.set("incapable", browser),
    );
    const orch = new Orchestrator({
      registry: new Map([
        [capable.id, capable],
        [incapable.id, incapable],
      ]),
      reviewers: reviewers(),
    });

    const res = await orch.run({
      repoRoot: repo,
      prompt: "browse while implementing",
      mode: "agent",
      harnesses: ["capable", "incapable"],
      n: 2,
      access: "full",
      browser: true,
      tests: [shellGate("true")],
    });

    expect(legacyOutcome(res)).toBe("success");
    expect(seen.get("capable")).toMatchObject({ headless: false });
    expect(seen.get("incapable")).toBeNull();
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toMatch(/harness_id: capable[\s\S]*effective: true/);
    expect(telemetry).toMatch(
      /harness_id: incapable[\s\S]*effective: false[\s\S]*reason: manifest_unsupported/,
    );
  });

  it("refuses a zero-effective browser pool before invoking a harness", async () => {
    const repo = await initRepo();
    grantFullAccess(repo);
    let calls = 0;
    const incapable = observeBrowserSpec(diffImplementer("incapable", "local"), () => {
      calls += 1;
    });
    const orch = new Orchestrator({
      registry: new Map([[incapable.id, incapable]]),
      reviewers: reviewers(),
    });

    const res = await orch.run({
      repoRoot: repo,
      prompt: "browse",
      mode: "agent",
      harnesses: ["incapable"],
      n: 1,
      access: "full",
      browser: true,
    });

    expect(calls).toBe(0);
    expect(legacyOutcome(res)).toBe("failed");
    expect(res.summary).toMatch(/browser was requested.*manifest_unsupported/);
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(false);
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "browser was requested",
    );
  });
});

describe("stall rotation (pacing + coverage)", () => {
  it("prefers UNTRIED candidates even when a tried one has more pacing slack", async () => {
    const { pickStallRotationIdx } = await import("./runSupport.js");
    const ledger = {
      bindingPaceSlack: (id: string) => (id === "strong" ? 1 : 0.2),
      cooldownActive: () => false,
    };
    const pool = ["strong", "current", "fresh"];
    // "strong" was already tried since progress; "fresh" was not.
    expect(pickStallRotationIdx(pool, 1, ledger, new Set(["strong", "current"]))).toBe(2);
    // all tried -> falls back to best pacing slack among eligible.
    expect(pickStallRotationIdx(pool, 1, ledger, new Set(pool))).toBe(0);
    // total on degenerate pools: empty pool never NaN/undefined.
    expect(pickStallRotationIdx([], 0, ledger)).toBe(0);
    // every ALTERNATIVE cooling -> STAY on current (never hop onto a
    // known rate-limited harness just to rotate).
    const allCooling = { bindingPaceSlack: () => 1, cooldownActive: () => true };
    expect(pickStallRotationIdx(pool, 1, allCooling)).toBe(1);
    // equal pacing -> round-robin tiebreak: nearest clockwise neighbor.
    const flat = { bindingPaceSlack: () => 1, cooldownActive: () => false };
    expect(pickStallRotationIdx(pool, 1, flat)).toBe(2);
    expect(pickStallRotationIdx(pool, 2, flat)).toBe(0);
  });
});

describe("delegation belt injection (D32)", () => {
  it.each(["ask", "plan"] as const)("refuses Delegate directly for %s mode", async (mode) => {
    const repo = await initRepo();
    const orch = new Orchestrator({ registry: new Map(), reviewers: [] });
    await expect(orch.run({ repoRoot: repo, prompt: "x", mode, delegate: true })).rejects.toThrow(
      /agent-only strategy/,
    );
  });

  /** A writing adapter that DECLARES mcp_injection and records the last spec it
   * received, so implement and create paths can assert what the engine injected. */
  function delegatingAdapter(
    id: string,
    mcpInjection: boolean,
    observe?: (spec: { extra_mcp_servers?: unknown }) => void,
    requiresFullAccess = false,
    beltStatus?: string,
    usageCostUsd?: number,
    beltToolStatuses: Array<"ok" | "error"> = [],
    afterBeltToolResult?: () => void,
    writeCandidate?: (cwd: string, spec: HarnessRunSpec) => void,
    responseText = "Implemented.",
  ): HarnessAdapter {
    return {
      id,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: "anthropic",
          capabilities: { implement: true, create_from_scratch: true, browser_tool: true },
          capability_profile: {
            mcp_injection: mcpInjection,
            mcp_injection_requires_full_access: requiresFullAccess,
          },
          access_profiles_supported: ["workspace_write", "full"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          enabled_intents: ["implement", "create_from_scratch"],
        });
      },
      async *run(spec) {
        observe?.(spec as { extra_mcp_servers?: unknown });
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          ...(beltStatus
            ? { payload: { mcp_servers: [{ name: "claudexor", status: beltStatus }] } }
            : {}),
          ...(usageCostUsd
            ? {
                credential_route: "managed_api_key" as const,
                credential_source: "api_key_env" as const,
              }
            : {}),
        };
        for (const status of beltToolStatuses) {
          yield {
            type: "tool_call",
            session_id: spec.session_id,
            ts,
            tool: { name: "mcp__claudexor__claudexor_ask", kind: "mcp" },
          };
          yield {
            type: "tool_result",
            session_id: spec.session_id,
            ts,
            tool: {
              name: "mcp__claudexor__claudexor_ask",
              kind: "mcp",
              status,
              ...(status === "error" ? { error_summary: "delegated child failed" } : {}),
            },
          };
          afterBeltToolResult?.();
        }
        if (writeCandidate) writeCandidate(spec.cwd, spec);
        else writeFileSync(join(spec.cwd, "CHANGED.txt"), "change\n");
        yield { type: "message", session_id: spec.session_id, ts, text: responseText };
        if (usageCostUsd) {
          yield {
            type: "usage",
            session_id: spec.session_id,
            ts,
            credential_route: "managed_api_key",
            credential_source: "api_key_env",
            usage: { cost_usd: usageCostUsd },
          };
        }
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
  }

  const belt = {
    name: "claudexor",
    command: "/usr/bin/node",
    args: ["/cli", "mcp", "serve-belt"],
    env: { CLAUDEXOR_DELEGATION_DEPTH: "0" },
    required: true,
  };

  it.each([
    ["race", { mode: "agent" as const }],
    ["convergence", { mode: "agent" as const, attempts: 1 }],
    ["plan", { mode: "plan" as const }],
    ["ask/deep-scan report", { mode: "ask" as const }],
  ] as const)(
    "rejecting durable run.created keeps %s unannounced and releases startup ownership",
    async (strategy, strategyInput) => {
      const repo = await initRepo();
      const suffix = strategy.replace(/\W+/g, "-");
      const runId = `run-child-${suffix}`;
      const taskId = `task-child-${suffix}`;
      const parentRunId = `run-parent-${suffix}`;
      const admissionId = `job-child-${suffix}`;
      const authority = new DelegationBudgetAuthority();
      authority.registerParent(parentRunId, new BudgetLedger());
      authority.noteChildAccepted(parentRunId, admissionId);
      const runStarts: string[] = [];
      const published: string[] = [];
      const orch = new Orchestrator({
        registry: new Map(),
        reviewers: [],
        delegationBudgetAuthority: authority,
      });

      await expect(
        orch.run({
          repoRoot: repo,
          prompt: "x",
          ...strategyInput,
          runId,
          taskId,
          delegatedFromRunId: parentRunId,
          delegationAdmissionId: admissionId,
          onRunStart: ({ runId: startedRunId }) => runStarts.push(startedRunId),
          onEventPersist: (event) => {
            if (event.type === "run.created") throw new Error("event sink failed before announce");
          },
          onEvent: (event) => published.push(event.type),
        }),
      ).rejects.toThrow(/event sink failed before announce/);

      expect(runStarts).toEqual([]);
      expect(published).toEqual([]);
      const paths = new ArtifactStore(repo).runPaths(runId);
      expect(readRunEvents(paths.root).map((event) => event.type)).toEqual(["run.created"]);
      expect(() => new EventLog(paths.eventsPath, runId, taskId).dispose()).not.toThrow();
      authority.beginParentClose(parentRunId);
      await expect(authority.waitForChildren(parentRunId, 20)).resolves.toBeUndefined();
    },
  );

  it("terminalizes a preamble event failure after durable run.created exactly once", async () => {
    const repo = await initRepo();
    const head = (await runCapture("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    const runStarts: string[] = [];
    const published: string[] = [];
    const startupOrder: string[] = [];
    const result = await new Orchestrator({ registry: new Map(), reviewers: [] }).run({
      repoRoot: repo,
      prompt: "read",
      mode: "ask",
      runId: "run-post-created-preamble-failure",
      projectGitInitialization: {
        initialized: true,
        baselineCommitted: true,
        gitignoreSeeded: false,
        headSha: head,
      },
      onRunStart: ({ runId }) => {
        runStarts.push(runId);
        startupOrder.push("onRunStart");
      },
      onEventPersist: (event) => {
        startupOrder.push(`persist:${event.type}`);
        if (event.type === "project.git.initialized") {
          throw new Error("project initialization journal refused");
        }
      },
      onEvent: (event) => published.push(event.type),
    });

    expect(runStarts).toEqual(["run-post-created-preamble-failure"]);
    expect(startupOrder.slice(0, 3)).toEqual([
      "persist:run.created",
      "onRunStart",
      "persist:project.git.initialized",
    ]);
    expect(result.lifecycle).toBe("failed");
    const eventTypes = readRunEvents(result.runDir).map((event) => event.type);
    expect(eventTypes.slice(0, 2)).toEqual(["run.created", "project.git.initialized"]);
    expect(eventTypes.filter((type) => type === "run.failed")).toHaveLength(1);
    expect(eventTypes.filter((type) => type === "run.completed" || type === "run.blocked")).toEqual(
      [],
    );
    expect(published).toContain("run.created");
    expect(published).not.toContain("project.git.initialized");
    expect(published.filter((type) => type === "run.failed")).toHaveLength(1);
  });

  it("does not release an unrelated authority on a caller-supplied run-id collision", async () => {
    const repo = await initRepo();
    const authority = new DelegationBudgetAuthority();
    authority.registerParent("run-collision", new BudgetLedger());
    const orch = new Orchestrator({
      registry: new Map([["deleg", delegatingAdapter("deleg", true)]]),
      reviewers: [],
      delegationBudgetAuthority: authority,
    });

    await expect(
      orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["deleg"],
        attempts: 1,
        runId: "run-collision",
        onEventPersist: (event) => {
          if (event.type === "run.created") throw new Error("event sink failed before announce");
        },
      }),
    ).rejects.toThrow(/event sink failed before announce/);

    expect(authority.hasParent("run-collision")).toBe(true);
    authority.releaseRun("run-collision");
  });

  it("can retry the same run-id after delegated ledger preparation refuses pre-announce", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([["deleg", delegatingAdapter("deleg", true)]]),
      reviewers: [],
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const input = {
      repoRoot: repo,
      prompt: "x",
      mode: "agent" as const,
      harnesses: ["deleg"],
      attempts: 1,
      runId: "run-unadmitted-child",
      delegatedFromRunId: "run-missing-parent",
      delegationAdmissionId: "job-missing",
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(orch.run(input)).rejects.toMatchObject({
        code: "delegation_budget_parent_unavailable",
      });
    }
  });

  it("admits an estimated delegated child while the parent unknown-cost unit is live", async () => {
    const repo = await initRepo();
    const authority = new DelegationBudgetAuthority();
    const root = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const parentLease = root.reserve({
      taskId: "task-parent",
      attemptId: "parent-a01",
      intent: "implement",
      harnessId: "parent",
    });
    expect(parentLease.granted).toBe(true);
    authority.registerParent("run-parent", root);
    authority.noteChildAccepted("run-parent", "job-child");
    const orch = new Orchestrator({
      registry: new Map([
        ["deleg", delegatingAdapter("deleg", true, undefined, false, undefined, 0.2)],
      ]),
      reviewers: [],
      delegationBudgetAuthority: authority,
    });

    const result = await orch.run({
      repoRoot: repo,
      prompt: "child work",
      mode: "agent",
      harnesses: ["deleg"],
      runId: "run-child",
      delegatedFromRunId: "run-parent",
      delegationAdmissionId: "job-child",
      paidBudget: { kind: "finite", maxUsd: 1 },
    });

    expect(
      result.lifecycle,
      JSON.stringify({ facts: result.facts, summary: result.summary, runDir: result.runDir }),
    ).toBe("succeeded");
    expect(result.spendUsd).toBeCloseTo(0.2, 5);
    expect(root.spend()).toBeCloseTo(0.2, 5);
    root.cancel(parentLease.lease!.lease_id);
    authority.beginParentClose("run-parent");
    await expect(authority.waitForChildren("run-parent", 20)).resolves.toBeUndefined();
  });

  it("injects the belt descriptor into an agent lane whose adapter can host MCP servers, rebinding its budget to the RESOLVED cap", async () => {
    const repo = await initRepo();
    let injected: unknown;
    const orch = new Orchestrator({
      registry: new Map([
        ["deleg", delegatingAdapter("deleg", true, (s) => (injected = s.extra_mcp_servers))],
      ]),
      reviewers: [],
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    await orch.run({
      repoRoot: repo,
      prompt: "do the thing",
      mode: "agent",
      harnesses: ["deleg"],
      delegate: true,
      delegationBelt: belt,
      runId: "run-current-delegate",
      parentRunId: "run-prior-thread-turn",
    });
    // The engine rebinds the belt's parent-budget env to the resolved run
    // budget (default = unlimited here), preserving the descriptor's other env.
    const list = injected as Array<{ env: Record<string, string> }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.env.CLAUDEXOR_DELEGATION_DEPTH).toBe("0");
    // The belt parent is THIS Delegate run, never its ordinary thread ancestor.
    expect(list[0]!.env.CLAUDEXOR_DELEGATION_PARENT_RUN_ID).toBe("run-current-delegate");
    // Children are pinned to the original user project, never the executing
    // parent envelope and never a raw path proposed by the harness.
    expect(list[0]!.env.CLAUDEXOR_DELEGATION_REPO_ROOT).toBe(repo);
    expect(JSON.parse(list[0]!.env.CLAUDEXOR_DELEGATION_BUDGET)).toEqual({ kind: "unlimited" });
  });

  it("rebinds the belt budget to the configured global cap when the request supplied none (config-cap inheritance)", async () => {
    const repo = await initRepo();
    const configDir = reapMk(join(tmpdir(), "claudexor-orch-beltcfg-"));
    writeFileSync(
      join(configDir, "config.yaml"),
      "budget:\n  paid_budget_per_run:\n    kind: finite\n    maxUsd: 0.25\n",
    );
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      let injected: unknown;
      const orch = new Orchestrator({
        registry: new Map([
          ["deleg", delegatingAdapter("deleg", true, (s) => (injected = s.extra_mcp_servers))],
        ]),
        reviewers: [],
        delegationBudgetAuthority: new DelegationBudgetAuthority(),
      });
      await orch.run({
        repoRoot: repo,
        prompt: "do the thing",
        mode: "agent",
        harnesses: ["deleg"],
        delegate: true,
        // No paidBudget on the request: the belt must still inherit the
        // config-resolved finite cap, not fall back to unlimited.
        delegationBelt: belt,
      });
      const list = injected as Array<{ env: Record<string, string> }>;
      expect(JSON.parse(list[0]!.env.CLAUDEXOR_DELEGATION_BUDGET)).toEqual({
        kind: "finite",
        maxUsd: 0.25,
      });
    } finally {
      delete process.env.CLAUDEXOR_CONFIG_DIR;
    }
  });

  it("does NOT inject the belt when delegate is off", async () => {
    const repo = await initRepo();
    let injected: unknown;
    const orch = new Orchestrator({
      registry: new Map([
        ["deleg", delegatingAdapter("deleg", true, (s) => (injected = s.extra_mcp_servers))],
      ]),
      reviewers: [],
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    await orch.run({ repoRoot: repo, prompt: "x", mode: "agent", harnesses: ["deleg"] });
    expect(injected).toEqual([]);
  });

  it("degrades before start below full access and records a durable warning", async () => {
    const repo = await initRepo();
    let injected: unknown = "unset";
    const orch = new Orchestrator({
      registry: new Map([
        [
          "fullonly",
          delegatingAdapter("fullonly", true, (s) => (injected = s.extra_mcp_servers), true),
        ],
      ]),
      reviewers: [],
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["fullonly"],
      delegate: true,
      delegationBelt: belt,
      // default write access (workspace_write) — below full
    });
    expect(res.lifecycle).toBe("succeeded");
    expect(readFileSync(join(res.runDir, "events.jsonl"), "utf8")).toMatch(
      /delegation\.belt\.degraded.*access_profile_incompatible/,
    );
    expect(readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8")).toMatch(
      /reason: access_profile_incompatible/,
    );
    // The belt was never injected into a lane that would sandbox-cancel it.
    expect(injected).toEqual([]);
  });

  it("injects the belt on a full-access-requiring harness WHEN the lane runs at full access", async () => {
    const repo = await initRepo();
    grantFullAccess(repo);
    let injected: unknown;
    const orch = new Orchestrator({
      registry: new Map([
        [
          "fullonly",
          delegatingAdapter("fullonly", true, (s) => (injected = s.extra_mcp_servers), true),
        ],
      ]),
      reviewers: [],
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    await orch.run({
      repoRoot: repo,
      prompt: "do the thing",
      mode: "agent",
      harnesses: ["fullonly"],
      access: "full",
      delegate: true,
      delegationBelt: belt,
    });
    const list = injected as Array<{ name: string; env: Record<string, string> }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("claudexor");
    expect(JSON.parse(list[0]!.env.CLAUDEXOR_DELEGATION_BUDGET)).toEqual({ kind: "unlimited" });
  });

  it("degrades before start on a non-injecting harness with durable typed cause", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([["nocap", delegatingAdapter("nocap", false)]]),
      reviewers: [],
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["nocap"],
      delegate: true,
      delegationBelt: belt,
    });
    expect(res.lifecycle).toBe("succeeded");
    expect(readFileSync(join(res.runDir, "events.jsonl"), "utf8")).toMatch(
      /delegation\.belt\.degraded.*manifest_unsupported/,
    );
    expect(readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8")).toMatch(
      /reason: manifest_unsupported/,
    );
  });

  it("prioritizes an effective Delegate lane for a single candidate from a mixed pool", async () => {
    const repo = await initRepo();
    let incapableRuns = 0;
    let delegateRuns = 0;
    const orch = new Orchestrator({
      registry: new Map([
        ["nocap", delegatingAdapter("nocap", false, () => (incapableRuns += 1))],
        [
          "deleg",
          delegatingAdapter(
            "deleg",
            true,
            () => {
              delegateRuns += 1;
            },
            false,
            "connected",
          ),
        ],
      ]),
      reviewers: [],
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["nocap", "deleg"],
      n: 1,
      delegate: true,
      delegationBelt: belt,
    });
    expect(res.lifecycle).toBe("succeeded");
    expect(delegateRuns).toBe(1);
    expect(incapableRuns).toBe(0);
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toContain("reason: delegate_effective_first");
    expect(telemetry).toMatch(/order:\n\s+- deleg\n\s+- nocap/);
  });

  it("persists partially degraded truth after both mixed Delegate lanes actually run", async () => {
    const repo = await initRepo();
    let capableRuns = 0;
    let incapableRuns = 0;
    const orch = new Orchestrator({
      registry: new Map([
        ["nocap", delegatingAdapter("nocap", false, () => (incapableRuns += 1))],
        ["deleg", delegatingAdapter("deleg", true, () => (capableRuns += 1), false, "connected")],
      ]),
      reviewers: [],
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });

    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["nocap", "deleg"],
      n: 2,
      delegate: true,
      delegationBelt: belt,
    });

    expect({ capableRuns, incapableRuns }).toEqual({ capableRuns: 1, incapableRuns: 1 });
    const telemetry = new ArtifactStore(repo).readYaml<{
      delegation: { requested: boolean; effective: boolean; used: boolean; reason: string };
      request_requirements: Array<{
        capability: string;
        harness_id: string;
        requested: boolean;
        effective: boolean;
        reason: string;
      }>;
    }>(join(res.runDir, "final", "telemetry.yaml"));
    expect(telemetry?.delegation).toMatchObject({
      requested: true,
      effective: true,
      used: false,
      reason: "partially_degraded",
    });
    expect(
      telemetry?.request_requirements.find(
        (receipt) => receipt.capability === "delegation" && receipt.harness_id === "deleg",
      ),
    ).toMatchObject({ requested: true, effective: true, reason: "effective" });
    expect(
      telemetry?.request_requirements.find(
        (receipt) => receipt.capability === "delegation" && receipt.harness_id === "nocap",
      ),
    ).toMatchObject({ requested: true, effective: false, reason: "manifest_unsupported" });
  });

  it("starts convergence on an effective Delegate lane when a mixed pool also has an incapable lane", async () => {
    const repo = await initRepo();
    let incapableRuns = 0;
    let delegateRuns = 0;
    let injected: unknown;
    const orch = new Orchestrator({
      registry: new Map([
        ["nocap", delegatingAdapter("nocap", false, () => (incapableRuns += 1))],
        [
          "deleg",
          delegatingAdapter(
            "deleg",
            true,
            (spec) => {
              delegateRuns += 1;
              injected = spec.extra_mcp_servers;
            },
            false,
            "connected",
          ),
        ],
      ]),
      reviewers: reviewers(),
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["nocap", "deleg"],
      attempts: 1,
      delegate: true,
      delegationBelt: belt,
    });
    expect(delegateRuns).toBe(1);
    expect(incapableRuns).toBe(0);
    expect(
      (injected as Array<{ env: Record<string, string> }>)[0]!.env
        .CLAUDEXOR_DELEGATION_PARENT_RUN_ID,
    ).toBe(res.runId);
  });

  it("degrades before start when the installed runtime has no belt entry", async () => {
    const repo = await initRepo();
    let injected: unknown = "unset";
    const orch = new Orchestrator({
      registry: new Map([
        ["deleg", delegatingAdapter("deleg", true, (s) => (injected = s.extra_mcp_servers))],
      ]),
      reviewers: [],
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["deleg"],
      delegate: true,
      delegationBelt: null,
    });
    expect(res.lifecycle).toBe("succeeded");
    expect(injected).toEqual([]);
    expect(readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8")).toMatch(
      /reason: runtime_unavailable/,
    );
  });

  it("hard-fails when an injected belt reports startup failure", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([["deleg", delegatingAdapter("deleg", true, undefined, false, "failed")]]),
      reviewers: [],
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["deleg"],
      delegate: true,
      delegationBelt: belt,
    });
    expect(res.lifecycle).toBe("failed");
    expect(readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8")).toMatch(
      /reason: startup_failed/,
    );
  });

  it("hard-fails a delivered Agent on an unrecovered exact belt tool error", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([
        [
          "deleg",
          delegatingAdapter("deleg", true, undefined, false, "pending", undefined, ["error"]),
        ],
      ]),
      reviewers: [],
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["deleg"],
      delegate: true,
      delegationBelt: belt,
    });
    expect(res.lifecycle).toBe("failed");
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toMatch(/delegation:\n[\s\S]*used: true[\s\S]*reason: used/);
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).toContain("phase: delegation_runtime");
    expect(failure).toContain("category: harness_error");
    expect(failure).toContain("harnessId: deleg");
    expect(failure).toContain("attemptId: a01");
    expect(failure).toContain("rawDetailRef: attempts/a01/attempt.yaml");
    expect(failure).toContain("Delegate belt tool failed in deleg");
    expect(telemetry).toMatch(/outcome:\n[\s\S]*status: failed/);
    expect(readFileSync(join(res.runDir, "events.jsonl"), "utf8")).not.toContain(
      '"type":"review.started"',
    );
  });

  it("allows the same exact belt operation to recover before Agent finalization", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([
        [
          "deleg",
          delegatingAdapter("deleg", true, undefined, false, "pending", undefined, ["error", "ok"]),
        ],
      ]),
      reviewers: [],
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["deleg"],
      delegate: true,
      delegationBelt: belt,
    });
    expect(res.lifecycle).toBe("succeeded");
    const telemetry = readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8");
    expect(telemetry).toMatch(/delegation:\n[\s\S]*used: true[\s\S]*reason: used/);
    expect(telemetry).toMatch(/unrecovered_tool_errors: 0/);
  });

  it("hard-fails convergence before review after an unrecovered belt tool error", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([
        [
          "deleg",
          delegatingAdapter("deleg", true, undefined, false, "pending", undefined, ["error"]),
        ],
      ]),
      reviewers: reviewers(),
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["deleg"],
      attempts: 3,
      delegate: true,
      delegationBelt: belt,
    });
    expect(res.lifecycle).toBe("failed");
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).toContain("phase: delegation_runtime");
    expect(failure).toContain("category: harness_error");
    expect(failure).toContain("harnessId: deleg");
    expect(failure).toContain("attemptId: a01");
    expect(failure).toContain("rawDetailRef: attempts/a01/attempt.yaml");
    expect(res.summary).toContain("convergence cannot review, repair, or continue");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events.match(/"type":"harness.started"/g)).toHaveLength(1);
    expect(events).not.toContain('"type":"review.started"');
  });

  it.each([
    { lane: "Delegate race", delegate: true, attempts: undefined },
    { lane: "Delegate convergence", delegate: true, attempts: 2 },
    { lane: "ordinary Agent", delegate: false, attempts: undefined },
  ])(
    "quarantines a secret-bearing in-place diff for $lane without artifacts or Git objects",
    async ({ delegate, attempts }) => {
      const repo = await initRepo();
      const secret = `sk-${"a".repeat(24)}`;
      const adapter = delegatingAdapter(
        "deleg",
        true,
        undefined,
        false,
        delegate ? "pending" : undefined,
        undefined,
        delegate ? ["error"] : [],
        undefined,
        (cwd) => writeFileSync(join(cwd, "LEAK.txt"), `TOKEN=${secret}\n`),
      );
      const orch = new Orchestrator({
        registry: new Map([["deleg", adapter]]),
        reviewers: attempts ? reviewers() : [],
        delegationBudgetAuthority: new DelegationBudgetAuthority(),
      });
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["deleg"],
        inPlace: true,
        ...(attempts ? { attempts } : {}),
        ...(delegate ? { delegate: true, delegationBelt: belt } : {}),
      });

      expect(res.lifecycle).toBe("failed");
      expect(existsSync(join(repo, "LEAK.txt"))).toBe(false);
      expect(existsSync(join(res.runDir, "final", "patch.diff"))).toBe(false);
      expect(existsSync(join(res.runDir, "attempts", "a01", "patch.diff"))).toBe(false);
      const workProduct = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
      expect(workProduct).toContain("secret_diff_refused: true");
      expect(workProduct).toContain("secret_recovery: manual_cleanup");
      expect(workProduct).toContain("adopted: true");
      expect(workProduct).toContain("apply_state: applied_review_blocked");
      expect(workProduct).toContain("revert_anchor_id: null");
      const attempt = readFileSync(join(res.runDir, "attempts", "a01", "attempt.yaml"), "utf8");
      expect(attempt).toContain("secret_diff_refusal:");
      if (delegate) {
        expect(attempt).toMatch(/delegation_belt:\n[\s\S]*tool_evidence: true/);
        expect(attempt).toContain("unrecovered_tool_errors: 1");
        expect(readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8")).toMatch(
          /delegation:\n[\s\S]*used: true/,
        );
      }
      const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
      expect(events).toContain('"type":"work_product.emitted"');
      expect(events.indexOf('"type":"work_product.emitted"')).toBeLessThan(
        events.indexOf('"type":"run.failed"'),
      );
      expect(treeContainsBytes(res.runDir, secret)).toBe(false);
      expect(gitObjectStoreContains(repo, secret)).toBe(false);
      const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
      expect(failure).toContain(
        delegate ? "phase: delegation_runtime" : "phase: artifact_security",
      );
    },
  );

  it.each([false, true])(
    "quarantines a binary secret-bearing Agent diff (inPlace=%s)",
    async (inPlace) => {
      const repo = await initRepo();
      const secret = `sk-${"b".repeat(24)}`;
      const adapter = delegatingAdapter(
        "deleg",
        true,
        undefined,
        false,
        undefined,
        undefined,
        [],
        undefined,
        (cwd) =>
          writeFileSync(
            join(cwd, "LEAK.bin"),
            Buffer.concat([Buffer.from([0]), Buffer.from(secret), Buffer.from([0])]),
          ),
      );
      const orch = new Orchestrator({
        registry: new Map([["deleg", adapter]]),
        reviewers: [],
      });
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["deleg"],
        inPlace,
      });

      expect(res.lifecycle).toBe("failed");
      expect(existsSync(join(repo, "LEAK.bin"))).toBe(false);
      expect(existsSync(join(res.runDir, "final", "patch.diff"))).toBe(false);
      expect(existsSync(join(res.runDir, "attempts", "a01", "patch.diff"))).toBe(false);
      expect(treeContainsBytes(res.runDir, secret)).toBe(false);
      expect(gitObjectStoreContains(repo, secret)).toBe(false);
      expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain(
        "phase: artifact_security",
      );
      expect(existsSync(join(res.runDir, "final", "work_product.yaml"))).toBe(inPlace);
    },
  );

  it("reports manual cleanup when an in-place Delegate stages secret bytes", async () => {
    const repo = await initRepo();
    const secret = `sk-${"e".repeat(24)}`;
    const adapter = delegatingAdapter(
      "deleg",
      true,
      undefined,
      false,
      "pending",
      undefined,
      ["error"],
      undefined,
      (cwd) => {
        writeFileSync(join(cwd, "LEAK.txt"), `${secret}\n`);
        execFileSync("git", ["-C", cwd, "add", "LEAK.txt"]);
      },
    );
    const orch = new Orchestrator({
      registry: new Map([["deleg", adapter]]),
      reviewers: [],
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["deleg"],
      inPlace: true,
      delegate: true,
      delegationBelt: belt,
    });

    expect(res.lifecycle).toBe("failed");
    expect(existsSync(join(repo, "LEAK.txt"))).toBe(false);
    expect(execFileSync("git", ["-C", repo, "show", ":LEAK.txt"]).toString()).toContain(secret);
    const workProduct = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
    expect(workProduct).toContain("secret_recovery: manual_cleanup");
    expect(workProduct).toContain("apply_state: applied_review_blocked");
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).toContain("Inspect and clean the state named in the recovery receipt");
    expect(treeContainsBytes(res.runDir, secret)).toBe(false);
  });

  it("exactly reverts a secret-bearing non-Git in-place convergence attempt", async () => {
    const repo = reapMk(join(tmpdir(), "claudexor-secret-nongit-"));
    writeFileSync(join(repo, "README.md"), "# test\n");
    const secret = `sk-${"g".repeat(24)}`;
    const adapter = delegatingAdapter(
      "deleg",
      true,
      undefined,
      false,
      undefined,
      undefined,
      [],
      undefined,
      (cwd) => writeFileSync(join(cwd, "LEAK.txt"), `${secret}\n`),
    );
    const orch = new Orchestrator({
      registry: new Map([["deleg", adapter]]),
      reviewers: reviewers(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["deleg"],
      attempts: 2,
      inPlace: true,
    });

    expect(res.lifecycle).toBe("failed");
    expect(existsSync(join(repo, "LEAK.txt"))).toBe(false);
    expect(existsSync(join(repo, ".git"))).toBe(false);
    expect(readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8")).toContain(
      "secret_recovery: reverted",
    );
    expect(treeContainsBytes(res.runDir, secret)).toBe(false);
  });

  it("refuses a secret-bearing non-Git binary output without persisting it", async () => {
    const repo = reapMk(join(tmpdir(), "claudexor-secret-nongit-binary-"));
    writeFileSync(join(repo, "README.md"), "# test\n");
    const secret = `sk-${"i".repeat(24)}`;
    const adapter = delegatingAdapter(
      "deleg",
      true,
      undefined,
      false,
      undefined,
      undefined,
      [],
      undefined,
      (cwd) =>
        writeFileSync(
          join(cwd, "LEAK.bin"),
          Buffer.concat([Buffer.from([0]), Buffer.from(secret), Buffer.from([0])]),
        ),
    );
    const orch = new Orchestrator({
      registry: new Map([["deleg", adapter]]),
      reviewers: reviewers(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["deleg"],
      attempts: 2,
      inPlace: true,
    });

    expect(res.lifecycle).toBe("failed");
    expect(existsSync(join(repo, "LEAK.bin"))).toBe(true);
    expect(existsSync(join(res.runDir, "final", "patch.diff"))).toBe(false);
    expect(existsSync(join(res.runDir, "attempts", "a01", "patch.diff"))).toBe(false);
    expect(readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8")).toContain(
      "secret_recovery: manual_cleanup",
    );
    expect(treeContainsBytes(res.runDir, secret)).toBe(false);
  });

  it("fails closed when non-Git binary output is unreadable during capture", async () => {
    const repo = reapMk(join(tmpdir(), "claudexor-secret-nongit-unreadable-"));
    writeFileSync(join(repo, "README.md"), "# test\n");
    const secret = `sk-${"j".repeat(24)}`;
    const adapter = delegatingAdapter(
      "deleg",
      true,
      undefined,
      false,
      undefined,
      undefined,
      [],
      undefined,
      (cwd) => {
        const leak = join(cwd, "LEAK.bin");
        writeFileSync(leak, Buffer.concat([Buffer.from([0]), Buffer.from(secret)]));
        chmodSync(leak, 0o000);
      },
    );
    const orch = new Orchestrator({
      registry: new Map([["deleg", adapter]]),
      reviewers: reviewers(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["deleg"],
      attempts: 2,
      inPlace: true,
    });

    expect(res.lifecycle).toBe("failed");
    expect(existsSync(join(res.runDir, "final", "patch.diff"))).toBe(false);
    expect(existsSync(join(res.runDir, "attempts", "a01", "patch.diff"))).toBe(false);
    expect(readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8")).toContain(
      "secret_recovery: manual_cleanup",
    );
    expect(treeContainsBytes(res.runDir, secret)).toBe(false);
    chmodSync(join(repo, "LEAK.bin"), 0o600);
  });

  it.each(["replace", "delete"] as const)(
    "refuses a binary patch whose $case reverse payload contains a secret",
    async (operation) => {
      const repo = await initRepo();
      const secret = `sk-${"c".repeat(24)}`;
      const path = join(repo, "BASE.bin");
      writeFileSync(path, Buffer.concat([Buffer.from([0]), Buffer.from(secret)]));
      execFileSync("git", ["-C", repo, "add", "BASE.bin"]);
      execFileSync("git", [
        "-C",
        repo,
        "-c",
        "user.email=t@t.dev",
        "-c",
        "user.name=Test",
        "commit",
        "-m",
        "binary base",
      ]);
      const adapter = delegatingAdapter(
        "deleg",
        true,
        undefined,
        false,
        undefined,
        undefined,
        [],
        undefined,
        (cwd) => {
          const candidate = join(cwd, "BASE.bin");
          if (operation === "delete") unlinkSync(candidate);
          else writeFileSync(candidate, Buffer.from([0, 1, 2, 3]));
        },
      );
      const orch = new Orchestrator({ registry: new Map([["deleg", adapter]]), reviewers: [] });
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["deleg"],
      });

      expect(res.lifecycle).toBe("failed");
      expect(existsSync(join(res.runDir, "final", "patch.diff"))).toBe(false);
      expect(existsSync(join(res.runDir, "attempts", "a01", "patch.diff"))).toBe(false);
      expect(treeContainsBytes(res.runDir, secret)).toBe(false);
    },
  );

  it.each(["owned artifact", "ignored markdown link"] as const)(
    "refuses secret-bearing raster output from an $source",
    async (source) => {
      const repo = await initRepo();
      grantFullAccess(repo);
      if (source === "ignored markdown link") {
        writeFileSync(join(repo, ".gitignore"), "preview.png\n");
        execFileSync("git", ["-C", repo, "add", ".gitignore"]);
        execFileSync("git", [
          "-C",
          repo,
          "-c",
          "user.email=t@t.dev",
          "-c",
          "user.name=Test",
          "commit",
          "-m",
          "ignore preview",
        ]);
      }
      const secret = `sk-${"h".repeat(24)}`;
      const adapter = delegatingAdapter(
        "deleg",
        true,
        undefined,
        false,
        undefined,
        undefined,
        [],
        undefined,
        (cwd, spec) => {
          const ownedRoot = spec.browser?.output_dir;
          if (source === "owned artifact" && !ownedRoot) throw new Error("missing browser output");
          const path =
            source === "owned artifact" ? join(ownedRoot!, "shot.png") : join(cwd, "preview.png");
          mkdirSync(join(path, ".."), { recursive: true });
          writeFileSync(path, Buffer.concat([Buffer.from([0]), Buffer.from(secret)]));
          if (ownedRoot) {
            const clean = join(ownedRoot, "clean.png");
            mkdirSync(join(clean, ".."), { recursive: true });
            writeFileSync(clean, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
          }
        },
        source === "ignored markdown link" ? "![preview](preview.png)" : "Implemented.",
      );
      const orch = new Orchestrator({ registry: new Map([["deleg", adapter]]), reviewers: [] });
      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["deleg"],
        access: "full",
        browser: true,
      });

      expect(res.lifecycle).toBe("failed");
      expect(treeContainsBytes(res.runDir, secret)).toBe(false);
      expect(existsSync(join(res.runDir, "final", "patch.diff"))).toBe(false);
      expect(existsSync(join(res.runDir, "attempts", "a01", "patch.diff"))).toBe(false);
      expect(existsSync(join(res.runDir, "attempts", "a01", "produced"))).toBe(false);
    },
  );

  it("turns an unreadable raster into a sanitized artifact-security refusal", async () => {
    const repo = await initRepo();
    writeFileSync(join(repo, ".gitignore"), "unreadable.png\n");
    execFileSync("git", ["-C", repo, "add", ".gitignore"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=Test",
      "commit",
      "-m",
      "ignore unreadable preview",
    ]);
    const adapter = delegatingAdapter(
      "deleg",
      true,
      undefined,
      false,
      undefined,
      undefined,
      [],
      undefined,
      (cwd) => {
        const path = join(cwd, "unreadable.png");
        writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        chmodSync(path, 0o000);
      },
      "![preview](unreadable.png)",
    );
    const orch = new Orchestrator({ registry: new Map([["deleg", adapter]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["deleg"],
    });

    expect(res.lifecycle).toBe("failed");
    expect(readFileSync(join(res.runDir, "attempts", "a01", "attempt.yaml"), "utf8")).toContain(
      "secret_diff_refusal:",
    );
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "phase: artifact_security",
    );
    expect(existsSync(join(res.runDir, "attempts", "a01", "produced"))).toBe(false);
  });

  it.each(["oversized", "unreadable"] as const)(
    "emits a truthful manual-cleanup receipt for an $state in-place raster",
    async (state) => {
      const repo = reapMk(join(tmpdir(), `claudexor-raster-${state}-`));
      writeFileSync(join(repo, "README.md"), "# test\n");
      grantFullAccess(repo);
      let raster: string | null = null;
      const adapter = delegatingAdapter(
        "raster",
        true,
        undefined,
        false,
        undefined,
        undefined,
        [],
        undefined,
        (_cwd, spec) => {
          if (!spec.browser?.output_dir) throw new Error("missing browser output");
          const output = join(spec.browser.output_dir, "preview.png");
          raster = output;
          mkdirSync(join(output, ".."), { recursive: true });
          writeFileSync(
            output,
            state === "oversized"
              ? Buffer.alloc(16 * 1024 * 1024 + 1)
              : Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          );
          if (state === "unreadable") chmodSync(output, 0o000);
        },
      );
      const orch = new Orchestrator({
        registry: new Map([["raster", adapter]]),
        reviewers: reviewers(),
      });

      const res = await orch.run({
        repoRoot: repo,
        prompt: "x",
        mode: "agent",
        harnesses: ["raster"],
        attempts: 2,
        inPlace: true,
        access: "full",
        browser: true,
      });

      expect(res.lifecycle).toBe("failed");
      expect(existsSync(join(res.runDir, "final", "patch.diff"))).toBe(false);
      const workProduct = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
      expect(workProduct).toContain("secret_recovery: manual_cleanup");
      expect(workProduct.replace(/\s+/g, " ")).toContain(
        "could not be proven secret-safe or captured as an exact reversible patch",
      );
      expect(workProduct).not.toContain("later user edits");
      const refusalSurface = [
        res.summary,
        readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8"),
        readFileSync(join(res.runDir, "attempts", "a01", "attempt.yaml"), "utf8"),
      ].join("\n");
      expect(refusalSurface).toContain("could not be proven secret-safe");
      expect(refusalSurface).not.toContain("contains secret-like token");
      if (state === "unreadable" && raster && existsSync(raster)) chmodSync(raster, 0o600);
    },
  );

  it("excludes a discarded secret candidate so its clean best-of sibling can win", async () => {
    const repo = await initRepo();
    const secret = `sk-${"q".repeat(24)}`;
    const leaky = delegatingAdapter(
      "leaky",
      true,
      undefined,
      false,
      undefined,
      undefined,
      [],
      undefined,
      (cwd) => writeFileSync(join(cwd, "LEAK.txt"), `${secret}\n`),
    );
    const clean = delegatingAdapter(
      "clean",
      true,
      undefined,
      false,
      undefined,
      undefined,
      [],
      undefined,
      (cwd) => writeFileSync(join(cwd, "CLEAN.txt"), "clean candidate\n"),
    );
    const orch = new Orchestrator({
      registry: new Map([
        ["leaky", leaky],
        ["clean", clean],
      ]),
      reviewers: reviewers(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["leaky", "clean"],
      n: 2,
    });

    expect(res.lifecycle).toBe("succeeded");
    expect(res.candidates.find((candidate) => candidate.attemptId === res.winner)?.harnessId).toBe(
      "clean",
    );
    expect(readFileSync(join(res.runDir, "final", "patch.diff"), "utf8")).toContain("CLEAN.txt");
    expect(treeContainsBytes(res.runDir, secret)).toBe(false);
  });

  it("keeps an all-secret best-of race as an artifact-security hard failure", async () => {
    const repo = await initRepo();
    const secret = `sk-${"s".repeat(24)}`;
    const leaky = (id: string) =>
      delegatingAdapter(id, true, undefined, false, undefined, undefined, [], undefined, (cwd) =>
        writeFileSync(join(cwd, `${id}.txt`), `${secret}\n`),
      );
    const orch = new Orchestrator({
      registry: new Map([
        ["leaky-a", leaky("leaky-a")],
        ["leaky-b", leaky("leaky-b")],
      ]),
      reviewers: reviewers(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["leaky-a", "leaky-b"],
      n: 2,
    });

    expect(res.lifecycle).toBe("failed");
    expect(res.winner).toBeNull();
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "phase: artifact_security",
    );
    expect(treeContainsBytes(res.runDir, secret)).toBe(false);
  });

  it("keeps harness commits inside the disposable candidate clone", async () => {
    const repo = await initRepo();
    const secret = `sk-${"d".repeat(24)}`;
    const adapter = delegatingAdapter(
      "deleg",
      true,
      undefined,
      false,
      undefined,
      undefined,
      [],
      undefined,
      (cwd) => {
        expect(execFileSync("git", ["-C", cwd, "remote"]).toString()).toBe("");
        writeFileSync(join(cwd, "LEAK.txt"), `${secret}\n`);
        execFileSync("git", ["-C", cwd, "add", "LEAK.txt"]);
        execFileSync("git", [
          "-C",
          cwd,
          "-c",
          "user.email=t@t.dev",
          "-c",
          "user.name=Test",
          "commit",
          "-m",
          "candidate",
        ]);
      },
    );
    const orch = new Orchestrator({ registry: new Map([["deleg", adapter]]), reviewers: [] });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["deleg"],
    });

    expect(res.lifecycle).toBe("failed");
    expect(gitObjectStoreContains(repo, secret)).toBe(false);
    expect(treeContainsBytes(res.runDir, secret)).toBe(false);
  });

  it("keeps a failed in-place Delegate race honestly applied and revertable", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([
        [
          "deleg",
          delegatingAdapter("deleg", true, undefined, false, "pending", undefined, ["error"]),
        ],
      ]),
      reviewers: [],
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["deleg"],
      inPlace: true,
      create: true,
      delegate: true,
      delegationBelt: belt,
    });
    expect(res.lifecycle).toBe("failed");
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(true);
    const wp = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
    expect(wp).toContain("kind: new_repo");
    expect(wp).toContain("adopted: true");
    expect(wp).toContain("apply_state: applied_review_blocked");
    expect(wp).toMatch(/pre_turn_sha: ['"]?[0-9a-f]{6,}/);
    expect(wp).toMatch(/post_turn_sha: ['"]?[0-9a-f]{6,}/);
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events.indexOf('"type":"work_product.emitted"')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('"type":"work_product.emitted"')).toBeLessThan(
      events.indexOf('"type":"run.failed"'),
    );
    const anchorId = wp.match(/revert_anchor_id:\s+['"]?(sha256:[0-9a-f]{64})/)?.[1];
    expect(anchorId).toBeDefined();
    const { revertInPlaceFromAnchor } = await import("@claudexor/delivery");
    expect(await revertInPlaceFromAnchor(repo, anchorId!)).toMatchObject({ reverted: true });
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(false);
  });

  it("keeps a failed in-place Delegate convergence honestly applied and revertable", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([
        [
          "deleg",
          delegatingAdapter("deleg", true, undefined, false, "pending", undefined, ["error"]),
        ],
      ]),
      reviewers: reviewers(),
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["deleg"],
      attempts: 3,
      inPlace: true,
      delegate: true,
      delegationBelt: belt,
    });
    expect(res.lifecycle).toBe("failed");
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(true);
    const wp = readFileSync(join(res.runDir, "final", "work_product.yaml"), "utf8");
    expect(wp).toContain("adopted: true");
    expect(wp).toContain("apply_state: applied_review_blocked");
    expect(wp).toContain("attempts: 1");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events.indexOf('"type":"work_product.emitted"')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('"type":"work_product.emitted"')).toBeLessThan(
      events.indexOf('"type":"run.failed"'),
    );
    const anchorId = wp.match(/revert_anchor_id:\s+['"]?(sha256:[0-9a-f]{64})/)?.[1];
    expect(anchorId).toBeDefined();
    const { revertInPlaceFromAnchor } = await import("@claudexor/delivery");
    expect(await revertInPlaceFromAnchor(repo, anchorId!)).toMatchObject({ reverted: true });
    expect(existsSync(join(repo, "CHANGED.txt"))).toBe(false);
  });

  it("lets cancellation win when it arrives while a belt failure is finalizing", async () => {
    const repo = await initRepo();
    const abort = new AbortController();
    const orch = new Orchestrator({
      registry: new Map([
        [
          "deleg",
          delegatingAdapter("deleg", true, undefined, false, "pending", undefined, ["error"], () =>
            abort.abort("wall_clock_exceeded"),
          ),
        ],
      ]),
      reviewers: reviewers(),
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["deleg"],
      attempts: 3,
      delegate: true,
      delegationBelt: belt,
      signal: abort.signal,
    });
    expect(res.lifecycle).toBe("cancelled");
    expect(res.facts.reason).toBe("wall_clock_exceeded");
    expect(readFileSync(join(res.runDir, "events.jsonl"), "utf8")).not.toContain(
      '"phase":"delegation_runtime"',
    );
  });

  it("lets an unrecovered belt tool failure dominate a healthy mixed-race sibling", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([
        [
          "failed",
          delegatingAdapter("failed", true, undefined, false, "pending", undefined, ["error"]),
        ],
        ["healthy", delegatingAdapter("healthy", true, undefined, false, "connected")],
      ]),
      reviewers: [],
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["failed", "healthy"],
      n: 2,
      delegate: true,
      delegationBelt: belt,
    });
    expect(res.lifecycle).toBe("failed");
    expect(res.winner).toBeNull();
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "phase: delegation_runtime",
    );
  });

  it("lets an unrecovered belt failure dominate a discarded secret sibling", async () => {
    const repo = await initRepo();
    const secret = `sk-${"t".repeat(24)}`;
    const orch = new Orchestrator({
      registry: new Map([
        [
          "failed",
          delegatingAdapter("failed", true, undefined, false, "pending", undefined, ["error"]),
        ],
        [
          "leaky",
          delegatingAdapter(
            "leaky",
            true,
            undefined,
            false,
            "connected",
            undefined,
            [],
            undefined,
            (cwd) => writeFileSync(join(cwd, "LEAK.txt"), `${secret}\n`),
          ),
        ],
      ]),
      reviewers: [],
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["failed", "leaky"],
      n: 2,
      delegate: true,
      delegationBelt: belt,
    });

    expect(res.lifecycle).toBe("failed");
    expect(readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "phase: delegation_runtime",
    );
    expect(treeContainsBytes(res.runDir, secret)).toBe(false);
  });

  it("lets any injected belt startup failure dominate a mixed race", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([
        ["failed", delegatingAdapter("failed", true, undefined, false, "failed")],
        ["ready", delegatingAdapter("ready", true, undefined, false, "connected")],
      ]),
      reviewers: [],
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["failed", "ready"],
      n: 2,
      delegate: true,
      delegationBelt: belt,
    });
    expect(res.lifecycle).toBe("failed");
    expect(res.winner).toBeNull();
    expect(readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8")).toMatch(
      /reason: startup_failed/,
    );
  });

  it("hard-fails convergence immediately when an injected belt fails startup", async () => {
    const repo = await initRepo();
    const orch = new Orchestrator({
      registry: new Map([["deleg", delegatingAdapter("deleg", true, undefined, false, "failed")]]),
      reviewers: reviewers(),
      delegationBudgetAuthority: new DelegationBudgetAuthority(),
    });
    const res = await orch.run({
      repoRoot: repo,
      prompt: "x",
      mode: "agent",
      harnesses: ["deleg"],
      attempts: 3,
      delegate: true,
      delegationBelt: belt,
    });
    expect(res.lifecycle).toBe("failed");
    expect(readFileSync(join(res.runDir, "final", "telemetry.yaml"), "utf8")).toMatch(
      /reason: startup_failed/,
    );
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events.match(/"type":"harness.started"/g)).toHaveLength(1);
    expect(events).not.toContain('"type":"review.started"');
  });
});

describe("frozen-plan brief delivery (withPlanBrief, INV-081)", () => {
  type PlanBriefInput = {
    prompt: string;
    planRef?: { runId: string; sha256: string; path: string };
  };
  function planBriefFixture() {
    const dir = reapMk(join(tmpdir(), "claudexor-planbrief-"));
    const store = new ArtifactStore(join(dir, "repo"), { claudexorDir: join(dir, "claudexor") });
    const paths = store.createRun("run-planbrief");
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const apply = (input: PlanBriefInput): PlanBriefInput =>
      withPlanBrief(input, store, paths, {
        emit: (type: string, payload: Record<string, unknown>) => events.push({ type, payload }),
      });
    return { dir, paths, events, apply };
  }

  it("[INV-081:plan-brief-materialized] verifies the frozen hash and materializes context/PLAN.md in the run artifact tree", () => {
    const { dir, paths, events, apply } = planBriefFixture();
    const planText = "# Plan\n\n1. do the thing\n";
    const planPath = join(dir, "final-plan.md");
    writeFileSync(planPath, planText);
    const digest = sha256(planText).replace(/^sha256:/, "");
    const out = apply({
      prompt: "implement it",
      planRef: { runId: "run-plan", sha256: digest, path: planPath },
    });
    const briefPath = join(paths.contextDir, "PLAN.md");
    // The brief lands OUTSIDE every worktree (the run artifact tree), and the
    // prompt points at that absolute path — the plan is a file, never
    // re-embedded prose.
    expect(readFileSync(briefPath, "utf8")).toBe(planText);
    expect(out.prompt).toContain("implement it");
    expect(out.prompt).toContain(`The approved plan is at: ${briefPath}`);
    expect(events).toEqual([
      {
        type: "plan.brief.materialized",
        payload: { plan_run_id: "run-plan", sha256: digest, path: "context/PLAN.md" },
      },
    ]);
  });

  it("[INV-081:plan-missing] a missing or unreadable frozen plan fails LOUDLY before any harness spawns", () => {
    const { dir, paths, events, apply } = planBriefFixture();
    const gone = join(dir, "no-such-plan.md");
    expect(() =>
      apply({
        prompt: "implement it",
        planRef: { runId: "run-plan", sha256: "c".repeat(64), path: gone },
      }),
    ).toThrow(`implement plan: the frozen plan at ${gone} is missing or unreadable`);
    expect(existsSync(join(paths.contextDir, "PLAN.md"))).toBe(false);
    expect(events).toEqual([]);
  });

  it("[INV-081:plan-hash-mismatch] a plan modified after freeze is a loud tamper failure, never a silent run", () => {
    const { dir, paths, events, apply } = planBriefFixture();
    const planPath = join(dir, "final-plan.md");
    writeFileSync(planPath, "# Plan (original)\n");
    const frozen = sha256(readFileSync(planPath, "utf8")).replace(/^sha256:/, "");
    writeFileSync(planPath, "# Plan (tampered after freeze)\n");
    expect(() =>
      apply({
        prompt: "implement it",
        planRef: { runId: "run-plan", sha256: frozen, path: planPath },
      }),
    ).toThrow(/plan hash mismatch .*the plan was modified after freeze/);
    expect(existsSync(join(paths.contextDir, "PLAN.md"))).toBe(false);
    expect(events).toEqual([]);
  });

  it("input without a planRef passes through untouched (one-shot runs carry no plan brief)", () => {
    const { paths, events, apply } = planBriefFixture();
    const input = { prompt: "just do it" };
    expect(apply(input)).toBe(input);
    expect(existsSync(join(paths.contextDir, "PLAN.md"))).toBe(false);
    expect(events).toEqual([]);
  });

  it.each([
    ["race", false],
    ["convergence", true],
  ] as const)(
    "a quota snapshot preflight failure leaves no announced/orphaned %s plan run",
    async (_strategy, untilClean) => {
      const repo = await initRepo();
      const planPath = join(repo, "approved-plan.md");
      const planText = "# Approved plan\n\n1. implement safely\n";
      writeFileSync(planPath, planText);
      const runId = `run-quota-preflight-${untilClean ? "convergence" : "race"}`;
      let announced: { runId: string } | null = null;
      const orch = new Orchestrator({
        registry: new Map(),
        quotaSnapshots: () => {
          throw new Error("quota snapshot boom");
        },
      });

      await expect(
        orch.run({
          repoRoot: repo,
          prompt: "implement the approved plan",
          mode: "agent",
          runId,
          untilClean,
          planRef: {
            runId: "run-approved-plan",
            path: planPath,
            sha256: sha256(planText).replace(/^sha256:/, ""),
          },
          onRunStart: (info) => {
            announced = info;
          },
        }),
      ).rejects.toThrow("quota snapshot boom");

      expect(announced).toBeNull();
      expect(existsSync(new ArtifactStore(repo).runPaths(runId).root)).toBe(false);
    },
  );
});
