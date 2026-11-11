import { delegatedParentOf, RunTimeLimitRequest } from "@claudexor/schema";
import type { JobRecord } from "./job-record.js";
import { RunTimeLimit, timeLimitProblem } from "./run-time-limit.js";

/** The scheduler owns which live run may expose its timer; params stay immutable. */
export class RunTimeLimits {
  private readonly owners = new Map<string, { timer: RunTimeLimit; live(): boolean }>();
  register(id: string, timer: RunTimeLimit, live: () => boolean): void {
    if (this.owners.has(id)) throw timeLimitProblem("A run already owns this timer");
    this.owners.set(id, { timer, live });
  }
  close(id: string): void {
    this.owners.get(id)?.timer.dispose();
    this.owners.delete(id);
  }
  dispatch(raw: unknown, lookup: (id: string) => JobRecord | undefined) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw timeLimitProblem("Expected a timer request envelope", "time_limit_invalid", 400);
    const params = raw as Record<string, unknown>;
    if (
      typeof params.id !== "string" ||
      !params.id.trim() ||
      Object.keys(params).some((key) => key !== "id" && key !== "request")
    )
      throw timeLimitProblem(
        "Expected an exact job id and timer request",
        "time_limit_invalid",
        400,
      );
    const request = RunTimeLimitRequest.parse(params.request);
    const record = lookup(params.id);
    if (!record) throw timeLimitProblem("No such run", "run_not_found", 404);
    if (record.state !== "running")
      throw timeLimitProblem("Run has no active timer", "run_not_active");
    if (request.action !== "read" && delegatedParentOf(record.params))
      throw timeLimitProblem(
        "Delegate child timers remain governed by their parent",
        "delegated_time_limit_forbidden",
        403,
      );
    const owner = this.owners.get(record.id);
    if (!owner)
      throw Object.assign(timeLimitProblem("Run timer is not ready", "time_limit_not_ready"), {
        retryable: true,
      });
    if (!owner.live()) throw timeLimitProblem("Run has already been cancelled", "run_not_active");
    return owner.timer.control(request);
  }
}
