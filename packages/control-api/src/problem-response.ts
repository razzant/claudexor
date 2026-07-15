const RESERVED_FIELDS = new Set([
  "error",
  "message",
  "code",
  "retryable",
  "fieldErrors",
  "requiredActions",
  "evidenceRefs",
]);

export type ControlProblemError = Error & {
  code: string;
  retryable: boolean;
  fieldErrors?: unknown;
  requiredActions?: unknown;
  evidenceRefs?: unknown;
  context: Record<string, unknown>;
};

export function controlProblemError(status: number, body: unknown): ControlProblemError {
  const source = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message =
    typeof source["error"] === "string"
      ? source["error"]
      : typeof source["message"] === "string"
        ? source["message"]
        : `request failed with status ${status}`;
  const code = typeof source["code"] === "string" ? source["code"] : `http_${status}`;
  const context = Object.fromEntries(
    Object.entries(source).filter(([key]) => !RESERVED_FIELDS.has(key)),
  );
  return Object.assign(new Error(message), {
    code,
    retryable: source["retryable"] === true,
    fieldErrors: source["fieldErrors"],
    requiredActions: source["requiredActions"],
    evidenceRefs: source["evidenceRefs"],
    context,
  });
}
