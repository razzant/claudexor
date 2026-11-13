import { describe, expect, it } from "vitest";
import { candidateStatusInRouteContext } from "./routeContext.js";
import { cancelledResult } from "./runTerminals.js";

describe("scoped route probe fails CLOSED on absent evidence (release wave sol #1)", () => {
  it("a null scoped probe never admits the route via host readiness", async () => {
    const host = {
      id: "claude",
      status: "ok",
      manifest: { id: "claude" },
    } as never;
    const statusById = new Map([["claude", host]]);
    const result = await candidateStatusInRouteContext(
      { routeStatus: async () => null },
      { cwd: "/tmp/scoped", env: {} } as never,
      "claude",
      "auto",
      statusById,
    );
    expect(result).toBeUndefined();
    // The host cache is left untouched — absent scoped evidence is not a
    // verdict about the host env.
    expect(statusById.get("claude")).toBe(host);
  });

  it("uses the harness-specific lane env for the scoped readiness probe", async () => {
    const host = {
      id: "claude",
      status: "ok",
      manifest: { id: "claude" },
    } as never;
    const scoped = {
      id: "claude",
      status: "ok",
      manifest: { id: "claude" },
    } as never;
    const statusById = new Map([["claude", host]]);
    const seen: unknown[] = [];
    const result = await candidateStatusInRouteContext(
      {
        routeStatus: async (_id, spec) => {
          seen.push(spec);
          return scoped;
        },
      },
      {
        cwd: "/tmp/scoped",
        env: { HOME: "/tmp/disposable-home" },
        envForHarness: (harnessId) =>
          harnessId === "claude" ? { HOME: "/tmp/durable-claude-home" } : null,
        dispose: async () => {},
      },
      "claude",
      "subscription",
      statusById,
    );

    expect(seen).toEqual([
      {
        cwd: "/tmp/scoped",
        env: { HOME: "/tmp/durable-claude-home" },
        authPreference: "subscription",
        fresh: true,
      },
    ]);
    expect(result).toBe(scoped);
    expect(statusById.get("claude")).toBe(scoped);
  });
});

describe("cancel summary is announced only when it exists (release wave sol #3)", () => {
  const log = () => {
    const events: string[] = [];
    return {
      events,
      emit: (type: string) => {
        events.push(type);
      },
    };
  };

  it("a failed summary write suppresses output.ready but keeps the terminal", () => {
    const sink = log();
    cancelledResult(
      sink as never,
      "run-1",
      "task-1",
      "ask",
      "/tmp/run-1",
      [],
      undefined,
      null,
      undefined,
      {
        writeText: () => {
          throw new Error("disk full");
        },
      } as never,
    );
    expect(sink.events).not.toContain("output.ready");
    expect(sink.events).toContain("run.failed");
  });

  it("a successful write announces output.ready before the terminal", () => {
    const sink = log();
    cancelledResult(
      sink as never,
      "run-1",
      "task-1",
      "ask",
      "/tmp/run-1",
      [],
      undefined,
      null,
      undefined,
      { writeText: () => {} } as never,
    );
    expect(sink.events.indexOf("output.ready")).toBeGreaterThanOrEqual(0);
    expect(sink.events.indexOf("output.ready")).toBeLessThan(sink.events.indexOf("run.failed"));
  });
});
