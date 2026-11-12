import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { redactSecrets } from "@claudexor/util";

/**
 * The vendor allow rule documented as matching "all files on the system".
 * Claude and Codex agents read anywhere in every access profile; agy instead
 * asks before a read outside its workspace folders, and a headless run cannot
 * answer, so the read is auto-denied and the turn often ends without output.
 * A read grant changes no write confinement: plan mode still withholds edits,
 * accept-edits still asks before an edit outside the workspace, and shell
 * commands keep their own approval. The vendor evaluates Deny > Ask > Allow,
 * so a read_file deny rule in the same file still wins, and
 * `toolPermission: "strict"` prompts before every read even when an allow rule
 * matches.
 */
export const AGY_READ_ANYWHERE_RULE = "read_file(*)";

/**
 * The grant's state, and the profile's `permissions` object with the grant in
 * it whenever the file could be read and parsed, so a session policy can be
 * composed from the rules the vendor reads even when saving the grant failed.
 * `permissions` is absent only when the settings themselves are unknown.
 */
export type AgyReadGrant =
  | { state: "present" | "added"; permissions: Record<string, unknown> }
  | { state: "unavailable"; reason: string; permissions?: Record<string, unknown> };

/** agy has no settings-path variable: the profile HOME selects this file. */
export function agySettingsPath(profileHome: string): string {
  return join(profileHome, ".gemini", "antigravity-cli", "settings.json");
}

/**
 * Ensure the Claudexor-owned profile settings carry the read grant, keeping
 * every other key and rule. The file belongs to the whole profile, so the
 * grant applies to every run on it. Unreadable or unexpected settings are
 * never rewritten and the caller discloses the reason; a grant that could not
 * be saved still returns the rules as read.
 */
export function ensureAgyReadGrant(profileHome: string): AgyReadGrant {
  const path = agySettingsPath(profileHome);
  let text = "";
  let mode = 0o600;
  try {
    text = readFileSync(path, "utf8");
    mode = statSync(path).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT")
      return unavailable(`settings.json is unreadable: ${message(error)}`);
  }
  let settings: Record<string, unknown> = {};
  if (text.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return unavailable("settings.json is not valid JSON");
    }
    if (!isRecord(parsed)) return unavailable("settings.json is not a JSON object");
    settings = parsed;
  }
  const permissions = settings["permissions"] ?? {};
  if (!isRecord(permissions)) return unavailable("settings.json permissions is not an object");
  const allow = permissions["allow"] ?? [];
  if (!Array.isArray(allow)) return unavailable("settings.json permissions.allow is not a list");
  if (allow.includes(AGY_READ_ANYWHERE_RULE)) return { state: "present", permissions };
  const granted = { ...permissions, allow: [...allow, AGY_READ_ANYWHERE_RULE] };
  try {
    writeAtomically(
      path,
      `${JSON.stringify({ ...settings, permissions: granted }, null, 2)}\n`,
      mode,
    );
  } catch (error) {
    return {
      state: "unavailable",
      reason: `settings.json could not be written: ${message(error)}`,
      permissions: granted,
    };
  }
  return { state: "added", permissions: granted };
}

/** Same-directory temp file + rename: a concurrent run reads the old or the
 * new file, never a torn one. Concurrent writers add the same rule. A
 * symlinked settings file is replaced by a regular file (its target is left
 * alone), and a process killed between write and rename leaves its temp file. */
function writeAtomically(path: string, text: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, text, { encoding: "utf8", mode, flag: "wx" });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unavailable(reason: string): AgyReadGrant {
  return { state: "unavailable", reason };
}

function message(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200);
}
