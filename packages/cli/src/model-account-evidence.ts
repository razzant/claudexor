import type { ModelImageFacet } from "@claudexor/core";
import { redactSecrets } from "@claudexor/util";
import type { CredentialUnusableLedger, QuotaRegistry } from "@claudexor/daemon";
import { createCredentialExecutionObserver } from "@claudexor/orchestrator";
import type { ControlProblem, HarnessEvent, ModelUsage } from "@claudexor/schema";

/** Bind at the real catalog/inference boundary, before any provider work.
 * Raw models translate their typed result into the same observation owner
 * as native sessions; the original result and dispatch custody are unchanged. */
export function bindModelAccountEvidence(args: {
  harnessId: string;
  profileId: string;
  model: string | null;
  unusable: CredentialUnusableLedger;
  quota: () => QuotaRegistry;
  /** Images share credential revocation, but never text usage/quota or entitlement. */
  authenticationOnly?: boolean;
}) {
  const binding = args.unusable.bind({
    harnessId: args.harnessId,
    profileId: args.profileId,
    route: "vendor_native",
    requestedModel: args.model,
  });
  const observer = createCredentialExecutionObserver(args.unusable, binding);
  return {
    current: () => args.unusable.current(binding),
    honorCatalog: (observedAt: string) => args.unusable.honorBound(binding, null, observedAt),
    finish: () => observer.finish(),
    observe: (
      problem: ControlProblem | null,
      usage?: ModelUsage,
      model?: string | null,
      dispatched = false,
    ) => {
      if (args.authenticationOnly) {
        if (problem?.code !== "auth_required") return;
        usage = undefined;
      }
      const event: HarnessEvent = {
        type: usage ? "usage" : "error",
        ts: new Date().toISOString(),
        session_id: "model-operation",
        credential_route: "vendor_native",
        credential_profile_id: args.profileId,
        observed_model: model ?? undefined,
        ...(usage
          ? {
              usage: {
                input_tokens: usage.input_tokens ?? undefined,
                output_tokens: usage.output_tokens ?? undefined,
                cached_input_tokens: usage.cached_input_tokens ?? undefined,
              },
            }
          : {}),
      };
      const context = args.authenticationOnly ? {} : (problem?.context ?? {});
      if (typeof context.resetsAt === "string" || typeof context.retryAfterMs === "number") {
        event.rate_limit = {
          applies_to_request_kinds: ["text"],
          resets_at: typeof context.resetsAt === "string" ? context.resetsAt : null,
          retry_delay_ms: typeof context.retryAfterMs === "number" ? context.retryAfterMs : null,
        };
      }
      observer.observe(event);
      // model_unavailable also names local preparation/catalog failures.
      // Only a dispatched generation's typed refusal can condemn that model.
      const category =
        problem?.code === "auth_required"
          ? "authentication_failed"
          : dispatched &&
              args.model !== null &&
              (problem?.code === "model_unavailable" ||
                (problem?.code === "model_capability_refused" &&
                  problem.context.vendorCode === "model_not_found"))
            ? "model_not_found"
            : null;
      if (category) {
        observer.observe({
          ...event,
          type: "error",
          usage: undefined,
          rate_limit: undefined,
          status: { kind: "api_retry", error_category: category },
        });
      }
      observer.observe({
        ...event,
        type: "completed",
        usage: undefined,
        rate_limit: undefined,
        payload: { exit_code: problem ? 1 : 0, harness_reported_error: problem !== null },
      });
      if (!args.authenticationOnly && args.unusable.current(binding))
        args.quota().ingest(args.harnessId, event);
    },
  };
}

/** Bind each image invocation before auth/dispatch; share only authentication
 * evidence, under the same credential generation as text/native execution. */
export function withImageAccountEvidence(
  image: ModelImageFacet,
  args: Omit<Parameters<typeof bindModelAccountEvidence>[0], "model" | "authenticationOnly"> & {
    sourceId: string;
    warn?: (message: string) => void;
  },
): ModelImageFacet {
  return {
    ...image,
    async invoke(input, context) {
      const evidence = bindModelAccountEvidence({ ...args, model: null, authenticationOnly: true });
      try {
        const result = await image.invoke(input, {
          ...context,
          onQuota: (snapshot) => {
            if (
              !evidence.current() ||
              snapshot.subject.harness !== args.harnessId ||
              snapshot.subject.subject_id !== args.profileId ||
              snapshot.subject.credential_route !== "vendor_native"
            )
              return;
            try {
              args.quota().upsert(snapshot);
            } catch (error) {
              args.warn?.(`Image quota evidence was not recorded: ${redactSecrets(String(error))}`);
            }
          },
        });
        try {
          if (
            result.route.source === args.sourceId &&
            result.route.credentialProfileId === args.profileId
          )
            evidence.observe(result.problem);
        } catch (error) {
          args.warn?.(`Model account evidence was not recorded: ${redactSecrets(String(error))}`);
        }
        return result;
      } finally {
        try {
          evidence.finish();
        } catch (error) {
          args.warn?.(
            `Model account evidence finalization failed: ${redactSecrets(String(error))}`,
          );
        }
      }
    },
  };
}
