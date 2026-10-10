import {
  safeProblemContext,
  safeProblemMessage,
  safeProblemRequiredActions,
} from "@claudexor/util";
import type { McpToolOutput } from "./index.js";

/** Preserve typed connection/admission failures through the SDK tool-error result. */
export function mcpToolFailure(error: unknown): McpToolOutput {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const message = safeProblemMessage(error);
  const failure: Record<string, unknown> = { message };
  if (typeof record["code"] === "string") failure["code"] = safeProblemMessage(record["code"]);
  if (typeof record["retryable"] === "boolean") failure["retryable"] = record["retryable"];
  const fieldErrors = safeProblemContext(record["fieldErrors"]);
  if (Object.keys(fieldErrors).length > 0) failure["fieldErrors"] = fieldErrors;
  const requiredActions = safeProblemRequiredActions(record["requiredActions"]);
  if (requiredActions.length > 0) failure["requiredActions"] = requiredActions;
  const details = safeProblemContext(record["details"]);
  if (Object.keys(details).length > 0) failure["details"] = details;
  const context = safeProblemContext(record["context"]);
  if (Object.keys(context).length > 0) failure["context"] = context;
  return {
    text: typeof failure["code"] === "string" ? `${failure["code"]}: ${message}` : message,
    structured: { status: "failed", failure },
    isError: true,
  };
}
