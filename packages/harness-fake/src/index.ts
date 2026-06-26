import type {
  ConformanceReport,
  HarnessEvent,
  HarnessManifest,
  HarnessRunSpec,
  ProviderFamily,
} from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import { CLAUDEXOR_VERSION, nowIso } from "@claudexor/util";

export type FakeKind =
  | "fake-success"
  | "fake-fail-tests"
  | "fake-invalid-json"
  | "fake-timeout"
  | "fake-rate-limit"
  | "fake-same-model-fallback"
  | "fake-reviewer-without-evidence";

export const FAKE_KINDS: FakeKind[] = [
  "fake-success",
  "fake-fail-tests",
  "fake-invalid-json",
  "fake-timeout",
  "fake-rate-limit",
  "fake-same-model-fallback",
  "fake-reviewer-without-evidence",
];

export interface FakeOptions {
  provider?: ProviderFamily;
  observedModel?: string;
}

function ev(sessionId: string, type: HarnessEvent["type"], extra: Partial<HarnessEvent> = {}): HarnessEvent {
  return { type, session_id: sessionId, ts: nowIso(), ...extra };
}

function buildManifest(id: string, provider: ProviderFamily): HarnessManifest {
  return {
    id,
    display_name: `Fake (${id})`,
    kind: "fake",
    version: CLAUDEXOR_VERSION,
    adapter_version: CLAUDEXOR_VERSION,
    provider_family: provider,
    capability_profile: {
      execution_surfaces: [{
        kind: "cli_one_shot",
        input: "prompt_arg",
        output: "ndjson",
        event_schema: "versioned",
        supports_followup: false,
        supports_interrupt: false,
        supports_permission_reply: false,
      }],
      session: {
        native_session_id_emitted: false,
        resume_latest: false,
        resume_by_id: false,
        fork: false,
        list: false,
        logs: false,
        attach_tui: false,
        export: false,
        diff: false,
      },
      output: {
        ndjson_events: true,
        partial_deltas: false,
        tool_lifecycle: false,
        file_changes: true,
        final_json: false,
        json_schema_final: id !== "fake-invalid-json",
        usage_signal: "exact",
        cost_signal: "exact",
      },
      auth: { supported_sources: ["none"], preferred_source: "none", probe_command: [], env_vars: [], can_scrub_env: true },
      access_control: { readonly: true, workspace_write: true, full: true, mechanism: "fake", conformance_required: false },
      image_input: "none",
    },
    capabilities: {
      plan: true,
      spec: true,
      implement: true,
      create_from_scratch: true,
      repair: true,
      review: true,
      verify: true,
      compare: true,
      synthesize: true,
      shell: false,
      read_files: true,
      edit_files: true,
      apply_patch: true,
      structured_events: true,
      structured_output: id !== "fake-invalid-json",
      json_schema_output: id !== "fake-invalid-json",
      resume: false,
      cancel: true,
      mcp: false,
      browser_tool: false,
      plugins: false,
      worktree_native: false,
      web_policy: "none",
      max_turns: false,
      tool_lists: false,
      interactive: false,
      orchestrate: true,
      quota_signal: id === "fake-rate-limit" ? "observed" : "unknown",
      usage_signal: "exact",
      // Partial ladder: a deliberate clamp fixture for the effort normalizer
      // (requests for xhigh/max clamp down to high).
      effort_levels: ["low", "medium", "high"],
      known_models: [],
      models_authoritative: false,
    },
    auth_modes: ["none"],
    access_profiles_supported: ["readonly", "workspace_write", "full"],
  };
}

async function* runFake(kind: FakeKind, spec: HarnessRunSpec, observedModel: string): AsyncIterable<HarnessEvent> {
  const s = spec.session_id;
  yield ev(s, "started", { observed_model: observedModel });
  switch (kind) {
    case "fake-success":
      yield ev(s, "message", { text: `Implemented: ${spec.prompt}` });
      yield ev(s, "file_change", { payload: { path: "FAKE_CHANGE.txt", action: "create" } });
      yield ev(s, "usage", { usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.01 } });
      yield ev(s, "completed", { observed_model: observedModel });
      return;
    case "fake-reviewer-without-evidence":
      yield ev(s, "message", { text: "I think there might be a bug somewhere (no evidence)." });
      yield ev(s, "completed", { observed_model: observedModel });
      return;
    case "fake-same-model-fallback":
      yield ev(s, "message", { text: "Output from the (silently) same model." });
      yield ev(s, "completed", { observed_model: observedModel });
      return;
    // Error kinds still END with `completed`: the shared CLI run loop guarantees
    // a terminal completed for every real adapter, and the fakes are the
    // conformance fixtures for that contract (failure truth lives in `error`
    // events + gates, not in a missing terminal event).
    case "fake-fail-tests":
      yield ev(s, "message", { text: "Attempted a fix." });
      yield ev(s, "file_change", { payload: { path: "BROKEN.txt", action: "modify" } });
      yield ev(s, "error", { error: "tests failed: 2 failing" });
      yield ev(s, "completed", { observed_model: observedModel });
      return;
    case "fake-invalid-json":
      yield ev(s, "error", { error: "AdapterParseError: harness emitted unparseable output" });
      yield ev(s, "completed", { observed_model: observedModel });
      return;
    case "fake-timeout":
      yield ev(s, "thinking", { text: "..." });
      yield ev(s, "error", { error: "timeout after 0ms (simulated)" });
      yield ev(s, "completed", { observed_model: observedModel });
      return;
    case "fake-rate-limit": {
      // Positive conformance fixture for the budget cooldown path: a TYPED
      // rate_limit signal (not just prose) so the budget layer can read
      // ev.rate_limit without regex over the error text.
      const resetsAt = new Date(Date.now() + 3600_000).toISOString();
      yield ev(s, "error", {
        error: "rate limited",
        rate_limit: { resets_at: resetsAt, retry_delay_ms: 2500 },
        payload: { resets_at: resetsAt },
      });
      yield ev(s, "completed", { observed_model: observedModel });
      return;
    }
  }
}

/** Construct a deterministic fake harness adapter of the given kind. */
export function createFakeHarness(kind: FakeKind, opts: FakeOptions = {}): HarnessAdapter {
  const provider: ProviderFamily = opts.provider ?? "local";
  const observedModel = opts.observedModel ?? `${kind}-model`;
  return {
    id: kind,
    async discover(): Promise<HarnessManifest> {
      return buildManifest(kind, provider);
    },
    async doctor(_spec: DoctorSpec): Promise<ConformanceReport> {
      const degraded = kind === "fake-invalid-json";
      return {
        harness_id: kind,
        status: degraded ? "degraded" : "ok",
        checks: [
          { id: "installed", status: "pass" },
          { id: "structured_output", status: degraded ? "fail" : "pass" },
        ],
        enabled_intents: degraded ? ["implement"] : ["plan", "implement", "review", "verify", "explain", "audit"],
        disabled_intents: degraded ? ["review", "arbitrate", "explain", "audit"] : [],
        reasons: degraded ? ["structured_output_parse_failed"] : [],
      };
    },
    run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runFake(kind, spec, observedModel);
    },
    review(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runFake(kind, spec, observedModel);
    },
    async cancel(): Promise<void> {
      /* no-op for fakes */
    },
  };
}
