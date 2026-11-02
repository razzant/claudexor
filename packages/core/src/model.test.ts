import { describe, expect, it } from "vitest";
import { HarnessModel } from "@claudexor/schema";
import {
  HarnessUnavailableError,
  ModelCatalogUnavailableError,
  modelCatalogFailureRetryable,
} from "./errors.js";
import {
  catalogRowFor,
  chosenModel,
  hasModelInventoryForRoute,
  missingRouteModel,
  modelCatalogFailureRefuses,
  observedModelCatalogMatch,
  readModelCatalog,
  routingVariantOf,
  validateModel,
  validateModelOnUnreadCatalog,
} from "./model.js";

describe("validateModel under an AUTHORITATIVE declaration (strict model truth)", () => {
  const known = ["sonnet", "opus", "claude-opus-4-8"];

  it("is ok when no model is requested (the harness default is used)", () => {
    expect(validateModel(null, known, "manifest", "authoritative").status).toBe("ok");
    expect(validateModel(undefined, known, "manifest", "authoritative").status).toBe("ok");
    expect(validateModel("", known, "manifest", "authoritative").status).toBe("ok");
  });

  it("is ok for a known alias/id", () => {
    expect(validateModel("opus", known, "manifest", "authoritative").status).toBe("ok");
    expect(validateModel("claude-opus-4-8", known, "manifest", "authoritative").status).toBe("ok");
    expect(validateModel("  opus  ", known, "manifest", "authoritative").status).toBe("ok"); // trimmed
  });

  it("REJECTS an explicit model when the harness has no truth list (never forwarded to die natively)", () => {
    const manifest = validateModel("anything", [], "manifest", "authoritative");
    expect(manifest.status).toBe("rejected");
    expect(manifest.message).toContain("cannot verify models");
    expect(manifest.message).toContain("manifest known_models");
    const api = validateModel("anything", [], "api", "authoritative");
    expect(api.status).toBe("rejected");
    expect(api.message).toContain("live model inventory");
    expect(api.message).toContain("repair the live account/auth route");
    expect(api.message).not.toContain("known_models");
  });

  it("REJECTS a miss naming the truth source and the list (the fable regression, now typed)", () => {
    const r = validateModel("fable-x", known, "manifest", "authoritative");
    expect(r.status).toBe("rejected");
    expect(r.message).toContain('model "fable-x"');
    expect(r.message).toContain("manifest known-model list");
    expect(r.message).toContain("sonnet");
  });

  it("REJECTS an api-inventory miss", () => {
    const r = validateModel("ghost", ["gpt-4o", "gpt-4o-mini"], "api", "authoritative");
    expect(r.status).toBe("rejected");
    expect(r.message).toContain("live model inventory");
  });

  it("truncates giant truth lists in the refusal message", () => {
    const big = Array.from({ length: 120 }, (_, i) => `m-${i}`);
    const r = validateModel("nope", big, "api", "authoritative");
    expect(r.status).toBe("rejected");
    expect(r.message).toContain("(120 total)");
  });
});

/**
 * An ADVISORY declaration (INV-104; owner-approved 2026-09-21 for a live
 * producer, 2026-09-24 for the harness as a whole): a harness that cannot
 * enumerate what its runtime accepts proves PRESENCE only. Absence stops being
 * a reason to refuse — the explicit model is forwarded to the vendor and the
 * note says so. The declaration is the harness's, so it governs its manifest
 * hint list exactly like its live answer; everything authoritative keeps
 * today's exact text.
 */
