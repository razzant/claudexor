/**
 * Login-runner IO hygiene and delivery helpers (owner directive 2026-08-04):
 * the bounded ANSI-stripped, secret-redacted, URL-query-redacted output tail
 * that is the ONLY vendor output allowed near a durable surface (INV-146),
 * and the one-shot input-sidecar-to-stdin delivery for
 * url_disclosure_with_input logins.
 */
import type { ChildProcess } from "node:child_process";
import { redactSecrets } from "@claudexor/util";
import {
  atomicPrivateJson,
  readRunnerLoginInput,
  type SetupLoginManifest,
} from "./setup-login-protocol.js";

export const OUTPUT_TAIL_BYTES = 4096;

/**
 * OAuth-URL capture for TERMINAL-mode logins (claude/cursor, and codex's
 * legacy fallback): the vendor CLI prints its sign-in URL to its own output;
 * detecting it lets the runner surface a STRUCTURED `oauth_url` disclosure on
 * the job — the same sidecar + card shape as codex's device-code flow — so a
 * UI can render "open this link" with no terminal. Bounded rolling window: a
 * URL split across chunks is still caught, memory stays capped.
 */
// eslint-disable-next-line no-control-regex
export const TERM_ESCAPE_RE =
  /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g;
// eslint-disable-next-line no-control-regex
export const C0_CONTROL_RE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

const INPUT_POLL_MS = 300;

/** One-shot delivery of the daemon-written input sidecar to the vendor CLI's
 * stdin (url_disclosure_with_input — claude's pasted OAuth code). The value
 * exists only in the 0600 job-dir sidecar and the child's stdin; it never
 * touches the tail, the result, or any durable record. */
export function watchLoginInput(
  manifest: SetupLoginManifest,
  child: ChildProcess,
  now: () => Date,
  /** Called with the value the moment it is delivered. A tty-backed login
   * (ptyStdin) is ECHOED by the terminal line discipline, so the pasted code
   * comes straight back out on the tee'd output — the tail must forget it
   * before any failure receipt is written (INV-146). */
  options: {
    onDelivered?: (value: string) => void;
    windowsConpty?: boolean;
  } = {},
): () => void {
  let delivered = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (delivered || !manifest.inputPath || !child.stdin || child.stdin.destroyed) return;
    const input = readRunnerLoginInput(manifest.inputPath, manifest.jobId, manifest.executionId);
    if (!input) return;
    delivered = true;
    options.onDelivered?.(input.value);
    try {
      if (options.windowsConpty) {
        // Server-era ConPTY parsers have shipped bugs around chunked Win32
        // input-mode sequences. Wait for each complete record's write callback:
        // consecutive write() calls can otherwise coalesce through _writev.
        const stdin = child.stdin;
        const records = encodeWindowsConptyLine(input.value).values();
        const writeNext = (error?: Error | null): void => {
          if (error || stopped || stdin.destroyed) return;
          const record = records.next();
          if (!record.done) stdin.write(record.value, writeNext);
        };
        // Writable reports a failed write both to its callback and as an
        // error event. The callback stops delivery; the runner owns the result.
        stdin.once("error", () => undefined);
        writeNext();
      } else {
        child.stdin.write(`${input.value}\n`);
      }
      // Delivery has been claimed, not acknowledged by the vendor. Keep only
      // the consumed marker while the remaining writes complete, so a second
      // submission still conflicts and the secret no longer exists on disk.
      atomicPrivateJson(manifest.inputPath, {
        version: input.version,
        jobId: manifest.jobId,
        executionId: manifest.executionId,
        consumed: true,
        submittedAt: input.submittedAt,
      });
    } catch {
      // A dead stdin means the vendor already exited; the result receipt
      // carries the real outcome.
    }
  }, INPUT_POLL_MS);
  timer.unref?.();
  void now;
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function encodeWindowsConptyLine(value: string): string[] {
  const keyRecord = (virtualKey: number, scanCode: number, codeUnit: number, keyDown: 0 | 1) =>
    `\u001b[${virtualKey};${scanCode};${codeUnit};${keyDown};0;1_`;
  const records: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    records.push(keyRecord(231, 0, codeUnit, 1), keyRecord(231, 0, codeUnit, 0));
  }
  records.push(keyRecord(13, 28, 13, 1), keyRecord(13, 28, 13, 0));
  return records;
}

