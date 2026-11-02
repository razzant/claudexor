/**
 * One candidate lane's raw patch custody across its tries (#147, #551): the packet
 * each dispatch sizes, the envelope its answer carries and the refusal that ends a
 * try. Each dispatch describes the exact tree the candidate holds at that moment,
 * while the envelope's `base_sha` stays the run's delivery base, so a later round
 * revises the earlier one and the captured result from that base holds them all.
 */
import { rawContextSizer, type RawContextOptions } from "@claudexor/context";
import type { RawRequestCapacity } from "@claudexor/core";
import {
  RawPatchRefusalCode,
  type HarnessEvent,
  type ImplementationTransport,
  type RawContextPacket,
  type RawGitPatchEnvelope,
  type WorkspaceEnvelope,
} from "@claudexor/schema";
import {
  RawPatchRefusalError,
  captureRawPatchEnvelope,
  consumeRawPatchEnvelope,
  rawCandidateTree,
  rawPatchRefusalIsModelCorrectable,
} from "@claudexor/workspace";
import type { CandidateRun } from "./candidateEvidence.js";

export class RawPatchLane {
  private readonly producesPatches: boolean;
  private packet: RawContextPacket | null = null;
  private patch: RawGitPatchEnvelope | null = null;
  /** This try's typed refusal: the attempt's declared failure, and no retry. */
  refusal: RawPatchRefusalError | null = null;
  /** What the per-spawn gate needs to size this lane's packet from its catalog read. */
  readonly dispatch: {
    rawContext?: (capacity: RawRequestCapacity | null) => Promise<RawContextPacket>;
  };

  constructor(
    transport: ImplementationTransport,
    private readonly envelope: WorkspaceEnvelope,
    context: RawContextOptions,
  ) {
    const sizer = rawContextSizer(transport, envelope, context);
    this.producesPatches = sizer !== null;
    this.dispatch = sizer
      ? {
          rawContext: async (capacity) =>
            (this.packet = await sizer(capacity, await rawCandidateTree(envelope.worktree_path))),
        }
      : {};
  }

  /** A patch binds only the packet its own try sent. */
  beginTry(): void {
    this.packet = this.patch = this.refusal = null;
  }

  observe(event: HarnessEvent): void {
    this.patch = captureRawPatchEnvelope(this.producesPatches, this.patch, event);
    // The adapter's own typed refusal is the same kind of failure: before any request
    // (no packet, or over a known window) or after one (the answer was no patch). It
    // is kept without a throw, so a usage event after it is still read.
    if (event.type === "error" && event.refusal_code)
      this.refusal ??= new RawPatchRefusalError(
        event.refusal_code,
        event.error ?? event.refusal_code,
      );
  }

  /** Materialize the answer of a try that ended without a harness error. */
  async settle(harnessErrored: boolean): Promise<void> {
    if (!this.producesPatches || harnessErrored) return;
    await consumeRawPatchEnvelope({
      repoRoot: this.envelope.repo_root,
      worktreePath: this.envelope.worktree_path,
      baseCommitSha: this.envelope.base_sha ?? "HEAD",
      context: this.packet,
      envelope: this.patch,
    });
  }

  /** Keep a thrown refusal as this try's failure; false for any other throw. */
  refused(err: unknown): boolean {
    if (!(err instanceof RawPatchRefusalError)) return false;
    this.refusal = err;
    return true;
  }
}

/** The typed code of a round whose patch the engine refused for a reason the model
 * can correct, else null. That patch was not applied, so the round has no result of
 * its own: the candidate still holds an earlier round's result, and this round's
 * failure is the refusal, never a repeat of that result (INV-047). */
export function correctableRefusal(run: CandidateRun): RawPatchRefusalCode | null {
  const code = RawPatchRefusalCode.safeParse(run.declaredFailure?.code);
  return code.success && rawPatchRefusalIsModelCorrectable(code.data) ? code.data : null;
}

/** Failures another convergence round cannot repair: a refused request, a rejected
 * effort, and a raw refusal the model's next patch cannot correct. Every other
 * failure, a correctable refusal included, goes back through the revise prompt. */
export function endsConvergence(run: CandidateRun): boolean {
  const rawRefusal = RawPatchRefusalCode.safeParse(run.declaredFailure?.code);
  return (
    Boolean(run.telemetry.requestRefusal) ||
    run.telemetry.effortResolution?.resolution === "rejected" ||
    (rawRefusal.success && !rawPatchRefusalIsModelCorrectable(rawRefusal.data))
  );
}
