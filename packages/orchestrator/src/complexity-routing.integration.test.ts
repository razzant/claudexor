/**
 * Complexity routing through the real route resolver (INV-135, INV-140): the
 * configured table and account tiers decide harness, model and account for a
 * run that states a complexity, the decision lands in the routing rationale,
 * and nothing qualifying is one typed refusal. Offline fake harnesses only.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runCapture, type HarnessAdapter } from "@claudexor/core";
import {
  ConformanceReport,
  HarnessManifest,
  RunTelemetry,
  type HarnessRunSpec,
  type QuotaSnapshot,
} from "@claudexor/schema";
import { Orchestrator } from "./orchestrator.js";

const dirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function initRepo(): Promise<string> {
  const repo = scratch("claudexor-complexity-repo-");
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

const MODELS: Record<string, string> = {
  claude: "claude-mid",
  codex: "codex-mid",
  grok: "grok-mid",
};

/** An offline read-only harness that answers and records the spec it ran. */
function answering(id: string, seen: HarnessRunSpec[], unproven = false): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: id === "claude" ? "anthropic" : "openai",
        capabilities: {
          plan: true,
          review: true,
          read_files: true,
          web_policy: "tools",
          known_models: [MODELS[id]!, `${id}-default`],
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
        // As the real adapters' login probes do: a vendor answer, which is what
        // proves subscription billing to the budget router (paid_fallback).
        verification_source: unproven ? "local_store" : "vendor",
        detail: "fixture profile verified",
        last_verified_at: new Date().toISOString(),
      };
    },
    async *run(spec) {
      seen.push(spec);
      const ts = new Date().toISOString();
      const base = { session_id: spec.session_id, ts, credential_route: "vendor_native" };
      yield { ...base, type: "started" } as never;
      yield { ...base, type: "message", text: `answered by ${id}` } as never;
      yield { ...base, type: "completed" } as never;
    },
  };
}

const ACCOUNTS: Array<[harness: string, id: string, tier: string | null]> = [
  ["claude", "lead", "primary"],
  ["claude", "spare", "auxiliary"],
  ["codex", "cx1", "auxiliary"],
  ["codex", "cx2", "auxiliary"],
  ["grok", "gk", "auxiliary"],
];

function writeConfig(configDir: string, withTable = true): void {
  const lines = ["credential_profiles:"];
  for (const [harness, id, tier] of ACCOUNTS) {
    lines.push(
      `  - profile_id: ${id}`,
      `    harness_id: ${harness}`,
      `    display_name: ${id}`,
      "    credential_kind: config_dir_login",
      `    isolation_locator: '${join(configDir, `profile-${harness}-${id}`)}'`,
    );
    if (tier) lines.push(`    tier: ${tier}`);
  }
  if (withTable)
    lines.push(
      "routing:",
      "  complexity_routes:",
      "    medium:",
      "      - { harness: claude, model: claude-mid }",
      "      - { harness: grok, model: grok-mid }",
      "      - { harness: codex, model: codex-mid }",
    );
  lines.push("");
  writeFileSync(join(configDir, "config.yaml"), lines.join("\n"));
}

const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/** One fresh quota window of one account, in the model every source feeds. */
function quota(
  harness: string,
  id: string,
  used: number,
  resetsAt: string,
  observedAt = iso(-1000),
): QuotaSnapshot {
  return {
    subject: { harness, credential_route: "vendor_native", plan_label: null, subject_id: id },
    constraints: [
      {
        id: "weekly",
        label: "window",
        used_ratio: used,
        window_seconds: 7 * 24 * 3600,
        resets_at: resetsAt,
        cooldown_until: null,
      },
    ],
    source:
      harness === "grok"
        ? "grok_local_usage"
        : harness === "codex"
          ? "codex_app_server"
          : "claude_oauth_usage",
    observed_at: observedAt,
    freshness: "fresh",
  };
}

