import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { ControlPrimaryOutput, type RunFailure } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { safeArtifactPath } from "./artifact-paths.js";
import type { DaemonRunRecord } from "./daemon-server.js";
import { TERMINAL_STATES } from "./sse-shared.js";

const PRIMARY_OUTPUT_PREVIEW_BYTES = 256 * 1024;

function preview(
  rec: DaemonRunRecord,
  relPath: string,
): { text: string; bytes: number; truncated: boolean } | null {
  if (!rec.runDir) return null;
  const path = safeArtifactPath(rec.runDir, relPath);
  if (!path) return null;
  const st = lstatSync(path);
  if (st.isSymbolicLink() || st.isDirectory()) return null;
  const length = Math.min(st.size, PRIMARY_OUTPUT_PREVIEW_BYTES);
  const data = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, data, 0, length, 0);
  } finally {
    closeSync(fd);
  }
  return {
    text: redactSecrets(data.toString("utf8")),
    bytes: st.size,
    truncated: st.size > length,
  };
}

export function primaryOutput(
  rec: DaemonRunRecord,
  mode: string | null | undefined,
  failure: RunFailure | null,
): ControlPrimaryOutput | null {
  const candidates =
    mode === "ask"
      ? [
          { kind: "structured_output" as const, path: "final/output.json" },
          { kind: "answer" as const, path: "final/answer.md" },
        ]
      : mode === "plan"
        ? [{ kind: "plan" as const, path: "final/plan.md" }]
        : mode === "audit"
          ? [
              { kind: "report" as const, path: "final/report.md" },
              { kind: "report" as const, path: "final/explore.md" },
              { kind: "summary" as const, path: "final/summary.md" },
            ]
          : mode === "orchestrate"
            ? [
                { kind: "report" as const, path: "final/orchestration.md" },
                { kind: "summary" as const, path: "final/summary.md" },
              ]
            : [
                { kind: "structured_output" as const, path: "final/output.json" },
                { kind: "answer" as const, path: "final/answer.md" },
                { kind: "summary" as const, path: "final/summary.md" },
                { kind: "patch" as const, path: "final/patch.diff" },
              ];
  for (const candidate of candidates) {
    const output = preview(rec, candidate.path);
    if (output?.text.trim()) return ControlPrimaryOutput.parse({ ...candidate, ...output });
  }
  return failure
    ? ControlPrimaryOutput.parse({
        kind: "diagnostic",
        path: failure.rawDetailRef ?? "final/failure.yaml",
        text: failure.safeMessage,
        bytes: Buffer.byteLength(failure.safeMessage, "utf8"),
      })
    : null;
}

export function outputReadyState(
  rec: DaemonRunRecord,
  mode: string | null | undefined,
  failure: RunFailure | null,
): "pending" | "finalizing" | "ready" | "diagnostic" {
  const primary = primaryOutput(rec, mode, failure);
  if (primary?.kind === "diagnostic") return "diagnostic";
  if (primary?.text?.trim()) return "ready";
  if (TERMINAL_STATES.has(rec.state)) return failure ? "diagnostic" : "finalizing";
  return "pending";
}
