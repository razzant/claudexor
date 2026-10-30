import {
  needsOperatorAttention,
  type HarnessEvent,
  type HarnessRunSpec,
  type PoolAttemptFailure,
  type RunOutcomeFacts,
  type VendorFailureEvidence,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { dominantHarnessFailureCategory } from "./harnessFailure.js";
import type { TryFacts } from "./inrun-continuity-types.js";

/** The admission gate's callback, fired once a send is admitted, right before
 * its adapter runs (`admitCurrentProfileDispatch`). */
const DISPATCH = "markPhysicalDispatchStarted";

interface OpenTry {
  spec: HarnessRunSpec;
  tryIndex: number;
  error: string | null;
  at: string | null;
  foreign: boolean;
  /** Set by the gate's own callback once this try's send was admitted. */
  dispatched?: true;
  gate: unknown;
}

/**
 * Per-try account attribution of one attempt (diagnostic evidence only): every
 * ACTUAL try that ended in an error, with the row it ran on and its own error
 * text in order, so a pool failure names each account's refusal instead of only
 * the last one. The in-run controller opens a row at `beginTry`, observes the
 * stream, and settles it once in `afterTry`. Only a PHYSICAL try counts: the
 * gate's own dispatch callback marks it, so a selected successor whose account
 * failed earlier (model inventory, processing or billing preparation) has no
 * row, while an adapter that fails on entry, before its typed start, keeps one.
 * Cancelled, budget-stopped and request-refused tries are not account evidence,
 * and a try whose own events name another account is not attributed to this
 * one. Building a row never throws: a malformed event time falls back to the
 * settlement clock instead of replacing the original error.
 */
export class PoolAttemptEvidence {
  private readonly rows: PoolAttemptFailure[] = [];
  private open: OpenTry | null = null;

  constructor(
    private readonly harnessId: string,
    private readonly attemptId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  begin(spec: HarnessRunSpec, tryIndex: number): void {
    const gate = spec.extra[DISPATCH];
    const open: OpenTry = { spec, tryIndex, error: null, at: null, foreign: false, gate };
    this.open = open;
    spec.extra[DISPATCH] = () => {
      open.dispatched = true;
      if (typeof gate === "function") (gate as () => void)();
    };
  }

  observe(event: HarnessEvent): void {
    const open = this.open;
    if (!open) return;
    const bound = open.spec.credential_profile?.profile_id ?? null;
    if (event.credential_profile_id !== undefined && event.credential_profile_id !== bound)
      open.foreign = true;
    if (event.type === "error" && open.error === null) {
      open.error = event.error ?? event.text ?? null;
      open.at = event.ts;
    }
  }

  settle(
    facts: Pick<
      TryFacts,
      | "harnessErrored"
      | "aborted"
      | "budgetStopped"
      | "requestRefused"
      | "originalError"
      | "newTransients"
      | "markers"
    >,
  ): void {
    const open = this.open;
    this.open = null; // one settlement per try, whatever the caller repeats
    if (!open) return;
    // Successors copy this spec after settlement: they wrap the gate, never this try.
    open.spec.extra[DISPATCH] = open.gate;
    if (open.foreign || !open.dispatched || !facts.harnessErrored) return;
    if (facts.aborted || facts.budgetStopped || facts.requestRefused) return;
    const profile = open.spec.credential_profile ?? null;
    const vendor = [...facts.newTransients].reverse().find((t) => t.vendorFailure)?.vendorFailure;
    this.rows.push({
      harnessId: this.harnessId,
      profileId: profile?.profile_id ?? null,
      profileDisplayName: profile ? redactSecrets(profile.display_name) : null,
      requestedModel: open.spec.model_hint ?? null,
      attemptId: this.attemptId,
      tryIndex: open.tryIndex,
      observedAt: isoOr(open.at, this.now),
      phase: facts.markers.sawAgentProgress
        ? "after_progress"
        : facts.markers.sawSessionStart
          ? "pre_progress"
          : "pre_start",
      category: dominantHarnessFailureCategory([...facts.newTransients]) ?? "unknown_harness_error",
      error: redactSecrets(
        open.error ?? facts.originalError ?? "the try ended in an error without a message",
      ),
      vendorFailure: vendor ? redactVendorFailure(vendor) : null,
    });
  }

  snapshot(): PoolAttemptFailure[] {
    return this.rows.map((row) => ({ ...row }));
  }
}

function isoOr(value: string | null, now: () => Date): string {
  const at = value === null ? Number.NaN : Date.parse(value);
  return new Date(Number.isFinite(at) ? at : now().getTime()).toISOString();
}

/** Vendor failure text is a diagnostic derivative: masked like safeMessage (INV-146). */
export function redactVendorFailure(vendor: VendorFailureEvidence): VendorFailureEvidence {
  return {
    code: vendor.code === null ? null : redactSecrets(vendor.code),
    message: vendor.message === null ? null : redactSecrets(vendor.message),
    source: vendor.source,
  };
}

/** Every failed try of these attempts, in attempt order. */
export function poolAttemptsOf(
  items: readonly { poolAttempts?: readonly PoolAttemptFailure[] }[],
): PoolAttemptFailure[] {
  return items.flatMap((item) => item.poolAttempts ?? []);
}

/**
 * The list a strategy's own terminal names, decided by its actual outcome (the
 * same axes that choose run.completed/run.blocked/run.failed): every failed try
 * on a failure, a cancellation or a D8 decision/input block; none on a clean
 * completion. The block or cancellation itself is never an account row.
 */
export function terminalPoolAttempts(
  facts: RunOutcomeFacts,
  items: readonly { poolAttempts?: readonly PoolAttemptFailure[] }[],
): PoolAttemptFailure[] {
  const clean = facts.lifecycle === "succeeded" && !needsOperatorAttention(facts, false);
  return clean ? [] : poolAttemptsOf(items);
}

/**
 * The ONE human rendering of a pool failure, shared by every failure terminal
 * (failure.yaml `safeMessage`, `run.failed` error, summary.md and the returned
 * summary): the terminal's own message, then each failed try with its account
 * and its own error text. The structured list rides beside it unchanged.
 */
export function withPoolAttempts(message: string, attempts: readonly PoolAttemptFailure[]): string {
  if (attempts.length === 0) return message;
  const lines = attempts.map((a) => {
    const label =
      a.profileDisplayName && a.profileDisplayName !== a.profileId
        ? ` (${a.profileDisplayName})`
        : "";
    return `- ${a.harnessId}/${a.profileId ?? "default"}${label} · ${a.requestedModel ?? "default model"} · ${a.attemptId} try ${a.tryIndex + 1} · ${a.phase.replace("_", " ")} · ${a.category}: ${a.error}`;
  });
  return `${message}\n\nAccount attempts:\n${lines.join("\n")}`;
}

/** A failure terminal's message and list from its attempts, in one step. */
export function poolFailure(
  message: string,
  items: readonly { poolAttempts?: readonly PoolAttemptFailure[] }[],
): { message: string; poolAttempts: PoolAttemptFailure[] } {
  const poolAttempts = poolAttemptsOf(items);
  return { message: withPoolAttempts(message, poolAttempts), poolAttempts };
}

/** An in-run `route.profile.rotation_exhausted`: each candidate keeps its
 * rejection facts and gains its own failed tries; the ordered list rides
 * beside, so a row deleted mid-run still names its failure exactly once. */
export function withRotationAttempts(
  payload: Record<string, unknown>,
  attempts: readonly PoolAttemptFailure[],
): Record<string, unknown> {
  const candidates = Array.isArray(payload["candidates"])
    ? (payload["candidates"] as Record<string, unknown>[])
    : [];
  return {
    ...payload,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      attempt_failures: attempts.filter((a) => a.profileId === candidate["profile_id"]),
    })),
    pool_attempts: attempts,
  };
}
