import type { ModelAdapter } from "@claudexor/core";
import type {
  ModelCapabilityLedger,
  CredentialUnusableLedger,
  QuotaRegistry,
} from "@claudexor/daemon";
import {
  ControlModelCatalogResponse,
  ControlProblem,
  type CredentialProfile,
  type ModelAccountChoice,
  type ModelRoutingEvidence,
  type PreProgressRefusalObservation,
} from "@claudexor/schema";
import { describeCodexClientVersion } from "@claudexor/harness-codex";
import { redactSecrets } from "@claudexor/util";
import { bindModelAccountEvidence } from "./model-account-evidence.js";
import { modelError } from "./model-service-refusals.js";

type SoftObservation = Pick<
  PreProgressRefusalObservation,
  "harness_id" | "profile_id" | "requested_model"
>;

export interface ModelCatalogSelection {
  profile: CredentialProfile;
  catalog: ControlModelCatalogResponse;
  reason: ModelRoutingEvidence["selectionReason"];
}

/** Live per-operation discovery. Listed beats advisory misses; marks beat
 * neither. Preference orders within a tier. A pin keeps exact admission. */
export async function selectModelCatalog(args: {
  adapter: ModelAdapter;
  harnessId: string;
  account: ModelAccountChoice;
  model: string | null;
  signal: AbortSignal;
  capabilities: ModelCapabilityLedger;
  unusable: CredentialUnusableLedger;
  quota: () => QuotaRegistry;
  warn?: (message: string) => void;
  excluded?: Set<string>;
  excludedFingerprint?: string | null;
  /** A differential needs a comparator with no known model deficiency first. */
  correlatedRetry?: boolean;
  /** Only a clean alternative can authorize the host's one differential retry. */
  unmarkedOnly?: boolean;
  /** Whether the request's historical native continuation belongs to this account. */
  boundHistory?: (profileId: string, fingerprint: string | null) => boolean;
  /** Live pre-generation refusals: a recently refusing account ranks like a marked one. */
  refusals?: readonly PreProgressRefusalObservation[];
  /** Live served-model substitutions: that account answered this model with another one. */
  substitutions?: readonly SoftObservation[];
  /** Set when the clean-alternative scan passes an account with no capability row:
   * a soft observation may belong to one request, so that account may still serve. */
  seen?: { capable: boolean };
  pick: (
    excluded: Set<string>,
    refusals: Map<string, ControlProblem>,
  ) => Promise<CredentialProfile>;
}): Promise<ModelCatalogSelection> {
  const excluded = new Set(args.excluded);
  const refusals = new Map<string, ControlProblem>();
  const fallback: Array<{ selection: ModelCatalogSelection; priority: number }> = [];
  for (;;) {
    args.signal.throwIfAborted();
    let profile: CredentialProfile;
    try {
      profile = await args.pick(excluded, refusals);
    } catch (error) {
      const pool = ControlProblem.safeParse(
        error && typeof error === "object" && "problem" in error ? error.problem : null,
      );
      if (!pool.success || !pool.data.context.poolCause) throw error;
      const candidate = fallback.sort((a, b) => a.priority - b.priority)[0];
      if (candidate) return candidate.selection;
      throw error;
    }
    excluded.add(profile.profile_id);
    const catalog = await readCatalog(args, profile, refusals);
    if (!catalog) continue;
    if (args.excludedFingerprint && catalog.accountFingerprint === args.excludedFingerprint)
      continue;
    const listed = args.model === null || catalog.models.some((m) => m.id === args.model);
    if (!listed && args.adapter.inventoryAbsence !== "advisory") {
      const refusal = ControlProblem.parse({
        code: "model_unavailable",
        message: `The selected account does not advertise the requested model in its catalog as served to ${describeCodexClientVersion(catalog)}`,
        retryable: false,
        context: {
          source: args.adapter.id,
          credentialProfileId: profile.profile_id,
          requestedModel: args.model,
          clientVersion: catalog.clientVersion,
          clientVersionSource: catalog.clientVersionSource,
        },
      });
      if (args.account.mode === "pin")
        throw Object.assign(modelError(refusal.code, refusal.message), { problem: refusal });
      refusals.set(profile.profile_id, refusal);
      continue;
    }
    if (args.account.mode === "pin") return { profile, catalog, reason: "pinned" };
    const state = args.capabilities.state(args.harnessId, profile.profile_id, args.model);
    const observed = (rows?: readonly SoftObservation[]) =>
      rows?.some(
        (row) =>
          row.harness_id === args.harnessId &&
          row.profile_id === profile.profile_id &&
          row.requested_model === args.model,
      ) ?? false;
    const refused = observed(args.refusals);
    // A usable preferred account is resolved before the substitution ordering (INV-135).
    const substituted =
      observed(args.substitutions) && args.account.preferredProfileId !== profile.profile_id;
    // A conversation whose native history was produced on its preferred account
    // replays only there: while that account carries no capability row and has
    // not just refused it stays first even when its catalog omits the model
    // (catalogs can lag). A marked or refusing preferred account still yields.
    if (
      state === null &&
      !refused &&
      args.account.mode === "auto" &&
      args.account.preferredProfileId === profile.profile_id &&
      args.boundHistory?.(profile.profile_id, catalog.accountFingerprint)
    )
      return { profile, catalog, reason: "preferred" };
    if (args.unmarkedOnly && (state !== null || refused || substituted)) {
      if (state === null && args.seen) args.seen.capable = true;
      continue;
    }
    const marked =
      refused ||
      substituted ||
      state === "provisional" ||
      state === "confirmed" ||
      state === "probing" ||
      (args.correlatedRetry && state !== null);
    const reason = marked
      ? "marked_fallback"
      : state === "probe_due"
        ? "probe"
        : !listed
          ? "unlisted_fallback"
          : args.account.preferredProfileId === profile.profile_id
            ? "preferred"
            : "listed";
    const selected = { profile, catalog, reason } as ModelCatalogSelection;
    if (listed && !marked) return selected;
    // A soft observation may belong to one request; a capability row is the
    // account's own. A probe already in flight is still usable when nothing
    // else remains.
    fallback.push({
      selection: selected,
      priority: state === "probing" ? 3 : marked && state !== null ? 2 : marked ? 1 : 0,
    });
  }
}

