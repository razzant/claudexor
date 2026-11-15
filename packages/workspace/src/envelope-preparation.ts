/**
 * Envelope base preparation facts (r10 C, #694): `owner.json` carries
 * `preparation` from before the first spawn; `preparing` stays true until the
 * envelope is handed over. A base kept after a stop without a proven end gets
 * the stop's facts there too, and goes by the read-only release below; where no
 * read can prove its end, only an operator's confirmation recorded there
 * (`operator_release`, `confirmEnvelopeRelease`) lets that release run.
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { preparationQuiet, WorkspaceError } from "@claudexor/core";
import { removeTree } from "@claudexor/util";
import { ENVELOPE_CUSTODY_FILE } from "./envelope-custody.js";
import { processStartTime } from "./envelope-recovery.js";
import {
  afterDirectExit,
  directExitObserved,
  heldFrom,
  holdFactsOf,
  sameHold,
  writeAtomicAsync,
  type PreparationHeldFacts,
  type PreparationHoldCause,
  type PreparationQuietRead,
} from "./preparation-hold.js";
import {
  boundOperatorRelease,
  confirmPreparationRelease,
  envelopeGeneration,
  hasPreparationChild,
  isPreparationUnderWay,
  releaseDecision,
  type ConfirmationInput,
  type ConfirmationOutcome,
  type OperatorReleaseBasis,
  type ReleaseBasis,
} from "./preparation-release.js";

export interface EnvelopePreparationFacts {
  scope_marker: string | null;
  preparing: boolean;
  held?: PreparationHeldFacts;
  /** An operator's confirmation that this base's processes ended (r17). */
  operator_release?: OperatorReleaseBasis;
}

/** owner.json's fields the release reads (the rest is kept as written). */
export interface EnvelopeOwnerRecord {
  pid?: unknown;
  started?: unknown;
  created_at?: unknown;
  envelope_id?: unknown;
  preparation?: EnvelopePreparationFacts;
}

/** The base's preparation facts: null when it has no owner.json (an envelope
 * that predates it) or no `preparation` field (an engine that predates it). A
 * record that exists but cannot be read or parsed throws: unreadable is not
 * absent (the first write and every rewrite are atomic, so a torn record is
 * damage, not an unfinished write). */
export function readEnvelopePreparation(base: string): EnvelopePreparationFacts | null {
  return readEnvelopeOwner(base)?.preparation ?? null;
}

