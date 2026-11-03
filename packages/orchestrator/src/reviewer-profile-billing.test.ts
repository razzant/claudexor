/** Regression for ordinary review panels sharing a Delegate family budget.
 * Exact-profile vendor evidence enters through the production panel resolver;
 * an unvisited sibling must not invent an unknown-cost in-flight unit. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BudgetLedger } from "@claudexor/budget";
import type { HarnessAdapter } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import type { ReviewerSpec } from "@claudexor/review";
import { ConformanceReport, HarnessManifest, type CredentialProfile } from "@claudexor/schema";
import { DelegationBudgetAuthority } from "./delegationBudgetAuthority.js";
import { Orchestrator, type RunInput } from "./orchestrator.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-panel-family-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  execFileSync("git", ["-C", dir, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "base",
  ]);
  return dir;
}

function author(): HarnessAdapter {
  const fake = createFakeHarness("fake-implement");
  return {
    ...fake,
    id: "author",
    async discover() {
      const manifest = await fake.discover();
      return HarnessManifest.parse({
        ...manifest,
        id: "author",
        kind: "local_cli",
        capabilities: { ...manifest.capabilities, review: false, synthesize: false },
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "author",
        status: "ok",
        enabled_intents: ["implement", "repair"],
      });
    },
    async *run(spec) {
      const common = {
        session_id: spec.session_id,
        ts: new Date().toISOString(),
        credential_route: "managed_api_key" as const,
      };
      yield { ...common, type: "started" };
      writeFileSync(join(spec.cwd, "change.txt"), "change from author\n");
      // An exact cash receipt keeps the candidate lease itself fully priced.
      yield {
        ...common,
        type: "usage",
        usage: { cost_usd: 0.01, cost_basis: { kind: "cash", source: "fixture.debit" } },
      };
      yield { ...common, type: "message", text: "Changed the fixture." };
      yield { ...common, type: "completed" };
    },
  };
}

function reviewer(
  id: string,
  providerFamily: "openai" | "anthropic",
  evidence: "vendor" | "api",
): { spec: ReviewerSpec; calls: () => number; probes: string[] } {
  let calls = 0;
  const probes: string[] = [];
  const adapter: HarnessAdapter = {
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
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["review"] });
    },
    async probeCredentialProfile(profile) {
      probes.push(profile.profile_id);
      return {
        profile_id: profile.profile_id,
        harness_id: id,
        availability: "available",
        verification: "passed",
        verification_source: evidence === "vendor" ? "vendor" : "local_store",
        last_verified_at: new Date().toISOString(),
      };
    },
    async *run(spec) {
      calls++;
      const ts = new Date().toISOString();
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        observed_model: `${id}-model`,
        credential_route: evidence === "api" ? "managed_api_key" : "vendor_native",
        // fixture fidelity: the harness reports the account it ran under
        ...(spec.credential_profile
          ? { credential_profile_id: spec.credential_profile.profile_id }
          : {}),
      };
      yield { type: "message", session_id: spec.session_id, ts, text: "```json\n[]\n```" };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
  const profileDir = mkdtempSync(join(tmpdir(), `reviewer-panel-profile-${id}-`));
  dirs.push(profileDir);
  const credentialProfile: CredentialProfile = {
    profile_id: `${id}-account`,
    harness_id: id,
    display_name: `${id}-account`,
    credential_kind: evidence === "api" ? "api_key" : "config_dir_login",
    isolation_locator: evidence === "api" ? null : profileDir,
    secret_ref:
      evidence === "api" ? `${id === "codex" ? "openai" : "anthropic"}:${id}-account` : null,
    enabled: true,
    created_at: null,
  };
  return {
    spec: {
      adapter,
      providerFamily,
      credentialProfile,
      profilePinned: true,
    } as ReviewerSpec,
    calls: () => calls,
    probes,
  };
}

async function childRun(evidence: ReadonlyArray<"vendor" | "api">) {
  const root = repo();
  const configDir = mkdtempSync(join(tmpdir(), "reviewer-panel-family-cfg-"));
  dirs.push(configDir);
  const previous = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  try {
    const authority = new DelegationBudgetAuthority({ cancelAdmission: () => {} });
    // The parent already reserved an unknown-cost unit in the finite family budget.
    const parentLedger = new BudgetLedger({ kind: "finite", maxUsd: 2 });
    authority.registerParent("run-parent", parentLedger);
    expect(
      parentLedger.reserve({
        taskId: "task-parent",
        attemptId: "a01",
        intent: "implement",
        harnessId: "parent",
      }).granted,
    ).toBe(true);
    authority.noteChildAccepted("run-parent", "job-child");
    const a = reviewer("codex", "openai", evidence[0]!);
    const b = reviewer("claude", "anthropic", evidence[1]!);
    const profiles = [a.spec.credentialProfile!, b.spec.credentialProfile!];
    writeFileSync(
      join(configDir, "config.yaml"),
      JSON.stringify({
        routing: { paid_fallback: "when_unavailable" },
        credential_profiles: profiles,
      }),
    );
    const snapshots = profiles.flatMap((profile, i) =>
      evidence[i] === "vendor"
        ? [
            {
              subject: {
                harness: profile.harness_id,
                credential_route: "vendor_native" as const,
                plan_label: "pro",
                subject_id: profile.profile_id,
              },
              constraints: [],
              source:
                profile.harness_id === "codex"
                  ? ("codex_app_server" as const)
                  : ("claude_oauth_usage" as const),
              observed_at: new Date().toISOString(),
              freshness: "fresh" as const,
            },
          ]
        : [],
    );
    const orchestrator = new Orchestrator({
      registry: new Map<string, HarnessAdapter>([
        ["author", author()],
        ["codex", a.spec.adapter],
        ["claude", b.spec.adapter],
      ]),
      reviewerPanel: profiles.map((profile) => ({
        harness: profile.harness_id,
        model: `${profile.harness_id}-model`,
        credentialProfileId: profile.profile_id,
      })),
      quotaSnapshots: () => snapshots,
      delegationBudgetAuthority: authority,
    });
    const result = await orchestrator.run({
      repoRoot: root,
      prompt: "Make a change",
      mode: "agent",
      harnesses: ["author"],
      review: true,
      synthesis: "never",
      runId: "run-child",
      taskId: "task-child",
      parentRunId: "run-parent",
      delegatedFromRunId: "run-parent",
      delegationAdmissionId: "job-child",
      paidBudget: { kind: "finite", maxUsd: 2 },
    } as RunInput);
    const failurePath = join(result.runDir, "final", "failure.yaml");
    return {
      probes: [a.probes, b.probes],
      lifecycle: result.lifecycle,
      reason: result.facts.reason ?? null,
      review: result.facts.review ?? null,
      reviewerCalls: [a.calls(), b.calls()],
      failure: existsSync(failurePath) ? readFileSync(failurePath, "utf8") : "",
      summary: result.summary,
    };
  } finally {
    if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previous;
  }
}

describe("ordinary reviewer panels in a Delegate family", () => {
  it("runs both vendor-verified named reviewers beside an unknown parent unit", async () => {
    const result = await childRun(["vendor", "vendor"]);
    expect(result.probes).toEqual([["codex-account"], ["claude-account"]]);
    expect(result.lifecycle).toBe("succeeded");
    expect(result.review).toBe("approved");
    expect(result.reviewerCalls).toEqual([1, 1]);
  });
  it.each([
    ["vendor", "api"],
    ["api", "vendor"],
  ] as const)("refuses the paid reviewer before sending (%s then %s)", async (first, second) => {
    const result = await childRun([first, second]);
    expect(result.probes).toEqual([["codex-account"], ["claude-account"]]);
    expect(result.lifecycle).toBe("failed");
    expect(result.reason).toBe("budget_exhausted");
    expect(result.failure).toContain("unknown_paid_in_flight");
    expect(result.reviewerCalls[first === "api" ? 0 : 1]).toBe(0);
  });
});
