/** run-deadline/1: the warden takes over a thread preparation's scope before its first Git child. */
import { describe, expect, it } from "vitest";
import type { DaemonRunScopeIndex } from "./run-scope-index.js";
import { threadPreparationScope } from "./thread-preparation-scope.js";

const MARKER = `CLAUDEXOR_RUN_SCOPE_${"f".repeat(32)}`;

function index(log: string[]): DaemonRunScopeIndex {
  return {
    open: async () => {
      log.push("open");
      return { marker: MARKER };
    },
    settle: async () => {
      log.push("settle");
      return { settled: true } as never;
    },
    list: () => [],
  } as unknown as DaemonRunScopeIndex;
}

describe("threadPreparationScope deadline hand-off", () => {
  it("hands the marker over after it is recorded and before the scope is returned", async () => {
    const log: string[] = [];
    const scope = threadPreparationScope(index(log), "job-1", async (marker) => {
      log.push(`attach ${marker}`);
    });
    await expect(scope.openScope()).resolves.toEqual({ marker: MARKER });
    expect(log).toEqual(["open", `attach ${MARKER}`]);
  });

  it("refuses the preparation when the hand-off fails, and settles what it opened", async () => {
    const log: string[] = [];
    const scope = threadPreparationScope(index(log), "job-1", async () => {
      throw Object.assign(new Error("deadline passed"), { code: "run_deadline_expired" });
    });
    const failure = await scope.openScope().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "run_deadline_expired" });
    await scope.closeAfter(failure);
    expect(log).toEqual(["open", "settle"]);
  });
});