/** The base's owner.json (null: none); unreadable throws, as above. */
export function readEnvelopeOwner(base: string): EnvelopeOwnerRecord | null {
  const path = join(base, "owner.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as EnvelopeOwnerRecord | null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkspaceError(
      `${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * A base's preparation facts are rewritten and the base released one at a time in
 * this process. A rewrite reads owner.json and writes it back across awaits, and the
 * exit stamp of a held base runs whenever its step's process exits: a release that
 * removed the base in between would see the write make it again with the facts read
 * before (the write creates a missing parent). In its turn a rewrite after a release
 * finds no owner.json and writes nothing. The turns last as long as their steps, and
 * an idle base keeps no entry.
 */
const baseTurns = new Map<string, Promise<void>>();
function inBaseTurn<T>(base: string, step: () => Promise<T>): Promise<T> {
  const turn = (baseTurns.get(base) ?? Promise.resolve()).then(step);
  const done = turn.then(
    () => undefined,
    () => undefined,
  );
  baseTurns.set(base, done);
  void done.then(() => {
    if (baseTurns.get(base) === done) baseTurns.delete(base);
  });
  return turn;
}

/** Rewrite owner.json's preparation facts, keeping its other fields: awaited off the
 * main thread at lane start (#704); `update` derives the new facts from the ones read
 * (null: none recorded, nothing is written). */
export function updateEnvelopePreparationAsync(
  base: string,
  update: (facts: EnvelopePreparationFacts | null) => EnvelopePreparationFacts | null,
): Promise<void> {
  return inBaseTurn(base, async () => {
    const path = join(base, "owner.json");
    const owner = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> & {
      preparation?: EnvelopePreparationFacts;
    };
    const facts = update(owner.preparation ?? null);
    if (facts) await writeAtomicAsync(path, { ...owner, preparation: facts });
  });
}

export type EnvelopePreparationVerdict =
  | { status: "none" }
  /** Releasable: its end is proven by reading, or an operator's confirmation
   * bound to this base lets it go where nothing can be read (`unproven`). */
  | { status: "quiet"; basis: ReleaseBasis; unproven?: string[] }
  /** What its stop (or a crash) left may still run, or no read can prove its end. */
  | { status: "held"; reasons: string[]; operatorMayConfirm?: true };

/** Whether an unfinished preparation's base may go. Changes nothing. */
export async function envelopePreparationVerdict(
  base: string,
  quiet: PreparationQuietRead = (facts) => preparationQuiet(facts),
): Promise<EnvelopePreparationVerdict> {
  let owner: EnvelopeOwnerRecord | null;
  try {
    owner = readEnvelopeOwner(base);
  } catch (error) {
    return { status: "held", reasons: [error instanceof Error ? error.message : String(error)] };
  }
  const facts = owner?.preparation;
  if (!facts?.preparing) return { status: "none" };
  if (hasPreparationChild(base))
    return { status: "held", reasons: ["this preparation's current child has not exited"] };
  const decision = releaseDecision(await quiet(holdFactsOf(facts.scope_marker, facts.held)), {
    operator: boundOperatorRelease(facts.operator_release, envelopeGeneration(owner!, facts.held)),
    platformLimit: false,
  });
  if (!decision.release)
    return {
      status: "held",
      reasons: decision.reasons,
      ...(decision.operatorMayConfirm ? { operatorMayConfirm: true as const } : {}),
    };
  return {
    status: "quiet",
    basis: decision.basis,
    ...(decision.unproven.length > 0 ? { unproven: decision.unproven } : {}),
  };
}

/** Record at the base why it is kept (an unconfirmed stop's facts); `preparing`
 * stays true. As for a thread, a hold that names the step's own process is
 * rewritten when this daemon sees it exit. */
export async function holdEnvelopePreparation(
  base: string,
  termination: PreparationHoldCause,
): Promise<void> {
  const held = heldFrom(termination);
  const recorded = updateEnvelopePreparationAsync(base, (facts) => ({
    scope_marker: facts?.scope_marker ?? null,
    preparing: true,
    held,
  }));
  afterDirectExit(base, termination, held, () =>
    updateEnvelopePreparationAsync(base, (facts) =>
      facts?.held && sameHold(facts.held, held)
        ? { ...facts, held: directExitObserved(facts.held) }
        : null,
    ),
  );
  await recorded;
}

/** The base of an envelope whose preparation stopped without a proven end goes
 * once a read proves its end; otherwise it stays (the startup sweep reads again).
 * Its read and removal take one turn of the base (`inBaseTurn`). */
export function releaseEnvelopeBase(base: string, quiet?: PreparationQuietRead): Promise<boolean> {
  return inBaseTurn(base, () => releaseEnvelopeBaseNow(base, quiet));
}

async function releaseEnvelopeBaseNow(
  base: string,
  quiet?: PreparationQuietRead,
): Promise<boolean> {
  return (await releaseEnvelopeBaseOnce(base, quiet)) !== "held";
}

/** `kept`: the base carries continuation custody, whose own owner decides it
 * (the recovery sweep, adoption, discard): only the hold is lifted. */
async function releaseEnvelopeBaseOnce(
  base: string,
  quiet?: PreparationQuietRead,
): Promise<"released" | "kept" | "held"> {
  const verdict = await envelopePreparationVerdict(base, quiet);
  if (verdict.status === "held") return "held";
  if (verdict.status === "quiet" && existsSync(join(base, ENVELOPE_CUSTODY_FILE))) {
    const path = join(base, "owner.json");
    const owner = JSON.parse(await readFile(path, "utf8")) as EnvelopeOwnerRecord;
    await writeAtomicAsync(path, {
      ...owner,
      preparation: { ...owner.preparation, preparing: false },
    });
    return "kept";
  }
  // Off the main thread, owner.json last: a removal cut short stays recognized (#704).
  await removeTree(base, { lastEntry: "owner.json" });
  return "released";
}

/**
 * An operator's confirmation that what this held base's preparation started has
 * ended (`confirmPreparationRelease`), in one turn of the base: compared with the
 * inspected digest, recorded in owner.json, then the base's own release. Its
 * creator still alive in another process (a CLI run, an MCP/ACP serve, another
 * daemon; on Windows possibly known by its pid alone), or this daemon's own
 * preparation of it still under way, refuses.
 */
export function confirmEnvelopeRelease(
  base: string,
  input: ConfirmationInput & { quiet?: PreparationQuietRead },
): Promise<ConfirmationOutcome> {
  const path = join(base, "owner.json");
  return inBaseTurn(base, () =>
    confirmPreparationRelease<EnvelopeOwnerRecord>(input, {
      read: () => readFile(path, "utf8"),
      parse: (bytes) => {
        const owner = JSON.parse(bytes) as EnvelopeOwnerRecord;
        return owner?.preparation?.preparing ? owner : null;
      },
      generation: (owner) => envelopeGeneration(owner, owner.preparation?.held),
      basis: (owner) => owner.preparation?.operator_release,
      stop: (owner) => owner.preparation?.held,
      refusal: async (owner) => envelopePreparationRefusal(base, owner),
      quiet: (owner) =>
        (input.quiet ?? ((facts) => preparationQuiet(facts)))(
          holdFactsOf(owner.preparation!.scope_marker, owner.preparation!.held),
        ),
      writer: (owner) => {
        const held = owner.preparation?.held;
        return {
          ...(typeof owner.created_at === "string" ? { opened_at: owner.created_at } : {}),
          ...(held ? { held_at: held.at } : {}),
        };
      },
      recordBasis: (owner, basis) =>
        writeAtomicAsync(path, {
          ...owner,
          preparation: { ...owner.preparation, operator_release: basis },
        }),
      release: async () => {
        const done = await releaseEnvelopeBaseOnce(base, input.quiet);
        return done === "kept" ? "completed" : done;
      },
    }),
  );
}

export function envelopePreparationRefusal(
  base: string,
  owner: EnvelopeOwnerRecord,
): string | null {
  if (isPreparationUnderWay(base)) return "this daemon's preparation of it is still under way";
  const pid = owner.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const recorded = typeof owner.started === "string" ? owner.started : null;
  if (pid === process.pid && (recorded === null || recorded === processStartTime(pid))) return null;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return null;
  }
  const live = processStartTime(pid);
  if (recorded !== null && live !== null && live !== recorded) return null;
  return `its creator pid ${pid} (another Claudexor process: a CLI run, an MCP/ACP serve or another daemon) may still be running`;
}
