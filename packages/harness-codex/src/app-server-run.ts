import { spawnProcess, type ChildStdin, type SpawnOptions } from "@claudexor/core";
import { verifyCodexAttachments } from "./attachments.js";
import type { HarnessEvent } from "@claudexor/schema";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import {
  asObject,
  CodexServerRequestRefusal,
  codexAppServerEvents,
  codexRequestRefusal,
  createCodexSteer,
  errorText,
  readCodexLifecycle,
  rpcProvenance,
  type CodexThreadLifecycle,
  type CodexAppServerRunInput,
  type JsonObject,
} from "./app-server-protocol.js";
import {
  CodexBrowserStartup,
  codexRequiredMcpStatuses,
  notificationArrival,
  observeCodexMcpStartup,
  waitForCodexBrowser,
  waitForCodexMcp,
} from "./app-server-mcp-startup.js";
import { CodexCancellation } from "./app-server-cancel.js";
import { CodexApprovals } from "./app-server-approvals.js";
import { CodexAutoReview } from "./app-server-auto-review.js";
import { startCodexTurn } from "./app-server-start.js";
import { codexAppServerThreadRequest, codexTurnSandboxPolicy } from "./app-server-session.js";
import {
  CodexSubagentThreads,
  codexCompletedEvent,
  codexCleanupIsProofLimitation,
  codexHasCompletedAnswer,
  codexSettledTerminal,
  codexTeardownFailed,
  codexTerminalEvents,
  observeCodexRootError,
  ownsNotification,
} from "./app-server-threads.js";
import { parseCodexStderrFailure, type CodexParseState } from "./parse.js";
import { parseCodexRpcError } from "./rpc-error.js";
import { codexResumeIdentityMismatch } from "./resume-identity.js";
export { CodexAppServerController } from "./app-server-protocol.js";
export { codexAppServerEvents, codexAppServerThreadParams } from "./app-server-protocol.js";
export type { CodexAppServerRunInput } from "./app-server-protocol.js";
export async function* runCodexAppServer(
  input: CodexAppServerRunInput,
): AsyncGenerator<HarnessEvent> {
  verifyCodexAttachments(input.spec.attachments);
  const run = input.spawn ?? spawnProcess;
  const abort = new AbortController();
  const pending = new Map<
    number,
    { resolve: (value: JsonObject) => void; reject: (error: Error) => void; taint: boolean }
  >();
  const notifications: JsonObject[] = [];
  const notificationWaiter: { wake?: () => void } = {};
  let io: ChildStdin | null = null;
  let resolveSpawn!: () => void;
  const spawned = new Promise<void>((resolve) => {
    resolveSpawn = resolve;
  });
  let nextId = 1;
  let processFailure: Error | null = null;
  let processStopped = false;
  let completedAnswer = false;
  let nativeThreadId: string | null = input.spec.resume_session_id ?? null;
  // Ownership binds a resumed root up front; cancellation RPCs wait for the reply.
  let threadConfirmed = false;
  let activeTurnId: string | null = null;
  const ownedCommandItemIds = new Set<string>();
  const subagents = new CodexSubagentThreads();
  const cancellation = new CodexCancellation({
    spawned,
    threadId: () => (threadConfirmed ? nativeThreadId : null),
    activeTurnId: () => activeTurnId,
    request: (method, params) => request(method, params),
    readLifecycle: () => readLifecycle(),
    stopProcess: () => stopProcess(),
    processFailure: () => processFailure,
    pollIntervalMs: input.pollIntervalMs ?? 250,
    cancelDeadlineMs: input.cancelDeadlineMs ?? 5_000,
  });
  const stderrRing: string[] = [];
  let launchAdvisory: string | null = null;
  let launchAdvisoryShown = false;
  let droppedUnrecognizedEvents = 0;
  let harnessReportedError = false;
  let terminationUnconfirmed: { survivors: number[]; unresolved: JsonObject[] } | null = null;
  let outputDrainTruncated = false;
  let nativeSystemError = false;
  const requiredMcpStatuses = codexRequiredMcpStatuses(input.spec);
  const browserStartup = new CodexBrowserStartup(input.spec);
  const parseState: CodexParseState = {
    envelopeActive: input.spec.output_schema !== undefined && input.spec.output_schema !== null,
    requiredMcpServers: input.spec.extra_mcp_servers
      .filter((server) => server.required)
      .map((server) => server.name),
    startedEmitted: true,
  };
  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const approvals = new CodexApprovals({
    spec: input.spec,
    io: () => io!,
    threadId: () => nativeThreadId,
    turnId: () => activeTurnId,
    live: () => !cancellation.requested && !processStopped && !abort.signal.aborted,
    enqueue: (notification) => {
      notifications.push(notification);
      notificationWaiter.wake?.();
      notificationWaiter.wake = undefined;
    },
    failed: (error) => {
      processFailure = error;
      rejectPending(error);
      notificationWaiter.wake?.();
    },
  });
  const autoReview = new CodexAutoReview({
    spec: input.spec,
    threadId: () => nativeThreadId,
    turnId: () => activeTurnId,
    live: () => !cancellation.requested && !processStopped && !abort.signal.aborted,
  });
  // Only root frames move run state; ownership is defined in app-server-threads.ts.
  const observeOwnNotification = (notification: JsonObject): void => {
    const method = notification["method"];
    const params = asObject(notification["params"]);
    if (!ownsNotification(params, nativeThreadId)) return;
    observeCodexRootError(parseState, method, params);
    if (method === "turn/started") {
      const turn = asObject(params?.["turn"]);
      if (typeof turn?.["id"] === "string") activeTurnId = turn["id"];
    } else if (method === "turn/completed") {
      const turn = asObject(params?.["turn"]);
      if (!turn || turn["id"] === activeTurnId) activeTurnId = null;
    } else if (method === "item/started") {
      const item = asObject(params?.["item"]);
      if (item?.["type"] === "commandExecution" && typeof item["id"] === "string")
        ownedCommandItemIds.add(item["id"]);
    } else if (method === "thread/status/changed") {
      if (asObject(params?.["status"])?.["type"] === "systemError") {
        nativeSystemError = true;
        approvals.close();
        autoReview.close(new Error("Codex root thread failed during native authorization"));
      }
    } else if (method === "mcpServer/startupStatus/updated") {
      if (observeCodexMcpStartup(params, requiredMcpStatuses, browserStartup))
        harnessReportedError = true;
    }
  };
  const onMessage = (message: unknown): void => {
    const object = asObject(message);
    if (!object) throw new Error("Codex app-server sent a non-object JSON-RPC frame");
    autoReview.observe(object);
    if (approvals.observe(object)) return;
    if (typeof object["id"] === "number") {
      const request = pending.get(object["id"]);
      if (!request) return;
      pending.delete(object["id"]);
      const rpcError = asObject(object["error"]);
      if (rpcError) {
        if (request.taint) harnessReportedError = true;
        request.reject(parseCodexRpcError(rpcError));
        return;
      }
      const result = asObject(object["result"]);
      if (!result) {
        request.reject(new Error("Codex app-server returned a malformed JSON-RPC result"));
        return;
      }
      request.resolve(result);
      return;
    }
    if (typeof object["method"] === "string") {
      observeOwnNotification(object);
      steer.observeEcho(object);
      notifications.push(object);
      notificationWaiter.wake?.();
      notificationWaiter.wake = undefined;
    }
  };
  const process = (async (): Promise<void> => {
    try {
      const options: SpawnOptions = {
        stdoutFraming: "lf",
        cwd: input.spec.cwd,
        env: input.env,
        inheritEnv: input.spec.env_inheritance,
        keepStdinOpen: true,
        abortSignal: abort.signal,
        onSpawn(childIo) {
          io = childIo;
          void childIo.closed.then(() => {
            approvals.close();
            autoReview.close();
          });
          resolveSpawn();
        },
      };
      for await (const event of run(input.bin, [...input.args, "app-server", "--stdio"], options)) {
        if (event.type === "stdout") {
          try {
            onMessage(JSON.parse(event.line));
          } catch (error) {
            if (error instanceof CodexServerRequestRefusal) throw error;
            throw new Error(`Invalid Codex app-server frame: ${errorText(error)}`);
          }
        } else if (event.type === "launch_advisory") {
          launchAdvisory = event.detail;
        } else if (event.type === "stderr") {
          stderrRing.push(event.line);
          if (stderrRing.length > 40) stderrRing.shift();
        } else if (event.type === "termination_unconfirmed") {
          terminationUnconfirmed = {
            survivors: event.survivors,
            unresolved: event.unresolved,
          };
          if (!completedAnswer || cancellation.requested || !codexCleanupIsProofLimitation(event))
            throw new Error("Codex app-server process termination could not be confirmed");
        } else if (event.type === "exit") {
          outputDrainTruncated = event.drain === "truncated";
          if (!abort.signal.aborted)
            throw new Error(
              `Codex app-server exited before the run completed (code ${event.code ?? "null"})`,
            );
        }
      }
    } catch (error) {
      processFailure = error instanceof Error ? error : new Error(String(error));
      rejectPending(processFailure);
      throw processFailure;
    } finally {
      approvals.close();
      autoReview.close();
      processStopped = true;
      if (abort.signal.aborted)
        rejectPending(cancellation.failure ?? new Error("Codex app-server stopped"));
      notificationWaiter.wake?.();
      notificationWaiter.wake = undefined;
    }
  })();
  void process.catch(() => {});
  // taint=false keeps benign turn/steer refusals out of harness_reported_error.
  const request = async (method: string, params: JsonObject, taint = true): Promise<JsonObject> => {
    // Once ready, write synchronously with the caller's last authority check.
    if (!io)
      await Promise.race([
        spawned,
        process.then(() => {
          throw processFailure ?? new Error("Codex app-server exited before accepting requests");
        }),
      ]);
    const id = nextId++;
    const response = new Promise<JsonObject>((resolve, reject) => {
      pending.set(id, { resolve, reject, taint });
    });
    io!.write(`${JSON.stringify({ id, method, params })}\n`);
    return response;
  };
  const notify = async (method: string, params: JsonObject | null): Promise<void> => {
    await spawned;
    io!.write(`${JSON.stringify({ method, params })}\n`);
  };
  const steer = createCodexSteer({
    sessionId: input.spec.session_id,
    threadId: () => nativeThreadId,
    activeTurnId: () => activeTurnId,
    live: () => !cancellation.requested && !processStopped,
    send: (method, params) => rpcProvenance(request(method, params, false)),
    responseDeadlineMs: input.steerDeadlineMs ?? 30_000,
  });
  const assertProcessLive = (): void => {
    if (processFailure) throw processFailure;
    if (processStopped) throw cancellation.failure ?? new Error("Codex app-server disconnected");
  };
  const nextNotification = async (
    method: string,
    accept: (params: JsonObject | null) => boolean = () => true,
    consume = true,
  ): Promise<JsonObject> => {
    for (;;) {
      const index = notifications.findIndex(
        (item) => item["method"] === method && accept(asObject(item["params"])),
      );
      if (index >= 0) return consume ? notifications.splice(index, 1)[0]! : notifications[index]!;
      assertProcessLive();
      await notificationArrival(notificationWaiter);
    }
  };
  /** Next queued notification; with `timeoutMs`, `null` once the wait lapses in silence. */
  const takeNotification = async (timeoutMs?: number): Promise<JsonObject | null> => {
    for (;;) {
      const next = notifications.shift();
      if (next) return next;
      assertProcessLive();
      if (!(await notificationArrival(notificationWaiter, timeoutMs))) return null;
    }
  };
  let stopPromise: Promise<void> | null = null;
  const stopProcess = (): Promise<void> =>
    (stopPromise ??= (async () => {
      approvals.close();
      autoReview.close();
      if (!abort.signal.aborted) abort.abort();
      io?.end();
      await process.catch(() => {});
    })());
  const terminalPayload = (extra: JsonObject = {}): JsonObject => {
    const stderrTail = redactSecrets(stderrRing.join("\n")).slice(-1_000).trim();
    return {
      ...extra,
      ...(autoReview.authorizationSubmissions.length
        ? { native_authorization_requests: autoReview.authorizationSubmissions }
        : {}),
      ...(launchAdvisory && !launchAdvisoryShown
        ? { launch_advisory: redactSecrets(launchAdvisory) }
        : {}),
      ...(harnessReportedError ? { harness_reported_error: true } : {}),
      ...(stderrTail ? { stderr_tail: stderrTail } : {}),
      ...(droppedUnrecognizedEvents
        ? { dropped_unrecognized_events: droppedUnrecognizedEvents }
        : {}),
      ...(terminationUnconfirmed ? { termination_unconfirmed: terminationUnconfirmed } : {}),
      ...(outputDrainTruncated ? { output_drain: "truncated" } : {}),
    };
  };
  const readLifecycle = (): Promise<CodexThreadLifecycle> =>
    readCodexLifecycle(request, nativeThreadId, ownedCommandItemIds);
  const cancel = () => {
    approvals.close();
    autoReview.close();
    return cancellation.cancel();
  };
  input.controller?.bind(cancel);
  input.controller?.bindSteer(steer.send);
  const onAbort = (): void => void cancel();
  const externalAbort = input.spec.extra["abortSignal"];
  if (externalAbort instanceof AbortSignal) {
    if (externalAbort.aborted) onAbort();
    else externalAbort.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await request("initialize", {
      clientInfo: { name: "claudexor", version: CLAUDEXOR_VERSION },
      capabilities: { experimentalApi: true },
    });
    await notify("initialized", null);
    const threadResult = await request(...codexAppServerThreadRequest(input.spec, input.effort));
    const thread = asObject(threadResult["thread"]);
    const threadId = thread?.["id"];
    if (typeof threadId !== "string") throw new Error("Codex app-server omitted thread id");
    const identityMismatch = codexResumeIdentityMismatch(input.spec, threadId);
    if (identityMismatch) {
      await stopProcess();
      yield* subagents.takeWarnings(notifications, nativeThreadId, input.spec.session_id);
      yield* identityMismatch;
      return;
    }
    const rootWasUnknown = nativeThreadId === null;
    nativeThreadId = threadId;
    threadConfirmed = true;
    // Nothing has consumed this queue yet. Classify startup state effects in
    // arrival order now that start named the root; resume was bound upfront.
    if (rootWasUnknown) notifications.forEach(observeOwnNotification);
    await waitForCodexMcp(requiredMcpStatuses, nextNotification);
    await waitForCodexBrowser({
      startup: browserStartup,
      deadlineMs: input.browserStartupDeadlineMs,
      assertProcessLive,
      stopRequested: () => cancellation.requested,
      abandoned: () => nativeSystemError,
      nextArrival: (timeoutMs) => notificationArrival(notificationWaiter, timeoutMs),
    });
    // Explicit auxiliary roots ride only the turn policy (app-server-session.ts).
    const sandboxPolicy = codexTurnSandboxPolicy(input.spec, threadResult["sandbox"]);
    yield await startCodexTurn({
      spec: input.spec,
      threadId,
      sandboxPolicy,
      requiredMcpServers: parseState.requiredMcpServers ?? [],
      request,
      nextNotification,
    });
    yield* browserStartup.takeEvents(input.spec.session_id);
    if (launchAdvisory) {
      yield {
        type: "status",
        session_id: input.spec.session_id,
        ts: nowIso(),
        text: redactSecrets(launchAdvisory),
        payload: { launch_advisory: true },
      };
      launchAdvisoryShown = true;
    }
    let pendingTerminal: JsonObject | null = null;
    for (;;) {
      // Once the root turn completed, "thread settled" is re-checked on ANY
      // notification and, as a safety net, after the poll interval even in
      // silence (how Codex reports the root status while sub-agents still
      // run is not verified).
      const notification = pendingTerminal
        ? await takeNotification(input.pollIntervalMs ?? 250)
        : await takeNotification();
      if (notification) {
        const method = notification["method"];
        const params = asObject(notification["params"]);
        if (!ownsNotification(params, nativeThreadId)) {
          // A sub-agent thread: timeline and usage only, never finality.
          const mapped = subagents.events(notification, input.spec.session_id);
          if (mapped) for (const event of mapped) yield event;
          else droppedUnrecognizedEvents += 1;
          if (!pendingTerminal) continue;
        } else if (method === "turn/started") {
          pendingTerminal = null;
          parseState.lastAgentMessage = undefined;
          continue;
        } else {
          const mapped =
            approvals.events(notification) ??
            autoReview.events(notification) ??
            steer.deliveredEvents(notification) ??
            codexAppServerEvents(notification, input.spec.session_id, parseState);
          if (mapped) {
            for (const event of mapped) {
              if (event.type === "error") harnessReportedError = true;
              yield event;
            }
          } else if (
            method !== "turn/completed" &&
            method !== "thread/status/changed" &&
            method !== "mcpServer/startupStatus/updated"
          ) {
            droppedUnrecognizedEvents += 1;
          }
          if (method === "turn/completed") {
            pendingTerminal = asObject(params?.["turn"]);
          } else if (method === "thread/status/changed" && nativeSystemError && !pendingTerminal) {
            pendingTerminal = {
              id: activeTurnId,
              status: "failed",
              error: { message: "Codex app-server thread settled in systemError" },
            };
          } else if (!pendingTerminal) {
            continue;
          }
        }
      }

      for (;;) {
        const current =
          cancellation.requested && cancellation.quiescent
            ? {
                threadStatus: "idle",
                threadSettled: true,
                goalActive: false,
                ownedBackground: [],
              }
            : await readLifecycle();
        if (
          !nativeSystemError &&
          notifications.some(
            (item) =>
              item["method"] === "turn/started" &&
              ownsNotification(asObject(item["params"]), nativeThreadId),
          )
        )
          break;
        const systemError = nativeSystemError || current.threadStatus === "systemError";
        if (!current.threadSettled || current.goalActive || current.ownedBackground.length) {
          if (current.ownedBackground.length && (systemError || !current.goalActive)) {
            await new Promise<void>((resolve) => setTimeout(resolve, input.pollIntervalMs ?? 250));
            continue;
          }
          if (!systemError) break;
        }
        const status = pendingTerminal?.["status"];
        const finalAnswer = parseState.lastAgentMessage ?? "";
        const terminal = codexTerminalEvents({
          pendingTerminal,
          systemError,
          sessionId: input.spec.session_id,
          parseState,
        });
        // Hand denials back only after this turn's answer, never from a failed thread.
        const handback =
          status === "completed" &&
          !(systemError || harnessReportedError || terminal.reportedError === true) &&
          !cancellation.requested &&
          autoReview.pending;
        const handbackInput = {
          turnId: String(pendingTerminal?.["id"]),
          sandboxPolicy,
          finalAnswer,
          completed: terminal.events,
          request,
          readLifecycle,
          failure: () => processFailure,
          cancelled: () => cancellation.requested,
          cancel,
        };
        if (handback && (yield* autoReview.handback(handbackInput))) {
          pendingTerminal = null;
          break;
        }
        if (terminal.reportedError !== null) harnessReportedError = terminal.reportedError;
        let failed = systemError || harnessReportedError || cancellation.requested;
        completedAnswer = !failed && codexHasCompletedAnswer(status, current, terminal.events);
        await stopProcess();
        if (processFailure) throw processFailure;
        failed = nativeSystemError || harnessReportedError || cancellation.requested;
        // A late root event invalidates a completed answer even when POSIX
        // cleanup proved death. Keep existing failed/interrupted terminals;
        // only revalidate a candidate answer here.
        if (completedAnswer && codexTeardownFailed(notifications, nativeThreadId, failed))
          throw new Error("Codex completion was invalidated during process teardown");
        yield* subagents.takeWarnings(notifications, nativeThreadId, input.spec.session_id);
        if (!handback) yield* codexSettledTerminal(terminal.events, parseState);
        yield codexCompletedEvent(
          input.spec.session_id,
          terminalPayload({
            native_session_id: threadId,
            native_turn_id: pendingTerminal?.["id"] ?? activeTurnId,
            ...(subagents.count ? { subagent_threads: subagents.count } : {}),
          }),
          status === "interrupted",
        );
        return;
      }
    }
  } catch (error) {
    if (cancellation.requested) await cancel();
    await stopProcess();
    yield* subagents.takeWarnings(notifications, nativeThreadId, input.spec.session_id);
    if (processFailure && cancellation.requested) cancellation.failure ??= processFailure;
    if (
      cancellation.requested &&
      cancellation.quiescent &&
      !cancellation.failure &&
      !processFailure
    ) {
      yield codexCompletedEvent(
        input.spec.session_id,
        terminalPayload({ code: "user_cancelled", native_session_id: nativeThreadId }),
        true,
      );
      return;
    }
    const aborted = cancellation.requested;
    const failure = processFailure ?? cancellation.failure ?? error;
    if (failure instanceof CodexServerRequestRefusal) harnessReportedError = true;
    const requestRefusal = codexRequestRefusal(failure);
    const code =
      cancellation.failure || terminationUnconfirmed
        ? "codex_control_loss"
        : failure instanceof CodexServerRequestRefusal
          ? failure.code
          : "codex_app_server_failure";
    const nativeError =
      !requestRefusal && failure !== processFailure && !cancellation.failure
        ? parseCodexStderrFailure(errorText(failure), input.spec.session_id, parseState)
        : null;
    if (nativeError) harnessReportedError = true;
    yield nativeError ?? {
      type: "error",
      session_id: input.spec.session_id,
      ts: nowIso(),
      error: redactSecrets(errorText(failure)),
      ...(requestRefusal ? { request_refusal: requestRefusal } : {}),
      payload: { code: requestRefusal?.kind ?? code },
    };
    yield codexCompletedEvent(
      input.spec.session_id,
      terminalPayload({ code, native_session_id: nativeThreadId }),
      aborted,
    );
  } finally {
    if (externalAbort instanceof AbortSignal) externalAbort.removeEventListener("abort", onAbort);
    input.controller?.clear(cancel);
    input.controller?.clearSteer(steer.send);
    await stopProcess();
  }
}
