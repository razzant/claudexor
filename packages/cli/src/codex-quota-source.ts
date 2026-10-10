import { prepareHarnessCommand, killOwnedProcessTree } from "@claudexor/core";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadConfigCached } from "@claudexor/config";
import { harnessBinaryIdentity, harnessRuntimeEnv, providerScrubEnv } from "@claudexor/core";
import type { QuotaRefreshCycle, QuotaRefreshResult } from "@claudexor/daemon";
import {
  CODEX_FILE_AUTH_ARGS,
  canonicalCodexProfileHome,
  defaultNativeCodexHome,
  redactCodexDoctorDetail,
  parseCodexRateLimitsResponse,
  parseCodexAccountResources,
  CodexRpcError,
  parseCodexRpcError,
  codexRpcErrorDetail,
} from "@claudexor/harness-codex";
import {
  emptyResourceFacet,
  type AccountResourceObservation,
  type AccountTarget,
  type QuotaAbsence,
  type QuotaSnapshot,
} from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { readAccountsMigrationFile } from "./accounts-unified-migration.js";
import {
  emitQuotaDiagnostic,
  type QuotaDiagnosticSink,
  type QuotaRefreshDiagnostic,
} from "./quota-refresh-diagnostics.js";

export { parseCodexRateLimitsResponse } from "@claudexor/harness-codex";

const CODEX_BIN = process.env.CLAUDEXOR_CODEX_BIN || "codex";

/** One subject per logged-in CODEX_HOME: the default native home (subject null)
 * plus every enabled codex config_dir_login profile (subject = profile_id).
 * Each candidate is one sequential app-server invocation; a candidate that
 * cannot be observed yields a typed absence CLAIM, never a throw — a single
 * account's failure must never blind the others (release cut V11a). */
export async function refreshCodexQuota(
  options: {
    bin?: string;
    baseEnv?: NodeJS.ProcessEnv;
    spawn?: typeof spawn;
    diagnostic?: QuotaDiagnosticSink;
    foreground?: boolean;
    cycle?: QuotaRefreshCycle;
  } = {},
): Promise<QuotaRefreshResult> {
  const snapshots: QuotaSnapshot[] = [];
  const absences: QuotaAbsence[] = [];
  const resources: AccountResourceObservation[] = [];
  for (const candidate of codexQuotaCandidates(options.cycle?.target)) {
    const subject = {
      harness: "codex",
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: candidate.subjectId,
    };
    if (options.cycle?.shouldRefresh?.(subject) === false) continue;
    if (options.cycle?.pacing?.cooldownUntil(subject, Date.now()) != null) {
      absences.push({
        ...subjectOfAbsence(candidate.subjectId),
        reason: "poll_paced",
        detail: "quota poll paused",
        observed_at: new Date().toISOString(),
      });
      continue;
    }
    const operationId = randomUUID();
    const diagnostic: QuotaDiagnosticSink = (record) =>
      emitQuotaDiagnostic(options.diagnostic, record);
    const diagnosticBase = {
      operationId,
      source: "codex_app_server",
      profileId: candidate.subjectId,
      foreground: options.foreground === true,
      credentialEpoch: null,
      current: null,
    };
    // Logged-out precheck (v3.0.3 S8): a home without auth.json cannot yield a
    // quota window — report the typed absence WITHOUT booting a codex
    // app-server (the 2026-07-21 incident: a fresh scoped home was re-spawned
    // and re-initialized every 60s forever).
    if (!existsSync(join(candidate.home, "auth.json"))) {
      diagnostic({
        ...diagnosticBase,
        at: new Date().toISOString(),
        stage: "poll",
        outcome: "skipped",
        reason: "credential_file_absent",
      });
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
      const at = new Date();
      const result = await requestCodexAccount(
        candidate.home,
        options.baseEnv,
        options.bin,
        options.spawn,
        (record) => diagnostic({ ...record, ...diagnosticBase }),
      );
      if (candidate.subjectId !== null) {
        const observation = parseCodexAccountResources(result, candidate.subjectId, at);
        for (const key of ["balances", "spending", "resets", "diagnostics"] as const)
          observation[key] ??= {
            ...emptyResourceFacet(),
            source: "codex_app_server",
            last_attempt_at: at.toISOString(),
            last_error: "not_reported",
          };
        resources.push(observation);
      }
      snapshots.push(...parseCodexRateLimitsResponse(result, at, candidate.subjectId));
    } catch (error) {
      absences.push(codexAbsenceClaim(candidate.subjectId, error));
    }
  }
  for (const absence of absences) {
    const id = absence.subject.subject_id;
    if (id === null || resources.some((row) => row.target.profile_id === id)) continue;
    resources.push({
      target: { harness: "codex", profile_id: id },
      ...Object.fromEntries(
        ["balances", "spending", "resets", "diagnostics"].map((key) => [
          key,
          {
            ...emptyResourceFacet(),
            last_attempt_at: new Date().toISOString(),
            last_error: absence.reason,
          },
        ]),
      ),
    });
  }
  return { snapshots, absences, resources };
}

