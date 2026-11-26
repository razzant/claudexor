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
 * matches. The terminal sandbox a workspace_write run may request mounts
 * every path a `read_file` rule allows, read-only, so this rule also makes the
 * files it covers visible to commands inside that sandbox.
 */
export const AGY_READ_ANYWHERE_RULE = "read_file(*)";

/** The profile's three permission lists as agy reads them. */
export type AgyPermissionRules = { allow: string[]; deny: string[]; ask: string[] };

/**
 * The grant's state, with the three lists agy reads (the grant included)
 * whenever the snapshot's lists are valid, so a session policy can carry them
 * even when only saving the grant failed. `rules` is absent when the settings
 * or their lists are unknown, and when the file no longer held the snapshot
 * (`changed`): what the run decided from it is out of date, so it must not start.
 */
export type AgyReadGrant =
  | { state: "present" | "added"; rules: AgyPermissionRules }
  | { state: "unavailable"; reason: string; rules?: AgyPermissionRules }
  | { state: "changed"; reason: string; rules?: undefined };

/** agy has no settings-path variable: the profile HOME selects this file. */
export function agySettingsPath(profileHome: string): string {
  return join(profileHome, ".gemini", "antigravity-cli", "settings.json");
}

/**
 * The profile's own settings, read and checked once per run: every decision a
 * run makes from them, and the read grant it saves, come from this one
 * snapshot. A missing or empty file reads as no settings. `rules` holds the
 * three permission lists (absent or null: empty) only when each is a list of
 * rules; otherwise it says why they are unknown, and nothing is written or
 * requested from them. `text` is the file as read (null: there was none).
 */
export type AgyProfileSettings =
  | {
      state: "read";
      settings: Record<string, unknown>;
      rules: { state: "valid"; lists: AgyPermissionRules } | { state: "invalid"; reason: string };
      text: string | null;
      mode: number;
    }
  | { state: "unavailable"; reason: string };

export function readAgyProfileSettings(profileHome: string): AgyProfileSettings {
  let text: string | null = null;
  let mode = 0o600;
  try {
    const path = agySettingsPath(profileHome);
    text = readFileSync(path, "utf8");
    mode = statSync(path).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT")
      return unavailable(`settings.json is unreadable: ${message(error)}`);
  }
  let settings: Record<string, unknown> = {};
  if (text?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return unavailable("settings.json is not valid JSON");
    }
    if (!isRecord(parsed)) return unavailable("settings.json is not a JSON object");
    settings = parsed;
  }
  return { state: "read", settings, rules: permissionRules(settings), text, mode };
}

function permissionRules(
  settings: Record<string, unknown>,
): Extract<AgyProfileSettings, { state: "read" }>["rules"] {
  const permissions = settings["permissions"] ?? {};
  if (!isRecord(permissions))
    return { state: "invalid", reason: "settings.json permissions is not an object" };
  const lists: Partial<AgyPermissionRules> = {};
  for (const key of ["allow", "deny", "ask"] as const) {
    const list = permissions[key] ?? [];
    if (!Array.isArray(list) || list.some((rule) => typeof rule !== "string"))
      return {
        state: "invalid",
        reason: `settings.json permissions.${key} is not a list of rules`,
      };
    lists[key] = [...(list as string[])];
  }
  return { state: "valid", lists: lists as AgyPermissionRules };
}

/**
 * Ensure the Claudexor-owned profile settings carry the read grant, keeping
 * every other key and rule, from the run's one snapshot. The file belongs to
 * the whole profile, so the grant applies to every run on it. Unreadable
 * settings, or lists that are not lists of rules, are never rewritten and the
 * caller discloses the reason; a grant that could not be saved still returns
 * the lists as read, with the grant. A file that no longer holds the snapshot
 * is never replaced by it: `changed`, with no rules.
 */
export function ensureAgyReadGrant(
  profileHome: string,
  profile: AgyProfileSettings = readAgyProfileSettings(profileHome),
): AgyReadGrant {
  if (profile.state === "unavailable") return profile;
  if (profile.rules.state === "invalid") return unavailable(profile.rules.reason);
  const { allow, deny, ask } = profile.rules.lists;
  if (allow.includes(AGY_READ_ANYWHERE_RULE))
    return { state: "present", rules: { allow, deny, ask } };
  const rules = { allow: [...allow, AGY_READ_ANYWHERE_RULE], deny, ask };
  const permissions = profile.settings["permissions"] ?? {};
  let saved: "replaced" | "already" | "changed";
  try {
    saved = replaceIfUnchanged(
      agySettingsPath(profileHome),
      profile.text,
      `${JSON.stringify({ ...profile.settings, permissions: { ...(permissions as object), allow: rules.allow } }, null, 2)}\n`,
      profile.mode,
    );
  } catch (error) {
    return {
      state: "unavailable",
      reason: `settings.json could not be written: ${message(error)}`,
      rules,
    };
  }
  if (saved === "changed")
    return {
      state: "changed",
      reason: "settings.json changed after this run read it; the newer file was left as it is",
    };
  return { state: saved === "replaced" ? "added" : "present", rules };
}

/**
 * Same-directory temp file + rename, so a concurrent reader sees the old or
 * the new file, never a torn one, made only while the file still holds
 * `expected` (null: no file), compared just before the rename, as input-file.ts
 * checks a published copy's bytes. A file that already holds `text` (another
 * run saving the same grant from the same settings) is left alone; any other
 * content is a change and is never replaced. The comparison narrows the
 * window but locks nothing: agy or the user can still change the file between
 * it and the rename. A symlinked settings file is replaced by a regular file
 * (its target is left alone), and a process killed before the rename leaves
 * its temp file.
 */
function replaceIfUnchanged(
  path: string,
  expected: string | null,
  text: string,
  mode: number,
): "replaced" | "already" | "changed" {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, text, { encoding: "utf8", mode, flag: "wx" });
    chmodSync(temp, mode);
    const current = currentText(path);
    if (current === text) return "already";
    if (current !== expected) return "changed";
    renameSync(temp, path);
    return "replaced";
  } finally {
    rmSync(temp, { force: true });
  }
}

function currentText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Why the profile's own validated settings keep agy from reading any file
 * without asking, or null. Three declarations are recognized, exactly as
 * written and with no other rule interpreted: `toolPermission: "strict"`,
 * which prompts before every read, and the all-files rule itself in `ask` or
 * in `deny`. A headless run cannot answer a prompt; where prompts are
 * approved for the run (`promptsApproved`, full access), only the deny rule
 * holds. Settings or lists that are unknown give null here: a read grant
 * cannot be saved from them, and that is reported on its own.
 */
export function agyReadsHeldBySettings(
  profile: AgyProfileSettings,
  promptsApproved: boolean,
): string | null {
  if (profile.state !== "read" || profile.rules.state !== "valid") return null;
  const { deny, ask } = profile.rules.lists;
  if (deny.includes(AGY_READ_ANYWHERE_RULE))
    return `the profile's deny rule ${AGY_READ_ANYWHERE_RULE} refuses every read`;
  if (promptsApproved) return null;
  if (profile.settings["toolPermission"] === "strict")
    return `the profile's toolPermission "strict" asks before every read, which a headless run cannot answer`;
  if (ask.includes(AGY_READ_ANYWHERE_RULE))
    return `the profile's ask rule ${AGY_READ_ANYWHERE_RULE} asks before every read, which a headless run cannot answer`;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unavailable(reason: string): { state: "unavailable"; reason: string } {
  return { state: "unavailable", reason };
}

function message(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200);
}
