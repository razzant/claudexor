import type { ControlOperationDescriptor } from "@claudexor/schema";
import type { OperationDraft } from "./operation-draft.js";
import { OPERATION_SUMMARIES } from "./operation-summaries.js";

/** Canonical descriptor defaults for every code-owned operation family. */
export function descriptor(input: OperationDraft): ControlOperationDescriptor {
  const applicability =
    input.path.includes("/threads/") || input.path === "/v2/threads"
      ? "thread"
      : input.path.includes("/runs/") || input.path === "/v2/runs"
        ? "run"
        : input.path.includes("/projects/") || input.path === "/v2/projects"
          ? "project"
          : "global";
  const summary = input.summary ?? OPERATION_SUMMARIES[`${input.method} ${input.path}`];
  if (!summary)
    throw new Error(`operation catalog: missing summary for '${input.method} ${input.path}'`);
  return {
    ...input,
    summary,
    auth: "loopback_bearer",
    errorSchema: "ControlProblem",
    id: `${input.method.toLowerCase()}:${input.path.slice(4).replaceAll(/[:/<>]+/g, ".")}`,
    applicability: input.applicability ?? applicability,
    parameters: input.parameters ?? [],
    idempotency: input.idempotency ?? (input.mutability === "read_only" ? "natural" : "none"),
    completion:
      input.completion ?? (input.responseKind === "stream" ? "terminal_stream" : "immediate"),
  };
}

export const jsonOperation = (
  method: OperationDraft["method"],
  path: string,
  mutability: OperationDraft["mutability"],
  requestSchema: string | null = null,
  responseSchema: string | null = null,
  extra: Partial<OperationDraft> = {},
): ControlOperationDescriptor =>
  descriptor({
    method,
    path,
    mutability,
    requestSchema,
    responseSchema,
    responseKind: "json",
    ...extra,
  });
