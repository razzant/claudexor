/**
 * Producer chain for Cursor's display-label model: the init frame's raw
 * string, the per-spawn gate's catalog proof, the attempt pairing, and
 * final/telemetry.yaml read back through the schema (the file Ouroboros
 * reads). Catalog rows and init frames are SYNTHETIC Cursor-style values: no
 * recorded real catalog/init pair exists. The real Agent and Ask/report retry
 * loops are exercised in observed-model-native-retry.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import {
  CredentialProfile,
  HarnessEvent,
  HarnessModel,
  HarnessRunSpec,
  RunTelemetry,
  SCHEMA_VERSION,
  TaskContract,
} from "@claudexor/schema";
import { createCursorAdapter } from "../../harness-cursor/src/index.js";
import { newAttemptOutputMarkers } from "./attemptOutputMarkers.js";
import { createAttemptTelemetry, observeAttemptTelemetry } from "./attemptTelemetry.js";
import { runModelGovernedRoute, type ModelGovernedRoute } from "./modelGovernance.js";
import { beginNativeRetry } from "./native-retry-telemetry.js";
import { writeRunTelemetryArtifact } from "./runTelemetryWriter.js";

const row = (id: string, label: string | null) => HarnessModel.parse({ id, label });
const CATALOG = [
  row("gpt-5.5-high", "GPT-5.5 High"),
  row("gpt-5.5-high-fast", "GPT-5.5 High Fast"),
  row("gpt-5.5", "GPT-5.5"),
];
const PROOF = {
  label: "GPT-5.5 High",
  id: "gpt-5.5-high",
  source: "account_catalog",
  profile_id: null,
} as const;

function cursorProfile(profileId: string): CredentialProfile {
  return CredentialProfile.parse({
    profile_id: profileId,
    harness_id: "cursor",
    display_name: profileId,
    credential_kind: "api_key",
    secret_ref: `cursor:${profileId}`,
  });
}

/** Write final/telemetry.yaml for ONE attempt and read it back through the schema.
 * Each entry of `tries` is one native try; the loops' retry boundary runs between them. */
