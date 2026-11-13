import { measureModelPreparation } from "@claudexor/util";
import {
  createCodexCatalogReader,
  authenticatedProblem,
  codexModelHeaders as headers,
} from "./model-catalog.js";
export { parseCodexModelCatalog } from "./model-catalog.js";
import { codexCapabilityRefusal } from "./model-capability-refusal.js";
import {
  prepareCodexProcessing,
  observeCodexProcessing,
  codexProcessingCost,
} from "./processing.js";
import type { ProcessingReceipt, EffortResolution } from "@claudexor/schema";
import type { ModelAdapter } from "@claudexor/core";
import type { ModelCallResult, ModelNativeContinuation, ModelRoute } from "@claudexor/schema";
import { prepareCodexModelAuth, type CodexModelAuthDeps } from "./model-auth.js";
import {
  buildResponsesRequest,
  CodexModelError,
  emptyModelResult,
  providerProblem,
  readResponsesStream,
  record,
  text,
  validateCodexModelOptions,
} from "./responses.js";
import {
  codexCatalogClientVersion,
  type CodexCatalogClientVersion,
} from "./http-client-version.js";
import { processingAdmissionProblem } from "./processing-refusal.js";
import { ResponseFailureCapture } from "./failure-evidence.js";
import { RequestDelivery } from "./request-delivery.js";
import { codexRequestCompression, encodeRequestBody } from "./request-compression.js";
import { boundReached, CODEX_RESPONSE_BOUNDS } from "./response-bounds.js";
import { codexModelEffortResolution } from "./model-effort.js";
import { createCodexImageFacet } from "./images.js";

const ENDPOINT = "https://chatgpt.com/backend-api/codex";
const TURN_FORMAT = "codex.turn.v1";
/** Transport state belongs to a caller's live turn, never to assistant history. */
function prepareTurnContinuation(
  native: ModelNativeContinuation | null | undefined,
  route: ModelRoute,
): ModelNativeContinuation | null | undefined {
  if (native == null) return native;
  const turnState = text(record(native.payload)?.turnState);
  try {
    if (
      native.format !== TURN_FORMAT ||
      turnState === null ||
      new Headers({ "x-codex-turn-state": turnState }).get("x-codex-turn-state") !== turnState
    )
      throw new Error("invalid turn state");
  } catch {
    throw new CodexModelError(
      "invalid_continuation",
      "Codex transport continuation requires a valid, unchanged HTTP header value.",
    );
  }
  // Unknown or changed identity starts empty. A transport hint must never pin
  // an account or refuse otherwise valid generation on a newly selected route.
  return route.accountFingerprint &&
    native.route.accountFingerprint === route.accountFingerprint &&
    native.route.source === route.source &&
    native.route.credentialProfileId === route.credentialProfileId &&
    native.route.model === route.model
    ? native
    : null;
}

export interface CodexModelAdapterDeps extends CodexModelAuthDeps {
  fetch?: typeof fetch;
  /** Whether the inference body is compressed (see request-compression.ts). */
  requestCompression?: () => boolean;
  /** The client version the catalog read declares (see http-client-version.ts). */
  clientVersion?: () => Promise<CodexCatalogClientVersion>;
}

