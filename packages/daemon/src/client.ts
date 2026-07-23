import { type Socket, connect } from "node:net";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { ControlProblem, type ControlProblem as ControlProblemBody } from "@claudexor/schema";

function rpcStatus(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599
    ? value
    : 500;
}

function rpcProblem(value: unknown): ControlProblemBody {
  const wire =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const nested =
    wire["problem"] && typeof wire["problem"] === "object" && !Array.isArray(wire["problem"])
      ? (wire["problem"] as Record<string, unknown>)
      : wire;
  const fieldErrors: Record<string, string[]> = {};
  if (
    nested["fieldErrors"] &&
    typeof nested["fieldErrors"] === "object" &&
    !Array.isArray(nested["fieldErrors"])
  ) {
    for (const [field, messages] of Object.entries(
      nested["fieldErrors"] as Record<string, unknown>,
    )) {
      if (Array.isArray(messages)) {
        const safe = messages.filter((message): message is string => typeof message === "string");
        if (safe.length > 0) fieldErrors[field] = safe;
      }
    }
  }
  const stringArray = (field: "requiredActions" | "evidenceRefs"): string[] =>
    Array.isArray(nested[field])
      ? nested[field].filter(
          (entry): entry is string => typeof entry === "string" && entry.length > 0,
        )
      : [];
  const context =
    nested["context"] && typeof nested["context"] === "object" && !Array.isArray(nested["context"])
      ? (nested["context"] as Record<string, unknown>)
      : {};
  const topLevelMessage = wire["message"];
  return ControlProblem.parse({
    code:
      typeof nested["code"] === "string" && nested["code"].length > 0
        ? nested["code"]
        : "daemon_rpc_failed",
    message:
      typeof nested["message"] === "string"
        ? nested["message"]
        : typeof topLevelMessage === "string"
          ? topLevelMessage
          : "daemon RPC failed",
    retryable: typeof nested["retryable"] === "boolean" ? nested["retryable"] : false,
    fieldErrors,
    requiredActions: stringArray("requiredActions"),
    evidenceRefs: stringArray("evidenceRefs"),
    context,
  });
}

/** Thin JSON-RPC client for the daemon over a Unix socket. */
export class DaemonClient {
  constructor(
    private readonly socketPath: string,
    private readonly token: string,
  ) {}

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
        () => finish(() => reject(new Error(`daemon RPC timeout (${method})`))),
        10_000,
      );
      timer.unref?.();
      // Attach the error handler first so connect failures (ENOENT/ECONNREFUSED)
      // never become an unhandled 'error' event.
      sock.on("error", (err) => finish(() => reject(err)));
      sock.on("close", () => finish(() => reject(new Error("daemon connection closed"))));
      rl = createInterface({ input: sock });
      rl.on("error", (err) => finish(() => reject(err))); // readline re-emits input 'error'
      sock.on("connect", () => {
        sock.write(JSON.stringify({ id, method, params, token: this.token }) + "\n");
      });
      rl.on("line", (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.id !== id) return;
          if (msg.error) {
            const problem = rpcProblem(msg.error);
            const error = Object.assign(new Error(problem.message), problem, {
              status: rpcStatus(msg.error.status),
            });
            finish(() => reject(error));
          } else finish(() => resolve(msg.result as T));
        } catch {
          /* ignore */
        }
      });
    });
  }

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
    return this.call<{ id: string; state: string }>("claudexor.enqueue", {
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
      problem?: ControlProblemBody;
      createdAt?: string;
      startedAt?: string;
      finishedAt?: string;
    }>("claudexor.status", { id });
  }
  findAccepted(
    request: unknown,
    options: { idempotencyKey: string; clientId?: string; operation?: string },
  ) {
    return this.call<Awaited<ReturnType<DaemonClient["status"]>> | null>("claudexor.findAccepted", {
      request,
      idempotencyKey: options.idempotencyKey,
      clientId: options.clientId ?? "daemon-client",
      operation: options.operation,
    });
  }
  list() {
    return this.call<
      {
        id: string;
        state: string;
        params?: unknown;
        runId?: string;
        taskId?: string;
        runDir?: string;
        error?: string;
        errorCode?: string;
        errorStatus?: number;
        problem?: ControlProblemBody;
        createdAt?: string;
        startedAt?: string;
        finishedAt?: string;
      }[]
    >("claudexor.list");
  }
  cancel(id: string) {
    return this.call("claudexor.cancel", { id });
  }
  shutdown() {
    return this.call("claudexor.shutdown");
  }
}
