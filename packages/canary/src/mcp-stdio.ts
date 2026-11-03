/** A minimal stdio MCP consumer of the BUILT `claudexor mcp serve`, for canary stories. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import type { TestContext } from "vitest";
import { CLI, type Sandbox } from "./support.js";

type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface McpStdioClient {
  readonly pid: number;
  /** Send one request; resolves with its result, rejects on a JSON-RPC error or timeout. */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  /** Send a request and return its id without waiting (the reply may be dropped). */
  start(method: string, params?: unknown): number;
  notify(method: string, params?: unknown): void;
  initialize(): Promise<void>;
  call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  /** Kill the server without reading any outstanding reply (a lost response). */
  kill(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A story's close phase for afterEachClosed (#376). The clients close under the hook's deadline,
 * and the returned tail stops the daemon and removes the sandbox with no deadline of its own. A
 * client close that rejects, or settles after the hook's deadline, still stops the daemon and keeps
 * the files. A close that never settles reaches neither, so its daemon outlives the hook.
 */
export async function closeThenDispose(
  context: TestContext,
  sandbox: Sandbox | undefined,
  clients: McpStdioClient[],
): Promise<() => void> {
  let closed = false;
  try {
    for (const client of clients) await client.close();
    closed = !context.signal.aborted; // Vitest aborts it when this hook's deadline passes.
  } finally {
    if (!closed) sandbox?.dispose({ keepFiles: true });
  }
  return () => sandbox?.dispose();
}

export function mcpStdioClient(
  sb: Sandbox,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): McpStdioClient {
  const child = spawn(process.execPath, [CLI, "mcp", "serve"], {
    cwd: opts.cwd ?? sb.repo,
    env: { ...sb.env, ...opts.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const exited = once(child, "exit");
  child.once("exit", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`MCP exited: ${stderr}`));
    }
    pending.clear();
  });
  const write = (message: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const start = (method: string, params?: unknown) => {
    const id = ++nextId;
    write({ id, method, params });
    return id;
  };
  const request = (method: string, params?: unknown, timeoutMs = 90_000) =>
    new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request ${method} timed out: ${stderr}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      write({ id, method, params });
    });
  const stopped = () => child.exitCode !== null || child.signalCode !== null;
  return {
    pid: child.pid!,
    request,
    start,
    notify: (method, params) => write({ method, params }),
    async initialize() {
      await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "controller-canary", version: "1.0" },
      });
      write({ method: "notifications/initialized" });
    },
    call: (name, args, timeoutMs) => request("tools/call", { name, arguments: args }, timeoutMs),
    async kill() {
      if (stopped()) return;
      child.kill("SIGKILL");
      await exited;
      lines.close();
    },
    async close() {
      if (stopped()) return;
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGTERM"), 2000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
        lines.close();
      }
    },
  };
}
