/**
 * Codex rollout-transcript readers: the CLI's own session record
 * (`$CODEX_HOME/sessions/<Y>/<M>/<D>/rollout-*-<threadId>.jsonl`) is the
 * native machine-readable source for the observed model (route proof)
 * and the rate-window quota. One owner for rollout facts.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent } from "@claudexor/schema";

/**
 * Route proof: recover the model codex ACTUALLY ran from its own session
 * rollout file (`$CODEX_HOME/sessions/<Y>/<M>/<D>/rollout-*-<threadId>.jsonl`,
 * `turn_context.payload.model`). This is the codex CLI's OWN record — a real
 * observation, not an argv echo — so it honestly upgrades the cross-family route
 * proof to `verified` (CLAUDEXOR_BIBLE §5) for a CLI whose `--json` stream never
 * carries the model. Best-effort: any missing/ambiguous/unreadable state returns
 * null and the proof stays unobserved (safe degradation, never throws).
 */
export function codexTranscriptModel(
  codexHome: string | null | undefined,
  threadId: string | undefined,
): string | null {
  if (!threadId) return null;
  // An explicit scoped home is REQUIRED (v3.0.3 S9): falling back to the
  // operator's real ~/.codex would read native state Claudexor does not own.
  // Callers always resolve the run's CODEX_HOME; absent means unobserved.
  const home = codexHome && codexHome.trim() ? codexHome : null;
  if (!home) return null;
  const rollout = findCodexRollout(join(home, "sessions"), threadId);
  if (!rollout) return null;
  let observed: string | null = null;
  try {
    for (const line of readFileSync(rollout, "utf8").split("\n")) {
      if (!line.includes("turn_context")) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const model = (obj as { payload?: { model?: unknown } })?.payload?.model;
      // Keep the LAST turn_context, not the first: a RESUMED codex session
      // (`exec resume <id>`) accumulates multiple turns in one rollout, so the
      // observed model must reflect the most recent turn — the one the usage
      // event this is attached to actually ran — not a stale earlier turn.
      if (typeof model === "string" && model.trim()) observed = model;
    }
  } catch {
    /* unreadable rollout: stay unobserved */
  }
  return observed;
}

/**
 * Quota headroom: recover codex's OWN rate-window record from the rollout
 * (`event_msg.payload.token_count.rate_limits.{primary,secondary}`), the same
 * native machine-readable source route proof uses. Returns every window in the
 * LAST record independently. Best-effort: null on anything missing.
 */
export function codexTranscriptRateLimits(
  codexHome: string | null | undefined,
  threadId: string | undefined,
): NonNullable<HarnessEvent["quota"]> | null {
  if (!threadId) return null;
  // An explicit scoped home is REQUIRED (v3.0.3 S9): falling back to the
  // operator's real ~/.codex would read native state Claudexor does not own.
  // Callers always resolve the run's CODEX_HOME; absent means unobserved.
  const home = codexHome && codexHome.trim() ? codexHome : null;
  if (!home) return null;
  const rollout = findCodexRollout(join(home, "sessions"), threadId);
  if (!rollout) return null;
  let latest: NonNullable<HarnessEvent["quota"]> | null = null;
  try {
    for (const line of readFileSync(rollout, "utf8").split("\n")) {
      if (!line.includes("rate_limits")) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const rl = (obj as { payload?: { rate_limits?: Record<string, unknown> } })?.payload
        ?.rate_limits;
      if (!rl || typeof rl !== "object") continue;
      const constraints = Object.entries(rl).flatMap(([id, value]) => {
        if (!value || typeof value !== "object") return [];
        const w = value as Record<string, unknown>;
        const rawUsed = w["used_percent"];
        if (typeof rawUsed !== "number" || !Number.isFinite(rawUsed)) return [];
        const rawReset = w["resets_at"];
        const resetsAt =
          typeof rawReset === "number"
            ? new Date(rawReset * 1000).toISOString()
            : typeof rawReset === "string"
              ? rawReset
              : null;
        const minutes = w["window_minutes"];
        return [
          {
            id,
            label: id,
            used_ratio: Math.min(1, Math.max(0, rawUsed / 100)),
            window_seconds:
              typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
                ? minutes * 60
                : null,
            resets_at: resetsAt,
            cooldown_until: null,
          },
        ];
      });
      if (constraints.length > 0) {
        latest = {
          source: "codex_rollout",
          plan_label: null,
          subject_id: null,
          constraints,
        };
      }
    }
  } catch {
    /* unreadable rollout: no quota signal */
  }
  return latest;
}

/** Locate the rollout file whose name binds to this run's threadId (the id is unique per session). */
export function findCodexRollout(sessionsDir: string, threadId: string): string | null {
  if (!existsSync(sessionsDir)) return null;
  try {
    for (const y of listDirsDesc(sessionsDir)) {
      for (const m of listDirsDesc(join(sessionsDir, y))) {
        for (const d of listDirsDesc(join(sessionsDir, y, m))) {
          const dayDir = join(sessionsDir, y, m, d);
          const hit = readdirSync(dayDir).find((f) => f.includes(threadId) && f.endsWith(".jsonl"));
          if (hit) return join(dayDir, hit);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Subdirectory names sorted newest-first (date partitions), directories only. */
function listDirsDesc(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => {
        try {
          return statSync(join(dir, n)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  } catch {
    return [];
  }
}
