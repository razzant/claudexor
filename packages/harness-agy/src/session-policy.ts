import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";
import type { AgyProfileSettings, AgyReadGrant } from "./read-grant.js";
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

type Rules = { allow: string[]; deny: string[]; ask: string[] };
/** A readonly session file carries the permission lists; a workspace_write one
 * names only the terminal settings, so the profile's lists apply unchanged. */
export type AgySessionSettings =
  { permissions: Rules } | { enableTerminalSandbox: true; toolPermission: "proceed-in-sandbox" };
export type AgyReadonlyPolicy =
  | { state: "composed"; settings: { permissions: Rules } }
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
 * Whether a workspace_write run requests the limited terminal mode. Only a
 * profile that leaves both settings unset, or already chose the same values,
 * gets it. A saved `request-review` or `strict`, a disabled sandbox, a value
 * the engine does not know and unreadable settings all stay in force and the
 * request is not made: it would loosen what the profile chose.
 */
export function agyWorkspaceWriteTerminal(
  profile: AgyProfileSettings,
): { state: "requested" } | { state: "kept" | "unavailable"; reason: string } {
  if (profile.state === "unavailable") return profile;
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
 * Why a workspace_write run must not start, or null. Its `--mode accept-edits`
 * could approve edits that a `strict` tool permission asks about on an agy not
 * known to let strict win (vendor-cli-version.ts), so a profile set to strict,
 * or one whose settings cannot be read and so might be, is refused there
 * before anything is sent or written. Every other profile keeps its ordinary
 * edits.
 */
export function agyWorkspaceWriteStrictRefusal(
  profile: AgyProfileSettings,
  cli: Pick<AgyWorkspaceWriteCli, "installed" | "determined" | "strictKept">,
): string | null {
  if (cli.strictKept) return null;
  const strictMin = AGY_STRICT_OVER_ACCEPT_EDITS_MIN_CLI_VERSION;
  const agy = cli.determined
    ? `agy ${cli.installed} is older than ${strictMin}, the first release whose strict setting also wins over accept-edits`
    : `the agy version could not be determined, so it is unknown whether its strict setting wins over accept-edits`;
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

/**
 * Whether a workspace_write run requests the limited terminal mode, with the
 * status event that says why or why not: it is requested only on agy 1.5.8 or
 * newer (vendor-cli-version.ts) and only when the profile leaves the choice
 * unset (`agyWorkspaceWriteTerminal`).
 */
export function* agyWorkspaceWriteTerminalRequest(
  sessionId: string,
  profile: AgyProfileSettings,
  cli: Pick<AgyWorkspaceWriteCli, "installed" | "determined" | "terminal">,
): Generator<HarnessEvent, boolean> {
  const min = AGY_WORKSPACE_WRITE_MIN_CLI_VERSION;
  if (!cli.terminal) {
    yield cli.determined
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
        );
    return false;
  }
  const decision = agyWorkspaceWriteTerminal(profile);
  if (decision.state === "requested") {
    yield agyWorkspaceWritePolicyEvent(sessionId);
    return true;
  }
  yield agyWorkspaceWriteNoTerminalEvent(sessionId, decision.reason, {
    code:
      decision.state === "kept"
        ? "agy_workspace_write_terminal_kept"
        : "agy_workspace_write_session_policy_unavailable",
  });
  return false;
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
    text: `agy workspace_write requests no terminal sandbox, so this run edits files and a shell command agy would ask about is refused in a headless run: ${reason}`,
    payload,
  };
}

/**
 * Keep the session settings out of argv (the profile's rules can name
 * private paths) in a private file the adapter owns until the child has
 * exited or been reaped, including cancellation and spawn failure, like the
 * Claude instructions file. A file that cannot be written refuses a readonly
 * run before the child starts, because its denials would be missing; a
 * workspace_write run starts without it, requesting no terminal sandbox.
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
          text: `agy workspace_write runs without session settings, so it requests no terminal sandbox and a shell command agy would ask about is refused in a headless run: the settings file could not be written: ${detail.slice(0, 300)}`,
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
    yield* run(["--settings", path]);
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
