import type { ResponseBounds } from "./request-delivery.js";

/** The inference request's own transport bounds, set on every dispatch so a
 * host dispatcher's values do not decide them. The provider sends a keep-alive
 * about every six seconds and closes a silent stream itself at five minutes. */
export const CODEX_RESPONSE_BOUNDS: ResponseBounds = {
  headMs: 300_000,
  silenceMs: 300_000,
};

/** Which library timeout an error code is, and what the engine asks for. The
 * text says what the library reported, never what the provider did, and no
 * elapsed time: the library counts its own ticks, which stop while the
 * daemon's event loop is blocked. The code stays the fact. */
const BOUND_REACHED: Record<string, string> = {
  UND_ERR_HEADERS_TIMEOUT: `a response-head timeout; the engine asks for ${CODEX_RESPONSE_BOUNDS.headMs / 1_000} s on this request`,
  UND_ERR_BODY_TIMEOUT: `a response-body timeout; the engine asks for ${CODEX_RESPONSE_BOUNDS.silenceMs / 1_000} s on this request`,
};

/** A sentence naming the library timeout an error's cause chain reports, or nothing. */
export function boundReached(error: unknown): string {
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === "object" && !seen.has(current);) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && Object.hasOwn(BOUND_REACHED, code))
      return ` The HTTP library reported ${BOUND_REACHED[code]}.`;
    current = (current as { cause?: unknown }).cause;
  }
  return "";
}
