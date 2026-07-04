/**
 * Run-start normalization (single owner): both entry paths — the HTTP control
 * API and the daemon socket runner — MUST use these so scope/secret/
 * absolute-root acceptance can never drift between surfaces. Split from
 * daemon-server.ts (INV-124 ratchet).
 */
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ControlRunStartRequest } from "@claudexor/schema";
import { assertNoInlineSecretValues, noProjectRepoRoot } from "@claudexor/util";

const NO_PROJECT_ROOT = noProjectRepoRoot();

export function validateAbsoluteRepoRoot(repoRoot: string): string | null {
  return isAbsolute(repoRoot) ? null : "project root must be an absolute path";
}

/** Direct /runs attachments are path-only: inline bytes ride thread turns. */
export function validateDirectRunAttachments<T extends ControlRunStartRequest & { turnId?: string }>(params: T): T {
  if (!params.attachments || params.attachments.length === 0) return params;
  const attachments = params.attachments.map((att, index) => {
    const hasData = typeof att.data === "string" && att.data.length > 0;
    const path = typeof att.path === "string" ? att.path.trim() : "";
    const hasPath = path.length > 0;
    if (hasData) {
      throw Object.assign(
        new Error("inline attachment data is only accepted through thread turns; direct /runs enqueue requires path-only attachments"),
        { status: 400 },
      );
    }
    if (!hasPath) {
      throw Object.assign(new Error(`attachments[${index}].path must be a non-empty absolute file path`), { status: 400 });
    }
    if (!isAbsolute(path)) {
      throw Object.assign(new Error(`attachments[${index}].path must be absolute: ${path}`), { status: 400 });
    }
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw Object.assign(new Error(`attachments[${index}].path does not exist or is not a file: ${path}`), { status: 400 });
    }
    const { data: _data, ...rest } = att;
    return { ...rest, path };
  });
  return { ...params, attachments };
}

export function normalizeRunStart(parsed: ControlRunStartRequest): ControlRunStartRequest {
  const specPath = parsed.specPath?.trim();
  const mode = parsed.mode ?? "agent";
  // Empty chat is never a silent no-op (Bible): reject a blank prompt at the
  // engine boundary unless a frozen spec FILE (specPath) supplies the intent.
  // A bare specId does not load spec content at enqueue time, so it is not a
  // valid substitute for the prompt. Fail loud (400) rather than enqueue a
  // doomed run that produces nothing.
  if (parsed.prompt.trim().length === 0 && !specPath) {
    throw Object.assign(new Error("prompt must not be empty (provide a prompt or a frozen specPath)"), { status: 400 });
  }
  // maxToolCalls caps the orchestrate EXECUTOR's plan steps; accepting it on
  // any other mode would create a silent no-op knob (INV-023).
  if (parsed.maxToolCalls !== undefined && mode !== "orchestrate") {
    throw Object.assign(
      new Error("maxToolCalls only applies to mode=orchestrate (it caps the executor's plan steps)"),
      { status: 400 },
    );
  }
  if (specPath && specPath !== parsed.specPath) parsed = { ...parsed, specPath };
  // Validate BEFORE enqueue (ARCHITECTURE §5): a contradictory web policy must
  // 400 here, not persist a doomed job for the orchestrator to reject later.
  if (parsed.web && parsed.externalContextPolicy && parsed.web !== parsed.externalContextPolicy) {
    throw Object.assign(
      new Error(`contradictory web policy: web='${parsed.web}' vs externalContextPolicy='${parsed.externalContextPolicy}' (pass one, or equal values)`),
      { status: 400 },
    );
  }
  // Live (in-place) isolation runs the harness directly in the execution tree
  // (the live project for an in-place thread, or the thread's worktree for an
  // isolated thread; also CLI convergence --in-place). It is an agent-only
  // concept — read-only modes have nothing to mutate; accepting it elsewhere
  // would silently run an envelope while claiming live semantics.
  if (parsed.execution?.isolation === "live" && mode !== "agent") {
    throw Object.assign(
      new Error(`execution.isolation='live' is only supported for agent runs, not '${mode}'`),
      { status: 400 },
    );
  }
  if (parsed.scope.kind === "project") {
    const repoRoot = parsed.scope.root.trim();
    const absoluteRepoError = validateAbsoluteRepoRoot(repoRoot);
    if (absoluteRepoError) throw Object.assign(new Error(absoluteRepoError), { status: 400 });
    // Existence is the only filesystem precondition here: a NON-GIT folder is
    // fine — write modes initialize the git boundary themselves (announced via
    // the project.git.initialized run event).
    if (!existsSync(repoRoot) || !lstatSync(repoRoot).isDirectory()) {
      throw Object.assign(new Error(`project root does not exist or is not a directory: ${repoRoot}`), { status: 400 });
    }
    return { ...parsed, scope: { kind: "project", root: repoRoot, context: parsed.scope.context ?? "auto" } };
  }
  if (mode === "ask") {
    mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
    return parsed;
  }
  throw Object.assign(new Error(`project scope is required for mode '${mode}'`), { status: 400 });
}

/**
 * Single owner of run-start normalization. Both entry paths (HTTP control API
 * and the daemon socket runner) MUST use this so scope/secret/absolute-root
 * acceptance can never drift between surfaces.
 */
export function normalizeRunStartRequest(raw: unknown): ControlRunStartRequest {
  assertNoInlineSecretValues(raw);
  return normalizeRunStart(ControlRunStartRequest.parse(raw ?? {}));
}
