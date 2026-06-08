import type { GateResult } from "@claudexor/schema";
import { GateResult as GateResultSchema } from "@claudexor/schema";
import { runCapture } from "@claudexor/core";

export interface GateSpec {
  id: string;
  command: string;
  required?: boolean;
}

export interface RunGatesOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Run one deterministic gate. Outcome is decided by exit code, never by parsing text. */
export async function runGate(spec: GateSpec, opts: RunGatesOptions): Promise<GateResult> {
  const start = Date.now();
  let code: number | null = null;
  let timedOut = false;
  try {
    const r = await runCapture("sh", ["-c", spec.command], {
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs ?? 600_000,
    });
    code = r.code;
    if (r.signal === "SIGKILL") timedOut = true;
  } catch {
    code = null;
  }
  const status = timedOut ? "timed_out" : code === 0 ? "passed" : "failed";
  return GateResultSchema.parse({
    id: spec.id,
    command: spec.command,
    exit_code: code,
    status,
    duration_ms: Date.now() - start,
    required: spec.required ?? true,
  });
}

export async function runGates(specs: GateSpec[], opts: RunGatesOptions): Promise<GateResult[]> {
  const out: GateResult[] = [];
  for (const spec of specs) out.push(await runGate(spec, opts));
  return out;
}

/** `git apply --check` gate: does this patch apply cleanly to the repo? */
export async function patchAppliesGate(repoRoot: string, patchPath: string): Promise<GateResult> {
  return runGate({ id: "patch-applies", command: `git apply --check "${patchPath}"` }, { cwd: repoRoot });
}

export function gatesPassed(gates: GateResult[]): boolean {
  return gates.filter((g) => g.required).every((g) => g.status === "passed");
}
