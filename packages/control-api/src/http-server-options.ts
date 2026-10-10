import type { Server } from "node:http";

/**
 * Explicit socket timeouts for the control API's HTTP server, instead of
 * Node's defaults:
 * - `keepAliveTimeout` outlives every client's idle-reuse window. Node's 5 s
 *   default equals the httpx pool's 5 s keep-alive expiry used by Ouroboros,
 *   so a request reusing an idle socket at that edge raced the server's close
 *   (ECONNRESET). Clients that read the `Keep-Alive` hint see the new value.
 * - `headersTimeout` stays above `keepAliveTimeout`, Node's documented order.
 * - `requestTimeout` is off. It bounds receipt of a whole request, so it could
 *   cut a large upload streamed while the daemon is busy (408); it never
 *   applies to responses, so SSE and long reads are unaffected either way.
 *   The server listens on loopback only and authenticates every route.
 */
export const CONTROL_HTTP_TIMEOUTS = {
  keepAliveTimeout: 65_000,
  headersTimeout: 66_000,
  requestTimeout: 0,
} as const;

/**
 * Apply the timeouts, and keep a long keep-alive from delaying shutdown:
 * `close()` destroys only the sockets idle at that moment, so one still
 * answering when it ran would hold `close()` for the whole keep-alive window
 * once its response finished. After the server stops listening, each socket
 * is closed as soon as its response finishes.
 */
export function withControlHttpTimeouts(server: Server): Server {
  server.on("request", (_req, res) => {
    res.once("finish", () => {
      if (!server.listening) setImmediate(() => server.closeIdleConnections());
    });
  });
  return Object.assign(server, CONTROL_HTTP_TIMEOUTS);
}
