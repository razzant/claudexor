import { WorkspaceError } from "@claudexor/core";
import { CaptureChangeInventory, WorkspaceCaptureFailure } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import type { CapturedWorkspaceDiff } from "./manager.js";

/** Keep the original error until scratch cleanup has attached its own evidence. */
export function incompleteWorkspaceCapture(error: unknown): CapturedWorkspaceDiff {
  return {
    diff: "",
    captureIncomplete: true,
    captureFailure: error instanceof Error ? error : new WorkspaceError(String(error)),
  };
}

/** Only typed, bounded, sanitized cause facts cross into persisted diagnostics. */
export function captureFailureEvidence(error: Error | undefined): WorkspaceCaptureFailure {
  const facts = (error ?? {}) as Record<string, unknown>;
  const code = WorkspaceCaptureFailure.shape.code.safeParse(facts["code"]);
  const safe = (text: string) => redactSecrets(text).slice(0, 4000);
  const cleanup = facts["cleanupError"];
  const cleanupCode = (cleanup as { code?: unknown } | undefined)?.code;
  const inventory = CaptureChangeInventory.safeParse(facts["captureInventory"]);
  return WorkspaceCaptureFailure.parse({
    code: code.success ? code.data : "capture_failed",
    message: safe(error?.message ?? "Workspace changes could not be captured completely"),
    ...(typeof facts["code"] === "string" ? { causeCode: safe(facts["code"]) } : {}),
    ...(Number.isSafeInteger(facts["bufferBudgetBytes"]) && Number(facts["bufferBudgetBytes"]) >= 0
      ? { bufferBudgetBytes: facts["bufferBudgetBytes"] }
      : {}),
    ...(["stdout", "stderr"].includes(String(facts["stream"])) ? { stream: facts["stream"] } : {}),
    ...(facts["drain"] === "truncated" ? { drain: "truncated" } : {}),
    ...Object.fromEntries(
      (["requiredBytes", "availableBytes", "stallMs"] as const)
        .filter((key) => Number.isSafeInteger(facts[key]) && Number(facts[key]) >= 0)
        .map((key) => [key, facts[key]]),
    ),
    ...(typeof facts["signal"] === "string" ? { signal: safe(facts["signal"]).slice(0, 32) } : {}),
    ...(inventory.success ? { inventory: inventory.data } : {}),
    ...(cleanup === undefined
      ? {}
      : {
          cleanup: {
            code: typeof cleanupCode === "string" ? safe(cleanupCode) : null,
            message: safe(cleanup instanceof Error ? cleanup.message : String(cleanup)),
          },
        }),
  });
}
