import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { assertCaptureComplete, runCaptureRaw, type CaptureProjection } from "@claudexor/core";
import { incompleteWorkspaceCapture } from "./capture-failure.js";
import type { CapturedWorkspaceDiff } from "./manager.js";
import { excludePlainDiffPathPrefix, relativizePlainDiffHeaders } from "./plain-diff.js";

const PROJECTION_CHARS = 200_000; // Existing legacy non-Git preview contract.
const TRUNCATED = "\n... [diff truncated]\n";
type Line = { text: string; newline: boolean; clipped: boolean; output?: string };

/** Drain the entire diff but retain only the preview. Four-line lookahead keeps
 * structural header recognition and exact owned-directory exclusion intact;
 * even a single enormous hunk line is bounded before it becomes a string.
 */
export class PlainDiffProjection implements CaptureProjection {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private clipped = false;
  private lines: Line[] = [];
  private inHunk = false;
  private excluded = false;
  private preview = "";
  private truncated = false;
  get complete(): boolean {
    return !this.truncated;
  }

  constructor(
    private baseline: string,
    private root: string,
    private artifactRelative?: string | null,
  ) {}

  write(chunk: Buffer): void {
    this.consume(this.decoder.write(chunk));
  }

  private consume(text: string): void {
    let offset = 0;
    while (offset < text.length) {
      const end = text.indexOf("\n", offset);
      const stop = end === -1 ? text.length : end;
      const room = PROJECTION_CHARS + 1 - this.pending.length;
      this.pending += text.slice(offset, Math.min(stop, offset + room));
      this.clipped ||= stop - offset > room;
      if (end === -1) break;
      this.line(true);
      offset = end + 1;
    }
  }

  private line(newline: boolean): void {
    this.lines.push({ text: this.pending, newline, clipped: this.clipped });
    this.pending = "";
    this.clipped = false;
    if (this.lines.length >= 4) this.flushLine();
  }

  private flushLine(): void {
    const prefix = this.inHunk ? "@@\n" : "";
    const normalized = relativizePlainDiffHeaders(
      prefix + this.lines.map((l) => l.text).join("\n"),
      this.baseline,
      this.root,
    )
      .split("\n")
      .slice(this.inHunk ? 1 : 0);
    const raw = this.lines[0]!;
    const line = { ...raw, text: raw.output ?? normalized[0]! };
    if (
      raw.text.startsWith("--- ") &&
      this.lines[1]?.text.startsWith("+++ ") &&
      this.lines[2]?.text.startsWith("@@")
    )
      this.lines[1]!.output = normalized[1]!;
    const binary = line.text.startsWith("Binary files ") && line.text.endsWith(" differ");
    if (line.text.startsWith("diff ") || binary) {
      this.inHunk = false;
      const nextBlock = normalized.findIndex(
        (text, i) => i > 0 && (text.startsWith("diff ") || text.startsWith("Binary files ")),
      );
      this.excluded =
        !!this.artifactRelative &&
        excludePlainDiffPathPrefix(
          normalized.slice(0, binary ? 1 : nextBlock < 0 ? undefined : nextBlock).join("\n"),
          this.artifactRelative,
        ) === "";
    } else if (line.text.startsWith("@@")) this.inHunk = true;
    if (!this.excluded) {
      const text = line.text + (line.newline ? "\n" : "");
      const room = PROJECTION_CHARS - this.preview.length;
      this.preview += text.slice(0, room);
      this.truncated ||= line.clipped || text.length > room;
    }
    this.lines.shift();
  }

  end(): string {
    this.consume(this.decoder.end());
    if (this.pending || this.clipped) this.line(false);
    while (this.lines.length) this.flushLine();
    return this.preview + (this.truncated ? TRUNCATED : "");
  }
}

export async function capturePlainDiff(
  baseline: string,
  root: string,
  artifactRelative: string | null,
): Promise<CapturedWorkspaceDiff> {
  if (!existsSync(baseline))
    return incompleteWorkspaceCapture(new Error("Non-Git capture baseline is unavailable"));
  try {
    const projection = new PlainDiffProjection(baseline, root, artifactRelative);
    const result = await runCaptureRaw(
      "diff",
      [
        "-ruN",
        "-x",
        ".git",
        "-x",
        "node_modules",
        "-x",
        "__pycache__",
        "-x",
        ".venv",
        "-x",
        "venv",
        baseline,
        root,
      ],
      { timeoutMs: 120_000, stdoutProjection: projection },
    );
    assertCaptureComplete(result);
    if (result.code !== 0 && result.code !== 1)
      return incompleteWorkspaceCapture(
        Object.assign(new Error(`diff failed (${result.code}): ${result.stderr}`), {
          code: "capture_failed",
        }),
      );
    return {
      diff: result.stdout,
      captureIncomplete: !projection.complete,
      ...(!projection.complete
        ? {
            captureFailure: Object.assign(
              new Error(
                "Non-Git display preview exceeds 200,000 characters; exact patch operations are unavailable",
              ),
              { code: "capture_preview_truncated" },
            ),
          }
        : {}),
    };
  } catch (error) {
    return incompleteWorkspaceCapture(error);
  }
}
