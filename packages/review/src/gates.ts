import type { GateResult } from "@claudexor/schema";
import { GateResult as GateResultSchema } from "@claudexor/schema";
import { runCapture } from "@claudexor/core";
import { redactSecrets } from "@claudexor/util";

const GATE_OUTPUT_TAIL_CHARS = 12_000;

export interface GateSpec {
  id: string;
  command: string;
  required?: boolean;
}

export interface RunGatesOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Cancellation: checked between gates AND passed into each gate's process
   * (a cancel must not wait out a 600s gate before acknowledging — T3.1#8). */
  signal?: AbortSignal;
}

/** Run one deterministic gate. Outcome is decided by exit code, never by parsing text. */
export async function runGate(spec: GateSpec, opts: RunGatesOptions): Promise<GateResult> {
  const start = Date.now();
  let code: number | null = null;
  let timedOut = false;
  let stdout = "";
  let stderr = "";
  try {
    const r = await runCapture("sh", ["-c", spec.command], {
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs ?? 600_000,
      abortSignal: opts.signal,
    });
    code = r.code;
    stdout = r.stdout;
    stderr = r.stderr;
    if (r.signal === "SIGKILL") timedOut = true;
  } catch (err) {
    // A gate whose SPAWN itself throws is still an honest `failed`, but the
    // reason must survive as evidence — exit_code:null with empty tails is
    // undiagnosable ("evidence beats summaries").
    code = null;
    stderr = `gate spawn failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  const status = timedOut ? "timed_out" : code === 0 ? "passed" : "failed";
  const includeOutput = status !== "passed";
  const stdoutEvidence = includeOutput ? outputTail(stdout) : EMPTY_OUTPUT_TAIL;
  const stderrEvidence = includeOutput ? outputTail(stderr) : EMPTY_OUTPUT_TAIL;
  return GateResultSchema.parse({
    id: spec.id,
    command: spec.command,
    exit_code: code,
    status,
    duration_ms: Date.now() - start,
    required: spec.required ?? true,
    stdout_tail: stdoutEvidence.tail,
    stderr_tail: stderrEvidence.tail,
    output_truncated: stdoutEvidence.truncated || stderrEvidence.truncated,
  });
}

export async function runGates(specs: GateSpec[], opts: RunGatesOptions): Promise<GateResult[]> {
  const out: GateResult[] = [];
  for (const spec of specs) {
    // Abort between gates: remaining gates are simply not run (the attempt is
    // being cancelled; burning their full timeouts would delay the ack).
    if (opts.signal?.aborted) break;
    out.push(await runGate(spec, opts));
  }
  return out;
}

export function gatesPassed(gates: GateResult[]): boolean {
  return gates.filter((g) => g.required).every((g) => g.status === "passed");
}

const EMPTY_OUTPUT_TAIL = { tail: null, truncated: false } as const;

function outputTail(text: string): { tail: string | null; truncated: boolean } {
  const redacted = redactSecrets(text).trimEnd();
  if (!redacted) return EMPTY_OUTPUT_TAIL;
  return {
    tail: redacted.slice(-GATE_OUTPUT_TAIL_CHARS),
    truncated: redacted.length > GATE_OUTPUT_TAIL_CHARS,
  };
}
