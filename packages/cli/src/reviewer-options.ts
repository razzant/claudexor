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
