import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";
import type { AgyPermissionRules, AgyProfileSettings, AgyReadGrant } from "./read-grant.js";
import {
  AGY_STRICT_OVER_ACCEPT_EDITS_MIN_CLI_VERSION,
  AGY_WORKSPACE_WRITE_MIN_CLI_VERSION,
  type AgyWorkspaceWriteCli,
} from "./vendor-cli-version.js";

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
 * The vendor's documented limited terminal mode (sandbox page, CLI
 * configuration), which a workspace_write run requests for its own session
 * only. With the terminal sandbox on, `proceed-in-sandbox` runs a shell
 * command without asking only when it runs inside the sandbox and asks before
 * any other; explicit allow, ask and deny rules decide first (Deny > Ask >
 * Allow), and where agy cannot run the sandbox the setting asks like
 * `request-review`. The request is the engine's; the effective mode is agy's.
 * The sandbox mounts every path the profile lets agy read, so it confines
 * where commands write, not what they can read.
 */
export const AGY_WORKSPACE_WRITE_TERMINAL = {
  enableTerminalSandbox: true,
  toolPermission: "proceed-in-sandbox",
} as const;

/** The documented `toolPermission` values (settings page). */
const AGY_TOOL_PERMISSIONS = ["request-review", "proceed-in-sandbox", "strict", "always-proceed"];

/** The readonly capability delta, disclosed in the child's own instructions. */
export const AGY_READONLY_NOTE =
  "ENGINE NOTE (read-only Antigravity run): Your file tools may read files and folders outside the workspace as well as inside it, except where the profile's own rules deny or ask about a read or its strict mode prompts for one. Shell commands and file writes are denied in this run: such a call returns a permission error instead of running, so do not retry it and inspect files with your file tools instead.";

/**
 * A run's session file. A readonly one carries the three permission lists with
 * its denials. A workspace_write one names the two terminal settings when it
 * requests them and, only when saving the read grant failed, the three lists
 * as read with the grant (`agyWorkspaceWriteSessionSettings`); otherwise it
 * names no list, so the profile's lists apply unchanged.
 */
export type AgySessionSettings = {
  permissions?: AgyPermissionRules;
  enableTerminalSandbox?: true;
  toolPermission?: "proceed-in-sandbox";
};
export type AgyReadonlyPolicy =
  | { state: "composed"; settings: { permissions: AgyPermissionRules } }
  | { state: "unavailable"; reason: string };

/**
 * The `--settings` object for a readonly run. agy 1.5.0 merges it into the
 * profile's settings.json key by key but REPLACES each list it names, and it
 * refuses unknown top-level keys (probed without credentials). So it carries
 * only `permissions`, with all three lists copied from the profile and the
 * denials appended: the profile's own allow, deny and ask rules, its
 * `toolPermission` and every other key stay in force. The lists come from the
 * run's one settings snapshot, with the read grant, also when saving the grant
 * failed. Settings that could not be read or have an unexpected shape are not
 * treated as empty: no policy, and the caller refuses the run.
 */
export function agyReadonlyPolicy(grant: AgyReadGrant): AgyReadonlyPolicy {
  const rules = grant.rules;
  if (!rules)
    return {
      state: "unavailable",
      reason: "reason" in grant ? grant.reason : "settings.json permissions are unknown",
    };
  const { allow, deny, ask } = rules;
  const added = AGY_READONLY_DENY_RULES.filter((rule) => !deny.includes(rule));
  return {
    state: "composed",
    settings: { permissions: { allow, deny: [...deny, ...added], ask } },
  };
}

/**
 * A workspace_write run's session file, or null when it needs none: the
 * terminal request, and the lists `carried` (the profile's lists as read with
 * the read grant, only when saving the grant failed). agy replaces each list
 * the file names, so carrying all three as read keeps every allow, deny and ask
 * rule of the snapshot; no other rule is added.
 */
export function agyWorkspaceWriteSessionSettings(
  carried: AgyPermissionRules | null,
  terminal: boolean,
): AgySessionSettings | null {
  if (!carried && !terminal) return null;
  return {
    ...(carried ? { permissions: carried } : {}),
    ...(terminal ? { ...AGY_WORKSPACE_WRITE_TERMINAL } : {}),
  };
}

/**
 * Whether a workspace_write run requests the limited terminal mode. Only a
 * profile that leaves both settings unset, or already chose the same values,
 * gets it. A saved `request-review` or `strict`, a disabled sandbox, a value
 * the engine does not know, unreadable settings and permission lists that are
 * not lists of rules all stay in force and the request is not made: it would
 * loosen what the profile chose, or rest on rules nobody can check.
 */
