import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { spawnProcess } from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { runCodexAppServer } from "./app-server-run.js";
import { withCodexVendorFailure } from "./vendor-failure.js";

/**
 * #558: Codex's own TYPED usage refusal (`usage_limit_exceeded` in the
 * rollout, `usageLimitExceeded` on the app-server wire) is one code for a spent
 * plan window and a workspace out of credits alike, with no reopening time of
 * its own. The adapter translates that code, never the words, into one typed
 * limit per try whose reopening is unknown. The out-of-credits wording below
 * matches no rate-limit phrase, so only the typed code can produce the limit.
 */
const CREDITS =
  "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.";
const WINDOW_WORDS =
  "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 4th, 2026 9:38 AM.";
const USAGE_REFUSAL = {
  applies_to_request_kinds: ["text"],
  resets_at: null,
  retry_delay_ms: null,
  reopening: "unknown",
};

type Frame = Record<string, unknown>;
const THREAD = "thread-usage";
const TURN = "turn-usage";
const turnError = (message: string, codexErrorInfo?: unknown): Frame => ({
  message,
  ...(codexErrorInfo === undefined ? {} : { codexErrorInfo }),
  additionalDetails: null,
});
const failedTurn = (error: Frame): Frame => ({
  method: "turn/completed",
  params: { threadId: THREAD, turn: { id: TURN, status: "failed", error, items: [] } },
});
const errorFrame = (error: Frame): Frame => ({
  method: "error",
  params: { error, willRetry: false, threadId: THREAD, turnId: TURN },
});
const systemError: Frame = {
  method: "thread/status/changed",
  params: { threadId: THREAD, status: { type: "systemError" } },
};
const commandStarted: Frame = {
  method: "item/started",
  params: {
    threadId: THREAD,
    turnId: TURN,
    item: { type: "commandExecution", id: "cmd-bg", command: "sleep 30", status: "inProgress" },
  },
};

/**
 * The vendor process is the only fake. It answers the adapter's own requests;
 * `afterTurn` follows `turn/start`, `duringWait` arrives with the first
 * background read, and `closing` arrives only after the adapter closed stdin.
 */
function vendor(opts: {
  afterTurn: Frame[];
  status: "idle" | "systemError";
  closing?: Frame[];
  /** Owned background reads that still report the command before it is gone. */
  backgroundReads?: number;
  duringWait?: Frame[];
}) {
  const replies: string[] = [];
  let wake: (() => void) | undefined;
  let stop = false;
  let reads = 0;
  const push = (...frames: Frame[]): void => {
    for (const frame of frames) replies.push(JSON.stringify(frame));
    wake?.();
    wake = undefined;
  };
  // The adapter stops a settled run by abort, then stdin close: whichever comes
  // first is the shutdown, and what the process writes then still reaches it.
  const shutdown = (): void => {
    if (!stop) push(...(opts.closing ?? []));
    stop = true;
    wake?.();
  };
  const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
    options.onSpawn?.({
      write(data) {
        const request = JSON.parse(data) as { id?: number; method: string };
        const reply = (result: Frame) => push({ id: request.id, result });
        if (request.method === "initialize") reply({});
        if (request.method === "thread/start") reply({ thread: { id: THREAD } });
        if (request.method === "turn/start") {
          reply({ turn: { id: TURN } });
          push({ method: "turn/started", params: { threadId: THREAD, turn: { id: TURN } } });
          push(...opts.afterTurn);
        }
        if (request.method === "thread/read") reply({ thread: { status: { type: opts.status } } });
        if (request.method === "thread/goal/get") reply({ goal: null });
        if (request.method === "thread/backgroundTerminals/list") {
          const holding = reads < (opts.backgroundReads ?? 0);
          if (reads === 0 && opts.duringWait) push(...opts.duringWait);
          reads += 1;
          reply({ data: holding ? [{ itemId: "cmd-bg", processId: "process-bg" }] : [] });
        }
      },
      end: shutdown,
      closed: Promise.resolve(),
    });
    options.abortSignal?.addEventListener("abort", shutdown, { once: true });
    while (!stop || replies.length) {
      if (replies.length) yield { type: "stdout", line: replies.shift()! };
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  };
  return { spawn, reads: () => reads };
}

const spec = HarnessRunSpec.parse({
  session_id: "session-usage",
  intent: "implement",
  prompt: "work",
  cwd: process.cwd(),
});

