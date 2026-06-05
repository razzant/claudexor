import type { DoctorSpec, HarnessAdapter } from "@claudex/core";
import type { HarnessRunSpec } from "@claudex/schema";
import { METHODS, type Transport, isRequest, readMessages, writeMessage } from "./protocol.js";

/**
 * Serve a HarnessAdapter implementation over a line transport. External adapters
 * (Node) call this with `{ read: process.stdin, write: process.stdout }`.
 */
export async function runAdapterServer(impl: HarnessAdapter, transport: Transport): Promise<void> {
  for await (const msg of readMessages(transport.read)) {
    if (!isRequest(msg)) continue;
    const { id, method, params } = msg;
    try {
      switch (method) {
        case METHODS.discover:
          writeMessage(transport.write, { id, result: await impl.discover() });
          break;
        case METHODS.doctor:
          writeMessage(transport.write, { id, result: await impl.doctor(params as DoctorSpec) });
          break;
        case METHODS.run:
        case METHODS.review: {
          const iter =
            method === METHODS.review && impl.review
              ? impl.review(params as HarnessRunSpec)
              : impl.run(params as HarnessRunSpec);
          for await (const ev of iter) writeMessage(transport.write, { id, event: ev });
          writeMessage(transport.write, { id, result: { done: true } });
          break;
        }
        case METHODS.cancel:
          await impl.cancel?.((params as { sessionId: string }).sessionId);
          writeMessage(transport.write, { id, result: { ok: true } });
          break;
        default:
          writeMessage(transport.write, { id, error: { message: `unknown method: ${method}` } });
      }
    } catch (err) {
      writeMessage(transport.write, {
        id,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}
