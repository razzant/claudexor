import type { SpawnOptions, spawnProcess } from "@claudexor/core";
import { HarnessRunSpec, HarnessEvent } from "@claudexor/schema";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codexAppServerInput } from "./attachments.js";
import {
  CodexAppServerController,
  codexAppServerEvents,
  codexAppServerThreadParams,
  runCodexAppServer,
  type CodexAppServerRunInput,
} from "./app-server-run.js";
import type { CodexParseState } from "./parse.js";
import { createCodexAdapter } from "./index.js";

const retryNotifications = readFileSync(
  new URL("../fixtures/app-server/retry-status-0.156.1.jsonl", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("Codex app-server transport", () => {
  it.each([
    ["workspace_write", "workspace-write", "on-request"],
    ["readonly", "read-only", "never"],
    ["full", "danger-full-access", "never"],
    ["inherit_native", undefined, "never"],
  ])(
    "preserves the %s boundary while enabling native automatic review",
    (access, sandbox, policy) => {
      const params = codexAppServerThreadParams(
        HarnessRunSpec.parse({
          session_id: "review-policy",
          intent: "implement",
          prompt: "work",
          cwd: process.cwd(),
          access,
        }),
      );
      expect(params["sandbox"]).toBe(sandbox);
      expect(params["approvalPolicy"]).toBe(policy);
      expect(params["approvalsReviewer"]).toBe("auto_review");
    },
  );

  it.each([
    [
      0,
      "item/fileChange/requestApproval",
      "codex_approval_required",
      { decision: "decline" },
      null,
    ],
    [
      3,
      "item/fileChange/requestApproval",
      "codex_approval_required",
      { decision: "decline" },
      null,
    ],
    [
      "approval-1",
      "item/fileChange/requestApproval",
      "codex_approval_required",
      { decision: "decline" },
      null,
    ],
    [
      4,
      "item/commandExecution/requestApproval",
      "codex_approval_required",
      { decision: "decline" },
      null,
    ],
    [
      1,
      "future/serverAction",
      "codex_request_unsupported",
      null,
      { code: -32601, message: "Unsupported server request" },
    ],
  ])(
    "refuses server request id %s (%s) without granting authority or mistaking it for a response",
    async (id, method, code, result, error) => {
      const writes: Array<Record<string, unknown>> = [];
      const replies: string[] = [];
      let wake: (() => void) | undefined;
      let stopped = false;
      const push = (value: unknown) => {
        replies.push(JSON.stringify(value));
        wake?.();
      };
      const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
        // A broken client must fail this assertion, not hang the test indefinitely.
        const timeout = setTimeout(() => {
          stopped = true;
          wake?.();
        }, 100);
        options.onSpawn?.({
          write(line) {
            const message = JSON.parse(line) as Record<string, unknown>;
            writes.push(message);
            if (message.method === "initialize") push({ id: message.id, result: {} });
            if (message.method === "thread/start")
              push({ id: message.id, result: { thread: { id: "thread-approval" } } });
            if (message.method === "turn/start")
              push({
                id,
                method,
                params: { threadId: "thread-approval", turnId: "turn-1", itemId: "patch-1" },
              });
          },
          end() {
            stopped = true;
            wake?.();
          },
          closed: Promise.resolve(),
        });
        try {
          while (!stopped || replies.length) {
            if (replies.length) yield { type: "stdout", line: replies.shift()! };
            else await new Promise<void>((resolve) => (wake = resolve));
          }
          yield { type: "exit", code: 0, signal: null, durationMs: 0 };
        } finally {
          clearTimeout(timeout);
        }
      };
      const events: HarnessEvent[] = [];
      for await (const event of runCodexAppServer({
        bin: "/fixture/codex",
        args: [],
        env: {},
        spawn,
        spec: HarnessRunSpec.parse({
          session_id: "session-approval",
          intent: "implement",
          prompt: "Write a file",
          cwd: process.cwd(),
          access: "workspace_write",
        }),
      }))
        events.push(event);
      expect(writes.filter((message) => !message.method)).toEqual([
        { id, ...(result ? { result } : { error }) },
      ]);
      expect(events).toContainEqual(expect.objectContaining({ type: "error", payload: { code } }));
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        payload: { harness_reported_error: true },
      });
    },
  );
  it("preserves recorded native retries without inventing policy signals or counters", () => {
    for (const notification of retryNotifications) {
      const params = notification["params"] as Record<string, unknown>;
      const events = codexAppServerEvents(notification, "session-retry", {});
      expect(events).toHaveLength(1);
      expect(events![0]).toEqual({
        type: "status",
        session_id: "session-retry",
        ts: expect.any(String),
        text: (params["error"] as Record<string, unknown>)["message"],
        status: { kind: "api_retry" },
        payload: params,
      });
      expect(HarnessEvent.safeParse(events![0]).success).toBe(true);
    }
  });

  it.each([false, undefined, "true", 1, null])(
    "keeps non-retry notification accounting for willRetry=%s",
    (willRetry) => {
      const notification = retryNotifications[0]!;
      expect(
        codexAppServerEvents(
          { ...notification, params: { ...(notification["params"] as object), willRetry } },
          "session-retry",
          {},
        ),
      ).toBeNull();
    },
  );

  it("initializes, starts a thread and turn, and delivers queued quota from the same native process", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stopped = false;

    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, args, options: SpawnOptions = {}) {
      expect(args).toEqual(["app-server", "--stdio"]);
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as {
            id?: number;
            method: string;
            params?: Record<string, unknown> | null;
          };
          writes.push(request);
          if (request.method === "initialize") {
            push({
              id: request.id,
              result: { userAgent: "claudexor/0.162.1 (fixture) unknown (claudexor; 5.0.0)" },
            });
          } else if (request.method === "thread/start") {
            push({ id: request.id, result: { thread: { id: "thread-1" } } });
            push({
              method: "account/rateLimits/updated",
              params: {
                rateLimits: {
                  limitId: "codex",
                  primary: {
                    usedPercent: 17,
                    windowDurationMins: 300,
                    resetsAt: 1791151200,
                  },
                },
              },
            });
            push({
              method: "mcpServer/startupStatus/updated",
              params: { threadId: "thread-1", name: "required_one", status: "starting" },
            });
            push({
              method: "mcpServer/startupStatus/updated",
              params: { threadId: "thread-1", name: "required_one", status: "ready" },
            });
          } else if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-1" } } });
            push({
              method: "turn/started",
              params: { threadId: "thread-1", turn: { id: "turn-1" } },
            });
          }
        },
        end() {
          stopped = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      try {
        while (!stopped) {
          if (replies.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            continue;
          }
          yield { type: "stdout", line: replies.shift()! };
        }
      } finally {
        stopped = true;
      }
    };

    const spec = HarnessRunSpec.parse({
      session_id: "session-1",
      intent: "implement",
      prompt: "Keep working",
      cwd: process.cwd(),
      output_schema: false,
      extra_mcp_servers: [
        { name: "required_one", command: "/bin/echo", args: [], env: {}, required: true },
      ],
    });
    let first: HarnessEvent | undefined;
    let quota: HarnessEvent | undefined;
    for await (const event of runCodexAppServer({
      bin: "/fixture/codex",
      args: [],
      spec,
      env: {},
      spawn,
    })) {
      first ??= event;
      if (event.quota) {
        quota = event;
        break;
      }
    }

    expect(first?.program).toMatchObject({ version: "0.162.1", versionSource: "vendor_stream" });
    expect(writes.map((request) => request.id).filter(Boolean)).toEqual([1, 2, 3]);
    expect(writes.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    expect(writes[0]?.params).toMatchObject({
      clientInfo: { name: "claudexor" },
      capabilities: { experimentalApi: true },
    });
    expect(writes.find((request) => request.method === "turn/start")?.params).toMatchObject({
      outputSchema: false,
    });
    expect(first).toMatchObject({
      type: "started",
      session_id: "session-1",
      payload: {
        native_session_id: "thread-1",
        native_turn_id: "turn-1",
        mcp_servers: [{ name: "required_one", status: "connected" }],
      },
    });
    expect(quota).toMatchObject({
      type: "status",
      quota: {
        source: "codex_app_server_event",
        constraints: [expect.objectContaining({ id: "codex:primary", used_ratio: 0.17 })],
      },
    });
    expect(quota?.usage).toBeUndefined();
  });

  it("types a required MCP startup failure notification before starting the turn", async () => {
    const methods: string[] = [];
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as { id?: number; method: string };
          methods.push(request.method);
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start") {
            push({ id: request.id, result: { thread: { id: "thread-mcp-failure" } } });
            push({
              method: "mcpServer/startupStatus/updated",
              params: {
                threadId: "thread-mcp-failure",
                name: "required_one",
                status: "starting",
              },
            });
            push({
              method: "mcpServer/startupStatus/updated",
              params: {
                threadId: "thread-mcp-failure",
                name: "required_one",
                status: "failed",
                error: "unavailable",
              },
            });
          }
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          stop = true;
          wake?.();
        },
        { once: true },
      );
      while (!stop || replies.length) {
        if (replies.length) yield { type: "stdout", line: replies.shift()! };
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    };
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "/fixture/codex",
      args: [],
      spec: HarnessRunSpec.parse({
        session_id: "session-mcp-failure",
        intent: "implement",
        prompt: "work",
        cwd: process.cwd(),
        extra_mcp_servers: [
          { name: "required_one", command: "/bin/echo", args: [], env: {}, required: true },
        ],
      }),
      env: {},
      spawn,
    }))
      events.push(event);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        payload: {
          code: "required_mcp_startup_failed",
          mcp_servers: [{ name: "required_one", status: "failed" }],
        },
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: { harness_reported_error: true },
    });
    expect(events.at(-1)?.aborted).toBeUndefined();
    expect(methods).not.toContain("turn/start");
  });

  it("preserves run settings and verified image input", () => {
    const imagePath = fileURLToPath(import.meta.url);
    const imageBytes = readFileSync(imagePath);
    const spec = HarnessRunSpec.parse({
      session_id: "session-parity",
      intent: "implement",
      prompt: "Inspect it",
      instructions: "Stay terse",
      cwd: process.cwd(),
      access: "readonly",
      model_hint: "gpt-test",
      effort_hint: "high",
      external_context_policy: "off",
      output_schema: { type: "object" },
      attachments: [
        {
          resource_id: "image-1",
          kind: "image",
          mime: "image/png",
          name: "image.png",
          path: imagePath,
          sha256: `sha256:${createHash("sha256").update(imageBytes).digest("hex")}`,
          size_bytes: imageBytes.length,
        },
      ],
      extra_mcp_servers: [
        {
          name: "claudexor",
          command: "/bin/echo",
          args: ["server"],
          env: { RUN_ID: "run-1" },
          required: true,
        },
      ],
    });

    expect(codexAppServerThreadParams(spec)).toMatchObject({
      cwd: process.cwd(),
      model: "gpt-test",
      sandbox: "read-only",
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      developerInstructions: "Stay terse",
      config: {
        web_search: "disabled",
        model_reasoning_effort: "high",
        mcp_servers: {
          claudexor: {
            command: "/bin/echo",
            args: ["server"],
            env: { RUN_ID: "run-1" },
            required: true,
          },
        },
      },
    });
    expect(codexAppServerInput(spec)).toEqual([
      { type: "text", text: "Inspect it" },
      { type: "localImage", path: imagePath },
    ]);
  });

  it("maps app-server item, plan, and usage notifications to existing events", () => {
    const state: CodexParseState = {};
    expect(
      codexAppServerEvents(
        {
          method: "item/started",
          params: {
            item: {
              type: "commandExecution",
              id: "cmd-1",
              command: "sleep 10",
              status: "inProgress",
            },
          },
        },
        "session-map",
        state,
      ),
    ).toMatchObject([{ type: "tool_call", tool: { use_id: "cmd-1" } }]);
    expect(
      codexAppServerEvents(
        {
          method: "turn/plan/updated",
          params: { plan: [{ step: "Wait", status: "inProgress" }] },
        },
        "session-map",
        state,
      )?.[0]?.plan_progress,
    ).toEqual({ items: [{ id: "codex-0", title: "Wait", status: "in_progress" }] });
    expect(
      codexAppServerEvents(
        {
          method: "thread/tokenUsage/updated",
          params: {
            tokenUsage: {
              last: {
                inputTokens: 11,
                cachedInputTokens: 3,
                cacheWriteInputTokens: 2,
                outputTokens: 5,
              },
            },
          },
        },
        "session-map",
        state,
      ),
    ).toMatchObject([
      {
        type: "usage",
        usage: {
          input_tokens: 11,
          cached_input_tokens: 3,
          output_tokens: 5,
          input_token_usage: {
            total_tokens: 11,
            cache_read_tokens: 3,
            cache_write_tokens: 2,
          },
        },
      },
    ]);
    expect(
      codexAppServerEvents(
        {
          method: "item/completed",
          params: {
            item: {
              type: "fileChange",
              id: "patch-1",
              changes: [{ path: "one.ts" }, { path: "two.ts" }],
            },
          },
        },
        "session-map",
        state,
      ),
    ).toEqual([
      expect.objectContaining({
        type: "file_change",
        payload: expect.objectContaining({ path: "one.ts" }),
        tool: {
          name: "apply_patch",
          kind: "file",
          use_id: "patch-1",
          target: "one.ts",
          phase: "completed",
        },
      }),
      expect.objectContaining({
        type: "file_change",
        payload: expect.objectContaining({ path: "two.ts" }),
        tool: {
          name: "apply_patch",
          kind: "file",
          use_id: "patch-1",
          target: "two.ts",
          phase: "completed",
        },
      }),
    ]);
  });

  it("keeps one run active across a goal continuation and owned background terminal", async () => {
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    let snapshot = 0;
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as { id?: number; method: string };
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-bg" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-1" } } });
            push({
              method: "turn/started",
              params: { threadId: "thread-bg", turn: { id: "turn-1" } },
            });
            push({
              method: "item/completed",
              params: {
                item: { type: "agentMessage", id: "msg-1", text: "intermediate" },
              },
            });
            push({
              method: "item/started",
              params: {
                item: {
                  type: "commandExecution",
                  id: "cmd-owned",
                  command: "sleep 10",
                  status: "inProgress",
                },
              },
            });
            push({
              method: "turn/completed",
              params: {
                threadId: "thread-bg",
                turn: { id: "turn-1", status: "completed", items: [] },
              },
            });
          }
          if (request.method === "thread/goal/get") {
            push({
              id: request.id,
              result: { goal: { status: snapshot === 0 ? "active" : "complete" } },
            });
          }
          if (request.method === "thread/read") {
            push({
              id: request.id,
              result: {
                thread: { status: { type: snapshot === 0 ? "active" : "idle" } },
              },
            });
          }
          if (request.method === "thread/backgroundTerminals/list") {
            push({
              id: request.id,
              result: {
                data: snapshot++ === 0 ? [{ itemId: "cmd-owned", processId: "process-1" }] : [],
              },
            });
            if (snapshot === 1) {
              push({
                method: "turn/started",
                params: { threadId: "thread-bg", turn: { id: "turn-2" } },
              });
              push({
                method: "item/completed",
                params: { item: { type: "agentMessage", id: "msg-2", text: "final" } },
              });
              push({
                method: "turn/completed",
                params: {
                  threadId: "thread-bg",
                  turn: { id: "turn-2", status: "completed", items: [] },
                },
              });
            } else {
              stop = true;
              wake?.();
            }
          }
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      while (!stop || replies.length) {
        if (replies.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        } else {
          yield { type: "stdout", line: replies.shift()! };
        }
      }
    };
    const spec = HarnessRunSpec.parse({
      session_id: "session-bg",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "/fixture/codex",
      args: [],
      spec,
      env: {},
      spawn,
      pollIntervalMs: 0,
    }))
      events.push(event);

    expect(events.filter((event) => event.type === "started")).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message", text: "intermediate" }),
    );
    expect(events.find((event) => event.text === "intermediate")?.final).toBeUndefined();
    expect(events.filter((event) => event.final)).toEqual([
      expect.objectContaining({ type: "message", text: "final", final: true }),
    ]);
    expect(events.at(-1)?.type).toBe("completed");
    expect(events.at(-1)?.aborted).toBeUndefined();
  });

  it("waits for owned background before terminalizing a native system error", async () => {
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    let snapshots = 0;
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as { id?: number; method: string };
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-wait" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-wait" } } });
            push({
              method: "turn/started",
              params: { turn: { id: "turn-wait" } },
            });
            push({
              method: "item/started",
              params: {
                item: {
                  type: "commandExecution",
                  id: "cmd-wait",
                  command: "sleep 10",
                  status: "inProgress",
                },
              },
            });
            push({
              method: "item/completed",
              params: { item: { type: "agentMessage", id: "msg-wait", text: "done" } },
            });
            push({
              method: "turn/completed",
              params: {
                turn: {
                  id: "turn-wait",
                  status: "failed",
                  error: { message: "native failed" },
                  items: [],
                },
              },
            });
          }
          if (request.method === "thread/read")
            push({
              id: request.id,
              result: { thread: { status: { type: snapshots ? "systemError" : "active" } } },
            });
          if (request.method === "thread/goal/get")
            push({ id: request.id, result: { goal: { status: "complete" } } });
          if (request.method === "thread/backgroundTerminals/list") {
            push({
              id: request.id,
              result: {
                data: snapshots++
                  ? [{ itemId: "unrelated", processId: "process-unrelated" }]
                  : [
                      { itemId: "cmd-wait", processId: "process-wait" },
                      { itemId: "unrelated", processId: "process-unrelated" },
                    ],
              },
            });
            if (snapshots === 2) {
              stop = true;
              wake?.();
            }
          }
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      while (!stop || replies.length) {
        if (replies.length) yield { type: "stdout", line: replies.shift()! };
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    };
    const spec = HarnessRunSpec.parse({
      session_id: "session-wait",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "/fixture/codex",
      args: [],
      spec,
      env: {},
      spawn,
      pollIntervalMs: 0,
    }))
      events.push(event);

    expect(snapshots).toBe(2);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", error: "native failed" }),
    );
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("Stop pauses the goal, interrupts the exact turn, and terminates only owned terminals", async () => {
    const writes: Array<{ id?: number; method: string; params?: Record<string, unknown> }> = [];
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    let paused = false;
    let interrupted = false;
    const terminated = new Set<string>();
    let resolveQueued!: () => void;
    const queued = new Promise<void>((resolve) => {
      resolveQueued = resolve;
    });
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as (typeof writes)[number];
          writes.push(request);
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-stop" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-stop" } } });
            push({
              method: "turn/started",
              params: { turn: { id: "turn-stop" } },
            });
            push({
              method: "item/completed",
              params: { item: { type: "agentMessage", id: "msg-stop", text: "waiting" } },
            });
            push({
              method: "turn/completed",
              params: { turn: { id: "turn-stop", status: "completed", items: [] } },
            });
            push({ method: "turn/started", params: { turn: { id: "turn-next" } } });
            push({
              method: "item/started",
              params: {
                item: {
                  type: "commandExecution",
                  id: "cmd-stop",
                  command: "sleep 60",
                  status: "inProgress",
                },
              },
            });
            push({
              method: "item/started",
              params: {
                item: {
                  type: "commandExecution",
                  id: "cmd-stop-late",
                  command: "sleep 60",
                  status: "inProgress",
                },
              },
            });
          }
          if (request.method === "thread/goal/get")
            push({ id: request.id, result: { goal: { status: paused ? "paused" : "active" } } });
          if (request.method === "thread/goal/set") {
            paused = true;
            push({ id: request.id, result: { goal: { status: "paused" } } });
          }
          if (request.method === "turn/interrupt") {
            interrupted = true;
            push({ id: request.id, result: {} });
            push({
              method: "turn/completed",
              params: { turn: { id: "turn-next", status: "interrupted", items: [] } },
            });
          }
          if (request.method === "thread/backgroundTerminals/list")
            push({
              id: request.id,
              result: {
                data:
                  request.params?.["cursor"] === "owned-page"
                    ? !terminated.has("process-owned")
                      ? [{ itemId: "cmd-stop", processId: "process-owned" }]
                      : !terminated.has("process-late")
                        ? [{ itemId: "cmd-stop-late", processId: "process-late" }]
                        : []
                    : [{ itemId: "other", processId: "process-unrelated" }],
                nextCursor: request.params?.["cursor"] === "owned-page" ? null : "owned-page",
              },
            });
          if (request.method === "thread/backgroundTerminals/terminate") {
            terminated.add(String(request.params?.["processId"]));
            push({ id: request.id, result: {} });
          }
          if (request.method === "thread/read")
            push({
              id: request.id,
              result: {
                thread: {
                  status: { type: interrupted && terminated.size === 2 ? "idle" : "active" },
                },
              },
            });
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          stop = true;
          wake?.();
        },
        { once: true },
      );
      while (!stop || replies.length) {
        if (replies.length) {
          const line = replies.shift()!;
          yield { type: "stdout", line };
          const delivered = JSON.parse(line) as {
            method?: string;
            params?: { item?: { id?: string } };
          };
          if (delivered.method === "item/started" && delivered.params?.item?.id === "cmd-stop-late")
            resolveQueued();
        } else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    };
    const spec = HarnessRunSpec.parse({
      session_id: "session-stop",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const controller = new CodexAppServerController();
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "/fixture/codex",
      args: [],
      spec,
      env: {},
      spawn,
      controller,
      pollIntervalMs: 0,
      cancelDeadlineMs: 100,
    })) {
      events.push(event);
      if (event.type === "message") {
        await queued;
        await Promise.all([controller.cancel(), controller.cancel()]);
      }
    }

    expect(writes.filter((request) => request.method === "thread/goal/set")).toHaveLength(1);
    expect(writes.filter((request) => request.method === "turn/interrupt")).toEqual([
      expect.objectContaining({ params: { threadId: "thread-stop", turnId: "turn-next" } }),
    ]);
    expect(
      writes.filter((request) => request.method === "thread/backgroundTerminals/terminate"),
    ).toEqual([
      expect.objectContaining({
        params: { threadId: "thread-stop", processId: "process-owned" },
      }),
      expect.objectContaining({
        params: { threadId: "thread-stop", processId: "process-late" },
      }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "completed", aborted: true });
  });

  it("Stop pauses a goal between continuation turns without guessing a turn id", async () => {
    const methods: string[] = [];
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    let paused = false;
    let resolveGap!: () => void;
    const gap = new Promise<void>((resolve) => {
      resolveGap = resolve;
    });
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as { id?: number; method: string };
          methods.push(request.method);
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-gap" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-gap" } } });
            push({ method: "turn/started", params: { turn: { id: "turn-gap" } } });
            push({
              method: "turn/completed",
              params: { turn: { id: "turn-gap", status: "completed", items: [] } },
            });
          }
          if (request.method === "thread/read")
            push({
              id: request.id,
              result: { thread: { status: { type: paused ? "idle" : "active" } } },
            });
          if (request.method === "thread/goal/get")
            push({ id: request.id, result: { goal: { status: paused ? "paused" : "active" } } });
          if (request.method === "thread/goal/set") {
            paused = true;
            push({ id: request.id, result: { goal: { status: "paused" } } });
          }
          if (request.method === "thread/backgroundTerminals/list") {
            push({ id: request.id, result: { data: [] } });
            if (!paused) resolveGap();
          }
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          stop = true;
          wake?.();
        },
        { once: true },
      );
      while (!stop || replies.length) {
        if (replies.length) yield { type: "stdout", line: replies.shift()! };
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    };
    const controller = new CodexAppServerController();
    const spec = HarnessRunSpec.parse({
      session_id: "session-gap",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const events: HarnessEvent[] = [];
    const collect = (async () => {
      for await (const event of runCodexAppServer({
        bin: "/fixture/codex",
        args: [],
        spec,
        env: {},
        spawn,
        controller,
        pollIntervalMs: 0,
        cancelDeadlineMs: 100,
      }))
        events.push(event);
    })();
    await gap;
    await controller.cancel();
    await collect;

    expect(methods.filter((method) => method === "thread/goal/set")).toHaveLength(1);
    expect(methods).not.toContain("turn/interrupt");
    expect(events.at(-1)).toMatchObject({ type: "completed", aborted: true });
  });

  it.each([
    { caseName: "without turn/completed", emitTurnCompleted: false, goalStatus: "complete" },
    { caseName: "with a stale active goal", emitTurnCompleted: true, goalStatus: "active" },
  ])(
    "fails on a durable thread systemError $caseName",
    async ({ emitTurnCompleted, goalStatus }) => {
      const replies: string[] = [];
      let wake: (() => void) | undefined;
      let stop = false;
      const push = (message: unknown): void => {
        replies.push(JSON.stringify(message));
        wake?.();
        wake = undefined;
      };
      const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
        options.onSpawn?.({
          write(data) {
            const request = JSON.parse(data) as { id?: number; method: string };
            if (request.method === "initialize") push({ id: request.id, result: {} });
            if (request.method === "thread/start")
              push({ id: request.id, result: { thread: { id: "thread-system-error" } } });
            if (request.method === "turn/start") {
              push({ id: request.id, result: { turn: { id: "turn-system-error" } } });
              push({ method: "turn/started", params: { turn: { id: "turn-system-error" } } });
              if (emitTurnCompleted)
                push({
                  method: "turn/completed",
                  params: { turn: { id: "turn-system-error", status: "completed", items: [] } },
                });
              push({
                method: "thread/status/changed",
                params: {
                  threadId: "thread-system-error",
                  status: { type: "systemError" },
                },
              });
            }
            if (request.method === "thread/read")
              push({ id: request.id, result: { thread: { status: { type: "systemError" } } } });
            if (request.method === "thread/goal/get")
              push({ id: request.id, result: { goal: { status: goalStatus } } });
            if (request.method === "thread/backgroundTerminals/list")
              push({ id: request.id, result: { data: [] } });
          },
          end() {
            stop = true;
            wake?.();
          },
          closed: Promise.resolve(),
        });
        options.abortSignal?.addEventListener(
          "abort",
          () => {
            stop = true;
            wake?.();
          },
          { once: true },
        );
        while (!stop || replies.length) {
          if (replies.length) yield { type: "stdout", line: replies.shift()! };
          else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
        yield { type: "stderr", line: "app-server diagnostic" };
      };
      const events: HarnessEvent[] = [];
      for await (const event of runCodexAppServer({
        bin: "/fixture/codex",
        args: [],
        spec: HarnessRunSpec.parse({
          session_id: "session-system-error",
          intent: "implement",
          prompt: "work",
          cwd: process.cwd(),
        }),
        env: {},
        spawn,
        pollIntervalMs: 0,
      }))
        events.push(event);

      expect(events).toContainEqual(
        expect.objectContaining({ type: "error", error: expect.stringContaining("systemError") }),
      );
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        payload: { harness_reported_error: true, stderr_tail: "app-server diagnostic" },
      });
    },
  );

  it("does not publish success before app-server process death is confirmed", async () => {
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let aborted = false;
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as { id?: number; method: string };
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-survivor" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-survivor" } } });
            push({ method: "turn/started", params: { turn: { id: "turn-survivor" } } });
            push({
              method: "turn/completed",
              params: { turn: { id: "turn-survivor", status: "completed", items: [] } },
            });
          }
          if (request.method === "thread/read")
            push({ id: request.id, result: { thread: { status: { type: "idle" } } } });
          if (request.method === "thread/goal/get")
            push({ id: request.id, result: { goal: null } });
          if (request.method === "thread/backgroundTerminals/list")
            push({ id: request.id, result: { data: [] } });
        },
        end() {
          aborted = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          wake?.();
        },
        { once: true },
      );
      while (!aborted || replies.length) {
        if (replies.length) yield { type: "stdout", line: replies.shift()! };
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
      yield { type: "exit", code: null, signal: "SIGINT" };
      yield {
        type: "termination_unconfirmed",
        rootPid: 42,
        survivors: [43],
        unresolved: [],
      };
    };
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "/fixture/codex",
      args: [],
      spec: HarnessRunSpec.parse({
        session_id: "session-survivor",
        intent: "implement",
        prompt: "work",
        cwd: process.cwd(),
      }),
      env: {},
      spawn,
      pollIntervalMs: 0,
    }))
      events.push(event);

    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(events.some((event) => event.final)).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", payload: { code: "codex_control_loss" } }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: { code: "codex_control_loss", termination_unconfirmed: { survivors: [43] } },
    });
  });

  it("fails closed when native interrupt acknowledgement misses the deadline", async () => {
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    const push = (message: unknown): void => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as { id?: number; method: string };
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-timeout" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-timeout" } } });
            push({ method: "turn/started", params: { turn: { id: "turn-timeout" } } });
          }
          if (request.method === "thread/goal/get")
            push({ id: request.id, result: { goal: null } });
          // Deliberately never answer turn/interrupt.
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          stop = true;
          wake?.();
        },
        { once: true },
      );
      while (!stop || replies.length) {
        if (replies.length) yield { type: "stdout", line: replies.shift()! };
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    };
    const controller = new CodexAppServerController();
    const spec = HarnessRunSpec.parse({
      session_id: "session-timeout",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "/fixture/codex",
      args: [],
      spec,
      env: {},
      spawn,
      controller,
      cancelDeadlineMs: 1,
    })) {
      events.push(event);
      if (event.type === "started") await controller.cancel();
    }

    expect(events.find((event) => event.type === "error")?.payload?.["code"]).toBe(
      "codex_control_loss",
    );
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      aborted: true,
      payload: { code: "codex_control_loss" },
    });
  });

  it("routes adapter runs and Stop through the matching app-server controller", async () => {
    let appServerRuns = 0;
    let execRuns = 0;
    let cancels = 0;
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex-cli 0.156.1",
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      hasApiKey: () => false,
      probeEfforts: async () => null,
      runCliHarness: async function* (): AsyncGenerator<HarnessEvent> {
        execRuns++;
        throw new Error("legacy exec path must not run");
      },
      runAppServer: async function* (input): AsyncGenerator<HarnessEvent> {
        appServerRuns++;
        input.controller?.bind(async () => {
          cancels++;
          release();
        });
        yield {
          type: "started",
          session_id: input.spec.session_id,
          ts: "2026-09-24T00:00:00.000Z",
          payload: { native_session_id: "native-1" },
        };
        await stopped;
        yield {
          type: "completed",
          session_id: input.spec.session_id,
          ts: "2026-09-24T00:00:01.000Z",
          aborted: true,
        };
      },
    });
    const spec = HarnessRunSpec.parse({
      session_id: "session-adapter",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const iterator = adapter.run(spec)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      type: "status",
      effort_resolution: { requested: null, submitted: null, resolution: "omitted" },
    });
    expect((await iterator.next()).value).toMatchObject({ type: "started" });
    await adapter.cancel?.("session-adapter");
    expect((await iterator.next()).value).toMatchObject({ type: "completed", aborted: true });
    expect((await iterator.next()).done).toBe(true);
    await adapter.cancel?.("session-adapter");
    expect(appServerRuns).toBe(1);
    expect(execRuns).toBe(0);
    expect(cancels).toBe(1);
  });
});

