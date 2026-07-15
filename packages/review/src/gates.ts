import type { AccessProfile, GateResult, TestCommandGrant } from "@claudexor/schema";
import { GateResult as GateResultSchema } from "@claudexor/schema";
import { loadConfig } from "@claudexor/config";
import { runCapture } from "@claudexor/core";
import { canonicalProjectRoot, hashJson, redactSecrets, sha256 } from "@claudexor/util";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, relative, resolve } from "node:path";

const GATE_OUTPUT_TAIL_CHARS = 12_000;

export interface GateSpec {
  id: string;
  program: string;
  args: string[];
  cwd?: string;
  envAllowlist?: string[];
  trustRequired?: boolean;
  trustGrant?: TestCommandGrant | null;
  projectRoot?: string;
  accessProfile?: AccessProfile;
  required?: boolean;
}

export interface RunGatesOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Cancellation: checked between gates AND passed into each gate's process
   * (a cancel must not wait out a 600s gate before acknowledging). */
  signal?: AbortSignal;
}

/** Run one deterministic gate. Outcome is decided by exit code, never by parsing text. */
export async function runGate(spec: GateSpec, opts: RunGatesOptions): Promise<GateResult> {
  const start = Date.now();
  let code: number | null = null;
  let timedOut = false;
  let stdout = "";
  let stderr = "";
  const command = JSON.stringify([spec.program, ...spec.args]);
  try {
    const cwd = commandCwd(opts.cwd, spec.cwd);
    const env = commandEnv(spec.envAllowlist ?? [], opts.env);
    if (spec.trustRequired) verifyExternalGrant(spec, cwd, env);
    const r = await runCapture(spec.program, spec.args, {
      cwd,
      env,
      inheritEnv: "clean",
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
    command,
    exit_code: code,
    status,
    duration_ms: Date.now() - start,
    required: spec.required ?? true,
    stdout_tail: stdoutEvidence.tail,
    stderr_tail: stderrEvidence.tail,
    output_truncated: stdoutEvidence.truncated || stderrEvidence.truncated,
  });
}

/** Exact external-grant verification for versioned project commands. A repo
 * can request argv, but cannot grant execution authority to itself. */
function verifyExternalGrant(spec: GateSpec, cwd: string, env: Record<string, string>): void {
  const grant = spec.trustGrant;
  if (!grant) throw new Error("versioned project gate has no external trust grant");
  const invocation = {
    program: spec.program,
    args: spec.args,
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    envAllowlist: spec.envAllowlist ?? [],
  };
  const projectRoot = spec.projectRoot;
  if (!projectRoot || !spec.accessProfile) {
    throw new Error("versioned project gate is missing its current project context");
  }
  const currentConfig = loadConfig(projectRoot);
  if (
    grant.projectDigest !== sha256(canonicalProjectRoot(projectRoot)) ||
    grant.configDigest !== hashJson(currentConfig.project) ||
    grant.commandDigest !== hashJson(invocation) ||
    grant.accessProfile !== spec.accessProfile
  ) {
    throw new Error("versioned project gate trust grant does not match its current context");
  }
  const executablePath = resolveExecutable(spec.program, cwd, env["PATH"] ?? process.env.PATH);
  if (
    executablePath !== grant.executablePath ||
    fileDigest(executablePath) !== grant.executableDigest
  ) {
    throw new Error("versioned project gate executable changed since it was granted");
  }
  const scriptPath = resolveScript(spec.program, spec.args, cwd);
  const scriptDigest = scriptPath ? fileDigest(scriptPath) : null;
  // commandDigest binds the exact relative/absolute argv. A fresh verifier
  // intentionally resolves that same relative script inside another worktree,
  // so the absolute evidence path may differ while the script digest must not.
  if (
    (scriptPath === null) !== (grant.scriptPath === null) ||
    scriptDigest !== grant.scriptDigest
  ) {
    throw new Error("versioned project gate script changed since it was granted");
  }
}

function resolveExecutable(program: string, cwd: string, pathValue?: string): string {
  const candidates = program.includes("/")
    ? [isAbsolute(program) ? program : resolve(cwd, program)]
    : (pathValue ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((entry) => resolve(entry, program));
  const found = candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  if (!found) throw new Error(`cannot resolve gate executable ${program}`);
  return realpathSync(found);
}

function resolveScript(program: string, args: string[], cwd: string): string | null {
  if (["pnpm", "npm", "yarn", "bun"].includes(program.split(/[\\/]/).at(-1) ?? "")) {
    const packageJson = resolve(cwd, "package.json");
    if (existsSync(packageJson) && statSync(packageJson).isFile()) return realpathSync(packageJson);
  }
  const candidate = args.find((arg) => !arg.startsWith("-"));
  if (!candidate) return null;
  const path = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
  return existsSync(path) && statSync(path).isFile() ? realpathSync(path) : null;
}

function fileDigest(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function commandCwd(root: string, requested?: string): string {
  if (!requested) return root;
  if (isAbsolute(requested)) throw new Error("gate cwd must be project-relative");
  const resolved = resolve(root, requested);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("gate cwd escapes the project root");
  }
  return resolved;
}

function commandEnv(
  allowlist: string[],
  overrides: Record<string, string> | undefined,
): Record<string, string> {
  const env: Record<string, string> = { ...(overrides ?? {}) };
  for (const name of allowlist) {
    if (/(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE|CREDENTIAL)/i.test(name)) {
      throw new Error(`gate env allowlist refuses sensitive name ${name}`);
    }
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
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

/** Build the exact record an explicit user-level trust surface persists. */
export function buildTestCommandGrant(
  invocation: Pick<GateSpec, "program" | "args" | "cwd" | "envAllowlist">,
  projectRoot: string,
  accessProfile: AccessProfile,
): TestCommandGrant {
  const cwd = commandCwd(projectRoot, invocation.cwd);
  const executablePath = resolveExecutable(invocation.program, cwd, process.env.PATH);
  const scriptPath = resolveScript(invocation.program, invocation.args, cwd);
  const currentConfig = loadConfig(projectRoot);
  return {
    projectDigest: sha256(canonicalProjectRoot(projectRoot)),
    configDigest: hashJson(currentConfig.project),
    commandDigest: hashJson({
      program: invocation.program,
      args: invocation.args,
      ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
      envAllowlist: invocation.envAllowlist ?? [],
    }),
    executablePath,
    executableDigest: fileDigest(executablePath),
    scriptPath,
    scriptDigest: scriptPath ? fileDigest(scriptPath) : null,
    accessProfile,
  };
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
