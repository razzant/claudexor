import * as acp from "@agentclientprotocol/sdk";
import { spawnProcess, type ChildStdin } from "@claudexor/core";
import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { measureWork } from "@claudexor/util";
import { AcpEvents, AcpFailure, record } from "./events.js";
import { decidePermission, denyPermission } from "./policy.js";

export interface AcpObservation {
  session?: acp.NewSessionResponse;
  version?: string;
  writePermission: boolean;
  promptDispatched: boolean;
}

/** SDK owns RPC correlation/validation; our byte-bounded stream owns transcript order. */
export function connectAcp(input: {
  harnessId: string;
  binary: string;
  args: string[];
  env: Record<string, string | null>;
  spec: HarnessRunSpec;
  abort: AbortController;
  events: AcpEvents;
  observation: AcpObservation;
  emit: (event: HarnessEvent) => Promise<void>;
}) {
  const { spec, abort, events, observation, emit } = input;
  let stdin!: ChildStdin;
  let receive!: (io: ChildStdin) => void;
  const spawned = new Promise<ChildStdin>((resolve) => {
    receive = resolve;
  });
  let termination: string | undefined;
  let outputDrainTruncated = false;
  let closing = false;
  let replyId: acp.JsonRpcId | undefined;
  let replyReady: Promise<void> | undefined;
  let replied: (() => void) | undefined;
  const process = spawnProcess(input.binary, input.args, {
    cwd: spec.cwd,
    env: input.env,
    inheritEnv: "clean",
    keepStdinOpen: true,
    abortSignal: abort.signal,
    streamLimits: { stdoutFrameBytes: 8 * 1024 * 1024, queuedFrames: 16, stderrBytes: 64 * 1024 },
    onSpawn: (io) => {
      stdin = io;
      receive(io);
    },
    onTerminationUnconfirmed: () => {
      termination = "ACP process tree death could not be confirmed";
    },
  });
  const wire = (direction: "agent" | "client", line: string) =>
    emit(events.event("status", { payload: { acp_frame: { direction, line } } }));
  const stream: acp.Stream = {
    writable: new WritableStream<acp.AnyMessage>({
      async write(message) {
        const line = `${JSON.stringify(message)}\n`;
        if (Buffer.byteLength(line) > 8 * 1024 * 1024)
          throw new AcpFailure("frame_too_large", "ACP outgoing frame exceeds 8 MiB");
        const io = await spawned;
        if (closing) throw new Error("ACP transport closed");
        // Delivery can be ambiguous after this write. No reconnection/replay exists.
        io.write(line);
        // Cancellation must reach the pipe even when the transcript is backpressured.
        if (!abort.signal.aborted) await wire("client", line);
        if ("id" in message && !("method" in message) && message.id === replyId) replied?.();
      },
    }),
    readable: new ReadableStream<acp.AnyMessage>(
      {
        async pull(controller) {
          try {
            // SDK handlers are concurrent. Wait for each inbound request's
            // response before reading another, so its writer queue stays bounded.
            await replyReady;
            if (closing) return;
            for (;;) {
              const next = await process.next();
              if (closing) return;
              if (next.done) {
                controller.close();
                return;
              }
              const event = next.value;
              if (event.type === "termination_unconfirmed") {
                termination = "ACP process tree death could not be confirmed";
              } else if (event.type === "exit") {
                outputDrainTruncated = event.drain === "truncated";
              } else if (event.type === "stderr") {
                await emit(events.event("status", { payload: { stderr: event.line } }));
              } else if (event.type === "stdout") {
                await wire("agent", event.wire ?? `${event.line}\n`);
                const message: unknown = measureWork(
                  "run.stream",
                  () => JSON.parse(event.line),
                  input.harnessId,
                );
                const envelope = record(message);
                if (envelope["jsonrpc"] !== "2.0")
                  throw new AcpFailure("invalid_frame", "ACP frame is not JSON-RPC 2.0");
                if (typeof envelope["method"] === "string" && !("id" in envelope)) {
                  if (envelope["method"] === acp.methods.client.session.update) {
                    const params = record(envelope["params"]);
                    if (
                      !observation.session ||
                      params["sessionId"] !== observation.session.sessionId
                    )
                      throw new AcpFailure(
                        "wrong_session",
                        "ACP update is outside the active session",
                      );
                    for (const translated of measureWork(
                      "run.stream",
                      () => events.update(params["update"]),
                      input.harnessId,
                    ))
                      await emit(translated);
                  }
                  // Preserve unknown updates/notifications without SDK filtering or console logging.
                  continue;
                }
                if (typeof envelope["method"] === "string") {
                  replyId = envelope["id"] as acp.JsonRpcId;
                  replyReady = new Promise<void>((resolve) => {
                    replied = resolve;
                  });
                }
                controller.enqueue(message as acp.AnyMessage);
                return;
              }
            }
          } catch (error) {
            if (!closing) controller.error(error);
          }
        },
        cancel() {
          /* The lifetime owner closes and reaps the process below. */
        },
      },
      { highWaterMark: 0 },
    ),
  };
  const connection = acp
    .client()
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      if (abort.signal.aborted || params.sessionId !== observation.session?.sessionId)
        return denyPermission();
      if (params.toolCall.kind === "edit" || params.toolCall.kind === "execute")
        observation.writePermission = true;
      return decidePermission(spec.access, spec.cwd, params);
    })
    .connect(stream);
  let cleanup: Promise<void> | undefined;
  return {
    connection,
    /** The agent exited while a descendant held its pipe; the bounded drain force-closed it. */
    outputDrainTruncated: () => outputDrainTruncated,
    async cancel() {
      // Queue the protocol notification before abort; don't wait on a blocked stream writer.
      if (observation.session && !closing) {
        const frame = {
          jsonrpc: "2.0",
          method: acp.methods.agent.session.cancel,
          params: { sessionId: observation.session.sessionId },
        };
        stdin?.write(`${JSON.stringify(frame)}\n`);
      }
      await this.close();
    },
    close(): Promise<void> {
      cleanup ??= (async () => {
        closing = true;
        replied?.();
        abort.abort();
        connection.close();
        stdin?.end();
        await process.return(undefined);
        if (termination) throw new AcpFailure("termination_unconfirmed", termination);
      })();
      return cleanup;
    },
  };
}