describe("validateModel under an ADVISORY declaration", () => {
  const stale = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2"];

  it("FORWARDS a model the live list lacks, with the unverified note", () => {
    const r = validateModel("gpt-6-astra", stale, "api", "advisory");
    expect(r.status).toBe("ok");
    expect(r.unverified).toBe(true);
    expect(r.message).toBe(
      "model \"gpt-6-astra\" is not in this account's listed models; this harness's list " +
        "cannot prove a model is absent, so the request is forwarded to the vendor",
    );
  });

  it("FORWARDS on an empty live list (the second live failure mode), saying which case it is", () => {
    const r = validateModel("gpt-6-astra", [], "api", "advisory");
    expect(r.status).toBe("ok");
    expect(r.unverified).toBe(true);
    expect(r.message).toBe(
      "the harness returned no model list; this harness's list cannot prove a model is " +
        "absent, so the request is forwarded to the vendor",
    );
  });

  it("stays silent for a LISTED model: presence is proof, so there is nothing to disclose", () => {
    const r = validateModel("gpt-5.5", stale, "api", "advisory");
    expect(r.status).toBe("ok");
    expect(r.message).toBeNull();
    expect(r.unverified).toBeUndefined();
    const none = validateModel(null, stale, "api", "advisory");
    expect(none.status).toBe("ok");
    expect(none.message).toBeNull();
    expect(none.unverified).toBeUndefined();
  });

  it("governs the MANIFEST hint list the same way: a hint list is one day's memory of the same vendor menu", () => {
    const miss = validateModel("gpt-6-astra", stale, "manifest", "advisory");
    expect(miss.status).toBe("ok");
    expect(miss.unverified).toBe(true);
    expect(miss.message).toBe(
      'model "gpt-6-astra" is not in this harness\'s manifest known-model list; this ' +
        "harness's list cannot prove a model is absent, so the request is forwarded to the vendor",
    );
    const empty = validateModel("gpt-6-astra", [], "manifest", "advisory");
    expect(empty.status).toBe("ok");
    expect(empty.unverified).toBe(true);
    expect(empty.message).toBe(
      "the harness manifest lists no models; this harness's list cannot prove a model is " +
        "absent, so the request is forwarded to the vendor",
    );
    // Presence is still proof on the manifest side: nothing to disclose.
    expect(validateModel("gpt-5.5", stale, "manifest", "advisory")).toEqual({
      status: "ok",
      message: null,
    });
  });

  it("keeps the authoritative refusals byte-identical on both sources", () => {
    expect(validateModel("gpt-6-astra", stale, "api", "authoritative")).toEqual({
      status: "rejected",
      message:
        'model "gpt-6-astra" is not in the harness\'s live model inventory ' +
        "(gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.2)",
    });
    expect(validateModel("gpt-6-astra", stale, "manifest", "authoritative")).toEqual({
      status: "rejected",
      message:
        'model "gpt-6-astra" is not in the harness\'s manifest known-model list ' +
        "(gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.2)",
    });
    expect(validateModel("gpt-6-astra", [], "api", "authoritative")).toEqual({
      status: "rejected",
      message:
        "this harness cannot verify models (no live model inventory); repair the live " +
        "account/auth route or use the harness default (omit the model)",
    });
    expect(validateModel("gpt-6-astra", [], "manifest", "authoritative")).toEqual({
      status: "rejected",
      message:
        "this harness cannot verify models (no manifest known_models); use the harness " +
        "default (omit the model) or add known_models to the manifest",
    });
  });
});

