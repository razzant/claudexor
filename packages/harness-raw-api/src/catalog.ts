import { createHash } from "node:crypto";
import type { CredentialProfile, HarnessModel } from "@claudexor/schema";
import type {
  HarnessModelSpec,
  ModelCatalogCredential,
  ModelCatalogFailure,
  ModelCatalogObservation,
} from "@claudexor/core";
import { namespacedSecretRefBase, resolveSecret } from "@claudexor/secrets";
import { parseModelsList, type ParsedModel } from "./parse.js";
import { redactAndBound } from "./providerError.js";

/** Model enumeration is interactive (a picker waits on it): keep it snappy. */
const RAW_API_MODELS_TIMEOUT_MS = 15_000;
const FAILURE_DETAIL_MAX_CHARS = 200;

type Env = Record<string, string | null | undefined>;

/** The parts of one configured instance that decide which key it may send where. */
export interface RawApiInstance {
  id: string;
  baseUrl: string;
  keyEnv: string;
}

/** The instance's default credential: its key variable, then its own secret slot. */
export function instanceApiKey(
  instance: RawApiInstance,
  env: Env = process.env,
): string | undefined {
  const value = env[instance.keyEnv];
  if (value) return value;
  // Secret fallback is INSTANCE-SCOPED so a key for one provider is never sent
  // to another (e.g. an OpenAI "raw" key must not reach openrouter.ai). The
  // default OpenAI-compatible instance owns the managed "raw" (and "openai")
  // secret; every named instance (openrouter, …) resolves ONLY its own slot.
  if (instance.id === "raw-api") {
    return (
      resolveSecret("raw") ??
      (instance.keyEnv === "OPENAI_API_KEY" ? (resolveSecret("openai") ?? undefined) : undefined)
    );
  }
  return resolveSecret(instance.id) ?? undefined;
}

/**
 * The key one request sends for a credential identity: ONE resolution for
 * `run()` and the catalog read, so a catalog is never read under another
 * account's key. INV-135 strict profile routing: a raw-api profile is exactly
 * its secret-ref API key, inside the instance fence — the default instance may
 * reference raw/openai slots, a NAMED instance only its own, and the ref must be
 * NAMESPACED (a bare ref would alias the engine-default slot).
 */
export function requestApiKey(
  instance: RawApiInstance,
  profile: CredentialProfile | null | undefined,
  env: Env | undefined,
): { key: string } | { refusal: string } {
  const { id } = instance;
  if (!profile) {
    const key = instanceApiKey(instance, { ...process.env, ...env });
    return key ? { key } : { refusal: `${id}: ${instance.keyEnv} not set` };
  }
  if (profile.credential_kind !== "api_key")
    return {
      refusal: `credential profile "${profile.profile_id}": ${id} supports only the api_key transport`,
    };
  const ref = profile.secret_ref ?? "";
  const base = namespacedSecretRefBase(ref);
  const allowed = id === "raw-api" ? ["raw", "openai"] : [id];
  if (!base || !allowed.includes(base))
    return {
      refusal: `credential profile "${profile.profile_id}": secret "${ref || "(missing ref)"}" is outside ${id}'s instance fence (namespaced base:profile refs only; allowed bases: ${allowed.join(", ")})`,
    };
  const key = (profile.secret_ref ? resolveSecret(profile.secret_ref) : null) ?? undefined;
  return key
    ? { key }
    : {
        refusal: `credential profile "${profile.profile_id}": secret "${profile.secret_ref ?? "(missing ref)"}" is not stored`,
      };
}

/** Non-secret identity of one key at one endpoint: a domain-separated,
 * truncated SHA-256. It binds an observation to its key without storing it. */
export function apiKeyFingerprint(baseUrl: string, key: string): string {
  return createHash("sha256")
    .update(`claudexor.api-key-fingerprint.v1\0${baseUrl.replace(/\/$/, "")}\0${key}`)
    .digest("hex")
    .slice(0, 16);
}

/** The key one catalog read resolved, for one instance and profile. Only the
 * fingerprint is public: the key is a private field, so no event, record, log
 * or copy of the observation carries it, and it lives as long as the read. */
class CheckedApiKey implements ModelCatalogCredential {
  readonly fingerprint: string;
  readonly #key: string;
  readonly #instanceId: string;
  readonly #profileId: string | null;

  constructor(
    instance: RawApiInstance,
    profile: CredentialProfile | null | undefined,
    key: string,
  ) {
    this.fingerprint = apiKeyFingerprint(instance.baseUrl, key);
    this.#key = key;
    this.#instanceId = instance.id;
    this.#profileId = profile?.profile_id ?? null;
  }

