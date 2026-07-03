import { AccessProfile, ExternalContextPolicy, ProviderFamily } from "./primitives.js";
import { EffortHint } from "./harness.js";

/**
 * ONE owner for the surface-level run-control argument validation shared by
 * the MCP and ACP servers (they previously each hand-rolled a near-identical
 * copy — contract rules drifted per surface). Structural JSON-Schema/SDK
 * validation happens upstream; these are the SEMANTIC rules a schema cannot
 * express (cross-field equality, enum membership via the live Zod shapes,
 * nested reviewer/approval shapes). Returns a human-readable error or null.
 *
 * Surface-SPECIFIC rules stay in the surface (e.g. ACP's `mode`, MCP's
 * per-tool race `n` minimum, prompt/cwd requirements).
 */
export function validateSurfaceRunControls(obj: Record<string, unknown>): string | null {
  const primaryHarnessError = validateOptionalNonEmptyString(obj.primaryHarness, "primaryHarness");
  if (primaryHarnessError) return primaryHarnessError;
  if (obj.web !== undefined && (typeof obj.web !== "string" || !ExternalContextPolicy.safeParse(obj.web).success)) {
    return "web must be a valid external context policy";
  }
  if (
    obj.externalContextPolicy !== undefined &&
    (typeof obj.externalContextPolicy !== "string" || !ExternalContextPolicy.safeParse(obj.externalContextPolicy).success)
  ) {
    return "externalContextPolicy must be a valid external context policy";
  }
  if (obj.web !== undefined && obj.externalContextPolicy !== undefined && obj.web !== obj.externalContextPolicy) {
    return "web and externalContextPolicy must be equal when both are provided";
  }
  const modelError = validateOptionalNonEmptyString(obj.model, "model");
  if (modelError) return modelError;
  if (obj.effort !== undefined && (typeof obj.effort !== "string" || !EffortHint.safeParse(obj.effort).success)) {
    return "effort must be a valid effort value";
  }
  const testsError = validateStringArray(obj.tests, "tests");
  if (testsError) return testsError;
  if (obj.maxUsd !== undefined && (typeof obj.maxUsd !== "number" || !Number.isFinite(obj.maxUsd) || obj.maxUsd < 0)) {
    return "maxUsd must be a non-negative number";
  }
  if (obj.access !== undefined && (typeof obj.access !== "string" || !AccessProfile.safeParse(obj.access).success)) {
    return "access must be a valid access profile";
  }
  if (obj.reviewerPanel !== undefined) {
    if (!Array.isArray(obj.reviewerPanel) || obj.reviewerPanel.length === 0) {
      return "reviewerPanel must be a non-empty array";
    }
    for (const entry of obj.reviewerPanel) {
      if (!isPlainRecord(entry)) return "reviewerPanel entries must be objects";
      const keys = Object.keys(entry);
      const allowed = new Set(["harness", "model", "effort"]);
      for (const key of keys) if (!allowed.has(key)) return `unknown reviewerPanel field: ${key}`;
      if (typeof entry.harness !== "string" || entry.harness.trim() === "") {
        return "reviewerPanel[].harness must be a non-empty string";
      }
      if (entry.model !== undefined && (typeof entry.model !== "string" || entry.model.trim() === "")) {
        return "reviewerPanel[].model must be a non-empty string";
      }
      if (entry.effort !== undefined && (typeof entry.effort !== "string" || !EffortHint.safeParse(entry.effort).success)) {
        return "reviewerPanel[].effort must be a valid effort value";
      }
    }
  }
  const modelsError = validateFamilyStringMap(obj.reviewerModels, "reviewerModels");
  if (modelsError) return modelsError;
  const effortsError = validateFamilyEffortMap(obj.reviewerEfforts, "reviewerEfforts");
  if (effortsError) return effortsError;
  if (obj.protectedPathApprovals !== undefined) {
    if (!Array.isArray(obj.protectedPathApprovals)) {
      return "protectedPathApprovals must be an array";
    }
    for (const entry of obj.protectedPathApprovals) {
      if (!isPlainRecord(entry)) return "protectedPathApprovals entries must be objects";
      const keys = Object.keys(entry);
      const allowed = new Set(["path", "reason"]);
      for (const key of keys) if (!allowed.has(key)) return `unknown protectedPathApprovals field: ${key}`;
      if (typeof entry.path !== "string" || entry.path.trim() === "") {
        return "protectedPathApprovals[].path must be a non-empty string";
      }
      if (entry.reason !== undefined && (typeof entry.reason !== "string" || entry.reason.trim() === "")) {
        return "protectedPathApprovals[].reason must be a non-empty string";
      }
    }
  }
  return null;
}

export function validateOptionalNonEmptyString(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") return `${name} must be a non-empty string`;
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateStringArray(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    return `${name} must be an array of non-empty strings`;
  }
  return null;
}

function validateFamilyStringMap(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (!isPlainRecord(value)) return `${name} must be an object`;
  for (const [key, child] of Object.entries(value)) {
    if (!ProviderFamily.safeParse(key).success) {
      return `${name} has unknown provider family key: ${key}`;
    }
    if (typeof child !== "string" || child.trim() === "") {
      return `${name} must map provider family keys to non-empty strings`;
    }
  }
  return null;
}

function validateFamilyEffortMap(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (!isPlainRecord(value)) return `${name} must be an object`;
  for (const [key, child] of Object.entries(value)) {
    if (!ProviderFamily.safeParse(key).success) {
      return `${name} has unknown provider family key: ${key}`;
    }
    if (typeof child !== "string" || !EffortHint.safeParse(child).success) {
      return `${name} must map provider family keys to valid effort values`;
    }
  }
  return null;
}