describe("Codex live app-server events and messages", () => {
  type Request = { id?: number; method: string; params?: Record<string, unknown> };
  type Push = (message: unknown) => void;
  const STEER_TEXT = "Change of plan: stop and answer MANGO.";

  /** A scripted app-server whose first turn stays open until `finishTurn()`;
   * `onSteer` scripts the vendor's answer to `turn/steer` (default: none). */
  function liveAppServer(onSteer: (request: Request, push: Push) => void = () => {}) {
    const writes: Request[] = [];
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    let exitCode: number | null = null;
    let turnOpen = true;
    const waiters: Array<{ method: string; resolve: () => void }> = [];
    const state = { goalActive: false };
    const push: Push = (message) => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const completeTurn = (turnId: string, status: string): void => {
      turnOpen = false;
      push({
        method: "turn/completed",
        params: { threadId: "thread-live", turn: { id: turnId, status, items: [] } },
      });
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as Request;
          writes.push(request);
          for (const waiter of waiters.splice(0)) {
            if (waiter.method === request.method) waiter.resolve();
            else waiters.push(waiter);
          }
          if (request.method === "initialize") push({ id: request.id, result: {} });
          if (request.method === "thread/start")
            push({ id: request.id, result: { thread: { id: "thread-live" } } });
          if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-live" } } });
            push({
              method: "turn/started",
              params: { threadId: "thread-live", turn: { id: "turn-live" } },
            });
            push({
              method: "item/started",
              params: {
                item: {
                  type: "commandExecution",
                  id: "cmd-live",
                  command: "sleep 3",
                  status: "inProgress",
                },
                threadId: "thread-live",
                turnId: "turn-live",
              },
            });
          }
          if (request.method === "turn/steer") onSteer(request, push);
          if (request.method === "turn/interrupt") {
            push({ id: request.id, result: {} });
            completeTurn("turn-live", "interrupted");
          }
          if (request.method === "thread/read")
            push({
              id: request.id,
              result: { thread: { status: { type: turnOpen ? "active" : "idle" } } },
            });
          if (request.method === "thread/goal/get")
            push({
              id: request.id,
              result: { goal: state.goalActive ? { status: "active" } : null },
            });
          if (request.method === "thread/backgroundTerminals/list")
            push({ id: request.id, result: { data: [] } });
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          stop = true;
          wake?.();
        },
        { once: true },
      );
      while (!stop || replies.length) {
        if (replies.length) yield { type: "stdout", line: replies.shift()! };
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
      if (exitCode !== null) yield { type: "exit", code: exitCode, signal: null };
    };
    return {
      spawn,
      writes,
      push,
      state,
      finishTurn: (): void => completeTurn("turn-live", "completed"),
      startTurn: (turnId: string): void => {
        turnOpen = true;
        push({ method: "turn/started", params: { threadId: "thread-live", turn: { id: turnId } } });
      },
      completeTurn,
      crash: (code = 1): void => {
        exitCode = code;
        stop = true;
        wake?.();
      },
      /** Resolves on the NEXT request of that method (register before triggering it). */
      nextWrite: (method: string): Promise<void> =>
        new Promise<void>((resolve) => waiters.push({ method, resolve })),
    };
  }

  const echo = (
    method: "item/started" | "item/completed",
    clientId: string,
    turnId = "turn-live",
  ): unknown => ({
    method,
    params: {
      item: {
        type: "userMessage",
        id: "user-live",
        clientId,
        content: [{ type: "text", text: STEER_TEXT, text_elements: [] }],
      },
      threadId: "thread-live",
      turnId,
    },
  });

  const spec = HarnessRunSpec.parse({
    session_id: "session-live",
    intent: "implement",
    prompt: "work",
    cwd: process.cwd(),
  });

  type Server = ReturnType<typeof liveAppServer>;
  /** Runs the scripted server on a free-running consumer so the run's main loop
   * keeps advancing while the test orchestrates from outside. */
  function start(server: Server, options: Partial<CodexAppServerRunInput> = {}) {
    const controller = new CodexAppServerController();
    const events: HarnessEvent[] = [];
    const watchers: Array<{ match: (event: HarnessEvent) => boolean; resolve: () => void }> = [];
    const done = (async () => {
      for await (const event of runCodexAppServer({
        bin: "/fixture/codex",
        args: [],
        spec,
        env: {},
        spawn: server.spawn,
        controller,
        pollIntervalMs: 0,
        cancelDeadlineMs: 200,
        ...options,
      })) {
        events.push(event);
        for (const watcher of watchers.splice(0)) {
          if (watcher.match(event)) watcher.resolve();
          else watchers.push(watcher);
        }
      }
    })();
    return {
      controller,
      events,
      done,
      /** Resolves once an event matching `match` has been seen (past or future). */
      seen: (match: (event: HarnessEvent) => boolean): Promise<void> =>
        events.some(match)
          ? Promise.resolve()
          : new Promise<void>((resolve) => watchers.push({ match, resolve })),
    };
  }
  const started = (event: HarnessEvent): boolean => event.type === "started";
  const steerWrites = (server: Server): Request[] =>
    server.writes.filter((request) => request.method === "turn/steer");
  const statusEvents = (events: HarnessEvent[]): HarnessEvent[] =>
    events.filter((event) => event.type === "status");

  it.each(["completed", "failed", "systemError", 0, 7] as const)(
    "keeps native retry activity separate from terminal outcome %s",
    async (outcome) => {
      const server = liveAppServer();
      const run = start(server);
      await run.seen(started);
      for (const notification of retryNotifications) {
        server.push({
          ...notification,
          params: {
            ...(notification["params"] as object),
            threadId: "thread-live",
            turnId: "turn-live",
          },
        });
      }
      server.push({ method: "unmapped/fixture", params: {} });
      server.push({
        method: "item/completed",
        params: {
          threadId: "thread-live",
          turnId: "turn-live",
          item: { type: "agentMessage", id: "answer", text: "OK" },
        },
      });
      if (typeof outcome === "number") server.crash(outcome);
      else {
        if (outcome === "systemError") {
          // Recorded exhaustion order: systemError, non-retrying error, failed turn.
          server.push({
            method: "thread/status/changed",
            params: { threadId: "thread-live", status: { type: "systemError" } },
          });
          server.push({
            method: "error",
            params: { willRetry: false, error: { message: "retry exhausted" } },
          });
        }
        server.completeTurn("turn-live", outcome === "systemError" ? "failed" : outcome);
      }
      await run.done;
      expect(statusEvents(run.events).map((event) => event.status)).toEqual([
        { kind: "api_retry" },
        { kind: "api_retry" },
      ]);
      expect(run.events.filter((event) => event.type === "completed")).toHaveLength(1);
      expect(server.writes.filter((request) => request.method === "turn/start")).toHaveLength(1);
      expect(server.writes.filter((request) => request.method === "thread/start")).toHaveLength(1);
      if (outcome === "completed") {
        expect(run.events.filter((event) => event.type === "error")).toEqual([]);
        expect(run.events.filter((event) => event.final)).toEqual([
          expect.objectContaining({ text: "OK", final: true }),
        ]);
        expect(run.events.at(-1)?.payload?.["dropped_unrecognized_events"]).toBe(1);
        expect(run.events.at(-1)?.payload?.["harness_reported_error"]).toBeUndefined();
      } else {
        expect(run.events.filter((event) => event.type === "error")).toHaveLength(1);
        expect(run.events.filter((event) => event.final)).toEqual([]);
        if (typeof outcome === "number")
          expect(run.events.at(-1)?.payload?.["code"]).toBe("codex_app_server_failure");
        else expect(run.events.at(-1)?.payload?.["harness_reported_error"]).toBe(true);
      }
    },
  );

  it("answers accepted on {turnId}; the later userMessage echo yields one delivered receipt", async () => {
    const server = liveAppServer((request, push) =>
      push({ id: request.id, result: { turnId: "turn-live" } }),
    );
    const run = start(server);
    await run.seen(started);
    await expect(run.controller.steer({ messageId: "msg-1", text: STEER_TEXT })).resolves.toEqual({
      outcome: "accepted",
      nativeTurnId: "turn-live",
    });
    // The vendor consumes the message later (2.9 s live) and echoes it twice
    // (item/started + item/completed): ONE receipt, and neither frame counts
    // as a dropped unrecognized event.
    server.push(echo("item/started", "msg-1"));
    server.push(echo("item/completed", "msg-1"));
    await run.seen((event) => event.type === "status");
    server.finishTurn();
    await run.done;

    expect(steerWrites(server)).toEqual([
      expect.objectContaining({
        params: {
          threadId: "thread-live",
          expectedTurnId: "turn-live",
          clientUserMessageId: "msg-1",
          input: [{ type: "text", text: STEER_TEXT, text_elements: [] }],
        },
      }),
    ]);
    expect(statusEvents(run.events)).toEqual([
      expect.objectContaining({
        type: "status",
        session_id: "session-live",
        payload: { code: "live_input_delivered", message_id: "msg-1", native_turn_id: "turn-live" },
      }),
    ]);
    expect(run.events.at(-1)).toMatchObject({ type: "completed" });
    expect(run.events.at(-1)?.aborted).toBeUndefined();
    expect(run.events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
    expect(run.events.at(-1)?.payload).not.toHaveProperty("dropped_unrecognized_events");
  });

  it("settles as delivered when the echo arrives before the vendor's reply", async () => {
    const server = liveAppServer((request, push) => {
      const clientId = String(request.params?.["clientUserMessageId"]);
      push(echo("item/started", clientId));
      push({ id: request.id, result: { turnId: "turn-live" } });
    });
    const run = start(server);
    await run.seen(started);
    await expect(
      run.controller.steer({ messageId: "msg-early", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "delivered", nativeTurnId: "turn-live" });
    server.finishTurn();
    await run.done;
    expect(statusEvents(run.events)).toHaveLength(1);
    expect(run.events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
  });

  it("ignores a same-id echo on another turn and a foreign clientId", async () => {
    const server = liveAppServer((request, push) => {
      const clientId = String(request.params?.["clientUserMessageId"]);
      push(echo("item/started", clientId, "turn-other"));
      push(echo("item/started", "someone-else", "turn-live"));
      push({ id: request.id, result: { turnId: "turn-live" } });
    });
    const run = start(server);
    await run.seen(started);
    await expect(
      run.controller.steer({ messageId: "msg-strict", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "accepted", nativeTurnId: "turn-live" });
    server.finishTurn();
    await run.done;
    expect(statusEvents(run.events)).toHaveLength(0);
  });

  it("answers not_active without an RPC when no turn is active (goal-continuation gap)", async () => {
    const server = liveAppServer();
    server.state.goalActive = true;
    const run = start(server);
    await run.seen(started);
    // turn/completed with an ACTIVE goal: the run stays alive waiting for the
    // continuation turn, and activeTurnId is null meanwhile.
    const gap = server.nextWrite("thread/read");
    server.finishTurn();
    await gap;
    await expect(run.controller.steer({ messageId: "msg-gap", text: STEER_TEXT })).resolves.toEqual(
      { outcome: "not_active", reason: "no_active_turn" },
    );
    server.state.goalActive = false;
    server.startTurn("turn-2");
    server.completeTurn("turn-2", "completed");
    await run.done;
    expect(steerWrites(server)).toEqual([]);
    expect(run.events.at(-1)).toMatchObject({ type: "completed" });
    expect(run.events.at(-1)?.aborted).toBeUndefined();
  });

  it("maps a vendor refusal on the still-active turn to rejected without tainting the run", async () => {
    const server = liveAppServer((request, push) =>
      // Every codex refusal shares -32600; the prose is NOT consulted.
      push({ id: request.id, error: { code: -32600, message: "no active turn to steer" } }),
    );
    const run = start(server);
    await run.seen(started);
    await expect(
      run.controller.steer({ messageId: "msg-refused", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "rejected", reason: "rpc_refused" });
    server.finishTurn();
    await run.done;
    expect(run.events.filter((event) => event.type === "error")).toEqual([]);
    expect(run.events.at(-1)).toMatchObject({ type: "completed" });
    expect(run.events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
  });

  it("maps a refusal that lands after the turn moved on to not_active", async () => {
    const server = liveAppServer((request, push) => {
      server.finishTurn();
      push({ id: request.id, error: { code: -32600, message: "no active turn to steer" } });
    });
    const run = start(server);
    await run.seen(started);
    await expect(
      run.controller.steer({ messageId: "msg-late", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "not_active", reason: "no_active_turn" });
    await run.done;
    expect(run.events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
  });

  it("answers delivery_unknown on a missed deadline and never cancels the run", async () => {
    const server = liveAppServer();
    const run = start(server, { steerDeadlineMs: 5 });
    await run.seen(started);
    await expect(
      run.controller.steer({ messageId: "msg-slow", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "delivery_unknown", reason: "response_timeout" });
    server.finishTurn();
    await run.done;
    expect(steerWrites(server)).toHaveLength(1);
    expect(run.events.at(-1)).toMatchObject({ type: "completed" });
    expect(run.events.at(-1)?.aborted).toBeUndefined();
    expect(run.events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
  });

  it("answers delivery_unknown when the app-server dies before replying", async () => {
    const server = liveAppServer(() => server.crash());
    const run = start(server);
    await run.seen(started);
    await expect(
      run.controller.steer({ messageId: "msg-lost", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "delivery_unknown", reason: "transport_lost" });
    await run.done;
    expect(run.events.at(-1)).toMatchObject({
      type: "completed",
      payload: { code: "codex_app_server_failure" },
    });
  });

  it("answers not_active after Stop and after the session ended; unsupported when never bound", async () => {
    const server = liveAppServer();
    const run = start(server);
    await run.seen(started);
    await run.controller.cancel();
    await expect(
      run.controller.steer({ messageId: "msg-stopped", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "not_active", reason: "no_active_turn" });
    await run.done;
    expect(steerWrites(server)).toEqual([]);
    expect(run.events.at(-1)).toMatchObject({ type: "completed", aborted: true });
    await expect(
      run.controller.steer({ messageId: "msg-after", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "not_active", reason: "no_active_turn" });
    await expect(
      new CodexAppServerController().steer({ messageId: "msg-unbound", text: STEER_TEXT }),
    ).resolves.toEqual({ outcome: "unsupported", reason: "no_live_session" });
  });

  it("routes adapter.message through the session's app-server controller", async () => {
    const seen: Array<{ messageId: string; text: string }> = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex-cli 0.156.1",
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      hasApiKey: () => false,
      probeEfforts: async () => null,
      runCliHarness: async function* (): AsyncGenerator<HarnessEvent> {
        throw new Error("legacy exec path must not run");
      },
      runAppServer: async function* (input): AsyncGenerator<HarnessEvent> {
        input.controller?.bindSteer(async (message) => {
          seen.push(message);
          return { outcome: "accepted", nativeTurnId: "native-turn" };
        });
        yield {
          type: "started",
          session_id: input.spec.session_id,
          ts: "2026-09-26T00:00:00.000Z",
        };
        await held;
        yield {
          type: "completed",
          session_id: input.spec.session_id,
          ts: "2026-09-26T00:00:01.000Z",
        };
      },
    });
    const runSpec = HarnessRunSpec.parse({
      session_id: "session-message",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const iterator = adapter.run(runSpec)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      type: "status",
      effort_resolution: { requested: null, submitted: null, resolution: "omitted" },
    });
    expect((await iterator.next()).value).toMatchObject({ type: "started" });
    await expect(
      adapter.message?.("session-message", { messageId: "msg-a", text: "steer" }),
    ).resolves.toEqual({ outcome: "accepted", nativeTurnId: "native-turn" });
    await expect(
      adapter.message?.("session-unknown", { messageId: "msg-b", text: "steer" }),
    ).resolves.toEqual({ outcome: "unsupported", reason: "no_live_session" });
    release();
    expect((await iterator.next()).value).toMatchObject({ type: "completed" });
    expect((await iterator.next()).done).toBe(true);
    // The finished session's controller is gone from the map.
    await expect(
      adapter.message?.("session-message", { messageId: "msg-c", text: "steer" }),
    ).resolves.toEqual({ outcome: "unsupported", reason: "no_live_session" });
    expect(seen).toEqual([{ messageId: "msg-a", text: "steer" }]);
  });

  it("answers unsupported on the legacy exec path, which has no app-server channel", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex-cli 0.156.1",
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      hasApiKey: () => false,
      probeEfforts: async () => null,
      runCliHarness: async function* (input): AsyncGenerator<HarnessEvent> {
        yield {
          type: "started",
          session_id: input.spec.session_id,
          ts: "2026-09-26T00:00:00.000Z",
        };
        await held;
        yield {
          type: "completed",
          session_id: input.spec.session_id,
          ts: "2026-09-26T00:00:01.000Z",
        };
      },
    });
    const runSpec = HarnessRunSpec.parse({
      session_id: "session-exec",
      intent: "implement",
      prompt: "work",
      cwd: process.cwd(),
    });
    const iterator = adapter.run(runSpec)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      type: "status",
      effort_resolution: { requested: null, submitted: null, resolution: "omitted" },
    });
    expect((await iterator.next()).value).toMatchObject({ type: "started" });
    await expect(
      adapter.message?.("session-exec", { messageId: "msg-exec", text: "steer" }),
    ).resolves.toEqual({ outcome: "unsupported", reason: "no_live_session" });
    release();
    expect((await iterator.next()).value).toMatchObject({ type: "completed" });
    expect((await iterator.next()).done).toBe(true);
  });
});

describe("Codex app-server root-thread ownership (native sub-agents)", () => {
  type Request = { id?: number; method: string; params?: Record<string, unknown> };
  type Push = (message: unknown) => void;
  const ROOT = "thread-root";
  const CHILD = "thread-child";

  /** A scripted app-server: `script` answers each request; thread/read,
   * thread/goal/get and thread/backgroundTerminals/list answer from `lifecycle`. */
  function scriptedServer(
    script: (request: Request, push: Push) => void,
    lifecycle: (method: string) => { status: string; goal?: unknown; background?: unknown[] },
    afterFrame?: (frame: Record<string, unknown>) => void,
  ) {
    const writes: Request[] = [];
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    const push: Push = (message) => {
      replies.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    };
    const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
      options.onSpawn?.({
        write(data) {
          const request = JSON.parse(data) as Request;
          writes.push(request);
          if (request.method === "initialize") push({ id: request.id, result: {} });
          else if (request.method === "thread/read")
            push({
              id: request.id,
              result: { thread: { status: { type: lifecycle(request.method).status } } },
            });
          else if (request.method === "thread/goal/get")
            push({ id: request.id, result: { goal: lifecycle(request.method).goal ?? null } });
          else if (request.method === "thread/backgroundTerminals/list")
            push({ id: request.id, result: { data: lifecycle(request.method).background ?? [] } });
          else script(request, push);
        },
        end() {
          stop = true;
          wake?.();
        },
        closed: Promise.resolve(),
      });
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          stop = true;
          wake?.();
        },
        { once: true },
      );
      while (!stop || replies.length) {
        if (replies.length) {
          const line = replies.shift()!;
          yield { type: "stdout", line };
          afterFrame?.(JSON.parse(line));
        } else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    };
    return { spawn, writes };
  }
  const agentMessage = (threadId: string, turnId: string, id: string, text: string): unknown => ({
    method: "item/completed",
    params: { item: { type: "agentMessage", id, text }, threadId, turnId },
  });
  const turnStarted = (threadId: string, turnId: string): unknown => ({
    method: "turn/started",
    params: { threadId, turn: { id: turnId } },
  });
  const turnCompleted = (threadId: string, turnId: string, status = "completed"): unknown => ({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status, items: [] } },
  });
  async function collect(
    spawn: typeof spawnProcess,
    specExtra: Record<string, unknown> = {},
    controller?: CodexAppServerController,
  ): Promise<HarnessEvent[]> {
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "/fixture/codex",
      args: [],
      spec: HarnessRunSpec.parse({
        session_id: "session-subagents",
        intent: "review",
        prompt: "review",
        cwd: process.cwd(),
        ...specExtra,
      }),
      env: {},
      spawn,
      controller,
      pollIntervalMs: 0,
    }))
      events.push(event);
    return events;
  }

  // Each bit independently places one child notification before/after the RPC
  // reply. Exercise the real loop, including immediate control-state effects.
  const startupCases = ["start", "resume"].flatMap((operation) =>
    Array.from({ length: 16 }, (_, beforeMask) => ({ operation, beforeMask })),
  );
  it.each(startupCases)(
    "classifies child notifications around thread/$operation (before mask $beforeMask)",
    async ({ operation, beforeMask }) => {
      const controller = new CodexAppServerController();
      let earlySteer: ReturnType<typeof controller.steer> | undefined;
      let backgroundReads = 0;
      const command = { type: "commandExecution", id: "cmd-child", command: "cat missing.py" };
      const frames = [
        {
          method: "thread/status/changed",
          params: { threadId: CHILD, status: { type: "systemError" } },
        },
        {
          method: "item/started",
          params: {
            threadId: CHILD,
            turnId: "turn-child",
            item: { ...command, status: "inProgress" },
          },
        },
        turnStarted(CHILD, "turn-child"),
        agentMessage(CHILD, "turn-child", "msg-child", "child answer"),
      ];
      const server = scriptedServer(
        (request, push) => {
          if (request.method === `thread/${operation}`) {
            frames.forEach((frame, index) => {
              if (beforeMask & (1 << index)) push(frame);
            });
            push({ id: request.id, result: { thread: { id: ROOT } } });
            frames.forEach((frame, index) => {
              if (!(beforeMask & (1 << index))) push(frame);
            });
          } else if (request.method === "turn/steer") {
            push({ id: request.id, result: { turnId: "turn-child" } });
          } else if (request.method === "turn/start") {
            // No root turn exists yet: an early child turn must not become a
            // steer target merely because the thread reply has now arrived.
            earlySteer = controller.steer({ messageId: "early-steer", text: "focus" });
            push({ id: request.id, result: { turn: { id: "turn-root" } } });
            push(turnStarted(ROOT, "turn-root"));
            push({
              method: "item/completed",
              params: {
                threadId: CHILD,
                turnId: "turn-child",
                item: {
                  ...command,
                  status: "failed",
                  exitCode: 1,
                  aggregatedOutput: "missing file",
                },
              },
            });
            for (const threadId of [CHILD, ROOT])
              push({
                method: "thread/tokenUsage/updated",
                params: { threadId, tokenUsage: { last: { inputTokens: 17, outputTokens: 3 } } },
              });
            push(turnCompleted(CHILD, "turn-child", "failed"));
            push(agentMessage(ROOT, "turn-root", "msg-root", "root answer"));
            push(turnCompleted(ROOT, "turn-root"));
          }
        },
        (method) => ({
          status: "idle",
          // If incorrectly owned, this child terminal forces an extra poll.
          background:
            method === "thread/backgroundTerminals/list" && backgroundReads++ === 0
              ? [{ itemId: "cmd-child", processId: "process-child" }]
              : [],
        }),
      );
      const events = await collect(
        server.spawn,
        operation === "resume" ? { resume_session_id: ROOT } : {},
        controller,
      );
      for (const event of events) expect(HarnessEvent.safeParse(event).success).toBe(true);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(events.filter((event) => event.final)).toEqual([
        expect.objectContaining({ type: "message", text: "root answer", final: true }),
      ]);
      expect(
        events
          .filter((event) => event.type === "message")
          .every((event) => event.text === "root answer"),
      ).toBe(true);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "status",
          text: "child answer",
          payload: expect.objectContaining({
            code: "subagent_message",
            native_thread_id: CHILD,
            subagent: true,
          }),
        }),
      );
      expect(events.filter((event) => event.tool?.use_id === "cmd-child")).toEqual([
        expect.objectContaining({
          type: "tool_call",
          payload: expect.objectContaining({ subagent: true }),
        }),
        expect.objectContaining({
          type: "tool_result",
          tool: expect.objectContaining({ status: "error", exit_code: 1 }),
          payload: expect.objectContaining({ subagent: true }),
        }),
      ]);
      expect(
        events.filter((event) => event.type === "usage").map((event) => event.usage?.input_tokens),
      ).toEqual([17, 17]);
      expect(events[0]).toMatchObject({
        type: "started",
        payload: { native_session_id: ROOT, native_turn_id: "turn-root" },
      });
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        payload: { native_session_id: ROOT, native_turn_id: "turn-root", subagent_threads: 1 },
      });
      expect(events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
      await expect(earlySteer).resolves.toEqual({
        outcome: "not_active",
        reason: "no_active_turn",
      });
      expect(server.writes.filter((request) => request.method === "turn/steer")).toEqual([]);
      expect(backgroundReads).toBe(1);
      if (operation === "resume")
        expect(
          server.writes.find((request) => request.method === "thread/resume")?.params,
        ).toMatchObject({ threadId: ROOT });
    },
  );

  it.each(["start", "resume"])(
    "retains root systemError received before thread/%s replies",
    async (operation) => {
      const server = scriptedServer(
        (request, push) => {
          if (request.method === `thread/${operation}`) {
            push({
              method: "thread/status/changed",
              params: { threadId: ROOT, status: { type: "systemError" } },
            });
            push({ id: request.id, result: { thread: { id: ROOT } } });
          } else if (request.method === "turn/start") {
            push({ id: request.id, result: { turn: { id: "turn-root" } } });
            push(turnStarted(ROOT, "turn-root"));
            push(agentMessage(ROOT, "turn-root", "msg-root", "root answer"));
            push(turnCompleted(ROOT, "turn-root"));
          }
        },
        () => ({ status: "idle" }),
      );
      const events = await collect(
        server.spawn,
        operation === "resume" ? { resume_session_id: ROOT } : {},
      );
      expect(events.filter((event) => event.type === "error")).toEqual([
        expect.objectContaining({ error: "Codex app-server thread settled in systemError" }),
      ]);
      expect(events.filter((event) => event.final)).toEqual([]);
      expect(events.at(-1)?.payload).toMatchObject({ harness_reported_error: true });
    },
  );

  it("binds a resumed root before the reply so an early root turn can be steered", async () => {
    const controller = new CodexAppServerController();
    let earlySteer: ReturnType<typeof controller.steer> | undefined;
    const server = scriptedServer(
      (request, push) => {
        if (request.method === "thread/resume") {
          push(turnStarted(ROOT, "turn-inherited"));
          push(turnStarted(CHILD, "turn-child"));
          push({ id: request.id, result: { thread: { id: ROOT } } });
        } else if (request.method === "turn/steer") {
          push({ id: request.id, result: { turnId: "turn-inherited" } });
        } else if (request.method === "turn/start") {
          push({ id: request.id, result: { turn: { id: "turn-root" } } });
          push(turnStarted(ROOT, "turn-root"));
          push(agentMessage(ROOT, "turn-root", "msg-root", "root answer"));
          push(turnCompleted(ROOT, "turn-root"));
        }
      },
      () => ({ status: "idle" }),
      (frame) => {
        const params = frame.params as Record<string, unknown> | undefined;
        if (frame.method === "turn/started" && params?.threadId === CHILD)
          earlySteer = controller.steer({ messageId: "early-steer", text: "focus" });
      },
    );
    const events = await collect(server.spawn, { resume_session_id: ROOT }, controller);
    await expect(earlySteer).resolves.toEqual({
      outcome: "accepted",
      nativeTurnId: "turn-inherited",
    });
    expect(server.writes.find((request) => request.method === "turn/steer")?.params).toMatchObject({
      threadId: ROOT,
      expectedTurnId: "turn-inherited",
    });
    expect(events.filter((event) => event.final)).toEqual([
      expect.objectContaining({ text: "root answer", final: true }),
    ]);
  });

  it("does not send cancellation RPCs to a resumed thread before its resume reply", async () => {
    const controller = new CodexAppServerController();
    let cancelled: Promise<void> | undefined;
    const server = scriptedServer(
      (request) => {
        // The resume reply never arrives: the stop lands during the handshake.
        if (request.method === "thread/resume") cancelled = controller.cancel();
      },
      () => ({ status: "idle" }),
    );
    const events = await collect(server.spawn, { resume_session_id: ROOT }, controller);
    await cancelled;
    const methods = server.writes.map((request) => request.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/goal/get");
    expect(methods).not.toContain("thread/read");
    expect(methods).not.toContain("turn/interrupt");
    expect(events.at(-1)).toMatchObject({ type: "completed", aborted: true });
  });

  it.each([false, true])(
    "replays early root effects in order after start (turn completed=%s)",
    async (completed) => {
      const controller = new CodexAppServerController();
      let earlySteer: ReturnType<typeof controller.steer> | undefined;
      let backgroundReads = 0;
      const server = scriptedServer(
        (request, push) => {
          if (request.method === "thread/start") {
            push(turnStarted(ROOT, "turn-inherited"));
            push({
              method: "item/started",
              params: {
                threadId: ROOT,
                item: {
                  type: "commandExecution",
                  id: "cmd-root",
                  command: "sleep 1",
                  status: "inProgress",
                },
              },
            });
            if (completed) push(turnCompleted(ROOT, "turn-inherited"));
            push(turnStarted(CHILD, "turn-child"));
            // Legacy untagged MCP frames also wait for root binding; their order
            // matters because a reversed replay would leave this server starting.
            for (const status of ["starting", "ready"])
              push({
                method: "mcpServer/startupStatus/updated",
                params: { name: "required_one", status },
              });
            push({ id: request.id, result: { thread: { id: ROOT } } });
          } else if (request.method === "turn/start") {
            earlySteer = controller.steer({ messageId: "early-steer", text: "focus" });
            push({ id: request.id, result: { turn: { id: "turn-root" } } });
            push(turnStarted(ROOT, "turn-root"));
            push(agentMessage(ROOT, "turn-root", "msg-root", "root answer"));
            push(turnCompleted(ROOT, "turn-root"));
          } else if (request.method === "turn/steer") {
            push({ id: request.id, result: { turnId: request.params?.expectedTurnId } });
          }
        },
        (method) => ({
          status: "idle",
          background:
            method === "thread/backgroundTerminals/list" && backgroundReads++ === 0
              ? [{ itemId: "cmd-root", processId: "process-root" }]
              : [],
        }),
      );
      const events = await collect(
        server.spawn,
        {
          extra_mcp_servers: [
            { name: "required_one", command: "/bin/echo", args: [], env: {}, required: true },
          ],
        },
        controller,
      );
      await expect(earlySteer).resolves.toEqual(
        completed
          ? { outcome: "not_active", reason: "no_active_turn" }
          : { outcome: "accepted", nativeTurnId: "turn-inherited" },
      );
      expect(backgroundReads).toBeGreaterThanOrEqual(2);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(events.filter((event) => event.final)).toEqual([
        expect.objectContaining({ text: "root answer", final: true }),
      ]);
      expect(events[0]?.payload?.mcp_servers).toEqual([
        { name: "required_one", status: "connected" },
      ]);
      expect(events.find((event) => event.type === "tool_call")?.payload).not.toHaveProperty(
        "subagent",
      );
    },
    2_000,
  );

  it("finalizes the ROOT turn when a sub-agent turn finishes last with different text", async () => {
    const server = scriptedServer(
      (request, push) => {
        if (request.method === "thread/start")
          push({ id: request.id, result: { thread: { id: ROOT } } });
        if (request.method === "turn/start") {
          push({ id: request.id, result: { turn: { id: "turn-root" } } });
          push(turnStarted(ROOT, "turn-root"));
          push(agentMessage(ROOT, "turn-root", "msg-root", "root verdict: PASS"));
          push(turnStarted(CHILD, "turn-child"));
          push({
            method: "thread/tokenUsage/updated",
            params: {
              threadId: CHILD,
              turnId: "turn-child",
              tokenUsage: { last: { inputTokens: 500, outputTokens: 20 } },
            },
          });
          push(agentMessage(CHILD, "turn-child", "msg-child", "[]\nNO_FINDINGS"));
          push(turnCompleted(ROOT, "turn-root"));
          push(turnCompleted(CHILD, "turn-child"));
          push({
            method: "thread/status/changed",
            params: { threadId: CHILD, status: { type: "idle" } },
          });
        }
      },
      () => ({ status: "idle" }),
    );
    const events = await collect(server.spawn);

    expect(events.filter((event) => event.final)).toEqual([
      expect.objectContaining({ type: "message", text: "root verdict: PASS", final: true }),
    ]);
    expect(events.filter((event) => event.type === "message").map((event) => event.text)).toEqual([
      "root verdict: PASS",
      "root verdict: PASS",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "status",
        text: "[]\nNO_FINDINGS",
        payload: {
          code: "subagent_message",
          native_thread_id: CHILD,
          native_turn_id: "turn-child",
          subagent: true,
        },
      }),
    );
    expect(events.filter((event) => event.type === "usage")).toEqual([
      expect.objectContaining({
        usage: expect.objectContaining({ input_tokens: 500, output_tokens: 20 }),
        payload: expect.objectContaining({ native_thread_id: CHILD, subagent: true }),
      }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: { native_session_id: ROOT, native_turn_id: "turn-root", subagent_threads: 1 },
    });
    expect(events.at(-1)?.aborted).toBeUndefined();
  });

  it("never fails the root on a sub-agent's systemError or failed command, and never steers its turn", async () => {
    const server = scriptedServer(
      (request, push) => {
        if (request.method === "thread/start")
          push({ id: request.id, result: { thread: { id: ROOT } } });
        if (request.method === "turn/start") {
          push({ id: request.id, result: { turn: { id: "turn-root" } } });
          push(turnStarted(ROOT, "turn-root"));
          push(turnStarted(CHILD, "turn-child"));
          push({
            method: "item/started",
            params: {
              item: {
                type: "commandExecution",
                id: "cmd-child",
                command: "cat missing.py",
                status: "inProgress",
              },
              threadId: CHILD,
              turnId: "turn-child",
            },
          });
          push({
            method: "item/completed",
            params: {
              item: {
                type: "commandExecution",
                id: "cmd-child",
                command: "cat missing.py",
                status: "failed",
                exitCode: 1,
                aggregatedOutput: "cat: missing.py: No such file or directory",
              },
              threadId: CHILD,
              turnId: "turn-child",
            },
          });
          push({
            method: "thread/status/changed",
            params: { threadId: CHILD, status: { type: "systemError" } },
          });
          push(turnCompleted(CHILD, "turn-child", "failed"));
          push(agentMessage(ROOT, "turn-root", "msg-root", "ok"));
          push(turnCompleted(ROOT, "turn-root"));
        }
      },
      () => ({ status: "idle" }),
    );
    const controller = new CodexAppServerController();
    const events: HarnessEvent[] = [];
    let steered: Promise<unknown> | undefined;
    for await (const event of runCodexAppServer({
      bin: "/fixture/codex",
      args: [],
      spec: HarnessRunSpec.parse({
        session_id: "session-subagents",
        intent: "review",
        prompt: "review",
        cwd: process.cwd(),
      }),
      env: {},
      spawn: server.spawn,
      controller,
      pollIntervalMs: 0,
    })) {
      events.push(event);
      // Steer while the child turn is the latest started: the root turn is the target.
      if (event.type === "tool_call" && !steered)
        steered = controller.steer({ messageId: "msg-steer", text: "focus" });
    }

    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(events.filter((event) => event.final)).toEqual([
      expect.objectContaining({ text: "ok", final: true }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        tool: expect.objectContaining({ use_id: "cmd-child", status: "error", exit_code: 1 }),
        payload: expect.objectContaining({ native_thread_id: CHILD, subagent: true }),
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: { native_turn_id: "turn-root", subagent_threads: 1 },
    });
    expect(events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
    expect(server.writes.filter((request) => request.method === "turn/steer")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ threadId: ROOT, expectedTurnId: "turn-root" }),
      }),
    ]);
  });

  it("resumes a plan-review thread and waits for the ROOT turn even when an inherited sub-agent turn starts first", async () => {
    const server = scriptedServer(
      (request, push) => {
        if (request.method === "thread/resume")
          push({ id: request.id, result: { thread: { id: ROOT } } });
        if (request.method === "turn/start") {
          push({ id: request.id, result: { turn: { id: "turn-root-2" } } });
          push(turnStarted(CHILD, "turn-child-2"));
          push(agentMessage(CHILD, "turn-child-2", "msg-child", "child text"));
          push(turnStarted(ROOT, "turn-root-2"));
          push(agentMessage(ROOT, "turn-root-2", "msg-root", "root text"));
          push(turnCompleted(CHILD, "turn-child-2"));
          push(turnCompleted(ROOT, "turn-root-2"));
        }
      },
      () => ({ status: "idle" }),
    );
    const events = await collect(server.spawn, { resume_session_id: ROOT });

    expect(
      server.writes.find((request) => request.method === "thread/resume")?.params,
    ).toMatchObject({
      threadId: ROOT,
    });
    expect(server.writes.map((request) => request.method)).not.toContain("thread/start");
    expect(events[0]).toMatchObject({
      type: "started",
      payload: { native_session_id: ROOT, native_turn_id: "turn-root-2" },
    });
    expect(events.filter((event) => event.final)).toEqual([
      expect.objectContaining({ text: "root text", final: true }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: { native_turn_id: "turn-root-2", subagent_threads: 1 },
    });
  });

  it("re-checks thread settlement in silence after the root turn completed", async () => {
    let reads = 0;
    const server = scriptedServer(
      (request, push) => {
        if (request.method === "thread/start")
          push({ id: request.id, result: { thread: { id: ROOT } } });
        if (request.method === "turn/start") {
          push({ id: request.id, result: { turn: { id: "turn-root" } } });
          push(turnStarted(ROOT, "turn-root"));
          push(agentMessage(ROOT, "turn-root", "msg-root", "late settle"));
          push(turnCompleted(ROOT, "turn-root"));
          // No further notification ever arrives: the thread reports active once,
          // then idle, and only the poll re-check can observe it.
        }
      },
      () => ({ status: reads++ === 0 ? "active" : "idle" }),
    );
    const events = await collect(server.spawn);

    expect(events.filter((event) => event.final)).toEqual([
      expect.objectContaining({ text: "late settle", final: true }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: { native_turn_id: "turn-root" },
    });
    expect(
      server.writes.filter((request) => request.method === "thread/read").length,
    ).toBeGreaterThanOrEqual(2);
  });
});
