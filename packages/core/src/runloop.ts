import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { spawnProcess, type ChildStdin } from "./proc.js";

/**
 * Shared CLI adapter run loop.
 *
 * Every local-CLI adapter (claude/codex/cursor/opencode) streams NDJSON from a
 * spawned binary and translates lines into normalized HarnessEvents. This loop
 * owns the parts that previously drifted between four copy-pasted variants:
 *
 * - stderr is captured (bounded ring buffer) and surfaced on failure instead of
 *   being silently dropped;
 * - unparseable stdout lines and recognized-but-unmapped native events are
 *   COUNTED and reported on the terminal `completed` event payload
 *   (`dropped_unparsed_lines` / `dropped_unrecognized_events`), never silently
 *   discarded;
 * - a terminal `completed` event is guaranteed exactly once on every path
 *   (clean exit, nonzero exit, spawn failure, abort);
 * - abort is honored via the duck-typed AbortSignal smuggled in `spec.extra`
 *   (instanceof checks break across module realms).
 */

const STDERR_RING_MAX = 40;
const STDERR_DETAIL_MAX = 1000;

export function abortSignalFromSpec(spec: HarnessRunSpec): AbortSignal | undefined {
  const signal = spec.extra?.["abortSignal"];
  if (!signal || typeof signal !== "object") return undefined;
  const candidate = signal as Partial<AbortSignal>;
  return typeof candidate.aborted === "boolean" && typeof candidate.addEventListener === "function"
    ? (signal as AbortSignal)
    : undefined;
}

export interface CliRunLoopOptions {
  bin: string;
  args: string[];
  spec: HarnessRunSpec;
  /**
   * Translate one parsed JSON stdout object into normalized events.
   * Return `null` for UNRECOGNIZED shapes (counted as dropped) and `[]` for
   * recognized-but-intentionally-skipped events (progress ticks etc.).
   */
  parseEvent: (obj: unknown, sessionId: string) => HarnessEvent[] | null;
  env?: Record<string, string | null | undefined>;
  /** Label used in synthesized error messages; defaults to `bin`. */
  label?: string;
  /** Redactor applied to stderr detail before it is surfaced. */
  redact?: (text: string) => string;
  /**
   * Bidirectional session support (e.g. Claude's stream-json control
   * protocol). When set, stdin stays open, `initialStdin` is written at spawn,
   * frames matching `matches` are routed to `handle` (an async generator that
   * may yield normalized events and write control responses via the stdin
   * handle), and stdin is closed when `closeStdinOn` matches a frame —
   * the cooperative end of a streaming session.
   */
  session?: {
    initialStdin?: string;
    matches: (obj: unknown) => boolean;
    handle: (obj: unknown, io: ChildStdin) => AsyncGenerator<HarnessEvent>;
    closeStdinOn?: (obj: unknown) => boolean;
  };
}

export async function* runCliHarness(opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
  const { spec } = opts;
  const label = opts.label ?? opts.bin;
  const redact = opts.redact ?? ((text: string): string => text);
  const ts = (): string => new Date().toISOString();
  const stderrRing: string[] = [];
  let droppedUnparsedLines = 0;
  let droppedUnrecognizedEvents = 0;
  let sawError = false;
  let spawnFailed = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const abortSignal = abortSignalFromSpec(spec);

  const stderrTail = (): string => redact(stderrRing.join("\n")).slice(-STDERR_DETAIL_MAX).trim();

  // Box the stdin handle: it is assigned inside the onSpawn callback, which
  // TypeScript's control-flow narrowing cannot see through a plain let.
  const session: { io: ChildStdin | null } = { io: null };
  try {
    for await (const ev of spawnProcess(opts.bin, opts.args, {
      cwd: spec.cwd,
      env: opts.env,
      inheritEnv: spec.env_inheritance,
      abortSignal,
      ...(opts.session
        ? {
            keepStdinOpen: true,
            onSpawn: (io: ChildStdin) => {
              session.io = io;
              if (opts.session?.initialStdin) io.write(opts.session.initialStdin);
            },
          }
        : {}),
    })) {
      if (ev.type === "stderr") {
        stderrRing.push(ev.line);
        if (stderrRing.length > STDERR_RING_MAX) stderrRing.shift();
        continue;
      }
      if (ev.type === "exit") {
        exitCode = ev.code;
        exitSignal = ev.signal;
        continue;
      }
      let obj: unknown;
      try {
        obj = JSON.parse(ev.line);
      } catch {
        droppedUnparsedLines += 1;
        continue;
      }
      if (opts.session && session.io && opts.session.matches(obj)) {
        for await (const out of opts.session.handle(obj, session.io)) {
          if (out.type === "error") sawError = true;
          yield out;
        }
        continue;
      }
      const events = opts.parseEvent(obj, spec.session_id);
      if (opts.session && session.io && opts.session.closeStdinOn?.(obj)) {
        // The native terminal frame arrived; close stdin so the streaming
        // session ends cooperatively instead of waiting for more input.
        session.io.end();
        session.io = null;
      }
      if (events === null) {
        droppedUnrecognizedEvents += 1;
        continue;
      }
      for (const out of events) {
        if (out.type === "error") sawError = true;
        yield out;
      }
    }
  } catch (err) {
    sawError = true;
    spawnFailed = true;
    yield {
      type: "error",
      session_id: spec.session_id,
      ts: ts(),
      error: `${label} failed to start: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    session.io?.end();
    session.io = null;
  }

  const aborted = abortSignal?.aborted === true;
  if (!sawError && !aborted && exitCode !== null && exitCode !== 0) {
    const tail = stderrTail();
    yield {
      type: "error",
      session_id: spec.session_id,
      ts: ts(),
      error: `${label} exited with code ${exitCode}${tail ? `: ${tail}` : ""}`,
    };
  } else if (!sawError && !aborted && exitCode === null && exitSignal) {
    yield {
      type: "error",
      session_id: spec.session_id,
      ts: ts(),
      error: `${label} was killed by signal ${exitSignal}`,
    };
  }

  const payload: Record<string, unknown> = {};
  if (droppedUnparsedLines > 0) payload["dropped_unparsed_lines"] = droppedUnparsedLines;
  if (droppedUnrecognizedEvents > 0)
    payload["dropped_unrecognized_events"] = droppedUnrecognizedEvents;
  if (aborted) payload["aborted"] = true;
  if (exitCode !== null) payload["exit_code"] = exitCode;
  // Typed crash evidence (GH #31): a non-aborted signal kill or spawn failure is
  // a process crash the orchestrator classifies without parsing prose.
  if (!aborted && exitSignal) payload["exit_signal"] = exitSignal;
  if (spawnFailed) payload["spawn_failed"] = true;
  yield {
    type: "completed",
    session_id: spec.session_id,
    ts: ts(),
    ...(aborted ? { aborted: true } : {}),
    ...(Object.keys(payload).length > 0 ? { payload } : {}),
  };
}
