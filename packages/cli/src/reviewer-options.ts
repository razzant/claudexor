import {
  EffortHint,
  ProviderFamily,
  type ControlReviewerPanelEntry,
  type EffortHint as EffortHintValue,
} from "@claudexor/schema";

/** Parse `--reviewer-effort openai=xhigh,anthropic=high` into the control-api DTO shape. */
export function parseReviewerEffortMap(
  value: string | undefined,
): Partial<Record<ProviderFamily, EffortHintValue>> | undefined {
  if (value === undefined) return undefined;
  const map: Partial<Record<ProviderFamily, EffortHintValue>> = {};
  for (const pair of value.split(",")) {
    const raw = pair.trim();
    if (!raw) throw new Error("invalid --reviewer-effort value (empty comma-separated entry)");
    const eq = raw.indexOf("=");
    const family = (eq === -1 ? raw : raw.slice(0, eq)).trim();
    const effort = (eq === -1 ? "" : raw.slice(eq + 1)).trim();
    if (!family && !effort) continue;
    if (!family || !effort || effort.includes("="))
      throw new Error(`invalid --reviewer-effort entry '${pair}' (expected family=effort)`);
    const parsedFamily = ProviderFamily.safeParse(family);
    if (!parsedFamily.success)
      throw new Error(
        `invalid reviewer provider '${family}' (expected openai|anthropic|google|cursor|opencode|xai|local|unknown)`,
      );
    const parsed = EffortHint.safeParse(effort);
    if (!parsed.success)
      throw new Error(`invalid reviewer effort '${effort}' (expected low|medium|high|xhigh|max)`);
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
export function parseReviewerModelMap(
  value: string | undefined,
): Partial<Record<ProviderFamily, string>> | undefined {
  if (value === undefined) return undefined;
  const map: Partial<Record<ProviderFamily, string>> = {};
  for (const pair of value.split(",")) {
    const raw = pair.trim();
    if (!raw) throw new Error("invalid --reviewer-model value (empty comma-separated entry)");
    // Split on the FIRST '=' only, so a model id that itself contains '=' is preserved.
    const eq = raw.indexOf("=");
    const family = (eq === -1 ? raw : raw.slice(0, eq)).trim();
    const model = (eq === -1 ? "" : raw.slice(eq + 1)).trim();
    if (!family && !model) continue;
    if (!family || !model)
      throw new Error(`invalid --reviewer-model entry '${pair}' (expected family=model)`);
    const parsedFamily = ProviderFamily.safeParse(family);
    if (!parsedFamily.success)
      throw new Error(
        `invalid reviewer provider '${family}' (expected openai|anthropic|google|cursor|opencode|xai|local|unknown)`,
      );
    map[parsedFamily.data] = model;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/**
 * Parse `--reviewer-panel "claude=claude-opus-4-8:max,cursor=gemini-3.1-pro,cursor=gpt-5.5-extra-high"`
 * into an ordered reviewer list. Entries are harness-id based, not
 * provider-family based, so repeated harnesses are preserved for multi-model
 * panels on the same native provider.
 */
export function parseReviewerPanel(
  value: string | undefined,
): ControlReviewerPanelEntry[] | undefined {
  if (value === undefined) return undefined;
  const out: ControlReviewerPanelEntry[] = [];
  for (const pair of value.split(",")) {
    const raw = pair.trim();
    if (!raw)
      throw new Error(`invalid --reviewer-panel entry '${pair}' (empty entries are not allowed)`);
    const eq = raw.indexOf("=");
    let effort: EffortHintValue | undefined;
    let harness = (eq === -1 ? raw : raw.slice(0, eq)).trim();
    const rest = eq === -1 ? "" : raw.slice(eq + 1).trim();
    if (eq !== -1 && !rest)
      throw new Error(`invalid --reviewer-panel entry '${pair}' (missing model after '=')`);
    if (eq === -1) {
      const colon = harness.lastIndexOf(":");
      if (colon > -1) {
        const suffix = harness.slice(colon + 1).trim();
        const parsedEffort = EffortHint.safeParse(suffix);
        if (!parsedEffort.success)
          throw new Error(
            `invalid --reviewer-panel entry '${pair}' (expected harness[:effort] or harness[=model[:effort]])`,
          );
        effort = parsedEffort.data;
        harness = harness.slice(0, colon).trim();
      }
    }
    if (!harness)
      throw new Error(
        `invalid --reviewer-panel entry '${pair}' (expected harness[:effort] or harness[=model[:effort]])`,
      );
    let model: string | undefined = rest || undefined;
    if (model) {
      const colon = model.lastIndexOf(":");
      if (colon > -1) {
        const suffix = model.slice(colon + 1).trim();
        const parsedEffort = EffortHint.safeParse(suffix);
        if (parsedEffort.success) {
          effort = parsedEffort.data;
          model = model.slice(0, colon).trim();
          if (!model)
            throw new Error(`invalid --reviewer-panel entry '${pair}' (missing model after '=')`);
        }
      }
    }
    out.push({ harness, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
  }
  if (out.length === 0)
    throw new Error("invalid --reviewer-panel value (expected at least one harness entry)");
  return out;
}
