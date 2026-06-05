import type {
  ConformanceReport,
  HarnessEvent,
  HarnessManifest,
  HarnessRunSpec,
  ProviderFamily,
} from "@claudex/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudex/core";
import { nowIso } from "@claudex/util";

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
    version: "0.1.0",
    adapter_version: "0.1.0",
    provider_family: provider,
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
      plugins: false,
      worktree_native: false,
      quota_signal: id === "fake-rate-limit" ? "observed" : "unknown",
      usage_signal: "exact",
    },
    auth_modes: ["local_session"],
    access_profiles_supported: ["readonly", "workspace_write", "full"],
    models: { discovery: "available" },
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
    case "fake-fail-tests":
      yield ev(s, "message", { text: "Attempted a fix." });
      yield ev(s, "file_change", { payload: { path: "BROKEN.txt", action: "modify" } });
      yield ev(s, "error", { error: "tests failed: 2 failing" });
      return;
    case "fake-invalid-json":
      yield ev(s, "error", { error: "AdapterParseError: harness emitted unparseable output" });
      return;
    case "fake-timeout":
      yield ev(s, "thinking", { text: "..." });
      yield ev(s, "error", { error: "timeout after 0ms (simulated)" });
      return;
    case "fake-rate-limit":
      yield ev(s, "error", {
        error: "rate limited",
        payload: { resets_at: new Date(Date.now() + 3600_000).toISOString() },
      });
      return;
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
        enabled_intents: degraded ? ["implement"] : ["plan", "implement", "review", "verify"],
        disabled_intents: degraded ? ["review", "arbitrate"] : [],
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