describe("a FAILED catalog read is no list at all (#393)", () => {
  const failure = { cause: "auth_rejected" as const, httpStatus: 401, detail: "invalid key" };
  const network = {
    cause: "network" as const,
    httpStatus: null,
    detail: "fetch failed (ECONNREFUSED)",
  };

  it("refuses an explicit model on an AUTHORITATIVE harness only for a missing or rejected credential", () => {
    expect(validateModelOnUnreadCatalog("vendor/m", failure, "authoritative")).toEqual({
      status: "rejected",
      catalogFailure: failure,
      message:
        "the live model catalog could not be read (auth_rejected; HTTP 401: invalid key), so " +
        'model "vendor/m" cannot be verified; the endpoint rejected the API key: replace it or ' +
        "check its access",
    });
    const missing = { cause: "no_credential" as const, httpStatus: null, detail: "KEY not set" };
    expect(validateModelOnUnreadCatalog("vendor/m", missing, "authoritative")).toMatchObject({
      status: "rejected",
      catalogFailure: missing,
    });
    expect(validateModelOnUnreadCatalog("vendor/m", missing, "authoritative").message).toContain(
      "cannot be verified; configure this route's API key",
    );
    expect(modelCatalogFailureRefuses(failure)).toBe(true);
    expect(modelCatalogFailureRefuses(missing)).toBe(true);
    expect(validateModelOnUnreadCatalog(null, failure, "authoritative")).toEqual({
      status: "ok",
      message: null,
    });
  });

  it("forwards an explicit model unverified on the same key when the catalog is unavailable or unusable (decision A)", () => {
    expect(validateModelOnUnreadCatalog("vendor/m", network, "authoritative")).toEqual({
      status: "ok",
      unverified: true,
      message:
        "the live model catalog could not be read (network; fetch failed (ECONNREFUSED)), so " +
        'model "vendor/m" could not be verified; it is sent unchanged on the same key and the ' +
        "provider accepts or refuses it",
    });
    for (const [cause, httpStatus] of [
      ["http_status", 503],
      ["http_status", 404],
      ["http_status", 429],
      ["timeout", null],
      ["malformed", 200],
      ["incomplete", 200],
    ] as const) {
      const read = { cause, httpStatus, detail: "x" };
      const check = validateModelOnUnreadCatalog("vendor/m", read, "authoritative");
      expect(check, `${cause} ${httpStatus}`).toMatchObject({ status: "ok", unverified: true });
      expect(check.catalogFailure).toBeUndefined();
      expect(check.message).toContain("could not be verified");
      expect(check.message).not.toContain("is not in the harness's live model inventory");
      expect(modelCatalogFailureRefuses(read)).toBe(false);
    }
  });

  it("keeps an ADVISORY harness's declaration: the read proves nothing, so the model forwards with the failure named", () => {
    expect(validateModelOnUnreadCatalog("vendor/m", network, "advisory")).toEqual({
      status: "ok",
      unverified: true,
      message:
        "the live model catalog could not be read (network; fetch failed (ECONNREFUSED)); this " +
        "harness's list cannot prove a model is absent, so the request is forwarded to the vendor",
    });
  });

  it("types the refusal every consumer raises; the listing's problem keeps its retry verdict", () => {
    const refused = new ModelCatalogUnavailableError("harness 'x' refused model 'm'", failure);
    expect(refused).toBeInstanceOf(HarnessUnavailableError);
    expect(refused).toMatchObject({
      code: "model_catalog_unavailable",
      category: "auth",
      retryable: false,
      failure,
    });
    // `modelCatalogFailureRetryable` still decides the listing problem's verdict.
    const status = (httpStatus: number) => ({
      cause: "http_status" as const,
      httpStatus,
      detail: "",
    });
    expect(modelCatalogFailureRetryable(status(503))).toBe(true);
    expect(modelCatalogFailureRetryable(status(429))).toBe(true);
    expect(modelCatalogFailureRetryable(status(404))).toBe(false);
    expect(modelCatalogFailureRetryable({ cause: "malformed", httpStatus: 200, detail: "" })).toBe(
      false,
    );
    expect(
      modelCatalogFailureRetryable({ cause: "no_credential", httpStatus: null, detail: "" }),
    ).toBe(false);
  });

  it("phrases a SUCCESSFUL empty catalog as one, without account/auth advice", () => {
    const empty = validateModel("vendor/m", [], "api", "authoritative", { catalogRead: true });
    expect(empty).toEqual({
      status: "rejected",
      message:
        'model "vendor/m" is not in the harness\'s live model inventory (the catalog lists no models)',
    });
    // A fail-soft producer's [] keeps today's text: it may be a failed read.
    expect(validateModel("vendor/m", [], "api", "authoritative").message).toContain(
      "repair the live account/auth route",
    );
  });

  it("reads typed producers as typed and legacy fail-soft producers as before", async () => {
    const row = HarnessModel.parse({ id: "m" });
    expect(await readModelCatalog({ models: async () => [row] })).toEqual({
      status: "listed",
      models: [row],
      failSoft: true,
    });
    const typed = {
      models: async () => [],
      modelCatalog: async () => ({ status: "listed" as const, models: [] }),
    };
    expect(await readModelCatalog(typed)).toEqual({
      status: "listed",
      models: [],
      failSoft: false,
    });
    const failed = {
      models: async () => [],
      modelCatalog: async () => ({ status: "unavailable" as const, failure }),
    };
    expect(await readModelCatalog(failed)).toEqual({ status: "unavailable", failure });
  });
});

