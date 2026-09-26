import { describe, expect, it } from "vitest";
import { EffortHint, mergeEffortLadders } from "./effort.js";
import * as SetupLoginProtocol from "./setup-login-protocol.js";
import {
  AccessProfile,
  ActiveTaskContract,
  CredentialProfile,
  HARNESS_INACTIVITY_TIMEOUT_DEFAULT_MS,
  DAEMON_MAX_CONCURRENT_DEFAULT,
  MAX_COUNCIL_MEMBERS_DEFAULT,
  MAX_DEEP_SCAN_WIDTH_DEFAULT,
  MAX_PARALLEL_CANDIDATES_DEFAULT,
  ControlCredentialProfilesResponse,
  ControlRunDecisionRequest,
  ControlRunSummary,
  ControlRunStartRequest,
  RecordedControlRunStartRequest,
  ControlSetupJob,
  ControlSetupJobCreateRequest,
  ControlSetupJobEvent,
  ControlSetupJobSnapshot,
  ControlSettingsSnapshot,
  ControlSettingsUpdateRequest,
  ControlThread,
  ControlThreadCreateRequest,
  ControlThreadUpdateRequest,
  ControlThreadTurnRequest,
  ConformanceReport,
  FrozenTaskContractArtifact,
  RecordedAppliedAttemptFacts,
  HarnessManifest,
  HarnessStatusDto,
  HarnessRunSpec,
  ReviewFinding,
  RouteProof,
  RoutingGoal,
  ProjectConfig,
  GlobalConfig,
  Session,
  ContinuityDisclosure,
  LaneCheckpoint,
  SetupExecutableEvidence,
  TaskContract,
  Thread,
  ThreadTurn,
  isBlocking,
} from "./index.js";

describe("AuthSourceReadiness compatibility", () => {
  it("defaults missing conformance and control readiness arrays", () => {
    const report = ConformanceReport.parse({ harness_id: "codex", status: "ok" });
    expect(report.auth_sources).toEqual([]);
    const status = HarnessStatusDto.parse({ id: "codex", status: "ok" });
    expect(status.authSources).toEqual([]);
  });

  it("keeps availability and verification as independent typed axes", () => {
    const report = ConformanceReport.parse({
      harness_id: "codex",
      status: "degraded",
      auth_sources: [
        {
          source: "native_session",
          availability: "unknown",
          verification: "not_run",
          detail: "probe failed",
        },
      ],
    });
    expect(report.auth_sources[0]).toMatchObject({
      availability: "unknown",
      verification: "not_run",
    });
    expect(() =>
      ConformanceReport.parse({
        harness_id: "codex",
        status: "ok",
        auth_sources: [
          { source: "native_session", availability: "present", verification: "passed" },
        ],
      }),
    ).toThrow();
  });
});

