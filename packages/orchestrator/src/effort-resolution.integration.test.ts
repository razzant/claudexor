import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  HarnessModel,
  HarnessRunSpec,
  RunTelemetry,
  TaskContract,
  SCHEMA_VERSION,
  HarnessEvent,
} from "@claudexor/schema";
import { createCodexAdapter, clearCodexEffortCache } from "../../harness-codex/src/index.js";
import { readModelListEfforts } from "../../harness-codex/src/effort-probe.js";
import { createClaudeAdapter } from "../../harness-claude/src/index.js";
import {
  legacyCodexProcessing,
  prepareCodexProcessing,
} from "../../harness-codex/src/processing.js";
import { prepareClaudeProcessing } from "../../harness-claude/src/processing.js";
import { prepareCursorProcessing } from "../../harness-cursor/src/processing.js";
import { createAttemptTelemetry, observeAttemptTelemetry } from "./attemptTelemetry.js";
import { writeRunTelemetryArtifact } from "./runTelemetryWriter.js";
import effortFixture from "../../schema/fixtures/effort-resolution.json" with { type: "json" };

function persist(events: HarnessEvent[], harnessId: string, requestedModel: string | null = null) {
  const root = mkdtempSync(join(tmpdir(), "effort-artifact-"));
  try {
    const store = new ArtifactStore(root, { claudexorDir: root });
    const paths = store.createRun("run");
    const telemetry = createAttemptTelemetry("off", false, "off", [], requestedModel);
    for (const event of events) observeAttemptTelemetry(telemetry, event);
    writeRunTelemetryArtifact({
      store,
      finalDir: paths.finalDir,
      contract: TaskContract.parse({
        schema_version: SCHEMA_VERSION,
        task_id: "task",
        created_at: new Date(0).toISOString(),
        repo: { root, base_ref: "main" },
        mode: { kind: "ask" },
        user_intent: { raw: "fixture" },
      }),
      runId: "run",
      taskId: "task",
      mode: "ask",
      finalAttemptId: "attempt",
      attempts: [{ attemptId: "attempt", harnessId, telemetry }],
      resolveAuthPreference: () => "auto",
    });
    return RunTelemetry.parse(store.readYaml(join(paths.finalDir, "telemetry.yaml")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("round-trips the canonical contract fixture through final telemetry without retaining an earlier observation", () => {
  const event = { type: "status", session_id: "fixture", ts: new Date(0).toISOString() };
  // Synthetic wire fixtures test the consumer independently of native producers.
  const events = [
    HarnessEvent.parse({
      ...event,
      effort_resolution: { ...effortFixture, observed: "high", observedSource: "fixture.echo" },
    }),
    HarnessEvent.parse({ ...event, effort_resolution: effortFixture }),
  ];
  expect(persist(events, "codex").attempts[0]?.effort_resolution).toEqual(effortFixture);
});

it.each([{ requested: "future", submitted: "future", resolution: "exact" }, effortFixture])(
  "keeps $requested through preflight and persists final native evidence",
  async (expected) => {
    clearCodexEffortCache();
    let sent: string[] = [];
    const adapter = createCodexAdapter({
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      hasApiKey: () => false,
      probeEfforts: async () => ({
        defaultModel: "target",
        models: {
          target: { levels: ["low", "xhigh", "future"], default: "low" },
          sibling: { levels: ["low", "xhigh", "ultra", "future"], default: "low" },
        },
      }),
      runCliHarness: async function* (opts) {
        sent = opts.args;
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: new Date(0).toISOString(),
        };
      },
    });
    // Preflight carries the preference to the route unchanged — discovery only
    // describes the default account — so the spec holds exactly what was asked.
    const spec = HarnessRunSpec.parse({
      session_id: "session",
      intent: "explain",
      cwd: process.cwd(),
      prompt: "fixture",
      model_hint: "target",
      effort_hint: expected.requested,
    });
    const events = [];
    for await (const event of adapter.run(spec)) events.push(event);
    expect(sent).toContain(`model_reasoning_effort="${expected.submitted}"`);
    expect(persist(events, "codex").attempts[0]?.effort_resolution).toEqual({
      ...expected,
      source: "live_probe",
      parameter: "model_reasoning_effort",
      observed: null,
      observedSource: null,
    });
    expect(events.some((event) => event.type === "message")).toBe(false);
    clearCodexEffortCache();
  },
);

it("uses Claude's known vendor order below a missing level, logs it, and persists it in final telemetry", async () => {
  let sent: string[] = [];
  const adapter = createClaudeAdapter({
    probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "ok" }),
    probeAuthStatus: async () => ({
      loggedIn: true,
      authed: true,
      authMethod: "claude.ai",
      probeError: null,
    }),
    anthropicApiKey: () => null,
    claudeOAuthToken: () => null,
    probeEffortLevels: async () => ({ levels: ["low", "max"], live: true }),
    runCliHarness: async function* (opts) {
      sent = opts.args;
      yield { type: "completed", session_id: opts.spec.session_id, ts: new Date(0).toISOString() };
    },
  });
  const spec = HarnessRunSpec.parse({
    session_id: "session",
    intent: "explain",
    cwd: process.cwd(),
    prompt: "fixture",
    effort_hint: "xhigh",
  });
  const events = [];
  for await (const event of adapter.run(spec)) events.push(event);
  expect(sent[sent.indexOf("--effort") + 1]).toBe("low");
  expect(persist(events, "claude").attempts[0]).toMatchObject({
    effort_resolution: {
      requested: "xhigh",
      submitted: "low",
      resolution: "downward",
      parameter: "--effort",
      observed: null,
    },
  });
  expect(events.some((event) => event.type === "message")).toBe(false);
});

it.each([true, false])(
  "distinguishes known empty capability from unverifiable proof (live=%s)",
  async (live) => {
    let sent: string[] = [];
    const adapter = createClaudeAdapter({
      detectVersion: async () => "0.0.0",
      probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "ok" }),
      probeAuthStatus: async () => ({
        loggedIn: true,
        authed: true,
        authMethod: "claude.ai",
        probeError: null,
      }),
      anthropicApiKey: () => null,
      claudeOAuthToken: () => null,
      probeEffortLevels: async () => ({ levels: live ? [] : ["low", "high"], live }),
      runCliHarness: async function* (opts) {
        sent = opts.args;
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: new Date(0).toISOString(),
        };
      },
    });
    const spec = HarnessRunSpec.parse({
      session_id: "session",
      intent: "explain",
      cwd: process.cwd(),
      prompt: "fixture",
      effort_hint: "high",
    });
    const events = [];
    for await (const event of adapter.run(spec)) events.push(event);
    expect(sent).not.toContain("--effort");
    expect(persist(events, "claude").attempts[0]).toMatchObject({
      effort_resolution: {
        requested: "high",
        submitted: null,
        resolution: live ? "omitted" : "unverifiable",
        source: live ? "live_probe" : "adapter",
        observed: null,
      },
    });
  },
);