describe("declared routing variants (#145)", () => {
  const variants = [
    { suffix: ":nitro", billing: "service_tier" as const },
    { suffix: ":floor", billing: "service_tier" as const },
    { suffix: ":exacto", billing: "base" as const },
  ];
  const listed = ["openai/gpt-5.2", "vendor/laguna:free"];
  const check = (model: string, declared = variants) =>
    validateModel(model, listed, "api", "authoritative", {
      catalogRead: true,
      routingVariants: declared,
    });

  it("admits a declared routing variant of a listed row and discloses it with its billing effect", () => {
    expect(check("openai/gpt-5.2:nitro")).toEqual({
      status: "ok",
      unverified: true,
      message:
        'model "openai/gpt-5.2:nitro" is listed model "openai/gpt-5.2" with routing variant ' +
        ":nitro; it is sent unchanged, the provider picks the endpoint, and :nitro may bill " +
        "that endpoint's service-tier rate instead of the listed price",
    });
    expect(check("openai/gpt-5.2:exacto").message).toBe(
      'model "openai/gpt-5.2:exacto" is listed model "openai/gpt-5.2" with routing variant ' +
        ":exacto; it is sent unchanged, the provider picks the endpoint, and it bills the listed price",
    );
    expect(check("openai/gpt-5.2:floor").status).toBe("ok");
    // Stacked trailing variants resolve to the same listed row.
    expect(check("openai/gpt-5.2:nitro:exacto").message).toContain("routing variant :nitro:exacto");
  });

  it("keeps a catalog variant in the row id: m:free:nitro needs m:free itself listed", () => {
    expect(check("vendor/laguna:free:nitro")).toMatchObject({ status: "ok", unverified: true });
    expect(check("openai/gpt-5.2:free:nitro")).toMatchObject({ status: "rejected" });
    expect(routingVariantOf("vendor/laguna:free:nitro", variants)?.metadataId).toBe(
      "vendor/laguna:free",
    );
  });

  it("admits the documented any-order combinations without assuming a catalog variant", () => {
    // OpenRouter: suffixes "can be combined in any order"; one catalog variant,
    // any number of routing variants. Only declared routing segments are removed.
    expect(check("vendor/laguna:nitro:free")).toMatchObject({ status: "ok", unverified: true });
    expect(check("vendor/laguna:nitro:free").message).toContain(
      'is listed model "vendor/laguna:free" with routing variant :nitro;',
    );
    expect(routingVariantOf("vendor/laguna:nitro:free", variants)?.metadataId).toBe(
      "vendor/laguna:free",
    );
    expect(check("openai/gpt-5.2:exacto:nitro").message).toContain(
      "routing variant :exacto:nitro;",
    );
    for (const model of [
      "openai/gpt-5.2:nitro:free", // its :free row is not listed: never assumed
      "openai/gpt-5.2:nitro:unknownsuffix",
      "openai/gpt-5.2:online:nitro",
      "openai/gpt-5.2:nitro:online",
    ])
      expect(check(model).status, model).toBe("rejected");
  });

  it("refuses :online, an unknown suffix, an unlisted base and a bare suffix by exact membership", () => {
    for (const model of [
      "openai/gpt-5.2:online",
      "openai/gpt-5.2:unknownsuffix",
      "openai/gpt-9:nitro",
      ":nitro",
    ])
      expect(check(model).status, model).toBe("rejected");
    // A catalog row's own id never needs a variant note.
    expect(check("vendor/laguna:free")).toEqual({ status: "ok", message: null });
  });

  it("refuses a declared refused variant in any position, listed or not, read or not (#393)", () => {
    const refusedVariants = [{ suffix: ":online", reason: "provider_web_search" as const }];
    const failed = { cause: "http_status" as const, httpStatus: 503, detail: "down" };
    const reason =
      "carries the :online variant, which this harness refuses: the provider would search the web for the request, outside this route's web policy";
    for (const model of [
      "openai/gpt-5.2:online",
      "openai/gpt-5.2:nitro:online",
      "vendor/laguna:online:free",
    ]) {
      // Even a list that names the id cannot admit it.
      const listedCheck = validateModel(model, [...listed, model], "api", "authoritative", {
        catalogRead: true,
        routingVariants: variants,
        refusedVariants,
      });
      expect(listedCheck, model).toMatchObject({
        status: "rejected",
        refusedVariant: refusedVariants[0],
      });
      expect(listedCheck.message).toBe(`model "${model}" ${reason}`);
      for (const absence of ["authoritative", "advisory"] as const)
        expect(
          validateModelOnUnreadCatalog(model, failed, absence, { refusedVariants }),
          `${model} ${absence}`,
        ).toMatchObject({ status: "rejected", refusedVariant: refusedVariants[0] });
    }
    // Negative control: without the declaration a failed read forwards it, and a
    // base id or a mere substring is never mistaken for the suffix.
    expect(
      validateModelOnUnreadCatalog("openai/gpt-5.2:online", failed, "authoritative"),
    ).toMatchObject({
      status: "ok",
      unverified: true,
    });
    for (const model of ["vendor/online", "vendor/m:onlinex", "vendor/laguna:free"])
      expect(
        validateModelOnUnreadCatalog(model, failed, "authoritative", { refusedVariants }).status,
        model,
      ).toBe("ok");
  });

  it("changes nothing for a harness that declares no routing variants (generic endpoints)", () => {
    expect(check("openai/gpt-5.2:nitro", [])).toMatchObject({ status: "rejected" });
    expect(validateModel("openai/gpt-5.2:nitro", listed, "api", "authoritative").status).toBe(
      "rejected",
    );
    expect(routingVariantOf("openai/gpt-5.2:nitro", [])).toBeNull();
  });

  it("resolves metadata of a composite id to its listed row", () => {
    const rows = [
      HarnessModel.parse({ id: "openai/gpt-5.2", context_window: 400000 }),
      HarnessModel.parse({ id: "vendor/laguna:free", context_window: 32768 }),
    ];
    expect(catalogRowFor("openai/gpt-5.2:nitro", rows, variants)?.context_window).toBe(400000);
    expect(catalogRowFor("vendor/laguna:free:nitro", rows, variants)?.context_window).toBe(32768);
    expect(catalogRowFor("vendor/laguna:nitro:free", rows, variants)?.context_window).toBe(32768);
    expect(catalogRowFor("openai/gpt-5.2:nitro:free", rows, variants)).toBeNull();
    expect(catalogRowFor("openai/gpt-5.2:online", rows, variants)).toBeNull();
  });
});