/** Ring buffer of the last OUTPUT_TAIL_BYTES of tee'd vendor output. */
export function createTailBuffer(): {
  push(chunk: Buffer): void;
  text(): string;
  forget(value: string): void;
} {
  // Byte-accurate ring: keep the final OUTPUT_TAIL_BYTES RAW bytes, decode
  // ONCE in text() (per-chunk String() splits multibyte UTF-8; UTF-16 .slice
  // miscounts the byte bound).
  let tail = Buffer.alloc(0);
  // Ring overflow is tracked HERE and handed to boundedTail — the decoded
  // string's length (already <= the cap) cannot recover it (X224).
  let overflowed = false;
  // Exact strings the tail must never carry back out (a tty-echoed sign-in
  // code); `redactSecrets` cannot anchor a vendor code with no known prefix.
  const forgotten: string[] = [];
  return {
    forget(value) {
      // Every delivered value is a secret, however short. A tty also echoes a
      // CR as a LINE BREAK, so the string we wrote comes back as two lines and
      // a whole-string match would miss both halves.
      for (const part of value.split(/[\r\n]+/)) {
        const trimmed = part.trim();
        if (trimmed) forgotten.push(trimmed);
      }
    },
    push(chunk) {
      const combined = Buffer.concat([tail, chunk]);
      if (combined.length > OUTPUT_TAIL_BYTES) overflowed = true;
      tail = combined.subarray(-OUTPUT_TAIL_BYTES);
    },
    text() {
      // The ring can start mid-codepoint: drop leading continuation bytes
      // (0b10xxxxxx) so the decode never opens with a replacement char.
      let start = 0;
      while (start < tail.length && (tail[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
      // Escapes come off BEFORE the forget match: a vendor that re-prints the
      // code in colour splits it with control bytes, the exact-string match
      // misses, and boundedTail then reassembles the plaintext into a durable
      // receipt. Stripping first means the match sees what the reader will.
      let text = tail
        .subarray(start)
        .toString("utf8")
        .replace(TERM_ESCAPE_RE, "")
        .replace(C0_CONTROL_RE, "");
      for (const value of forgotten) text = text.split(value).join("[redacted]");
      return boundedTail(text, overflowed || start > 0);
    },
  };
}

// Live sign-in material rides a URL's QUERY (state/code_challenge/user_code):
// transient-sidecar-only, never durable (f-78414434ad00). Host+path stay.
const URL_QUERY_RE = /(https?:\/\/[^\s"'<>?#]+)\?[^\s"'<>]*/g;

/** Strip terminal escapes (CSI, OSC, bare ESC, C0 controls except newline),
 * redact secret-like tokens and URL queries, and clamp - diagnostic evidence
 * entering a durable journal/API surface, never a raw vendor log copy
 * (INV-146). */
export function boundedTail(text: string, truncated = false): string {
  const plain = text
    .replace(TERM_ESCAPE_RE, "")
    .replace(C0_CONTROL_RE, "")
    .replace(URL_QUERY_RE, "$1?[redacted]");
  // Redact the complete sanitized input before any boundary is selected: a
  // tail-first clamp can strip the prefix a token detector needs to anchor.
  const redacted = redactSecrets(plain);
  // When the source was truncated at the front (ring overflow, or a
  // direct-string caller over the byte budget), a secret split by that
  // boundary could leave a prefix-less fragment redactSecrets cannot anchor —
  // drop the leading partial token. The caller's flag is authoritative (a
  // ring string is already <= the cap, so length cannot see the cut).
  const bytes = Buffer.from(redacted, "utf8");
  const cut = truncated || bytes.length > OUTPUT_TAIL_BYTES;
  const tail = bytes.subarray(Math.max(0, bytes.length - OUTPUT_TAIL_BYTES));
  let start = 0;
  while (start < tail.length && (tail[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
  let bounded = tail.subarray(start).toString("utf8");
  if (cut) bounded = bounded.replace(/^\S+/, "");
  return bounded.trim();
}
