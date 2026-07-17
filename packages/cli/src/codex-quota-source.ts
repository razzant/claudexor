import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { providerScrubEnv } from "@claudexor/core";
import { CODEX_FILE_AUTH_ARGS, defaultNativeCodexHome } from "@claudexor/harness-codex";
import type { QuotaConstraint, QuotaSnapshot } from "@claudexor/schema";

const CODEX_BIN = process.env.CLAUDEXOR_CODEX_BIN || "codex";

export async function refreshCodexQuota(
  options: { bin?: string; baseEnv?: NodeJS.ProcessEnv } = {},
): Promise<QuotaSnapshot[]> {
  const invocation = codexQuotaInvocation(options.baseEnv);
  const child = spawn(options.bin ?? CODEX_BIN, invocation.args, {
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
    return parseCodexRateLimitsResponse(result, new Date());
  } catch (error) {
    throw new Error(
      `Codex app-server quota refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.destroy();
    child.kill("SIGTERM");
  }
}

export function parseCodexRateLimitsResponse(value: unknown, observedAt: Date): QuotaSnapshot[] {
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
        subject_id: null,
      },
      constraints,
      source: "codex_app_server",
      observed_at: observedAt.toISOString(),
      freshness: "fresh",
    },
  ];
}

export function codexQuotaInvocation(baseEnv: NodeJS.ProcessEnv = process.env): {
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const env = { ...baseEnv };
  for (const key of Object.keys(providerScrubEnv())) delete env[key];
  env["CODEX_HOME"] = defaultNativeCodexHome();
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
