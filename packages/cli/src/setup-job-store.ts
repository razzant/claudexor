import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import {
  DurableJournal,
  JournalRecoveryRequiredError,
  type JournalRecoveryState,
} from "@claudexor/journal";
import {
  ControlSetupJob as ControlSetupJobSchema,
  ControlSetupJobEvent,
  TERMINAL_CONTROL_SETUP_JOB_STATES,
  type ControlSetupJob,
  type ControlSetupJobListFilter,
  type ControlSetupJobSnapshot,
} from "@claudexor/schema";
import { ensureCanonicalPrivateDirectory, hashJson, redactSecrets } from "@claudexor/util";
import { initialSetupJob, reduceSetupJob } from "./setup-job-reducer.js";

export const ACTIVE_SETUP_STATES = new Set<ControlSetupJob["state"]>([
  "queued",
  "running",
  "waiting_for_input",
]);
export const TERMINAL_SETUP_STATES = new Set<ControlSetupJob["state"]>([
  ...TERMINAL_CONTROL_SETUP_JOB_STATES,
]);

export interface SetupJobPaths {
  dir: string;
  manifest: string;
  runnerState: string;
  runnerResult: string;
  runnerPermit: string;
  command: string;
}

export interface SetupJobStoreOptions {
  now?: () => Date;
  journal?: DurableJournal;
}

interface SetupCreateIdempotency {
  key: string;
  client: string;
  request: unknown;
}

interface SetupCreateBinding {
  keyDigest: string;
  requestDigest: string;
  jobId: string;
}

type SetupJournalPayload = {
  job?: unknown;
  jobId?: unknown;
  line?: unknown;
  binding?: unknown;
};
const MAX_LOG_RECORD_BYTES = 16 * 1024;

/**
 * Setup lifecycle projection over the daemon's global durable journal.
 *
 * Per-job directories contain only operational artifacts (runner handshake
 * and command launcher). They never contain a job snapshot,
 * event ledger or sequence metadata and cannot become a second authority.
 */
export class SetupJobStore {
  readonly artifactsDir: string;
  readonly journal: DurableJournal;
  private readonly jobs = new Map<string, ControlSetupJob>();
  private readonly createByKey = new Map<string, { requestDigest: string; jobId: string }>();
  private readonly now: () => Date;
  private semanticRecovery: Extract<JournalRecoveryState, { status: "recovery_required" }> | null =
    null;

  constructor(
    readonly rootDir: string,
    opts: SetupJobStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    ensurePrivateRealDirectory(rootDir, "daemon data root");
    this.artifactsDir = join(rootDir, "setup-artifacts");
    ensurePrivateRealDirectory(this.artifactsDir, "setup artifacts root");
    if (realpathSync(this.artifactsDir).startsWith(realpathSync(rootDir) + sep) === false) {
      throw new Error("setup artifacts root escapes daemon data root");
    }
    this.journal =
      opts.journal ??
      new DurableJournal({
        rootDir: join(rootDir, "journal"),
        partition: "global",
        now: this.now,
      });
    if (this.journal.options.partition !== "global") {
      throw new Error(
        `setup lifecycle requires the global journal, received '${this.journal.options.partition}'`,
      );
    }
    this.rebuild();
  }

  paths(jobId: string): SetupJobPaths {
    if (!/^setup-[A-Za-z0-9-]+$/.test(jobId)) {
      throw new Error(`unsafe setup job id: ${jobId}`);
    }
    const dir = join(this.artifactsDir, jobId);
    if (!dir.startsWith(this.artifactsDir + sep)) {
      throw new Error(`setup job path escapes store: ${jobId}`);
    }
    return {
      dir,
      manifest: join(dir, "runner-manifest.json"),
      runnerState: join(dir, "runner-state.json"),
      runnerResult: join(dir, "runner-result.json"),
      runnerPermit: join(dir, "runner-permit.json"),
      command: join(dir, "login.command"),
    };
  }

  recoveryState(): JournalRecoveryState {
    if (!this.semanticRecovery) return this.journal.state();
    return {
      ...this.semanticRecovery,
      location: { ...this.semanticRecovery.location },
    };
  }

  validateProjection(): void {
    this.assertAvailable();
  }

  create(job: ControlSetupJob, idempotency?: SetupCreateIdempotency): ControlSetupJob {
    this.assertAvailable();
    if (this.jobs.has(job.jobId)) throw new Error(`setup job already exists: ${job.jobId}`);
    return this.persist(
      initialSetupJob(job),
      idempotency ? this.newBinding(job.jobId, idempotency) : undefined,
    );
  }

  resolveCreate(idempotency: SetupCreateIdempotency): ControlSetupJob | null {
    this.assertAvailable();
    const binding = this.newBinding("pending", idempotency);
    const prior = this.createByKey.get(binding.keyDigest);
    if (!prior) return null;
    if (prior.requestDigest !== binding.requestDigest) throw idempotencyConflict();
    return this.status(prior.jobId);
  }

