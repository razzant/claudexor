import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import type { HarnessAdapter } from "@claudexor/core";
import { BudgetLedger } from "@claudexor/budget";
import { ConformanceReport, HarnessManifest } from "@claudexor/schema";
import { ArtifactStore } from "@claudexor/artifact-store";
import { Orchestrator } from "./orchestrator.js";

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

it.each([
  { mode: "agent", cap: 2 },
  { mode: "ask", cap: 2 },
  { mode: "agent", cap: 0 },
  { mode: "ask", cap: 0 },
] as const)(
  "$mode re-admits rotated processing at cap=$cap before native generation",
  async ({ mode, cap }) => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-processing-rotation-"));
    roots.push(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
    writeFileSync(join(root, "README.md"), "fixture");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "baseline",
      ],
      { cwd: root, stdio: "pipe" },
    );
    const configDir = process.env.CLAUDEXOR_CONFIG_DIR!;
    writeFileSync(
      join(configDir, "config.yaml"),
      JSON.stringify({
        routing: { paid_fallback: "allowed_within_cap" },
        credential_profiles: ["a", "b"].map((id) => ({
          profile_id: id,
          harness_id: "limited",
          display_name: id,
          credential_kind: "config_dir_login",
          isolation_locator: join(root, "profile-" + id),
        })),
        harnesses: { limited: { profile_policy: { limit_action: "rotate" } } },
      }),
    );
    const order: string[] = [];
    const original = BudgetLedger.prototype.repriceReservedLease;
    vi.spyOn(BudgetLedger.prototype, "repriceReservedLease").mockImplementation(function (
      this: BudgetLedger,
      id,
      cost,
    ) {
      order.push("admit:" + cost.provenance.find((p) => p.startsWith("profile:")));
      return original.call(this, id, cost);
    });
    const adapter: HarnessAdapter = {
      id: "limited",
      async discover() {
        return HarnessManifest.parse({
          id: "limited",
          display_name: "limited",
          kind: "local_cli",
          provider_family: "local",
          capabilities: {
            implement: true,
            read_files: true,
            effort_levels: ["high"],
            repair: true,
            explain: true,
            audit: true,
            known_models: ["same-model"],
          },
          auth_modes: ["local_session"],
          access_profiles_supported: ["workspace_write", "readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "limited",
          status: "ok",
          enabled_intents: ["implement", "repair", "explain", "audit"],
          auth_sources: [
            { source: "native_session", availability: "available", verification: "passed" },
          ],
        });
      },
      async probeCredentialProfile(profile) {
        return {
          profile_id: profile.profile_id,
          harness_id: "limited",
          availability: "available",
          verification: "passed",
          verification_source: "local_store",
          last_verified_at: new Date().toISOString(),
        };
      },
      async models() {
        return [{ id: "same-model", label: null, context_window: null, routes: null }];
      },
      async prepareProcessing(input) {
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
        order.push("run:" + profile);
        expect(spec.model_hint).toBe("same-model");
        expect(spec.effort_hint).toBe("high");
        const common = {
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          credential_route: "vendor_native" as const,
          credential_profile_id: profile,
          processing: spec.processing,
          processing_cost_basis: spec.processing_cost_basis,
        };
        yield { ...common, type: "started" };
        if (profile === "a") {
          yield {
            ...common,
            type: "status",
            status: { kind: "api_retry", error_category: "rate_limit" },
            rate_limit: { resets_at: null, retry_delay_ms: 60000 },
          };
          yield { ...common, type: "error", error: "fixture capacity refused before work" };
          yield { ...common, type: "completed" };
          return;
        }
        expect(spec.processing?.submitted).toBe("fast");
        yield {
          ...common,
          type: "usage",
          usage: { cost_usd: 0.2, cost_basis: { kind: "cash", source: "fixture.debit" } },
        };
        if (mode === "agent") {
          writeFileSync(join(spec.cwd, "result.txt"), "finished");
          yield { ...common, type: "file_change", payload: { path: "result.txt" } };
        }
        yield { ...common, type: "message", text: "Finished", final: true };
        yield { ...common, type: "completed" };
      },
    };
    const result = await new Orchestrator({
      registry: new Map([["limited", adapter]]),
      reviewers: [],
    }).run({
      repoRoot: root,
      ...(mode === "agent" ? { inPlace: true } : {}),
      mode,
      prompt: "finish",
      harnesses: ["limited"],
      review: false,
      processingPreference: "fast",
      models: { limited: "same-model" },
      effort: "high",
      authPreference: "subscription",
      paidBudget: { kind: "finite", maxUsd: cap },
      web: "off",
    });
    expect(order, JSON.stringify({ summary: result.summary, facts: result.facts })).toEqual(
      cap === 0
        ? ["admit:profile:a", "run:a", "admit:profile:b"]
        : ["admit:profile:a", "run:a", "admit:profile:b", "run:b"],
    );
    expect(result.lifecycle, result.summary).toBe(cap === 0 ? "failed" : "succeeded");
    expect(result.spendUsd).toBeCloseTo(cap === 0 ? 0 : 0.2);
    if (cap === 0) {
      expect(result.facts.reason).toBe("budget_exhausted");
      expect(
        new ArtifactStore(root).readYaml<any>(join(result.runDir, "final", "failure.yaml")),
      ).toMatchObject({ category: "budget", code: "finite_zero" });
      return;
    }
    const telemetry = new ArtifactStore(root).readYaml<any>(
      join(result.runDir, "final", "telemetry.yaml"),
    );
    expect(telemetry.auth_route.profile_id).toBe("b");
  },
);
