import type { harnessBinaryIdentity } from "@claudexor/core";
import { redactSecrets } from "@claudexor/util";

/** A receipt of observed work, not an estimate of the vendor's request budget.
 * Native RPC/process calls may perform unobserved HTTP requests internally. */
export interface QuotaRefreshDiagnostic {
  operationId: string;
  source: string;
  profileId: string | null;
  at: string;
  foreground: boolean;
  credentialEpoch: number | null;
  current: boolean | null;
  stage: "credential_read" | "native_refresh" | "native_rpc" | "usage_http" | "poll";
  outcome: "started" | "succeeded" | "failed" | "skipped";
  reason?: string;
  httpStatus?: number;
  retryAfterMs?: number | null;
  expiresAtMs?: number | null;
  previousExpiresAtMs?: number | null;
  hasRefreshToken?: boolean;
  binary?: ReturnType<typeof harnessBinaryIdentity>;
  nativeRpcCode?: number | null;
  native?: {
    binary: ReturnType<typeof harnessBinaryIdentity>;
    expiresAtMs: number | null;
    exitCode: number | null;
    signal: string | null;
    terminationUnconfirmed: boolean;
    childFailed: boolean;
  };
}

export type QuotaDiagnosticSink = (record: QuotaRefreshDiagnostic) => void;

/** Keep the old parser's one-line JSON receipt. The writer supplies the budget
 * left after its timestamp, label and newline. Count omitted UTF-8 bytes of
 * redacted string values, before JSON escaping or adding an ellipsis. */
export function quotaObservationJson(record: QuotaRefreshDiagnostic, budget: number): string {
  // The replacer visits the omission count after measuring all the receipt's values.
  const receipt = { ...record, omittedTextBytes: 0 };
  let limit = budget;
  for (;;) {
    let omitted = 0;
    let detailBytes = 0;
    let longest = 0;
    const json = JSON.stringify(receipt, (key, value: unknown) => {
      if (key === "omittedTextBytes") return omitted || undefined;
      if (typeof value !== "string") return value;
      const safe = redactSecrets(value);
      if (key === "operationId" || key === "stage" || key === "outcome") return safe;
      const bytes = Buffer.byteLength(safe);
      detailBytes += bytes;
      if (key === "source" || key === "at") return safe;
      longest = Math.max(longest, Math.min(bytes, limit));
      if (bytes <= limit) return safe;
      const prefix = Buffer.allocUnsafe(limit);
      const kept = prefix.write(safe); // ends on a whole UTF-8 character
      omitted += bytes - kept;
      return `${prefix.toString("utf8", 0, kept)}…`;
    });
    const excess = Buffer.byteLength(json) - budget;
    if (excess <= 0) return json;
    if (longest === 0) {
      // The daemon-generated UUID and enums fit even the smallest writer.
      // A small configured writer may not fit the native metadata's keys.
      return JSON.stringify({
        operationId: redactSecrets(record.operationId),
        stage: record.stage,
        outcome: record.outcome,
        omittedTextBytes: detailBytes,
      });
    }
    // JSON escaping can make the excess larger than the entire unescaped field.
    const reduction = Math.min(excess, Math.ceil(longest / 2));
    limit = longest - reduction;
  }
}

export function emitQuotaDiagnostic(
  sink: QuotaDiagnosticSink | undefined,
  record: QuotaRefreshDiagnostic,
): void {
  try {
    sink?.(record);
  } catch {
    // Logs never decide whether a refresh succeeded or whether it may retry.
  }
}

/** One redacted receipt for a measured window whose model scope is unknown
 * (#394): its identity, usage and reset stay evidence. It is neither an
 * account-wide limit nor proof that the account is available. */
export function unknownQuotaScopeReason(window: {
  id: string;
  group?: string;
  used_ratio: number | null;
  resets_at: string | null;
}): string {
  const field = (value: string) => redactSecrets(value).slice(0, 80);
  const used = window.used_ratio === null ? "unknown" : `${Math.round(window.used_ratio * 100)}%`;
  return [
    `unknown_scope=${field(window.id)}`,
    ...(window.group === undefined ? [] : [`group=${field(window.group)}`]),
    `used=${used}`,
    `resets=${window.resets_at === null ? "unknown" : field(window.resets_at)}`,
  ].join(" ");
}