async function wire(server: ReturnType<typeof vendor>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of runCodexAppServer({
    bin: "codex",
    args: [],
    spec,
    env: {},
    spawn: server.spawn,
    pollIntervalMs: 0,
  }))
    events.push(event);
  return events;
}
const errors = (events: HarnessEvent[]) => events.filter((event) => event.type === "error");
const limits = (events: HarnessEvent[]) => events.filter((event) => event.rate_limit);

describe("Codex usage refusal on the app-server wire (#558)", () => {
  it("translates a failed turn's typed usageLimitExceeded, whatever its words, into one unknown-reopening limit", async () => {
    const events = await wire(
      vendor({ afterTurn: [failedTurn(turnError(CREDITS, "usageLimitExceeded"))], status: "idle" }),
    );
    expect(errors(events)).toHaveLength(1);
    expect(errors(events)[0]).toMatchObject({ error: CREDITS, rate_limit: USAGE_REFUSAL });
    expect(limits(events)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: { harness_reported_error: true },
    });
  });

  it("never derives the unknown-reopening semantic from words: limit prose alone keeps today's plain signal", async () => {
    const events = await wire(
      vendor({ afterTurn: [failedTurn(turnError(WINDOW_WORDS))], status: "idle" }),
    );
    expect(errors(events)).toHaveLength(1);
    const signal = errors(events)[0]!.rate_limit;
    expect(signal).toEqual({
      applies_to_request_kinds: ["text"],
      resets_at: null,
      retry_delay_ms: null,
    });
    expect(signal).not.toHaveProperty("reopening");
  });

  it("leaves another typed code alone (no limit for an overloaded model)", async () => {
    const events = await wire(
      vendor({
        afterTurn: [failedTurn(turnError("Selected model is at capacity.", "serverOverloaded"))],
        status: "idle",
      }),
    );
    expect(errors(events)).toHaveLength(1);
    expect(limits(events)).toEqual([]);
  });

  it("reads the typed reason a systemError raced ahead of (recorded order: systemError, error, failed turn)", async () => {
    const error = turnError(CREDITS, "usageLimitExceeded");
    const events = await wire(
      vendor({
        afterTurn: [systemError, errorFrame(error), failedTurn(error)],
        status: "systemError",
      }),
    );
    expect(errors(events)).toHaveLength(1);
    expect(errors(events)[0]).toMatchObject({
      error: "Codex app-server thread settled in systemError",
      rate_limit: USAGE_REFUSAL,
    });
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: { harness_reported_error: true },
    });
  });

  it("takes a typed reason the process wrote only while it shut down, without waiting for one", async () => {
    const events = await wire(
      vendor({
        afterTurn: [systemError],
        status: "systemError",
        closing: [errorFrame(turnError(CREDITS, "usageLimitExceeded"))],
      }),
    );
    expect(errors(events)).toHaveLength(1);
    expect(errors(events)[0]?.rate_limit).toEqual(USAGE_REFUSAL);
  });

  it("keeps a root refusal the loop read and dropped before a systemError settled the run", async () => {
    const events = await wire(
      vendor({
        afterTurn: [errorFrame(turnError(CREDITS, "usageLimitExceeded")), systemError],
        status: "systemError",
      }),
    );
    expect(errors(events)).toHaveLength(1);
    expect(errors(events)[0]).toMatchObject({
      error: "Codex app-server thread settled in systemError",
      rate_limit: USAGE_REFUSAL,
    });
    expect(limits(events)).toHaveLength(1);
  });

  it("types a failed turn whose own error carries only words from the root's non-retrying frame", async () => {
    for (const words of [CREDITS, WINDOW_WORDS]) {
      const events = await wire(
        vendor({
          afterTurn: [
            errorFrame(turnError(CREDITS, "usageLimitExceeded")),
            failedTurn(turnError(words)),
          ],
          status: "idle",
        }),
      );
      expect(errors(events)).toHaveLength(1);
      // The typed refusal replaces the plain limit those words alone would produce.
      expect(errors(events)[0]).toMatchObject({ error: words, rate_limit: USAGE_REFUSAL });
      expect(limits(events)).toHaveLength(1);
    }
  });

  it("a retrying frame is not the refusal: it stays transport status and limits nothing", async () => {
    const events = await wire(
      vendor({
        afterTurn: [
          {
            method: "error",
            params: {
              error: turnError(CREDITS, "usageLimitExceeded"),
              willRetry: true,
              threadId: THREAD,
              turnId: TURN,
            },
          },
          systemError,
        ],
        status: "systemError",
      }),
    );
    expect(limits(events)).toEqual([]);
    expect(events.some((event) => event.status?.kind === "api_retry")).toBe(true);
  });

  it("a sub-agent's refusal never limits the root, on a root failure or a root success", async () => {
    const CHILD = "thread-child";
    const typed = turnError(CREDITS, "usageLimitExceeded");
    const childFrames: Frame[] = [
      { method: "error", params: { error: typed, willRetry: false, threadId: CHILD, turnId: "c" } },
      {
        method: "turn/completed",
        params: { threadId: CHILD, turn: { id: "c", status: "failed", error: typed, items: [] } },
      },
    ];
    const failed = await wire(
      vendor({
        afterTurn: [...childFrames, failedTurn(turnError("Selected model is at capacity."))],
        status: "idle",
      }),
    );
    expect(errors(failed)).toHaveLength(1);
    expect(limits(failed)).toEqual([]);
    const settled = await wire(
      vendor({ afterTurn: [...childFrames, systemError], status: "systemError" }),
    );
    expect(errors(settled)).toHaveLength(1);
    expect(limits(settled)).toEqual([]);
    const answered = await wire(
      vendor({
        afterTurn: [
          ...childFrames,
          {
            method: "item/completed",
            params: {
              threadId: THREAD,
              turnId: TURN,
              item: { type: "agentMessage", id: "answer", text: "done" },
            },
          },
          {
            method: "turn/completed",
            params: { threadId: THREAD, turn: { id: TURN, status: "completed", items: [] } },
          },
        ],
        status: "idle",
      }),
    );
    expect(errors(answered)).toEqual([]);
    expect(limits(answered)).toEqual([]);
    expect(answered.some((event) => event.final && event.text === "done")).toBe(true);
  });

  it("a new root turn clears the earlier turn's refusal", async () => {
    const events = await wire(
      vendor({
        afterTurn: [
          errorFrame(turnError(CREDITS, "usageLimitExceeded")),
          { method: "turn/started", params: { threadId: THREAD, turn: { id: "turn-next" } } },
          failedTurn(turnError("Selected model is at capacity.")),
        ],
        status: "idle",
      }),
    );
    expect(errors(events)).toHaveLength(1);
    expect(limits(events)).toEqual([]);
  });

  it("a cancelled root turn keeps its cancel: the refusal it read adds no error and no limit", async () => {
    const events = await wire(
      vendor({
        afterTurn: [
          errorFrame(turnError(CREDITS, "usageLimitExceeded")),
          {
            method: "turn/completed",
            params: { threadId: THREAD, turn: { id: TURN, status: "interrupted", items: [] } },
          },
        ],
        status: "idle",
      }),
    );
    expect(errors(events)).toEqual([]);
    expect(limits(events)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "completed", aborted: true });
  });

  it("still terminates a systemError that never gets a later terminal frame, with no invented limit", async () => {
    const events = await wire(vendor({ afterTurn: [systemError], status: "systemError" }));
    expect(errors(events)).toEqual([
      expect.objectContaining({ error: "Codex app-server thread settled in systemError" }),
    ]);
    expect(limits(events)).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: { harness_reported_error: true },
    });
  });

  it("keeps background-command custody before terminalizing, then carries the reason that arrived meanwhile", async () => {
    const error = turnError(CREDITS, "usageLimitExceeded");
    const server = vendor({
      afterTurn: [commandStarted, systemError],
      status: "systemError",
      backgroundReads: 3,
      duringWait: [errorFrame(error), failedTurn(error)],
    });
    const events = await wire(server);
    // The owned command was reported three times before it ended; only then the terminal.
    expect(server.reads()).toBe(4);
    expect(errors(events)).toHaveLength(1);
    expect(errors(events)[0]?.rate_limit).toEqual(USAGE_REFUSAL);
    expect(events.at(-1)?.type).toBe("completed");
  });
});

