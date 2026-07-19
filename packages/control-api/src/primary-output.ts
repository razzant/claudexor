import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { ControlPrimaryOutput, type RunFailure } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { safeArtifactPath } from "./artifact-paths.js";
import type { DaemonRunRecord } from "./daemon-server.js";
import { TERMINAL_STATES } from "./sse-shared.js";

const PRIMARY_OUTPUT_PREVIEW_BYTES = 256 * 1024;
const REDACTION_OVERLAP_BYTES = 1024;

function decodeValidUtf8(data: Buffer): string {
  for (let trim = 0; trim <= 3 && trim <= data.length; trim += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        trim === 0 ? data : data.subarray(0, data.length - trim),
      );
    } catch {
      // A bounded prefix may end inside one multi-byte scalar; back off.
    }
  }
  return data.toString("utf8");
}

function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  return encoded.length <= maxBytes ? text : decodeValidUtf8(encoded.subarray(0, maxBytes));
}

function preview(
  rec: DaemonRunRecord,
  relPath: string,
): { text: string; bytes: number; truncated: boolean } | null {
  if (!rec.runDir) return null;
  const path = safeArtifactPath(rec.runDir, relPath);
  if (!path) return null;
  const st = lstatSync(path);
  if (st.isSymbolicLink() || st.isDirectory()) return null;
  const length = Math.min(st.size, PRIMARY_OUTPUT_PREVIEW_BYTES + REDACTION_OVERLAP_BYTES);
  const data = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, data, 0, length, 0);
  } finally {
    closeSync(fd);
  }
  const redacted = redactSecrets(decodeValidUtf8(data));
  return {
    text: truncateUtf8(redacted, PRIMARY_OUTPUT_PREVIEW_BYTES),
    bytes: st.size,
    truncated:
      st.size > PRIMARY_OUTPUT_PREVIEW_BYTES ||
      Buffer.byteLength(redacted, "utf8") > PRIMARY_OUTPUT_PREVIEW_BYTES,
  };
}

export function boundedArtifactText(rec: DaemonRunRecord, relPath: string): string | null {
  const output = preview(rec, relPath);
  if (!output?.text.trim()) return null;
  return output.truncated
    ? `${output.text}\n\n[Inline preview bounded; open ${relPath} for the full artifact.]`
    : output.text;
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
          // deep scan writes a synthesized research report instead of an answer
          { kind: "report" as const, path: "final/report.md" },
        ]
      : mode === "plan"
        ? [{ kind: "plan" as const, path: "final/plan.md" }]
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
