import { ControlSetupJob as ControlSetupJobSchema, type ControlSetupJob } from "@claudexor/schema";

const ALLOWED_STATE_TRANSITIONS: Record<
  ControlSetupJob["state"],
  ReadonlySet<ControlSetupJob["state"]>
> = {
  queued: new Set([
    "queued",
    "running",
    "waiting_for_input",
    "failed",
    "cancelled",
    "timed_out",
    "interrupted_unknown",
    "not_supported",
  ]),
  running: new Set([
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "interrupted_unknown",
  ]),
  waiting_for_input: new Set([
    "waiting_for_input",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "interrupted_unknown",
  ]),
  succeeded: new Set(),
  failed: new Set(["failed"]),
  cancelled: new Set(),
  timed_out: new Set(),
  interrupted_unknown: new Set(),
  not_supported: new Set(),
};

const IMMUTABLE_FIELDS = [
  "jobId",
  "harness",
  "action",
  "createdAt",
  "guideUrl",
] as const satisfies readonly (keyof ControlSetupJob)[];

const ALLOWED_PHASE_TRANSITIONS: Record<
  NonNullable<ControlSetupJob["phase"]>,
  ReadonlySet<NonNullable<ControlSetupJob["phase"]>>
> = {
  preparing: new Set(["preparing", "launching", "completed"]),
  launching: new Set(["launching", "awaiting_user", "cancelling", "completed"]),
  awaiting_user: new Set(["awaiting_user", "verifying", "cancelling", "completed"]),
  verifying: new Set(["verifying", "cancelling", "completed"]),
  cancelling: new Set(["cancelling", "completed"]),
  completed: new Set(["completed"]),
};

const OUTCOME_STATE: Record<
  NonNullable<ControlSetupJob["outcome"]>["reason"],
  ControlSetupJob["state"]
> = {
  completed: "succeeded",
  not_supported: "not_supported",
  launch_failed: "failed",
  command_failed: "failed",
  auth_not_ready: "failed",
  capability_verification_failed: "failed",
  credential_route_mismatch: "failed",
  timed_out: "timed_out",
  cancelled_by_user: "cancelled",
  cancelled_on_restart: "cancelled",
  interrupted: "failed",
  interrupted_unknown: "interrupted_unknown",
  termination_unconfirmed: "failed",
};

export class SetupTransitionError extends Error {
  readonly code = "invalid_setup_transition";
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "SetupTransitionError";
  }
}

export function initialSetupJob(raw: unknown): ControlSetupJob {
  const job = ControlSetupJobSchema.parse(raw);
  if (job.state !== "queued" || job.phase !== "preparing") {
    throw new SetupTransitionError("a setup job must begin queued in the preparing phase");
  }
  assertNonterminalShape(job);
  assertActiveStatePhase(job);
  assertChronology(job);
  return job;
}

export function reduceSetupJob(current: ControlSetupJob, rawNext: unknown): ControlSetupJob {
  const next = ControlSetupJobSchema.parse(rawNext);
  for (const field of IMMUTABLE_FIELDS) {
    if (JSON.stringify(next[field]) !== JSON.stringify(current[field])) {
      throw new SetupTransitionError(`setup field '${field}' is immutable`);
    }
  }
  if (!ALLOWED_STATE_TRANSITIONS[current.state].has(next.state)) {
    throw new SetupTransitionError(
      `invalid setup state transition ${current.state} -> ${next.state}`,
    );
  }
  if (!current.phase || !next.phase || !ALLOWED_PHASE_TRANSITIONS[current.phase].has(next.phase)) {
    throw new SetupTransitionError(
      `invalid setup phase transition ${current.phase ?? "missing"} -> ${next.phase ?? "missing"}`,
    );
  }
  if (isTerminal(current.state)) assertTerminalReconciliation(current, next);
  if (current.startedAt !== null && next.startedAt !== current.startedAt) {
    throw new SetupTransitionError("setup startedAt is immutable once observed");
  }
  if (current.deadlineAt !== undefined && next.deadlineAt === undefined) {
    throw new SetupTransitionError("setup deadlineAt cannot disappear once issued");
  }
  if (
    current.deadlineAt !== undefined &&
    next.deadlineAt !== undefined &&
    Date.parse(next.deadlineAt) < Date.parse(current.deadlineAt)
  ) {
    throw new SetupTransitionError("setup deadlineAt cannot move backwards");
  }
  assertExecutionTransition(current, next);
  assertAuthorizationTransition(current, next);
  assertNativeCommandTransition(current, next);
  assertAuthCapabilityTransition(current, next);
  if (isTerminal(next.state)) {
    if (next.phase !== "completed" || !next.outcome || next.finishedAt === null) {
      throw new SetupTransitionError(
        "terminal setup jobs require completed phase, outcome and finishedAt",
      );
    }
    if (OUTCOME_STATE[next.outcome.reason] !== next.state) {
      throw new SetupTransitionError(
        `outcome '${next.outcome.reason}' is invalid for terminal state '${next.state}'`,
      );
    }
  } else {
    assertNonterminalShape(next);
    assertActiveStatePhase(next);
  }
  assertChronology(next);
  return next;
}

