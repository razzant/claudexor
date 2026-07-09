import { type Socket, connect } from "node:net";
import { createInterface } from "node:readline";

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
      const timer = setTimeout(() => finish(() => reject(new Error(`daemon RPC timeout (${method})`))), 10_000);
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
          if (msg.error) finish(() => reject(new Error(msg.error.message)));
          else finish(() => resolve(msg.result as T));
        } catch {
          /* ignore */
        }
      });
    });
  }

  health() {
    return this.call("claudexor.health");
  }
  enqueue(params: unknown) {
    return this.call<{ id: string; state: string }>("claudexor.enqueue", params);
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
      createdAt?: string;
      startedAt?: string;
      finishedAt?: string;
    }>(
      "claudexor.status",
      { id },
    );
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
