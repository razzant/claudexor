/** run-deadline/1: the warden takes over a thread preparation's scope before its first Git child. */
import { describe, expect, it } from "vitest";
import { onChildProcessRegistered, runCaptureRaw } from "@claudexor/core";
import type { DaemonRunScopeIndex } from "./run-scope-index.js";
import { preparationGitCapability, threadPreparationScope } from "./thread-preparation-scope.js";

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

describe("a thread turn's Git preflight", () => {
  it("opens the preparation scope once, hands it over, then launches its Git child inside it", async () => {
    const log: string[] = [];
    const scope = threadPreparationScope(index(log), "job-1", async (marker) => {
      log.push(`attach ${marker}`);
    });
    const registered: Array<string | undefined> = [];
    const stop = onChildProcessRegistered((child) => {
      log.push("launch");
      registered.push(child.scopeMarker);
    });
    try {
      const capability = preparationGitCapability(scope, new AbortController().signal, async () => {
        // The probe's own launch, as `probeGitCapability` makes it (no marker in its env).
        await runCaptureRaw(process.execPath, ["-e", ""], { timeoutMs: 10_000 });
        return { status: "available", version: "git version x", detail: null, remediation: null };
      });
      await capability();
      // The worktree preparation that follows reuses the same scope.
      await scope.openScope();
    } finally {
      stop();
    }
    expect(log).toEqual(["open", `attach ${MARKER}`, "launch"]);
    expect(registered).toEqual([MARKER]);
  });

  it("passes the job's abort to the probe", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    await preparationGitCapability(
      threadPreparationScope(index([]), "job-1"),
      controller.signal,
      async (deps) => {
        seen = deps?.abortSignal;
        return { status: "available", version: null, detail: null, remediation: null };
      },
    )();
    expect(seen).toBe(controller.signal);
  });
});
