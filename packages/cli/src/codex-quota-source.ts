import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig } from "@claudexor/config";
import { providerScrubEnv } from "@claudexor/core";
import type { QuotaRefreshResult } from "@claudexor/daemon";
import {
  CODEX_FILE_AUTH_ARGS,
  canonicalCodexProfileHome,
  defaultNativeCodexHome,
  redactCodexDoctorDetail,
} from "@claudexor/harness-codex";
import type { QuotaAbsence, QuotaConstraint, QuotaSnapshot } from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";

const CODEX_BIN = process.env.CLAUDEXOR_CODEX_BIN || "codex";

/** One subject per logged-in CODEX_HOME: the default native home (subject null)
 * plus every enabled codex config_dir_login profile (subject = profile_id).
 * Each candidate is one sequential app-server invocation; a candidate that
 * cannot be observed yields a typed absence CLAIM, never a throw — a single
 * account's failure must never blind the others (release cut V11a). */
export async function refreshCodexQuota(
  options: { bin?: string; baseEnv?: NodeJS.ProcessEnv } = {},
): Promise<QuotaRefreshResult> {
  const snapshots: QuotaSnapshot[] = [];
  const absences: QuotaAbsence[] = [];
  for (const candidate of codexQuotaCandidates()) {
    // Logged-out precheck (v3.0.3 S8): a home without auth.json cannot yield a
    // quota window — report the typed absence WITHOUT booting a codex
    // app-server (the 2026-07-21 incident: a fresh scoped home was re-spawned
    // and re-initialized every 60s forever).
    if (!existsSync(join(candidate.home, "auth.json"))) {
      absences.push({
        subject: {
          harness: "codex",
          credential_route: "vendor_native",
          plan_label: null,
          subject_id: candidate.subjectId,
        },
        reason: "not_logged_in",
        detail: `no auth.json in ${candidate.home}; run \`claudexor auth login codex\``,
        observed_at: new Date().toISOString(),
      });
      continue;
    }
    try {
      snapshots.push(
        ...(await readCodexCandidate(
          candidate.subjectId,
          candidate.home,
          options.baseEnv,
          options.bin,
        )),
      );
    } catch (error) {
      absences.push(codexAbsenceClaim(candidate.subjectId, error));
    }
  }
  return { snapshots, absences };
}

/** The default native home plus every enabled codex config_dir_login profile,
 * resolved to its scoped CODEX_HOME (the profile's isolation_locator dir). */
function codexQuotaCandidates(): Array<{ subjectId: string | null; home: string }> {
  const candidates: Array<{ subjectId: string | null; home: string }> = [
    { subjectId: null, home: defaultNativeCodexHome() },
  ];
  for (const profile of loadConfig(noProjectRepoRoot()).global.credential_profiles) {
    if (profile.harness_id !== "codex" || !profile.enabled) continue;
    if (profile.credential_kind !== "config_dir_login" || !profile.isolation_locator) continue;
    try {
      candidates.push({
        subjectId: profile.profile_id,
        home: canonicalCodexProfileHome(profile.isolation_locator),
      });
    } catch {
      /* a mis-registered locator is a doctor problem, not a quota crash */
    }
  }
  return candidates;
}

/** Map one candidate's failure onto a typed absence claim. readCodexCandidate
 * tags the error with the reason it could distinguish; an untagged error (never
 * expected here) is the honest catch-all refresh_failed. The detail is already
 * redacted — this source carries no raw provider payload in its errors. */
function codexAbsenceClaim(subjectId: string | null, error: unknown): QuotaAbsence {
  const message = error instanceof Error ? error.message : String(error);
  const tagged = (error as { quotaAbsenceReason?: QuotaAbsence["reason"] })?.quotaAbsenceReason;
  return {
    subject: {
      harness: "codex",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: subjectId,
    },
    reason: tagged ?? "refresh_failed",
    detail: message,
    observed_at: new Date().toISOString(),
  };
}

/** One app-server invocation for a single candidate CODEX_HOME. Stamps the
 * resolved subject_id onto every snapshot it returns. Throws a reason-tagged
 * error on failure; the caller converts it to an absence claim. */
