import { describe, expect, it, vi } from "vitest";
import { RoutingPreflightError } from "@claudexor/budget";
import {
  HarnessUnavailableError,
  ModelCatalogUnavailableError,
  RawContextRefusalError,
  dispatchModelCatalog,
  withDispatchModelCatalog,
  type HarnessAdapter,
  type RawRequestCapacity,
} from "@claudexor/core";
import { HarnessRunSpec, CredentialProfile, type RawContextPacket } from "@claudexor/schema";
import {
  assertRouteModelsAllowed,
  isDispatchRefusal,
  runModelGovernedRoute,
  type ModelGovernedRoute,
} from "./modelGovernance.js";
import { ProcessingBudgetAdmissionError } from "./processing-dispatch.js";

describe("runModelGovernedRoute", () => {
  it("uses the exact spawn profile/state and refuses before adapter.run", async () => {
    const profile: CredentialProfile = {
      profile_id: "rotated",
      harness_id: "cursor",
      display_name: "Rotated",
      credential_kind: "api_key",
      isolation_locator: null,
      secret_ref: "cursor:rotated",
      enabled: true,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const models = vi.fn(async () => []);
    const run = vi.fn((_spec: HarnessRunSpec) =>
      (async function* () {
        yield* [];
      })(),
    );
    const adapter = { id: "cursor", models, run } as unknown as HarnessAdapter;
    const routed: ModelGovernedRoute = {
      adapter,
      knownModels: [],
      authRouteEstimate: "local_session",
      quotaAdmission: { profile: null },
      settings: null,
    };
    const spec = HarnessRunSpec.parse({
      session_id: "ses-model-governance",
      intent: "audit",
      prompt: "review",
      cwd: "/repo/attempt",
      env: { HOME: "/state/attempt" },
      auth_preference: "api_key",
      credential_profile: profile,
      model_hint: "profile-only-model",
    });

    const consume = async (): Promise<void> => {
      for await (const _event of runModelGovernedRoute(routed, spec)) {
        // Rejection occurs before any event can be emitted.
      }
    };
    await expect(consume()).rejects.toThrow(
      /profile 'rotated' supplied this live inventory \(\d+ models\); inspect that profile's own vendor model list/,
    );
    expect(models).toHaveBeenCalledWith({
      cwd: "/repo/attempt",
      env: { HOME: "/state/attempt" },
      authPreference: "api_key",
      credentialProfile: profile,
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("assertRouteModelsAllowed", () => {
  it("uses the exact scoped env and invents no auth preference without a named profile", async () => {
    const seen: unknown[] = [];
    const adapter = {
      id: "cursor",
      models: async (spec: unknown) => {
        seen.push(spec);
        return [{ id: "profile-less-model", label: "Profile-less model" }];
      },
    } as unknown as HarnessAdapter;
    const routed: ModelGovernedRoute = {
      adapter,
      knownModels: [],
      authRouteEstimate: "local_session",
      quotaAdmission: { profile: null },
      settings: { defaultModel: "profile-less-model", fallbackModel: null },
    };
    const env = { HOME: "/tmp/scoped-model-home" };

    await assertRouteModelsAllowed([routed], undefined, "/repo", () => env);

    // The admission route is NOT replayed as an auth preference here: the spawn
    // will resolve `auto` itself, and a preflight that asked a different
    // question than the run would be answering about a different account.
    expect(seen).toEqual([{ cwd: "/repo", env }]);
  });

  it("defers a fallback model until its own profile/state reaches the spawn guard", async () => {
    const primaryProfile: CredentialProfile = {
      profile_id: "primary",
      harness_id: "cursor",
      display_name: "Primary",
      credential_kind: "config_dir_login",
      isolation_locator: "/profiles/primary",
      secret_ref: null,
      enabled: true,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const fallbackProfile: CredentialProfile = {
      ...primaryProfile,
      profile_id: "fallback",
      display_name: "Fallback",
      isolation_locator: "/profiles/fallback",
    };
    const run = vi.fn((_spec: HarnessRunSpec) =>
      (async function* () {
        yield* [];
      })(),
    );
    const models = vi.fn(async (spec?: { credentialProfile?: CredentialProfile | null }) => {
      return spec?.credentialProfile?.profile_id === "fallback"
        ? [{ id: "fallback-model", label: "Fallback" }]
        : [{ id: "primary-model", label: "Primary" }];
    });
    const adapter = { id: "cursor", models, run } as unknown as HarnessAdapter;
    const routed: ModelGovernedRoute = {
      adapter,
      knownModels: [],
      authRouteEstimate: "local_session",
      quotaAdmission: { profile: primaryProfile },
      settings: { defaultModel: "primary-model", fallbackModel: "fallback-model" },
    };

    await assertRouteModelsAllowed([routed], undefined, "/repo", () => ({
      HOME: "/primary-state",
    }));

    const fallbackSpec = HarnessRunSpec.parse({
      session_id: "ses-fallback-model-governance",
      intent: "audit",
      prompt: "review",
      cwd: "/repo/fallback-attempt",
      env: { HOME: "/fallback-state" },
      auth_preference: "subscription",
      credential_profile: fallbackProfile,
      model_hint: "fallback-model",
    });
    for await (const _event of runModelGovernedRoute(routed, fallbackSpec)) {
      // The profile-specific inventory admits the fallback before run.
    }

    expect(models).toHaveBeenNthCalledWith(1, {
      cwd: "/repo",
      env: { HOME: "/primary-state" },
      credentialProfile: primaryProfile,
    });
    expect(models).toHaveBeenNthCalledWith(2, {
      cwd: "/repo/fallback-attempt",
      env: { HOME: "/fallback-state" },
      authPreference: "subscription",
      credentialProfile: fallbackProfile,
    });
    expect(run).toHaveBeenCalledWith(fallbackSpec);
  });
});

describe("profile-less auto is answered as auto, never rewritten", () => {
  const autoAdapter = (
    id: string,
    modelSpecs: unknown[],
    runSpecs: HarnessRunSpec[],
  ): HarnessAdapter =>
    ({
      id,
      models: async (spec: unknown) => {
        modelSpecs.push(spec);
        return [{ id: "bound-model", label: "Bound" }];
      },
      run: (spec: HarnessRunSpec) =>
        (async function* () {
          runSpecs.push(spec);
          yield* [];
        })(),
    }) as unknown as HarnessAdapter;

  // Sol wave-4 P1/P2 counterexamples: the gate used to concretize the admitted
  // route into `subscription`/`api_key`. For a non-Cursor adapter that queried
  // a different inventory than its own spawn would use, and for Cursor it
  // silenced the `auth_switched/readiness_preferred` disclosure, which the
  // adapter emits ONLY while the received preference is still `auto`.
  it.each(["cursor", "generic"])(
    "%s: the inventory is asked with auto and the spawned spec is byte-identical",
    async (id) => {
      const modelSpecs: unknown[] = [];
      const runSpecs: HarnessRunSpec[] = [];
      const routed: ModelGovernedRoute = {
        adapter: autoAdapter(id, modelSpecs, runSpecs),
        knownModels: [],
        authRouteEstimate: id === "cursor" ? "local_session" : null,
        quotaAdmission: { profile: null },
        settings: null,
      };
      const spec = HarnessRunSpec.parse({
        session_id: `ses-auto-${id}`,
        intent: "audit",
        prompt: "review",
        cwd: "/repo",
        env: { HOME: "/state" },
        auth_preference: "auto",
        model_hint: "bound-model",
      });

      for await (const _event of runModelGovernedRoute(routed, spec)) {
        // The adapter emits no events in this contract test.
      }

      expect(modelSpecs).toEqual([
        { cwd: "/repo", env: { HOME: "/state" }, authPreference: "auto" },
      ]);
      expect(runSpecs).toEqual([spec]);
      expect(runSpecs[0]?.auth_preference).toBe("auto");
    },
  );

  it("a run stopped at a pre-dispatch disclosure is never handed to its adapter", async () => {
    const runSpecs: HarnessRunSpec[] = [];
    const routed: ModelGovernedRoute = {
      adapter: autoAdapter("generic", [], runSpecs),
      knownModels: [],
      authRouteEstimate: null,
      quotaAdmission: { profile: null },
      settings: null,
    };
    const stop = new AbortController();
    const spec = HarnessRunSpec.parse({
      session_id: "ses-stopped-preamble",
      intent: "audit",
      prompt: "review",
      cwd: "/repo",
      env: { HOME: "/state" },
      auth_preference: "auto",
      model_hint: "bound-model",
    });
    spec.extra["abortSignal"] = stop.signal;
    const seen: unknown[] = [];
    // A consumer that keeps reading after Stop (to drain teardown evidence).
    for await (const event of runModelGovernedRoute(routed, spec)) {
      seen.push(event);
      stop.abort();
    }
    expect(seen).not.toEqual([]);
    expect(runSpecs).toEqual([]);
  });

  it("an undecidable admission route no longer refuses a profile-less auto run", async () => {
    const modelSpecs: unknown[] = [];
    const runSpecs: HarnessRunSpec[] = [];
    const routed: ModelGovernedRoute = {
      adapter: autoAdapter("cursor", modelSpecs, runSpecs),
      knownModels: [],
      authRouteEstimate: null,
      quotaAdmission: { profile: null },
      settings: null,
    };
    const spec = HarnessRunSpec.parse({
      session_id: "ses-undecidable-route",
      intent: "audit",
      prompt: "review",
      cwd: "/repo",
      auth_preference: "auto",
      model_hint: "bound-model",
    });

    for await (const _event of runModelGovernedRoute(routed, spec)) {
      // The vendor, not this gate, is the authority on an `auto` route.
    }

    expect(runSpecs).toEqual([spec]);
  });

  it("the early gate leaves a non-Cursor automatic route alone as well", async () => {
    const seen: unknown[] = [];
    const routed: ModelGovernedRoute = {
      adapter: {
        id: "generic",
        models: async (spec: unknown) => {
          seen.push(spec);
          return [{ id: "generic-model", label: "Generic" }];
        },
      } as unknown as HarnessAdapter,
      knownModels: [],
      authRouteEstimate: null,
      quotaAdmission: { profile: null },
      settings: { defaultModel: "generic-model", fallbackModel: null },
    };

    await assertRouteModelsAllowed([routed], undefined, "/repo");

    expect(seen).toEqual([{ cwd: "/repo" }]);
  });
});

/**
 * The regression this change exists for. A codex `model/list` probe whose
 * remote fetch timed out answers with the CLI's bundled default list — live in
 * shape, stale in content — and nothing on the wire marks it. Under the old
 * strict gate that list refused `gpt-6-astra` on the very accounts that were
 * serving it, in under a second, for free, as an untyped failure. An advisory
 * inventory now forwards the explicit model and says once that it was unlisted.
 */
describe("advisory live inventory (absence is not proof)", () => {
  // The exact list observed in the live refusals: astra dropped from the front,
  // gpt-5.2 appended at the back — a previous generation of the same list.
  const STALE = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2"];
  const NOTE =
    "model \"gpt-6-astra\" is not in this account's listed models; this harness's list " +
    "cannot prove a model is absent, so the request is forwarded to the vendor";

  const codexish = (
    absence: "authoritative" | "advisory" | undefined,
    list: readonly string[],
    runSpecs: HarnessRunSpec[] = [],
  ): ModelGovernedRoute => ({
    adapter: {
      id: "codex",
      models: async () => list.map((id) => ({ id, label: null })),
      run: (spec: HarnessRunSpec) =>
        (async function* () {
          runSpecs.push(spec);
          yield* [];
        })(),
    } as unknown as HarnessAdapter,
    knownModels: ["gpt-6-astra"],
    modelInventory: {
      model_inventory_routes: ["local_session"],
      ...(absence ? { model_inventory_absence: absence } : {}),
    },
    authRouteEstimate: "local_session",
    quotaAdmission: { profile: null },
    settings: { defaultModel: "gpt-6-astra", fallbackModel: null },
  });

  const astraSpec = (session: string): HarnessRunSpec =>
    HarnessRunSpec.parse({
      session_id: session,
      intent: "audit",
      prompt: "review",
      cwd: "/repo",
      env: { HOME: "/state" },
      auth_preference: "subscription",
      model_hint: "gpt-6-astra",
    });

  it("admits the unlisted model at BOTH gates, discloses once, and spawns the spec byte-identical", async () => {
    const runSpecs: HarnessRunSpec[] = [];
    const routed = codexish("advisory", STALE, runSpecs);
    // Preflight stays SILENT (it has no event stream; the spawn gate speaks).
    await assertRouteModelsAllowed([routed], undefined, "/repo");
    const spec = astraSpec("ses-advisory-stale");
    const events = [];
    for await (const event of runModelGovernedRoute(routed, spec)) events.push(event);
    const disclosures = events.filter((event) => event.type === "status" && event.text);
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]?.text).toBe(NOTE);
    expect(disclosures[0]?.session_id).toBe("ses-advisory-stale");
    // Never a second list: the manifest (which HAS astra) is not substituted,
    // and the spec the adapter receives is the one the caller asked for.
    expect(runSpecs).toEqual([spec]);
    expect(runSpecs[0]?.model_hint).toBe("gpt-6-astra");
  });

  it("forwards an EMPTY live answer too, with the note naming that case", async () => {
    const runSpecs: HarnessRunSpec[] = [];
    const routed = codexish("advisory", [], runSpecs);
    await assertRouteModelsAllowed([routed], undefined, "/repo");
    const events = [];
    for await (const event of runModelGovernedRoute(routed, astraSpec("ses-advisory-empty")))
      events.push(event);
    expect(
      events.filter((event) => event.type === "status" && event.text).map((event) => event.text),
    ).toEqual([
      "the harness returned no model list; this harness's list cannot prove a model is " +
        "absent, so the request is forwarded to the vendor",
    ]);
    expect(runSpecs).toHaveLength(1);
  });

  it("emits no model warning when the live list DOES carry the model", async () => {
    const routed = codexish("advisory", [...STALE, "gpt-6-astra"]);
    const events = [];
    for await (const event of runModelGovernedRoute(routed, astraSpec("ses-advisory-listed")))
      events.push(event);
    expect(events.filter((event) => event.text)).toEqual([]);
    expect(events[0]?.effort_resolution).toMatchObject({ requested: null, resolution: "omitted" });
  });

  it("an AUTHORITATIVE adapter still refuses the same list with today's exact text", async () => {
    for (const absence of ["authoritative", undefined] as const) {
      const runSpecs: HarnessRunSpec[] = [];
      const routed = codexish(absence, STALE, runSpecs);
      const consume = async () => {
        for await (const _event of runModelGovernedRoute(routed, astraSpec("ses-strict"))) {
          /* the refusal precedes every event */
        }
      };
      await expect(consume()).rejects.toThrow(
        "harness 'codex' refused model 'gpt-6-astra' (truth source: api): " +
          'model "gpt-6-astra" is not in the harness\'s live model inventory ' +
          "(gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.2); " +
          "run `claudexor models --harness codex`",
      );
      await expect(assertRouteModelsAllowed([routed], undefined, "/repo")).rejects.toThrow(
        /refused model 'gpt-6-astra'/,
      );
      expect(runSpecs).toEqual([]);
    }
  });

  it("an authoritative adapter still refuses an EMPTY inventory with today's exact text", async () => {
    const routed = codexish("authoritative", []);
    await expect(assertRouteModelsAllowed([routed], undefined, "/repo")).rejects.toThrow(
      "harness 'codex' refused model 'gpt-6-astra' (truth source: api): this harness cannot " +
        "verify models (no live model inventory); repair the live account/auth route or use " +
        "the harness default (omit the model); run `claudexor models --harness codex`",
    );
  });

  it("carries the advisory declaration to MANIFEST truth on another route (the harness declares, not the list)", async () => {
    // An api_key route reads the manifest hints. Those are one day's memory of
    // the same vendor menu, so the harness's declaration governs them too:
    // advisory forwards the miss; authoritative refuses it with today's text.
    // No list is swapped for another either way (the live list is never read).
    const profile = CredentialProfile.parse({
      profile_id: "api",
      harness_id: "codex",
      display_name: "API",
      credential_kind: "api_key",
      secret_ref: "openai:api",
    });
    const forwarded: ModelGovernedRoute = {
      ...codexish("advisory", STALE),
      knownModels: [{ id: "manifest-only", routes: ["api_key"] }],
      quotaAdmission: { profile },
    };
    await expect(
      assertRouteModelsAllowed([forwarded], { codex: "gpt-6-astra" }, "/repo"),
    ).resolves.toBeUndefined();
    const refused: ModelGovernedRoute = {
      ...codexish("authoritative", STALE),
      knownModels: [{ id: "manifest-only", routes: ["api_key"] }],
      quotaAdmission: { profile },
    };
    await expect(
      assertRouteModelsAllowed([refused], { codex: "gpt-6-astra" }, "/repo"),
    ).rejects.toThrow(
      /truth source: manifest, route: api_key.*manifest known-model list \(manifest-only\)/,
    );
  });
});

describe("route-scoped live model producer", () => {
  it("admits the API-key manifest model at preflight and actual spawn without borrowing native inventory", async () => {
    const profile = CredentialProfile.parse({
      profile_id: "api-key",
      harness_id: "generic",
      display_name: "API",
      credential_kind: "api_key",
      secret_ref: "openai:api",
    });
    const models = vi.fn(async () => []);
    const run = vi.fn((_spec: HarnessRunSpec) =>
      (async function* () {
        yield* [];
      })(),
    );
    const routed: ModelGovernedRoute = {
      adapter: { id: "generic", models, run } as unknown as HarnessAdapter,
      knownModels: [{ id: "api-model", routes: ["api_key"] }],
      modelInventory: { model_inventory_routes: ["local_session"] },
      authRouteEstimate: "local_session",
      quotaAdmission: { profile },
      settings: { defaultModel: "api-model", fallbackModel: null },
    };
    await assertRouteModelsAllowed([routed], undefined, "/repo");
    const spec = HarnessRunSpec.parse({
      session_id: "api-model",
      intent: "audit",
      prompt: "test",
      cwd: "/repo",
      credential_profile: profile,
      model_hint: "api-model",
    });
    for await (const _event of runModelGovernedRoute(routed, spec)) {
      /* consume */
    }
    expect(models).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(spec);
    await expect(
      assertRouteModelsAllowed([routed], { generic: "native-model" }, "/repo"),
    ).rejects.toThrow(/truth source: manifest, route: api_key/);
    const nativeProfile = CredentialProfile.parse({
      ...profile,
      credential_kind: "config_dir_login",
      secret_ref: null,
      isolation_locator: "/profiles/native",
    });
    const native = {
      ...routed,
      knownModels: ["api-model"],
      quotaAdmission: { profile: nativeProfile },
    };
    await expect(assertRouteModelsAllowed([native], undefined, "/repo")).rejects.toThrow(
      /truth source: api.*cannot verify models/,
    );
    expect(models).toHaveBeenCalledWith({ cwd: "/repo", credentialProfile: nativeProfile });
  });
});

/**
 * A raw-api-shaped producer: authoritative, with a TYPED catalog read (#393)
 * and declared routing variants (#145). The gates must tell a failed read from
 * an empty catalog and admit a variant without rewriting the spawned spec.
 */
describe("typed catalog reads at the run gates (#393, #145)", () => {
  type Read = Awaited<ReturnType<NonNullable<HarnessAdapter["modelCatalog"]>>>;
  const rawish = (read: Read, runSpecs: HarnessRunSpec[] = []): ModelGovernedRoute => ({
    adapter: {
      id: "openrouter",
      models: async () => (read.status === "listed" ? read.models : []),
      modelCatalog: async () => read,
      run: (spec: HarnessRunSpec) =>
        (async function* () {
          runSpecs.push(spec);
          yield* [];
        })(),
    } as unknown as HarnessAdapter,
    knownModels: [],
    modelInventory: {
      model_routing_variants: [
        { suffix: ":nitro", billing: "service_tier" },
        { suffix: ":exacto", billing: "base" },
      ],
      model_refused_variants: [{ suffix: ":online", reason: "provider_web_search" }],
    },
    authRouteEstimate: "api_key",
    quotaAdmission: { profile: null },
    settings: null,
  });
  const listed = (...ids: string[]): Read => ({
    status: "listed",
    models: ids.map((id) => ({ id, label: null, context_window: null, routes: null })),
  });
  const runSpec = (model: string) =>
    HarnessRunSpec.parse({
      session_id: `ses-${model.replace(/\W+/g, "-")}`,
      intent: "implement",
      prompt: "edit",
      cwd: "/repo",
      model_hint: model,
    });
  const statuses = async (routed: ModelGovernedRoute, spec: HarnessRunSpec) => {
    const texts: string[] = [];
    for await (const event of runModelGovernedRoute(routed, spec))
      if (event.type === "status" && event.text) texts.push(event.text);
    return texts;
  };

  it("forwards an explicit model at BOTH gates on an UNAVAILABLE catalog, byte-identical, saying it could not be verified (decision A)", async () => {
    const runSpecs: HarnessRunSpec[] = [];
    const down = {
      status: "unavailable" as const,
      failure: { cause: "http_status" as const, httpStatus: 503, detail: "upstream down" },
    };
    const routed = rawish(down, runSpecs);
    await assertRouteModelsAllowed([routed], { openrouter: "vendor/m" }, "/repo");
    const spec = runSpec("vendor/m");
    const notes = await statuses(routed, spec);
    expect(notes).toEqual([
      "the live model catalog could not be read (http_status; HTTP 503: upstream down), so " +
        'model "vendor/m" could not be verified; it is sent unchanged on the same key and the ' +
        "provider accepts or refuses it",
    ]);
    // The spawn carries the model as asked and the failed read itself.
    const observed = { ...down, sourceProgram: null };
    expect(runSpecs).toEqual([withDispatchModelCatalog(spec, observed)]);
  });

  it("refuses an explicit model at BOTH gates, typed, when the endpoint REJECTED the key", async () => {
    const runSpecs: HarnessRunSpec[] = [];
    const routed = rawish(
      {
        status: "unavailable",
        failure: { cause: "auth_rejected", httpStatus: 401, detail: "invalid key" },
      },
      runSpecs,
    );
    const refusal =
      "harness 'openrouter' refused model 'vendor/m' (truth source: api): the live model " +
      "catalog could not be read (auth_rejected; HTTP 401: invalid key), so model " +
      '"vendor/m" cannot be verified; the endpoint rejected the API key: replace it or check ' +
      "its access";
    const preflight = assertRouteModelsAllowed([routed], { openrouter: "vendor/m" }, "/repo");
    await expect(preflight).rejects.toBeInstanceOf(ModelCatalogUnavailableError);
    await expect(preflight).rejects.toMatchObject({
      code: "model_catalog_unavailable",
      category: "auth",
      retryable: false,
    });
    await expect(preflight).rejects.toThrow(refusal);
    const consume = async () => {
      for await (const _event of runModelGovernedRoute(routed, runSpec("vendor/m"))) {
        /* the refusal precedes every event */
      }
    };
    await expect(consume()).rejects.toThrow(refusal);
    expect(runSpecs).toEqual([]);
  });

  it("refuses a model absent from a SUCCESSFUL empty catalog without auth advice", async () => {
    const routed = rawish(listed());
    await expect(
      assertRouteModelsAllowed([routed], { openrouter: "vendor/m" }, "/repo"),
    ).rejects.toThrow(
      "harness 'openrouter' refused model 'vendor/m' (truth source: api): model \"vendor/m\" is " +
        "not in the harness's live model inventory (the catalog lists no models); " +
        "run `claudexor models --harness openrouter`",
    );
  });

  it("admits a declared routing variant of a listed row, discloses it and sends the original id", async () => {
    const runSpecs: HarnessRunSpec[] = [];
    const routed = rawish(listed("vendor/m"), runSpecs);
    await assertRouteModelsAllowed([routed], { openrouter: "vendor/m:nitro" }, "/repo");
    const spec = runSpec("vendor/m:nitro");
    const [note] = await statuses(routed, spec);
    expect(note).toContain(
      'model "vendor/m:nitro" is listed model "vendor/m" with routing variant :nitro',
    );
    expect(note).toContain("service-tier rate");
    // The request is sent as asked; the gate adds only its own catalog read.
    expect(runSpecs).toEqual([withDispatchModelCatalog(spec, listed("vendor/m"))]);
    expect(runSpecs[0]?.model_hint).toBe("vendor/m:nitro");
  });

  it("admits a documented any-order combination by its listed catalog-variant row", async () => {
    const runSpecs: HarnessRunSpec[] = [];
    const routed = rawish(listed("vendor/m", "vendor/m:free"), runSpecs);
    await assertRouteModelsAllowed([routed], { openrouter: "vendor/m:nitro:free" }, "/repo");
    const spec = runSpec("vendor/m:nitro:free");
    const [note] = await statuses(routed, spec);
    expect(note).toContain('is listed model "vendor/m:free" with routing variant :nitro;');
    expect(runSpecs[0]?.model_hint).toBe("vendor/m:nitro:free");
    await expect(
      assertRouteModelsAllowed(
        [rawish(listed("vendor/m"))],
        { openrouter: "vendor/m:nitro:free" },
        "/repo",
      ),
    ).rejects.toThrow(
      /refused model 'vendor\/m:nitro:free'.*not in the harness's live model inventory/,
    );
  });

  it("refuses an unknown suffix by exact membership and the declared :online on any read", async () => {
    const consume = async (routed: ModelGovernedRoute, model: string) => {
      for await (const _event of runModelGovernedRoute(routed, runSpec(model))) {
        /* the refusal precedes every event */
      }
    };
    const routed = rawish(listed("vendor/m"));
    await expect(
      assertRouteModelsAllowed([routed], { openrouter: "vendor/m:unknownsuffix" }, "/repo"),
    ).rejects.toThrow("refused model 'vendor/m:unknownsuffix'");
    await expect(consume(routed, "vendor/m:unknownsuffix")).rejects.toThrow(
      /not in the harness's live model inventory/,
    );
    const online =
      "harness 'openrouter' refused model 'vendor/m:online': model \"vendor/m:online\" carries " +
      "the :online variant, which this harness refuses";
    const down = rawish({
      status: "unavailable",
      failure: { cause: "timeout", httpStatus: null, detail: "no answer within 15s" },
    });
    for (const route of [routed, down]) {
      await expect(
        assertRouteModelsAllowed([route], { openrouter: "vendor/m:online" }, "/repo"),
      ).rejects.toThrow(online);
      await expect(consume(route, "vendor/m:online")).rejects.toThrow(online);
    }
  });
});

describe("one catalog read per spawn serves the model, the raw packet and the adapter (#147, #146)", () => {
  type Read = Awaited<ReturnType<NonNullable<HarnessAdapter["modelCatalog"]>>>;
  const PACKET = { packet_hash: "sha256:sized" } as RawContextPacket;
  function raw(read: Read | Read[]) {
    const runSpecs: HarnessRunSpec[] = [];
    const rows: unknown[] = [];
    // One answer per read, in order; the last answer repeats.
    const answers = Array.isArray(read) ? [...read] : [read];
    const modelCatalog = vi.fn(async () => (answers.length > 1 ? answers.shift()! : answers[0]!));
    const adapter = {
      id: "openrouter",
      models: async () => [],
      modelCatalog,
      rawRequestCapacity: (
        spec: HarnessRunSpec,
        catalog: readonly { context_window: number | null }[],
      ) => {
        rows.push(catalog);
        return {
          model: spec.model_hint ?? "vendor/default",
          contextWindow: catalog[0]?.context_window ?? null,
          outputAllowance: 4_096,
          outputAllowanceSource: "catalog",
          framingTokens: 10,
        } satisfies RawRequestCapacity;
      },
      run: (spec: HarnessRunSpec) =>
        (async function* () {
          runSpecs.push(spec);
          yield* [];
        })(),
    } as unknown as HarnessAdapter;
    const routed: ModelGovernedRoute = {
      adapter,
      knownModels: [],
      authRouteEstimate: "api_key",
      quotaAdmission: { profile: null },
      settings: null,
    };
    const sized: Array<RawRequestCapacity | null> = [];
    const notes: string[] = [];
    const dispatched = vi.fn();
    const send = async (
      model?: string,
      rawContext = async () => PACKET,
      profile: CredentialProfile | null = null,
    ) => {
      const spec = HarnessRunSpec.parse({
        session_id: "ses-raw",
        intent: "implement",
        prompt: "edit",
        cwd: "/repo",
        ...(model ? { model_hint: model } : {}),
        ...(profile ? { credential_profile: profile } : {}),
      });
      spec.extra["markPhysicalDispatchStarted"] = dispatched;
      const dispatch = {
        rawContext: async (capacity: RawRequestCapacity | null) => {
          sized.push(capacity);
          return rawContext();
        },
      };
      for await (const event of runModelGovernedRoute(routed, spec, dispatch))
        if (event.type === "status" && event.text) notes.push(event.text);
    };
    return { routed, runSpecs, rows, modelCatalog, sized, notes, dispatched, send };
  }
  const window = (contextWindow: number): Read => ({
    status: "listed",
    models: [{ id: "vendor/m", label: null, context_window: contextWindow, routes: null }],
  });
  const failure = { cause: "http_status" as const, httpStatus: 503, detail: "upstream down" };
  const failed: Read = { status: "unavailable", failure };

  it("sizes the packet from the read that admitted the model and hands that read to the adapter", async () => {
    const h = raw(window(50_000));
    await h.send("vendor/m");
    expect(h.modelCatalog).toHaveBeenCalledTimes(1);
    expect(h.sized).toEqual([
      expect.objectContaining({ model: "vendor/m", contextWindow: 50_000 }),
    ]);
    expect(h.runSpecs).toHaveLength(1);
    expect(h.runSpecs[0]!.raw_context_packet).toBe(PACKET);
    expect(dispatchModelCatalog(h.runSpecs[0]!)).toEqual(window(50_000));
    expect(h.dispatched).toHaveBeenCalledTimes(1);
  });

  it("without an explicit model still reads once; a failed read leaves the window unknown and refuses nothing", async () => {
    const h = raw(failed);
    await h.send();
    expect(h.modelCatalog).toHaveBeenCalledTimes(1);
    expect(h.rows).toEqual([[]]);
    expect(h.sized).toEqual([expect.objectContaining({ contextWindow: null })]);
    expect(h.runSpecs[0]!.raw_context_packet).toBe(PACKET);
    expect(dispatchModelCatalog(h.runSpecs[0]!)).toEqual({ ...failed, sourceProgram: null });
  });

  it("forwards an explicit model its unavailable read cannot verify, sized under an unknown window", async () => {
    const h = raw(failed);
    await h.send("vendor/m");
    expect(h.sized).toEqual([expect.objectContaining({ model: "vendor/m", contextWindow: null })]);
    expect(h.notes.join("\n")).toContain('model "vendor/m" could not be verified');
    expect(h.runSpecs).toHaveLength(1);
    expect(h.runSpecs[0]!.model_hint).toBe("vendor/m");
    expect(h.dispatched).toHaveBeenCalledTimes(1);
  });

  it("refuses an explicit model whose key the endpoint rejected before sizing, admitting or sending", async () => {
    const h = raw({
      status: "unavailable",
      failure: { cause: "auth_rejected", httpStatus: 401, detail: "invalid key" },
    });
    const refusal = await h.send("vendor/m").catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(ModelCatalogUnavailableError);
    expect(refusal).toMatchObject({ category: "auth", retryable: false });
    expect(isDispatchRefusal(refusal)).toBe(true);
    expect(h.sized).toEqual([]);
    expect(h.dispatched).not.toHaveBeenCalled();
    expect(h.runSpecs).toEqual([]);
  });

  describe("an unavailable read keeps what this run already read at the same identity (#393 x #147)", () => {
    const profile = (id: string) =>
      CredentialProfile.parse({
        profile_id: id,
        harness_id: "openrouter",
        display_name: id,
        credential_kind: "api_key",
        secret_ref: `openrouter:${id}`,
        enabled: true,
      });
    /** The read as a producer that names its key reports it. */
    const keyed = (read: Read, fingerprint = "fp-key-1"): Read => ({
      ...read,
      credential: { fingerprint },
    });

    it("admission knew a 50k window: the failed dispatch read sizes under it, says so and hands it on", async () => {
      const h = raw([keyed(window(50_000)), keyed(failed)]);
      await assertRouteModelsAllowed([h.routed], { openrouter: "vendor/m" }, "/repo");
      await h.send("vendor/m");
      expect(h.modelCatalog).toHaveBeenCalledTimes(2); // admission + dispatch, nothing more
      expect(h.sized).toEqual([expect.objectContaining({ contextWindow: 50_000 })]);
      // The earlier rows, handed on with the key this dispatch read checked.
      expect(dispatchModelCatalog(h.runSpecs[0]!)).toEqual(keyed(window(50_000)));
      expect(h.notes).toHaveLength(1);
      expect(h.notes[0]).toMatch(
        /^the live model catalog could not be read \(http_status; HTTP 503: upstream down\) at dispatch; this run's earlier catalog read with the same credentials \(\d{4}-.+\) answers for the model and its limits$/,
      );
    });

    it("a successful newer read wins, and later failures fall back to it", async () => {
      const h = raw([keyed(window(50_000)), keyed(window(64_000)), keyed(failed)]);
      await assertRouteModelsAllowed([h.routed], { openrouter: "vendor/m" }, "/repo");
      await h.send("vendor/m");
      await h.send("vendor/m");
      expect(h.sized.map((c) => c?.contextWindow)).toEqual([64_000, 64_000]);
    });

    it("another account's earlier read is never borrowed: its window stays unknown", async () => {
      const h = raw([keyed(window(50_000)), keyed(failed)]);
      h.routed.quotaAdmission = { profile: profile("acct-a") };
      await assertRouteModelsAllowed([h.routed], { openrouter: "vendor/m" }, "/repo");
      await h.send("vendor/m", undefined, profile("acct-b"));
      expect(h.sized).toEqual([expect.objectContaining({ contextWindow: null })]);
      expect(h.notes.join("\n")).toContain('model "vendor/m" could not be verified');
      expect(h.notes.join("\n")).not.toContain("earlier catalog read");
    });

    it("another key under the same identity, or a read naming no key, never borrows it", async () => {
      for (const reads of [
        [keyed(window(50_000), "fp-key-1"), keyed(failed, "fp-key-2")],
        [window(50_000), failed],
      ]) {
        const h = raw(reads);
        await assertRouteModelsAllowed([h.routed], { openrouter: "vendor/m" }, "/repo");
        await h.send("vendor/m");
        expect(h.sized).toEqual([expect.objectContaining({ contextWindow: null })]);
        expect(h.notes.join("\n")).not.toContain("earlier catalog read");
      }
    });

    it("a pinned account's own admission read answers its failed dispatch read", async () => {
      const h = raw([keyed(window(50_000)), keyed(failed)]);
      h.routed.quotaAdmission = { profile: profile("acct-a") };
      await assertRouteModelsAllowed([h.routed], { openrouter: "vendor/m" }, "/repo");
      await h.send("vendor/m", undefined, profile("acct-a"));
      expect(h.sized).toEqual([expect.objectContaining({ contextWindow: 50_000 })]);
    });

    it("a rejected key still refuses, whatever was read before", async () => {
      const h = raw([
        keyed(window(50_000)),
        keyed({
          status: "unavailable",
          failure: { cause: "auth_rejected", httpStatus: 403, detail: "" },
        }),
      ]);
      await assertRouteModelsAllowed([h.routed], { openrouter: "vendor/m" }, "/repo");
      await expect(h.send("vendor/m")).rejects.toBeInstanceOf(ModelCatalogUnavailableError);
      expect(h.sized).toEqual([]);
      expect(h.runSpecs).toEqual([]);
    });

    it("a model the earlier successful read did not list is still refused", async () => {
      const h = raw([keyed(window(50_000)), keyed(failed)]);
      await assertRouteModelsAllowed([h.routed], { openrouter: "vendor/m" }, "/repo");
      await expect(h.send("vendor/other")).rejects.toThrow(
        /refused model 'vendor\/other'.*not in the harness's live model inventory/,
      );
      expect(h.runSpecs).toEqual([]);
    });

    it("nothing read before: the window is genuinely unknown", async () => {
      const h = raw(failed);
      await h.send();
      expect(h.sized).toEqual([expect.objectContaining({ contextWindow: null })]);
      expect(h.notes).toEqual([]);
    });
  });

  it("an undeliverable packet refuses before admission and before the adapter runs", async () => {
    const h = raw(window(50_000));
    const refusal = await h
      .send("vendor/m", async () => {
        throw new RawContextRefusalError("raw_context_exceeds_window", "too big");
      })
      .catch((err: unknown) => err);
    expect(isDispatchRefusal(refusal)).toBe(true);
    expect(refusal).toMatchObject({ code: "raw_context_exceeds_window", category: "validation" });
    expect(h.dispatched).not.toHaveBeenCalled();
    expect(h.runSpecs).toEqual([]);
  });

  it("names exactly the refusals raised before anything is sent", () => {
    const denial = { code: "hard_cap", reason: "cap" } as ConstructorParameters<
      typeof ProcessingBudgetAdmissionError
    >[0];
    for (const refusal of [
      new ProcessingBudgetAdmissionError(denial),
      new RoutingPreflightError("no route"),
      new ModelCatalogUnavailableError("unread", failure),
      new RawContextRefusalError("raw_context_mandatory_unavailable", "missing"),
    ])
      expect(isDispatchRefusal(refusal)).toBe(true);
    for (const other of [new HarnessUnavailableError("absent"), new Error("crash"), "text"])
      expect(isDispatchRefusal(other)).toBe(false);
  });
});
