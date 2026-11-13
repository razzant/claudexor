import type {
  HarnessProgram,
  HarnessProgramIdentity,
  SelectedHarnessProgram,
} from "@claudexor/schema";
import { composeSpawnEnv } from "./env-scope.js";
import { harnessBinaryIdentityOnPath } from "./runtime-env.js";
import {
  resolveSelectedProgramAsync,
  selectProgramEntry,
  type ProgramResolutionOptions,
} from "./selected-program.js";

export interface ProgramObservation {
  selection: SelectedHarnessProgram | null;
  program: HarnessProgramIdentity | null;
  key: string;
  versionSource: "version_probe" | "remembered" | "unknown";
}
interface Remembered {
  identity: string;
  sequence: number;
  known: boolean;
  selection: SelectedHarnessProgram;
  pending?: Promise<ProgramObservation>;
}
const remembered = new Map<string, Remembered>();
let sequence = 0;
const listeners = new Set<(harness?: string) => void>();
/** In-flight consumers end their epoch when maintenance or a passive identity
 * observation detects replacement. No polling or file watcher is installed. */
export function onProgramObservationChange(listener: (harness?: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function changed(harness?: string): void {
  for (const listener of listeners) listener(harness);
}
function remember(entry: Remembered, selection: SelectedHarnessProgram): void {
  // A failed ask is still an observation, but never erases this identity's answer.
  if (selection.version !== null || entry.selection.version === null) entry.selection = selection;
  entry.known = true;
}
function entryFor(program: HarnessProgram, options: ProgramResolutionOptions) {
  const selected = selectProgramEntry(program, options);
  const identity = JSON.stringify([
    selected.observed.path,
    selected.observed.realPath,
    selected.observed.path
      ? harnessBinaryIdentityOnPath(
          selected.observed.path,
          selected.env.PATH ?? "",
          options.platform,
        )
      : null,
  ]);
  const key = `${program.id}\0${selected.observed.path ?? "missing"}`;
  let entry = remembered.get(key);
  if (!entry || entry.identity !== identity) {
    if (entry) changed(program.id);
    entry = { identity, sequence: ++sequence, known: false, selection: selected.observed };
    remembered.set(key, entry);
  }
  return { key, entry, selected };
}
function observation(
  selection: SelectedHarnessProgram,
  identity: string,
  source: "version_probe" | "remembered" = "remembered",
): ProgramObservation {
  return {
    selection,
    program: selection.path ? { path: selection.path, version: selection.version } : null,
    key: JSON.stringify([identity, selection.version]),
    versionSource: selection.version === null ? "unknown" : source,
  };
}
export function invalidateProgramObservations(harness?: string): void {
  changed(harness);
  for (const key of remembered.keys())
    if (!harness || key.startsWith(`${harness}\0`)) remembered.delete(key);
}

/** Reserve publication before an inventory child or native startup. A later
 * observation or file replacement fences its answer; no clock/TTL is involved. */
export function programObservationPublisher(
  program: HarnessProgram,
  options: ProgramResolutionOptions = {},
) {
  const { entry, key } = entryFor(program, options);
  const revision = (entry.sequence = ++sequence);
  return (selected: SelectedHarnessProgram): boolean => {
    if (
      remembered.get(key) !== entry ||
      entry.sequence !== revision ||
      entryFor(program, options).entry !== entry ||
      selected.path !== entry.selection.path ||
      selected.realPath !== entry.selection.realPath
    )
      return false;
    if (entry.known && entry.selection.version !== selected.version) changed(program.id);
    remember(entry, selected);
    entry.pending = undefined;
    return true;
  };
}

/** Passive reads inspect file identity only. The first read of an entry and
 * explicit fresh reads share one version process. An unanswered ask is remembered
 * by file identity too; consumers may reuse evidence under that same null answer. */
export async function observeHarnessProgram(
  program: HarnessProgram | undefined,
  patch?: Record<string, string | null | undefined>,
  bin?: string,
  options: { fresh?: boolean; probe?: boolean; environment?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<ProgramObservation> {
  if (!program)
    return { selection: null, program: null, key: "no-program", versionSource: "unknown" };
  const environment = options.environment ?? composeSpawnEnv("mirror_native", patch);
  const resolution = {
    sourceEnv: { ...environment, ...(bin ? { [program.overrideEnv]: bin } : {}) },
    environment,
    cwd: options.cwd,
  };
  const { entry, key, selected } = entryFor(program, resolution);
  const read = () =>
    observation(
      {
        ...selected.observed,
        version: entry.selection.version,
        versionOutput: entry.selection.versionOutput,
      },
      entry.identity,
    );
  if (options.probe === false) return read();
  if (entry.pending) return entry.pending;
  if (entry.known && !options.fresh) return read();
  const revision = (entry.sequence = ++sequence);
  const pending = resolveSelectedProgramAsync(program, resolution)
    .then((answer) => {
      if (
        remembered.get(key) === entry &&
        entry.sequence === revision &&
        entryFor(program, resolution).entry === entry
      ) {
        if (entry.known && entry.selection.version !== answer.version) changed(program.id);
        remember(entry, answer);
        return observation(
          entry.selection,
          entry.identity,
          answer.version === null ? "remembered" : "version_probe",
        );
      }
      return observation(answer, entry.identity, "version_probe");
    })
    .finally(() => {
      if (entry.pending === pending) entry.pending = undefined;
    });
  entry.pending = pending;
  return pending;
}

export function assertSameProgram(before: ProgramObservation, after: ProgramObservation): void {
  if (before.key !== after.key)
    throw Object.assign(
      new Error("The selected program changed during this observation; read it again."),
      { code: "program_changed_during_observation" },
    );
}