  static keyFor(
    credential: unknown,
    instance: RawApiInstance,
    profile: CredentialProfile | null | undefined,
  ): string | undefined {
    return credential instanceof CheckedApiKey &&
      credential.#instanceId === instance.id &&
      credential.#profileId === (profile?.profile_id ?? null)
      ? credential.#key
      : undefined;
  }
}

/**
 * The key `run()` sends: the one its spawn's dispatch read checked, when the
 * gate made that read for this instance and profile, so the catalog, the packet
 * sized from it and the request share one key resolution. A key replaced after
 * that check is read by the next spawn (#393 x #147). Without such a read the
 * key resolves now, exactly as the catalog read would.
 */
export function requestKeyFor(
  instance: RawApiInstance,
  profile: CredentialProfile | null | undefined,
  env: Env | undefined,
  dispatched: ModelCatalogObservation | undefined,
): { key: string } | { refusal: string } {
  const checked = CheckedApiKey.keyFor(dispatched?.credential, instance, profile);
  return checked ? { key: checked } : requestApiKey(instance, profile, env);
}

function unavailable(
  cause: ModelCatalogFailure["cause"],
  httpStatus: number | null,
  detail: string,
): ModelCatalogObservation {
  const bounded = redactAndBound(
    detail.replace(/\s+/g, " ").trim(),
    FAILURE_DETAIL_MAX_CHARS,
  ).value;
  return { status: "unavailable", failure: { cause, httpStatus, detail: bounded || "no detail" } };
}

function isTimeout(err: unknown): boolean {
  return err instanceof DOMException && err.name === "TimeoutError";
}

/** undici reports every transport failure as "fetch failed" and keeps the
 * reason in `cause`: a socket code (ECONNREFUSED, ENOTFOUND, ...) or, for a
 * refusal before any socket such as a blocked port, only a message. */
function networkDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error ? (err.cause as Record<string, unknown> | undefined) : undefined;
  const reason =
    typeof cause?.["code"] === "string" && cause["code"]
      ? cause["code"]
      : typeof cause?.["message"] === "string"
        ? cause["message"]
        : "";
  return reason && reason !== message ? `${message} (${reason})` : message;
}

/** Catalog metadata is copied only when known: absent means unknown, never "none". */
function harnessModel(row: ParsedModel): HarnessModel {
  return {
    id: row.id,
    label: row.label,
    context_window: row.context_window,
    // A live enumeration reflects the credentials it ran under; route
    // scoping is a manifest-annotation concept (W11), not an API fact.
    routes: null,
    ...(row.input_modalities ? { input_modalities: row.input_modalities } : {}),
    ...(row.max_output_tokens ? { max_output_tokens: row.max_output_tokens } : {}),
  };
}

/**
 * The REAL enumeration producer (ADP4): an OpenAI-compatible endpoint exposes
 * `GET <baseURL>/models`. The read is bound to the credential identity `run()`
 * would use and answers a complete catalog or a typed failure — never a
 * smaller list standing in for a failed or partial read (#393). Every answer
 * made with a key names it by fingerprint: a stored secret or key variable can
 * be replaced under the same profile id, so the id alone is no identity.
 */
export async function readRawApiCatalog(
  instance: RawApiInstance,
  spec?: HarnessModelSpec,
): Promise<ModelCatalogObservation> {
  const profile = spec?.credentialProfile;
  const credential = requestApiKey(instance, profile, spec?.env);
  if ("refusal" in credential) return unavailable("no_credential", null, credential.refusal);
  const read = await readCatalogWithKey(instance, credential.key, spec?.abortSignal);
  return { ...read, credential: new CheckedApiKey(instance, profile, credential.key) };
}

/** One GET of the catalog with an already resolved `key`. */
export async function readCatalogWithKey(
  instance: RawApiInstance,
  key: string,
  abortSignal?: AbortSignal,
): Promise<ModelCatalogObservation> {
  const timeout = AbortSignal.timeout(RAW_API_MODELS_TIMEOUT_MS);
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(`${instance.baseUrl.replace(/\/$/, "")}/models`, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${key}` },
      signal,
    });
  } catch (err) {
    return isTimeout(err)
      ? unavailable("timeout", null, `no answer within ${RAW_API_MODELS_TIMEOUT_MS / 1000}s`)
      : unavailable("network", null, networkDetail(err));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return unavailable(
      res.status === 401 || res.status === 403 ? "auth_rejected" : "http_status",
      res.status,
      body,
    );
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    return isTimeout(err)
      ? unavailable("timeout", res.status, "the catalog body did not finish arriving")
      : unavailable("malformed", res.status, "the answer is not JSON");
  }
  const parsed = parseModelsList(json);
  return parsed.ok
    ? { status: "listed", models: parsed.models.map(harnessModel) }
    : unavailable(parsed.cause, res.status, parsed.detail);
}
