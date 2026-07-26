import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  RunTelemetry,
  SCHEMA_VERSION,
  requiredActionsFor,
  validateRunFactsInvariants,
  type RunFacts,
  type RunOutcomeFacts,
} from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import type { AnnouncedRunContext } from "./runTerminals.js";
import { buildRunFacts } from "./runFactsBuilder.js";

export { buildRunFacts };

export interface PreparedRunFactsReceipt {
  facts: RunFacts;
  /** Publish telemetry compatibility + the canonical receipt commit marker. */
  commit: () => void;
  /** Restore the exact pre-commit marker/telemetry bytes after event failure. */
  rollback: () => void;
}

interface TextSnapshot {
  existed: boolean;
  text: string;
}

function textSnapshot(path: string): TextSnapshot {
  try {
    return { existed: true, text: readFileSync(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { existed: false, text: "" };
    }
    throw error;
  }
}

function restoreSnapshot(path: string, prior: TextSnapshot): void {
  if (!prior.existed) {
    let removed = false;
    try {
      unlinkSync(path);
      removed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (removed) fsyncParentDirectory(dirname(path));
    return;
  }
  replaceTextAtomically(path, prior.text);
}

function fsyncParentDirectory(parent: string): void {
  const parentFd = openSync(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(parentFd);
  } finally {
    closeSync(parentFd);
  }
}

function replaceTextAtomically(path: string, text: string): void {
  const parent = dirname(path);
  const tmp = join(parent, `.run-facts-restore-${randomUUID()}.tmp`);
  let fileFd: number | null = null;
  try {
    fileFd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fileFd, text, "utf8");
    fsyncSync(fileFd);
    closeSync(fileFd);
    fileFd = null;
    renameSync(tmp, path);
    fsyncParentDirectory(parent);
  } finally {
    if (fileFd !== null) closeSync(fileFd);
    try {
      unlinkSync(tmp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function writeYamlAtomically(ctx: AnnouncedRunContext, path: string, value: unknown): void {
  const parent = dirname(path);
  const tmp = join(parent, `.run-facts-${randomUUID()}.tmp`);
  try {
    ctx.store.writeYaml(tmp, value);
    const fileFd = openSync(tmp, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(fileFd);
    } finally {
      closeSync(fileFd);
    }
    renameSync(tmp, path);
    fsyncParentDirectory(parent);
  } finally {
    try {
      unlinkSync(tmp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function persistPreparedRunFacts(
  ctx: AnnouncedRunContext,
  facts: RunFacts,
): PreparedRunFactsReceipt {
  const telemetryPath = join(ctx.paths.finalDir, "telemetry.yaml");
  const receiptPath = join(ctx.paths.finalDir, "run_facts.yaml");
  const parsedTelemetry = RunTelemetry.safeParse(ctx.store.readYaml(telemetryPath));
  const telemetry = parsedTelemetry.success ? parsedTelemetry.data : null;
  const embedded = telemetry ? RunTelemetry.parse({ ...telemetry, run_facts: facts }) : null;
  let priorTelemetry: TextSnapshot | null = null;
  let priorReceipt: TextSnapshot | null = null;
  let committed = false;
  let rolledBack = false;
  const rollback = () => {
    if (rolledBack) return;
    if (priorReceipt) restoreSnapshot(receiptPath, priorReceipt);
    if (priorTelemetry) restoreSnapshot(telemetryPath, priorTelemetry);
    rolledBack = true;
  };
  const commit = () => {
    if (committed) return;
    if (rolledBack) throw new Error("cannot commit a rolled-back RunFacts receipt");
    priorTelemetry = textSnapshot(telemetryPath);
    priorReceipt = textSnapshot(receiptPath);
    if (embedded) writeYamlAtomically(ctx, telemetryPath, embedded);
    // Land the canonical marker last, after its telemetry compatibility copy.
    writeYamlAtomically(ctx, receiptPath, facts);
    committed = true;
  };
  return { facts, commit, rollback };
}

/**
 * Prepare the validated receipt before terminal append. EventLog owns the
 * commit boundary and invokes rollback if the terminal cannot become durable.
 */
export function prepareRunFactsReceipt(
  ctx: AnnouncedRunContext,
  terminalOutcome: RunOutcomeFacts,
): PreparedRunFactsReceipt {
  return persistPreparedRunFacts(ctx, buildRunFacts(ctx, terminalOutcome));
}

/**
 * A terminal-facts contradiction is itself a failed run. This minimal receipt
 * deliberately does not trust the contradictory artifact graph, but still
 * gives every surface a valid, fail-closed canonical outcome.
 */
export function prepareRunFactsFailureReceipt(
  ctx: AnnouncedRunContext,
  failureOutcome: RunOutcomeFacts,
): PreparedRunFactsReceipt {
  const facts = validateRunFactsInvariants({
    schema_version: SCHEMA_VERSION,
    run_id: ctx.runId,
    task_id: ctx.taskId,
    mode: ctx.mode,
    outcome: failureOutcome,
    deliverable: {
      present: false,
      kind: null,
      path: null,
      producer_attempt_id: null,
    },
    participants: { planners: 0, attempts: [] },
    gates: {
      configured: false,
      required: 0,
      total: 0,
      executed: false,
      state: "not_configured",
      receipt_attempt_id: null,
    },
    review: {
      state: failureOutcome.review,
      blocker_ids: [],
      blockers: 0,
    },
    apply: {
      eligibility: null,
      operator_decision_present: false,
    },
    required_actions: requiredActionsFor(failureOutcome, false),
    generated_at: nowIso(),
  });
  return persistPreparedRunFacts(ctx, facts);
}
