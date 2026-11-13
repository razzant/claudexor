import type { Dispatcher } from "undici";
import { existingDispatcher } from "./dispatcher-accessor.cjs";

/** The bounds one inference dispatch sets on its own request (see `request`). */
export interface ResponseBounds {
  /** The library's response-head timeout. */
  headMs: number;
  /** The library's response-body timeout. */
  silenceMs: number;
}

interface SendObservation {
  /** The dispatcher began writing this request (its onConnect ran). */
  connected: boolean;
  chunks: number;
  handed: number;
  response: boolean;
  /** The dispatcher reported an error for this send; its code may be absent. */
  errored: boolean;
  errorCode: string | null;
  supported: boolean;
}

/** One exact request body's transport observations, never a retry or a socket owner.
 * Handoff is an UPPER bound on peer receipt. Full handoff is still unknown.
 * A custom fetch/dispatcher which emits no callbacks supplies no evidence.
 */
export class RequestDelivery {
  readonly bytes: Buffer;
  private readonly sends: SendObservation[] = [];

  /** `bytes` are the body exactly as sent, after any content encoding. */
  constructor(bytes: Uint8Array) {
    this.bytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** `bounds` replace the dispatcher's own head and body timeouts for this
   * request only. They are the HTTP library's clocks, not wall-clock deadlines.
   * On HTTP/1.1 both are counted in the library's ticks, and a stretch in which
   * this process's event loop is blocked counts as one tick. The head clock
   * starts with the request, restarts whenever the socket pushes back and when
   * the last body byte is handed off; while the body is being written it ends
   * the request only if the socket is still backpressured. The body clock
   * restarts on every chunk of the response. On HTTP/2 the body value is the
   * stream's idle timeout on the runtime's ordinary timer and the head value is
   * unused. */
  request(bounds?: ResponseBounds): {
    body: ReadableStream<Uint8Array>;
    duplex: "half";
    dispatcher: NonNullable<RequestInit["dispatcher"]>;
  } {
    let offset = 0;
    const bytes = this.bytes;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        const chunk = bytes.subarray(offset, offset + 64 * 1024);
        offset += chunk.length;
        controller.enqueue(chunk);
      },
    });
    let delegate: Dispatcher | undefined;
    const selected = () => (delegate ??= existingDispatcher());
    // Resolve lazily INSIDE fetch. Preserve every property (including
    // isMockActive), callback receiver and dispatch return value of its owner.
    const dispatcher = new Proxy({} as Dispatcher, {
      get: (_target, key) => {
        const target = selected();
        if (key === "dispatch")
          return (options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) => {
            const observation: SendObservation = {
              connected: false,
              chunks: 0,
              handed: 0,
              response: false,
              errored: false,
              errorCode: null,
              supported: true,
            };
            this.sends.push(observation);
            return target.dispatch(
              bounds
                ? { ...options, headersTimeout: bounds.headMs, bodyTimeout: bounds.silenceMs }
                : options,
              new Proxy(handler, {
                get: (original, method) => {
                  const fn = Reflect.get(original, method, original);
                  if (method === "onBodySent")
                    return (...args: unknown[]) => {
                      const chunk = args[0];
                      // Native Undici supplies the actual chunk. Its published
                      // types also describe numeric callbacks: preserve those, but
                      // do not mistake an unfamiliar implementation for byte proof.
                      if (typeof chunk === "string" || chunk instanceof Uint8Array) {
                        observation.chunks += 1;
                        observation.handed += Buffer.byteLength(chunk);
                      } else observation.supported = false;
                      return fn?.apply(original, args);
                    };
                  if (typeof fn !== "function") return fn;
                  return (...args: unknown[]) => {
                    // Both handler generations: the library calls one of each pair.
                    if (method === "onConnect" || method === "onRequestStart")
                      observation.connected = true;
                    if (
                      method === "onHeaders" ||
                      method === "onResponseStarted" ||
                      method === "onResponseStart"
                    )
                      observation.response = true;
                    if (method === "onError" || method === "onResponseError") {
                      // The older callback takes the error alone, the newer one
                      // after its controller.
                      const error = args[method === "onError" ? 0 : args.length - 1] as
                        { code?: unknown } | undefined;
                      observation.errored = true;
                      observation.errorCode = typeof error?.code === "string" ? error.code : null;
                    }
                    return fn.apply(original, args);
                  };
                },
              }),
            );
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    // Node's fetch declarations bundle an older Undici type version. The
    // forwarding dispatch interface is shared; no FormData crosses this seam.
    return {
      body,
      duplex: "half",
      dispatcher: dispatcher as unknown as NonNullable<RequestInit["dispatcher"]>,
    };
  }

  facts() {
    const chunks = this.sends.reduce((sum, send) => sum + send.chunks, 0);
    return {
      bodyBytes: this.bytes.length,
      handedOffBytes:
        chunks && this.sends.every((send) => send.supported)
          ? this.sends.reduce((sum, send) => sum + send.handed, 0)
          : null,
      observedChunks: chunks,
      dispatches: this.sends.length,
      responseReceived: this.sends.some((send) => send.response),
    };
  }

  notDelivered() {
    const facts = this.facts();
    // The send failed before request writing began: the dispatcher reported an
    // error and had not called onConnect, which it calls when it starts to write
    // a request. Any error qualifies; its place in the callback order is the
    // proof, not its code. A thrown fetch error alone proves nothing. A
    // dispatcher that wrote before onConnect, or an interceptor that withheld
    // onConnect from this handler, would make this claim false.
    const connectFailure = (send: SendObservation) =>
      send.supported && send.errored && !send.connected && send.chunks === 0;
    if (!this.sends.length || facts.responseReceived) return null;
    const allConnect = this.sends.every(connectFailure);
    // Every dispatch this wrapper observed counts: a prior full or unknown
    // handoff cannot be erased by a later connect failure. A retry inside the
    // dispatcher, below this wrapper, shares one observation, whose callbacks
    // accumulate.
    const partial = this.sends.every(
      (send) =>
        connectFailure(send) ||
        (send.supported && send.chunks > 0 && send.handed < this.bytes.length),
    );
    if (!allConnect && !partial) return null;
    return {
      state: "not_delivered" as const,
      basis: allConnect ? ("connect_failure" as const) : ("incomplete_upload" as const),
      ...facts,
      errorCodes: this.sends.map((send) => send.errorCode),
    };
  }
}
