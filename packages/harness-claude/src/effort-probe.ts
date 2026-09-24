/**
 * Effort discovery for the INSTALLED claude CLI.
 *
 * Claude Code's effort ladder is a property of the binary on this machine, not
 * of Claudexor: 2.1.89 advertises `low, medium, high, max` while 2.1.165
 * advertises `low, medium, high, xhigh, max`. Hardcoding either one means one
 * installed version gets silently clamped, which is exactly the defect this
 * replaces. So we read the ladder out of the binary's own `--help`.
 *
 * The help line looks like:
 *   --effort <level>   Effort level for the current session (low, medium, high, xhigh, max)
 * with the parenthesized list possibly wrapped onto following lines — and HOW FAR
 * it wraps depends on the terminal width, so the parse reads the flag's whole
 * block rather than a fixed number of lines.
 *
 * On a missing binary, an unparseable help text, or a `--help` that stops
 * documenting the values, the recorded snapshot fills in and the run proceeds.
 */
import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { EffortHint } from "@claudexor/schema";
import { normalizeEffort, resolveEffort, runCapture } from "@claudexor/core";
import { nowIso, redactSecrets } from "@claudexor/util";
import { CLAUDE_VENDOR_CLI_VERSION } from "./vendor-cli-version.js";

export const BIN = process.env.CLAUDEXOR_CLAUDE_BIN || "claude";

/**
 * Recorded fallback, captured from `claude --help` on the CLI version stamped
 * below (2.1.280 retains the full low/medium/high/xhigh/max ladder unchanged
 * from 2.1.261 — re-read from the 2.1.280 binary, not carried over). Used ONLY
 * when the live parse cannot answer.
 */
