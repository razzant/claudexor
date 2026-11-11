import type {
  CredentialEvidenceAuthority,
  CredentialExecutionBinding,
  CredentialExecutionObserver,
} from "@claudexor/core";
import type { CredentialRoute, CredentialUnusableObservation } from "@claudexor/schema";
import { credentialStreamRefusal } from "./credential-differential.js";
import { classifyStatusError } from "./transientClassify.js";

/** Bind before native execution; events cannot choose another account's identity. */
export function createCredentialExecutionObserver(
  authority: CredentialEvidenceAuthority,
  captured: CredentialExecutionBinding,
): CredentialExecutionObserver {
  const subject = captured.subject;
  const bindings = new Map<CredentialRoute, CredentialExecutionBinding>();
  for (const route of subject.route
    ? [subject.route]
    : (["vendor_native", "managed_api_key"] as const)) {
    bindings.set(route, { ...captured, subject: { ...subject, route } });
  }
  let route = subject.route;
  let terminalFailure = false;
  let cleanTerminal = false;
  let reportedFailure = false;
  let finished = false;
  let observedModel: string | null = null;
  const pending = new Map<CredentialRoute, CredentialUnusableObservation>();
  const servedEvidence = new Map<CredentialRoute, { model: string | null; at: string }>();
  return {
    observe(event) {
      if (
        event.credential_profile_id !== undefined &&
        event.credential_profile_id !== subject.profileId
      )
        return;
      if (event.credential_route) {
        if (subject.route !== null && event.credential_route !== subject.route) return;
        if (route !== event.credential_route) observedModel = null;
        route = event.credential_route;
      }
      if (route === null) return;
      const binding = bindings.get(route);
      if (!binding) return;
      if (event.observed_model) observedModel = event.observed_model;
      const refusal = classifyStatusError(event);
      if (refusal) {
        const value = credentialStreamRefusal({
          harnessId: subject.harnessId,
          profileId: subject.profileId,
          model: subject.requestedModel,
          route,
          refusal,
          now: new Date(event.ts),
        });
        if (value) {
          // A later refusal of one model never narrows a credential-wide one.
          if (value.model === null || pending.get(route)?.model !== null) pending.set(route, value);
          cleanTerminal = false;
        }
      }
      const served =
        event.type === "usage" &&
        ((event.usage?.input_tokens ?? 0) > 0 || (event.usage?.output_tokens ?? 0) > 0);
      if (served) {
        servedEvidence.set(route, { model: observedModel, at: event.ts });
      }
      if (event.type === "error" || event.payload?.["non_success_result"] === true) {
        terminalFailure = true;
        cleanTerminal = false;
        reportedFailure = true;
      }
      if (event.type === "completed") {
        const exitCode = event.payload?.["exit_code"];
        if (typeof exitCode === "number" && exitCode !== 0) terminalFailure = true;
        else if (exitCode === 0 && event.payload?.["aborted"] !== true && !reportedFailure)
          cleanTerminal = true;
      }
    },
    finish() {
      if (finished) return;
      finished = true;
      for (const [actualRoute, proof] of servedEvidence) {
        const refusal = pending.get(actualRoute);
        // Failed native results can report cumulative usage before their error.
        if (
          terminalFailure &&
          !cleanTerminal &&
          refusal &&
          (refusal.model === null || proof.model === null || refusal.model === proof.model)
        )
          continue;
        authority.honorBound(bindings.get(actualRoute)!, proof.model, proof.at);
        if (refusal?.model === null || refusal?.model === proof.model) pending.delete(actualRoute);
      }
      for (const [actualRoute, refusal] of pending) {
        const succeededElsewhere =
          cleanTerminal &&
          (actualRoute !== route ||
            (refusal.model !== null && observedModel !== null && refusal.model !== observedModel));
        if ((terminalFailure && !cleanTerminal) || succeededElsewhere)
          authority.recordBound(bindings.get(actualRoute)!, refusal);
      }
    },
  };
}
