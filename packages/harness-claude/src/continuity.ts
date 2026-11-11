/**
 * Claude Code session continuity (locate / move / typed rejection).
 *
 * A Claude session is one transcript `<store>/projects/<enc(cwd)>/<sid>.jsonl`
 * plus the sibling `<sid>/` directory (spilled `tool-results/`, `subagents/`).
 * The store is the Claudexor-owned `CLAUDE_CONFIG_DIR`: a registered profile's
 * `isolation_locator` (named by the engine under the neutral
 * `CLAUDEXOR_PROFILE_LOCATOR` key) or the default native store. Transcripts
 * carry no account binding, so a move is a verified copy into the target
 * account's store at the project dir of the cwd the child will use, then the
 * retirement of the source — never `.claude.json`, never credentials.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  CONTINUITY_PROFILE_LOCATOR_ENV,
  type EnvMap,
  type HarnessContinuityCapability,
  type NativeSessionFormatEvidence,
} from "@claudexor/core";
import { claudeNativeEnv } from "./index.js";
import { canonicalProfileConfigDir } from "./profile.js";

/** Claude Code's project-dir encoding of a working directory (every non-alphanumeric → `-`). */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** The store the engine named (profile locator) or the default native store. */
export function claudeStoreDir(env: EnvMap): string {
  const locator = env[CONTINUITY_PROFILE_LOCATOR_ENV];
  if (typeof locator === "string" && locator.trim()) return canonicalProfileConfigDir(locator);
  return String(claudeNativeEnv(env).CLAUDE_CONFIG_DIR);
}

function transcriptCandidates(store: string, sid: string, cwd: string): string[] {
  const projects = join(store, "projects");
  const out: string[] = [];
  const preferred = join(projects, claudeProjectDirName(cwd), `${sid}.jsonl`);
  if (existsSync(preferred)) out.push(preferred);
  if (!existsSync(projects)) return out;
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${sid}.jsonl`);
    if (file !== preferred && existsSync(file)) out.push(file);
  }
  return out;
}

export const claudeContinuity: HarnessContinuityCapability = {
  async locate(ref, env) {
    const found = transcriptCandidates(claudeStoreDir(env), ref.nativeSessionId, ref.cwd)
      .map((file) => ({ file, mtimeMs: statSync(file).mtimeMs }))
      // Newest wins on a tie (a session resumed under another cwd writes there).
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (!found) return { found: false };
    const sidecar = join(found.file.slice(0, -".jsonl".length));
    return {
      found: true,
      file: found.file,
      mtimeMs: found.mtimeMs,
      sidecars: existsSync(sidecar) && statSync(sidecar).isDirectory() ? [sidecar] : [],
    };
  },

  async move(located, _fromEnv, toEnv, targetCwd) {
    const sid = located.nativeSessionId ?? basename(located.file, ".jsonl");
    const targetDir = join(claudeStoreDir(toEnv), "projects", claudeProjectDirName(targetCwd));
    const dest = join(targetDir, `${sid}.jsonl`);
    if (dest === located.file) return { ok: true, resumeRef: { nativeSessionId: sid } };
    const copied: string[] = [];
    try {
      mkdirSync(targetDir, { recursive: true });
      copied.push(dest);
      copyFileSync(located.file, dest);
      if (statSync(dest).size !== statSync(located.file).size)
        throw new Error("transcript copy size mismatch");
      for (const sidecar of located.sidecars) {
        const destDir = join(targetDir, basename(sidecar));
        copied.push(destDir);
        cpSync(sidecar, destDir, { recursive: true });
        if (!existsSync(destDir)) throw new Error("sidecar copy missing");
      }
    } catch (err) {
      for (const dest of copied) rmSync(dest, { recursive: true, force: true });
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    // The engine publishes the destination holder before invoking retirement.
    return {
      ok: true,
      resumeRef: { nativeSessionId: sid },
      retire() {
        rmSync(located.file, { force: true });
        for (const sidecar of located.sidecars) rmSync(sidecar, { recursive: true, force: true });
      },
    };
  },

  /** Only asked on a resumed try. API 400 rejects the carried request;
   * a failed CLI exit can also report the documented missing-session diagnostic.
   * This is vendor stderr, never model prose or a generic execution failure. */
  rejectsCarriedState(ev) {
    if (ev.type === "error") return ev.payload?.["api_error_status"] === 400;
    if (ev.type !== "completed") return false;
    const exitCode = ev.payload?.["exit_code"];
    const failed =
      ev.payload?.["harness_reported_error"] === true ||
      (typeof exitCode === "number" && exitCode > 0);
    const stderr = ev.payload?.["stderr_tail"];
    return (
      failed &&
      typeof stderr === "string" &&
      stderr
        .split(/\r?\n/)
        .some((line) =>
          /^No conversation found with session ID: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            line.trim(),
          ),
        )
    );
  },
};

/** One recorded session of 2.1.316 on Darwin: its transcript and the spilled tool
 * output beside it. Its subagents, file history, todos, debug log and task state
 * were absent, so a session holding those, or on another host, is not proven by it. */
const CLAUDE_SESSION_EVIDENCE: NativeSessionFormatEvidence = {
  fixture: "packages/harness-claude/fixtures/native-session/2.1.316",
  vendorVersions: ["2.1.316"],
  platforms: ["darwin"],
  transcriptOf(rel, id) {
    const [top, cwd, name, kind, file, ...deeper] = rel.split("/");
    if (top !== "projects" || !cwd || !name) return null;
    const transcript = `projects/${cwd}/${id}.jsonl`;
    if (rel === transcript) return transcript;
    return name === id && kind === "tool-results" && file && deeper.length === 0
      ? transcript
      : null;
  },
  versionField: "version",
};

/** Native persistence is owned together with this adapter's resume contract. */
export const claudePersistence = {
  continuity: claudeContinuity,
  nativeSessionExport: {
    storeRoot: claudeStoreDir,
    // Matched by the exact session id. A recording proves which of these it saw.
    sessionLocations: {
      projects: 2,
      "file-history": 1,
      todos: 1,
      debug: 1,
      "session-env": 1,
      tasks: 1,
    },
    laneCredentialStores: [".claude/.credentials.json", ".claude/.claude.json", ".claude.json"],
    formatEvidence: CLAUDE_SESSION_EVIDENCE,
    // Not this session's transcript parts or sidecars, so outside its closure;
    // whatever its own transcript names in the store is required, and blocks.
    outOfClosure: [
      {
        source: "history.jsonl",
        reason:
          "account-wide prompt log shared by every session, not a part of this one; reading it would read other sessions, so its relation to this session is unknown and it is not exported",
      },
      {
        source: "plans, shell-snapshots",
        reason:
          "not named by session id, so never read; one this session's own transcript names in the store is not carried and blocks retirement",
      },
      {
        source: "paths outside the store",
        reason:
          "project files and temporary output a transcript names are not session material and are never followed",
      },
    ],
  },
  nativeHomeLifetime: {
    status: "not_pruned" as const,
    reason:
      "The Claude CLI owns transcript expiry; independent pruning of its session sidecars is not proven safe.",
  },
};
