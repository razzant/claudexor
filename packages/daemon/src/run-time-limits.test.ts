import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRecord, JobState } from "./job-record.js";
import { RunTimeLimit } from "./run-time-limit.js";
import { RunTimeLimits } from "./run-time-limits.js";

const timers: RunTimeLimit[] = [];
const job = (state: JobState = "running", params: unknown = {}): JobRecord => ({
  id: "job-1",
  state,
  params,
  createdAt: "2026-10-15T12:00:00.000Z",
});
const timer = (): RunTimeLimit => {
  const value = new RunTimeLimit();
  timers.push(value);
  return value;
};
const thrownBy = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the request to be rejected");
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
});
afterEach(() => {
  for (const value of timers.splice(0)) value.dispose();
  vi.useRealTimers();
});

describe("RunTimeLimits scheduler registry", () => {
  it("reads and mutates only the timer owned by the running job", () => {
    const registry = new RunTimeLimits();
    const owned = timer();
    const record = job();
    registry.register(record.id, owned, () => true);
    const lookup = (id: string) => (id === record.id ? record : undefined);

    expect(registry.dispatch({ id: "job-1", request: { action: "read" } }, lookup)).toEqual({
      revision: 0,
      mode: "soft",
      state: "disabled",
      deadlineAt: null,
      reachedAt: null,
    });
    expect(
      registry.dispatch(
        { id: "job-1", request: { action: "set", seconds: 10, expectedRevision: 0 } },
        lookup,
      ),
    ).toMatchObject({
      revision: 1,
      mode: "soft",
      state: "armed",
      deadlineAt: "2026-10-15T12:00:10.000Z",
    });
    expect(
      registry.dispatch(
        { id: "job-1", request: { action: "extend", seconds: 5, expectedRevision: 1 } },
        lookup,
      ),
    ).toMatchObject({ revision: 2, deadlineAt: "2026-10-15T12:00:15.000Z" });
    expect(
      registry.dispatch(
        { id: "job-1", request: { action: "disable", expectedRevision: 2 } },
        lookup,
      ),
    ).toMatchObject({ revision: 3, state: "disabled", deadlineAt: null });
    expect(registry.dispatch({ id: "job-1", request: { action: "read" } }, lookup)).toEqual(
      owned.snapshot(),
    );
  });

  it("rejects a missing job before consulting any timer", () => {
    const registry = new RunTimeLimits();
    registry.register("job-1", timer(), () => true);
    expect(
      thrownBy(() =>
        registry.dispatch({ id: "job-1", request: { action: "read" } }, () => undefined),
      ),
    ).toMatchObject({ code: "run_not_found", status: 404 });
  });

  it.each(["queued", "succeeded", "failed", "cancelled", "interrupted"] as const)(
    "rejects a %s job with no active timer",
    (state) => {
      const registry = new RunTimeLimits();
      const owned = timer();
      registry.register("job-1", owned, () => true);
      const before = owned.snapshot();
      expect(
        thrownBy(() =>
          registry.dispatch(
            { id: "job-1", request: { action: "set", seconds: 10, expectedRevision: 0 } },
            () => job(state),
          ),
        ),
      ).toMatchObject({ code: "run_not_active", status: 409 });
      expect(owned.snapshot()).toEqual(before);
    },
  );

  it("marks a running job whose timer is not registered as retryable", () => {
    const registry = new RunTimeLimits();
    expect(
      thrownBy(() => registry.dispatch({ id: "job-1", request: { action: "read" } }, () => job())),
    ).toMatchObject({ code: "time_limit_not_ready", status: 409, retryable: true });
  });

  it("rejects a cancelled owner even before its job record becomes terminal", () => {
    const registry = new RunTimeLimits();
    const owned = timer();
    registry.register("job-1", owned, () => false);
    expect(
      thrownBy(() => registry.dispatch({ id: "job-1", request: { action: "read" } }, () => job())),
    ).toMatchObject({ code: "run_not_active", status: 409 });
    expect(owned.snapshot().state).toBe("disabled");
  });

  it("rejects stale mutations without changing the current timer", () => {
    const registry = new RunTimeLimits();
    const owned = timer();
    registry.register("job-1", owned, () => true);
    const lookup = () => job();
    registry.dispatch(
      { id: "job-1", request: { action: "set", seconds: 10, expectedRevision: 0 } },
      lookup,
    );
    const before = owned.snapshot();
    expect(
      thrownBy(() =>
        registry.dispatch(
          { id: "job-1", request: { action: "disable", expectedRevision: 0 } },
          lookup,
        ),
      ),
    ).toMatchObject({ code: "time_limit_revision_conflict", status: 409 });
    expect(owned.snapshot()).toEqual(before);
  });

  it.each([
    null,
    [],
    {},
    { id: "" },
    { id: " " },
    { id: 1 },
    { id: "job-1", request: { action: "read" }, extra: true },
  ])("rejects an inexact outer envelope %#", (raw) => {
    const registry = new RunTimeLimits();
    expect(thrownBy(() => registry.dispatch(raw, () => job()))).toMatchObject({
      code: "time_limit_invalid",
      status: 400,
    });
  });

  it("rejects missing and extra request fields before changing a timer", () => {
    const registry = new RunTimeLimits();
    const owned = timer();
    registry.register("job-1", owned, () => true);
    for (const request of [
      undefined,
      { action: "read", extra: true },
      { action: "set", seconds: 10 },
    ]) {
      expect(
        thrownBy(() => registry.dispatch({ id: "job-1", request }, () => job())),
      ).toBeInstanceOf(Error);
      expect(owned.snapshot().revision).toBe(0);
    }
  });

  it("allows delegated reads but forbids delegated mutation", () => {
    const registry = new RunTimeLimits();
    const owned = timer();
    registry.register("job-1", owned, () => true);
    const delegated = () => job("running", { delegatedFromRunId: "parent-1" });
    expect(registry.dispatch({ id: "job-1", request: { action: "read" } }, delegated)).toEqual(
      owned.snapshot(),
    );
    for (const request of [
      { action: "set", seconds: 10, expectedRevision: 0 },
      { action: "extend", seconds: 10, expectedRevision: 0 },
      { action: "disable", expectedRevision: 0 },
    ]) {
      expect(thrownBy(() => registry.dispatch({ id: "job-1", request }, delegated))).toMatchObject({
        code: "delegated_time_limit_forbidden",
        status: 403,
      });
    }
    expect(owned.snapshot().revision).toBe(0);
  });

  it("keeps an external orchestrator's delegated workspace run controllable", () => {
    const registry = new RunTimeLimits();
    registry.register("job-1", timer(), () => true);
    expect(
      registry.dispatch(
        { id: "job-1", request: { action: "set", seconds: 10, expectedRevision: 0 } },
        () =>
          job("running", {
            execution: { delegated: true, workspaceRoot: "/caller/workspace" },
          }),
      ),
    ).toMatchObject({ state: "armed", revision: 1 });
  });

  it("does not treat ordinary parent lineage as delegation authority", () => {
    const registry = new RunTimeLimits();
    registry.register("job-1", timer(), () => true);
    expect(
      registry.dispatch(
        { id: "job-1", request: { action: "set", seconds: 10, expectedRevision: 0 } },
        () => job("running", { parentRunId: "parent-1" }),
      ),
    ).toMatchObject({ state: "armed", revision: 1 });
  });
});
