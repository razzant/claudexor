import {
  isModelOperation,
  type JobAdmission,
  type JobAdmissionActivity,
  type JobAdmissionBlocker,
  type JobAdmissionClass,
  type RuntimeConcurrencyCaps,
} from "@claudexor/schema";
import type { JobRecord } from "./job-record.js";
import { isDelegatedChildRecord } from "./delegation-admission.js";

/** Compact facts of one accepted live job; no prompt/result body is retained. */
export interface AdmissionJob {
  id: string;
  class: JobAdmissionClass;
  threadId?: string;
  delegated: boolean;
}
export function admissionJob(record: JobRecord): AdmissionJob {
  const threadId = (record.params as { threadId?: unknown } | null)?.threadId;
  return {
    id: record.id,
    class: isModelOperation(record.params) ? "model" : "non_model",
    ...(typeof threadId === "string" && threadId ? { threadId } : {}),
    delegated: isDelegatedChildRecord(record),
  };
}

export function admissionActivity(
  active: Iterable<AdmissionJob>,
  queued: Iterable<AdmissionJob>,
): JobAdmissionActivity {
  const count = (jobs: Iterable<AdmissionJob>) => {
    const counts = { model: 0, non_model: 0 };
    for (const job of jobs) counts[job.class]++;
    return counts;
  };
  return { active: count(active), queued: count(queued) };
}

export function admissionContext(jobs: Iterable<AdmissionJob>) {
  const active = { model: 0, non_model: 0 };
  const threads = new Set<string>();
  let delegated = false;
  for (const job of jobs) {
    active[job.class]++;
    if (job.threadId) threads.add(job.threadId);
    delegated ||= job.delegated;
  }
  return { active, threads, delegated };
}

/** The existing Delegate exception bypasses finite admission limits once, never
 * same-thread serialization. Ordinary work uses both its class and global cap. */
export function admissionBlockers(
  job: AdmissionJob,
  context: ReturnType<typeof admissionContext>,
  caps: RuntimeConcurrencyCaps,
  stopping = false,
): JobAdmissionBlocker[] {
  const blockers: JobAdmissionBlocker[] = [];
  if (stopping) blockers.push({ kind: "stopping" });
  if (job.threadId && context.threads.has(job.threadId)) blockers.push({ kind: "thread_busy" });
  if (!job.delegated || context.delegated) {
    if (
      caps.max_concurrent !== "unlimited" &&
      context.active.model + context.active.non_model >= caps.max_concurrent
    )
      blockers.push({ kind: "global_limit", limit: caps.max_concurrent });
    const limit =
      job.class === "model"
        ? caps.max_concurrent_model_operations
        : caps.max_concurrent_non_model_jobs;
    if (limit !== "unlimited" && context.active[job.class] >= limit)
      blockers.push({ kind: "class_limit", limit });
  }
  return blockers;
}

export function queuedAdmission(
  job: AdmissionJob,
  active: Iterable<AdmissionJob>,
  caps: RuntimeConcurrencyCaps,
  stopping: boolean,
): JobAdmission {
  return {
    class: job.class,
    phase: "queued",
    blockers: admissionBlockers(job, admissionContext(active), caps, stopping),
  };
}

/** Select from the caller's one queue, without changing it or owning a runner. */
export function eligibleJobIndex(
  queue: readonly AdmissionJob[],
  active: Iterable<AdmissionJob>,
  caps: RuntimeConcurrencyCaps,
): number {
  const context = admissionContext(active);
  const eligible = (job: AdmissionJob) => admissionBlockers(job, context, caps).length === 0;
  const child = queue.findIndex((job) => job.delegated && eligible(job));
  return child === -1 ? queue.findIndex(eligible) : child;
}
