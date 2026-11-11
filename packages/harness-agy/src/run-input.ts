import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import { agyInputDelivery } from "./input-file.js";
import { ensureAgyReadGrant } from "./read-grant.js";
import {
  AGY_READONLY_NOTE,
  agyReadonlyPolicy,
  agyReadonlyPolicyEvent,
  type AgySessionSettings,
} from "./session-policy.js";

/**
 * What the profile settings decide before an agy child starts, with each
 * decision disclosed as it is made: the read grant, a readonly run's session
 * policy and the engine note naming it, and the child's stdin (inline, or the
 * bootstrap of a file delivery). A readonly run always carries the policy:
 * when it cannot be composed safely, or the input cannot be delivered whole,
 * this yields a typed error and `completed` and returns null: nothing is sent.
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
  const policy = spec.access === "readonly" ? agyReadonlyPolicy(readGrant) : null;
  if (policy?.state === "unavailable")
    return yield* refuse(
      `agy readonly cannot deny commands and writes for this run, so nothing was sent: ${policy.reason}`,
      "agy_readonly_session_policy_unavailable",
    );
  // Full access auto-approves every read, so only the other profiles can lose
  // one; a readonly run's session settings carry the grant themselves.
  if (readGrant.state === "unavailable" && spec.access !== "full")
    yield status(
      policy
        ? `agy could not save the profile read grant, so only this readonly run's session settings grant reads: ${readGrant.reason}`
        : `agy may refuse reads outside the workspace without asking: ${readGrant.reason}`,
      { code: "agy_read_grant_unavailable" },
    );
  if (policy) {
    yield agyReadonlyPolicyEvent(spec.session_id);
    yield status("agy readonly: the engine appended its access note to the instructions", {
      code: "agy_readonly_access_note",
      note: AGY_READONLY_NOTE,
    });
  }
  const delivery = agyInputDelivery({
    prompt: spec.prompt,
    instructions: spec.instructions,
    notes: policy ? [AGY_READONLY_NOTE] : [],
    dir: spec.input_file_dir,
    readable: spec.access === "full" || readGrant.state !== "unavailable" || policy !== null,
    sessionId: spec.session_id,
  });
  if (delivery.kind === "refused")
    return yield* refuse(delivery.error, "agy_input_file_delivery_unavailable");
  if (delivery.kind === "files") yield delivery.status;
  return { settings: policy?.settings ?? null, input: delivery.input };
}
