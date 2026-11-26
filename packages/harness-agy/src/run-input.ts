import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import { agyInputDelivery } from "./input-file.js";
import { ensureAgyReadGrant, readAgyProfileSettings } from "./read-grant.js";
import {
  AGY_READONLY_NOTE,
  AGY_WORKSPACE_WRITE_TERMINAL,
  agyReadonlyPolicy,
  agyReadonlyPolicyEvent,
  agyWorkspaceWriteStrictRefusal,
  agyWorkspaceWriteTerminalRequest,
  type AgySessionSettings,
} from "./session-policy.js";
import {
  AGY_STRICT_OVER_ACCEPT_EDITS_MIN_CLI_VERSION,
  agyWorkspaceWriteCliFacts,
  type AgyWorkspaceWriteCli,
} from "./vendor-cli-version.js";

/**
 * What the profile settings decide before an agy child starts, with each
 * decision disclosed as it is made: the read grant, a readonly run's session
 * policy and engine note or a workspace_write run's terminal request, and the
 * child's stdin (inline, or the bootstrap of a file delivery). A readonly run
 * always carries its policy: when it cannot be composed safely, or the input
 * cannot be delivered whole, this yields a typed error and `completed` and
 * returns null: nothing is sent. A workspace_write run whose strict setting
 * its accept-edits mode might loosen is refused the same way, before the
 * profile's settings are written.
 */
export function* prepareAgyRunInput(
  spec: HarnessRunSpec,
  profileHome: string,
  /** What the agy a workspace_write run launches supports (workspace-write-cli.ts). */
  workspaceWriteCli: AgyWorkspaceWriteCli = agyWorkspaceWriteCliFacts(null),
): Generator<HarnessEvent, { settings: AgySessionSettings | null; input: string } | null> {
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
  const profile = spec.access === "workspace_write" ? readAgyProfileSettings(profileHome) : null;
  const strict = profile ? agyWorkspaceWriteStrictRefusal(profile, workspaceWriteCli) : null;
  if (strict)
    return yield* refuse(strict, {
      code: "agy_workspace_write_strict_unverified",
      installed_version: workspaceWriteCli.installed,
      min_version: AGY_STRICT_OVER_ACCEPT_EDITS_MIN_CLI_VERSION,
    });
  const readGrant = ensureAgyReadGrant(profileHome);
  const readonlyPolicy = spec.access === "readonly" ? agyReadonlyPolicy(readGrant) : null;
  if (readonlyPolicy?.state === "unavailable")
    return yield* refuse(
      `agy readonly cannot deny commands and writes for this run, so nothing was sent: ${readonlyPolicy.reason}`,
      { code: "agy_readonly_session_policy_unavailable" },
    );
  const sessionPolicy = readonlyPolicy?.state === "composed" ? readonlyPolicy.settings : null;
  // Full access auto-approves every read, so only the other profiles can lose
  // one; a readonly run's session settings carry the read grant themselves.
  if (readGrant.state === "unavailable" && spec.access !== "full")
    yield status(
      sessionPolicy
        ? `agy could not save the profile read grant, so only this readonly run's session settings grant reads: ${readGrant.reason}`
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
  const terminal = profile
    ? yield* agyWorkspaceWriteTerminalRequest(spec.session_id, profile, workspaceWriteCli)
    : false;
  const delivery = agyInputDelivery({
    prompt: spec.prompt,
    instructions: spec.instructions,
    notes: sessionPolicy ? [AGY_READONLY_NOTE] : [],
    dir: spec.input_file_dir,
    readable: spec.access === "full" || readGrant.state !== "unavailable" || sessionPolicy !== null,
    sessionId: spec.session_id,
  });
  if (delivery.kind === "refused")
    return yield* refuse(delivery.error, { code: "agy_input_file_delivery_unavailable" });
  if (delivery.kind === "files") yield delivery.status;
  return {
    settings: sessionPolicy ?? (terminal ? { ...AGY_WORKSPACE_WRITE_TERMINAL } : null),
    input: delivery.input,
  };
}