function assertTerminalReconciliation(current: ControlSetupJob, next: ControlSetupJob): void {
  if (
    current.state !== "failed" ||
    current.phase !== "completed" ||
    current.outcome?.reason !== "termination_unconfirmed" ||
    current.terminationReconciliation ||
    next.terminationReconciliation?.status !== "empty"
  ) {
    throw new SetupTransitionError("terminal setup jobs are immutable outside reconciliation");
  }
  const { terminationReconciliation: _before, message: _beforeMessage, ...before } = current;
  const { terminationReconciliation: _after, message: _afterMessage, ...after } = next;
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new SetupTransitionError("termination reconciliation cannot rewrite setup evidence");
  }
}

function assertNonterminalShape(job: ControlSetupJob): void {
  if (job.outcome !== undefined || job.finishedAt !== null) {
    throw new SetupTransitionError("nonterminal setup jobs cannot carry terminal outcome fields");
  }
}

function assertActiveStatePhase(job: ControlSetupJob): void {
  const phase = job.phase;
  const valid =
    job.state === "queued"
      ? phase === "preparing"
      : job.state === "running"
        ? phase === "verifying" || phase === "cancelling"
        : phase === "launching" || phase === "awaiting_user" || phase === "cancelling";
  if (!valid)
    throw new SetupTransitionError(
      `setup state '${job.state}' is incompatible with phase '${phase ?? "missing"}'`,
    );
  if (
    job.execution?.permitIssuedAt !== undefined &&
    !["launching", "awaiting_user", "verifying", "cancelling"].includes(job.phase)
  ) {
    throw new SetupTransitionError(
      "a live execution permit is incompatible with the current setup phase",
    );
  }
}

function isTerminal(state: ControlSetupJob["state"]): boolean {
  return !["queued", "running", "waiting_for_input"].includes(state);
}

function assertChronology(job: ControlSetupJob): void {
  const created = Date.parse(job.createdAt);
  const started = job.startedAt === null ? null : Date.parse(job.startedAt);
  const finished = job.finishedAt === null ? null : Date.parse(job.finishedAt);
  const deadline = job.deadlineAt === undefined ? null : Date.parse(job.deadlineAt);
  if (started !== null && started < created)
    throw new SetupTransitionError("setup startedAt precedes createdAt");
  if (finished !== null && finished < (started ?? created)) {
    throw new SetupTransitionError("setup finishedAt precedes prior lifecycle evidence");
  }
  if (deadline !== null && deadline < (started ?? created)) {
    throw new SetupTransitionError("setup deadlineAt precedes the active lifecycle");
  }
  if (
    job.state === "queued" &&
    (job.startedAt !== null ||
      job.finishedAt !== null ||
      job.deadlineAt !== undefined ||
      job.execution !== undefined ||
      job.authorization !== undefined ||
      job.nativeCommand !== undefined)
  ) {
    throw new SetupTransitionError(
      "a queued setup job cannot carry execution or timestamp evidence",
    );
  }
  if (job.execution) {
    const observed = Date.parse(job.execution.observedAt);
    const permit =
      job.execution.permitIssuedAt === undefined ? null : Date.parse(job.execution.permitIssuedAt);
    if (started === null || observed < started || (deadline !== null && observed > deadline)) {
      throw new SetupTransitionError(
        "setup process-group observation is outside the active launch window",
      );
    }
    if (permit !== null && (permit < observed || (deadline !== null && permit > deadline))) {
      throw new SetupTransitionError(
        "setup execution permit is outside the observed launch window",
      );
    }
  }
  if (job.authorization) {
    if (
      job.execution &&
      (job.execution.executionId !== job.authorization.executionId ||
        job.execution.commandDigest !== job.authorization.commandDigest ||
        job.execution.manifestDigest !== job.authorization.manifestDigest)
    ) {
      throw new SetupTransitionError(
        "setup execution evidence contradicts its command authorization",
      );
    }
  }
}