async function readCatalog(
  args: Parameters<typeof selectModelCatalog>[0],
  profile: CredentialProfile,
  refusals: Map<string, ControlProblem>,
): Promise<ControlModelCatalogResponse | null> {
  args.signal.throwIfAborted();
  const generation = args.capabilities.credentials.generation(args.harnessId, profile.profile_id);
  const evidence = bindModelAccountEvidence({
    harnessId: args.harnessId,
    profileId: profile.profile_id,
    model: args.model,
    unusable: args.unusable,
    quota: args.quota,
  });
  try {
    const catalog = ControlModelCatalogResponse.parse(
      await args.adapter.catalog({ profile, signal: args.signal }),
    );
    const after = args.capabilities.credentials.generation(args.harnessId, profile.profile_id);
    // A login window makes either reading unknown (NaN); only two known,
    // different generations prove that the account changed.
    if (Number.isFinite(generation) && Number.isFinite(after) && after !== generation)
      throw modelError(
        "auth_changed",
        "The selected account changed during catalog discovery; try a new operation.",
      );
    if (catalog.source !== args.adapter.id || catalog.credentialProfileId !== profile.profile_id)
      throw modelError(
        "model_catalog_identity_mismatch",
        "The model catalog does not identify the selected account",
      );
    if (catalog.provenance === "provider_http" && catalog.observedAt)
      evidence.honorCatalog(catalog.observedAt);
    args.capabilities.observeCatalog(args.harnessId, catalog, generation);
    return catalog;
  } catch (error) {
    const parsed = ControlProblem.safeParse(
      error && typeof error === "object" && "problem" in error ? error.problem : null,
    );
    if (!parsed.success) throw error;
    const refusal = {
      ...parsed.data,
      context: {
        ...parsed.data.context,
        source: args.adapter.id,
        credentialProfileId: profile.profile_id,
      },
    };
    refusals.set(profile.profile_id, refusal);
    try {
      evidence.observe(refusal);
    } catch (error) {
      args.warn?.(`Model quota evidence was not recorded: ${redactSecrets(String(error))}`);
    }
    if (args.account.mode === "pin")
      throw Object.assign(modelError(refusal.code, refusal.message), { problem: refusal });
    return null;
  } finally {
    try {
      evidence.finish();
    } catch (error) {
      args.warn?.(`Model account evidence finalization failed: ${redactSecrets(String(error))}`);
    }
  }
}
