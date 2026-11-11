import { describe, expect, it } from "vitest";
import { ControlModelCatalogResponse, ControlProblem, ModelCallRequest } from "@claudexor/schema";
import { CredentialGeneration } from "./credential-generation.js";
import { ModelCapabilityLedger, MODEL_CAPABILITY_TTL_MS } from "./model-capability-ledger.js";

const request = ModelCallRequest.parse({
  source: "codex",
  model: "m",
  account: { mode: "auto" },
  messages: [{ role: "user", content: "hello" }],
});
const problem = ControlProblem.parse({
  code: "model_capability_refused",
  message: "no model",
  retryable: false,
  context: { retryOnOtherAccount: true, providerReason: "model unavailable" },
});
function fixture() {
  let now = Date.parse("2026-10-20T00:00:00Z");
  const credentials = new CredentialGeneration(() => false);
  const ledger = new ModelCapabilityLedger(credentials, () => now);
  const catalog = ControlModelCatalogResponse.parse({
    source: "codex",
    credentialProfileId: "a",
    accountFingerprint: "a",
    capabilityFingerprint: "plan-free",
    observedAt: new Date(now).toISOString(),
    provenance: "provider_http",
    models: [],
  });
  const observe = () =>
    ledger.observeCatalog("codex", catalog, credentials.generation("codex", "a"));
  observe();
  const bind = () => ledger.bind("codex", catalog, "m");
  const refuse = (id = "one", binding = bind()) => {
    ledger.refuse(binding, id, problem, request);
    return binding;
  };
  return {
    ledger,
    credentials,
    catalog,
    bind,
    refuse,
    observe,
    tick: (ms: number) => {
      now += ms;
      catalog.observedAt = new Date(now).toISOString();
    },
  };
}