function assertNativeCommandTransition(current: ControlSetupJob, next: ControlSetupJob): void {
  if (!current.nativeCommand) {
    if (!next.nativeCommand) return;
    if (!["launching", "awaiting_user"].includes(current.phase)) {
      throw new SetupTransitionError(
        "native command evidence may first appear only while completing a login handoff",
      );
    }
    return;
  }
  if (!next.nativeCommand)
    throw new SetupTransitionError("native command evidence cannot disappear");
  if (JSON.stringify(current.nativeCommand) !== JSON.stringify(next.nativeCommand)) {
    throw new SetupTransitionError("native command evidence is immutable once journaled");
  }
}

function assertExecutionTransition(current: ControlSetupJob, next: ControlSetupJob): void {
  if (!current.execution) {
    if (!next.execution) return;
    if (current.phase !== "launching" || next.phase !== "launching") {
      throw new SetupTransitionError(
        "process-group evidence may first appear only during login launch",
      );
    }
    if (next.execution.permitIssuedAt !== undefined) {
      throw new SetupTransitionError(
        "process-group observation and execution permit require separate durable transitions",
      );
    }
    return;
  }
  if (!next.execution) throw new SetupTransitionError("setup execution evidence cannot disappear");
  for (const field of ["executionId", "processGroup", "observedAt"] as const) {
    if (JSON.stringify(current.execution[field]) !== JSON.stringify(next.execution[field])) {
      throw new SetupTransitionError(`setup execution field '${field}' is immutable`);
    }
  }
  if (
    current.execution.permitIssuedAt !== undefined &&
    next.execution.permitIssuedAt !== current.execution.permitIssuedAt
  ) {
    throw new SetupTransitionError("setup execution permit timestamp is immutable once issued");
  }
}

function assertAuthorizationTransition(current: ControlSetupJob, next: ControlSetupJob): void {
  if (!current.authorization) {
    if (!next.authorization) return;
    if (
      current.state !== "queued" ||
      current.phase !== "preparing" ||
      next.state !== "waiting_for_input" ||
      next.phase !== "launching"
    ) {
      throw new SetupTransitionError(
        "command authorization may first appear only at the login handoff transition",
      );
    }
    return;
  }
  if (!next.authorization)
    throw new SetupTransitionError("setup command authorization cannot disappear");
  if (JSON.stringify(current.authorization) !== JSON.stringify(next.authorization)) {
    throw new SetupTransitionError("setup command authorization is immutable");
  }
}

function assertAuthCapabilityTransition(current: ControlSetupJob, next: ControlSetupJob): void {
  const before = current.authCapability;
  const after = next.authCapability;
  if (!before || !after) {
    if (before !== after)
      throw new SetupTransitionError("setup auth capability lifecycle cannot appear or disappear");
    return;
  }
  for (const field of ["attemptId", "challengeDigest", "requestDigest", "disclosure"] as const) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      throw new SetupTransitionError(`setup auth capability field '${field}' is immutable`);
    }
  }
  const allowed = {
    disclosed: new Set(["disclosed", "running"]),
    running: new Set(["running", "completed", "interrupted_unknown"]),
    completed: new Set(["completed"]),
    interrupted_unknown: new Set(["interrupted_unknown"]),
  } as const;
  if (!allowed[before.state].has(after.state as never)) {
    throw new SetupTransitionError(
      `invalid auth capability transition ${before.state} -> ${after.state}`,
    );
  }
  if (before.state === after.state && JSON.stringify(before) !== JSON.stringify(after)) {
    throw new SetupTransitionError(`auth capability state '${before.state}' is immutable`);
  }
}