it("records omission for a route with no effort carrier at all, without rewriting its model", async () => {
  const { runModelGovernedRoute } = await import("./modelGovernance.js");
  const slug = "cursor-grok-4.6-xhigh";
  let observedSpec: HarnessRunSpec | undefined;
  const adapter = {
    id: "compound",
    discover: async () => {
      throw new Error("unneeded discovery");
    },
    doctor: async () => {
      throw new Error("unneeded doctor");
    },
    run: async function* (spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      observedSpec = spec;
      yield { type: "completed", session_id: spec.session_id, ts: new Date(0).toISOString() };
    },
  };
  const spec = HarnessRunSpec.parse({
    session_id: "compound",
    intent: "explain",
    cwd: process.cwd(),
    prompt: "fixture",
    model_hint: slug,
    effort_hint: "low",
  });
  const events = [];
  for await (const event of runModelGovernedRoute(
    {
      adapter,
      knownModels: [slug],
      authRouteEstimate: null,
      quotaAdmission: { profile: null },
      settings: null,
    },
    spec,
  ))
    events.push(event);
  expect(observedSpec?.model_hint).toBe(slug);
  expect(persist(events, "compound").attempts[0]).toMatchObject({
    effort_resolution: {
      requested: "low",
      submitted: null,
      resolution: "omitted",
      source: "adapter",
      parameter: null,
      observed: null,
      observedSource: null,
    },
  });
});

