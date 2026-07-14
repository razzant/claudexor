import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ConformanceReport,
  HarnessEvent,
  HarnessManifest,
  HarnessRunSpec,
  Intent,
  ProviderFamily,
} from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import { CLAUDEXOR_VERSION, nowIso } from "@claudexor/util";

export type FakeKind =
  | "fake-success"
  | "fake-implement"
  | "fake-fail-tests"
  | "fake-invalid-json"
  | "fake-timeout"
  | "fake-hang"
  | "fake-rate-limit"
  | "fake-same-model-fallback"
  | "fake-reviewer-without-evidence";

export const FAKE_KINDS: FakeKind[] = [
  "fake-success",
  "fake-implement",
  "fake-fail-tests",
  "fake-invalid-json",
  "fake-timeout",
  "fake-hang",
  "fake-rate-limit",
  "fake-same-model-fallback",
  "fake-reviewer-without-evidence",
];

/**
 * A minimal, schema-valid orchestration plan the `fake-implement` kind emits for
 * the `orchestrate` intent, so the orchestrate planner -> plan-extraction ->
 * (with autonomy) executor path is exercisable offline/deterministically. The
 * fenced ```json block is what `extractOrchestratePlan` parses.
 */
const FAKE_ORCHESTRATE_PLAN = [
  "## Orchestration plan",
  "1. start_run — kick off a single agent run for the goal.",
  "",
  "```json",
  '{"tool_calls":[{"tool":"start_run","prompt":"deterministic fake-implement plan","mode":"agent","why":"offline orchestration fixture"}]}',
  "```",
].join("\n");

/** Producing intents write a real file so the run->apply->deliver chain has a diff. */
const PRODUCING_INTENTS = new Set<Intent>(["implement", "create_from_scratch", "repair"]);

export interface FakeOptions {
  provider?: ProviderFamily;
  observedModel?: string;
}

function ev(
  sessionId: string,
  type: HarnessEvent["type"],
  extra: Partial<HarnessEvent> = {},
): HarnessEvent {
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
      auth: {
        supported_sources: ["none"],
        preferred_source: "none",
        credential_transports: [{ source: "none", kind: "none", relocatable_by: ["none"] }],
      },
      access_control: { readonly_mechanism: "none" },
      isolation: { supported_containment: ["env_or_file_injection"] },
      image_input: "none",
    },
    capabilities: {
      plan: true,
      implement: true,
      create_from_scratch: true,
      review: true,
      verify: true,
      synthesize: true,
      read_files: true,
      browser_tool: false,
      web_policy: "none",
      max_turns: false,
      tool_lists: false,
      interactive: false,
      json_schema_output: false,
      orchestrate: true,
      // Partial ladder: a deliberate clamp fixture for the effort normalizer
      // (requests for xhigh/max clamp down to high).
      effort_levels: ["low", "medium", "high"],
      // Small manifest truth source so strict model-truth tests can exercise BOTH the
      // accept path (fake-model) and the typed-refusal path (anything else).
      known_models: ["fake-model", "fake-model-alt"],
      known_models_verified_against: null,
    },
    auth_modes: ["none"],
    access_profiles_supported: ["readonly", "workspace_write", "full"],
  };
}

async function* runFake(
  kind: FakeKind,
  spec: HarnessRunSpec,
  observedModel: string,
): AsyncIterable<HarnessEvent> {
  const s = spec.session_id;
  yield ev(s, "started", { observed_model: observedModel });
  switch (kind) {
    case "fake-success":
      // Prompt-free deterministic text: the raw prompt must never be echoed into a
      // persisted message/answer artifact (BIBLE §6 — secrets never become artifacts).
      yield ev(s, "message", { text: "Implemented by the fake harness." });
      yield ev(s, "file_change", { payload: { path: "FAKE_CHANGE.txt", action: "create" } });
      yield ev(s, "usage", { usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.01 } });
      yield ev(s, "completed", { observed_model: observedModel });
      return;
    case "fake-implement":
      // Unlike fake-success (which only emits a file_change EVENT and stays a
      // no_op fixture), fake-implement makes the engine's write/apply/orchestrate
      // chains testable offline:
      //  - orchestrate intent -> a schema-valid fenced plan (orchestrate coverage);
      //  - producing intents   -> a REAL file written into the worktree so
      //    `git add -A && git diff` yields a patch (apply/commit/branch chain).
      if (spec.intent === "orchestrate") {
        yield ev(s, "message", { text: FAKE_ORCHESTRATE_PLAN });
        yield ev(s, "completed", { observed_model: observedModel });
        return;
      }
      yield ev(s, "message", { text: "Implemented by the fake harness." });
      // Only WRITE for producing intents AND when the run is not read-only (a fake
      // must not mutate a readonly envelope, mirroring real access enforcement).
      if (PRODUCING_INTENTS.has(spec.intent) && spec.access !== "readonly") {
        // Diffs come from git in the worktree, never invented by the adapter.
        // Write DETERMINISTIC fixture content — NOT the prompt: a secret-bearing
        // prompt must never land in a worktree file / diff / patch artifact
        // (BIBLE §6). Best-effort: a non-writable cwd yields an empty diff (no_op).
        let wrote = false;
        try {
          writeFileSync(join(spec.cwd, "FAKE_CHANGE.txt"), "fake-implement deterministic change\n");
          wrote = true;
        } catch {
          /* non-writable cwd -> empty diff -> no_op */
        }
        // Only CLAIM a file_change once the file actually exists (no typed
        // file_change event without on-disk evidence).
        if (wrote)
          yield ev(s, "file_change", { payload: { path: "FAKE_CHANGE.txt", action: "create" } });
      }
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
    case "fake-hang": {
      // Conformance fixture for the INACTIVITY WATCHDOG: one event,
      // then silence forever (until aborted). The deliberate exception to the
      // fakes' always-completed rule — a wedged CLI emits no terminal either.
      yield ev(s, "thinking", { text: "working... (and now silently wedged)" });
      const abort = spec.extra?.["abortSignal"] as AbortSignal | undefined;
      await new Promise<void>((resolve) => {
        if (abort?.aborted) return resolve();
        abort?.addEventListener("abort", () => resolve(), { once: true });
        // No timer: without an abort this hangs forever, like the real bug.
      });
      return;
    }
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
      // fake-implement is the deterministic offline fixture for the create,
      // orchestrate, and write->apply chains, so it enables those intents; the
      // other ok fakes keep the original read-only-ish set.
      const enabledIntents: Intent[] = degraded
        ? ["implement"]
        : kind === "fake-implement"
          ? [
              "plan",
              "implement",
              "create_from_scratch",
              "repair",
              "review",
              "verify",
              "synthesize",
              "explain",
              "audit",
              "orchestrate",
            ]
          : ["plan", "implement", "review", "verify", "explain", "audit"];
      return {
        harness_id: kind,
        status: degraded ? "degraded" : "ok",
        checks: [
          { id: "installed", status: "pass" },
          { id: "structured_output", status: degraded ? "fail" : "pass" },
        ],
        enabled_intents: enabledIntents,
        disabled_intents: degraded ? ["review", "explain", "audit"] : [],
        reasons: degraded ? ["structured_output_parse_failed"] : [],
        auth_sources: [],
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
