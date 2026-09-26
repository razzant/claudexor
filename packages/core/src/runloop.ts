import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { spawnProcess, type ChildStdin } from "./proc.js";
import type { ProcessTreeTerminationOutcome, ReapProcessTreeOptions } from "./process-tree.js";

/**
 * Shared CLI adapter run loop.
 *
 * Every local-CLI adapter (claude/codex/cursor/opencode) streams NDJSON from a
 * spawned binary and translates lines into normalized HarnessEvents. This loop
 * owns the parts that previously drifted between four copy-pasted variants:
 *
 * - stderr is captured (bounded ring buffer, adapter-redacted) and attached to
 *   the terminal `completed` payload as `stderr_tail` whenever it is non-empty
 *   — raw diagnostics only, never a verdict axis (INV-116 untouched), and
 *   double-redacted downstream (the orchestrator's redactHarnessEvent runs
 *   before events.jsonl persistence). The tail rides that terminal event, so
 *   persistence into attempt events is guaranteed for consumers that drain
 *   this stream to completion (zero and nonzero exits alike); an
 *   orchestrator-side abort that stops consuming before the terminal event
 *   will not persist it (bounded residue, ledgered). On an unexplained
 *   nonzero exit the same tail is additionally folded into the synthesized
 *   error text (adapters parse that failure-path argument — deliberate
 *   duplication);
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
  /** One-shot stdin payload. Mutually exclusive with the bidirectional session owner. */
  input?: string;
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
  /** Adapter-owned translation for a recognized stderr-only nonzero exit. */
  parseStderrFailure?: (stderr: string, sessionId: string) => HarnessEvent | null;
  /** Stop and reap the harness immediately after a normalized fatal event. */
  stopAfterEvent?: (event: HarnessEvent) => boolean;
  /**
   * Bidirectional session support (e.g. Claude's stream-json control
   * protocol). When set, stdin stays open, `initialStdin` is written at spawn,
   * frames matching `matches` are routed to `handle` (an async generator that
   * may yield normalized events and write control responses via the stdin
   * handle), and stdin is closed when `closeStdinOn` matches a frame —
   * the cooperative end of a streaming session. An adapter that must keep the
   * session open past a native terminal frame (a queued live message the CLI
   * runs as its next native turn, a run-owned background task) returns `false`
   * there; the deadline, inactivity and cancel bounds stay the outer limits.
   */
  session?: {
    initialStdin?: string;
    matches: (obj: unknown) => boolean;
    handle: (obj: unknown, io: ChildStdin) => AsyncGenerator<HarnessEvent>;
    closeStdinOn?: (obj: unknown) => boolean;
    /**
     * Live stdin seam for an adapter's live-input owner: called with the handle
     * right after spawn (once `initialStdin` is written) and with `null` exactly
     * once when stdin closes — on the `closeStdinOn` path or in the loop's
     * finally — so no live message is ever written into a closed session.
     */
    onIo?: (io: ChildStdin | null, sessionId: string) => void;
  };
  /** Injection seam for the whole-tree death proof (deterministic tests of the
   * termination_unconfirmed terminal fact). Forwarded to spawnProcess; production
   * callers never set this. */
  reap?: (opts: ReapProcessTreeOptions) => Promise<ProcessTreeTerminationOutcome>;
}