export const CLAUDE_EFFORT_SNAPSHOT: readonly EffortHint[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Vendor CLI version `CLAUDE_EFFORT_SNAPSHOT` was captured from. Aliases the
 * per-package vendor-version SSOT (vendor-cli-version.ts), the same constant
 * the remote installer pins — bumping the pin without re-recording this
 * snapshot is a lie the alias makes impossible to tell twice. */
export const CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST: string = CLAUDE_VENDOR_CLI_VERSION;

/**
 * Whether the recorded snapshot may be TRUSTED for arg emission against the
 * installed binary (INV-105). The snapshot is another `--help`'s recorded
 * answer, so it is only that binary's truth on the exact CLI version it was
 * captured from: 2.1.165 advertises `xhigh`, 2.1.89 rejects it, and a 2.1.89
 * install whose live parse failed used to be handed the 2.1.165 ladder anyway
 * — `--effort xhigh` then went to a CLI that refuses the flag.
 *
 * The installed version string is whatever `claude --version` printed
 * (e.g. `2.1.280 (Claude Code)`), so the comparison extracts the full dotted
 * numeric token and requires it to EQUAL the snapshot stamp exactly. An
 * unknown or unparseable version can never vouch for the snapshot.
 */
export function claudeSnapshotTrustedForVersion(installedVersion: string | null): boolean {
  if (installedVersion === null) return false;
  const token = installedVersion.match(/\d+(?:\.\d+)+/);
  return token !== null && token[0] === CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST;
}

/**
 * The effort ladder the RUN may resolve `--effort` against, version-gating
 * snapshot trust (INV-105):
 *
 * - a LIVE parse is the installed binary's own answer — trusted on any version;
 * - the snapshot FALLBACK is trusted only when the installed version equals
 *   `CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST` (same binary, same ladder);
 * - a fallback on ANY OTHER version (mismatch, unknown, unparseable) yields an
 *   EMPTY ladder: the normalizer then sends no `--effort` flag at all, and the
 *   existing drop seam (`claudeEffortIgnoredEvent`) discloses it — the run
 *   proceeds at the vendor default rather than forwarding a level another
 *   version's snapshot advertises to a binary that may reject it.
 */
export function claudeAdvertisedEffortsForRun(
  efforts: { levels: readonly EffortHint[]; live: boolean },
  installedVersion: string | null,
): readonly EffortHint[] {
  if (efforts.live) return efforts.levels;
  return claudeSnapshotTrustedForVersion(installedVersion) ? efforts.levels : [];
}

/**
 * The RUN's whole INV-105 effort seam in one place: probe the installed
 * binary's ladder, version-gate snapshot-fallback trust
 * (`claudeAdvertisedEffortsForRun`), and derive the DROP/CLAMP disclosure on
 * the SAME advertised list the arg builder will resolve against — so the flag
 * sent and the disclosure emitted can never disagree. The `--version` spawn
 * happens only when it can matter (fallback ladder AND an effort actually
 * requested); a live parse or a hint-less run never pays for it.
 */
export async function claudeRunEffortResolution(
  spec: Pick<HarnessRunSpec, "session_id" | "effort_hint">,
  deps: {
    probeEffortLevels: typeof probeClaudeEffortLevels;
    detectVersion: (abortSignal?: AbortSignal) => Promise<string | null>;
  },
  abortSignal?: AbortSignal,
): Promise<{ advertised: readonly EffortHint[]; disclosure: HarnessEvent | null }> {
  const efforts = await deps.probeEffortLevels(abortSignal);
  const advertised =
    efforts.live || !spec.effort_hint
      ? efforts.levels
      : claudeAdvertisedEffortsForRun(efforts, await deps.detectVersion(abortSignal));
  return { advertised, disclosure: claudeEffortDisclosureEvent(spec, advertised) };
}

/**
 * How many lines of a wrapped `--effort` block the parse will read. Generous
 * next to the widest observed wrap (four lines at 40 columns) and still a hard
 * stop, so an `--effort` line that documents nothing cannot reach into a later
 * option's parentheses.
 */
const EFFORT_HELP_BLOCK_MAX_LINES = 8;

/**
 * Pull the advertised levels out of `claude --help` text, or null when the
 * `--effort` line is absent or documents no values.
 *
 * Pure and separately testable: the spawn lives in the adapter's runtime deps so
 * a test can feed recorded help text for any CLI version.
 */
export function parseClaudeEffortHelp(help: string): EffortHint[] | null {
  const lines = help.split(/\r?\n/);
  // Match the flag TOKEN, not a substring: `line.includes("--effort")` also
  // matched `--effort-budget`, anchoring the parse on the wrong flag's block.
  const start = lines.findIndex((line) =>
    line.split(/[\s,]+/).some((token) => token === "--effort"),
  );
  if (start < 0) return null;
  // The value list wraps at the rendering width, and a narrower terminal pushes
  // the closing paren further down (2.1.165 at 40 columns needs four lines), so
  // a fixed line count silently loses the list. Read this flag's OWN block
  // instead: everything up to the next documented flag or the blank line that
  // ends the section, bounded so a paren from unrelated prose can never be
  // mistaken for the effort list.
  let end = start + 1;
  for (; end < lines.length && end - start < EFFORT_HELP_BLOCK_MAX_LINES; end += 1) {
    const next = lines[end] ?? "";
    // ANY new option line ends the block, SHORT alias included. Matching only a
    // leading `--` let a layout that renders aliases (`  -m, --model <model>`)
    // run straight past the next flag; the block then reached far enough that the
    // LAST parenthesized group came from THAT flag instead — and a group like
    // `(opus, sonnet, haiku)` is comma-separated lowercase slugs, so it passes as
    // a value list and publishes model names as the effort ladder.
    if (next.trim() === "" || /^\s*--?[A-Za-z0-9]/.test(next)) break;
  }
  const window = lines.slice(start, end).join(" ");
  // The FIRST paren in the block is not necessarily the value list: a vendor
  // annotation can precede it ("Effort level (beta) (low, medium, high, max)"),
  // and `beta` is itself a well-formed slug, so anchoring on the first group
  // published a bogus one-level ladder instead of falling back to the snapshot.
  // Take the LAST group that actually looks like a value list — which also
  // survives an annotation placed AFTER the list.
  let levels: EffortHint[] | null = null;
  for (const group of window.matchAll(/\(([^()]*)\)/g)) {
    const parsed = readEffortGroup(group[1] ?? "");
    // Same policy as the codex probe: ONE malformed token inside a value list
    // fails the WHOLE parse (snapshot fallback). Skipping the token instead
    // would publish a silently NARROWED ladder stamped as live — a real level
    // would clamp away or refuse against a list the vendor never printed.
    if (parsed === MALFORMED) return null;
    levels = parsed ?? levels;
  }
  return levels;
}

/**
 * A parenthesized group that ENUMERATES like a value list but carries a token
 * that is not an `EffortHint`. Distinct from `null` (not a value list at all —
 * an annotation like `(beta)`, which is skipped): this poisons the whole parse.
 */
const MALFORMED = Symbol("malformed-effort-group");

/**
 * The levels one parenthesized group advertises, or null when the group is not a
 * value list at all.
 *
 * A group qualifies only if it ENUMERATES (a comma or pipe): with no rank
 * table, a lone `(high)` is indistinguishable from an annotation like
 * `(beta)`, and the vendor's real value list has always enumerated. A help
 * text that ever documents a genuine one-level ladder falls back to the
 * recorded snapshot instead of guessing.
 *
 * STRICT inside an enumerating group, matching the codex probe's reviewed
 * policy: a token that fails the `EffortHint` contract (prose, an over-long
 * slug, invalid characters) is MALFORMED and fails the whole parse, because
 * skipping it would publish a silently narrowed ladder as live — and the
 * snapshot fallback is a real, usable ladder, so strictness costs freshness,
 * never capability.
 */
function readEffortGroup(body: string): EffortHint[] | null | typeof MALFORMED {
  if (!/[,|]/.test(body)) return null;
  const levels: EffortHint[] = [];
  for (const raw of body.split(/[,|]/)) {
    const parsed = EffortHint.safeParse(raw.trim());
    if (!parsed.success) return MALFORMED;
    if (!levels.includes(parsed.data)) levels.push(parsed.data);
  }
  return levels.length > 0 ? levels : null;
}

type ClaudeHelpProbe =
  { ok: true; help: string; code: number | null } | { ok: false; error: string };

/**
 * Wall clock the shared capture is bounded by. It replaces the caller abort
 * signal that used to bound it, so the spawn still cannot hang forever without
 * belonging to any one caller.
 */
const HELP_PROBE_TIMEOUT_MS = 10_000;

let helpProbePromise: Promise<ClaudeHelpProbe> | null = null;

/** What an abandoned caller reads, without the shared capture ever seeing it. */
function abandonedProbe(): ClaudeHelpProbe {
  return { ok: false, error: "claude --help probe abandoned: the caller was cancelled" };
}

/**
 * The ONE `claude --help` capture, owned by the module rather than by whichever
 * caller happened to ask for it first. The readonly-flag probe and the effort
 * ladder both ask the same installed binary the same question, so they share a
 * single spawn rather than growing a second discovery mechanism.
 *
 * Two properties keep the sharing honest, and the first cache had neither:
 *
 * 1. NO CALLER'S ABORT SIGNAL REACHES THE SPAWN. Threading the first caller's
 *    signal in here made a process-wide resource the private property of one
 *    run: cancelling that run killed the capture, and the memo then handed the
 *    corpse to every later run. Its own wall clock bounds it instead.
 * 2. ONLY AN ANSWER IS KEPT. A `--help` that never ran (spawn error) or that the
 *    timeout killed (`code === null`, no exit status of its own) says nothing
 *    about the installed binary, so keeping it turns one bad moment into a
 *    permanent one; those outcomes drop the memo and the next caller re-probes.
 *    A real exit is a fact about this binary — non-zero included — and stays.
 *
 * The stakes are higher than staleness. The ladder falls back to a snapshot
 * recorded from CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST, so a poisoned memo on a
 * machine running an older CLI does not merely lose freshness: it advertises and
 * forwards `xhigh` to a binary that rejects it, for the life of the daemon.
 */
function sharedHelpCapture(): Promise<ClaudeHelpProbe> {
  if (helpProbePromise) return helpProbePromise;
  const pending = (async (): Promise<ClaudeHelpProbe> => {
    try {
      const result = await runCapture(BIN, ["--help"], {
        timeoutMs: HELP_PROBE_TIMEOUT_MS,
        cancelSignal: "SIGTERM",
        cancelKillDelayMs: 0,
      });
      return { ok: true, help: `${result.stdout}\n${result.stderr}`, code: result.code };
    } catch (error) {
      return {
        ok: false,
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      };
    }
  })();
  helpProbePromise = pending;
  // Identity-guarded so a late settle can only ever clear its OWN memo, never a
  // re-probe another caller has already started.
  const forget = (): void => {
    if (helpProbePromise === pending) helpProbePromise = null;
  };
  void pending.then((probe) => {
    if (!probe.ok || probe.code === null) forget();
  }, forget);
  return pending;
}

/**
 * The shared capture, with the caller's cancellation bounding only the CALLER'S
 * OWN wait. An abandoned caller reads a probe failure — its run is going away
 * anyway, and the ladder falls back to the snapshot for that one run — while the
 * capture keeps running for everybody else.
 */
export function probeClaudeHelp(abortSignal?: AbortSignal): Promise<ClaudeHelpProbe> {
  const shared = sharedHelpCapture();
  if (!abortSignal) return shared;
  if (abortSignal.aborted) return Promise.resolve(abandonedProbe());
  return new Promise<ClaudeHelpProbe>((resolve) => {
    const abandon = (): void => resolve(abandonedProbe());
    abortSignal.addEventListener("abort", abandon, { once: true });
    void shared.then((probe) => {
      abortSignal.removeEventListener("abort", abandon);
      resolve(probe);
    });
  });
}

/**
 * The effort ladder the INSTALLED claude binary advertises, falling back to the
 * recorded snapshot when `--help` cannot be read or no longer documents the
 * values. A probe failure costs freshness, never the run.
 */
export async function probeClaudeEffortLevels(
  abortSignal?: AbortSignal,
): Promise<{ levels: readonly EffortHint[]; live: boolean }> {
  const probe = await probeClaudeHelp(abortSignal);
  const parsed = probe.ok ? parseClaudeEffortHelp(probe.help) : null;
  return parsed ? { levels: parsed, live: true } : { levels: CLAUDE_EFFORT_SNAPSHOT, live: false };
}

/**
 * The INV-105 disclosure for an effort the RUN itself could not honor, or null
 * when nothing was dropped. Preflight validates against the manifest ladder,
 * but the arg builder resolves against what the INSTALLED binary advertises at
 * run time (an older CLI's `--help` can be narrower than the discovered
 * manifest), and its normalizer answers "send no flag" — which without this
 * event was a silent vendor-default run. The payload rides the same
 * `ignored_settings` channel governance uses (QA-070 timeline warning).
 */
export function claudeEffortIgnoredEvent(
  spec: Pick<HarnessRunSpec, "session_id" | "effort_hint">,
  advertised: readonly EffortHint[],
): HarnessEvent | null {
  if (!spec.effort_hint) return null;
  if (normalizeEffort(spec.effort_hint, advertised) !== null) return null;
  // An EMPTY advertised list is the version-gated snapshot distrust case
  // (`claudeAdvertisedEffortsForRun`): the installed binary's ladder could not
  // be read and the recorded snapshot belongs to a different CLI version, so
  // the honest statement is "unverifiable", not "not accepted".
  const detail =
    advertised.length > 0
      ? `effort=${spec.effort_hint} (not accepted by the installed claude CLI; ` +
        `it advertises: ${advertised.join(", ")}; the run used the vendor default)`
      : `effort=${spec.effort_hint} (could not be verified against the installed claude CLI: ` +
        "its effort ladder could not be read from --help, and the recorded snapshot was " +
        `captured from CLI ${CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST}, a different version, ` +
        "so no effort flag was sent; the run used the vendor default)";
  return {
    type: "message",
    session_id: spec.session_id,
    ts: nowIso(),
    text: `[effort] ignored: ${detail}`,
    payload: { ignored_settings: [detail] },
  };
}

/**
 * The INV-105 disclosure for an effort the resolution CLAMPED, or null when the
 * level rode through verbatim (or was dropped — `claudeEffortIgnoredEvent`'s
 * shape; the two are mutually exclusive: a drop sends no flag, a clamp sends a
 * different one). Mirrors the codex clamp seam so a moved level is disclosed
 * the same way on both adapters, and takes the SAME (advertised, ladder)
 * inputs the arg builder's normalizer takes so the disclosure can never
 * disagree with the flag actually sent.
 *
 * Reachability today: the arg builder resolves with the installed binary's own
 * list as both advertised set and rank ladder (`normalizeEffort`'s two-arg
 * form), and against one's own ladder every miss is a DROP, never a clamp —
 * so with current call sites this event only fires if a rank ladder broader
 * than the binary's list is ever threaded through (the codex-shaped future,
 * e.g. `ultra` ranking above a max-capped binary and clamping onto `max`).
 * The seam exists precisely so that future cannot be silent.
 */
/**
 * The one INV-105 seam the run yields: the DROP disclosure or the CLAMP
 * disclosure, whichever applies (they are mutually exclusive by construction —
 * a drop sends no flag, a clamp sends a different one), or null when the
 * requested level rode through verbatim or nothing was requested.
 */
export function claudeEffortDisclosureEvent(
  spec: Pick<HarnessRunSpec, "session_id" | "effort_hint">,
  advertised: readonly EffortHint[],
): HarnessEvent | null {
  return claudeEffortIgnoredEvent(spec, advertised) ?? claudeEffortClampedEvent(spec, advertised);
}

export function claudeEffortClampedEvent(
  spec: Pick<HarnessRunSpec, "session_id" | "effort_hint">,
  advertised: readonly EffortHint[],
  ladder: readonly EffortHint[] = advertised,
): HarnessEvent | null {
  if (!spec.effort_hint) return null;
  const check = resolveEffort(spec.effort_hint, advertised, ladder);
  if (check.status !== "ok" || !check.clamped || check.effort === null) return null;
  const detail =
    `effort=${spec.effort_hint} (clamped to ${check.effort}: the requested level is not ` +
    `advertised by the installed claude CLI (it advertises: ${advertised.join(", ")}), ` +
    `so the run sent ${check.effort}, the nearest level it advertises)`;
  return {
    type: "message",
    session_id: spec.session_id,
    ts: nowIso(),
    text: `[effort] clamped: ${detail}`,
    payload: { ignored_settings: [detail] },
  };
}
