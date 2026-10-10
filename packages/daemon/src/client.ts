import { DaemonTransportError } from "./client-errors.js";
import type { CancelReasonCode, CommandListQuery } from "@claudexor/schema";
import { type Socket, connect } from "node:net";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { RuntimeReplacementTarget } from "./daemon-shutdown-rpc.js";

/** A daemon-authored problem as it crosses the RPC boundary (`rpcProblem`). */
export interface DaemonRpcProblem {
  message: string;
  code?: unknown;
  status?: unknown;
  retryable?: unknown;
  context?: unknown;
  requiredActions?: unknown;
}

/** Rebuild a daemon-authored problem from its wire form. Every transport uses
 * this one projection, so only well-typed fields survive and callers see the
 * same code/status/retryable/context/requiredActions whichever way it came. */
export function daemonRpcError(problem: DaemonRpcProblem): Error {
  return Object.assign(new Error(problem.message), {
    ...(typeof problem.code === "string" ? { code: problem.code } : {}),
    ...(typeof problem.status === "number" ? { status: problem.status } : {}),
    ...(typeof problem.retryable === "boolean" ? { retryable: problem.retryable } : {}),
    ...(problem.context && typeof problem.context === "object" ? { context: problem.context } : {}),
    ...(Array.isArray(problem.requiredActions) ? { requiredActions: problem.requiredActions } : {}),
  });
}

/** The daemon facade over one RPC transport. The socket client and the
 * daemon's in-process client share this method → RPC mapping, so request
 * envelopes and defaults cannot drift between transports. */
export abstract class DaemonRpcMethods {
  abstract call<T = unknown>(method: string, params?: unknown): Promise<T>;

  health() {
    return this.call("claudexor.health");
  }
  enqueue(
    request: unknown,
    options: {
      idempotencyKey?: string;
      clientId?: string;
      idempotencyRequest?: unknown;
      operation?: string;
    } = {},
  ) {
    return this.call<{ id: string; state: string; reused: boolean }>("claudexor.enqueue", {
      request,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      clientId: options.clientId ?? "daemon-client",
      idempotencyRequest: options.idempotencyRequest,
      operation: options.operation,
    });
  }
  status(id: string) {
    return this.call<{
      id: string;
      state: string;
      params?: unknown;
      runId?: string;
      taskId?: string;
      runDir?: string;
      result?: unknown;
      error?: string;
      errorCode?: string;
      errorStatus?: number;
      errorRetryable?: boolean;
      errorRequiredActions?: string[];
      errorContext?: Record<string, unknown>;
      createdAt?: string;
      startedAt?: string;
      finishedAt?: string;
    }>("claudexor.status", { id });
  }
  findAccepted(
    request: unknown,
    options: {
      idempotencyKey: string;
      clientId?: string;
      operation?: string;
      idempotencyRequest?: unknown;
    },
  ) {
    return this.call<Awaited<ReturnType<DaemonRpcMethods["status"]>> | null>(
      "claudexor.findAccepted",
      {
        request,
        idempotencyKey: options.idempotencyKey,
        clientId: options.clientId ?? "daemon-client",
        operation: options.operation,
        idempotencyRequest: options.idempotencyRequest,
      },
    );
  }
  /** Required addressed read; collection answers contain summary facts only. */
  list(query: CommandListQuery) {
    return this.call<
      {
        promptPreview?: string;
        id: string;
        state: string;
        params?: unknown;
        runId?: string;
        taskId?: string;
        runDir?: string;
        error?: string;
        errorCode?: string;
        errorStatus?: number;
        errorRetryable?: boolean;
        errorRequiredActions?: string[];
        errorContext?: Record<string, unknown>;
        createdAt?: string;
        startedAt?: string;
        finishedAt?: string;
      }[]
    >("claudexor.list", { query });
  }
  cancel(id: string, reasonCode?: CancelReasonCode) {
    return this.call("claudexor.cancel", reasonCode ? { id, reason_code: reasonCode } : { id });
  }
  fenceDelegationParent(runId: string) {
    return this.call<{ runId: string; fenced: boolean }>("claudexor.delegationFence", { runId });
  }
}

/** Thin JSON-RPC client for the daemon over a Unix socket. */
export class DaemonClient extends DaemonRpcMethods {
  constructor(
    private readonly socketPath: string,
    private readonly token: string,
  ) {
    super();
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const sock: Socket = connect(this.socketPath);
      const id = Math.floor(Math.random() * 1e9);
      let settled = false;
      let rl: ReturnType<typeof createInterface> | undefined;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rl?.close();
        sock.destroy();
        fn();
      };
      // A socket that accepts but never replies must not hang the caller
      // (`daemon status`) forever — fail loudly after a bounded wait.
      const timer = setTimeout(
        () => finish(() => reject(new DaemonTransportError(method, "timeout"))),
        10_000,
      );
      timer.unref?.();
      // Attach the error handler first so connect failures (ENOENT/ECONNREFUSED)
      // never become an unhandled 'error' event.
      sock.on("error", (err) =>
        finish(() => reject(new DaemonTransportError(method, "unavailable", err))),
      );
      sock.on("close", () => finish(() => reject(new DaemonTransportError(method, "unavailable"))));
      rl = createInterface({ input: sock });
      rl.on("error", (err) =>
        finish(() => reject(new DaemonTransportError(method, "unavailable", err))),
      ); // readline re-emits input 'error'
      sock.on("connect", () => {
        sock.write(JSON.stringify({ id, method, params, token: this.token }) + "\n");
      });
      rl.on("line", (line) => {
        try {
          const msg = JSON.parse(line);
          if (
            !msg ||
            typeof msg !== "object" ||
            msg.id !== id ||
            (msg.error ? typeof msg.error.message !== "string" : !("result" in msg))
          ) {
            throw new Error("invalid daemon RPC response");
          }
          if (msg.error) finish(() => reject(daemonRpcError(msg.error)));
          else finish(() => resolve(msg.result as T));
        } catch (error) {
          finish(() => reject(new DaemonTransportError(method, "unavailable", error)));
        }
      });
    });
  }

  shutdown() {
    return this.call("claudexor.shutdown");
  }
  shutdownForRuntimeReplacement(expectedTarget: RuntimeReplacementTarget) {
    return this.call<{ ok: true; fenced: true; targetBound: true }>(
      "claudexor.shutdownForRuntimeReplacement",
      expectedTarget,
    );
  }
}
