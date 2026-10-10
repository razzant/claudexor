import {
  CONCURRENCY_KEYS,
  RuntimeConcurrencyCaps,
  type GlobalConfig,
  type RuntimeConcurrencySources,
} from "@claudexor/schema";
import { ConfigParseError } from "./config-error.js";

const envKeys = {
  max_concurrent: "CLAUDEXOR_MAX_CONCURRENT",
  max_concurrent_non_model_jobs: "CLAUDEXOR_MAX_CONCURRENT_NON_MODEL_JOBS",
  max_concurrent_model_operations: "CLAUDEXOR_MAX_CONCURRENT_MODEL_OPERATIONS",
  max_parallel_candidates: "CLAUDEXOR_MAX_PARALLEL_CANDIDATES",
  max_deep_scan_width: "CLAUDEXOR_MAX_DEEP_SCAN_WIDTH",
  max_council_members: "CLAUDEXOR_MAX_COUNCIL_MEMBERS",
} as const;

export function concurrencyEnv(): Partial<RuntimeConcurrencyCaps> {
  const out: Partial<RuntimeConcurrencyCaps> = {};
  for (const key of CONCURRENCY_KEYS) {
    const name = envKeys[key];
    const raw = process.env[name];
    if (raw === undefined) continue;
    const parsed = RuntimeConcurrencyCaps.shape[key].safeParse(
      raw === "unlimited" ? raw : Number(raw),
    );
    if (!parsed.success) throw new ConfigParseError(`env:${name}`, parsed.error);
    Object.assign(out, { [key]: parsed.data });
  }
  return out;
}

/** Captured before defaults are materialized; presence, not value, establishes
 * an explicit configuration. Env always wins over a saved YAML key. */
export function concurrencySources(original: unknown): RuntimeConcurrencySources {
  const raw = original as { runtime?: Record<string, unknown> } | null;
  return Object.fromEntries(
    CONCURRENCY_KEYS.map((key) => [
      key,
      process.env[envKeys[key]] !== undefined
        ? "environment"
        : Object.hasOwn(raw?.runtime ?? {}, key)
          ? "config"
          : "default",
    ]),
  ) as RuntimeConcurrencySources;
}

/** Unrelated settings writes must not add new keys that old engines reject.
 * Preserve explicit YAML values, including values equal to today's defaults. */
export function omitImplicitConcurrency(config: GlobalConfig, original: unknown) {
  const raw = original as { runtime?: Record<string, unknown> } | null;
  const runtime: Partial<GlobalConfig["runtime"]> = { ...config.runtime };
  const defaults = RuntimeConcurrencyCaps.parse({});
  for (const key of CONCURRENCY_KEYS) {
    if (!Object.hasOwn(raw?.runtime ?? {}, key) && runtime[key] === defaults[key])
      delete runtime[key];
  }
  return { ...config, runtime };
}