export function agyWorkspaceWriteTerminal(
  profile: AgyProfileSettings,
): { state: "requested" } | { state: "kept" | "unavailable"; reason: string } {
  if (profile.state === "unavailable") return profile;
  if (profile.rules.state === "invalid")
    return { state: "unavailable", reason: profile.rules.reason };
  const { toolPermission, enableTerminalSandbox } = profile.settings;
  const wanted = AGY_WORKSPACE_WRITE_TERMINAL;
  if (toolPermission !== undefined && toolPermission !== wanted.toolPermission)
    return {
      state: "kept",
      reason: `the profile's toolPermission ${shown(toolPermission, AGY_TOOL_PERMISSIONS)}`,
    };
  if (enableTerminalSandbox !== undefined && enableTerminalSandbox !== true)
    return {
      state: "kept",
      reason: `the profile's enableTerminalSandbox ${shown(enableTerminalSandbox, [false])}`,
    };
  return { state: "requested" };
}

function shown(value: unknown, known: readonly unknown[]): string {
  return known.includes(value)
    ? `is ${JSON.stringify(value)}`
    : "has a value this engine does not recognize";
}

/**
 * Why a workspace_write run must not start for a strict setting, or null. Its
 * `--mode accept-edits` could approve edits that a `strict` tool permission
 * asks about on an agy not known to keep those edits asking
 * (vendor-cli-version.ts), so a profile set to strict, or one whose settings
 * cannot be read and so might be, is refused there, whatever other rules it
 * saved, before its settings are written or anything is sent (on macOS the
 * profile-local keychain may already have been prepared). A saved permission
 * for every command is judged separately
 * (`agyWorkspaceWriteAdminControlsRefusal`).
 */
export function agyWorkspaceWriteStrictRefusal(
  profile: AgyProfileSettings,
  cli: Pick<AgyWorkspaceWriteCli, "installed" | "determined" | "strictKept">,
): string | null {
  if (cli.strictKept) return null;
  const strictMin = AGY_STRICT_OVER_ACCEPT_EDITS_MIN_CLI_VERSION;
  const agy = cli.determined
    ? `agy ${cli.installed} is older than ${strictMin}, the first release in which file edits still ask under strict with accept-edits`
    : `the agy version could not be determined, so it is unknown whether file edits still ask under its strict setting with accept-edits`;
  const cause =
    profile.state === "unavailable"
      ? `the profile's settings could not be read (${profile.reason}), so it is unknown whether they set toolPermission "strict"`
      : profile.settings["toolPermission"] === "strict"
        ? `the profile's toolPermission is "strict"`
        : null;
  return cause
    ? `agy workspace_write did not start, so nothing was sent: ${cause}, and ${agy}; update agy to ${strictMin} or newer`
    : null;
}

/** The documented allow rule for every shell command (the one 6.4.1 sent for its
 * own sessions), compared as written: no pattern is interpreted. */
const AGY_ANY_COMMAND_RULE = "command(*)";

/**
 * Why a workspace_write run must not start on an agy older than 1.5.8 or of
 * unknown version, or null. Before 1.5.8 a headless run could ignore Gemini
 * Enterprise admin controls (vendor-cli-version.ts), so a saved permission
 * that runs every shell command without asking, `toolPermission:
 * "always-proceed"` or the allow rule `command(*)`, could override what an
 * administrator holds back, whether or not the profile is strict. Such a
 * profile, or one whose settings or lists cannot be read and so might hold
 * one, is refused there before its settings are written or anything is sent,
 * and its saved rules stay as they are. Narrower rules are not judged, and
 * every other profile keeps its ordinary edits.
 */
export function agyWorkspaceWriteAdminControlsRefusal(
  profile: AgyProfileSettings,
  cli: Pick<AgyWorkspaceWriteCli, "installed" | "determined" | "terminal">,
): string | null {
  if (cli.terminal) return null;
  const min = AGY_WORKSPACE_WRITE_MIN_CLI_VERSION;
  const unknown = "so it is unknown whether they let every shell command run without asking";
  const cause =
    profile.state === "unavailable"
      ? `the profile's settings could not be read (${profile.reason}), ${unknown}`
      : profile.settings["toolPermission"] === "always-proceed"
        ? `the profile's toolPermission "always-proceed" runs every shell command without asking`
        : profile.rules.state === "invalid"
          ? `the profile's rules could not be checked (${profile.rules.reason}), ${unknown}`
          : profile.rules.lists.allow.includes(AGY_ANY_COMMAND_RULE)
            ? `the profile's allow rule ${AGY_ANY_COMMAND_RULE} runs every shell command without asking`
            : null;
  if (!cause) return null;
  const agy = cli.determined
    ? `agy ${cli.installed} is older than ${min}, the first release whose headless runs apply Gemini Enterprise admin controls, so such a permission could override them`
    : `the agy version could not be determined, so it is unknown whether its headless runs apply Gemini Enterprise admin controls over such a permission`;
  return `agy workspace_write did not start, so nothing was sent: ${cause}, and ${agy}; update agy to ${min} or newer`;
}

/**
 * Whether a workspace_write run requests the limited terminal mode: only on agy
 * 1.5.8 or newer (vendor-cli-version.ts) and only when the profile leaves the
 * choice unset (`agyWorkspaceWriteTerminal`). When it does not, the status
 * says why; a request is disclosed only once its session file is in place,
 * immediately before launch (`agyWorkspaceWritePolicyEvent`).
 */
