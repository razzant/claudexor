export class JournalCursorError extends Error {
  readonly code = "journal_cursor_invalid";
  readonly status = 409;
  readonly retryable = true;
  readonly requiredActions = ["resnapshot"];
}

export function encodeCursor(partition: string, epoch: string, seq: number): string {
  return Buffer.from(JSON.stringify({ v: 1, p: partition, e: epoch, s: seq })).toString(
    "base64url",
  );
}

export function cursorError(detail: string): JournalCursorError {
  return new JournalCursorError(`journal cursor is ${detail}; resnapshot is required`);
}

export function sequenceAfterCursor(
  cursor: string | null | undefined,
  partition: string,
  epoch: string,
  nextSeq: number,
): number {
  if (!cursor) return 0;
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) throw cursorError("malformed");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw cursorError("malformed");
  }
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "e,p,s,v" || value.v !== 1) {
    throw cursorError("unsupported");
  }
  if (value.p !== partition || value.e !== epoch) throw cursorError("stale epoch");
  if (!Number.isSafeInteger(value.s) || Number(value.s) < 0 || Number(value.s) >= nextSeq) {
    throw cursorError("ahead of the durable partition");
  }
  if (encodeCursor(value.p as string, value.e as string, value.s as number) !== cursor) {
    throw cursorError("not canonically encoded");
  }
  return value.s as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