describe("temporary model capability evidence", () => {
  it("demotes only the refused model and exposes a redacted reason, since and probe time", () => {
    const f = fixture();
    f.refuse();
    expect(f.ledger.state("codex", "a", "other")).toBeNull();
    expect(f.ledger.live()).toMatchObject([
      {
        profile_id: "a",
        requested_model: "m",
        state: "provisional",
        provider_reason: "model unavailable",
        observed_at: "2026-10-20T00:00:00.000Z",
        expires_at: "2026-10-20T04:00:00.000Z",
      },
    ]);
  });
  it("allows exactly one concurrent expiry probe; unknown outcome postpones the next probe", () => {
    const f = fixture();
    f.refuse();
    f.tick(MODEL_CAPABILITY_TTL_MS);
    expect(f.ledger.state("codex", "a", "m")).toBe("probe_due");
    expect(f.ledger.reserve(f.bind(), "probe1")).toBe(true);
    expect(f.ledger.reserve(f.bind(), "probe2")).toBe(false);
    expect(f.ledger.state("codex", "a", "m")).toBe("probing");
    f.ledger.release(f.bind(), "probe1");
    expect(f.ledger.state("codex", "a", "m")).toBe("provisional");
  });
  it("success clears a probe and refusal re-marks it", () => {
    const f = fixture();
    f.refuse();
    f.tick(MODEL_CAPABILITY_TTL_MS);
    const b = f.bind();
    f.ledger.reserve(b, "probe");
    f.refuse("probe", b);
    expect(f.ledger.state("codex", "a", "m")).toBe("provisional");
    f.tick(MODEL_CAPABILITY_TTL_MS);
    const c = f.bind();
    f.ledger.reserve(c, "probe3");
    f.ledger.served(c);
    expect(f.ledger.live()).toEqual([]);
  });
  it("a late refusal cannot release a newer operation's probe", () => {
    const f = fixture();
    const old = f.refuse();
    f.tick(MODEL_CAPABILITY_TTL_MS);
    expect(f.ledger.reserve(f.bind(), "probe")).toBe(true);
    f.refuse("late", old);
    expect(f.ledger.state("codex", "a", "m")).toBe("probing");
    expect(f.ledger.reserve(f.bind(), "another")).toBe(false);
  });
  it.each(["accountFingerprint", "capabilityFingerprint", "clientVersion"] as const)(
    "clears on %s change and rejects late outcomes",
    (field) => {
      const f = fixture();
      const b = f.refuse();
      f.tick(1);
      f.catalog[field] = "changed";
      f.observe();
      f.refuse("late", b);
      expect(f.ledger.live()).toEqual([]);
    },
  );
  it("clears when model metadata changes, but not merely on catalog refresh", () => {
    const f = fixture();
    f.refuse();
    f.tick(1);
    f.observe();
    expect(f.ledger.live()).toHaveLength(1);
    f.catalog.models = [
      {
        id: "new",
        label: null,
        isDefault: true,
        contextWindow: null,
        maxContextWindow: null,
        maxOutputTokens: null,
        inputModalities: [],
        reasoningEfforts: [],
        defaultReasoningEffort: null,
        supportedOptions: [],
      },
    ];
    f.observe();
    expect(f.ledger.live()).toEqual([]);
  });
  it("invalidates the account generation and does not resurrect old refusals", () => {
    const f = fixture();
    const b = f.refuse();
    f.credentials.clearSubject("codex", "a");
    f.refuse("late", b);
    expect(f.ledger.live()).toEqual([]);
  });
  it("cannot bind a previously read catalog to a new credential generation", () => {
    const f = fixture();
    f.credentials.clearSubject("codex", "a");
    expect(f.ledger.current(f.bind())).toBe(false);
  });
  it("ignores a late failure bound before a later successful request", () => {
    const f = fixture();
    const old = f.bind();
    f.ledger.served(f.bind());
    f.refuse("late", old);
    expect(f.ledger.live()).toEqual([]);
  });
  it("does not clear a newer concurrent failure with an older success", () => {
    const f = fixture();
    const old = f.bind();
    f.refuse();
    f.ledger.served(old);
    expect(f.ledger.live()).toHaveLength(1);
  });
  it("an older success cannot roll back the watermark protecting newer service", () => {
    const f = fixture();
    const old = f.bind();
    const middle = f.bind();
    f.ledger.served(f.bind());
    f.ledger.served(old);
    f.refuse("late", middle);
    expect(f.ledger.live()).toEqual([]);
  });
  it("retains provisional equivalent-refusal evidence and independently confirms service", () => {
    const f = fixture();
    f.refuse("one");
    f.ledger.settleRetry("one", "equivalent_refusal");
    expect(f.ledger.state("codex", "a", "m")).toBe("provisional");
    f.refuse("two");
    f.ledger.settleRetry("one", "confirmed");
    expect(f.ledger.state("codex", "a", "m")).toBe("confirmed");
    f.ledger.settleRetry("two", "equivalent_refusal");
    expect(f.ledger.live()).toHaveLength(1);
    expect(f.ledger.state("codex", "a", "m")).toBe("confirmed");
  });
  it("claims one matching auto retry atomically and rejects a second caller", () => {
    const f = fixture();
    f.refuse();
    const retry = { ...request, retryOfOperationId: "one" };
    expect(f.ledger.claimRetry(retry, "two")).not.toBeNull();
    expect(() => f.ledger.claimRetry(retry, "three")).toThrow("unused");
  });
  it.each(["changed_request", "pin", "expired", "identity"])(
    "rejects an invalid retry: %s",
    (kind) => {
      const f = fixture();
      f.refuse();
      const retry = { ...request, retryOfOperationId: "one" };
      if (kind === "changed_request") retry.messages = [{ role: "user", content: "different" }];
      if (kind === "pin") retry.account = { mode: "pin", profileId: "a" };
      if (kind === "expired") f.tick(MODEL_CAPABILITY_TTL_MS);
      if (kind === "identity") f.credentials.clearSubject("codex", "a");
      expect(() => f.ledger.claimRetry(retry, "two")).toThrow("Capability retry");
    },
  );
});
