/**
 * Engine/CLI version-skew evidence — the one small owner (issue #93).
 *
 * A CLI process talks to exactly one daemon connection at a time, and the
 * /v2/handshake already reports the serving engine's build identity. This
 * module keeps that fact usable at failure time:
 *
 * - `consumeHandshakeIdentity` parses the CANONICAL handshake envelope
 *   (`ControlHandshakeResponse` — never a hand-rolled partial parser),
 *   applies echo hygiene, and OVERWRITES the module-scoped skew record on
 *   every successful handshake. Long-lived MCP/ACP processes reconnect after
 *   daemon restarts, so a stale record must never annotate post-fix failures;
 *   transport absence clears the record too (daemon-run.ts).
 * - `stampEngineSkew` is called by `controlProblemError` (cli-error.ts) — the
 *   single choke point every typed control-problem projection funnels
 *   through — so a stale daemon's own typed failure (e.g. a 422
 *   config_invalid raised against a NEWER config schema) carries the observed
 *   skew as bounded typed context plus the stop remedy. With no recorded skew
 *   the fields pass through UNTOUCHED: unskewed envelopes stay byte-identical.
 *
 * Same-major skew stays ADVISORY (a0c16964/PDR-02: the protocol major is the
 * only hard fence) — this module records evidence, it never blocks.
 */
import { ControlHandshakeResponse } from "@claudexor/schema";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { daemonOwner, EXTERNAL_DAEMON_REMEDY } from "./daemon-owner.js";

/** Same-major daemon/CLI skew observed on this process's control connection. */
export interface EngineSkew {
  daemonVersion: string;
  /** Present only when the daemon reported a well-formed 40-hex build SHA. */
  daemonSha?: string;
  cliVersion: string;
}

/** The daemon's validated build identity from a successful handshake. The
 * engine version is the AUTHORITATIVE running-engine version (QA-033a): a
 * `release check` must trust this live process identity over the executing CLI
 * package constant. Null when the daemon did not report a well-formed version. */
export interface EngineIdentity {
  engineVersion: string | null;
  engineBuildSha: string | null;
  /** Product admission at handshake time (issue #165 D5). A pre-#165 daemon
   * reports nothing and is always serving normally, so absent maps to
   * `normal`; `recovery_only` means product routes are typed-closed. */
  servingMode: "normal" | "recovery_only";
}

/** The ONE remedy wording — stderr advisory and typed requiredActions speak
 * with the same voice, so it must stay CALLER-NEUTRAL: acting commands
 * (`ensureDaemon`) auto-start the CLI's own dist daemon after the stop, which
 * cannot mismatch, but read-only paths (`connectDaemonIfRunning`: bare
 * `follow`/`inspect`, the release check) never auto-start and need an
 * explicit `claudexor daemon start` (a running macOS app may still relaunch
 * its own runtime afterwards; its reconciler owns that lifecycle). */
export const ENGINE_STOP_REMEDY =
  "run `claudexor daemon stop`, then rerun — an acting command starts a matching daemon (read-only commands: run `claudexor daemon start` first)";

export function engineSkewRemedy(): string {
  return daemonOwner() === "external" ? EXTERNAL_DAEMON_REMEDY : ENGINE_STOP_REMEDY;
}

let observedSkew: EngineSkew | null = null;

/** Overwrite the recorded skew (null clears). Called on every successful
 * handshake and on transport absence — the record always reflects the LAST
 * live observation, never a daemon this process can no longer see. */
export function recordEngineSkew(skew: EngineSkew | null): void {
  observedSkew = skew;
}

/** The skew observed on this process's current connection, or null. */
export function observedEngineSkew(): EngineSkew | null {
  return observedSkew ? { ...observedSkew } : null;
}

// Echo hygiene (INV-062-adjacent): only a validated engine version/SHA may
// reach a terminal or a typed envelope — never arbitrary response text. Same
// bounds the plugin-skew check uses.
const ENGINE_VERSION_RE = /^[\w.+-]{1,32}$/;
const BUILD_SHA_RE = /^[0-9a-f]{40}$/;

export interface HandshakeIdentity {
  /** The daemon's validated build identity (QA-033a); nulls when unreported. */
  engine: EngineIdentity;
  /** Pre-formatted stderr advisory line for a same-major skew; null when the
   * daemon matches this CLI (or reported no well-formed version). */
  skewAdvisory: string | null;
}

/**
 * Consume a SUCCESSFUL (HTTP 200) handshake response body: parse the
 * canonical envelope, validate the echoed identity, and update the skew
 * record — set on a validated version mismatch, cleared otherwise (a
 * malformed body observed nothing trustworthy and clears too).
 */
export function consumeHandshakeIdentity(body: unknown): HandshakeIdentity {
  const parsed = ControlHandshakeResponse.safeParse(body);
  if (!parsed.success) {
    // Identity is advisory; a malformed body never fails the handshake.
    recordEngineSkew(null);
    return {
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
      skewAdvisory: null,
    };
  }
  const { version, sha } = parsed.data.engine;
  const servingMode = parsed.data.servingMode ?? "normal";
  const daemonVersion = ENGINE_VERSION_RE.test(version) ? version : null;
  const engineBuildSha = sha === "unknown" || BUILD_SHA_RE.test(sha) ? sha : null;
  if (daemonVersion && daemonVersion !== CLAUDEXOR_VERSION) {
    recordEngineSkew({
      daemonVersion,
      ...(engineBuildSha && engineBuildSha !== "unknown" ? { daemonSha: engineBuildSha } : {}),
      cliVersion: CLAUDEXOR_VERSION,
    });
    return {
      engine: { engineVersion: daemonVersion, engineBuildSha, servingMode },
      skewAdvisory:
        `claudexor: daemon is engine ${daemonVersion} but this CLI is ${CLAUDEXOR_VERSION}; ` +
        `${engineSkewRemedy()}\n`,
    };
  }
  recordEngineSkew(null);
  return {
    engine: { engineVersion: daemonVersion, engineBuildSha, servingMode },
    skewAdvisory: null,
  };
}

/** The typed-problem fields `stampEngineSkew` shapes — a structural mirror of
 * cli-error's CliProblemFields (deliberately NOT imported: the projector's
 * dependency graph stays acyclic and last-resort-safe). */
export interface SkewStampableFields {
  code?: string;
  retryable?: boolean;
  fieldErrors?: Record<string, string[]>;
  requiredActions?: string[];
  details?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

/**
 * Shape a typed problem's fields at the controlProblemError choke point:
 * append `appendRequiredActions` (the handshake-refusal path names the stop
 * remedy explicitly), and when a same-major skew is recorded attach
 * `context.engineSkew` plus the stop remedy. Duplicate actions are elided so
 * the remedy reads once. With nothing to add, returns `fields` UNCHANGED —
 * unskewed envelopes are byte-identical to before this fix.
 */
export function stampEngineSkew(
  fields: SkewStampableFields,
  appendRequiredActions?: string[],
): SkewStampableFields {
  const skew = observedSkew;
  const existing = fields.requiredActions ?? [];
  const appended = [...(appendRequiredActions ?? []), ...(skew ? [engineSkewRemedy()] : [])].filter(
    (action, index, all) => !existing.includes(action) && all.indexOf(action) === index,
  );
  if (!skew && appended.length === 0) return fields;
  return {
    ...fields,
    requiredActions: [...existing, ...appended],
    ...(skew ? { context: { ...(fields.context ?? {}), engineSkew: { ...skew } } } : {}),
  };
}
