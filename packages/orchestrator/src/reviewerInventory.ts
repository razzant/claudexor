/**
 * How the reviewer panels read a reviewer's live model inventory: the explicit
 * panel's read with one retry and the automatic panel's zero-cost read.
 */
import type { AuthPreference, CredentialProfile, ModelInventoryAbsence } from "@claudexor/schema";
import type { HarnessAdapter, ModelCatalogFailure } from "@claudexor/core";
import {
  HarnessUnavailableError,
  modelCatalogFailureText,
  readModelCatalog,
} from "@claudexor/core";
import { safeErrorMessage } from "./runSupport.js";

const MODEL_INVENTORY_RETRY_DELAY_MS = 250;

export type AutoModelInventory =
  | {
      status: "available";
      ids: Set<string>;
      source: "api" | "manifest";
      catalogRead: boolean;
    }
  | { status: "unknown"; reason: string };

export async function readAutoModelInventory(
  adapter: HarnessAdapter,
  input: Parameters<NonNullable<HarnessAdapter["models"]>>[0],
): Promise<AutoModelInventory> {
  if (typeof adapter.models !== "function")
    return { status: "unknown", reason: "inventory not enumerable" };
  try {
    const read = await readModelCatalog(adapter, input);
    if (read.status === "unavailable")
      return { status: "unknown", reason: modelCatalogFailureText(read.failure) };
    // A fail-soft [] means the provider could not establish an inventory as
    // often as it means a genuinely empty catalog; auto selection never turns
    // that uncertainty into a model mismatch. A typed empty catalog is one.
    if (read.models.length === 0 && read.failSoft)
      return { status: "unknown", reason: "inventory unavailable" };
    const ids = new Set(read.models.map((model) => model.id));
    return {
      status: "available",
      ids,
      source: "api",
      catalogRead: !read.failSoft,
    };
  } catch (error) {
    return { status: "unknown", reason: `inventory unavailable: ${safeErrorMessage(error)}` };
  }
}

/** One retry with a short delay: transient inventory hiccups (cold auth,
 * slow first call) must not fail a panel that would succeed a moment later —
 * but a persistently empty/erroring fail-soft inventory still refuses loudly,
 * UNLESS the producer declared its absences advisory: an empty answer from such
 * a source proves nothing, so it is returned as the empty set and the caller's
 * shared decision forwards the explicit model to the vendor (a second probe
 * would ask the same source the same unanswerable question). A thrown call is
 * still a failure, not an answer, and still refuses. A producer that TYPES its
 * reads answers a catalog (an empty one included) or, after the retry, its
 * typed failure, which the caller refuses with that cause. */
export async function listModelIdsWithRetry(
  adapter: HarnessAdapter,
  input: {
    cwd: string;
    authPreference: AuthPreference;
    credentialProfile?: CredentialProfile | null;
    env: () => Record<string, string>;
    harnessId: string;
    requestedModel: string;
    absence: ModelInventoryAbsence;
  },
): Promise<{ ids: Set<string>; catalogRead: boolean } | { failure: ModelCatalogFailure }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const read = await readModelCatalog(adapter, {
        cwd: input.cwd,
        env: input.env(),
        authPreference: input.authPreference,
        ...(input.credentialProfile ? { credentialProfile: input.credentialProfile } : {}),
      });
      if (read.status === "unavailable") {
        if (attempt === 1) return { failure: read.failure };
        throw new Error(modelCatalogFailureText(read.failure));
      }
      const ids = new Set(read.models.map((m) => m.id));
      if (!read.failSoft) return { ids, catalogRead: true };
      if (ids.size === 0) {
        if (input.absence === "advisory") return { ids, catalogRead: false };
        throw new Error("model inventory was empty");
      }
      return { ids, catalogRead: false };
    } catch (err) {
      lastError = err;
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, MODEL_INVENTORY_RETRY_DELAY_MS));
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown");
  throw new HarnessUnavailableError(
    `reviewer harness '${input.harnessId}' could not verify requested model '${input.requestedModel}' because its model inventory call failed after retry: ${detail}; run \`claudexor models --harness ${input.harnessId}\``,
  );
}
