/**
 * Session capsule (A5): ONE durable record per attempt of the native vendor
 * session — `attempts/<attemptId>/session-capsule.json` under the run dir.
 *
 * Written by the orchestrator when `started` reports a native session id (every
 * try, every envelope kind, standalone runs included — the daemon's thread
 * callback is not standalone persistence), re-located after the try settles
 * (the vendor may write the history file after `started`) and refreshed after
 * a move. The holder is the concrete file the adapter's `locate` found; a
 * session has one holder at a time. Readers: the in-run continuation loop,
 * the `continueFrom` run chain and the thread store's projection.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionCapsule, type CredentialProfile } from "@claudexor/schema";
import {
  CONTINUITY_PROFILE_LOCATOR_ENV,
  type EnvMap,
  type HarnessContinuityCapability,
} from "@claudexor/core";

export const SESSION_CAPSULE_FILE = "session-capsule.json";

export function sessionCapsulePath(attemptDir: string): string {
  return join(attemptDir, SESSION_CAPSULE_FILE);
}

/** Atomic-enough write (temp + rename is overkill for a one-line JSON; a torn
 * write fails `readSessionCapsule`'s parse and reads as "no capsule"). */
export function writeSessionCapsule(attemptDir: string, capsule: SessionCapsule): void {
  const path = sessionCapsulePath(attemptDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(SessionCapsule.parse(capsule), null, 2) + "\n");
}

export { readSessionCapsule } from "@claudexor/workspace";

/**
 * The EnvMap the adapter's `locate`/`move` resolve a store from: the child's
 * spec env plus the registry locator of the profile that holds the session.
 * The engine names the row's `isolation_locator` under ONE neutral key; the
 * adapter maps it onto its vendor variable (INV-135, no vendor paths here).
 */
export function storeEnvFor(
  specEnv: Record<string, string> | undefined,
  profile: Pick<CredentialProfile, "isolation_locator"> | null | undefined,
): EnvMap {
  const locator = profile?.isolation_locator ?? null;
  return {
    ...(specEnv ?? {}),
    ...(locator ? { [CONTINUITY_PROFILE_LOCATOR_ENV]: locator } : {}),
  };
}

/** History belongs to a harness/profile pair, even when its holder is disabled. */
export function registryProfile(
  registry: readonly CredentialProfile[],
  profileId: string | null,
  harnessId: string,
): CredentialProfile | null {
  if (profileId === null) return null;
  return (
    registry.find((row) => row.profile_id === profileId && row.harness_id === harnessId) ?? null
  );
}

/**
 * Re-locate the capsule's holder file through the adapter (best-effort I/O).
 * A located file refreshes `file`/`mtimeMs`/`sidecars`; a miss leaves the
 * capsule as it was (a resume by id; only adapters with `continuity` have the
 * engine compare the resumed session id). Never throws.
 */
export async function relocateSessionCapsule(
  capsule: SessionCapsule,
  continuity: HarnessContinuityCapability | undefined,
  env: EnvMap,
): Promise<{ capsule: SessionCapsule; located: boolean | null }> {
  if (!continuity) return { capsule, located: null };
  try {
    const found = await continuity.locate(
      { nativeSessionId: capsule.nativeSessionId, cwd: capsule.cwd },
      env,
    );
    if (!found.found) return { capsule, located: false };
    return {
      capsule: {
        ...capsule,
        file: found.file,
        mtimeMs: found.mtimeMs,
        sidecars: found.sidecars,
      },
      located: true,
    };
  } catch {
    return { capsule, located: false };
  }
}