describe("model inventory credential routes", () => {
  it("keeps legacy enumeration and queries scoped producers only on their declared routes", () => {
    const adapter = { models: async () => [] };
    expect(hasModelInventoryForRoute(adapter, undefined, "api_key")).toBe(true);
    expect(hasModelInventoryForRoute(adapter, ["local_session"], null)).toBe(false);
    expect(hasModelInventoryForRoute(adapter, ["local_session"], "local_session")).toBe(true);
    expect(hasModelInventoryForRoute(adapter, ["local_session"], "api_key")).toBe(false);
    expect(hasModelInventoryForRoute({}, ["local_session"], "local_session")).toBe(false);
  });
});

// Synthetic Cursor-style `--list-models` rows: no recorded real catalog/init pair exists.
describe("observedModelCatalogMatch (synthetic catalogs)", () => {
  const row = (id: string, label: string | null, origin?: "hint") =>
    HarnessModel.parse({ id, label, ...(origin ? { origin } : {}) });
  const catalog = [
    row("gpt-5.5-high", "GPT-5.5 High"),
    row("gpt-5.5-high-fast", "GPT-5.5 High Fast"),
    row("gpt-5.5", "GPT-5.5"),
    row("auto", "auto"),
    row("unlabelled-model", null),
  ];

  it("names the only row whose label is byte-identical, keeping full speed/effort variants", () => {
    expect(observedModelCatalogMatch("GPT-5.5 High", catalog, null)).toEqual({
      label: "GPT-5.5 High",
      id: "gpt-5.5-high",
      source: "account_catalog",
      profile_id: null,
    });
    expect(observedModelCatalogMatch("GPT-5.5 High Fast", catalog, "cursor-work")).toEqual({
      label: "GPT-5.5 High Fast",
      id: "gpt-5.5-high-fast",
      source: "account_catalog",
      profile_id: "cursor-work",
    });
    // A row may legitimately carry its own id as its label.
    expect(observedModelCatalogMatch("auto", catalog, null)?.id).toBe("auto");
  });

  it("is no proof without exact equality: no trim, case-fold, spacing or id-as-label reading", () => {
    for (const observed of [
      "gpt-5.5 high",
      "GPT-5.5 HIGH",
      " GPT-5.5 High",
      "GPT-5.5 High ",
      "GPT-5.5  High",
      "GPT-5.5-High",
      "GPT-5.5 Hi",
      // A listed id is not a label: the raw observed string already names it.
      "gpt-5.5-high",
      "unlabelled-model",
    ])
      expect(observedModelCatalogMatch(observed, catalog, null)).toBeNull();
  });

  it("is no proof when the label is ambiguous or collides with another row's id", () => {
    const duplicated = [...catalog, row("gpt-5.5-high-legacy", "GPT-5.5 High")];
    expect(observedModelCatalogMatch("GPT-5.5 High", duplicated, null)).toBeNull();
    const colliding = [row("composer-2", "Composer"), row("Composer", "Composer Legacy")];
    expect(observedModelCatalogMatch("Composer", colliding, null)).toBeNull();
  });

  it("is no proof from a hint row, an empty catalog, a blank string or an invalid profile id", () => {
    const hinted = [row("gpt-5.5-high", "GPT-5.5 High", "hint")];
    expect(observedModelCatalogMatch("GPT-5.5 High", hinted, null)).toBeNull();
    // A hint row still counts as an id collision: never weaker than the live rows.
    const shadowed = [row("Composer", null, "hint"), row("composer-2", "Composer")];
    expect(observedModelCatalogMatch("Composer", shadowed, null)).toBeNull();
    expect(observedModelCatalogMatch("GPT-5.5 High", [], null)).toBeNull();
    const blank = [row("blank-label", " "), row("empty-label", "")];
    expect(observedModelCatalogMatch(" ", blank, null)).toBeNull();
    expect(observedModelCatalogMatch("", blank, null)).toBeNull();
    expect(observedModelCatalogMatch("GPT-5.5 High", catalog, "")).toBeNull();
  });
});

