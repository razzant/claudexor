/**
 * INV-105 version gate for the codex effort SNAPSHOT, plus the run's one
 * effort-resolution seam. Split out of effort-probe.ts (discovery mechanics)
 * so each file keeps a single altitude: the probe answers "what does the
 * vendor advertise", this module answers "what may THIS run trust".
 */
import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import {
  CODEX_EFFORT_SNAPSHOT_VERIFIED_AGAINST,
  codexEffortDisclosureEvent,
  codexEffortsForEnv,
  type CodexEffortCatalog,
  type CodexEffortProbe,
} from "./effort-probe.js";

/**
 * Whether the recorded snapshot may be TRUSTED for arg emission against the
 * installed binary (INV-105). The snapshot is another CLI version's recorded
 * `model/list` answer, so it is only that binary's truth on the exact version
 * it was captured from: 0.144.1 advertises `ultra` on gpt-5.6-sol, an older
 * codex may not, and an install whose live probe failed used to be handed the
 * 0.144.1 catalog anyway — `model_reasoning_effort="ultra"` then went to a CLI
 * that refuses the value. Mirrors `claudeSnapshotTrustedForVersion`.
 *
 * The installed version string is whatever `codex --version` printed
 * (e.g. `codex-cli 0.144.1`), so the comparison extracts the full dotted
 * numeric token and requires it to EQUAL the snapshot stamp exactly. An
 * unknown or unparseable version can never vouch for the snapshot.
 */
export function codexSnapshotTrustedForVersion(installedVersion: string | null): boolean {
  if (installedVersion === null) return false;
  const token = installedVersion.match(/\d+(?:\.\d+)+/);
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
): Promise<{ catalog: CodexEffortCatalog; disclosure: HarnessEvent | null }> {
  const efforts = await codexEffortsForEnv(deps, envPatch);
  const catalog =
    efforts.live || !spec.effort_hint
      ? efforts.catalog
      : codexCatalogForRun(efforts, await deps.detectVersion(abortSignal, envPatch));
  return { catalog, disclosure: codexEffortDisclosureEvent(catalog, spec) };
}