  bindCreate(jobId: string, idempotency: SetupCreateIdempotency): ControlSetupJob {
    this.assertAvailable();
    const job = this.status(jobId);
    const binding = this.newBinding(jobId, idempotency);
    const prior = this.createByKey.get(binding.keyDigest);
    if (prior) {
      if (prior.requestDigest !== binding.requestDigest) throw idempotencyConflict();
      return this.status(prior.jobId);
    }
    this.journal.append<SetupJournalPayload>("setup.job.create_bound", { binding });
    this.rememberBinding(binding);
    return job;
  }

  private persist(job: ControlSetupJob, binding?: SetupCreateBinding): ControlSetupJob {
    this.assertAvailable();
    this.ensureJobDir(this.paths(job.jobId).dir);
    this.journal.append<SetupJournalPayload>("setup.job.saved", { job, binding });
    const stored = cloneJob(job);
    this.jobs.set(job.jobId, stored);
    if (binding) this.rememberBinding(binding);
    return cloneJob(stored);
  }

  update(jobId: string, patch: Partial<ControlSetupJob>): ControlSetupJob {
    const current = this.jobs.get(jobId);
    if (!current) throw Object.assign(new Error("setup job not found"), { status: 404 });
    return this.persist(reduceSetupJob(current, { ...current, ...patch }));
  }

  status(jobId: string): ControlSetupJob {
    this.assertAvailable();
    const job = this.jobs.get(jobId);
    if (!job) throw Object.assign(new Error("setup job not found"), { status: 404 });
    return cloneJob(job);
  }

  list(filter?: ControlSetupJobListFilter): ControlSetupJob[] {
    this.assertAvailable();
    let rows = [...this.jobs.values()];
    if (filter?.harness) rows = rows.filter((job) => job.harness === filter.harness);
    if (filter?.action) rows = rows.filter((job) => job.action === filter.action);
    if (filter?.active !== undefined) {
      rows = rows.filter(
        (job) => filter.active === (job.phase !== undefined && ACTIVE_SETUP_STATES.has(job.state)),
      );
    }
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (filter?.limit !== undefined && rows.length > filter.limit) {
      rows = rows.slice(-filter.limit);
    }
    return rows.map(cloneJob);
  }

  snapshot(jobId: string): ControlSetupJobSnapshot {
    this.assertAvailable();
    return {
      job: this.status(jobId),
      cursor: this.journal.currentCursor(),
      sequence: this.journal.currentSequence(),
    };
  }

  events(jobId: string, afterCursor?: string | null) {
    this.assertAvailable();
    this.status(jobId);
    const afterSeq = this.journal.sequenceAfter(afterCursor);
    let previousCursor = afterCursor ?? null;
    const events: ControlSetupJobEvent[] = [];
    for (const record of this.journal.records<SetupJournalPayload>(afterSeq)) {
      if (record.type !== "setup.job.saved") continue;
      const parsed = ControlSetupJobSchema.safeParse(record.payload?.job);
      if (!parsed.success || parsed.data.jobId !== jobId) continue;
      const cursor = this.journal.cursorFor(record);
      events.push(
        ControlSetupJobEvent.parse({
          jobId,
          cursor,
          previousCursor,
          sequence: record.seq,
          time: record.time,
          kind: "status",
          state: parsed.data.state,
          message: parsed.data.message,
          job: parsed.data,
        }),
      );
      previousCursor = cursor;
    }
    return events;
  }

  appendLog(jobId: string, line: string): void {
    this.assertAvailable();
    if (!this.jobs.has(jobId)) return;
    const redacted = `[${this.now().toISOString()}] ${redactSecrets(line)}`;
    const bytes = Buffer.from(redacted, "utf8");
    const bounded =
      bytes.length <= MAX_LOG_RECORD_BYTES
        ? redacted
        : `${bytes.subarray(0, MAX_LOG_RECORD_BYTES).toString("utf8")}\n[output truncated at ${MAX_LOG_RECORD_BYTES} bytes]`;
    this.journal.append<SetupJournalPayload>("setup.job.log", { jobId, line: bounded });
  }