export async function* runCliHarness(opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
  if (opts.input !== undefined && opts.session !== undefined) {
    throw new Error("runCliHarness input and session are mutually exclusive stdin owners");
  }
  const { spec } = opts;
  const label = opts.label ?? opts.bin;
  const redact = opts.redact ?? ((text: string): string => text);
  const ts = (): string => new Date().toISOString();
  const stderrRing: string[] = [];
  let droppedUnparsedLines = 0;
  let droppedUnrecognizedEvents = 0;
  let sawError = false;
  // The harness's OWN stdout frames produced an `error` event (adapter parse or
  // adapter session handler). Never set for a spawn failure, an unconfirmed
  // termination, a stderr-only failure, or the loop's synthesized exit error.
  let harnessReportedError = false;
  let spawnFailed = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  // QA-027: a cancellation whose whole-tree death proof could not confirm death
  // (a proven-alive survivor group or an unreadable-identity group). Never silent.
  let terminationUnconfirmed: {
    survivors: number[];
    unresolved: Array<{ pgid: number; reason: string }>;
  } | null = null;
  const abortSignal = abortSignalFromSpec(spec);

  const stderrTail = (): string => redact(stderrRing.join("\n")).slice(-STDERR_DETAIL_MAX).trim();

  // Box the stdin handle: it is assigned inside the onSpawn callback, which
  // TypeScript's control-flow narrowing cannot see through a plain let.
  const session: { io: ChildStdin | null } = { io: null };
  // One owner for the close: stdin ends once and the adapter hears `null` once,
  // whether the native terminal frame closed it or the loop's finally did.
  const closeSessionStdin = (): void => {
    if (!session.io) return;
    session.io.end();
    session.io = null;
    opts.session?.onIo?.(null, spec.session_id);
  };
  try {
    for await (const ev of spawnProcess(opts.bin, opts.args, {
      cwd: spec.cwd,
      env: opts.env,
      inheritEnv: spec.env_inheritance,
      abortSignal,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.reap ? { reap: opts.reap } : {}),
      onTerminationUnconfirmed: (info) => {
        terminationUnconfirmed = { survivors: info.survivors, unresolved: info.unresolved };
        sawError = true;
      },
      ...(opts.session
        ? {
            keepStdinOpen: true,
            onSpawn: (io: ChildStdin) => {
              session.io = io;
              if (opts.session?.initialStdin) io.write(opts.session.initialStdin);
              opts.session?.onIo?.(io, spec.session_id);
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
      if (ev.type === "termination_unconfirmed") {
        // Death could not be proven — a fail-closed terminal fact (QA-027). Mark
        // the attempt non-clean so it can never launder as a clean success.
        terminationUnconfirmed = { survivors: ev.survivors, unresolved: ev.unresolved };
        sawError = true;
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
          if (out.type === "error") sawError = harnessReportedError = true;
          yield out;
        }
        continue;
      }
      const events = opts.parseEvent(obj, spec.session_id);
      if (opts.session && session.io && opts.session.closeStdinOn?.(obj)) {
        // The native terminal frame arrived; close stdin so the streaming
        // session ends cooperatively instead of waiting for more input.
        closeSessionStdin();
      }
      if (events === null) {
        droppedUnrecognizedEvents += 1;
        continue;
      }
      let stop = false;
      for (const out of events) {
        if (out.type === "error") sawError = harnessReportedError = true;
        yield out;
        if (opts.stopAfterEvent?.(out)) {
          stop = true;
          break;
        }
      }
      if (stop) break;
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
    closeSessionStdin();
  }

  const aborted = abortSignal?.aborted === true;
  // QA-027 fail-closed: an unconfirmed death is disclosed as its own typed terminal
  // fact EVEN on an aborted run (a default cancellation that could not prove death
  // is exactly the silent-survivor case) — emitted regardless of `aborted`.
  if (terminationUnconfirmed) {
    yield {
      type: "error",
      session_id: spec.session_id,
      ts: ts(),
      error: `${label} cancellation could not confirm process death: ${terminationUnconfirmed.survivors.length} surviving group(s)${
        terminationUnconfirmed.unresolved.length
          ? `, ${terminationUnconfirmed.unresolved.length} group(s) with unreadable identity`
          : ""
      }`,
    };
  }
  if (!sawError && !aborted && exitCode !== null && exitCode !== 0) {
    const tail = stderrTail();
    yield (tail ? opts.parseStderrFailure?.(tail, spec.session_id) : null) ?? {
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
  // Typed unconfirmed-death terminal fact (QA-027): the run cannot read as a clean
  // cancel/success while a proven survivor lives — the disclosure rides the
  // terminal completed event (and the error above), never a silent drop.
  if (terminationUnconfirmed) {
    payload["termination_unconfirmed"] = {
      survivors: terminationUnconfirmed.survivors,
      unresolved: terminationUnconfirmed.unresolved,
    };
  }
  // Typed crash evidence (GH #31): a non-aborted signal kill or spawn failure is
  // a process crash the orchestrator classifies without parsing prose.
  if (!aborted && exitSignal) payload["exit_signal"] = exitSignal;
  if (spawnFailed) payload["spawn_failed"] = true;
  // Typed "the harness voiced its own error" fact: lets the orchestrator tell a
  // CLI that reported a failed turn and exited non-zero from a crashed process,
  // without parsing prose. Only this loop can tell a harness frame from its own
  // synthesized exit error.
  if (harnessReportedError) payload["harness_reported_error"] = true;
  // Raw stderr diagnostics ride EVERY terminal payload (GH #120) — zero-exit and
  // aborted runs previously discarded the ring. Bounded + redacted here, redacted
  // again by the orchestrator before persistence; surfaced only through the raw
  // diagnostics channel (events.jsonl / SSE / --json-stream), never classified.
  const stderrDetail = stderrTail();
  if (stderrDetail) payload["stderr_tail"] = stderrDetail;
  yield {
    type: "completed",
    session_id: spec.session_id,
    ts: ts(),
    ...(aborted ? { aborted: true } : {}),
    ...(Object.keys(payload).length > 0 ? { payload } : {}),
  };
}