async function readCodexCandidate(
  subjectId: string | null,
  codexHome: string,
  baseEnv: NodeJS.ProcessEnv | undefined,
  bin?: string,
): Promise<QuotaSnapshot[]> {
  const invocation = codexQuotaInvocation(baseEnv, codexHome);
  const child = spawn(bin ?? CODEX_BIN, invocation.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: invocation.env,
  });
  const lines = createInterface({ input: child.stdout });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.stderr.resume();
  const responses = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  let processFailure: Error | null = null;
  const failPending = (value: unknown) => {
    processFailure ??=
      value instanceof Error ? value : new Error(`Codex app-server exited: ${String(value)}`);
    for (const pending of responses.values()) {
      clearTimeout(pending.timer);
      pending.reject(processFailure);
    }
    responses.clear();
  };
  child.once("error", failPending);
  child.once("exit", (code, signal) => {
    failPending(`code=${String(code)} signal=${String(signal)}`);
  });
  child.stdin.on("error", failPending);
  lines.on("line", (line) => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value["id"] === "number") {
        const pending = responses.get(value["id"]);
        if (!pending) return;
        clearTimeout(pending.timer);
        responses.delete(value["id"]);
        if (value["error"]) pending.reject(new Error("request was refused by Codex app-server"));
        else pending.resolve(value);
      }
    } catch {
      // Vendor diagnostics are not protocol authority.
    }
  });
  const request = (id: number, method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (processFailure) {
        reject(processFailure);
        return;
      }
      const timer = setTimeout(() => {
        responses.delete(id);
        reject(new Error(`${method} timed out`));
      }, 8_000);
      responses.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) failPending(error);
      });
    });
  try {
    await request(1, "initialize", {
      clientInfo: { name: "claudexor", version: "2" },
      capabilities: { optOutNotificationMethods: ["account/rateLimits/updated"] },
    });
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify({ method: "initialized", params: null })}\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    const response = await request(2, "account/rateLimits/read", null);
    const result = response["result"];
    if (!result || typeof result !== "object") throw new Error("Codex quota response is missing");
    return parseCodexRateLimitsResponse(result, new Date(), subjectId);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    // A spawn/exit/stdin transport fault (missing binary, crash, timeout) is a
    // transport absence; an app-server refusal we cannot prove is auth-shaped
    // stays refresh_failed (we never fabricate not_logged_in we can't tell).
    const transport =
      processFailure !== null || /spawn|ENOENT|exited|timed out|code=|signal=/.test(raw);
    const reason: QuotaAbsence["reason"] = transport ? "transport_unavailable" : "refresh_failed";
    throw Object.assign(
      new Error(`Codex app-server quota refresh failed: ${redactCodexDoctorDetail(raw)}`),
      { quotaAbsenceReason: reason },
    );
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.destroy();
    child.kill("SIGTERM");
  }
}

export function parseCodexRateLimitsResponse(
  value: unknown,
  observedAt: Date,
  subjectId: string | null = null,
): QuotaSnapshot[] {
  if (!value || typeof value !== "object") return [];
  const response = value as Record<string, unknown>;
  const historical = objectOrNull(response["rateLimits"]);
  const byId = objectOrNull(response["rateLimitsByLimitId"]);
  const buckets = byId
    ? Object.entries(byId).flatMap(([id, item]) => {
        const bucket = objectOrNull(item);
        return bucket ? [[id, bucket] as const] : [];
      })
    : historical
      ? [[String(historical["limitId"] ?? "default"), historical] as const]
      : [];
  const constraints: QuotaConstraint[] = [];
  for (const [fallbackId, bucket] of buckets) {
    const bucketId = textOrNull(bucket["limitId"]) ?? fallbackId;
    const bucketLabel = textOrNull(bucket["limitName"]) ?? bucketId;
    for (const [windowName, candidate] of Object.entries(bucket)) {
      const window = objectOrNull(candidate);
      if (!window || !isRateLimitWindow(window)) continue;
      const usedPercent = finiteNumber(window["usedPercent"]);
      const durationMins = finiteNumber(window["windowDurationMins"]);
      const resetSeconds = finiteNumber(window["resetsAt"]);
      constraints.push({
        id: `${bucketId}:${windowName}`,
        label: `${bucketLabel} ${windowName}`,
        used_ratio: usedPercent === null ? null : Math.min(1, Math.max(0, usedPercent / 100)),
        window_seconds: durationMins !== null && durationMins > 0 ? durationMins * 60 : null,
        resets_at: resetSeconds === null ? null : new Date(resetSeconds * 1000).toISOString(),
        cooldown_until: null,
      });
    }
  }
  // Live-verified shape (codex 0.142.2, 2026-07-17): a TOP-LEVEL
  // `rateLimitResetCredits: {availableCount, credits[]}` beside the buckets
  // (PR#28143). Zero credits stay silent; a positive balance is a visible
  // fact row so the footer never hides granted headroom.
  const resetCredits = objectOrNull(response["rateLimitResetCredits"]);
  const availableCredits = resetCredits ? finiteNumber(resetCredits["availableCount"]) : null;
  if (availableCredits !== null && availableCredits > 0) {
    constraints.push({
      id: "reset_credits",
      label: `${availableCredits} reset credit${availableCredits === 1 ? "" : "s"} available`,
      used_ratio: null,
      window_seconds: null,
      resets_at: null,
      cooldown_until: null,
    });
  }
  if (buckets.length === 0) return [];
  return [
    {
      subject: {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: historical ? textOrNull(historical["planType"]) : null,
        subject_id: subjectId,
      },
      constraints,
      source: "codex_app_server",
      observed_at: observedAt.toISOString(),
      freshness: "fresh",
    },
  ];
}

export function codexQuotaInvocation(
  baseEnv: NodeJS.ProcessEnv = process.env,
  codexHome?: string,
): {
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const env = { ...baseEnv };
  for (const key of Object.keys(providerScrubEnv())) delete env[key];
  // Explicit home wins (per-profile quota reads); the default stays the
  // Claudexor-owned native home so a bare call still binds to it.
  env["CODEX_HOME"] = codexHome ?? defaultNativeCodexHome();
  return {
    args: [...CODEX_FILE_AUTH_ARGS, "app-server", "--stdio"],
    env,
  };
}

function isRateLimitWindow(value: Record<string, unknown>): boolean {
  return ["usedPercent", "windowDurationMins", "resetsAt"].some((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