it.each([true, false])(
  "keeps explicit empty versus missing native model effort metadata (empty=%s)",
  async (empty) => {
    clearCodexEffortCache();
    let sent: string[] = [];
    const adapter = createCodexAdapter({
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      hasApiKey: () => false,
      probeEfforts: async () =>
        readModelListEfforts([
          { id: "target", isDefault: true, ...(empty ? { supportedReasoningEfforts: [] } : {}) },
          {
            id: "sibling",
            supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
          },
        ]),
      runCliHarness: async function* (opts) {
        sent = opts.args;
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: new Date(0).toISOString(),
        };
      },
    });
    const spec = HarnessRunSpec.parse({
      session_id: "session",
      intent: "explain",
      cwd: process.cwd(),
      prompt: "fixture",
      model_hint: "target",
      effort_hint: "high",
    });
    const events = [];
    for await (const event of adapter.run(spec)) events.push(event);
    expect(sent.some((arg) => arg.startsWith("model_reasoning_effort="))).toBe(false);
    expect(persist(events, "codex").attempts[0]?.effort_resolution).toMatchObject({
      requested: "high",
      submitted: null,
      resolution: empty ? "omitted" : "unverifiable",
      observed: null,
      observedSource: null,
    });
    clearCodexEffortCache();
  },
);

/** Frozen `cursor@valintine` slice: the grok-4.7 family, standard and fast. */
const GROK_47 = [
  "grok-4.7-low",
  "grok-4.7-medium",
  "grok-4.7-high",
  "grok-4.7-xhigh",
  "grok-4.7-low-fast",
  "grok-4.7-medium-fast",
  "grok-4.7-high-fast",
  "grok-4.7-xhigh-fast",
].map((id) => HarnessModel.parse({ id }));

it("a model-id effort carrier: ONE prepared result feeds --model, the processing receipt and the effort receipt", async () => {
  const { runModelGovernedRoute } = await import("./modelGovernance.js");
  const { createCursorAdapter } = await import("../../harness-cursor/src/index.js");
  let sent: string[] = [];
  let observedSpec: HarnessRunSpec | undefined;
  const adapter = createCursorAdapter({
    cursorApiKey: () => "fixture-key",
    smokeIsolatedApiKey: async () => ({ ok: true, detail: "fixture" }),
    listCursorModels: async () => GROK_47,
    runCliHarness: async function* (opts) {
      sent = opts.args;
      observedSpec = opts.spec;
      // The vendor init frame, through the adapter's own parser (which stamps
      // the processing receipt on every event), then the terminal frame.
      yield* (
        opts.parseEvent(
          { type: "system", subtype: "init", model: "grok-4.7-xhigh" },
          opts.spec.session_id,
        ) ?? []
      );
      yield { type: "completed", session_id: opts.spec.session_id, ts: new Date(0).toISOString() };
    },
  });
  const spec = HarnessRunSpec.parse({
    session_id: "cursor-effort",
    intent: "explain",
    cwd: process.cwd(),
    prompt: "fixture",
    auth_preference: "api_key",
    model_hint: "grok-4.7-high",
    effort_hint: "max",
  });
  const events: HarnessEvent[] = [];
  for await (const event of runModelGovernedRoute(
    {
      adapter,
      knownModels: [],
      modelInventory: { model_inventory_absence: "advisory" },
      authRouteEstimate: "api_key",
      quotaAdmission: { profile: null },
      settings: null,
    },
    spec,
  ))
    events.push(event);
  // argv == processing.submittedNative == the prepared model; the caller's hint is untouched.
  expect(sent[sent.indexOf("--model") + 1]).toBe("grok-4.7-xhigh");
  expect(observedSpec?.model_hint).toBe("grok-4.7-high");
  expect(observedSpec?.effort_hint).toBe("max");
  expect(observedSpec?.processing?.submittedNative).toBe("grok-4.7-xhigh");
  // Exactly ONE effort receipt, the preparation's own — no second engine `omitted`.
  const receipts = events.filter((event) => event.effort_resolution);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]?.effort_resolution).toMatchObject({
    requested: "max",
    submitted: "xhigh",
    resolution: "downward",
    parameter: "--model",
    source: "account_catalog",
    observed: null,
  });
  expect(receipts[0]?.payload?.["ignored_settings"]).toEqual([
    expect.stringContaining("effort=max: downward; submitted=xhigh"),
  ]);
  const telemetry = persist(events, "cursor", "grok-4.7-high");
  const attempt = telemetry.attempts[0];
  // What Ouroboros reads: requested id, final id, level receipt, no false mismatch.
  expect(attempt?.requested_model).toBe("grok-4.7-high");
  expect(attempt?.processing?.submittedNative).toBe("grok-4.7-xhigh");
  expect(attempt?.effort_resolution).toMatchObject({ requested: "max", submitted: "xhigh" });
  expect(attempt?.observed_model).toBe("grok-4.7-xhigh");
  expect(telemetry.auth_route?.model_mismatch).toBeNull();
});