function persistTries(tries: HarnessEvent[][], requestedModel: string | null) {
  const root = mkdtempSync(join(tmpdir(), "observed-model-catalog-"));
  try {
    const store = new ArtifactStore(root, { claudexorDir: root });
    const paths = store.createRun("run");
    const telemetry = createAttemptTelemetry("off", false, "off", [], requestedModel);
    tries.forEach((events, index) => {
      if (index > 0) beginNativeRetry(telemetry);
      for (const event of events) observeAttemptTelemetry(telemetry, event);
    });
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
      attempts: [{ attemptId: "attempt", harnessId: "cursor", telemetry }],
      resolveAuthPreference: () => "auto",
    });
    return RunTelemetry.parse(store.readYaml(join(paths.finalDir, "telemetry.yaml")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const persist = (events: HarnessEvent[], requestedModel: string | null) =>
  persistTries([events], requestedModel);

function route(adapter: HarnessAdapter, profile: CredentialProfile | null): ModelGovernedRoute {
  return {
    adapter,
    knownModels: [],
    modelInventory: { model_inventory_absence: "advisory" },
    authRouteEstimate: "api_key",
    quotaAdmission: { profile },
    settings: null,
  };
}

/** One routed Cursor spawn through the real adapter and the real per-spawn gate. */
async function cursorSpawn(
  initModel: string,
  catalog: HarnessModel[],
  options: { modelHint?: string; profile?: CredentialProfile } = {},
) {
  let listed = 0;
  const adapter = createCursorAdapter({
    cursorApiKey: () => "fixture-key",
    resolveProfileSecret: () => "profile-key",
    smokeIsolatedApiKey: async () => ({ ok: true, detail: "fixture" }),
    listCursorModels: async () => {
      listed += 1;
      return catalog;
    },
    runCliHarness: async function* (opts) {
      yield* opts.parseEvent(
        { type: "system", subtype: "init", model: initModel },
        opts.spec.session_id,
      ) ?? [];
      yield { type: "completed", session_id: opts.spec.session_id, ts: new Date(0).toISOString() };
    },
  });
  const spec = HarnessRunSpec.parse({
    session_id: "cursor-label",
    intent: "explain",
    cwd: process.cwd(),
    prompt: "fixture",
    auth_preference: "api_key",
    model_hint: options.modelHint ?? "gpt-5.5-high",
    credential_profile: options.profile ?? null,
  });
  const events: HarnessEvent[] = [];
  for await (const event of runModelGovernedRoute(route(adapter, options.profile ?? null), spec))
    events.push(event);
  return { events, listed, started: events.find((event) => event.type === "started") };
}

describe("Cursor observed-model catalog proof reaches the final attempt", () => {
  it("keeps the raw label and adds the spawn's exact listed id, without another catalog read", async () => {
    const { events, listed, started } = await cursorSpawn("GPT-5.5 High", CATALOG);
    expect(started?.observed_model).toBe("GPT-5.5 High");
    expect(started?.observed_model_catalog_match).toEqual(PROOF);
    // Both reads predate this proof: the processing preparation and the per-spawn model truth.
    expect(listed).toBe(2);
    const telemetry = persist(events, "gpt-5.5-high");
    expect(telemetry.final_attempt_id).toBe("attempt");
    const attempt = telemetry.attempts[0];
    expect(attempt?.observed_model).toBe("GPT-5.5 High");
    expect(attempt?.requested_model).toBe("gpt-5.5-high");
    expect(attempt?.observed_model_catalog_match).toEqual(PROOF);
    // Out of scope by decision: the route receipt still compares the raw string.
    expect(telemetry.auth_route?.model_mismatch).toEqual({
      requested: "gpt-5.5-high",
      observed: "GPT-5.5 High",
    });
  });

  it("binds the proof to the pinned profile whose own catalog answered", async () => {
    const { events } = await cursorSpawn("GPT-5.5 High", CATALOG, {
      profile: cursorProfile("cursor-work"),
    });
    const attempt = persist(events, "gpt-5.5-high").attempts[0];
    expect(attempt?.profile_id).toBe("cursor-work");
    expect(attempt?.observed_model_catalog_match).toEqual({ ...PROOF, profile_id: "cursor-work" });
  });

  it("reports the listed id the label names, never the requested one", async () => {
    const { events } = await cursorSpawn("GPT-5.5", CATALOG);
    const attempt = persist(events, "gpt-5.5-high").attempts[0];
    expect(attempt?.observed_model_catalog_match).toEqual({
      ...PROOF,
      label: "GPT-5.5",
      id: "gpt-5.5",
    });
  });

  it.each([
    {
      name: "the requested id is listed without that label",
      catalog: [row("gpt-5.5-high", null), row("gpt-5.5", "GPT-5.5")],
      initModel: "GPT-5.5 High",
    },
    {
      name: "the label is unmatched",
      catalog: CATALOG,
      initModel: "Auto",
    },
    {
      name: "the label is ambiguous",
      catalog: [...CATALOG, row("gpt-5.5-high-legacy", "GPT-5.5 High")],
      initModel: "GPT-5.5 High",
    },
    {
      name: "the label differs only by case",
      catalog: CATALOG,
      initModel: "gpt-5.5 high",
    },
    {
      name: "the catalog read came back empty",
      catalog: [],
      initModel: "GPT-5.5 High",
    },
  ])(
    "stays unproven, with the raw string kept, when $name (synthetic)",
    async ({ catalog, initModel }) => {
      const { events, started } = await cursorSpawn(initModel, catalog);
      expect(started?.observed_model).toBe(initModel);
      expect(started).not.toHaveProperty("observed_model_catalog_match");
      const attempt = persist(events, "gpt-5.5-high").attempts[0];
      expect(attempt?.observed_model).toBe(initModel);
      expect(attempt?.observed_model_catalog_match).toBeNull();
    },
  );

  it("never lets a later try's proof fill an earlier try's label", async () => {
    // The attempt loop observes every native try into ONE attempt record.
    const unproven = await cursorSpawn("GPT-5.5 High", [row("gpt-5.5", "GPT-5.5")]);
    const proven = await cursorSpawn("GPT-5.5 High", CATALOG);
    const attempt = persistTries([unproven.events, proven.events], "gpt-5.5-high").attempts[0];
    expect(attempt?.observed_model).toBe("GPT-5.5 High");
    expect(attempt?.observed_model_catalog_match).toBeNull();
  });

  it("ends the proof when a try rotates to another account, even with the same label", async () => {
    const first = await cursorSpawn("GPT-5.5 High", CATALOG, {
      profile: cursorProfile("cursor-a"),
    });
    const second = await cursorSpawn("GPT-5.5 High", CATALOG, {
      profile: cursorProfile("cursor-b"),
    });
    expect(second.started?.observed_model_catalog_match).toEqual({
      ...PROOF,
      profile_id: "cursor-b",
    });
    const attempt = persistTries([first.events, second.events], "gpt-5.5-high").attempts[0];
    // observed_model stays first-wins and profile_id last-wins (unchanged).
    expect(attempt?.observed_model).toBe("GPT-5.5 High");
    expect(attempt?.profile_id).toBe("cursor-b");
    expect(attempt?.observed_model_catalog_match).toBeNull();
  });
});

describe("the per-spawn gate is the only author of the proof", () => {
  /** A synthetic adapter that hands the gate a catalog and forges stream proof. */
  function forgingAdapter(events: HarnessEvent[], catalog?: HarnessModel[]): HarnessAdapter {
    return {
      id: "forging",
      discover: async () => {
        throw new Error("not used");
      },
      doctor: async () => {
        throw new Error("not used");
      },
      prepareProcessing: async (spec) => ({
        model: spec.model,
        receipt: {
          requested: null,
          submitted: null,
          submittedNative: null,
          observed: "unknown",
          observedNative: [],
          reason: null,
          source: "fixture",
        },
        costBasis: { nativeMode: null, kind: "unknown", source: "fixture" },
        ...(catalog ? { catalog } : {}),
      }),
      run: async function* () {
        yield* events;
      },
    };
  }
  const forged = { label: "GPT-5.5 High", id: "forged-id", source: "account_catalog" } as const;
  const event = (fields: Partial<HarnessEvent>): HarnessEvent =>
    HarnessEvent.parse({
      type: "started",
      session_id: "forge",
      ts: new Date(0).toISOString(),
      payload: { adapter_fixture: true },
      ...fields,
    });

  async function gate(adapter: HarnessAdapter, profile: CredentialProfile | null = null) {
    const spec = HarnessRunSpec.parse({
      session_id: "forge",
      intent: "explain",
      cwd: process.cwd(),
      prompt: "fixture",
      credential_profile: profile,
    });
    const out: HarnessEvent[] = [];
    for await (const ev of runModelGovernedRoute(route(adapter, profile), spec)) out.push(ev);
    // Only the adapter's own events; the gate also yields its effort receipt.
    return out.filter((ev) => ev.payload?.["adapter_fixture"] === true);
  }

  it("replaces a forged value with its own and strips what it did not compute", async () => {
    const out = await gate(
      forgingAdapter(
        [
          event({
            observed_model: "GPT-5.5 High",
            observed_model_catalog_match: { ...forged, profile_id: null },
          }),
          event({ type: "status", observed_model_catalog_match: { ...forged, profile_id: null } }),
          event({
            observed_model: "Unlisted",
            observed_model_catalog_match: { ...forged, label: "Unlisted", profile_id: null },
          }),
        ],
        CATALOG,
      ),
    );
    expect(out.map((ev) => ev.observed_model_catalog_match ?? null)).toEqual([PROOF, null, null]);
  });

  it("strips every forged value when the preparation supplied no catalog", async () => {
    const out = await gate(
      forgingAdapter([
        event({
          observed_model: "GPT-5.5 High",
          observed_model_catalog_match: { ...forged, profile_id: null },
        }),
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty("observed_model_catalog_match");
  });

  it("proves only events of the profile the catalog was read for", async () => {
    const profile = cursorProfile("cursor-work");
    const out = await gate(
      forgingAdapter(
        [
          event({ observed_model: "GPT-5.5 High", credential_profile_id: "cursor-work" }),
          event({ observed_model: "GPT-5.5 High", credential_profile_id: "cursor-other" }),
          event({ observed_model: "GPT-5.5 High" }),
        ],
        CATALOG,
      ),
      profile,
    );
    expect(out.map((ev) => ev.observed_model_catalog_match ?? null)).toEqual([
      { ...PROOF, profile_id: "cursor-work" },
      null,
      null,
    ]);
  });
});

describe("attempt pairing, proof lifetime and historical telemetry", () => {
  const event = (fields: Partial<HarnessEvent>): HarnessEvent =>
    HarnessEvent.parse({
      type: "started",
      session_id: "pair",
      ts: new Date(0).toISOString(),
      ...fields,
    });
  const proven = () =>
    event({ observed_model: "GPT-5.5 High", observed_model_catalog_match: PROOF });

  it("drops a proof whose label is not the string it travels with", () => {
    const attempt = persist(
      [event({ observed_model: "GPT-5.5", observed_model_catalog_match: PROOF })],
      "gpt-5.5-high",
    ).attempts[0];
    expect(attempt?.observed_model).toBe("GPT-5.5");
    expect(attempt?.observed_model_catalog_match).toBeNull();
  });

  it("never pairs a later event's proof with an earlier event's string", () => {
    const attempt = persist([event({ observed_model: "GPT-5.5 High" }), proven()], "gpt-5.5-high")
      .attempts[0];
    expect(attempt?.observed_model_catalog_match).toBeNull();
  });

  it("keeps the proof while later events repeat the string or name no model", () => {
    const attempt = persist(
      [
        proven(),
        event({ type: "message", text: "working" }),
        event({ observed_model: "GPT-5.5 High" }),
      ],
      "gpt-5.5-high",
    ).attempts[0];
    expect(attempt?.observed_model_catalog_match).toEqual(PROOF);
  });

  it("ends the proof when a later event reports another model, keeping the first string", () => {
    const later = { ...PROOF, label: "GPT-5.5", id: "gpt-5.5" };
    const attempt = persist(
      [proven(), event({ observed_model: "GPT-5.5", observed_model_catalog_match: later })],
      "gpt-5.5-high",
    ).attempts[0];
    expect(attempt?.observed_model).toBe("GPT-5.5 High");
    expect(attempt?.observed_model_catalog_match).toBeNull();
  });

  it("ends the proof at a native retry, even when the later try proves the same string", () => {
    for (const laterTry of [[], [event({ type: "message", text: "answer" })], [proven()]]) {
      const attempt = persistTries([[proven()], laterTry], "gpt-5.5-high").attempts[0];
      expect(attempt?.observed_model).toBe("GPT-5.5 High");
      expect(attempt?.observed_model_catalog_match).toBeNull();
    }
  });

  it("pairs the first string a later try reports with that try's own proof", () => {
    // No earlier try reported a model: the string and its proof share one event.
    const attempt = persistTries([[event({ type: "status" })], [proven()]], "gpt-5.5-high")
      .attempts[0];
    expect(attempt?.observed_model).toBe("GPT-5.5 High");
    expect(attempt?.observed_model_catalog_match).toEqual(PROOF);
  });

  it("restarts the try's progress markers at a native retry", () => {
    const telemetry = createAttemptTelemetry("off", false);
    observeAttemptTelemetry(telemetry, proven());
    observeAttemptTelemetry(
      telemetry,
      event({ type: "thinking", text: "Reading the repository." }),
    );
    expect(telemetry.outputMarkers.sawAgentProgress).toBe(true);
    beginNativeRetry(telemetry);
    expect(telemetry.outputMarkers).toEqual(newAttemptOutputMarkers());
    expect(telemetry.observedModel).toBe("GPT-5.5 High");
    expect(telemetry.observedModelCatalogMatch).toBeNull();
  });

  it("reads an attempt written before the field as unproven", () => {
    const legacy = persist([event({ observed_model: "GPT-5.5 High" })], "gpt-5.5-high");
    const row = { ...legacy.attempts[0] } as Record<string, unknown>;
    delete row["observed_model_catalog_match"];
    const reread = RunTelemetry.parse({ ...legacy, attempts: [row] });
    expect(reread.attempts[0]?.observed_model).toBe("GPT-5.5 High");
    expect(reread.attempts[0]?.observed_model_catalog_match).toBeNull();
  });
});
