import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type RpcId = number;

export interface RpcRequest {
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  id: RpcId;
  result?: unknown;
  error?: { message: string; data?: unknown };
}

export interface RpcEvent {
  id: RpcId;
  event: unknown;
}

export const METHODS = {
  discover: "claudexor.discover",
  doctor: "claudexor.doctor",
  run: "claudexor.run",
  review: "claudexor.review",
  cancel: "claudexor.cancel",
} as const;

/** A duplex line transport: `read` carries the peer's messages, `write` sends ours. */
export interface Transport {
  read: Readable;
  write: Writable;
}

export function writeMessage(w: Writable, msg: unknown): void {
  w.write(JSON.stringify(msg) + "\n");
}

export async function* readMessages(r: Readable): AsyncGenerator<unknown> {
  const rl = createInterface({ input: r });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      /* ignore non-JSON lines (e.g. stray logging) */
    }
  }
}

export function isResponse(m: unknown): m is RpcResponse {
  return (
    typeof m === "object" &&
    m !== null &&
    "id" in m &&
    !("event" in m) &&
    !("method" in m)
  );
}

export function isEvent(m: unknown): m is RpcEvent {
  return typeof m === "object" && m !== null && "id" in m && "event" in m;
}

export function isRequest(m: unknown): m is RpcRequest {
  return typeof m === "object" && m !== null && "id" in m && "method" in m;
}
