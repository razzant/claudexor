import type { IncomingMessage, ServerResponse } from "node:http";

/** A completed request body may be destroyed normally while its response is live. */
export function requestGone(req: IncomingMessage, res: ServerResponse): boolean {
  return req.aborted || res.destroyed || req.socket.destroyed || (req.destroyed && !req.complete);
}

/** What a stopping server answers for work it ended: repeat it after reconnecting. */
export function stoppingProblem(message: string): Error {
  return Object.assign(new Error(message), {
    code: "daemon_stopping",
    status: 503,
    retryable: true,
    requiredActions: ["reconnect"],
  });
}

/** True for the cancellation a server's Stop caused, never for an answer the work reached. */
export function endedByStop(error: unknown, stopping?: AbortSignal): boolean {
  return (
    stopping?.aborted === true &&
    (error === stopping.reason || (error as { name?: unknown } | null)?.name === "AbortError")
  );
}

/**
 * Abort a read when its client goes away or `stopping` fires. A consumed POST
 * may emit close/destroyed while its response remains live, so only a gone
 * request aborts. Call `dispose` when the read settles.
 */
export function readLifetime(
  req: IncomingMessage,
  res: ServerResponse,
  stopping?: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
  const disconnected = new AbortController();
  const check = () => {
    if (requestGone(req, res)) disconnected.abort();
  };
  const socket = req.socket;
  req.on("aborted", check);
  req.on("close", check);
  res.on("close", check);
  socket.on("close", check);
  check();
  return {
    signal: stopping ? AbortSignal.any([disconnected.signal, stopping]) : disconnected.signal,
    dispose() {
      req.off("aborted", check);
      req.off("close", check);
      res.off("close", check);
      socket.off("close", check);
    },
  };
}
