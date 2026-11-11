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
