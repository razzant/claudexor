import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "@claudexor/util";

/**
 * Ensure `.claudexor/.gitignore` CONTAINS `*` so the runtime dir stays
 * invisible to the project's git (the git-native trick that avoids mutating
 * the user's own .gitignore). Content-checked, not just existence-checked:
 * a user-edited or emptied file would silently re-expose envelopes, thread
 * worktrees, and seeded credentials to `git add -A`. Shared by the envelope
 * manager and the thread-worktree creator (single owner of the invariant).
 */
export function ensureSelfIgnore(claudexorDir: string): void {
  const path = join(claudexorDir, ".gitignore");
  try {
    if (readFileSync(path, "utf8").trim() === "*") return;
  } catch {
    /* missing/unreadable -> (re)write below */
  }
  ensureDir(claudexorDir);
  writeFileSync(path, "*\n");
}