describe("complexity routing through the route resolver", () => {
  let previousConfigDir: string | undefined;
  let configDir: string;
  beforeEach(() => {
    previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    configDir = scratch("claudexor-complexity-config-");
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  });
  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
  });

  async function run(
    snapshots: QuotaSnapshot[],
    input: { complexity?: "easy" | "medium" | "hard"; credentialProfileId?: string } = {
      complexity: "medium",
    },
    unproven: string[] = [],
  ) {
    const repo = await initRepo();
    const seen: HarnessRunSpec[] = [];
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const result = await new Orchestrator({
      registry: new Map(
        ["claude", "codex", "grok"].map(
          (id) => [id, answering(id, seen, unproven.includes(id))] as const,
        ),
      ),
      reviewers: [],
      quotaSnapshots: () => snapshots,
    }).run({
      repoRoot: repo,
      prompt: "2+2?",
      mode: "ask",
      ...input,
      onEvent: (event) =>
        events.push({
          type: event.type,
          payload: (event.payload ?? {}) as Record<string, unknown>,
        }),
    });
    const ran = seen.map((spec) => ({
      model: spec.model_hint ?? null,
      profile: spec.credential_profile?.profile_id ?? null,
      harness: spec.credential_profile?.harness_id ?? null,
    }));
    return { result, ran, events, repo };
  }

  const decided = (events: Array<{ type: string; payload: Record<string, unknown> }>) =>
    events.find((event) => event.type === "route.complexity.decided")?.payload as
      | {
          selected: string | null;
          candidates: Array<{
            harness_id: string;
            profile_id: string | null;
            blocked_by: string | null;
            accounts: Array<{ profile_id: string; blocked_by: string }>;
          }>;
        }
      | undefined;

  it("falls to the Claude candidate while Grok and both Codex accounts are spent, and records why", async () => {
    writeConfig(configDir);
    const { result, ran, events } = await run([
      quota("grok", "gk", 1, iso(10 * HOUR)),
      quota("codex", "cx1", 1, iso(4 * HOUR)),
      quota("codex", "cx2", 1, iso(6 * HOUR)),
      quota("claude", "spare", 0.3, iso(60 * HOUR)),
      quota("claude", "lead", 0.2, iso(60 * HOUR)),
    ]);
    expect(result.lifecycle).toBe("succeeded");
    // The auxiliary Claude account serves, on the table's model, never the primary one.
    expect(ran).toEqual([{ model: "claude-mid", profile: "spare", harness: "claude" }]);
    const decision = decided(events)!;
    expect(decision.selected).toBe("claude");
    expect(decision.candidates.map((c) => [c.harness_id, c.profile_id, c.blocked_by])).toEqual([
      ["claude", "spare", null],
      ["grok", null, "account_exhausted"],
      ["codex", null, "account_exhausted"],
    ]);
    expect(decision.candidates[2]!.accounts.map((a) => a.profile_id)).toEqual(["cx1", "cx2"]);
    // The same decision is the run's durable routing rationale.
    const telemetry = RunTelemetry.parse(
      parseYaml(readFileSync(join(result.runDir, "final", "telemetry.yaml"), "utf8")),
    );
    expect(telemetry.routing_rationale?.complexity?.selected).toBe("claude");
    expect(telemetry.routing_rationale?.order).toEqual(["claude"]);
  });

  it("chooses them again by tier order after their reset, with no other change", async () => {
    writeConfig(configDir);
    // The same accounts and config; the spent windows have passed their resets
    // and the next readings show room. Soonest limiting reset decides.
    const { ran, events } = await run([
      quota("grok", "gk", 0.05, iso(400 * HOUR)),
      quota("codex", "cx1", 0.1, iso(12 * HOUR)),
      quota("codex", "cx2", 0.2, iso(50 * HOUR)),
      quota("claude", "spare", 0.3, iso(60 * HOUR)),
      quota("claude", "lead", 0.2, iso(60 * HOUR)),
    ]);
    expect(ran).toEqual([{ model: "codex-mid", profile: "cx1", harness: "codex" }]);
    const decision = decided(events)!;
    expect(decision.selected).toBe("codex");
    expect(decision.candidates.every((c) => c.blocked_by === null)).toBe(true);
    expect(events.some((event) => event.type === "route.account.pool_selected")).toBe(true);
  });

  it("stops treating a spent window as a block once its reset instant has passed", async () => {
    writeConfig(configDir);
    // Evidence read before the reset and never replaced: the reset is in the past.
    const before = iso(-2 * HOUR);
    const { ran } = await run([
      quota("codex", "cx1", 1, iso(-HOUR), before),
      quota("codex", "cx2", 1, iso(-HOUR), before),
      quota("grok", "gk", 1, iso(-HOUR), before),
      quota("claude", "spare", 1, iso(30 * HOUR)),
      quota("claude", "lead", 0.9, iso(30 * HOUR)),
    ]);
    // Claude is exhausted (spare) or reserved (lead); the reopened auxiliary
    // accounts serve with unknown usage, in table order: Grok before Codex.
    expect(ran).toEqual([{ model: "grok-mid", profile: "gk", harness: "grok" }]);
  });

  it("refuses typed when nothing qualifies and never uses the reserved primary account", async () => {
    writeConfig(configDir);
    const { result, ran, events } = await run([
      quota("grok", "gk", 1, iso(10 * HOUR)),
      quota("codex", "cx1", 1, iso(4 * HOUR)),
      quota("codex", "cx2", 1, iso(6 * HOUR)),
      quota("claude", "spare", 1, iso(60 * HOUR)),
      quota("claude", "lead", 0.9, iso(70 * HOUR)),
    ]);
    expect(ran).toEqual([]);
    expect(result.lifecycle).toBe("failed");
    const decision = decided(events)!;
    expect(decision.selected).toBeNull();
    expect(
      decision.candidates.map((c) => [
        c.harness_id,
        c.accounts.map((a) => `${a.profile_id}:${a.blocked_by}`),
      ]),
    ).toEqual([
      ["claude", ["lead:owner_reserve", "spare:account_exhausted"]],
      ["grok", ["gk:account_exhausted"]],
      ["codex", ["cx1:account_exhausted", "cx2:account_exhausted"]],
    ]);
    const failure = parseYaml(
      readFileSync(join(result.runDir, "final", "failure.yaml"), "utf8"),
    ) as { category: string; phase: string; safeMessage: string };
    expect(failure).toMatchObject({ category: "harness_unavailable", phase: "routing" });
    expect(failure.safeMessage).toContain("no route candidate can serve complexity 'medium'");
    expect(failure.safeMessage).toContain("lead: owner_reserve");
  });

  it("uses the primary account below its reserve once every auxiliary one is exhausted", async () => {
    writeConfig(configDir);
    const { ran } = await run([
      quota("grok", "gk", 1, iso(10 * HOUR)),
      quota("codex", "cx1", 1, iso(4 * HOUR)),
      quota("codex", "cx2", 1, iso(6 * HOUR)),
      quota("claude", "spare", 1, iso(60 * HOUR)),
      quota("claude", "lead", 0.5, iso(70 * HOUR)),
    ]);
    expect(ran).toEqual([{ model: "claude-mid", profile: "lead", harness: "claude" }]);
  });

  it("keeps the paid-fallback rule: an account whose billing is unproven waits for a proven one", async () => {
    writeConfig(configDir);
    // Grok would win on tier order, but its login is not vendor-proven and its
    // local meter is no vendor answer, so the budget router
    // (paid_fallback: when_unavailable) keeps it out while a proven lane
    // exists. The decision records that cause.
    const { ran, events } = await run(
      [
        quota("grok", "gk", 0.1, iso(2 * HOUR)),
        quota("claude", "spare", 0.3, iso(60 * HOUR)),
        quota("codex", "cx1", 1, iso(10 * HOUR)),
        quota("codex", "cx2", 1, iso(10 * HOUR)),
      ],
      { complexity: "medium" },
      ["grok"],
    );
    expect(ran).toEqual([{ model: "claude-mid", profile: "spare", harness: "claude" }]);
    expect(decided(events)!.candidates[1]).toMatchObject({
      harness_id: "grok",
      blocked_by: "budget_or_cooldown",
    });
  });

  it("a strict pin still wins over the tier order", async () => {
    writeConfig(configDir);
    const { ran } = await run(
      [
        quota("claude", "spare", 0.1, iso(60 * HOUR)),
        quota("claude", "lead", 0.2, iso(60 * HOUR)),
        quota("codex", "cx1", 0.1, iso(2 * HOUR)),
      ],
      { complexity: "medium", credentialProfileId: "lead" },
    );
    expect(ran).toEqual([{ model: "claude-mid", profile: "lead", harness: "claude" }]);
  });

  it("refuses a complexity the table does not configure", async () => {
    writeConfig(configDir);
    await expect(run([], { complexity: "hard" })).rejects.toThrow(/no route candidates/);
  });

  it("a run that states no complexity ignores tiers, reserve and table", async () => {
    writeConfig(configDir, false);
    const snapshots = [
      quota("claude", "spare", 0.5, iso(2 * HOUR)),
      quota("claude", "lead", 0.9, iso(60 * HOUR)),
      quota("codex", "cx1", 0.2, iso(HOUR)),
    ];
    const repo = await initRepo();
    const seen: HarnessRunSpec[] = [];
    const events: string[] = [];
    await new Orchestrator({
      registry: new Map([["claude", answering("claude", seen)]]),
      reviewers: [],
      quotaSnapshots: () => snapshots,
    }).run({
      repoRoot: repo,
      prompt: "2+2?",
      mode: "ask",
      harnesses: ["claude"],
      credentialProfileId: "lead",
      onEvent: (event) => events.push(event.type),
    });
    // The primary account at 90% serves as it always did, with no complexity event.
    expect(seen.map((spec) => spec.credential_profile?.profile_id)).toEqual(["lead"]);
    expect(events).not.toContain("route.complexity.decided");
  });
});
