/** /v2/quota control services over the daemon's QuotaRegistry. */
import type { QuotaRegistry } from "@claudexor/daemon";
import {
  ControlQuotaFreshnessResponse,
  ControlAccountResourcesFreshnessResponse,
  ControlQuotaReadRequest,
  ControlQuotaRefreshRequest,
  accountResourceSourceHarnesses,
  emptyResourceFacet,
  withQuotaAvailability,
  type ControlQuotaResponse,
  type ControlAccountResourcesResponse,
  type AccountResourceSnapshot,
  type AccountResourceTarget,
} from "@claudexor/schema";
import { accountManagementTarget } from "./account-management.js";
import { openRouterKeyCredentials } from "./openrouter-key-source.js";

type AvailabilityScope = Pick<ControlQuotaRefreshRequest, "requestKind" | "model">;
type KeyBinding = { target: AccountResourceTarget; fingerprint: string };

const API_KEY_HARNESSES = accountResourceSourceHarnesses("api_key");
const targetKey = (target: AccountResourceTarget) =>
  JSON.stringify([target.harness, target.profile_id]);
const currentKeyBindings = (): KeyBinding[] =>
  openRouterKeyCredentials().map(({ target, fingerprint }) => ({ target, fingerprint }));

/** Account rows publish as before. API-key rows reach only a client that
 * negotiated includeApiKeys, one per key a request can send now: a row read
 * with another key (replaced or removed) never stands for the current one, and
 * a key not read yet appears with every facet unknown. */
export function publishedResources(
  rows: readonly AccountResourceSnapshot[],
  includeApiKeys = false,
  bindings: () => readonly KeyBinding[] = currentKeyBindings,
): AccountResourceSnapshot[] {
  const accounts = rows.filter((row) => !API_KEY_HARNESSES.has(row.target.harness));
  if (!includeApiKeys) return accounts;
  const stored = new Map(
    rows
      .filter((row) => API_KEY_HARNESSES.has(row.target.harness))
      .map((row) => [targetKey(row.target), row]),
  );
  return [
    ...accounts,
    ...bindings().map(({ target, fingerprint }) => {
      const row = stored.get(targetKey(target));
      return row?.credential_fingerprint === fingerprint
        ? row
        : {
            target,
            credential_fingerprint: fingerprint,
            balances: emptyResourceFacet(),
            spending: emptyResourceFacet(),
            resets: emptyResourceFacet(),
            diagnostics: emptyResourceFacet(),
          };
    }),
  ];
}

export function accountResourcesResponse(
  registry: QuotaRegistry,
  response: ControlQuotaResponse = registry.read(),
  resources: AccountResourceSnapshot[] = registry.readResources(),
  scope: AvailabilityScope = {},
  includeApiKeys = false,
): ControlAccountResourcesResponse {
  return {
    ...withQuotaAvailability(response, scope),
    resources: publishedResources(resources, includeApiKeys),
  };
}

/** An exact refresh names a managed account, or, for a client that negotiated
 * includeApiKeys, one of the API keys a request can send now. */
function validateRefreshTarget(target: AccountResourceTarget, includeApiKeys: boolean): void {
  if (includeApiKeys && API_KEY_HARNESSES.has(target.harness)) {
    if (currentKeyBindings().some((binding) => targetKey(binding.target) === targetKey(target)))
      return;
    throw Object.assign(new Error("No API key is configured for this resource target"), {
      status: 404,
      code: "credential_profile_not_found",
    });
  }
  if (target.profile_id === null)
    throw Object.assign(
      new Error(
        "A null profile_id names a default API-key route; it requires includeApiKeys=true on a harness with an API-key resource source",
      ),
      { status: 400, code: "invalid_request" },
    );
  accountManagementTarget({ harness: target.harness, profile_id: target.profile_id });
}

type DecoratedSnapshot = ControlQuotaResponse["snapshots"][number];

/** The historical Codex reset-credit label and the resets facet it came from. */
function resetCreditLabel(
  resources: readonly AccountResourceSnapshot[],
  snapshot: DecoratedSnapshot,
) {
  const row = resources.find(
    (row) =>
      row.target.harness === snapshot.subject.harness &&
      row.target.profile_id === snapshot.subject.subject_id,
  );
  const count = row?.resets.value?.find((offer) => offer.id === "codex_granted")?.available_count;
  return row && typeof count === "number" && count > 0 && snapshot.source === "codex_app_server"
    ? {
        facet: row.resets,
        constraint: {
          id: "reset_credits",
          label: `${count} reset credit${count === 1 ? "" : "s"} available`,
          used_ratio: null,
          window_seconds: null,
          resets_at: null,
          cooldown_until: null,
        },
      }
    : null;
}

