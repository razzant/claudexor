import type { DaemonRunRecord } from "./daemon-server.js";

/** Find a queued/running thread run that can mutate its project tree. */
export function findActiveMutatingThreadRun(
  records: DaemonRunRecord[],
  threadId: string,
): DaemonRunRecord | undefined {
  return records.find((record) => {
    if (record.state !== "queued" && record.state !== "running") return false;
    const params =
      record.params && typeof record.params === "object"
        ? (record.params as Record<string, unknown>)
        : {};
    return (
      params["threadId"] === threadId &&
      (params["mode"] === "agent" ||
        (params["mode"] === "orchestrate" &&
          (params["autonomy"] === "auto_safe" || params["autonomy"] === "auto_full")))
    );
  });
}

export function threadIdOfRun(record: DaemonRunRecord): string | null {
  const params =
    record.params && typeof record.params === "object"
      ? (record.params as Record<string, unknown>)
      : {};
  return typeof params["threadId"] === "string" ? params["threadId"] : null;
}

export async function assertThreadIdle(
  record: DaemonRunRecord,
  listRuns: () => Promise<DaemonRunRecord[]>,
): Promise<void> {
  const threadId = threadIdOfRun(record);
  if (!threadId) return;
  const active = findActiveMutatingThreadRun(await listRuns(), threadId);
  if (active) {
    throw Object.assign(
      new Error(`thread ${threadId} has an active mutating turn (${active.state})`),
      { status: 409, code: "thread_busy" },
    );
  }
}
