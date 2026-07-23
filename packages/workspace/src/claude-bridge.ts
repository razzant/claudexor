import { closeSync, existsSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * D-14 layer 3 (AGENTS.md unification) — the thin `CLAUDE.md` bridge.
 *
 * Codex, Cursor, and OpenCode read a project's `AGENTS.md` natively; Claude Code
 * reads `CLAUDE.md`. When a project standardizes on ONE `AGENTS.md`, Claudexor
 * bridges the gap so a Claude Code route sees the same instructions — by writing
 * a thin `CLAUDE.md` whose body is the official Anthropic import form
 * (`@AGENTS.md`) plus a Claudexor ownership marker. This is the ONE enumerated
 * live-tree mutation path this feature adds (ARCHITECTURE §Live-tree mutation
 * paths #7, Bible INV-113); the orchestrator announces every create via a typed
 * `project.claude_bridge.created` run event, exactly as `git init` announces
 * `project.git.initialized`.
 *
 * Fences (mirroring the automatic git-init boundary):
 *   - it acts ONLY when the project root has `AGENTS.md` and no `CLAUDE.md`;
 *   - the create is EXCLUSIVE (`O_CREAT|O_EXCL`, the Node `wx` flag): a
 *     hand-written `CLAUDE.md` — or one a racing prep just wrote — is NEVER
 *     overwritten;
 *   - it is NO-FOLLOW: anything already occupying the path (a regular file, a
 *     symlink — even a dangling one — or a directory) is refused, so the bridge
 *     can never clobber or write through a link;
 *   - it is IDEMPOTENT: a second (or concurrent) run finds the file and does
 *     nothing, so at most one file and one event ever result.
 */

/** The exact bytes written into a generated `CLAUDE.md`. */
export const CLAUDE_BRIDGE_MARKER =
  "claudexor:generated claude-bridge v1 — safe to edit; delete to stop bridging";
export const CLAUDE_BRIDGE_CONTENT = `@AGENTS.md\n\n<!-- ${CLAUDE_BRIDGE_MARKER} -->\n`;

export type ClaudeBridgeReason =
  /** No `AGENTS.md` at the project root — nothing to bridge to. */
  | "no_agents"
  /** A `CLAUDE.md` (file, symlink, or directory) already exists — never touched. */
  | "claude_exists"
  /** Lost an exclusive-create race to a concurrent prep — the other prep created it. */
  | "race_lost"
  /** This call created the bridge file. */
  | "created";

export interface ClaudeBridgeResult {
  /** True only when THIS call created the file (the single event trigger). */
  created: boolean;
  /** Absolute path of the (would-be) `CLAUDE.md`. */
  path: string;
  reason: ClaudeBridgeReason;
}

/**
 * Create the thin `CLAUDE.md` bridge at `projectRoot` when — and only when — the
 * root has `AGENTS.md` and no `CLAUDE.md`. Returns what happened; `created` is
 * true for exactly one caller across any number of concurrent invocations. The
 * caller (orchestrator run prep) restricts this to write-mode, non-in-place,
 * real-project runs and targets the PROJECT root (never a worktree envelope).
 */
export function ensureClaudeBridge(projectRoot: string): ClaudeBridgeResult {
  const agentsPath = join(projectRoot, "AGENTS.md");
  const claudePath = join(projectRoot, "CLAUDE.md");

  // Only bridge when AGENTS.md is present as the source of truth.
  if (!existsSync(agentsPath)) return { created: false, path: claudePath, reason: "no_agents" };

  // No-follow refusal: lstat does NOT dereference the final component, so a
  // symlink named CLAUDE.md (valid OR dangling), a regular file, or a directory
  // all surface here and are left untouched. ENOENT means the path is free.
  try {
    lstatSync(claudePath);
    return { created: false, path: claudePath, reason: "claude_exists" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // Exclusive create is the atomic race fence: `wx` opens with O_CREAT|O_EXCL, so
  // if any path (including a symlink) appears between the lstat above and this
  // open, the open fails EEXIST and we DO NOT overwrite. Exactly one concurrent
  // prep wins; the losers report `race_lost` and emit no event.
  let fd: number;
  try {
    fd = openSync(claudePath, "wx", 0o644);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST")
      return { created: false, path: claudePath, reason: "race_lost" };
    throw err;
  }
  try {
    writeSync(fd, CLAUDE_BRIDGE_CONTENT);
  } finally {
    closeSync(fd);
  }
  return { created: true, path: claudePath, reason: "created" };
}

/** The `CLAUDE.md` basename a diff-capture exclude targets. */
export const CLAUDE_BRIDGE_BASENAME = "CLAUDE.md";

/** The generated bridge as raw bytes, for exact-content comparison. */
const CLAUDE_BRIDGE_CONTENT_BYTES = Buffer.from(CLAUDE_BRIDGE_CONTENT, "utf8");

/**
 * True when `<worktreeRoot>/CLAUDE.md` is an UNMODIFIED Claudexor-generated
 * bridge — i.e. its bytes are EXACTLY `CLAUDE_BRIDGE_CONTENT`. Diff capture uses
 * this to exclude exactly the pristine generated bridge (and only it) from an
 * envelope candidate's patch, so the bridge written into a disposable envelope
 * tree never pollutes `patch.diff`.
 *
 * A-3: the decision is BYTE-EQUALITY, not marker substring. A substring check
 * silently dropped a candidate that EDITED `CLAUDE.md` while keeping the marker
 * comment (real work lost from `patch.diff`). Any candidate edit — even one that
 * retains the marker, or only appends to the bridge — now differs from the exact
 * bytes and is captured in the diff like any other real change. Only the pristine
 * generated file (which the candidate never touched) is excluded. A hand-written
 * `CLAUDE.md` cannot match these exact bytes either. A symlink at the path is
 * refused (no-follow), matching the writer's fence.
 */
export function isGeneratedClaudeBridge(worktreeRoot: string): boolean {
  const claudePath = join(worktreeRoot, CLAUDE_BRIDGE_BASENAME);
  try {
    if (lstatSync(claudePath).isSymbolicLink()) return false;
    return readFileSync(claudePath).equals(CLAUDE_BRIDGE_CONTENT_BYTES);
  } catch {
    return false;
  }
}