  private rebuild(): void {
    if (this.journal.state().status === "recovery_required") return;
    for (const record of this.journal.records<SetupJournalPayload>()) {
      if (record.type === "setup.job.log") {
        if (
          typeof record.payload?.jobId !== "string" ||
          !/^setup-[A-Za-z0-9-]+$/.test(record.payload.jobId) ||
          typeof record.payload.line !== "string" ||
          Buffer.byteLength(record.payload.line, "utf8") > MAX_LOG_RECORD_BYTES + 128
        ) {
          this.semanticRecovery = {
            status: "recovery_required",
            location: { kind: "cursor", epoch: record.epoch, seq: record.seq },
            reason: `invalid setup.job.log payload at journal seq ${record.seq}`,
            discardedTailBytes: 0,
          };
          return;
        }
        continue;
      }
      if (record.type === "setup.job.create_bound") {
        const binding = parseBinding(record.payload?.binding);
        if (!binding || !this.jobs.has(binding.jobId)) {
          this.failSemantic(record, "invalid setup.job.create_bound payload");
          return;
        }
        this.rememberBinding(binding);
        continue;
      }
      if (record.type !== "setup.job.saved") continue;
      const parsed = ControlSetupJobSchema.safeParse(record.payload?.job);
      if (!parsed.success) {
        this.semanticRecovery = {
          status: "recovery_required",
          location: { kind: "cursor", epoch: record.epoch, seq: record.seq },
          reason: `invalid setup.job.saved payload at journal seq ${record.seq}`,
          discardedTailBytes: 0,
        };
        return;
      }
      try {
        const current = this.jobs.get(parsed.data.jobId);
        const next = current ? reduceSetupJob(current, parsed.data) : initialSetupJob(parsed.data);
        this.jobs.set(next.jobId, cloneJob(next));
        if (record.payload?.binding !== undefined) {
          const binding = parseBinding(record.payload.binding);
          if (!binding || binding.jobId !== next.jobId) {
            this.failSemantic(record, "invalid setup create binding");
            return;
          }
          this.rememberBinding(binding);
        }
      } catch (error) {
        this.semanticRecovery = {
          status: "recovery_required",
          location: { kind: "cursor", epoch: record.epoch, seq: record.seq },
          reason: `invalid setup lifecycle transition at journal seq ${record.seq}: ${error instanceof Error ? error.message : String(error)}`,
          discardedTailBytes: 0,
        };
        return;
      }
    }
    // Partition-level recovery is acknowledged only by the global recovery
    // coordinator after every registered projection has validated the prefix.
  }

  private newBinding(jobId: string, input: SetupCreateIdempotency): SetupCreateBinding {
    if (!input.key.trim() || input.key.length > 256) {
      throw Object.assign(new Error("invalid Idempotency-Key"), { status: 400 });
    }
    return {
      keyDigest: hashJson({
        client: input.client,
        partition: "global",
        operation: "setup.job.create",
        key: input.key,
      }),
      requestDigest: hashJson(input.request),
      jobId,
    };
  }

  private rememberBinding(binding: SetupCreateBinding): void {
    const prior = this.createByKey.get(binding.keyDigest);
    if (prior && (prior.requestDigest !== binding.requestDigest || prior.jobId !== binding.jobId)) {
      throw idempotencyConflict();
    }
    this.createByKey.set(binding.keyDigest, {
      requestDigest: binding.requestDigest,
      jobId: binding.jobId,
    });
  }

  private failSemantic(record: { epoch: string; seq: number }, reason: string): void {
    this.semanticRecovery = {
      status: "recovery_required",
      location: { kind: "cursor", epoch: record.epoch, seq: record.seq },
      reason: `${reason} at journal seq ${record.seq}`,
      discardedTailBytes: 0,
    };
  }

  private assertAvailable(): void {
    const recovery = this.recoveryState();
    if (recovery.status === "recovery_required") {
      throw new JournalRecoveryRequiredError(recovery);
    }
  }

  private ensureJobDir(dir: string): void {
    if (existsSync(dir)) {
      if (!this.validExistingJobDir(dir)) {
        throw new Error(`refusing unsafe setup job directory: ${dir}`);
      }
    } else {
      mkdirSync(dir, { recursive: false, mode: 0o700 });
    }
    chmodSync(dir, 0o700);
  }

  private validExistingJobDir(dir: string): boolean {
    try {
      const stat = lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      const root = realpathSync(this.artifactsDir);
      return realpathSync(dir).startsWith(root + sep);
    } catch {
      return false;
    }
  }
}

function parseBinding(value: unknown): SetupCreateBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row["keyDigest"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(row["keyDigest"]) ||
    typeof row["requestDigest"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(row["requestDigest"]) ||
    typeof row["jobId"] !== "string" ||
    !/^setup-[A-Za-z0-9-]+$/.test(row["jobId"])
  )
    return null;
  return {
    keyDigest: row["keyDigest"],
    requestDigest: row["requestDigest"],
    jobId: row["jobId"],
  };
}

function idempotencyConflict(): Error {
  return Object.assign(new Error("Idempotency-Key was already used with a different request"), {
    code: "idempotency_conflict",
    status: 409,
  });
}

function ensurePrivateRealDirectory(path: string, label: string): void {
  try {
    ensureCanonicalPrivateDirectory(path);
  } catch (error) {
    throw new Error(
      `${label} is unsafe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function cloneJob(job: ControlSetupJob): ControlSetupJob {
  return ControlSetupJobSchema.parse(JSON.parse(JSON.stringify(job)));
}
