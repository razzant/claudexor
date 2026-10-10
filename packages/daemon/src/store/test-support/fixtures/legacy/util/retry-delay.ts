/**
 * Normalize a vendor-provided retry delay at the adapter boundary.
 *
 * Providers may disclose fractional milliseconds. Claudexor's typed event and
 * telemetry contracts intentionally persist whole non-negative milliseconds,
 * so round upward (never retry earlier than the provider requested) and reject
 * non-finite, negative, or unsafe values instead of leaking an invalid number
 * into durable run artifacts.
 */
export function normalizeRetryDelayMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const rounded = Math.ceil(value);
  return Number.isSafeInteger(rounded) ? rounded : null;
}