it("model_mismatch compares the observation with the SUBMITTED id, not the caller's hint", () => {
  const base = { type: "status", session_id: "mm", ts: new Date(0).toISOString() };
  const prepared = prepareCursorProcessing(undefined, "grok-4.7-high", GROK_47, true, "max");
  const processing = prepared.receipt;
  const effort = HarnessEvent.parse({ ...base, effort_resolution: prepared.effort });
  const agreeing = [
    effort,
    HarnessEvent.parse({ ...base, type: "started", observed_model: "grok-4.7-xhigh", processing }),
    HarnessEvent.parse({ ...base, type: "completed", processing }),
  ];
  expect(persist(agreeing, "cursor", "grok-4.7-high").auth_route?.model_mismatch).toBeNull();
  const drifting = [
    effort,
    HarnessEvent.parse({ ...base, type: "started", observed_model: "grok-4.7-medium", processing }),
    HarnessEvent.parse({ ...base, type: "completed", processing }),
  ];
  expect(persist(drifting, "cursor", "grok-4.7-high").auth_route?.model_mismatch).toEqual({
    requested: "grok-4.7-xhigh",
    observed: "grok-4.7-medium",
  });
  // Without a processing receipt the requested hint is still the sent id.
  const plain = [
    HarnessEvent.parse({ ...base, type: "started", observed_model: "model-y" }),
    HarnessEvent.parse({ ...base, type: "completed" }),
  ];
  expect(persist(plain, "lane", "model-x").auth_route?.model_mismatch).toEqual({
    requested: "model-x",
    observed: "model-y",
  });
  expect(persist(plain, "lane", "model-y").auth_route?.model_mismatch).toBeNull();
  expect(persist(plain, "lane").auth_route?.model_mismatch).toBeNull();
});

it.each([
  { name: "Codex Standard", harness: "codex", processing: prepareCodexProcessing("standard") },
  {
    name: "Codex priority",
    harness: "codex",
    processing: prepareCodexProcessing("fast", undefined, "priority"),
  },
  {
    name: "Codex inherited default",
    harness: "codex",
    processing: legacyCodexProcessing("default"),
  },
  {
    name: "Codex inherited priority",
    harness: "codex",
    processing: legacyCodexProcessing("priority"),
  },
  {
    name: "Claude fastMode off",
    harness: "claude",
    processing: prepareClaudeProcessing("standard"),
  },
  { name: "Claude fastMode on", harness: "claude", processing: prepareClaudeProcessing("fast") },
  {
    name: "Claude inherited fastMode off",
    harness: "claude",
    processing: prepareClaudeProcessing(undefined, false),
  },
  {
    name: "Claude inherited fastMode on",
    harness: "claude",
    processing: prepareClaudeProcessing(undefined, true),
  },
])("model_mismatch does not treat $name as a model id", ({ harness, processing }) => {
  const model = harness === "codex" ? "gpt-6-astra" : "claude-fable-5-1";
  const base = { session_id: "mm", ts: new Date(0).toISOString() };
  // Both current flag-carrier evidence and historical attempts without it.
  for (const parameter of [
    undefined,
    harness === "codex" ? "model_reasoning_effort" : "--effort",
  ]) {
    const events = [
      HarnessEvent.parse({
        ...base,
        type: "started",
        observed_model: model,
        processing,
        ...(parameter ? { effort_resolution: { ...effortFixture, parameter } } : {}),
      }),
      HarnessEvent.parse({ ...base, type: "completed", processing }),
    ];
    expect(persist(events, harness, model).auth_route?.model_mismatch).toBeNull();
    // A service receipt cannot manufacture a model hint that was never known.
    expect(persist(events, harness).auth_route?.model_mismatch).toBeNull();
    expect(persist(events, harness, "requested-model").auth_route?.model_mismatch).toEqual({
      requested: "requested-model",
      observed: model,
    });
  }
});