/**
 * The root turn's own failure record (`codexErrorInfo` and its words) that only
 * the app-server wire carried, a gap read in source: with no readable rollout
 * record it was dropped. It rides the terminal `completed` as `vendor_failure`
 * evidence (source `codex_app_server`), whatever the arrival order, and decides
 * nothing: the overloaded code adds no limit. Synthetic frames, not a recording.
 */
describe("the root turn's own failure record on the app-server wire", () => {
  const OVERLOADED = "Selected model is at capacity. Please try a different model.";
  const overloaded = turnError(OVERLOADED, "serverOverloaded");
  const wireRecord = (code: string | null, message: string | null) => ({
    code,
    message,
    source: "codex_app_server",
  });
  const recorded = (events: HarnessEvent[]) => events.at(-1)?.payload?.["vendor_failure"];
  const nextTurn: Frame = {
    method: "turn/started",
    params: { threadId: THREAD, turn: { id: "turn-next" } },
  };

  it.each([
    [
      "systemError, error, failed turn (recorded order)",
      [systemError, errorFrame(overloaded), failedTurn(overloaded)],
      "systemError",
    ],
    ["the error before the systemError", [errorFrame(overloaded), systemError], "systemError"],
    ["a failed turn alone", [failedTurn(overloaded)], "idle"],
  ] as const)(
    "keeps it on the terminal whatever the arrival order: %s",
    async (_order, afterTurn, status) => {
      const events = await wire(vendor({ afterTurn: [...afterTurn], status }));
      expect(recorded(events)).toEqual(wireRecord("serverOverloaded", OVERLOADED));
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        payload: { harness_reported_error: true },
      });
      expect(errors(events)).toHaveLength(1);
      expect(limits(events)).toEqual([]);
    },
  );

  it("takes a record written only at shutdown or during background custody, without waiting for one", async () => {
    const atShutdown = await wire(
      vendor({
        afterTurn: [systemError],
        status: "systemError",
        closing: [errorFrame(overloaded)],
      }),
    );
    expect(recorded(atShutdown)).toEqual(wireRecord("serverOverloaded", OVERLOADED));
    const server = vendor({
      afterTurn: [commandStarted, systemError],
      status: "systemError",
      backgroundReads: 3,
      duringWait: [errorFrame(overloaded), failedTurn(overloaded)],
    });
    const delayed = await wire(server);
    expect(server.reads()).toBe(4);
    expect(recorded(delayed)).toEqual(wireRecord("serverOverloaded", OVERLOADED));
    const silent = await wire(vendor({ afterTurn: [systemError], status: "systemError" }));
    expect(silent.at(-1)?.payload).not.toHaveProperty("vendor_failure");
  });

  it("a typed record outranks a later words-only one; between typed records the later speaks", async () => {
    const kept = await wire(
      vendor({
        afterTurn: [errorFrame(overloaded), failedTurn(turnError("turn failed"))],
        status: "idle",
      }),
    );
    expect(recorded(kept)).toEqual(wireRecord("serverOverloaded", OVERLOADED));
    const later = await wire(
      vendor({
        afterTurn: [
          errorFrame(turnError("first words", "serverOverloaded")),
          failedTurn(turnError("second words", { httpConnectionFailed: { httpStatusCode: 502 } })),
        ],
        status: "idle",
      }),
    );
    expect(recorded(later)).toEqual(wireRecord("httpConnectionFailed", "second words"));
  });

  it("a new root turn clears the earlier turn's record, and a failure without one carries none", async () => {
    const bare = await wire(
      vendor({ afterTurn: [errorFrame(overloaded), nextTurn, systemError], status: "systemError" }),
    );
    expect(bare.at(-1)).toMatchObject({ payload: { harness_reported_error: true } });
    expect(bare.at(-1)?.payload).not.toHaveProperty("vendor_failure");
    const words = await wire(
      vendor({
        afterTurn: [errorFrame(overloaded), nextTurn, failedTurn(turnError("later words"))],
        status: "idle",
      }),
    );
    expect(recorded(words)).toEqual(wireRecord(null, "later words"));
  });

  it("a retrying frame followed by an answer leaves no failure behind", async () => {
    const events = await wire(
      vendor({
        afterTurn: [
          {
            method: "error",
            params: { error: overloaded, willRetry: true, threadId: THREAD, turnId: TURN },
          },
          {
            method: "item/completed",
            params: {
              threadId: THREAD,
              turnId: TURN,
              item: { type: "agentMessage", id: "answer", text: "done" },
            },
          },
          {
            method: "turn/completed",
            params: { threadId: THREAD, turn: { id: TURN, status: "completed", items: [] } },
          },
        ],
        status: "idle",
      }),
    );
    expect(events.some((event) => event.final && event.text === "done")).toBe(true);
    expect(errors(events)).toEqual([]);
    expect(events.at(-1)?.payload).not.toHaveProperty("vendor_failure");
    expect(events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
  });

  it("a sub-agent's record never becomes the root's, and a cancelled turn carries none", async () => {
    const CHILD = "thread-child";
    const child: Frame[] = [
      {
        method: "error",
        params: { error: overloaded, willRetry: false, threadId: CHILD, turnId: "c" },
      },
      {
        method: "turn/completed",
        params: {
          threadId: CHILD,
          turn: { id: "c", status: "failed", error: overloaded, items: [] },
        },
      },
    ];
    const settled = await wire(
      vendor({ afterTurn: [...child, systemError], status: "systemError" }),
    );
    expect(settled.at(-1)?.payload).not.toHaveProperty("vendor_failure");
    const cancelled = await wire(
      vendor({
        afterTurn: [
          errorFrame(overloaded),
          {
            method: "turn/completed",
            params: { threadId: THREAD, turn: { id: TURN, status: "interrupted", items: [] } },
          },
        ],
        status: "idle",
      }),
    );
    expect(cancelled.at(-1)).toMatchObject({ type: "completed", aborted: true });
    expect(cancelled.at(-1)?.payload).not.toHaveProperty("vendor_failure");
  });
});

