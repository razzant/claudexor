import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";
import type { AgyReadGrant } from "./read-grant.js";

/**
 * Rules a readonly run adds for its own session only (#653). Headless agy
 * ends the whole turn when a tool needs an approval nobody can give, while a
 * matching deny rule fails only that call and returns the error to the model
 * (recorded on 1.5.0). Every command is denied, including commands the
 * profile allows: Deny outranks Allow. Other asking categories (`read_url`,
 * `execute_url`, `mcp`) keep the vendor's behavior and may still end a turn.
 */
export const AGY_READONLY_DENY_RULES = ["command(*)", "write_file(*)"] as const;

/**
 * Rules a workspace_write run adds for its own session only (agy >= 1.5.7).
 * Under headless `--mode accept-edits`, `agy` otherwise asks for interactive
 * approval on shell commands and auto-denies every command when nobody can answer.
 * Adding `command(*)` in session `permissions.allow` while preserving the profile's
 * `deny` and `ask` lists unblocks shell execution without weakening Deny > Ask > Allow
 * or enterprise/admin overrides.
 */
export const AGY_WORKSPACE_WRITE_ALLOW_RULES = ["command(*)"] as const;

/** The readonly capability delta, disclosed in the child's own instructions. */
export const AGY_READONLY_NOTE =
  "ENGINE NOTE (read-only Antigravity run): Your file tools may read files and folders outside the workspace as well as inside it, except where the profile's own rules deny or ask about a read or its strict mode prompts for one. Shell commands and file writes are denied in this run: such a call returns a permission error instead of running, so do not retry it and inspect files with your file tools instead.";

type Rules = { allow: string[]; deny: string[]; ask: string[] };
export type AgySessionSettings = { permissions: Rules };
export type AgyReadonlyPolicy =
  { state: "composed"; settings: AgySessionSettings } | { state: "unavailable"; reason: string };
export type AgyWorkspaceWritePolicy =
  | { state: "composed"; settings: AgySessionSettings; added: string[] }
  | { state: "unavailable"; reason: string };

function readProfilePermissionRules(
  grant: AgyReadGrant,
): { state: "ok"; rules: Rules } | { state: "unavailable"; reason: string } {
  const permissions = grant.permissions;
  if (!permissions)
    return {
      state: "unavailable",
      reason:
        grant.state === "unavailable" ? grant.reason : "settings.json permissions are unknown",
    };
  const rules: Partial<Rules> = {};
  for (const key of ["allow", "deny", "ask"] as const) {
    const list = permissions[key] ?? [];
    if (!Array.isArray(list) || list.some((rule) => typeof rule !== "string"))
      return {
        state: "unavailable",
        reason: `settings.json permissions.${key} is not a list of rules`,
      };
    rules[key] = [...(list as string[])];
  }
  return { state: "ok", rules: rules as Rules };
}

/**
 * The `--settings` object for a readonly run. agy 1.5.0 merges it into the
 * profile's settings.json key by key but REPLACES each list it names, and it
 * refuses unknown top-level keys (probed without credentials). So it carries
 * only `permissions`, with all three lists copied from the profile and the
 * denials appended: the profile's own allow, deny and ask rules, its
 * `toolPermission` and every other key stay in force. The lists come from the
 * rules as read, with the read grant, also when saving the grant failed.
 * Settings that could not be read or have an unexpected shape are not treated
 * as empty: no policy, and the caller refuses the run.
 */
export function agyReadonlyPolicy(grant: AgyReadGrant): AgyReadonlyPolicy {
  const parsed = readProfilePermissionRules(grant);
  if (parsed.state === "unavailable") return parsed;
  const { allow, deny, ask } = parsed.rules;
  const added = AGY_READONLY_DENY_RULES.filter((rule) => !deny.includes(rule));
  return {
    state: "composed",
    settings: { permissions: { allow, deny: [...deny, ...added], ask } },
  };
}