export function agyWorkspaceWriteTerminalPlan(
  sessionId: string,
  profile: AgyProfileSettings,
  cli: Pick<AgyWorkspaceWriteCli, "installed" | "determined" | "terminal">,
): { requested: true } | { requested: false; status: HarnessEvent } {
  const min = AGY_WORKSPACE_WRITE_MIN_CLI_VERSION;
  if (!cli.terminal)
    return {
      requested: false,
      status: cli.determined
        ? agyWorkspaceWriteNoTerminalEvent(
            sessionId,
            `the installed agy ${cli.installed} is older than ${min}; update agy`,
            {
              code: "agy_workspace_write_version_unsupported",
              installed_version: cli.installed,
              min_version: min,
            },
          )
        : agyWorkspaceWriteNoTerminalEvent(
            sessionId,
            `the installed agy version could not be determined (the request needs ${min} or newer)`,
            { code: "agy_workspace_write_version_unknown", min_version: min },
          ),
    };
  const decision = agyWorkspaceWriteTerminal(profile);
  if (decision.state === "requested") return { requested: true };
  return {
    requested: false,
    status: agyWorkspaceWriteNoTerminalEvent(sessionId, decision.reason, {
      code:
        decision.state === "kept"
          ? "agy_workspace_write_terminal_kept"
          : "agy_workspace_write_session_policy_unavailable",
    }),
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

/** The status event disclosing the terminal mode a workspace_write run requested. */
export function agyWorkspaceWritePolicyEvent(sessionId: string): HarnessEvent {
  return {
    type: "status",
    session_id: sessionId,
    ts: nowIso(),
    text: "agy workspace_write: this run's session settings request agy's terminal sandbox with toolPermission proceed-in-sandbox. Requested, not observed: where agy applies it, a shell command runs without asking only inside the sandbox and any other command asks, which a headless run cannot answer; where agy cannot run the sandbox, the setting asks like request-review. The sandbox can read every path the profile lets agy read, so it is no isolation for untrusted code. The profile's own rules stay in force: a command its allow rules match runs without asking, on a personal account also outside the sandbox",
    payload: {
      code: "agy_workspace_write_session_policy",
      requested: { ...AGY_WORKSPACE_WRITE_TERMINAL },
    },
  };
}

/** The status event of a workspace_write run that requests no terminal mode. */
export function agyWorkspaceWriteNoTerminalEvent(
  sessionId: string,
  reason: string,
  payload: Record<string, unknown>,
): HarnessEvent {
  return {
    type: "status",
    session_id: sessionId,
    ts: nowIso(),
    text: `agy workspace_write requests no terminal sandbox, so its file edits follow accept-edits within the profile's own settings and a shell command agy would ask about is denied without asking, which can end a headless turn: ${reason}`,
    payload,
  };
}

/**
 * Keep the session settings out of argv (the profile's rules can name
 * private paths) in a private file the adapter owns until the child has
 * exited or been reaped, including cancellation and spawn failure, like the
 * Claude instructions file. What the run discloses about the file (`written`)
 * is yielded only once it is in place, immediately before the child starts. A
 * file that cannot be written refuses a `required` run before the child
 * starts: every readonly run, whose denials would be missing, and a
 * workspace_write run whose input files only the file's read grant lets agy
 * read. Any other workspace_write run starts without it and says what it lacks.
 */
export async function* withAgySessionSettings(
  settings: AgySessionSettings | null,
  sessionId: string,
  run: (settingsArgs: string[]) => AsyncIterable<HarnessEvent>,
  options?: {
    access?: "readonly" | "workspace_write";
    required?: boolean;
    written?: () => HarnessEvent[];
  },
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
      if (access === "workspace_write" && options?.required !== true) {
        const lacks = [
          settings.toolPermission
            ? "it requests no terminal sandbox (a shell command agy would ask about is denied without asking)"
            : null,
          settings.permissions
            ? "it carries no read grant in place of the one the profile could not save (agy may refuse reads outside the workspace)"
            : null,
        ].filter(Boolean);
        yield {
          type: "status",
          session_id: sessionId,
          ts: nowIso(),
          text: `agy workspace_write runs without session settings, so ${lacks.join(", and ")}: the settings file could not be written: ${detail.slice(0, 300)}`,
          payload: { code: "agy_workspace_write_session_policy_unwritable" },
        };
        yield* run([]);
        return;
      }
      yield {
        type: "error",
        session_id: sessionId,
        ts: nowIso(),
        error: `agy ${access} session settings could not be written, so nothing was sent: ${detail.slice(0, 300)}`,
        payload: { code: `agy_${access}_session_policy_unwritable` },
      };
      yield { type: "completed", session_id: sessionId, ts: nowIso() };
      return;
    }
    yield* options?.written?.() ?? [];
    yield* run(["--settings", path]);
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
