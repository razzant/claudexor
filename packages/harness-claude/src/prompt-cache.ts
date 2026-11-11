import { composeSpawnEnv } from "@claudexor/core";
import type {
  HarnessEvent,
  HarnessRunSpec,
  PromptCacheTtl,
  PromptCacheTtlReceipt,
} from "@claudexor/schema";
import { observedPromptCacheTtl } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";

/** Claude Code reads the main-conversation lifetime and the lifetime of every
 * other request bucket (subagents, workflows, compaction, titles) from these
 * variables since 2.1.242. A process variable outranks the profile's
 * `promptCacheTtl`/`subagentPromptCacheTtl` settings and helper frontmatter;
 * only `FORCE_PROMPT_CACHING_5M` outranks it. */
export const CLAUDE_PROMPT_CACHE_TTL_ENV = [
  "CLAUDE_CODE_PROMPT_CACHE_TTL",
  "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL",
] as const;
const FIRST_READING_CLI = [2, 1, 242] as const;

/** An explicit lifetime governs both buckets. Default adds and removes nothing,
 * so native defaults, profile settings and inherited variables stay in effect. */
export function withClaudePromptCacheTtl(spec: HarnessRunSpec): HarnessRunSpec {
  const ttl = spec.prompt_cache_ttl;
  if (ttl === undefined) return spec;
  const env = { ...spec.env };
  for (const key of CLAUDE_PROMPT_CACHE_TTL_ENV) env[key] = ttl;
  return { ...spec, env };
}

/** Claude Code's own boolean variable parsing (`isEnvTruthy`). */
function envFlag(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Native controls KNOWN to keep the submitted lifetime from governing this
 * session, read from the composed child environment with the CLI's semantics.
 * A per-family disable covers only the model its alias resolves to, which is
 * certain only when the session was asked for that bare alias; any other model
 * stays unclaimed and the observed split decides.
 */
export function claudePromptCacheOverrides(
  ttl: PromptCacheTtl,
  model: string | null,
  env: NodeJS.ProcessEnv,
): string[] {
  const reasons: string[] = [];
  if (ttl === "1h" && envFlag(env.FORCE_PROMPT_CACHING_5M))
    reasons.push("FORCE_PROMPT_CACHING_5M is set, which forces 5m for both buckets");
  if (envFlag(env.DISABLE_PROMPT_CACHING))
    reasons.push("DISABLE_PROMPT_CACHING is set, which disables prompt caching for every model");
  const alias = model?.trim().toLowerCase();
  if (alias === "haiku" || alias === "sonnet" || alias === "opus") {
    const key = `DISABLE_PROMPT_CACHING_${alias.toUpperCase()}`;
    if (envFlag(env[key]))
      reasons.push(`${key} is set, which disables prompt caching for the ${alias} alias model`);
  }
  return reasons;
}

/** True only for a parseable version older than the first reading release;
 * an unknown version proves nothing. */
function predatesTtlControls(version: unknown): boolean {
  const match = typeof version === "string" ? /(\d+)\.(\d+)\.(\d+)/.exec(version) : null;
  if (!match) return false;
  for (let i = 0; i < 3; i++) {
    const part = Number(match[i + 1]);
    if (part !== FIRST_READING_CLI[i]) return part < FIRST_READING_CLI[i]!;
  }
  return false;
}

type WriteSplit = { fiveMinute: number; oneHour: number };

/** Unknown on any result stays unknown; a later result cannot revive a partial sum. */
function addWriteSplit(acc: WriteSplit | null | undefined, creation: any): WriteSplit | null {
  const five = creation?.ephemeral_5m_input_tokens;
  const one = creation?.ephemeral_1h_input_tokens;
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  if (acc === null || !count(five) || !count(one)) return null;
  return { fiveMinute: (acc?.fiveMinute ?? 0) + five, oneHour: (acc?.oneHour ?? 0) + one };
}

/**
 * Stamps the session's lifetime receipt on its started and usage events and
 * discloses, once, the known reasons a submitted lifetime cannot govern it
 * (INV-105 `ignored_settings`). The observed split comes only from the result
 * usage the CLI reports; which request buckets that usage aggregates is not
 * established here.
 */
export function claudePromptCacheObserver(spec: HarnessRunSpec) {
  const submitted = spec.prompt_cache_ttl ?? null;
  const reasons = submitted
    ? claudePromptCacheOverrides(
        submitted,
        spec.model_hint,
        composeSpawnEnv(spec.env_inheritance, spec.env),
      )
    : [];
  let split: WriteSplit | null | undefined;
  let initialized = false;
  const receipt = (): PromptCacheTtlReceipt => {
    const write5m = split ? split.fiveMinute : null;
    const write1h = split ? split.oneHour : null;
    return {
      requested: submitted,
      submitted,
      reason: reasons.length > 0 ? reasons.join("; ") : null,
      observed: observedPromptCacheTtl(write5m, write1h),
      write_5m_tokens: write5m,
      write_1h_tokens: write1h,
    };
  };
  return (obj: any, events: HarnessEvent[] | null, sessionId: string): HarnessEvent[] | null => {
    const first = obj?.type === "system" && obj.subtype === "init" && !initialized;
    if (first) {
      initialized = true;
      if (submitted && predatesTtlControls(obj.claude_code_version))
        reasons.push(
          `claude CLI ${String(obj.claude_code_version).trim()} predates 2.1.242, the first release that reads ${CLAUDE_PROMPT_CACHE_TTL_ENV.join(" and ")}`,
        );
    }
    if (obj?.type === "result") split = addWriteSplit(split, obj.usage?.cache_creation);
    const disclose = first && submitted !== null && reasons.length > 0;
    if (!events && !disclose) return events;
    const out = events ?? [];
    for (const event of out)
      if (event.type === "started" || event.type === "usage") event.prompt_cache_ttl = receipt();
    if (disclose) {
      const detail = `prompt_cache_ttl=${submitted} (${reasons.join("; ")})`;
      out.push({
        type: "status",
        session_id: sessionId,
        ts: nowIso(),
        text: `[prompt-cache] ignored: ${detail}`,
        payload: { ignored_settings: [detail] },
        prompt_cache_ttl: receipt(),
      });
    }
    return out;
  };
}
