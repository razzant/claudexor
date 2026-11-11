import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

const MAX_CONTROL_BODY_BYTES = 10 * 1024 * 1024;

/** Reads a bounded JSON request body with strict UTF-8 decoding. */
export async function readControlRequestBody(
  req: IncomingMessage,
  maxBytes = MAX_CONTROL_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Stopping early must not destroy the request: the response writer
  // discards the unread rest so the client receives the typed 413.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      chunks.length = 0;
      throw Object.assign(new Error("request body too large"), { status: 413 });
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  // QA-056: decode the complete byte body STRICTLY. `Buffer.toString("utf8")`
  // is non-fatal — it silently replaces malformed bytes with U+FFFD, so an
  // invalid octet (FF, a lone continuation byte, overlong/ truncated sequence)
  // would slip through as a valid JS string and could pass Zod, the secret
  // fence, idempotency hashing and a durable mutation storing a value that
  // differs from the wire bytes. TextDecoder({fatal:true}) throws on any
  // malformed byte; concatenating first keeps valid multibyte chars split
  // across HTTP chunks intact.
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw Object.assign(new Error("request body must be valid UTF-8"), {
      status: 400,
      code: "invalid_encoding",
    });
  }
  const raw = decoded.trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
}

/** Connections still receiving a body that their answer refused. */
export class RefusedBodies {
  /** Each such connection with the answer that refused its body. */
  private readonly refusals = new Map<Socket, ServerResponse>();
  private closing = false;

  /** An early answer discards the rest of the body and keeps the connection,
   * so the client can read the answer. */
  discard(res: ServerResponse): void {
    const req = res.req;
    if (!req || req.complete) return;
    req.resume();
    const socket = req.socket;
    if (this.refusals.has(socket)) return;
    this.refusals.set(socket, res);
    const settle = () => {
      this.refusals.delete(socket);
      req.off("end", settle);
      socket.off("close", settle);
    };
    req.once("end", settle);
    socket.once("close", settle);
    if (this.closing) endAfter(res, socket);
  }

  /** Called first at stop: a client that keeps sending would hold the listener
   * open, so each connection is half-closed after its refusing answer, now and
   * for every later refusal; the rest of the body is still read and discarded
   * until the client closes its side. */
  close(): void {
    this.closing = true;
    for (const [socket, res] of this.refusals) endAfter(res, socket);
  }
}

/** Half-close once the refusing answer is written. Answers queued before it on
 * the connection go out first, and no request follows an unfinished body. */
function endAfter(res: ServerResponse, socket: Socket): void {
  if (res.writableFinished) socket.end();
  else res.once("finish", () => socket.end());
}
