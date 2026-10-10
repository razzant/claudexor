import { z } from "zod/v3";

/**
 * Rooted path in either family: POSIX `/x`, a drive-rooted Windows path
 * (`C:\x`, `C:/x`), or a UNC share (`\\host\share\x`). Deliberately a REGEX,
 * not a `node:path` refinement: `packages/schema` is a pure contract package
 * and only a regex survives `schema:gen` as a JSON Schema `pattern`, so every
 * wire consumer keeps the same rule the daemon enforces. Drive-relative
 * (`C:x`) and root-relative (`\x`) spellings are refused — both resolve
 * against per-process state, so they are not absolute evidence — as is NUL.
 */
export const ABSOLUTE_PATH_PATTERN =
  /^(?:\/[^\u0000]*|[A-Za-z]:[\\/][^\u0000]*|\\\\[^\\/\u0000]+[\\/][^\\/\u0000]+(?:[\\/][^\u0000]*)?)$/;

export const SetupLoginJobId = z.string().regex(/^setup-[A-Za-z0-9-]+$/);
export const SetupLoginExecutionId = z.string().regex(/^[A-Za-z0-9-]+$/);
export const SetupLoginAbsolutePath = z.string().regex(ABSOLUTE_PATH_PATTERN, {
  message: "must be an absolute POSIX or Windows path",
});

export const SetupClientPtyPermitWaitMs = z
  .number()
  .int()
  .positive()
  .safe()
  .optional()
  .describe(
    "Sealed runner-to-daemon permit window measured from a deferred client-PTY runner's actual start; absent preserves the legacy absolute-deadline protocol.",
  );
