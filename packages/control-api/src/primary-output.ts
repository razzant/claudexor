import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { ControlPrimaryOutput, type RunFacts, type RunFailure } from "@claudexor/schema";
import { RETAINED_OUTPUT_PATH } from "@claudexor/event-log";
import { safeArtifactPath } from "./artifact-paths.js";
import type { DaemonRunRecord } from "./daemon-server.js";
import { readRunTombstone } from "./retention.js";
import { TERMINAL_STATES } from "./sse-shared.js";
import { projectionRead } from "./projection-context.js";

const PRIMARY_OUTPUT_PREVIEW_BYTES = 256 * 1024;
/** Read past the cap so truncation always sees whether more text follows. */
const READ_LOOKAHEAD_BYTES = 1024;

function decodeValidUtf8(data: Buffer): string {
  for (let trim = 0; trim <= 3 && trim <= data.length; trim += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        trim === 0 ? data : data.subarray(0, data.length - trim),
      );
    } catch {
      // A bounded prefix may end inside one multi-byte scalar; back off.
    }
  }
  return data.toString("utf8");
}

export function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  return encoded.length <= maxBytes ? text : decodeValidUtf8(encoded.subarray(0, maxBytes));
}

function preview(
  rec: DaemonRunRecord,
  relPath: string,
  maxBytes = PRIMARY_OUTPUT_PREVIEW_BYTES,
  metadataOnly = false,
): { text: string; bytes: number; truncated: boolean } | null {
  return projectionRead(
    rec.runDir ?? rec.id,
    `preview:${maxBytes}:${metadataOnly}:${relPath}`,
    () => previewUncached(rec, relPath, maxBytes, metadataOnly),
  );
}

function previewUncached(
  rec: DaemonRunRecord,
  relPath: string,
  maxBytes: number,
  metadataOnly: boolean,
): { text: string; bytes: number; truncated: boolean } | null {
  if (!rec.runDir) return null;
  const path = safeArtifactPath(rec.runDir, relPath);
  if (!path) return null;
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || st.isDirectory()) return null;
    // A reference still needs the canonical bounded nonblank-output check;
    // a nonempty whitespace-only patch must not become a ready deliverable.
    const readLimit = metadataOnly ? PRIMARY_OUTPUT_PREVIEW_BYTES : maxBytes;
    const length = Math.min(st.size, readLimit + READ_LOOKAHEAD_BYTES);
    const data = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, data, 0, length, 0);
    } finally {
      closeSync(fd);
    }
    const text = decodeValidUtf8(data);
    if (metadataOnly) return text.trim() ? { text: "", bytes: st.size, truncated: true } : null;
    return {
      text: truncateUtf8(text, maxBytes),
      bytes: st.size,
      truncated: st.size > length || Buffer.byteLength(text, "utf8") > maxBytes,
    };
  } catch {
    return null;
  }
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
  runFacts: RunFacts | null = null,
  options: { maxBytes?: number; patchReferenceOnly?: boolean; metadataMaxBytes?: number } = {},
): ControlPrimaryOutput | null {
  const selected = (path: string, kind?: string) =>
    preview(rec, path, options.maxBytes, options.patchReferenceOnly && kind === "patch");
  const usable = (output: ReturnType<typeof preview>, kind?: string) =>
    output &&
    (output.text.trim() || (options.patchReferenceOnly && kind === "patch" && output.bytes > 0));
  const project = (kind: string, path: string, output: NonNullable<ReturnType<typeof preview>>) =>
    ControlPrimaryOutput.parse({
      kind,
      path,
      ...output,
      text: options.patchReferenceOnly && kind === "patch" ? null : output.text,
    });
  const tombstone = rec.runDir ? readRunTombstone(rec.runDir, options.metadataMaxBytes) : null;
  if (tombstone) {
    const text = "Run artifacts were reclaimed by retention; inspect tombstone.yaml.";
    return ControlPrimaryOutput.parse({
      kind: "diagnostic",
      path: "tombstone.yaml",
      text,
      bytes: Buffer.byteLength(text, "utf8"),
    });
  }
  if (runFacts?.presentation) {
    const primary = runFacts.presentation.primary;
    if (!primary) return null;
    const output = selected(primary.path, primary.kind);
    if (usable(output, primary.kind)) return project(primary.kind, primary.path, output!);
    const text = `The canonical primary output (${primary.path}) is unavailable; inspect run retention and artifacts.`;
    return ControlPrimaryOutput.parse({
      kind: "diagnostic",
      path: primary.path,
      text,
      bytes: Buffer.byteLength(text, "utf8"),
    });
  }
  if (rec.state === "interrupted" && !runFacts) {
    const retained = selected(RETAINED_OUTPUT_PATH);
    if (retained?.text.trim())
      return ControlPrimaryOutput.parse({
        kind: "report",
        path: RETAINED_OUTPUT_PATH,
        ...retained,
      });
  }
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
        : [
            { kind: "structured_output" as const, path: "final/output.json" },
            { kind: "answer" as const, path: "final/answer.md" },
            { kind: "patch" as const, path: "final/patch.diff" },
          ];
  for (const candidate of candidates) {
    const output = selected(candidate.path, candidate.kind);
    if (usable(output, candidate.kind)) return project(candidate.kind, candidate.path, output!);
  }
  // Older cancelled Ask runs may contain only the cancellation summary.
  if (mode === "ask" && rec.state === "cancelled") {
    const output = selected("final/summary.md");
    if (output?.text.trim()) {
      return ControlPrimaryOutput.parse({
        kind: "diagnostic",
        path: "final/summary.md",
        ...output,
      });
    }
  }
  return failure
    ? ControlPrimaryOutput.parse({
        kind: "diagnostic",
        path: failure.rawDetailRef ?? "final/failure.yaml",
        text:
          options.maxBytes === undefined
            ? failure.safeMessage
            : truncateUtf8(failure.safeMessage, options.maxBytes),
        bytes: Buffer.byteLength(failure.safeMessage, "utf8"),
        truncated:
          options.maxBytes !== undefined &&
          Buffer.byteLength(failure.safeMessage, "utf8") > options.maxBytes,
      })
    : null;
}

export function outputReadyState(
  rec: DaemonRunRecord,
  mode: string | null | undefined,
  failure: RunFailure | null,
  runFacts: RunFacts | null = null,
): "pending" | "finalizing" | "ready" | "diagnostic" {
  if (rec.state === "interrupted" && !runFacts) return "diagnostic";
  if (runFacts?.presentation && !runFacts.presentation.primary) return runFacts.presentation.state;
  return outputReadyStateForPrimary(
    rec,
    failure,
    runFacts,
    primaryOutput(rec, mode, failure, runFacts),
  );
}

/** Shared readiness fold; history selects the bounded primary exactly once. */
export function outputReadyStateForPrimary(
  rec: DaemonRunRecord,
  failure: RunFailure | null,
  runFacts: RunFacts | null,
  primary: ControlPrimaryOutput | null,
): "pending" | "finalizing" | "ready" | "diagnostic" {
  if (rec.state === "interrupted" && !runFacts) return "diagnostic";
  if (primary?.kind === "diagnostic") return "diagnostic";
  if (runFacts?.presentation) {
    if (!runFacts.presentation.primary) return runFacts.presentation.state;
    return runFacts.presentation.state;
  }
  if (primary?.text?.trim() || (primary?.kind === "patch" && primary.bytes)) return "ready";
  if (TERMINAL_STATES.has(rec.state)) return failure ? "diagnostic" : "finalizing";
  return "pending";
}
