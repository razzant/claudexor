/**
 * Codex session continuity (locate / move / typed rejection).
 *
 * A Codex thread is a rollout `sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`
 * under `CODEX_HOME`, possibly with paginated parts (`.jsonl.zst`). The vendor's
 * own fallback lookup finds it by FILENAME (no DB row needed), so does this
 * locator — including the `.zst` parts today's transcript reader misses. The
 * store is the Claudexor-owned `CODEX_HOME`: a registered profile's
 * `isolation_locator` (named by the engine under the neutral
 * `CLAUDEXOR_PROFILE_LOCATOR` key) or the default native home. A move copies
 * every part to the SAME relative path under the target home, verifies, then
 * retires the sources — never `auth.json`, never credentials. Location and copy
 * share the transcript readers' boundary (`rollout-file.ts`): a part that is a
 * link or lies below one is still located, and a move refuses it typed.
 */
import { lstatSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  CONTINUITY_PROFILE_LOCATOR_ENV,
  type EnvMap,
  type HarnessContinuityCapability,
} from "@claudexor/core";
import { defaultNativeCodexHome } from "./auth.js";
import { canonicalCodexProfileHome } from "./profile.js";
import { codexRolloutParts, copyCodexRolloutPart, rolloutLogicalPart } from "./rollout-file.js";

/** The vendor's own code for a rejected carried reasoning item (its CLI sniffs the same token). */
const CARRIED_STATE_REJECTIONS = ["invalid_encrypted_content", "Request blocked."];

/** The home the engine named (profile locator) or the default native home. */
export function codexStoreHome(env: EnvMap): string {
  const locator = env[CONTINUITY_PROFILE_LOCATOR_ENV];
  if (typeof locator === "string" && locator.trim()) return canonicalCodexProfileHome(locator);
  return defaultNativeCodexHome(env);
}

export const codexContinuity: HarnessContinuityCapability = {
  async locate(ref, env) {
    const parts = codexRolloutParts(codexStoreHome(env), ref.nativeSessionId).map((p) => p.path);
    if (parts.length === 0) return { found: false };
    // The holder is the newest logical part, as its `.jsonl` sibling when it has
    // one; every part, compressed history included, is still a sidecar to move.
    const newest = rolloutLogicalPart(parts[0]!);
    const file = parts.includes(newest) ? newest : parts[0]!;
    return {
      found: true,
      file,
      mtimeMs: Math.max(...parts.map((part) => lstatSync(part).mtimeMs)),
      sidecars: parts.filter((part) => part !== file),
    };
  },

  async move(located, fromEnv, toEnv, _targetCwd) {
    const fromHome = codexStoreHome(fromEnv);
    const toHome = codexStoreHome(toEnv);
    const sid = located.nativeSessionId ?? rolloutThreadId(located.file);
    // Two spellings of one store (the default home through a link and a
    // profile registered at its real path) are the same home; copying there
    // would write each part onto itself.
    if (sameStore(fromHome, toHome)) return { ok: true, resumeRef: { nativeSessionId: sid } };
    const sources = [located.file, ...located.sidecars];
    const copied: string[] = [];
    try {
      const fromRoot = realpathSync(fromHome);
      for (const source of sources) {
        const rel = relative(fromRoot, realpathSync(source));
        if (rel.startsWith("..") || !rel.startsWith("sessions"))
          throw new Error(`rollout part outside the source sessions dir: ${source}`);
        const dest = join(toHome, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyCodexRolloutPart(fromHome, source, dest); // removes its own partial copy
        copied.push(dest);
      }
    } catch (err) {
      for (const dest of copied) rmSync(dest, { force: true });
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    // The engine publishes the destination holder before invoking retirement.
    return {
      ok: true,
      resumeRef: { nativeSessionId: sid },
      retire() {
        for (const source of sources) rmSync(source, { force: true });
      },
    };
  },

  /** The vendor's own rejection of carried reasoning: the typed rollout code
   * when the adapter attached one, else the same code token the CLI itself
   * reports in its error text. */
  rejectsCarriedState(ev) {
    if (ev.type !== "error" && ev.type !== "completed") return false;
    const vendor = ev.payload?.["vendor_failure"] as { code?: unknown } | undefined;
    const code = typeof vendor?.code === "string" ? vendor.code : "";
    const text = typeof ev.error === "string" ? ev.error : "";
    return CARRIED_STATE_REJECTIONS.some((token) => code === token || text.includes(token));
  },
};

/** One directory by identity; a destination home that does not exist yet is another store. */
function sameStore(fromHome: string, toHome: string): boolean {
  if (fromHome === toHome) return true;
  try {
    const from = statSync(fromHome);
    const to = statSync(toHome);
    return from.dev === to.dev && from.ino === to.ino;
  } catch {
    return false;
  }
}

/** The thread id embedded in a rollout filename (`rollout-<ts>-<uuid>.jsonl[.zst]`). */
function rolloutThreadId(file: string): string {
  const name = file.slice(file.lastIndexOf("/") + 1).replace(/\.jsonl(\.zst)?$/, "");
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(name);
  return match ? match[1]! : name;
}