describe("Control credential next-up route compatibility", () => {
  it("accepts both current route-aware and legacy native projections", () => {
    const base = {
      profiles: [],
      harnessAccounts: [
        {
          harness_id: "claude",
          native_credentials_enabled: true,
          native_login_detected: true,
          next_up: { kind: "native" as const },
        },
      ],
    };
    expect(ControlCredentialProfilesResponse.safeParse(base).success).toBe(true);
    expect(
      ControlCredentialProfilesResponse.safeParse({
        ...base,
        harnessAccounts: [
          {
            ...base.harnessAccounts[0],
            next_up: { kind: "native", route: "api_key" },
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("TaskContract", () => {
  it("applies defaults from minimal input", () => {
    const tc = TaskContract.parse({
      task_id: "t-1",
      created_at: "2026-06-05T00:00:00Z",
      repo: { root: "/repo", base_ref: "main" },
      schema_version: 2,
      mode: { kind: "agent" },
      user_intent: { raw: "do the thing" },
    });
    expect(tc.access.requested_profile).toBe("workspace_write");
    expect(tc.access.effective_profile).toBe("workspace_write");
    expect(tc.external_context.effective_mode).toBe("auto");
    expect(tc.budget.routing_goal).toBe("auto");
    expect(tc.constraints.protected_path_approvals).toEqual([]);
    expect(tc.convergence.require_tests_pass).toBe(true);
    expect(tc).not.toHaveProperty("review_requested");
    expect(TaskContract.parse({ ...tc, review_requested: false }).review_requested).toBe(false);
    expect(ControlRunStartRequest.parse({ prompt: "hello" })).not.toHaveProperty("review");
    expect(RecordedControlRunStartRequest.parse({ prompt: "hello" })).not.toHaveProperty("review");
  });

  it("separates active access from immutable historical decoding, including nested grants", () => {
    expect(AccessProfile.options).toEqual([
      "readonly",
      "workspace_write",
      "full",
      "inherit_native",
    ]);
    expect(
      ControlRunStartRequest.safeParse({ prompt: "x", access: "external_sandbox_full" }).success,
    ).toBe(false);
    expect(
      RecordedControlRunStartRequest.parse({ prompt: "x", access: "external_sandbox_full" }).access,
    ).toBe("external_sandbox_full");

    const historical = {
      task_id: "t-old",
      created_at: "2026-06-05T00:00:00Z",
      repo: { root: "/repo", base_ref: "main" },
      schema_version: 2,
      mode: { kind: "agent" },
      user_intent: { raw: "old run" },
      access: {
        requested_profile: "external_sandbox_full",
        effective_profile: "external_sandbox_full",
      },
      tests: {
        commands: [
          {
            id: "gate-1",
            program: "true",
            trust_required: true,
            trust_grant: {
              projectDigest: "sha256:project",
              configDigest: "sha256:config",
              commandDigest: "sha256:command",
              executablePath: "/usr/bin/true",
              executableDigest: "sha256:executable",
              accessProfile: "external_sandbox_full",
            },
          },
        ],
      },
    };
    expect(TaskContract.safeParse(historical).success).toBe(true);
    expect(ActiveTaskContract.safeParse(historical).success).toBe(false);
    expect(
      RecordedAppliedAttemptFacts.parse({
        harness_home_isolated: true,
        harness_home_dir: "/scoped",
        access_applied: "external_sandbox_full",
        credential_profile_applied: null,
        confinement_mechanism: "seatbelt",
        confinement_profile_digest: "sha256:profile",
        confinement_verified_denied_path: "/denied",
        confinement_unavailable_reason: null,
      }).access_applied,
    ).toBe("external_sandbox_full");
  });

  it("requires an explicit gate list only when decoding frozen task authority", () => {
    const minimal = {
      task_id: "t-1",
      created_at: "2026-06-05T00:00:00Z",
      repo: { root: "/repo", base_ref: "main" },
      schema_version: 2,
      mode: { kind: "agent" },
      user_intent: { raw: "do the thing" },
    };
    expect(TaskContract.parse(minimal).tests.commands).toEqual([]);
    expect(FrozenTaskContractArtifact.safeParse(minimal).success).toBe(false);
    expect(FrozenTaskContractArtifact.safeParse({ ...minimal, tests: {} }).success).toBe(false);
    expect(
      FrozenTaskContractArtifact.parse({ ...minimal, tests: { commands: [] } }).tests.commands,
    ).toEqual([]);
  });
});

describe("ControlSettingsSnapshot", () => {
  it("carries daemon-effective runtime settings for CLI/IDE projections", () => {
    const snapshot = ControlSettingsSnapshot.parse({
      runtime: {
        reviewerTimeoutMs: 2_400_000,
        concurrency: {
          configured: {
            maxConcurrent: 24,
            maxParallelCandidates: 6,
            maxDeepScanWidth: 10,
            maxCouncilMembers: 5,
          },
          effective: {
            maxConcurrent: 12,
            maxParallelCandidates: 4,
            maxDeepScanWidth: 8,
            maxCouncilMembers: 4,
          },
          restartRequired: true,
        },
        transientRetry: {
          maxRetries: 3,
          initialDelayMs: 2_000,
          maxDelayMs: 20_000,
        },
      },
    });
    expect(snapshot.runtime.reviewerTimeoutMs).toBe(2_400_000);
    expect(snapshot.runtime.concurrency!.restartRequired).toBe(true);
    expect(snapshot.runtime.concurrency!.configured.maxConcurrent).toBe(24);
    expect(snapshot.runtime.concurrency!.effective.maxConcurrent).toBe(12);
    expect(snapshot.runtime.transientRetry.maxRetries).toBe(3);
    expect(snapshot.runtime.transientRetry.initialDelayMs).toBe(2_000);
    expect(snapshot.runtime.transientRetry.maxDelayMs).toBe(20_000);
  });
});

describe("runtime concurrency settings surface", () => {
  it("keeps startup-frozen concurrency out of POST settings patches", () => {
    expect(() =>
      ControlSettingsUpdateRequest.parse({
        runtime: { concurrency: { maxConcurrent: 48 } },
      }),
    ).toThrow();
    expect(() =>
      ControlSettingsUpdateRequest.parse({ concurrency: { maxConcurrent: 48 } }),
    ).toThrow();
  });
});

// GH #129: the harness inactivity watchdog default has ONE named owner
// (HARNESS_INACTIVITY_TIMEOUT_DEFAULT_MS in the config schema module) consumed
// by BOTH default sites, so the persisted-config and wire-snapshot literals
// cannot drift. Absent-field semantics only: explicit values are never migrated.
describe("harness inactivity watchdog default", () => {
  it("defaults runtime.harness_inactivity_timeout_ms to the named constant", () => {
    expect(GlobalConfig.parse({}).runtime.harness_inactivity_timeout_ms).toBe(
      HARNESS_INACTIVITY_TIMEOUT_DEFAULT_MS,
    );
  });

  it("mirrors the same default on the ControlSettingsSnapshot wire schema", () => {
    expect(ControlSettingsSnapshot.parse({}).runtime.harnessInactivityTimeoutMs).toBe(
      HARNESS_INACTIVITY_TIMEOUT_DEFAULT_MS,
    );
  });
});

describe("runtime concurrency caps", () => {
  it("uses the product defaults and accepts larger finite values", () => {
    const runtime = GlobalConfig.parse({}).runtime;
    expect(runtime.max_concurrent).toBe(DAEMON_MAX_CONCURRENT_DEFAULT);
    expect(runtime.max_parallel_candidates).toBe(MAX_PARALLEL_CANDIDATES_DEFAULT);
    expect(runtime.max_deep_scan_width).toBe(MAX_DEEP_SCAN_WIDTH_DEFAULT);
    expect(runtime.max_council_members).toBe(MAX_COUNCIL_MEMBERS_DEFAULT);
    const larger = GlobalConfig.parse({
      runtime: {
        max_concurrent: 64,
        max_parallel_candidates: 12,
        max_deep_scan_width: 16,
        max_council_members: 10,
      },
    }).runtime;
    expect(larger).toMatchObject({
      max_concurrent: 64,
      max_parallel_candidates: 12,
      max_deep_scan_width: 16,
      max_council_members: 10,
    });
  });

  it("rejects invalid values and a Council cap below two", () => {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => GlobalConfig.parse({ runtime: { max_concurrent: value } })).toThrow();
    }
    expect(() => GlobalConfig.parse({ runtime: { max_council_members: 1 } })).toThrow();
  });
});

describe("ReviewFinding.isBlocking", () => {
  const base = {
    severity: "BLOCK" as const,
    status: "accepted" as const,
    evidence: { files: [], diff_hunks: [], commands: [], logs: [] },
  };

  it("does not block without evidence (no evidence -> cannot BLOCK)", () => {
    expect(isBlocking(base)).toBe(false);
  });

  it("blocks when accepted + BLOCK + has evidence", () => {
    expect(
      isBlocking({
        ...base,
        evidence: { ...base.evidence, files: [{ path: "a.ts", lines: "1-2" }] },
      }),
    ).toBe(true);
  });

  it("does not block when only proposed", () => {
    expect(
      isBlocking({
        severity: "BLOCK",
        status: "proposed",
        evidence: {
          files: [{ path: "a.ts", lines: null }],
          diff_hunks: [],
          commands: [],
          logs: [],
        },
      }),
    ).toBe(false);
  });

  it("parses a full finding with reviewer route proof", () => {
    const f = ReviewFinding.parse({
      id: "f-1",
      severity: "FIX_FIRST",
      category: "correctness",
      claim: "off-by-one",
      evidence: { files: [{ path: "x.ts", lines: "10" }] },
      reviewer: { harness_id: "claude", requested_effort: "max", route_proof_status: "verified" },
    });
    expect(f.status).toBe("proposed");
    expect(f.reviewer.requested_effort).toBe("max");
    expect(f.reviewer.route_proof_status).toBe("verified");
  });
});

describe("RouteProof + HarnessManifest", () => {
  it("parses a same-model fallback route proof", () => {
    const rp = RouteProof.parse({
      requested: { harness_id: "codex", provider_family: "openai" },
      observed: { provider: "openai", model_id: "gpt-5.5", evidence_source: "stream_event" },
      status: "verified",
    });
    expect(rp.status).toBe("verified");
    expect(rp.requested.model_hint).toBeNull();
  });

  it("parses a harness manifest with capabilities", () => {
    const m = HarnessManifest.parse({
      id: "fake-success",
      display_name: "Fake",
      kind: "fake",
      provider_family: "local",
      capabilities: { implement: true, review: true },
    });
    expect(m.capabilities.implement).toBe(true);
    expect(m.capabilities.web_policy).toBe("none");
  });

  it("leaves model_inventory_absence ABSENT by default, which every consumer reads as authoritative", () => {
    // INV-104: an adapter that says nothing keeps the strict gate. Only a
    // producer that knows it cannot tell its own answer from a substituted one
    // declares `advisory`, and it must say so out loud.
    const bare = HarnessManifest.parse({
      id: "fake-success",
      display_name: "Fake",
      kind: "fake",
      provider_family: "local",
      capabilities: {},
    });
    expect(bare.capabilities.model_inventory_absence).toBeUndefined();
    expect(
      HarnessManifest.parse({
        id: "codexish",
        display_name: "Codexish",
        kind: "local_cli",
        provider_family: "openai",
        capabilities: { model_inventory_absence: "advisory" },
      }).capabilities.model_inventory_absence,
    ).toBe("advisory");
    expect(() =>
      HarnessManifest.parse({
        id: "codexish",
        display_name: "Codexish",
        kind: "local_cli",
        provider_family: "openai",
        capabilities: { model_inventory_absence: "maybe" },
      }),
    ).toThrow();
  });
});

describe("EffortHint is an OPEN vocabulary, bounded by shape only", () => {
  it("accepts a level no ranking table knows, because vendors advertise their own", () => {
    // Mirrors codex's own generated schema, which types ReasoningEffort as "a
    // non-empty reasoning effort value advertised by the model" — a bounded
    // string, not an enum. Refusal happens where the advertised set is known.
    expect(EffortHint.parse("hyperdrive")).toBe("hyperdrive");
    expect(EffortHint.parse("xhigh")).toBe("xhigh");
    expect(EffortHint.parse("gpt-5")).toBe("gpt-5");
  });

  it("still refuses values that are not a slug at all", () => {
    for (const bad of [
      "",
      " ",
      "TURBO",
      "turbo boost",
      "turbo!",
      "-turbo",
      "turbo-",
      "a".repeat(33),
    ]) {
      expect(EffortHint.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("derives ordering from the vendor's own advertised sequences — there is no rank table", () => {
    // The ONE ordering owner is `mergeEffortLadders`: position in the vendor's
    // advertised list IS the rank, so a brand-new level ("hyperdrive") sorts
    // where the vendor put it and contradictory vendor orders are flagged
    // instead of silently re-ranked.
    expect(
      mergeEffortLadders([
        ["low", "medium", "high", "xhigh"],
        ["low", "medium", "high", "xhigh", "hyperdrive", "max"],
      ]),
    ).toEqual({
      order: ["low", "medium", "high", "xhigh", "hyperdrive", "max"],
      unconstrained: [],
      consistent: true,
    });
    expect(
      mergeEffortLadders([
        ["low", "max"],
        ["max", "low"],
      ]).consistent,
    ).toBe(false);
  });
});

describe("Control API schemas", () => {
  it("accepts a server-owned thread folder and an explicit clear", () => {
    expect(ControlThreadCreateRequest.parse({ folder: "Research" }).folder).toBe("Research");
    expect(ControlThreadUpdateRequest.parse({ folder: null }).folder).toBeNull();
    expect(
      ControlThread.parse({
        id: "th-1",
        folder: "Research",
        createdAt: "2026-09-24T00:00:00Z",
        updatedAt: "2026-09-24T00:00:00Z",
      }).folder,
    ).toBe("Research");
  });

  it("accepts typed plan-answer provenance only on the thread-turn boundary", () => {
    expect(
      ControlThreadTurnRequest.safeParse({
        prompt: "answers",
        mode: "plan",
        answersPlanRunId: "run-plan",
      }).success,
    ).toBe(true);
    expect(
      ControlRunStartRequest.safeParse({
        prompt: "answers",
        mode: "plan",
        answersPlanRunId: "run-plan",
      }).success,
    ).toBe(false);
  });

  it("keeps the frozen plan reference server-owned on the thread-turn boundary", () => {
    expect(
      ControlThreadTurnRequest.safeParse({
        prompt: "implement",
        planRunId: "run-plan",
        planRef: {
          runId: "run-plan",
          sha256: "a".repeat(64),
          path: "/tmp/forged-plan.md",
        },
      }).success,
    ).toBe(false);
  });

  it("preserves the deciding credential profile on a run auth-route receipt", () => {
    const summary = ControlRunSummary.parse({
      jobId: "job-1",
      runId: "run-1",
      state: "succeeded",
      authRoute: {
        requested: "auto",
        effective: "local_session",
        source: "native_session",
        reason: "native_first",
        harnessId: "claude",
        attemptId: "a01",
        profileId: "work",
      },
    });
    expect(summary.authRoute?.profileId).toBe("work");
  });

  it("hard-errors every removed portfolio boundary", () => {
    expect(RoutingGoal.safeParse("subscription-first").success).toBe(false);
    expect(() =>
      ControlRunStartRequest.parse({ prompt: "x", mode: "agent", portfolio: "balanced" }),
    ).toThrow();
    expect(() => ProjectConfig.parse({ budget: { portfolio: "cheapest" } })).toThrow();
    expect(() => GlobalConfig.parse({ default_portfolio: "daily-rich" })).toThrow();
  });

  it("accepts only repo-relative project protected-path globs", () => {
    expect(
      ProjectConfig.parse({
        constraints: { protected_paths: ["migrations/**", "**/*.env"] },
      }).constraints.protected_paths,
    ).toEqual(["migrations/**", "**/*.env"]);
    expect(ProjectConfig.parse({}).constraints.protected_paths).toEqual([]);

    for (const invalid of [
      "/etc/**",
      "../outside/**",
      "safe/../outside/**",
      "C:/temp/**",
      "dir\\**",
    ]) {
      expect(() => ProjectConfig.parse({ constraints: { protected_paths: [invalid] } })).toThrow();
    }
  });

  it("bounds maxSeconds to avoid a setTimeout 32-bit-ms overflow (W6/G10)", () => {
    expect(ControlRunStartRequest.parse({ prompt: "x", maxSeconds: 604_800 }).maxSeconds).toBe(
      604_800,
    );
    // > 7 days is rejected — a larger delay would wrap setTimeout to ~1ms and
    // cancel the run almost immediately.
    expect(() => ControlRunStartRequest.parse({ prompt: "x", maxSeconds: 604_801 })).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({ prompt: "x", maxSeconds: 3_000_000_000 }),
    ).toThrow();
  });

  it("defaults the delegated-run marker to false and keeps execution strict", () => {
    // Omitted by every existing caller (macOS app, CLI, MCP belt): the marker
    // must never turn a surface-started run into a delegated one by accident.
    expect(ControlRunStartRequest.parse({ prompt: "x" }).execution.delegated).toBe(false);
    expect(
      ControlRunStartRequest.parse({ prompt: "x", execution: { isolation: "live" } }).execution,
    ).toEqual({ isolation: "live", delegated: false });
    expect(
      ControlRunStartRequest.parse({
        prompt: "x",
        mode: "agent",
        execution: { isolation: "live", delegated: true },
      }).execution.delegated,
    ).toBe(true);
    // Still strict: an unknown execution key is a loud refusal, which is also
    // exactly how an OLDER daemon answers this new field (hence the client-side
    // minimum-version pin).
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "x",
        execution: { isolation: "live", delgated: true },
      }),
    ).toThrow();
  });

  it("accepts reviewer effort overrides on run start requests", () => {
    const req = ControlRunStartRequest.parse({
      prompt: "review it",
      mode: "agent",
      scope: { kind: "project", root: "/repo" },
      reviewerPanel: [
        {
          harness: "claude",
          model: "claude-opus-4-8",
          effort: "max",
          credentialProfileId: "reviewer-a",
        },
        { harness: "cursor", model: "gemini-3.1-pro" },
        { harness: "cursor", model: "gemini-3.5-flash" },
      ],
      reviewerEfforts: { anthropic: "max", openai: "xhigh" },
      reviewerModels: { anthropic: "claude-opus-4-8", openai: "gpt-4o" },
    });
    expect(req.scope).toEqual({
      kind: "project",
      root: "/repo",
      context: "auto",
      ephemeral: false,
    });
    expect(req.reviewerPanel).toEqual([
      {
        harness: "claude",
        model: "claude-opus-4-8",
        effort: "max",
        credentialProfileId: "reviewer-a",
      },
      { harness: "cursor", model: "gemini-3.1-pro" },
      { harness: "cursor", model: "gemini-3.5-flash" },
    ]);
    expect(req.reviewerEfforts?.anthropic).toBe("max");
    expect(req.reviewerEfforts?.openai).toBe("xhigh");
    expect(req.reviewerModels?.anthropic).toBe("claude-opus-4-8");
    expect(req.reviewerModels?.openai).toBe("gpt-4o");
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "legacy",
        mode: "agent",
        repoRoot: "/repo",
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerEfforts: { anthropic: 1 },
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerEfforts: { anthropic: "banana split" },
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerModels: { opneai: "gpt-4o" },
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        primaryHarness: "",
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        primaryHarness: "   ",
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        model: "",
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        model: "   ",
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerModels: { openai: "" },
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerModels: { openai: "   " },
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        harnesses: ["codex", "   "],
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        tests: [
          { program: "pnpm", args: ["test"] },
          { program: "   ", args: [] },
        ],
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerPanel: [{ harness: "", model: "gpt" }],
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerPanel: [{ harness: "   ", model: "gpt" }],
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerPanel: [{ harness: "cursor", model: "   " }],
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerPanel: [{ harness: "cursor", effort: "TURBO BOOST" }],
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        protectedPathApprovals: [{ path: "   " }],
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        protectedPathApprovals: [{ path: "packages/**/*.test.ts", reason: "   " }],
      }),
    ).toThrow();
  });

  it("parses setup-job + spec contracts", () => {
    const jobReq = ControlSetupJobCreateRequest.parse({
      harness: "cursor",
      action: "login",
      authRequest: "subscription",
    });
    expect(jobReq).toEqual({
      harness: "cursor",
      action: "login",
      authRequest: "subscription",
      transport: "daemon",
    });
    expect(() =>
      ControlSetupJobCreateRequest.parse({ harness: "codex", action: "login" }),
    ).toThrow();
    expect(() =>
      ControlSetupJobCreateRequest.parse({
        harness: "codex",
        action: "install",
        authRequest: "subscription",
      }),
    ).toThrow();
    expect(() =>
      ControlSetupJobCreateRequest.parse({
        harness: "raw-api",
        action: "login",
        authRequest: "subscription",
      }),
    ).toThrow();
    const timestamp = new Date().toISOString();
    const job = ControlSetupJob.parse({
      jobId: "setup-1",
      harness: "cursor",
      action: "login",
      state: "waiting_for_input",
      phase: "launching",
      command: "cursor-agent login",
      guideUrl: "https://docs.cursor.com/account/agent-security",
      message: "Complete native login in the opened browser.",
      createdAt: timestamp,
      startedAt: timestamp,
      finishedAt: null,
      authCapability: {
        attemptId: "attempt-1",
        challengeDigest: "a".repeat(64),
        requestDigest: "b".repeat(64),
        disclosure: {
          schemaVersion: 1,
          protocolVersion: 1,
          harness: "cursor",
          requested: "subscription",
          requiredRoute: "vendor_native",
          requiredSource: "native_session",
          networkScope: "selected_harness_only",
          billingKnowledge: "unknown",
          incrementalCostKnowledge: "unknown",
          mayConsumeQuota: true,
          generatedAt: timestamp,
        },
        state: "disclosed",
      },
    });
    expect(job.command).toBe("cursor-agent login");
    expect(job.finishedAt).toBeNull();

    const eventBase = {
      jobId: job.jobId,
      cursor: "journal-cursor-2",
      sequence: 2,
      time: new Date().toISOString(),
      kind: "status" as const,
      state: job.state,
      message: job.message,
      job,
    };
    expect(
      ControlSetupJobEvent.parse({ ...eventBase, previousCursor: null }).previousCursor,
    ).toBeNull();
    expect(
      ControlSetupJobEvent.parse({ ...eventBase, previousCursor: "journal-cursor-1" })
        .previousCursor,
    ).toBe("journal-cursor-1");
    expect(() => ControlSetupJobEvent.parse(eventBase)).toThrow();
    expect(() =>
      ControlSetupJobEvent.parse({ ...eventBase, previousCursor: eventBase.cursor }),
    ).toThrow();
    expect(() =>
      ControlSetupJobEvent.parse({ ...eventBase, previousCursor: null, sequence: 0 }),
    ).toThrow();

    const disclosure = {
      flow: "chatgptDeviceCode" as const,
      verificationUrl: "https://chatgpt.com/device",
      userCode: "ABCD-1234",
    };
    const codexAwaiting = ControlSetupJob.parse({
      ...job,
      harness: "codex",
      phase: "awaiting_user",
      authCapability: {
        ...job.authCapability,
        disclosure: { ...job.authCapability?.disclosure, harness: "codex" },
      },
    });
    expect(
      ControlSetupJobSnapshot.parse({
        job: codexAwaiting,
        cursor: "journal-cursor-2",
        sequence: 2,
        deviceCode: disclosure,
      }).deviceCode,
    ).toEqual(disclosure);
    // `job` above is a cursor login still LAUNCHING — the phase, not the
    // vendor, is why this one is refused.
    expect(() =>
      ControlSetupJobSnapshot.parse({
        job,
        cursor: "journal-cursor-2",
        sequence: 2,
        deviceCode: disclosure,
      }),
    ).toThrow();
    // A terminal-mode claude/cursor login captures its vendor sign-in URL into
    // the SAME sidecar and discloses it as `oauth_url`. The envelope admits
    // what the producer emits: naming one vendor here 500'd the snapshot route
    // and killed the SSE stream on exactly the login this release ships.
    const oauthUrl = {
      flow: "oauth_url" as const,
      verificationUrl: "https://claude.ai/oauth/authorize?state=abc",
      userCode: "",
    };
    for (const harness of ["claude", "cursor"] as const) {
      const awaiting = ControlSetupJob.parse({
        ...job,
        harness,
        phase: "awaiting_user",
        authCapability: {
          ...job.authCapability,
          disclosure: { ...job.authCapability?.disclosure, harness },
        },
      });
      expect(
        ControlSetupJobSnapshot.parse({
          job: awaiting,
          cursor: "journal-cursor-2",
          sequence: 2,
          deviceCode: oauthUrl,
        }).deviceCode,
      ).toEqual(oauthUrl);
      expect(
        ControlSetupJobEvent.parse({
          ...eventBase,
          job: awaiting,
          state: awaiting.state,
          message: awaiting.message,
          previousCursor: null,
          deviceCode: oauthUrl,
        }).deviceCode,
      ).toEqual(oauthUrl);
      // Lifecycle eligibility still holds for every vendor.
      expect(() =>
        ControlSetupJobSnapshot.parse({
          job: { ...awaiting, phase: "verifying" },
          cursor: "journal-cursor-2",
          sequence: 2,
          deviceCode: oauthUrl,
        }),
      ).toThrow();
    }
    expect(() =>
      ControlSetupJobEvent.parse({
        ...eventBase,
        job: { ...codexAwaiting, phase: "verifying" },
        state: codexAwaiting.state,
        message: codexAwaiting.message,
        previousCursor: null,
        deviceCode: disclosure,
      }),
    ).toThrow();
    expect(() =>
      ControlSetupJobSnapshot.parse({
        job: { ...codexAwaiting, state: "not_supported", phase: "awaiting_user" },
        cursor: "journal-cursor-2",
        sequence: 2,
        deviceCode: disclosure,
      }),
    ).toThrow();
  });
});

describe("v0.9 threads / sessions / decision", () => {
  it("parses a Thread with defaults (SSOT entity)", () => {
    const t = Thread.parse({
      schema_version: 2,
      id: "th-1",
      created_at: "2026-06-12T00:00:00Z",
      updated_at: "2026-06-12T00:00:00Z",
    });
    expect(t.state).toBe("active");
    expect(t.auth_preference).toBe("auto");
    expect(t.repo).toBeNull();
    expect(t.run_ids).toEqual([]);
  });

  it("parses a Session as a re-hostable cache pointer", () => {
    const s = Session.parse({
      id: "se-1",
      thread_id: "th-1",
      harness_id: "codex",
      created_at: "2026-06-12T00:00:00Z",
      updated_at: "2026-06-12T00:00:00Z",
    });
    expect(s.native_session_id).toBeNull();
    expect(s.last_observed_model).toBeNull();
    expect(s.resume_kind).toBe("none");
    expect(s.state).toBe("live");
  });

  it("defaults a Thread to an in-place workspace", () => {
    const t = Thread.parse({
      schema_version: 2,
      id: "th-1",
      created_at: "2026-06-12T00:00:00Z",
      updated_at: "2026-06-12T00:00:00Z",
    });
    expect(t.workspace.mode).toBe("in_place");
    expect(t.workspace.worktree_path).toBeNull();
    expect(t.state).toBe("active");
  });

  it("parses a ThreadTurn with a null continuity disclosure by default", () => {
    const turn = ThreadTurn.parse({
      id: "tn-1",
      thread_id: "th-1",
      created_at: "2026-06-12T00:00:00Z",
    });
    expect(turn.kind).toBe("followup");
    expect(turn.continuity).toBeNull();
  });

  it("parses a ContinuityDisclosure and a LaneCheckpoint (INV-137)", () => {
    const disclosure = ContinuityDisclosure.parse({
      kind: "packet",
      packet_turns: 3,
      summarized: true,
      lane_switched_from: { harness_id: "codex", profile_id: null },
    });
    expect(disclosure.kind).toBe("packet");
    expect(disclosure.packet_turns).toBe(3);
    expect(disclosure.lane_switched_from?.harness_id).toBe("codex");
    const checkpoint = LaneCheckpoint.parse({
      id: "th-1::claude::default",
      thread_id: "th-1",
      harness_id: "claude",
      profile_id: null,
      turn_id: "tn-1",
      updated_at: "2026-06-12T00:00:00Z",
    });
    expect(checkpoint.turn_id).toBe("tn-1");
  });

  it("carries auth_preference + resume_session_id on a HarnessRunSpec", () => {
    const spec = HarnessRunSpec.parse({
      session_id: "se-1",
      intent: "implement",
      prompt: "go",
      cwd: "/repo",
    });
    expect(spec.auth_preference).toBe("auto");
    expect(spec.resume_session_id).toBeNull();
  });

  it("accepts thread linkage + planRunId + authPreference on a run start request", () => {
    const req = ControlRunStartRequest.parse({
      prompt: "follow up",
      mode: "agent",
      threadId: "th-1",
      parentRunId: "run-0",
      planRunId: "run-plan-1",
      authPreference: "subscription",
      protectedPathApprovals: [
        { path: "packages/**/*.test.ts", reason: "test authoring requested" },
      ],
    });
    expect(req.threadId).toBe("th-1");
    expect(req.planRunId).toBe("run-plan-1");
    expect(req.authPreference).toBe("subscription");
    expect(req.protectedPathApprovals?.[0]?.path).toBe("packages/**/*.test.ts");
    // `sessionId` was removed (it had no consumer — staged-field rule): the strict
    // DTO now rejects it LOUDLY instead of accepting a no-op field.
    expect(() =>
      ControlRunStartRequest.parse({ prompt: "x", mode: "agent", sessionId: "se-1" }),
    ).toThrow(/sessionId/);
  });

  it("validates a typed review decision (unblock) request, rejecting unknown keys", () => {
    const d = ControlRunDecisionRequest.parse({
      action: "accept_risk",
      findingIds: ["f-1"],
      acceptedRisks: ["protected path"],
    });
    expect(d.action).toBe("accept_risk");
    expect(d.findingIds).toEqual(["f-1"]);
    expect(() => ControlRunDecisionRequest.parse({ action: "bogus" })).toThrow();
    expect(() => ControlRunDecisionRequest.parse({ action: "apply", surprise: 1 })).toThrow();
  });

  it("projects a ControlThread with a needs-me flag", () => {
    const ct = ControlThread.parse({
      id: "th-1",
      createdAt: "x",
      updatedAt: "y",
      needsHuman: true,
    });
    expect(ct.needsHuman).toBe(true);
    expect(ct.authPreference).toBe("auto");
    expect(ct.state).toBe("active");
  });

  it("defaults the convergence fields on a TaskContract", () => {
    const tc = TaskContract.parse({
      task_id: "t-1",
      created_at: "2026-06-12T00:00:00Z",
      repo: { root: "/repo", base_ref: "main" },
      schema_version: 2,
      mode: { kind: "agent" },
      user_intent: { raw: "do the thing" },
    });
    expect(tc.convergence.require_no_accepted_needs_human_open).toBe(true);
  });
});

describe("CredentialProfile validation (INV-135)", () => {
  const base = {
    profile_id: "work",
    harness_id: "claude",
    display_name: "Work",
    enabled: true,
  };

  it("config_dir_login requires isolation_locator and refuses secret_ref", () => {
    expect(
      CredentialProfile.safeParse({
        ...base,
        credential_kind: "config_dir_login",
        isolation_locator: "/abs/dir",
      }).success,
    ).toBe(true);
    expect(
      CredentialProfile.safeParse({ ...base, credential_kind: "config_dir_login" }).success,
    ).toBe(false);
    expect(
      CredentialProfile.safeParse({
        ...base,
        credential_kind: "config_dir_login",
        isolation_locator: "/abs/dir",
        secret_ref: "claude_oauth:work",
      }).success,
    ).toBe(false);
  });

  it("secret-ref kinds require secret_ref and refuse isolation_locator", () => {
    expect(
      CredentialProfile.safeParse({
        ...base,
        credential_kind: "oauth_token",
        secret_ref: "claude_oauth:work",
      }).success,
    ).toBe(true);
    expect(CredentialProfile.safeParse({ ...base, credential_kind: "api_key" }).success).toBe(
      false,
    );
    expect(
      CredentialProfile.safeParse({
        ...base,
        credential_kind: "api_key",
        secret_ref: "anthropic:work",
        isolation_locator: "/abs/dir",
      }).success,
    ).toBe(false);
  });

  it("secret_ref must be NAMESPACED — a bare engine-default slot is refused (round-15 #5)", () => {
    // A bare managed name (the engine-default slot) would silently alias the
    // default credential; profiles are ADDITIVE identities.
    for (const bare of ["anthropic", "claude_oauth", "openai", "cursor"]) {
      const parsed = CredentialProfile.safeParse({
        ...base,
        credential_kind: bare === "claude_oauth" ? "oauth_token" : "api_key",
        secret_ref: bare,
      });
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain("namespaced");
    }
    // Unmanaged bases and malformed suffixes are refused by the same grammar.
    expect(
      CredentialProfile.safeParse({
        ...base,
        credential_kind: "api_key",
        secret_ref: "bogus:work",
      }).success,
    ).toBe(false);
    expect(
      CredentialProfile.safeParse({
        ...base,
        credential_kind: "api_key",
        secret_ref: "anthropic:",
      }).success,
    ).toBe(false);
    // The namespaced form stays valid.
    expect(
      CredentialProfile.safeParse({
        ...base,
        credential_kind: "api_key",
        secret_ref: "anthropic:acc-2",
      }).success,
    ).toBe(true);
  });

  it("the config registry refuses duplicate (harness, profile) ids", () => {
    const entry = {
      ...base,
      credential_kind: "config_dir_login",
      isolation_locator: "/abs/dir",
    };
    const dup = GlobalConfig.safeParse({ credential_profiles: [entry, entry] });
    expect(dup.success).toBe(false);
    const distinct = GlobalConfig.safeParse({
      credential_profiles: [
        entry,
        { ...entry, harness_id: "codex", isolation_locator: "/abs/other" },
      ],
    });
    expect(distinct.success).toBe(true);
  });

  it("profile_policy.limit_action: ABSENT parses to the A6 'auto' stored default; explicit values are never reinterpreted (3=A)", () => {
    const absent = GlobalConfig.parse({ harnesses: { claude: {} } });
    expect(absent.harnesses["claude"]?.profile_policy.limit_action).toBe("auto");
    for (const limit_action of ["auto", "fail", "ask", "rotate"] as const) {
      const cfg = GlobalConfig.parse({
        harnesses: { claude: { profile_policy: { limit_action } } },
      });
      expect(cfg.harnesses["claude"]?.profile_policy.limit_action).toBe(limit_action);
    }
  });

  it("the config registry refuses two rows sharing one isolation_locator (unified account model)", () => {
    // One dir = one credential: two names for the same store would make
    // deletion, routing, and quota attribution ambiguous — including across
    // harnesses (deleting one row's material would gut the other row).
    const entry = {
      ...base,
      credential_kind: "config_dir_login",
      isolation_locator: "/abs/dir",
    };
    const sharedAcrossIds = GlobalConfig.safeParse({
      credential_profiles: [entry, { ...entry, profile_id: "other" }],
    });
    expect(sharedAcrossIds.success).toBe(false);
    expect(JSON.stringify(sharedAcrossIds.error?.issues)).toContain("share isolation_locator");
    const sharedAcrossHarnesses = GlobalConfig.safeParse({
      credential_profiles: [entry, { ...entry, harness_id: "codex" }],
    });
    expect(sharedAcrossHarnesses.success).toBe(false);
    // Secret-ref rows carry no locator and stay unconstrained by this rule.
    const secretRefRows = GlobalConfig.safeParse({
      credential_profiles: [
        { ...base, credential_kind: "api_key", secret_ref: "anthropic:acc-1" },
        {
          ...base,
          profile_id: "other",
          credential_kind: "api_key",
          secret_ref: "anthropic:acc-2",
        },
      ],
    });
    expect(secretRefRows.success).toBe(true);
  });
});

describe("SetupLoginAbsolutePath (cross-platform absolute paths)", () => {
  const accepted = [
    "/var/run/job",
    "/Users/user/.codex",
    "/a",
    "C:\\Users\\user\\AppData\\Local\\claudexor",
    "c:\\program files\\codex\\bin\\codex.exe",
    "C:/Users/user/AppData/Local/claudexor",
    "\\\\server\\share\\jobDir",
    "//server/share/jobDir",
  ];
  const refused = [
    "relative/path",
    "./relative",
    "../parent",
    "runner-state.json",
    // Drive- and root-relative spellings resolve against per-process state.
    "C:relative\\without\\slash",
    "d:foo/bar",
    "\\Windows\\System32\\cmd.exe",
    "",
    "   ",
    "/path/with/\0/nullbyte",
    "C:\\path\\with\0null",
  ];

  it("accepts POSIX, drive-rooted and UNC paths and refuses the rest", () => {
    for (const path of accepted) {
      expect(SetupLoginProtocol.SetupLoginAbsolutePath.safeParse(path).success).toBe(true);
    }
    for (const path of refused) {
      expect(SetupLoginProtocol.SetupLoginAbsolutePath.safeParse(path).success).toBe(false);
    }
  });

  it("applies the same rule to executable evidence realpaths", () => {
    const evidence = {
      realpath: "/usr/local/bin/codex",
      sha256: "0".repeat(64),
      size: 1024,
      mode: 0o755,
      device: "123",
      inode: "456",
    };
    expect(SetupExecutableEvidence.safeParse(evidence).success).toBe(true);
    expect(
      SetupExecutableEvidence.safeParse({
        ...evidence,
        realpath: "C:\\Program Files\\Codex\\codex.exe",
      }).success,
    ).toBe(true);
    expect(
      SetupExecutableEvidence.safeParse({ ...evidence, realpath: "./codex.exe" }).success,
    ).toBe(false);
  });

  it("survives schema generation as a JSON Schema pattern, not a refinement", () => {
    // A `.refine()` is invisible to schema:gen, so every wire consumer would
    // silently accept relative paths; the regex is the shared contract.
    expect(SetupLoginProtocol.ABSOLUTE_PATH_PATTERN.test("C:\\x")).toBe(true);
    expect(SetupLoginProtocol.ABSOLUTE_PATH_PATTERN.test("C:x")).toBe(false);
  });
});
