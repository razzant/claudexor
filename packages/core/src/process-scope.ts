/**
 * Scope markers: the one environment-based custody identity every process
 * started for a piece of work inherits for its whole life.
 *
 * A marker is an environment entry `NAME=1` whose NAME carries a random
 * 128-bit hex id (never a path: on macOS `ps -E` mixes argv into the
 * environment column, so a path-shaped marker could match a stranger's
 * arguments). A process inherits every marker of its ancestors; a scope ends
 * by enumerating live processes that still carry its marker from kernel state
 * and ending them by measured identity (`process-scope-census.ts`).
 *
 * Shared grammar (Claudexor + the embedding host): `^[A-Z][A-Z0-9_]*_SCOPE_[0-9a-f]{32}$`.
 * Roles are different prefixes of that one shape — `CLAUDEXOR_RUN_SCOPE_` is
 * one per Claudexor RUN; a host may carry its own longer-lived markers (an
 * installation scope) through the same grammar without Claudexor knowing it.
 * Inheritance is not a lifetime transfer: a process handed to a longer-lived
 * custodian sheds the shorter-lived markers at its spawn env.
 */
import { randomBytes } from "node:crypto";

/** The one shared marker grammar; the value is always exactly `1`. */
export const SCOPE_MARKER_NAME = /^[A-Z][A-Z0-9_]*_SCOPE_[0-9a-f]{32}$/;
export const SCOPE_MARKER_VALUE = "1";

/** Prefix of a Claudexor per-run marker (one per run, minted before the first launch). */
export const RUN_SCOPE_MARKER_PREFIX = "CLAUDEXOR_RUN_SCOPE_";

export function isScopeMarkerName(name: string): boolean {
  return SCOPE_MARKER_NAME.test(name);
}

export function isRunScopeMarkerName(name: string): boolean {
  return name.startsWith(RUN_SCOPE_MARKER_PREFIX) && isScopeMarkerName(name);
}

/** Mint a fresh run marker NAME (32 random hex digits; the value is `1`). */
export function mintRunScopeMarker(): string {
  return `${RUN_SCOPE_MARKER_PREFIX}${randomBytes(16).toString("hex")}`;
}

/** The env patch that plants one marker on a child. */
export function scopeMarkerEnv(marker: string): Record<string, string> {
  if (!isScopeMarkerName(marker)) throw new Error("scope marker name does not match the grammar");
  return { [marker]: SCOPE_MARKER_VALUE };
}

/**
 * Every marker the given environment carries (name matches the grammar AND
 * the value is exactly `1`). Used to forward enclosing custody through a
 * `clean` child env: the host's longer-lived markers must reach a harness no
 * matter how its env is composed, or the host cannot end what it owns.
 */
export function inheritedScopeMarkers(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === SCOPE_MARKER_VALUE && isScopeMarkerName(key)) out[key] = value;
  }
  return out;
}

/** `env` without Claudexor per-run markers: the spawn env of a process handed
 * to a longer-lived custodian. Every other marker, an enclosing host's
 * included, is kept. */
export function withoutRunScopeMarkers<V>(env: Record<string, V>): Record<string, V> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isRunScopeMarkerName(name)));
}

/** The run scope marker NAME carried by a composed spawn env, if any (never its value). */
export function runScopeMarkerOf(env: NodeJS.ProcessEnv): string | undefined {
  return Object.keys(env).find((key) => isRunScopeMarkerName(key) && env[key] === "1");
}
