/**
 * Object-store staging (r11, #694): the `owner.json` of a `tmp_claudexor-<uuid>`
 * staging directory under the store's `objects` names the creator, the scope and, once spawned, the writer (index-pack) with the
 * identity its capture measured. The store's prune reads it: a writer alive or
 * unknown keeps exactly this staging; exited or replaced lets it go. Where no
 * read can prove the end (r17), only an operator's confirmation recorded there
 * (`operator_release`, `confirmStagingRelease`) lets the prune remove it.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  preparationQuiet,
  type KnownProcessIdentity,
  type PreparationQuietVerdict,
} from "@claudexor/core";
import { writeAtomic, type PreparationQuietRead } from "./preparation-hold.js";
import { acquirePruneLock, ownerState } from "./object-store-leases.js";
import {
  boundOperatorRelease,
  confirmPreparationRelease,
  isPreparationUnderWay,
  releaseDecision,
  stagingGeneration,
  type ConfirmationInput,
  type ConfirmationOutcome,
  type OperatorReleaseBasis,
} from "./preparation-release.js";

export const STAGING_OWNER = "owner.json";

interface RecordedProcess {
  pid: number;
  identity?: KnownProcessIdentity;
}

export interface StagingOwnerRecord {
  schema: 1;
  intent: "index-pack";
  creator: RecordedProcess;
  scope: { marker: string } | null;
  /** The writer once spawned; null until then (unknown, never dead). */
  writer: RecordedProcess | null;
  /** An operator's confirmation that its writer (and what it started) ended. */
  operator_release?: OperatorReleaseBasis;
}

export function writeStagingOwner(staging: string, record: StagingOwnerRecord): void {
  writeAtomic(join(staging, STAGING_OWNER), record);
}

type ProcessState = (owner: RecordedProcess) => "alive" | "dead" | "unverified";

/**
 * Whether the store's prune may remove this old staging directory:
 * `legacy` (no owner record: the age policy alone, as before), `keep` (its
 * writer is alive, or unknown: not yet linked, unreadable, a birth that cannot
 * be compared, or a creator that may still link it), `remove` (its writer
 * exited or its pid names another process; or, never linked, its creator is
 * gone and its scope proven quiet). With an operator's confirmation bound to
 * the record, a writer known only by a pid in use, a scope no read can prove
 * quiet, and this process as the creator of a transfer no longer under way do
 * not keep it; a recorded identity that is alive or unreadable still does.
 */
export async function stagingVerdict(
  staging: string,
  state: ProcessState,
  quiet: PreparationQuietRead = (facts) => preparationQuiet(facts),
): Promise<"legacy" | "keep" | "remove"> {
  const path = join(staging, STAGING_OWNER);
  if (!existsSync(path)) return "legacy";
  let record: StagingOwnerRecord;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as StagingOwnerRecord;
  } catch {
    return "keep";
  }
  if (record?.schema !== 1 || !record.creator) return "keep";
  if (isPreparationUnderWay(staging)) return "keep";
  const operator = boundOperatorRelease(record.operator_release, stagingGeneration(record));
  if (record.writer) {
    const writer = state(record.writer);
    if (writer === "dead") return "remove";
    return operator && writer === "unverified" && record.writer.identity === undefined
      ? "remove"
      : "keep";
  }
  const creator = state(record.creator);
  if (creator !== "dead" && !(operator && record.creator.pid === process.pid)) return "keep";
  if (!record.scope) return "keep";
  const decision = releaseDecision(await quiet({ marker: record.scope.marker, groups: [] }), {
    operator,
    platformLimit: false,
  });
  return decision.release ? "remove" : "keep";
}

/** What one read shows of a staging record's writer, else of its scope. */
export async function stagingRead(
  record: StagingOwnerRecord,
  state: ProcessState = ownerState,
  quiet: PreparationQuietRead = (facts) => preparationQuiet(facts),
): Promise<PreparationQuietVerdict> {
  if (record.writer) {
    const writer = state(record.writer);
    if (writer === "alive")
      return { status: "held", reasons: [`its writer ${record.writer.pid} is alive`] };
    if (writer === "unverified")
      return {
        status: "held",
        reasons: [`its writer's pid ${record.writer.pid} is in use, its identity unknown`],
        ...(record.writer.identity === undefined ? { writerInUse: record.writer.pid } : {}),
      };
    return { status: "quiet" };
  }
  if (!record.scope) return { status: "held", reasons: ["it names neither a writer nor a scope"] };
  return quiet({ marker: record.scope.marker, groups: [] });
}

/** Shared with inspection; the release reads these facts again under the prune lock. */
export function stagingPreparationRefusal(
  staging: string,
  record: StagingOwnerRecord,
  state: ProcessState = ownerState,
): string | null {
  if (isPreparationUnderWay(staging)) return "this daemon's transfer into it is still under way";
  if (record.creator.pid !== process.pid && state(record.creator) !== "dead")
    return `its creator ${record.creator.pid} (another process) may still be running`;
  return null;
}

/**
 * An operator's confirmation for one staging directory of `store`
 * (`confirmPreparationRelease`), under the store's prune lock: compared with the
 * inspected digest, recorded in its owner.json, then removed only by the same
 * verdict the prune uses. A live creator other than this process refuses (on
 * Windows its identity may be a pid alone: the staging then waits for it).
 */
export async function confirmStagingRelease(
  store: string,
  name: string,
  input: ConfirmationInput & {
    state?: ProcessState;
    quiet?: PreparationQuietRead;
  },
): Promise<ConfirmationOutcome> {
  const state = input.state ?? ownerState;
  const staging = join(store, "objects", name);
  const path = join(staging, STAGING_OWNER);
  const hold = acquirePruneLock(store);
  if (!hold)
    return { outcome: "refused", reasons: ["the object store's prune is running: try again"] };
  try {
    return await confirmPreparationRelease<StagingOwnerRecord>(input, {
      read: () => readFile(path, "utf8"),
      parse: (bytes) => {
        const record = JSON.parse(bytes) as StagingOwnerRecord;
        if (record?.schema !== 1 || !record.creator) throw new Error("not a staging owner record");
        return record;
      },
      generation: stagingGeneration,
      basis: (record) => record.operator_release,
      stop: () => undefined,
      refusal: async (record) => stagingPreparationRefusal(staging, record, state),
      quiet: (record) => stagingRead(record, state, input.quiet),
      writer: () => ({}),
      recordBasis: (record, basis) =>
        writeStagingOwner(staging, { ...record, operator_release: basis }),
      release: async () => {
        if ((await stagingVerdict(staging, state, input.quiet)) !== "remove") return "held";
        rmSync(staging, { recursive: true, force: true });
        return "released";
      },
    });
  } finally {
    hold.release();
  }
}
