import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import { agyInputDelivery } from "./input-file.js";
import { ensureAgyReadGrant } from "./read-grant.js";
import {
  AGY_READONLY_NOTE,
  agyReadonlyPolicy,
  agyReadonlyPolicyEvent,
  agyWorkspaceWritePolicy,
  agyWorkspaceWritePolicyEvent,
  type AgySessionSettings,
} from "./session-policy.js";

/**
 * What the profile settings decide before an agy child starts, with each
 * decision disclosed as it is made: the read grant, a readonly or
 * workspace_write run's session policy (and the readonly engine note), and the
 * child's stdin (inline, or the bootstrap of a file delivery). Readonly and
 * workspace_write runs always carry their session policy when composed; when
 * it cannot be composed safely, or the input cannot be delivered whole, this
 * yields a typed error and `completed` and returns null: nothing is sent.
 */
export function* prepareAgyRunInput(
  spec: HarnessRunSpec,
  profileHome: string,
): Generator<HarnessEvent, { settings: AgySessionSettings | null; input: string } | null> {
  const status = (text: string, payload: Record<string, unknown>): HarnessEvent => ({
    type: "status",
    session_id: spec.session_id,
    ts: nowIso(),
    text,
    payload,
  });
  function* refuse(error: string, code: string): Generator<HarnessEvent, null> {
    yield { type: "error", session_id: spec.session_id, ts: nowIso(), error, payload: { code } };
    yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
    return null;
  }
  const readGrant = ensureAgyReadGrant(profileHome);
  const readonlyPolicy = spec.access === "readonly" ? agyReadonlyPolicy(readGrant) : null;
  if (readonlyPolicy?.state === "unavailable")
    return yield* refuse(
      `agy readonly cannot deny commands and writes for this run, so nothing was sent: ${readonlyPolicy.reason}`,
      "agy_readonly_session_policy_unavailable",
    );
  const workspaceWritePolicy =
    spec.access === "workspace_write"
      ? agyWorkspaceWritePolicy(readGrant, spec.tool_permission_policy)
      : null;
  if (workspaceWritePolicy?.state === "unavailable")
    return yield* refuse(
      `agy workspace_write cannot compose session permissions safely for this run, so nothing was sent: ${workspaceWritePolicy.reason}`,
      "agy_workspace_write_session_policy_unavailable",
    );
  const sessionPolicy =
    readonlyPolicy?.state === "composed"
      ? readonlyPolicy.settings
      : workspaceWritePolicy?.state === "composed"
        ? workspaceWritePolicy.settings
        : null;
  // Full access auto-approves every read, so only the other profiles can lose
  // one; readonly and workspace_write session settings carry the read grant themselves.
  if (readGrant.state === "unavailable" && spec.access !== "full")
    yield status(
      sessionPolicy
        ? `agy could not save the profile read grant, so only this ${spec.access} run's session settings grant reads: ${readGrant.reason}`
        : `agy may refuse reads outside the workspace without asking: ${readGrant.reason}`,
      { code: "agy_read_grant_unavailable" },
    );
  if (readonlyPolicy?.state === "composed") {
    yield agyReadonlyPolicyEvent(spec.session_id);
    yield status("agy readonly: the engine appended its access note to the instructions", {
      code: "agy_readonly_access_note",
      note: AGY_READONLY_NOTE,
    });
  } else if (workspaceWritePolicy?.state === "composed") {
    yield agyWorkspaceWritePolicyEvent(spec.session_id, {
      allow: workspaceWritePolicy.addedAllow,
      deny: workspaceWritePolicy.addedDeny,
    });
  }
  const delivery = agyInputDelivery({
    prompt: spec.prompt,
    instructions: spec.instructions,
    notes: readonlyPolicy?.state === "composed" ? [AGY_READONLY_NOTE] : [],
    dir: spec.input_file_dir,
    readable: spec.access === "full" || readGrant.state !== "unavailable" || sessionPolicy !== null,
    sessionId: spec.session_id,
  });
  if (delivery.kind === "refused")
    return yield* refuse(delivery.error, "agy_input_file_delivery_unavailable");
  if (delivery.kind === "files") yield delivery.status;
  return { settings: sessionPolicy, input: delivery.input };
}
