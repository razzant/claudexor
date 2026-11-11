import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunWaitManyInput, RunWaitManyResult, type RunWaitManySummary } from "@claudexor/schema";
import { defaultClaudexorTools } from "@claudexor/mcp-server";
import { runsWaitQuery } from "./mcp-runs-wait.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";

const daemon = vi.hoisted(() => ({
  connectDaemonIfRunning: vi.fn(),
  ensureDaemon: vi.fn(),
  enqueueAndAwait: vi.fn(),
}));
vi.mock("./daemon-run.js", () => daemon);

const TOKEN = "A".repeat(43);
const addr = { baseUrl: "http://wait-many.invalid", token: "fixture-token" };
const observed: RunWaitManySummary = {
  status: "interrupted",
  pending: false,
  token: TOKEN,
  problem: null,
};
const unavailable: RunWaitManySummary = {
  status: null,
  pending: null,
  token: null,
  problem: "snapshot_unavailable",
};
const result = (summaries: RunWaitManySummary[] = [observed]): RunWaitManyResult => ({
  wakeReason: "attention",
  attention: [0],
  summaries,
});

describe("runsWaitQuery: one bounded read of existing durable handles", () => {
  const fetch = vi.fn<typeof globalThis.fetch>();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetch);
    daemon.connectDaemonIfRunning.mockResolvedValue({ addr });
    fetch.mockResolvedValue(Response.json(result()));
  });

  afterEach(() => {
    expect(daemon.ensureDaemon).not.toHaveBeenCalled();
    expect(daemon.enqueueAndAwait).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    {},
    { targets: [] },
    { targets: Array.from({ length: 1001 }, () => ({ runId: "r" })) },
    { targets: [{ runId: " \t " }] },
    { targets: [{ runId: "x".repeat(257) }] },
    { targets: [{ runId: 1 }] },
    { targets: [{ runId: "r", seen: "A".repeat(42) }] },
    { targets: [{ runId: "r", seen: `${"A".repeat(42)}=` }] },
    { targets: [{ runId: "r", seen: `${"A".repeat(42)}é` }] },
    { targets: [{ runId: "r", afterSeq: 1 }] },
    { targets: [{ runId: "r" }], afterSeq: 1 },
    { targets: [{ runId: "r" }], waitMs: -1 },
    { targets: [{ runId: "r" }], waitMs: 50_001 },
    { targets: [{ runId: "r" }], waitMs: 1.5 },
    { targets: [{ runId: "r" }], waitMs: "0" },
    { targets: [{ runId: "r" }], waitMs: null },
    { targets: [{ runId: "r" }], waitMs: Infinity },
  ])("rejects malformed input case %# before discovery", async (input) => {
    await expect(runsWaitQuery(input)).rejects.toBeDefined();
    expect(daemon.connectDaemonIfRunning).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends includeBlocking only when true and reads the blocking rows it asked for (#628)", async () => {
    const marked = {
      wakeReason: "attention",
      attention: [0],
      summaries: [
        { status: "running", pending: true, token: TOKEN, problem: null, blocking: true },
      ],
    };
    // A response body is read once: each call gets its own.
    fetch.mockImplementation(async () => Response.json(result()));
    fetch.mockResolvedValueOnce(Response.json(marked));
    const targets = [{ runId: "r" }];
    expect(await runsWaitQuery({ targets, waitMs: 0, includeBlocking: true })).toEqual(marked);
    await runsWaitQuery({ targets, waitMs: 0, includeBlocking: false });
    await runsWaitQuery({ targets, waitMs: 0 });
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { targets, waitMs: 0, includeBlocking: true },
      { targets, waitMs: 0 },
      { targets, waitMs: 0 },
    ]);
    await expect(runsWaitQuery({ targets, includeBlocking: "true" })).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("forwards a null seen that acknowledges a problem row", async () => {
    const input = { targets: [{ runId: "r", seen: null }], waitMs: 0 };
    expect(await runsWaitQuery(input)).toEqual(result());
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual(input);
  });

  it("rejects aggregate JSON bytes before discovery, even with valid individual IDs", async () => {
    const input = {
      targets: Array.from({ length: 1000 }, () => ({ runId: "\u0001".repeat(256) })),
      waitMs: 0,
    };
    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBeGreaterThan(1_048_576);
    await expect(runsWaitQuery(input)).rejects.toBeDefined();
    expect(daemon.connectDaemonIfRunning).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["query", "MCP"] as const)(
    "preserves an exact-1MiB omitted wait through %s normalization and rejects the next byte",
    async (surface) => {
      let controls = 155_910;
      const targets = Array.from({ length: 1000 }, () => {
        const count = Math.min(256, controls);
        controls -= count;
        return { runId: "\u0001".repeat(count) + "x".repeat(256 - count) };
      });
      targets[999]!.runId = "€" + "é".repeat(11) + "x".repeat(244);
      const input = { targets };
      expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBe(1_048_576);
      const body: RunWaitManyResult = {
        wakeReason: "attention",
        attention: Array.from({ length: 1000 }, (_, i) => i),
        summaries: Array.from({ length: 1000 }, () => ({ ...observed })),
      };
      fetch.mockResolvedValue(Response.json(body));
      const tool = defaultClaudexorTools(mcpSurfaceRunner()).find(
        (entry) => entry.name === "claudexor_runs_wait",
      );
      if (surface === "query") expect(await runsWaitQuery(input)).toEqual(body);
      else {
        expect(tool).toBeDefined();
        const output = await tool!.handler(input, {});
        if (typeof output === "string") throw new Error("expected compact structured output");
        expect(output.isError).not.toBe(true);
        expect(RunWaitManyResult.parse(output.structured)).toEqual(body);
        expect(output.text).toBe(JSON.stringify(body));
      }
      expect(daemon.connectDaemonIfRunning).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = fetch.mock.calls[0]!;
      expect(url).toBe(`${addr.baseUrl}/v2/runs/wait-many`);
      expect(init?.method).toBe("POST");
      const wire = String(init?.body);
      expect(Buffer.byteLength(wire, "utf8")).toBe(1_048_576);
      expect(JSON.parse(wire)).toEqual(input);
      expect(JSON.parse(wire)).not.toHaveProperty("waitMs");
      expect(RunWaitManyInput.parse(JSON.parse(wire)).waitMs).toBe(25_000);

      daemon.connectDaemonIfRunning.mockClear();
      fetch.mockClear();
      const overLimit = {
        targets: [...targets.slice(0, 999), { runId: "€" + "é".repeat(12) + "x".repeat(243) }],
      };
      expect(Buffer.byteLength(JSON.stringify(overLimit), "utf8")).toBe(1_048_577);
      if (surface === "query") await expect(runsWaitQuery(overLimit)).rejects.toBeDefined();
      else expect(await tool!.handler(overLimit, {})).toMatchObject({ isError: true });
      expect(daemon.connectDaemonIfRunning).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { targets: [{ runId: "r" }] }])(
    "refuses the Delegate belt before validation or discovery: %j",
    async (input) => {
      await expect(runsWaitQuery(input, true)).rejects.toMatchObject({
        code: "delegation_forbidden",
        status: 403,
      });
      expect(daemon.connectDaemonIfRunning).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 0, 50_000])(
    "sends one POST for waitMs=%s without hydrating details",
    async (waitMs) => {
      const targets = [{ runId: " job/a " }, { runId: "run-a", seen: TOKEN }, { runId: "job/a" }];
      const body = { ...result([observed, unavailable, observed]), attention: [0, 2] };
      fetch.mockResolvedValue(Response.json(body));
      expect(await runsWaitQuery({ targets, ...(waitMs === undefined ? {} : { waitMs }) })).toEqual(
        body,
      );
      expect(daemon.connectDaemonIfRunning).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = fetch.mock.calls[0]!;
      expect(url).toBe(`${addr.baseUrl}/v2/runs/wait-many`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        targets: [{ runId: "job/a" }, { runId: "run-a", seen: TOKEN }, { runId: "job/a" }],
        ...(waitMs === undefined ? {} : { waitMs }),
      });
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("authorization")).toBe(`Bearer ${addr.token}`);
      expect(headers.has("Idempotency-Key")).toBe(false);
      expect(headers.has("Last-Event-ID")).toBe(false);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    },
  );

  it("projects daemon attention and unknowns unchanged instead of deriving output readiness", async () => {
    const body: RunWaitManyResult = {
      wakeReason: "attention",
      attention: [1, 2],
      summaries: [
        unavailable,
        { status: "running", pending: true, token: TOKEN, problem: null },
        observed,
      ],
    };
    fetch.mockResolvedValue(Response.json(body));
    expect(
      await runsWaitQuery({
        targets: [{ runId: "missing" }, { runId: "question" }, { runId: "terminal" }],
      }),
    ).toEqual(body);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "problems", "aborted"] as const)(
    "preserves the daemon's %s snapshot without another wait",
    async (wakeReason) => {
      const summary: RunWaitManySummary =
        wakeReason === "timeout"
          ? observed
          : {
              status: null,
              pending: null,
              token: null,
              problem: wakeReason === "aborted" ? "not_observed" : "snapshot_unavailable",
            };
      const body: RunWaitManyResult = { wakeReason, attention: [], summaries: [summary] };
      fetch.mockResolvedValue(Response.json(body));
      expect(await runsWaitQuery({ targets: [{ runId: "r", seen: TOKEN }] })).toEqual(body);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("does not start a missing daemon or turn absence into an empty result", async () => {
    daemon.connectDaemonIfRunning.mockResolvedValue(null);
    await expect(runsWaitQuery({ targets: [{ runId: "r" }] })).rejects.toMatchObject({
      code: "daemon_unavailable",
      retryable: true,
    });
    expect(daemon.connectDaemonIfRunning).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { status: 404, code: "not_found" },
    { status: 503, code: "run_observation_unavailable" },
    { status: 409, code: "store_identity_unavailable" },
  ])(
    "preserves a typed HTTP $status refusal without retry or single-run fallback",
    async ({ status, code }) => {
      fetch.mockResolvedValue(
        Response.json(
          {
            code,
            message: "compact observation is unavailable",
            retryable: false,
            fieldErrors: {},
            requiredActions: ["use a daemon supporting wait-many"],
            evidenceRefs: [],
            context: {},
          },
          { status },
        ),
      );
      await expect(
        runsWaitQuery({ targets: [{ runId: "a" }, { runId: "b" }] }),
      ).rejects.toMatchObject({
        code,
        retryable: false,
        requiredActions: ["use a daemon supporting wait-many"],
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(daemon.connectDaemonIfRunning).toHaveBeenCalledOnce();
    },
  );

  it("fails loudly on a legacy non-JSON missing route, without polling single waits", async () => {
    fetch.mockResolvedValue(new Response("Not Found", { status: 404 }));
    await expect(runsWaitQuery({ targets: [{ runId: "r" }] })).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { summary: "legacy reply" },
    { ...result(), events: [] },
    { ...result(), summaries: [{ ...observed, runId: "r" }] },
    { ...result(), summaries: [{ ...unavailable, pending: false }] },
    { ...result(), summaries: [{ ...observed, token: null }] },
    { ...result(), summaries: [{ ...observed, token: "short" }] },
    { ...result(), attention: [1] },
    { ...result(), summaries: Array.from({ length: 1001 }, () => observed) },
  ])("rejects malformed or expanded daemon result contract case %#", async (body) => {
    fetch.mockResolvedValue(Response.json(body));
    await expect(runsWaitQuery({ targets: [{ runId: "r" }] })).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([1, 3])("rejects a schema-valid %i-row reply to two input positions", async (rows) => {
    const body = result(Array.from({ length: rows }, () => ({ ...observed })));
    expect(RunWaitManyResult.parse(body)).toEqual(body);
    fetch.mockResolvedValue(Response.json(body));
    // Duplicates still own distinct output positions; a consumer must neither
    // accept a deduplicated reply nor silently drop an extra daemon row.
    await expect(
      runsWaitQuery({ targets: [{ runId: "r" }, { runId: "r" }] }),
    ).rejects.toMatchObject({
      code: "invalid_service_response",
      // A malformed answer stays malformed on retry.
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(daemon.connectDaemonIfRunning).toHaveBeenCalledOnce();
  });

  it("returns all 1000 longest rows at the independently established logical byte cap", async () => {
    const body: RunWaitManyResult = {
      wakeReason: "attention",
      attention: Array.from({ length: 1000 }, (_, i) => i),
      summaries: Array.from({ length: 1000 }, () => ({ ...observed })),
    };
    fetch.mockResolvedValue(Response.json(body));
    const actual = await runsWaitQuery({
      targets: Array.from({ length: 1000 }, () => ({ runId: "x".repeat(256) })),
    });
    expect(RunWaitManyResult.parse(actual)).toEqual(body);
    expect(Buffer.byteLength(JSON.stringify(actual), "utf8")).toBe(113_944);
    expect(Buffer.byteLength(JSON.stringify(actual), "utf8")).toBeLessThanOrEqual(131_072);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("forwards __runs_wait through the shared runner without treating it as a launch", async () => {
    const signal = new AbortController().signal;
    expect(
      await mcpSurfaceRunner()(
        { mode: "__runs_wait", targets: [{ runId: "r" }], waitMs: 0 },
        { signal },
      ),
    ).toEqual(result());
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({
      targets: [{ runId: "r" }],
      waitMs: 0,
    });
  });

  it("keeps __runs_wait forbidden for an injected belt runner", async () => {
    await expect(
      mcpSurfaceRunner({ delegationParentRunId: "parent" })({
        mode: "__runs_wait",
        targets: [{ runId: "r" }],
      }),
    ).rejects.toMatchObject({ code: "delegation_forbidden" });
    expect(daemon.connectDaemonIfRunning).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a pre-aborted host read before discovery", async () => {
    const host = new AbortController();
    host.abort(new Error("host stopped observing"));
    await expect(
      runsWaitQuery({ targets: [{ runId: "r" }] }, false, host.signal),
    ).rejects.toBeDefined();
    expect(daemon.connectDaemonIfRunning).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards host abort to the one HTTP read, never to worker controls", async () => {
    const host = new AbortController();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          expect(signal).toBeInstanceOf(AbortSignal);
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
          started();
        }),
    );
    const pending = mcpSurfaceRunner()(
      { mode: "__runs_wait", targets: [{ runId: "r" }] },
      { signal: host.signal },
    );
    const rejected = expect(pending).rejects.toBeDefined();
    await entered;
    host.abort(new Error("host stopped observing"));
    await rejected;
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("bounds discovery at 5s and never starts HTTP after that read later settles", async () => {
    vi.useFakeTimers();
    let connect!: (value: { addr: typeof addr }) => void;
    daemon.connectDaemonIfRunning.mockReturnValue(
      new Promise((resolve) => {
        connect = resolve;
      }),
    );
    const pending = runsWaitQuery({ targets: [{ runId: "r" }] });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "run_observation_timeout",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    connect({ addr });
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts during discovery without waiting for its uncancellable handshake", async () => {
    vi.useFakeTimers();
    const host = new AbortController();
    let connect!: (value: { addr: typeof addr }) => void;
    daemon.connectDaemonIfRunning.mockReturnValue(
      new Promise((resolve) => {
        connect = resolve;
      }),
    );
    const pending = runsWaitQuery({ targets: [{ runId: "r" }] }, false, host.signal);
    const rejected = expect(pending).rejects.toBeDefined();
    host.abort(new Error("host disconnected"));
    await rejected;
    connect({ addr });
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a typed discovery refusal instead of trying a different daemon", async () => {
    daemon.connectDaemonIfRunning.mockRejectedValue(
      Object.assign(new Error("protocol refused"), {
        code: "protocol_major_mismatch",
        retryable: false,
      }),
    );
    await expect(runsWaitQuery({ targets: [{ runId: "r" }] })).rejects.toMatchObject({
      code: "protocol_major_mismatch",
      retryable: false,
    });
    expect(daemon.connectDaemonIfRunning).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, 50_000])(
    "bounds HTTP at waitMs=%s plus 5s after discovery",
    async (waitMs) => {
      vi.useFakeTimers();
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      daemon.connectDaemonIfRunning.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ addr }), 4_000);
          }),
      );
      fetch.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener(
              "abort",
              () => reject(new Error("HTTP observer aborted")),
              { once: true },
            );
            started();
          }),
      );
      const pending = runsWaitQuery({
        targets: [{ runId: "r" }],
        ...(waitMs === undefined ? {} : { waitMs }),
      });
      const rejected = expect(pending).rejects.toBeDefined();
      await vi.advanceTimersByTimeAsync(4_000);
      await entered;
      const signal = fetch.mock.calls[0]![1]!.signal!;
      await vi.advanceTimersByTimeAsync((waitMs ?? 25_000) + 4_999);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(signal.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([false, true])(
    "releases timers and host listeners after HTTP failure=%s",
    async (fail) => {
      vi.useFakeTimers();
      const host = new AbortController();
      const add = vi.spyOn(host.signal, "addEventListener");
      const remove = vi.spyOn(host.signal, "removeEventListener");
      if (fail) fetch.mockRejectedValue(new Error("connection reset"));
      const pending = runsWaitQuery({ targets: [{ runId: "r" }] }, false, host.signal);
      if (fail) await expect(pending).rejects.toThrow("connection reset");
      else expect(await pending).toEqual(result());
      for (const [name, listener] of add.mock.calls)
        expect(remove).toHaveBeenCalledWith(name, listener);
      expect(vi.getTimerCount()).toBe(0);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("retains the HTTP budget through response-body consumption", async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetch.mockImplementation(
      async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"wakeReason":'));
              init!.signal!.addEventListener(
                "abort",
                () => {
                  controller.error(new Error("response body aborted"));
                },
                { once: true },
              );
              started();
            },
          }),
        ),
    );
    const pending = runsWaitQuery({ targets: [{ runId: "r" }], waitMs: 0 });
    const rejected = expect(pending).rejects.toBeDefined();
    await entered;
    const signal = fetch.mock.calls[0]![1]!.signal!;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
