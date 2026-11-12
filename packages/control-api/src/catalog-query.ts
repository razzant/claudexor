import { assertOnlyQueryParams, optionalBooleanQuery, singleQuery } from "./query.js";
import {
  ControlCredentialProfilesResponse,
  ControlCredentialProfilesSnapshotResponse,
  ControlCredentialProfilesResourcesResponse,
  type ControlQuotaReadRequest,
} from "@claudexor/schema";

export interface HarnessListQuery {
  fresh?: boolean;
  includeFakes?: boolean;
  harnessIds?: string[];
}

export function parseHarnessListQuery(url: URL): HarnessListQuery {
  assertOnlyQueryParams(url, ["fresh", "all", "harness"]);
  const fresh = optionalBooleanQuery(url, "fresh");
  const includeFakes = optionalBooleanQuery(url, "all");
  const harnessValues = url.searchParams.getAll("harness");
  if (harnessValues.some((id) => id.trim().length === 0)) {
    throw new Error("harness query parameters must be non-empty");
  }
  const harnessIds = harnessValues.map((id) => id.trim());
  return {
    ...(fresh === undefined ? {} : { fresh }),
    ...(includeFakes === undefined ? {} : { includeFakes }),
    ...(harnessIds.length === 0 ? {} : { harnessIds }),
  };
}

export function parseCredentialProfilesSnapshotQuery(url: URL) {
  assertOnlyQueryParams(url, ["snapshot", "view", "includeApiKeys"]);
  const snapshot = optionalBooleanQuery(url, "snapshot") ?? false;
  const view = resourceViewQuery(url);
  const includeApiKeys = optionalBooleanQuery(url, "includeApiKeys") === true;
  if (view && !snapshot) throw new Error("view=resources requires snapshot=true");
  if (includeApiKeys && !view) throw new Error("includeApiKeys requires view=resources");
  return {
    input: { snapshot, ...(view ? { view } : {}), ...(includeApiKeys ? { includeApiKeys } : {}) },
    schema: view
      ? ControlCredentialProfilesResourcesResponse
      : snapshot
        ? ControlCredentialProfilesSnapshotResponse
        : ControlCredentialProfilesResponse,
  };
}

export function parseRunApplicabilityQuery(url: URL): { repoRoot: string } {
  assertOnlyQueryParams(url, ["repoRoot"]);
  const repoRoot = singleQuery(url, "repoRoot");
  if (repoRoot === undefined || repoRoot.trim().length === 0) {
    throw new Error("repoRoot query parameter is required");
  }
  return { repoRoot };
}

export function resourceViewQuery(url: URL): "resources" | undefined {
  const view = singleQuery(url, "view");
  if (view !== undefined && view !== "resources") throw new Error("view must be resources");
  return view;
}

/** GET-only quota read selector; POST refresh keeps resourceViewQuery. */
export function quotaReadViewQuery(url: URL): ControlQuotaReadRequest["view"] {
  const view = singleQuery(url, "view");
  if (
    view !== undefined &&
    view !== "resources" &&
    view !== "constraint_freshness" &&
    view !== "resources_freshness"
  )
    throw new Error("view must be resources, constraint_freshness or resources_freshness");
  return view;
}