/**
 * The `--settings` object for a workspace_write run. It carries the profile's
 * `allow`, `deny` and `ask` lists as read (agy replaces each list it names)
 * with `command(*)` appended to `allow`, so the vendor's Deny > Ask > Allow
 * order keeps every profile deny and ask rule in force. Settings that could
 * not be read are not treated as empty: no policy, and the run starts without
 * session settings, as before this grant existed.
 */
export function agyWorkspaceWritePolicy(grant: AgyReadGrant): AgyWorkspaceWritePolicy {
  const parsed = readProfilePermissionRules(grant);
  if (parsed.state === "unavailable") return parsed;
  const { allow, deny, ask } = parsed.rules;
  const added = AGY_WORKSPACE_WRITE_ALLOW_RULES.filter((rule) => !allow.includes(rule));
  return {
    state: "composed",
    settings: { permissions: { allow: [...allow, ...added], deny, ask } },
    added,
  };
}

/** The status event disclosing a readonly run's session policy. */
export function agyReadonlyPolicyEvent(sessionId: string): HarnessEvent {
  return {
    type: "status",
    session_id: sessionId,
    ts: nowIso(),
    text: `agy readonly: this run's session settings deny ${AGY_READONLY_DENY_RULES.join(" and ")}; the profile's own rules stay in force`,
    payload: { code: "agy_readonly_session_policy", deny: [...AGY_READONLY_DENY_RULES] },
  };
}

/** The status event disclosing a workspace_write run's session policy. */
export function agyWorkspaceWritePolicyEvent(
  sessionId: string,
  added: readonly string[],
): HarnessEvent {
  return {
    type: "status",
    session_id: sessionId,
    ts: nowIso(),
    text: `agy workspace_write: this run's session settings allow ${AGY_WORKSPACE_WRITE_ALLOW_RULES.join(" and ")}; the profile's own deny and ask rules stay in force`,
    payload: { code: "agy_workspace_write_session_policy", allow: [...added] },
  };
}

/**
 * Keep the session settings out of argv (the profile's rules can name
 * private paths) in a private file the adapter owns until the child has
 * exited or been reaped, including cancellation and spawn failure, like the
 * Claude instructions file. A file that cannot be written refuses a readonly
 * run before the child starts, because its denials would be missing; a
 * workspace_write run starts without it, as before its grant existed.
 */
export async function* withAgySessionSettings(
  settings: AgySessionSettings | null,
  sessionId: string,
  run: (settingsArgs: string[]) => AsyncIterable<HarnessEvent>,
  options?: { access?: "readonly" | "workspace_write" },
): AsyncGenerator<HarnessEvent> {
  if (!settings) {
    yield* run([]);
    return;
  }
  const access = options?.access === "workspace_write" ? "workspace_write" : "readonly";
  let directory: string | undefined;
  try {
    let path: string;
    try {
      directory = mkdtempSync(join(tmpdir(), "claudexor-agy-settings-"));
      path = join(directory, "session-settings.json");
      writeFileSync(path, `${JSON.stringify(settings)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (error) {
      const detail = redactSecrets(error instanceof Error ? error.message : String(error));
      if (access === "workspace_write") {
        yield {
          type: "status",
          session_id: sessionId,
          ts: nowIso(),
          text: `agy workspace_write runs without session settings, so headless shell commands may be refused without asking: the settings file could not be written: ${detail.slice(0, 300)}`,
          payload: { code: "agy_workspace_write_session_policy_unwritable" },
        };
        yield* run([]);
        return;
      }
      yield {
        type: "error",
        session_id: sessionId,
        ts: nowIso(),
        error: `agy readonly session settings could not be written, so nothing was sent: ${detail.slice(0, 300)}`,
        payload: { code: "agy_readonly_session_policy_unwritable" },
      };
      yield { type: "completed", session_id: sessionId, ts: nowIso() };
      return;
    }
    yield* run(["--settings", path]);
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
