import { spawn } from "node:child_process";
import type {
  ConformanceReport as ConformanceReportT,
  HarnessEvent as HarnessEventT,
  HarnessManifest as HarnessManifestT,
  HarnessRunSpec,
} from "@claudexor/schema";
import { ConformanceReport, HarnessEvent, HarnessManifest } from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import { AdapterParseError, HarnessUnavailableError } from "@claudexor/core";
import {
  METHODS,
  type RpcId,
  type Transport,
  isEvent,
  isResponse,
  readMessages,
  writeMessage,
} from "./protocol.js";

interface StreamState {
  queue: unknown[];
  wake: (() => void) | null;
  done: boolean;
  error: string | null;
}

/** A HarnessAdapter backed by a JSON-RPC peer over a line transport. */
export class JsonRpcAdapterClient implements HarnessAdapter {
  private nextId: RpcId = 1;
  private readonly pending = new Map<RpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly streams = new Map<RpcId, StreamState>();
  private loopStarted = false;
  private closed = false;

  constructor(
    readonly id: string,
    private readonly transport: Transport,
  ) {}

  private startLoop(): void {
    if (this.loopStarted) return;
    this.loopStarted = true;
    void (async () => {
      try {
        for await (const msg of readMessages(this.transport.read)) this.handle(msg);
      } finally {
        this.onClosed();
      }
    })();
  }

  private handle(msg: unknown): void {
    if (isEvent(msg)) {
      const s = this.streams.get(msg.id);
      if (s) {
        s.queue.push(msg.event);
        s.wake?.();
        s.wake = null;
      }
      return;
    }
    if (isResponse(msg)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
      const s = this.streams.get(msg.id);
      if (s) {
        s.done = true;
        if (msg.error) s.error = msg.error.message;
        s.wake?.();
        s.wake = null;
      }
    }
  }

  private onClosed(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new HarnessUnavailableError("adapter process closed"));
    this.pending.clear();
    for (const s of this.streams.values()) {
      s.done = true;
      if (!s.error && s.queue.length === 0) s.error = "adapter process closed";
      s.wake?.();
      s.wake = null;
    }
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new HarnessUnavailableError("adapter closed"));
    this.startLoop();
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) =>
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }),
    );
    writeMessage(this.transport.write, { id, method, params });
    return promise;
  }

  async discover(): Promise<HarnessManifestT> {
    return HarnessManifest.parse(await this.request(METHODS.discover, {}));
  }

  async doctor(spec: DoctorSpec): Promise<ConformanceReportT> {
    return ConformanceReport.parse(await this.request(METHODS.doctor, spec));
  }

  run(spec: HarnessRunSpec): AsyncIterable<HarnessEventT> {
    return this.stream(METHODS.run, spec);
  }

  review(spec: HarnessRunSpec): AsyncIterable<HarnessEventT> {
    return this.stream(METHODS.review, spec);
  }

  async cancel(sessionId: string): Promise<void> {
    await this.request(METHODS.cancel, { sessionId });
  }

  private async *stream(method: string, params: unknown): AsyncGenerator<HarnessEventT> {
    this.startLoop();
    const id = this.nextId++;
    const s: StreamState = { queue: [], wake: null, done: false, error: null };
    this.streams.set(id, s);
    writeMessage(this.transport.write, { id, method, params });
    try {
      for (;;) {
        if (s.queue.length > 0) {
          yield HarnessEvent.parse(s.queue.shift());
          continue;
        }
        if (s.done) {
          if (s.error) throw new AdapterParseError(s.error);
          return;
        }
        await new Promise<void>((res) => {
          s.wake = res;
        });
      }
    } finally {
      this.streams.delete(id);
    }
  }
}

export interface SpawnAdapterOptions {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** Spawn an external adapter process and wrap it as a HarnessAdapter. */
export function spawnJsonRpcAdapter(opts: SpawnAdapterOptions): HarnessAdapter {
  const child = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (!child.stdin || !child.stdout) {
    throw new HarnessUnavailableError(`failed to open stdio for external adapter: ${opts.command}`);
  }
  return new JsonRpcAdapterClient(opts.id, { write: child.stdin, read: child.stdout });
}