/** One adapter-owned generation, with the official CLI owning token refresh. */
export function createCodexModelAdapter(deps: CodexModelAdapterDeps = {}): ModelAdapter {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const clientVersion = deps.clientVersion ?? (() => codexCatalogClientVersion());
  const catalogFor = createCodexCatalogReader(fetcher, now, clientVersion);
  const requestCompression = deps.requestCompression ?? codexRequestCompression;
  return {
    id: "codex",
    // Same managed account, auth and delivery owners; a different wire.
    image: createCodexImageFacet(deps),
    inventoryAbsence: "advisory",
    async catalog(context) {
      const auth = await measureModelPreparation("adapterAuth", () =>
        prepareCodexModelAuth(context.profile, context.signal, deps),
      );
      return catalogFor(auth, context);
    },
    async invoke(request, context) {
      let route: ModelRoute = {
        source: "codex",
        credentialProfileId: context.profile.profile_id,
        accountFingerprint: null,
        model: request.model,
      };
      let dispatched = false;
      let delivery: RequestDelivery | undefined;
      const capture = new ResponseFailureCapture(context.captureFailureEvidence);
      let processing: ProcessingReceipt | undefined;
      let effortResolution: EffortResolution | undefined;
      let nativeContinuation: ModelNativeContinuation | null | undefined =
        request.nativeContinuation === undefined ? undefined : null;
      const withTurnState = (result: ModelCallResult): ModelCallResult => {
        const optIn = request.options.processingPreference !== undefined;
        const observed =
          optIn && processing
            ? observeCodexProcessing(processing, result.appliedOptions.serviceTier)
            : undefined;
        // The turn belongs to the model that ANSWERED, which is known only once
        // the terminal response names it. The header is captured before the body
        // is read, so it carries the requested route until this point, and a
        // terminal response that names another model rebinds it there.
        // A response that names NO model says nothing about whose turn this is:
        // a refused, torn or aborted body leaves the caller's own token exactly
        // as it was, so a live turn survives an incomplete answer instead of
        // being re-rolled into a fresh conversation.
        const answered = result.route.model;
        const turn =
          nativeContinuation && answered !== null && nativeContinuation.route.model !== answered
            ? { ...nativeContinuation, route: { ...nativeContinuation.route, model: answered } }
            : nativeContinuation;
        return {
          ...result,
          ...(effortResolution
            ? {
                effortResolution: {
                  ...effortResolution,
                  observed: result.appliedOptions.reasoningEffort ?? null,
                  observedSource: result.appliedOptions.reasoningEffort
                    ? "codex.responses.reasoning.effort"
                    : null,
                },
              }
            : {}),
          ...(nativeContinuation === undefined ? {} : { nativeContinuation: turn }),
          ...(observed
            ? {
                processing: observed,
                cost: { ...result.cost, processing: codexProcessingCost(observed) },
              }
            : {}),
        };
      };
      try {
        if (
          request.source !== "codex" ||
          (request.account.mode === "pin" &&
            request.account.profileId !== context.profile.profile_id)
        ) {
          throw new CodexModelError(
            "invalid_request",
            "The selected profile does not match the requested Codex route.",
          );
        }
        // Refuse unsupported explicit options before auth helpers, catalog I/O, or dispatch.
        validateCodexModelOptions(request.options);
        const auth = await measureModelPreparation("adapterAuth", () =>
          prepareCodexModelAuth(context.profile, context.signal, deps),
        );
        route = { ...route, accountFingerprint: auth.accountFingerprint };
        nativeContinuation = prepareTurnContinuation(request.nativeContinuation, route);
        const discovered = context.catalog;
        if (
          discovered &&
          (discovered.source !== route.source ||
            discovered.credentialProfileId !== route.credentialProfileId ||
            discovered.accountFingerprint !== auth.accountFingerprint ||
            (discovered.capabilityFingerprint !== undefined &&
              discovered.capabilityFingerprint !== auth.capabilityFingerprint))
        )
          throw new CodexModelError(
            "auth_changed",
            "The managed Codex account changed after model discovery.",
          );
        // The caller may hand off this operation's exact-account catalog.
        // Unknown identity cannot authorize reuse, but remains a usable route:
        // obtain fresh metadata rather than inventing a fingerprint or a limit.
        const catalog = discovered?.accountFingerprint
          ? discovered
          : await catalogFor(auth, context);
        // The raw source declares what a valid catalog miss proves (INV-104).
        // Missing metadata never becomes a fabricated model row or sibling limits.
        const model = catalog.models.find((entry) => entry.id === request.model);
        effortResolution = codexModelEffortResolution(
          request.options.reasoningEffort,
          model,
          catalog.models,
        );
        if (effortResolution.resolution === "rejected") {
          throw new CodexModelError("unsupported_parameter", effortResolution.reason!, {
            parameter: "reasoningEffort",
          });
        }
        processing = prepareCodexProcessing(
          request.options.processingPreference,
          model?.processing,
          request.options.serviceTier,
        );
        const { reasoningEffort: _requestedEffort, ...otherOptions } = request.options;
        const physicalRequest = {
          ...request,
          options: {
            ...otherOptions,
            ...(effortResolution.submitted === null
              ? {}
              : { reasoningEffort: effortResolution.submitted }),
            ...(processing?.submittedNative ? { serviceTier: processing.submittedNative } : {}),
          },
        };
        const encoded = await measureModelPreparation("adapterBody", () => {
          const body = JSON.stringify(buildResponsesRequest(physicalRequest, route));
          return encodeRequestBody(Buffer.from(body, "utf8"), requestCompression());
        });
        delivery = new RequestDelivery(encoded.bytes);
        const requestHeaders = new Headers(headers(auth));
        requestHeaders.set("Content-Length", String(delivery.bytes.length));
        if (encoded.contentEncoding)
          requestHeaders.set("Content-Encoding", encoded.contentEncoding);
        if (nativeContinuation) {
          requestHeaders.set(
            "x-codex-turn-state",
            record(nativeContinuation.payload)!.turnState as string,
          );
        }
        if (request.options.cacheKey !== undefined) {
          try {
            requestHeaders.set("session_id", request.options.cacheKey);
          } catch {
            throw new CodexModelError(
              "unsupported_parameter",
              "The requested cacheKey cannot be represented in a Codex HTTP header.",
              { parameter: "cacheKey" },
            );
          }
        }
        // HTTP header validation is preparation, not evidence of a physical send.
        context.signal.throwIfAborted();
        await context.onDispatch(route);
        dispatched = true;
        const response = await fetcher(`${ENDPOINT}/responses`, {
          method: "POST",
          headers: requestHeaders,
          ...delivery.request(CODEX_RESPONSE_BOUNDS),
          signal: context.signal,
          redirect: "error",
        });
        if (!response.ok) {
          const result = emptyModelResult({ ...route, model: null });
          const error = await capture.readRefusal(response);
          if (response.status === 408) {
            // Request Timeout is the peer saying it did not receive a complete
            // request, so no generation began. An intermediary that answered 408
            // after the origin accepted the whole body would make this false.
            // The refusal's own facts (request id, vendor code, retry hint) stay.
            result.problem = new CodexModelError(
              "transport_not_delivered",
              "The provider did not receive the complete Codex request; generation did not start.",
              {
                ...providerProblem(408, error, response.headers).context,
                generationStarted: false,
                requestDelivery: {
                  state: "not_delivered",
                  basis: "http_408",
                  ...delivery.facts(),
                },
              },
              true,
            ).problem;
            return withTurnState(capture.finish(result));
          }
          result.problem = processingAdmissionProblem(
            codexCapabilityRefusal(
              authenticatedProblem(response, error, auth, now()),
              response.status,
              error,
              request.model,
            ),
            request.options,
            processing,
          );
          return withTurnState(capture.finish(result));
        }
        // Capture before reading the stream. A truncated body still owns this
        // same turn, and an already captured first header wins on later calls.
        const turnState = response.headers.get("x-codex-turn-state");
        if (nativeContinuation === null && turnState) {
          nativeContinuation = { route, format: TURN_FORMAT, payload: { turnState } };
        }
        return withTurnState(
          await readResponsesStream(response, route, context.captureFailureEvidence),
        );
      } catch (error) {
        const result = emptyModelResult({ ...route, model: null });
        const proof = dispatched ? delivery?.notDelivered() : null;
        result.outcome = dispatched && !proof ? "unknown" : "failed";
        result.problem = proof
          ? new CodexModelError(
              "transport_not_delivered",
              "The complete Codex request was not delivered; generation did not start.",
              { generationStarted: false, requestDelivery: proof },
              true,
            ).problem
          : error instanceof CodexModelError
            ? error.problem
            : new CodexModelError(
                dispatched
                  ? "transport_unknown"
                  : context.signal.aborted
                    ? "cancelled"
                    : "model_unavailable",
                dispatched
                  ? `The Codex generation outcome is unknown; it was not retried.${boundReached(error)}`
                  : context.signal.aborted
                    ? "The model operation was cancelled before dispatch."
                    : "The Codex model request could not be prepared.",
              ).problem;
        if (dispatched) {
          capture.caught(error);
          if (delivery && !proof && result.problem)
            result.problem.context.requestDelivery = delivery.facts();
        }
        return withTurnState(dispatched ? capture.finish(result) : result);
      }
    },
  };
}
