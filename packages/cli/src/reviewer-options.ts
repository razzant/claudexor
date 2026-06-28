import { EffortHint, ProviderFamily, type EffortHint as EffortHintValue } from "@claudexor/schema";

/** Parse `--reviewer-effort openai=xhigh,anthropic=high` into the control-api DTO shape. */
export function parseReviewerEffortMap(value: string | undefined): Record<string, EffortHintValue> | undefined {
  if (value === undefined) return undefined;
  const map: Record<string, EffortHintValue> = {};
  for (const pair of value.split(",")) {
    const [family, effort] = pair.split("=").map((s) => s.trim());
    if (!family && !effort) continue;
    if (!family || !effort) throw new Error(`invalid --reviewer-effort entry '${pair}'`);
    const parsedFamily = ProviderFamily.safeParse(family);
    if (!parsedFamily.success) throw new Error(`invalid reviewer provider '${family}' (expected openai|anthropic|google|cursor|opencode|xai|local|unknown)`);
    const parsed = EffortHint.safeParse(effort);
    if (!parsed.success) throw new Error(`invalid reviewer effort '${effort}' (expected low|medium|high|xhigh|max)`);
    map[parsedFamily.data] = parsed.data;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/**
 * Parse `--reviewer-model openai=gpt-4o-mini,anthropic=claude-haiku` into a
 * per-family model map. Fails loudly on malformed pairs / unknown families
 * (mirrors parseReviewerEffortMap) — a typo'd reviewer model must never be
 * silently dropped and the run continue with the default route.
 */
export function parseReviewerModelMap(value: string | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const map: Record<string, string> = {};
  for (const pair of value.split(",")) {
    // Split on the FIRST '=' only, so a model id that itself contains '=' is preserved.
    const eq = pair.indexOf("=");
    const family = (eq === -1 ? pair : pair.slice(0, eq)).trim();
    const model = (eq === -1 ? "" : pair.slice(eq + 1)).trim();
    if (!family && !model) continue;
    if (!family || !model) throw new Error(`invalid --reviewer-model entry '${pair}' (expected family=model)`);
    const parsedFamily = ProviderFamily.safeParse(family);
    if (!parsedFamily.success) throw new Error(`invalid reviewer provider '${family}' (expected openai|anthropic|google|cursor|opencode|xai|local|unknown)`);
    map[parsedFamily.data] = model;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}
