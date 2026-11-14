import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { WorkspaceError } from "@claudexor/core";
import type { WorkspaceEnvelope } from "@claudexor/schema";
import { oneShotRuntimeDir, userConfigDir } from "@claudexor/util";

export interface EnvelopeRecoveryRecord {
  envelopeId: string;
  workspaceMode: "in_place" | "isolated";
  workspaceKind?: "git" | "directory";
  /** The tree Git ran in, recorded at creation (#503); absent in legacy records. */
  executionRoot?: string;
}

/** Read only the identity needed to dispose a crashed envelope. The caller
 * decides whether missing legacy data is safe to fall back from. */
export function readEnvelopeRecoveryRecord(base: string): EnvelopeRecoveryRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(base, "owner.json"), "utf8")) as {
      envelope_id?: unknown;
      workspace_mode?: unknown;
      workspace_kind?: unknown;
      execution_root?: unknown;
    };
    if (
      typeof parsed.envelope_id !== "string" ||
      (parsed.workspace_mode !== "in_place" && parsed.workspace_mode !== "isolated")
    ) {
      return null;
    }
    return {
      envelopeId: parsed.envelope_id,
      workspaceMode: parsed.workspace_mode,
      ...(parsed.workspace_kind === "directory" ? { workspaceKind: "directory" } : {}),
      ...(typeof parsed.execution_root === "string" && isAbsolute(parsed.execution_root)
        ? { executionRoot: parsed.execution_root }
        : {}),
    };
  } catch {
    return null;
  }
}

/** This process's own start time, read once: constant for its lifetime. */
let ownStartTime: string | null | undefined;

/** `ps` start time for a pid, or null when unavailable. Pid+start-time
 * equality is the recycling-proof liveness identity for envelope owners
 * (command names/titles mutate; the kernel start time never does). The
 * process's own start time is read once and remembered (null too, where `ps`
 * cannot say), so a lane start does not run `ps` on the main thread; every
 * other pid is read fresh. */
export function processStartTime(pid: number): string | null {
  if (pid === process.pid && ownStartTime !== undefined) return ownStartTime;
  let out: string | null;
  try {
    out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim();
  } catch {
    out = null;
  }
  if (out === "") out = null;
  if (pid === process.pid) ownStartTime = out;
  return out;
}

/**
 * The engine-owned runtime namespace an envelope base lives in, from its own
 * recorded path (`<runtime>/workspaces/<task>/<attempt>`): a project namespace
 * `projects/<sha256>` or the one-shot namespace (#503). Null for any other
 * path, so a caller falls back to the legacy execution-root namespace and
 * never removes anything outside an engine-owned workspaces directory.
 */
export function envelopeRuntimeRoot(base: string): string | null {
  const workspaces = dirname(dirname(base));
  if (basename(workspaces) !== "workspaces") return null;
  const runtime = dirname(workspaces);
  const projects = join(userConfigDir(), "projects");
  if (runtime === oneShotRuntimeDir()) return runtime;
  return dirname(runtime) === projects && /^[0-9a-f]{64}$/.test(basename(runtime)) ? runtime : null;
}

/**
 * The scoped envelope base for a task/attempt under `workspacesDir`: the sole
 * on-disk root dispose deletes, so the ids MUST be path-safe segments and the
 * resolved base MUST stay inside the workspaces dir (a crafted `../` id could
 * otherwise turn dispose() into an arbitrary recursive delete).
 */
export function envelopeBaseIn(workspacesDir: string, taskId: string, attemptId: string): string {
  const idPattern = /^[A-Za-z0-9._-]+$/;
  for (const [label, id] of [
    ["taskId", taskId],
    ["attemptId", attemptId],
  ] as const) {
    if (!idPattern.test(id) || id === "." || id === "..") {
      throw new WorkspaceError(`${label} '${id}' is not a safe path segment`);
    }
  }
  const base = join(workspacesDir, taskId, attemptId);
  if (!base.startsWith(workspacesDir + sep)) {
    throw new WorkspaceError(`envelope base escapes the workspaces dir: ${base}`);
  }
  return base;
}

/**
 * Where an envelope physically is: the base its own scoped HOME records, when
 * that is an engine-owned `<runtime>/workspaces/<task>/<attempt>` of exactly
 * these ids (an adopted envelope keeps its path whichever run holds it, #503);
 * else the manager's own namespace (legacy records, foreign paths).
 */
export function physicalEnvelopeBase(
  env: Pick<WorkspaceEnvelope, "home_dir" | "task_id" | "attempt_id">,
  fallbackWorkspacesDir: string,
): string {
  const recorded = dirname(env.home_dir);
  const runtime = envelopeRuntimeRoot(recorded);
  if (runtime) {
    const base = envelopeBaseIn(join(runtime, "workspaces"), env.task_id, env.attempt_id);
    if (base === recorded) return base;
  }
  return envelopeBaseIn(fallbackWorkspacesDir, env.task_id, env.attempt_id);
}
