import { DaemonTransportError } from "./client-errors.js";
import { DaemonRpcMethods, daemonRpcError, type DaemonRpcProblem } from "./client.js";
import { rpcProblem } from "./rpc-problem.js";
import type { DaemonServer } from "./server.js";

/**
 * The daemon's own facade client: the socket client's methods, dispatched in
 * process. Callers that live inside the daemon (the control API, model
 * operations, harness maintenance) reach the same `DaemonServer.dispatch` the
 * socket handler enters, without a socket round trip and without the socket
 * transport's ten-second answer bound, so a slow event loop makes a call
 * slow rather than a `daemon_busy` with an unknown mutation outcome.
 *
 * Wire semantics are kept exactly: params, results and problems pass through
 * the same JSON value projection the socket applies, so the server never
 * holds a caller-owned object and a caller never holds a server-owned one;
 * problems are rebuilt by the shared `daemonRpcError`, so
 * code/status/retryable/context/requiredActions match the socket path byte
 * for byte. A result the wire cannot carry is the same typed
 * `daemon_unavailable` the socket client reports. The socket token gate is
 * not repeated: in-process callers already hold the server.
 *
 * The server is resolved per call, so the client can be composed before the
 * server it serves exists.
 */
export class DaemonLocalClient extends DaemonRpcMethods {
  constructor(private readonly server: () => Pick<DaemonServer, "dispatch">) {
    super();
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    let result: unknown;
    try {
      result = await this.server().dispatch(method, wireValue(params));
    } catch (error) {
      throw daemonRpcError(wireValue(rpcProblem(error)) as DaemonRpcProblem);
    }
    let answer: unknown;
    try {
      answer = wireValue(result);
    } catch (error) {
      throw new DaemonTransportError(method, "unavailable", error);
    }
    if (answer === undefined) throw new DaemonTransportError(method, "unavailable");
    return answer as T;
  }
}

/** The JSON value the socket line would carry; `undefined` is an absent field. */
function wireValue(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}
