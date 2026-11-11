import { ControlProblem } from "@claudexor/schema";
import { CliError, controlProblemError } from "./cli-error.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";

/** A 200 whose body is not the declared result comes back the same way on retry. */
export function invalidServiceResponse(message: string): CliError {
  return new CliError("operational", message, {
    code: "invalid_service_response",
    retryable: false,
  });
}

interface ObservationRead {
  method: "GET" | "POST";
  body?: string;
  timeoutMs: number;
  /** What failed, e.g. "run snapshot"; names the timeout and HTTP failures. */
  label: string;
  /** The problem an older daemon answers with an untyped body (no such route). */
  unsupported?: { code: string; message: string };
}

/**
 * One bounded JSON read from an existing daemon. Cancellation and the timeout
 * close only this read; a typed daemon problem keeps its own retryability.
 */
export async function readObservationJson(
  addr: ControlApiAddress,
  path: string,
  read: ObservationRead,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(
    () =>
      controller.abort(
        new CliError("operational", `${read.label} HTTP read timed out`, {
          code: "run_observation_timeout",
          retryable: true,
        }),
      ),
    read.timeoutMs,
  );
  try {
    const response = await controlApiFetch(addr, path, {
      method: read.method,
      ...(read.body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: read.body }),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => {
      controller.signal.throwIfAborted();
      if (response.ok) throw invalidServiceResponse(`daemon returned an invalid ${read.label}`);
      return null;
    });
    controller.signal.throwIfAborted();
    if (!response.ok)
      throw controlProblemError(
        response.status,
        read.unsupported && !ControlProblem.safeParse(body).success
          ? { ...read.unsupported, retryable: false }
          : body,
        `${read.label} failed (HTTP ${response.status})`,
      );
    return body;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
