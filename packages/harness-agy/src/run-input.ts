import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import { agyInputDelivery } from "./input-file.js";
import {
  agyReadsHeldBySettings,
  ensureAgyReadGrant,
  readAgyProfileSettings,
} from "./read-grant.js";
import {
  AGY_READONLY_NOTE,
  agyReadonlyPolicy,
  agyReadonlyPolicyEvent,
  agyWorkspaceWriteAdminControlsRefusal,
  agyWorkspaceWriteSessionSettings,
  agyWorkspaceWriteStrictRefusal,
  agyWorkspaceWriteTerminalPlan,
  type AgySessionSettings,
} from "./session-policy.js";
import {
  AGY_STRICT_OVER_ACCEPT_EDITS_MIN_CLI_VERSION,
  AGY_WORKSPACE_WRITE_MIN_CLI_VERSION,
  agyWorkspaceWriteCliFacts,
  type AgyWorkspaceWriteCli,
} from "./vendor-cli-version.js";

export type AgyPreparedInput = {
  settings: AgySessionSettings | null;
  /** The run must not start without its session file (`withAgySessionSettings`). */
  settingsRequired: boolean;
  /** The file requests the terminal mode: disclosed once it is in place, at launch. */
  terminalRequested: boolean;
  input: string;
};

/**
 * What the profile settings decide before an agy child starts, all from ONE
 * snapshot of them, read and checked once: a workspace_write refusal, the read
 * grant, a readonly run's session policy and engine note or a workspace_write
 * run's session file, and the child's stdin (inline, or the bootstrap of a
 * file delivery). A readonly run always carries its policy: when it cannot be
 * composed safely, or the input cannot be delivered whole, this yields a typed
 * error and `completed` and returns null: nothing is sent. A workspace_write
 * run whose strict setting its accept-edits mode might loosen, or whose saved
 * permission for every command might override admin controls, is refused the
 * same way, before the profile's settings are written; so is any run whose
 * settings file changed before its grant was saved. When only saving the
 * read grant failed, a workspace_write run on an agy known to keep strict edits
 * asking (1.5.7) carries the lists as read with the grant in its session file,
 * as a readonly run does; on an older or undetermined agy it cannot. Input that
 * must be read as files is refused, never sent unreadable, when no grant
 * reaches the run or the snapshot asks before or denies every read.
 */
export function* prepareAgyRunInput(
  spec: HarnessRunSpec,
  profileHome: string,
  /** What the agy a workspace_write run launches supports (workspace-write-cli.ts). */
  workspaceWriteCli: AgyWorkspaceWriteCli = agyWorkspaceWriteCliFacts(null),
): Generator<HarnessEvent, AgyPreparedInput | null> {
  const status = (text: string, payload: Record<string, unknown>): HarnessEvent => ({
    type: "status",
    session_id: spec.session_id,
    ts: nowIso(),
    text,
    payload,
  });
  function* refuse(error: string, payload: Record<string, unknown>): Generator<HarnessEvent, null> {
    yield { type: "error", session_id: spec.session_id, ts: nowIso(), error, payload };
    yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
    return null;
  }
  const writing = spec.access === "workspace_write";
  const profile = readAgyProfileSettings(profileHome);
  const strict = writing ? agyWorkspaceWriteStrictRefusal(profile, workspaceWriteCli) : null;
  if (strict)
    return yield* refuse(strict, {
      code: "agy_workspace_write_strict_unverified",
      installed_version: workspaceWriteCli.installed,
      min_version: AGY_STRICT_OVER_ACCEPT_EDITS_MIN_CLI_VERSION,
    });
  const anyCommand = writing
    ? agyWorkspaceWriteAdminControlsRefusal(profile, workspaceWriteCli)
    : null;
  if (anyCommand)
    return yield* refuse(anyCommand, {
      code: "agy_workspace_write_admin_controls_unverified",
      installed_version: workspaceWriteCli.installed,
      min_version: AGY_WORKSPACE_WRITE_MIN_CLI_VERSION,
    });
  const readGrant = ensureAgyReadGrant(profileHome, profile);
  // Every decision above and below rests on the snapshot: a file that changed
  // before the grant was saved leaves none of them standing.
  if (readGrant.state === "changed")
    return yield* refuse(
      `agy did not start, so nothing was sent: ${readGrant.reason}; this run's access decisions came from the earlier settings, so start it again`,
      { code: "agy_profile_settings_changed" },
    );
  const readonlyPolicy = spec.access === "readonly" ? agyReadonlyPolicy(readGrant) : null;
  if (readonlyPolicy?.state === "unavailable")
    return yield* refuse(
      `agy readonly cannot deny commands and writes for this run, so nothing was sent: ${readonlyPolicy.reason}`,
      { code: "agy_readonly_session_policy_unavailable" },
    );
  const sessionPolicy = readonlyPolicy?.state === "composed" ? readonlyPolicy.settings : null;
  const carried =
    writing && workspaceWriteCli.strictKept && readGrant.state === "unavailable"
      ? (readGrant.rules ?? null)
      : null;
  const terminal = writing
    ? agyWorkspaceWriteTerminalPlan(spec.session_id, profile, workspaceWriteCli)
    : null;
  const sessionGrantsReads = sessionPolicy !== null || carried !== null;
  // Full access auto-approves every read, so only the other profiles can lose
  // one; a session file that carries the lists carries the read grant too.
  if (readGrant.state === "unavailable" && spec.access !== "full")
    yield status(
      sessionGrantsReads
        ? `agy could not save the profile read grant, so only this ${spec.access} run's session settings grant reads: ${readGrant.reason}`
        : `agy may refuse reads outside the workspace without asking: ${readGrant.reason}`,
      { code: "agy_read_grant_unavailable" },
    );
  if (sessionPolicy) {
    yield agyReadonlyPolicyEvent(spec.session_id);
    yield status("agy readonly: the engine appended its access note to the instructions", {
      code: "agy_readonly_access_note",
      note: AGY_READONLY_NOTE,
    });
  }
  if (terminal && !terminal.requested) yield terminal.status;
  const granted = spec.access === "full" || readGrant.state !== "unavailable" || sessionGrantsReads;
  const delivery = agyInputDelivery({
    prompt: spec.prompt,
    instructions: spec.instructions,
    notes: sessionPolicy ? [AGY_READONLY_NOTE] : [],
    dir: spec.input_file_dir,
    // A grant does not make files readable where the snapshot itself asks
    // before or denies every read; full access approves the asking itself.
    unreadable:
      agyReadsHeldBySettings(profile, spec.access === "full") ??
      (granted ? null : "the profile read grant is unavailable"),
    sessionId: spec.session_id,
  });
  if (delivery.kind === "refused")
    return yield* refuse(delivery.error, { code: "agy_input_file_delivery_unavailable" });
  if (delivery.kind === "files") yield delivery.status;
  const terminalRequested = terminal?.requested === true;
  return {
    settings: sessionPolicy ?? agyWorkspaceWriteSessionSettings(carried, terminalRequested),
    settingsRequired: sessionPolicy !== null || (carried !== null && delivery.kind === "files"),
    terminalRequested,
    input: delivery.input,
  };
}