function withResetCreditLabel<T extends object>(snapshot: DecoratedSnapshot, label: T) {
  return {
    ...snapshot,
    constraints: [
      ...snapshot.constraints.filter((constraint) => constraint.id !== "reset_credits"),
      label,
    ],
  };
}

/** Compatibility text belongs at the wire boundary, never in canonical quota
 * evidence or admission. The resources-only view keeps its existing semantics. */
export function legacyQuotaResponse(
  registry: QuotaRegistry,
  response: ControlQuotaResponse,
  resources = registry.readResources?.() ?? [],
  scope: AvailabilityScope = {},
): ControlQuotaResponse {
  const decorated = withQuotaAvailability(response, scope);
  return {
    ...decorated,
    snapshots: decorated.snapshots.map((snapshot) => {
      const credits = resetCreditLabel(resources, snapshot);
      return credits ? withResetCreditLabel(snapshot, credits.constraint) : snapshot;
    }),
  };
}

/** Opt-in display read: the legacy shape plus each window's own freshness.
 * The compatibility label is not a quota window: it carries the freshness of
 * the resets facet its count came from, never fresher than an unknown snapshot. */
export function constraintFreshnessQuotaResponse(
  registry: QuotaRegistry,
  scope: AvailabilityScope = {},
  resources = registry.readResources?.() ?? [],
): ControlQuotaFreshnessResponse {
  const decorated = withQuotaAvailability(registry.readConstraintFreshness(), scope);
  return ControlQuotaFreshnessResponse.parse({
    ...decorated,
    snapshots: decorated.snapshots.map((snapshot) => {
      const credits = resetCreditLabel(resources, snapshot);
      return credits
        ? withResetCreditLabel(snapshot, {
            ...credits.constraint,
            freshness: snapshot.freshness === "unknown" ? "unknown" : credits.facet.freshness,
          })
        : snapshot;
    }),
  });
}

/** Bind GET/POST /v2/quota to the registry. Both routes decorate each snapshot
 * with the derived model-aware availability projection at the response
 * boundary; the registry's own read()/journal/projection-signature stay
 * byte-identical. The atomic Accounts response uses the same decorator at its
 * own boundary. POST accepts an optional model to compute state against. */
export function quotaControlServices(quotaRegistry: () => QuotaRegistry) {
  return {
    quota: async (input?: ControlQuotaReadRequest) => {
      const { view, includeApiKeys, ...scope } = ControlQuotaReadRequest.parse(input ?? {});
      if (includeApiKeys && view !== "resources" && view !== "resources_freshness")
        throw Object.assign(
          new Error("includeApiKeys requires view=resources or view=resources_freshness"),
          { status: 400, code: "invalid_request" },
        );
      const registry = quotaRegistry();
      if (view === "resources_freshness") {
        const resources = registry.readResources();
        const response = constraintFreshnessQuotaResponse(registry, scope, resources);
        return ControlAccountResourcesFreshnessResponse.parse({
          ...response,
          resources: publishedResources(resources, includeApiKeys),
          availability_scope: {
            basis: "quota_block",
            model: scope.model ?? null,
            requestKind: scope.requestKind ?? "text",
          },
        });
      }
      if (view === "resources")
        return accountResourcesResponse(
          registry,
          registry.read(),
          registry.readResources(),
          scope,
          includeApiKeys,
        );
      if (view === "constraint_freshness") return constraintFreshnessQuotaResponse(registry, scope);
      return legacyQuotaResponse(registry, registry.read(), undefined, scope);
    },
    refreshQuota: async (
      input?: ControlQuotaRefreshRequest & { view?: "resources"; includeApiKeys?: boolean },
    ) => {
      const { view, includeApiKeys = false, ...body } = input ?? {};
      if (includeApiKeys && view !== "resources")
        throw Object.assign(new Error("includeApiKeys requires view=resources"), {
          status: 400,
          code: "invalid_request",
        });
      const request = ControlQuotaRefreshRequest.parse(body);
      if (request.target) validateRefreshTarget(request.target, includeApiKeys);
      if (view === "resources") {
        const result = await quotaRegistry().refreshResources(request.target);
        return {
          ...withQuotaAvailability(result, request),
          resources: publishedResources(result.resources, includeApiKeys),
        };
      }
      return withQuotaAvailability(
        legacyQuotaResponse(quotaRegistry(), await quotaRegistry().refresh(request.target)),
        request,
      );
    },
  };
}
