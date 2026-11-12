import {
  AccountResourceObservation,
  emptyResourceFacet,
  observedResourceFacet,
  type AccountResourceTarget,
  type AccountSpending,
  type CredentialProfile,
} from "@claudexor/schema";
import {
  apiKeyFingerprint,
  instanceApiKey,
  requestApiKey,
  type RawApiInstance,
} from "./catalog.js";

/** The `ACCOUNT_RESOURCE_REFRESH_SOURCES` key this read publishes under. */
export const KEY_ALLOWANCE_SOURCE = "openrouter_key";
const KEY_ALLOWANCE_TIMEOUT_MS = 10_000;
const KEY_LIMIT_REASON =
  "This key's own spending limit, not the account's credit balance; the balance and workspace budgets can stop requests first. Display only: it never changes routing.";
const KEY_USAGE_REASON =
  "No limit is set on this key; the account's credit balance and workspace budgets still apply. Display only: it never changes routing.";

export interface KeyCredential {
  target: AccountResourceTarget;
  key: string;
  fingerprint: string;
}

/** The keys requests through this instance can send now: its default key
 * (the unregistered API-key route, profile_id null) and each enabled
 * registered API-key account, resolved exactly as `run()` resolves them. */
export function instanceKeyCredentials(
  instance: RawApiInstance,
  profiles: readonly CredentialProfile[],
  env: Record<string, string | null | undefined> = process.env,
): KeyCredential[] {
  const credentials: KeyCredential[] = [];
  const add = (profileId: string | null, key: string | undefined) => {
    if (key)
      credentials.push({
        target: { harness: instance.id, profile_id: profileId },
        key,
        fingerprint: apiKeyFingerprint(instance.baseUrl, key),
      });
  };
  add(null, instanceApiKey(instance, env));
  for (const profile of profiles) {
    if (profile.harness_id !== instance.id || profile.credential_kind !== "api_key") continue;
    if (!profile.enabled) continue;
    const resolved = requestApiKey(instance, profile, env);
    add(profile.profile_id, "key" in resolved ? resolved.key : undefined);
  }
  return credentials;
}

export type KeyAllowanceRead =
  | { ok: true; body: unknown }
  | { ok: false; reason: string; httpStatus: number | null; retryAfterMs: number | null };

function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

const isTimeout = (err: unknown) => err instanceof DOMException && err.name === "TimeoutError";

/** GET <base>/key: the provider's read of the calling key's own limit and
 * usage. It makes no generation and reads no account balance. Failures are
 * bounded codes; the response body is never retained (it could echo a key). */
export async function readKeyAllowance(
  baseUrl: string,
  key: string,
  timeoutMs = KEY_ALLOWANCE_TIMEOUT_MS,
): Promise<KeyAllowanceRead> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/key`, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      ok: false,
      reason: isTimeout(err) ? "timeout" : "network",
      httpStatus: null,
      retryAfterMs: null,
    };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    const reason =
      res.status === 401 || res.status === 403
        ? "auth_rejected"
        : res.status === 429
          ? "rate_limited"
          : "http_status";
    return {
      ok: false,
      reason,
      httpStatus: res.status,
      retryAfterMs: retryAfterMs(res.headers.get("retry-after"), Date.now()),
    };
  }
  try {
    return { ok: true, body: await res.json() };
  } catch (err) {
    return {
      ok: false,
      reason: isTimeout(err) ? "timeout" : "unrecognized_key_response",
      httpStatus: res.status,
      retryAfterMs: null,
    };
  }
}

type Row = Record<string, unknown>;
const record = (value: unknown): Row | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;

/** The provider's JSON number as a plain decimal string with no exponent and
 * no rounding beyond the number itself; undefined when it is not a number. */
export function decimalAmount(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const [, sign, whole, fraction = "", exponent] = match;
  const digits = whole! + fraction;
  const point = whole!.length + Number(exponent);
  const plain =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + "0".repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return sign + plain;
}

const LIMIT_WINDOWS: Record<string, NonNullable<AccountSpending["window"]>> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
};
const USAGE_FIELDS: Record<NonNullable<AccountSpending["window"]>, string> = {
  day: "usage_daily",
  week: "usage_weekly",
  month: "usage_monthly",
  lifetime: "usage",
};

/** One typed spending row for the key: its cap (or the provider's explicit
 * absence of one), the provider-reported amount left, and the spend counted
 * in the cap's window. A null limit is no per-key cap, never zero and never
 * unlimited money; a present malformed amount is a failed read, not a value. */
export function parseKeyAllowance(
  body: unknown,
  target: AccountResourceTarget,
  fingerprint: string,
  at: Date,
): AccountResourceObservation {
  const failed = (reason: string) =>
    AccountResourceObservation.parse({
      target,
      credential_fingerprint: fingerprint,
      spending: { ...emptyResourceFacet(), last_attempt_at: at.toISOString(), last_error: reason },
    });
  const data = record(record(body)?.["data"]);
  if (!data || !("limit" in data)) return failed("unrecognized_key_response");
  const amount = (value: unknown): string | null | undefined =>
    value === null || value === undefined ? null : decimalAmount(value);
  const limit = amount(data["limit"]);
  if (limit === undefined) return failed("invalid_key_amount");
  const capped = limit !== null;
  const remaining = capped ? amount(data["limit_remaining"]) : null;
  if (remaining === undefined) return failed("invalid_key_amount");
  const reset = data["limit_reset"];
  const window = !capped
    ? "month"
    : reset === null
      ? "lifetime"
      : typeof reset === "string"
        ? (LIMIT_WINDOWS[reset] ?? null)
        : null;
  // The provider's own budget layer for this cap (same cadence) carries the
  // exact spend and its reset instant; without it the window's usage counter
  // stands in, but only when BYOK spend does not also count toward the cap.
  const budget = Array.isArray(data["budgets"])
    ? data["budgets"]
        .map(record)
        .find((entry) => entry?.["scope"] === "key_limit" && entry["reset_interval"] === reset)
    : undefined;
  const budgetSpend = capped && budget ? amount(budget["spend_usd"]) : null;
  if (budgetSpend === undefined) return failed("invalid_key_amount");
  const counter =
    window === null || (capped && data["include_byok_in_limit"] === true)
      ? null
      : amount(data[USAGE_FIELDS[window]]);
  if (counter === undefined) return failed("invalid_key_amount");
  const resetsAt =
    capped && typeof budget?.["resets_at"] === "string" ? new Date(budget["resets_at"]) : null;
  const row: AccountSpending = {
    id: "openrouter_key_limit",
    label: "Key limit",
    enabled: null,
    capped,
    limit,
    remaining,
    used: budgetSpend ?? counter,
    window,
    unit: "USD",
    currency: "USD",
    decimal_places: null,
    fee_included: null,
    resets_at: resetsAt && Number.isFinite(resetsAt.getTime()) ? resetsAt.toISOString() : null,
    reason: capped ? KEY_LIMIT_REASON : KEY_USAGE_REASON,
  };
  return AccountResourceObservation.parse({
    target,
    credential_fingerprint: fingerprint,
    spending: observedResourceFacet([row], KEY_ALLOWANCE_SOURCE, at),
  });
}
