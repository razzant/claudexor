/**
 * INV-105 version gate for the codex effort SNAPSHOT, plus the run's one
 * effort-resolution seam and its disclosures. Split out of effort-probe.ts
 * (discovery mechanics + the pure resolution) so each file keeps a single
 * altitude: the probe answers "what does the vendor advertise", this module
 * answers "what may THIS run trust, and what does it tell the timeline".
 */
import { effortResolutionEvent } from "@claudexor/core";
import type { EffortResolution, HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import {
  CODEX_EFFORT_SNAPSHOT_VERIFIED_AGAINST,
  codexEffortResolution,
  codexEffortsForEnv,
  type CodexEffortCatalog,
  type CodexEffortProbe,
  type CodexEffortResolution,
} from "./effort-probe.js";

/**
 * Whether the recorded snapshot may be TRUSTED for arg emission against the
 * installed binary (INV-105). The snapshot is another CLI version's recorded
 * `model/list` answer, so it is only that binary's truth on the exact version
 * it was captured from. A failed live probe on an older CLI must not send
 * newer snapshot levels that the installed version may refuse. Mirrors
 * `claudeSnapshotTrustedForVersion`.
 *
 * The installed version string is whatever `codex --version` printed
 * (e.g. `codex-cli 0.156.1`), so the comparison extracts the full version
 * token — dotted numbers plus any pre-release or build suffix, which exact
 * installs can select — and requires it to EQUAL the snapshot stamp exactly.
 * An unknown or unparseable version can never vouch for the snapshot.
 */
export function codexSnapshotTrustedForVersion(installedVersion: string | null): boolean {
  if (installedVersion === null) return false;
  const token = installedVersion.match(/\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/);
  return token !== null && token[0] === CODEX_EFFORT_SNAPSHOT_VERIFIED_AGAINST;
}

/**
 * The effort catalog the RUN may resolve `model_reasoning_effort` against,
 * version-gating snapshot trust (INV-105) — the codex mirror of
 * `claudeAdvertisedEffortsForRun`:
 *
 * - a LIVE `model/list` answer is the installed binary's own truth for the
 *   resolved env's account — trusted on any version;
 * - the snapshot FALLBACK is trusted only when the installed version equals
 *   `CODEX_EFFORT_SNAPSHOT_VERIFIED_AGAINST` (same binary, same catalog);
 * - a fallback on ANY OTHER version (mismatch, unknown, unparseable) yields an
 *   EMPTY catalog: the resolver then sends no effort flag at all, and the
 *   existing drop seam (`codexEffortIgnoredEvent`) discloses it — the run
 *   proceeds at the vendor default rather than forwarding a level another
 *   version's snapshot advertises to a binary that may reject it.
 */
export function codexCatalogForRun(
  efforts: { catalog: CodexEffortCatalog; live: boolean },
  installedVersion: string | null,
): CodexEffortCatalog {
  if (efforts.live) return efforts.catalog;
  return codexSnapshotTrustedForVersion(installedVersion)
    ? efforts.catalog
    : { models: {}, defaultModel: null };
}

/**
 * The RUN's whole INV-105 effort seam in one place — the codex mirror of
 * `claudeRunEffortResolution`: probe the catalog for THIS run's resolved env
 * (profile / API-key `CODEX_HOME`s have their own accounts), version-gate
 * snapshot-fallback trust (`codexCatalogForRun`), and derive the DROP/CLAMP
 * disclosure on the SAME catalog the arg builder will resolve against — so the
 * flag sent and the disclosure emitted can never disagree. The `--version`
 * spawn happens only when it can matter (snapshot fallback AND an effort
 * actually requested); a live probe or a hint-less run never pays for it.
 */
export async function codexRunEffortResolution(
  spec: Pick<HarnessRunSpec, "session_id" | "model_hint" | "effort_hint">,
  deps: {
    probeEfforts: CodexEffortProbe;
    nowMs: () => number;
    detectVersion: (
      abortSignal?: AbortSignal,
      env?: Record<string, string | null | undefined>,
    ) => Promise<string | null>;
  },
  envPatch?: Record<string, string | null | undefined>,
  abortSignal?: AbortSignal,
): Promise<{
  catalog: CodexEffortCatalog;
  disclosure: HarnessEvent | null;
  resolution: EffortResolution;
  event: HarnessEvent;
}> {
  const efforts = await codexEffortsForEnv(deps, envPatch);
  const catalog =
    efforts.live || !spec.effort_hint
      ? efforts.catalog
      : codexCatalogForRun(efforts, await deps.detectVersion(abortSignal, envPatch));
  const untrusted = !efforts.live && catalog !== efforts.catalog;
  // The ONE result: the receipt recorded here is what the arg builders send
  // (`resolution.submitted`) and what both disclosure seams describe.
  const resolved = codexEffortResolution(catalog, spec.model_hint, spec.effort_hint, {
    source: untrusted ? "adapter" : efforts.live ? "live_probe" : "versioned_snapshot",
    untrusted,
  });
  const { resolution } = resolved;
  const disclosure = codexEffortDisclosureEvent(catalog, spec, resolved);
  const event = {
    ...((["downward", "floor"].includes(resolution.resolution) || untrusted) && disclosure
      ? disclosure
      : effortResolutionEvent(spec.session_id, resolution)),
    effort_resolution: resolution,
  };
  return { catalog, resolution, event, disclosure };
}

type EffortSpec = Pick<HarnessRunSpec, "session_id" | "model_hint" | "effort_hint">;

function disclosureEvent(spec: EffortSpec, kind: "ignored" | "clamped", detail: string) {
  return {
    type: "status",
    session_id: spec.session_id,
    ts: nowIso(),
    text: `[effort] ${kind}: ${detail}`,
    payload: { ignored_settings: [detail] },
  } satisfies HarnessEvent;
}

/**
 * The INV-105 disclosure for an effort the RUN itself could not honor, or null
 * when a level was submitted. Preflight validates against the manifest — the
 * DEFAULT account's catalog — but the adapter resolves against the catalog for
 * the env the child actually runs in (profile / API-key homes have their own
 * accounts), so a level can pass preflight and still resolve to "send no flag"
 * here. Without this event that run silently executed at the vendor default;
 * the payload rides the same `ignored_settings` channel governance uses, so
 * the timeline renders the same warning either way. Reads the run's ONE result
 * (`resolved`); pure callers derive it from the same catalog.
 */
export function codexEffortIgnoredEvent(
  catalog: CodexEffortCatalog,
  spec: EffortSpec,
  resolved: CodexEffortResolution = codexEffortResolution(
    catalog,
    spec.model_hint,
    spec.effort_hint,
  ),
): HarnessEvent | null {
  if (!spec.effort_hint || resolved.resolution.submitted !== null) return null;
  const target = resolved.effectiveModel;
  // An EMPTY catalog is the version-gated snapshot distrust case
  // (`codexCatalogForRun`): the live probe could not answer and the recorded
  // snapshot belongs to a different CLI version, so the honest statement is
  // "unverifiable", not "not accepted".
  const detail =
    Object.keys(catalog.models).length > 0
      ? `effort=${spec.effort_hint} (not accepted by the codex catalog resolved for this run's ` +
        `environment${target ? ` on model ${target}` : ""}; no effort flag is prepared; the vendor default is left unspecified)`
      : `effort=${spec.effort_hint} (could not be verified against the installed codex CLI: ` +
        "the live model/list probe could not answer, and the recorded snapshot was captured " +
        `from CLI ${CODEX_EFFORT_SNAPSHOT_VERIFIED_AGAINST}, a different version, ` +
        "so no effort flag is prepared; the vendor default is left unspecified)";
  return disclosureEvent(spec, "ignored", withReason(detail, resolved.resolution));
}

/** A receipt's own explanation (a shared-order placement, a word outside the
 * shared order, a refusal) rides behind the adapter's wording, never instead of it. */
function withReason(detail: string, resolution: EffortResolution): string {
  return resolution.reason ? `${detail}; ${resolution.reason}` : detail;
}

/**
 * The one INV-105 seam the run yields: the DROP disclosure or the CLAMP
 * disclosure, whichever applies (they are mutually exclusive by construction —
 * a drop sends no flag, a clamp sends a different one), or null when the
 * requested level rode through verbatim or nothing was requested.
 */
export function codexEffortDisclosureEvent(
  catalog: CodexEffortCatalog,
  spec: EffortSpec,
  resolved: CodexEffortResolution = codexEffortResolution(
    catalog,
    spec.model_hint,
    spec.effort_hint,
  ),
): HarnessEvent | null {
  return (
    codexEffortIgnoredEvent(catalog, spec, resolved) ??
    codexEffortClampedEvent(catalog, spec, resolved)
  );
}

/**
 * The INV-105 disclosure for an effort the run CLAMPED (`downward` or `floor`),
 * or null when the requested level rode through verbatim or was dropped. A
 * clamp is quieter than a drop but just as much a changed setting: `--effort
 * ultra` on gpt-5.4 runs at `xhigh`, and without this event nothing in the
 * timeline said so. A placement by the shared preference order carries the
 * receipt's reason, so the timeline says which order moved the level.
 */
export function codexEffortClampedEvent(
  catalog: CodexEffortCatalog,
  spec: EffortSpec,
  resolved: CodexEffortResolution = codexEffortResolution(
    catalog,
    spec.model_hint,
    spec.effort_hint,
  ),
): HarnessEvent | null {
  const sent = resolved.resolution.submitted;
  if (!spec.effort_hint || sent === null || resolved.resolution.resolution === "exact") return null;
  const detail =
    `effort=${spec.effort_hint} (clamped to ${sent}: the requested level is not ` +
    `advertised by${resolved.effectiveModel ? ` model ${resolved.effectiveModel}` : " the resolved model"}, ` +
    `so preparation selected ${sent}, the resolved supported level)`;
  return disclosureEvent(spec, "clamped", withReason(detail, resolved.resolution));
}
