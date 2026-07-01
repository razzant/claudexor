import type {
  ControlReviewerPanelEntry,
  EffortHint,
  ProtectedPathApproval,
  ProviderFamily,
} from "@claudexor/schema";
import {
  parseReviewerEffortMap,
  parseReviewerModelMap,
  parseReviewerPanel,
} from "./reviewer-options.js";

export function stringFlagValues(values: Array<string | boolean>, flag: string): string[] {
  const strings = values.filter((value): value is string => typeof value === "string");
  if (strings.length !== values.length)
    throw new Error(`invalid --${flag} value (expected a value)`);
  return strings;
}

export function parseProtectedPathApprovalFlags(
  values: Array<string | boolean>,
): ProtectedPathApproval[] | undefined {
  const strings = stringFlagValues(values, "allow-protected-path");
  if (strings.length === 0) return undefined;
  const paths = strings
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (paths.length === 0)
    throw new Error("invalid --allow-protected-path value (expected at least one glob)");
  return paths.map((path) => ({ path, reason: "explicit CLI --allow-protected-path" }));
}

export function parseReviewerPanelFlags(
  values: Array<string | boolean>,
): ControlReviewerPanelEntry[] | undefined {
  const strings = stringFlagValues(values, "reviewer-panel");
  return parseReviewerPanel(strings.length > 0 ? strings.join(",") : undefined);
}

export function parseReviewerModelFlags(
  values: Array<string | boolean>,
): Partial<Record<ProviderFamily, string>> | undefined {
  const strings = stringFlagValues(values, "reviewer-model");
  return parseReviewerModelMap(strings.length > 0 ? strings.join(",") : undefined);
}

export function parseReviewerEffortFlags(
  values: Array<string | boolean>,
): Partial<Record<ProviderFamily, EffortHint>> | undefined {
  const strings = stringFlagValues(values, "reviewer-effort");
  return parseReviewerEffortMap(strings.length > 0 ? strings.join(",") : undefined);
}
