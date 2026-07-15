import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { QuotaConstraint, QuotaSnapshot } from "@claudexor/schema";

const CODEX_BIN = process.env.CLAUDEXOR_CODEX_BIN || "codex";

export async function refreshCodexQuota(): Promise<QuotaSnapshot[]> {
  const child = spawn(CODEX_BIN, ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: nativeSessionEnv(),
  });
  const lines = createInterface({ input: child.stdout });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.stderr.resume();
  const responses = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value["id"] === "number") responses.get(value["id"])?.(value);
    } catch {
      // Vendor diagnostics are not protocol authority.
    }
  });
  const request = (id: number, method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 8_000);
      responses.set(id, (value) => {
        clearTimeout(timer);
        responses.delete(id);
        if (value["error"]) reject(new Error(`${method} was refused by Codex app-server`));
        else resolve(value);
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  try {
    await request(1, "initialize", {
      clientInfo: { name: "claudexor", version: "2" },
      capabilities: { optOutNotificationMethods: ["account/rateLimits/updated"] },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: null })}\n`);
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
    child.stdin.end();
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
    for (const windowName of ["primary", "secondary"] as const) {
      const window = objectOrNull(bucket[windowName]);
      if (!window) continue;
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

function nativeSessionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CLAUDEXOR_CODEX_API_KEY"]) delete env[key];
  return env;
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
