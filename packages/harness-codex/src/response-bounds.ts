import type { ResponseBounds } from "./request-delivery.js";

/** The inference request's own transport bounds, set on every dispatch so a
 * host dispatcher's values do not decide them. The provider sends a keep-alive
 * about every six seconds and closes a silent stream itself at five minutes. */
export const CODEX_RESPONSE_BOUNDS: ResponseBounds = {
  headMs: 300_000,
  silenceMs: 300_000,
};

/** What the two library timeouts mean, for a reader. The code stays the fact. */
const BOUND_REACHED: Record<string, string> = {
  UND_ERR_HEADERS_TIMEOUT: `no response head arrived within ${CODEX_RESPONSE_BOUNDS.headMs / 1_000} s of the request`,
  UND_ERR_BODY_TIMEOUT: `the response stream sent nothing for ${CODEX_RESPONSE_BOUNDS.silenceMs / 1_000} s`,
};

/** A sentence naming the bound an error's cause chain reports, or nothing. */
export function boundReached(error: unknown): string {
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === "object" && !seen.has(current);) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && Object.hasOwn(BOUND_REACHED, code))
      return ` The engine stopped waiting: ${BOUND_REACHED[code]}.`;
    current = (current as { cause?: unknown }).cause;
  }
  return "";
}