describe("a route that must name a model (#395)", () => {
  const requires = (instanceChoice: { model: string; source: string } | null, env?: string) => ({
    id: "route",
    modelRequirement: { instanceChoice, ...(env ? { env } : {}) },
  });

  it("a blank model was never a choice; any other keeps its exact bytes", () => {
    expect(chosenModel(null)).toBeNull();
    expect(chosenModel(undefined)).toBeNull();
    expect(chosenModel("")).toBeNull();
    expect(chosenModel(" \t\n")).toBeNull();
    expect(chosenModel(" vendor/m ")).toBe(" vendor/m ");
  });

  it("refuses only a route that requires one and has none, naming what repairs it once", () => {
    const refusal = missingRouteModel(requires(null, "ROUTE_MODEL"), "   ");
    expect(refusal).toContain("route needs a model and none is selected; nothing was sent");
    expect(refusal).toContain("`claudexor models --harness route`");
    expect(refusal).toContain("`claudexor settings set harness.route.default_model <model>`");
    expect(refusal).toContain("or set ROUTE_MODEL");
    expect(missingRouteModel(requires(null), null)).not.toContain(", or set");
    expect(missingRouteModel(requires(null), "vendor/m")).toBeNull();
    expect(missingRouteModel(requires({ model: "m", source: "ENV" }), null)).toBeNull();
    // A route whose vendor chooses is not this rule's business.
    expect(missingRouteModel({ id: "cli" }, null)).toBeNull();
  });
});