/** The default native home plus every enabled codex config_dir_login profile,
 * resolved to its scoped CODEX_HOME (the profile's isolation_locator dir). */
function codexQuotaCandidates(
  target?: AccountTarget,
): Array<{ subjectId: string | null; home: string }> {
  // A MIGRATED harness has no null subject (its former default home IS the
  // auto-registered row the profile loop covers): probing it again would
  // resurrect the retired subject every refresh cycle and double-probe one
  // credential (mirrors quotaSubjectUniverseFromConfig's migration-record use).
  const candidates: Array<{ subjectId: string | null; home: string }> =
    !target && readAccountsMigrationFile()["codex"] === undefined
      ? [{ subjectId: null, home: defaultNativeCodexHome() }]
      : [];
  for (const profile of loadConfigCached(noProjectRepoRoot()).global.credential_profiles) {
    if (
      profile.harness_id !== "codex" ||
      (target
        ? target.harness !== "codex" || profile.profile_id !== target.profile_id
        : !profile.enabled)
    )
      continue;
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
export async function requestCodexAccount(
  codexHome: string,
  baseEnv: NodeJS.ProcessEnv | undefined,
  bin?: string,
  start: typeof spawn = spawn,
  diagnostic?: (
    record: Pick<
      QuotaRefreshDiagnostic,
      "at" | "stage" | "outcome" | "reason" | "binary" | "nativeRpcCode"
    >,
  ) => void,
  method = "account/rateLimits/read",
  params: unknown = null,
): Promise<unknown> {
  const invocation = codexQuotaInvocation(baseEnv, codexHome);
  const report = (
    outcome: "started" | "succeeded" | "failed",
    reason?: string,
    nativeRpcCode?: number | null,
  ) =>
    diagnostic?.({
      at: new Date().toISOString(),
      stage: "native_rpc",
      outcome,
      reason,
      nativeRpcCode,
      ...(outcome === "started"
        ? { binary: harnessBinaryIdentity(bin ?? CODEX_BIN, invocation.env) }
        : {}),
    });
  const command = prepareHarnessCommand(bin ?? CODEX_BIN, invocation.args, invocation.env);
  const child = start(command.binary, command.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: command.env,
  });
  const lines = createInterface({ input: child.stdout });
  const timeout = setTimeout(() => killOwnedProcessTree(child, "SIGKILL"), 10_000);
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
        if (value["error"]) pending.reject(parseCodexRpcError(value["error"]));
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
    // Bind the evidence to the request, not its eventual delivery: a poll
    // already in flight must not erase a refusal observed while it awaited I/O.
    report("started", method);
    let response: Record<string, unknown>;
    try {
      response = await request(2, method, params);
      report("succeeded", "rpc_response_received");
    } catch (error) {
      report(
        "failed",
        error instanceof CodexRpcError ? "native_rpc_refused" : "native_rpc_transport_unknown",
        error instanceof CodexRpcError ? error.code : null,
      );
      throw error;
    }
    const result = response["result"];
    if (!result || typeof result !== "object") throw new Error("Codex quota response is missing");
    return result;
  } catch (error) {
    const raw =
      error instanceof CodexRpcError
        ? codexRpcErrorDetail(error)
        : error instanceof Error
          ? error.message
          : String(error);
    // A spawn/exit/stdin transport fault (missing binary, crash, timeout) is a
    // transport absence; an app-server refusal we cannot prove is auth-shaped
    // stays refresh_failed (we never fabricate not_logged_in we can't tell).
    const transport =
      !(error instanceof CodexRpcError) &&
      (processFailure !== null || /spawn|ENOENT|exited|timed out|code=|signal=/.test(raw));
    const reason: QuotaAbsence["reason"] = transport ? "transport_unavailable" : "refresh_failed";
    throw Object.assign(
      new Error(`Codex app-server quota refresh failed: ${redactCodexDoctorDetail(raw)}`),
      { quotaAbsenceReason: reason },
    );
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.destroy();
    killOwnedProcessTree(child, "SIGTERM");
  }
}

export function codexQuotaInvocation(
  baseEnv: NodeJS.ProcessEnv = process.env,
  codexHome?: string,
): {
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const env = harnessRuntimeEnv(baseEnv);
  for (const key of Object.keys(providerScrubEnv())) delete env[key];
  // Explicit home wins (per-profile quota reads); the default stays the
  // Claudexor-owned native home so a bare call still binds to it.
  env["CODEX_HOME"] = codexHome ?? defaultNativeCodexHome();
  return {
    args: [...CODEX_FILE_AUTH_ARGS, "app-server", "--stdio"],
    env,
  };
}

function subjectOfAbsence(subjectId: string | null) {
  return {
    subject: {
      harness: "codex",
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: subjectId,
    },
  };
}