/** The recorded rollout of #558's mechanism: a workspace out of credits, typed `usage_limit_exceeded`. */
const ROLLOUT_THREAD = "00000000-0000-7000-0000-000000000000";
const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/rollout/${name}`, import.meta.url));
const homes: string[] = [];
function codexHome(name: string): string {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-refusal-"));
  homes.push(home);
  const day = join(home, "sessions", "2026", "09", "12");
  mkdirSync(day, { recursive: true });
  copyFileSync(fixture(name), join(day, `rollout-2026-09-12T07-27-38-${ROLLOUT_THREAD}.jsonl`));
  return home;
}
afterAll(
  () => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })),
  0,
); // synchronous removal: no deadline (#376, see vitest.setup.ts)
afterEach(() => vi.useRealTimers());

const ts = "2026-09-12T07:27:42.843Z";
const ev = (event: Partial<HarnessEvent>): HarnessEvent =>
  ({ session_id: "ses-usage", ts, ...event }) as HarnessEvent;
/** An app-server failed turn's terminal: a voiced error and no OS exit evidence. */
const appServerCompletion = ev({ type: "completed", payload: { harness_reported_error: true } });

async function rollout(events: HarnessEvent[], name: string): Promise<HarnessEvent[]> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1789198058_100); // spawned in the recorded turn's second
  const out: HarnessEvent[] = [];
  async function* stream() {
    yield* events;
  }
  for await (const event of withCodexVendorFailure(
    stream(),
    HarnessRunSpec.parse({ session_id: "ses-usage", intent: "explain", prompt: "hi", cwd: "/" }),
    { CODEX_HOME: codexHome(name) },
    () => ROLLOUT_THREAD,
  ))
    out.push(event);
  return out;
}

describe("Codex usage refusal from the rollout record (#558, #414)", () => {
  it("adds the typed limit beside the forwarded evidence on a completion without exit evidence", async () => {
    const out = await rollout(
      [
        ev({ type: "error", error: "Codex app-server thread settled in systemError" }),
        appServerCompletion,
      ],
      "recorded-usage-limit-exceeded-0.153.3.jsonl",
    );
    expect(out.at(-1)).toMatchObject({
      type: "completed",
      payload: {
        harness_reported_error: true,
        vendor_failure: { code: "usage_limit_exceeded", message: CREDITS, source: "codex_rollout" },
      },
      rate_limit: USAGE_REFUSAL,
    });
  });

  it("adds no limit for another recorded code", async () => {
    const out = await rollout([appServerCompletion], "recorded-other-0.153.3.jsonl");
    expect(out.at(-1)?.payload?.["vendor_failure"]).toMatchObject({ code: "other" });
    expect(out.at(-1)?.rate_limit).toBeUndefined();
  });

  it("keeps ONE typed limit per try when the wire already carried it, while the evidence still rides", async () => {
    const wireLimit = ev({
      type: "error",
      error: CREDITS,
      rate_limit: { ...USAGE_REFUSAL } as never,
    });
    const out = await rollout(
      [wireLimit, appServerCompletion],
      "recorded-usage-limit-exceeded-0.153.3.jsonl",
    );
    expect(limits(out)).toHaveLength(1);
    expect(out.at(-1)?.payload?.["vendor_failure"]).toMatchObject({ code: "usage_limit_exceeded" });
  });

  it("adds the typed limit after a plain prose-matched one, so the unknown reopening is not lost", async () => {
    const plain = ev({
      type: "error",
      error: WINDOW_WORDS,
      rate_limit: { applies_to_request_kinds: ["text"], resets_at: null, retry_delay_ms: null },
    });
    const out = await rollout(
      [plain, appServerCompletion],
      "recorded-usage-limit-exceeded-0.153.3.jsonl",
    );
    expect(limits(out).map((event) => event.rate_limit?.reopening)).toEqual([undefined, "unknown"]);
  });
});
