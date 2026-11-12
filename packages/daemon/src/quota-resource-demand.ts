import {
  ACCOUNT_RESOURCE_REFRESH_SOURCES,
  type AccountResourceObservation,
} from "@claudexor/schema";

/** Poll scheduling evidence only. Never converted to quota snapshots or routed
 * through availability/admission: a money observation is not a quota verdict. */
export function resourceRefreshEvidence(resources: readonly AccountResourceObservation[]) {
  return resources.flatMap((snapshot) => {
    const declaration = Object.entries(ACCOUNT_RESOURCE_REFRESH_SOURCES).find(
      ([source, entry]) =>
        entry.credential === "account" &&
        entry.harness === snapshot.target.harness &&
        entry.facets.every((key) => snapshot[key]?.source === source),
    );
    if (!declaration) return [];
    const facets = declaration[1].facets.map((key) => snapshot[key]!);
    if (
      facets.some(
        (facet) =>
          facet.value === null ||
          facet.freshness !== "fresh" ||
          !facet.observed_at ||
          facet.last_error !== null,
      )
    )
      return [];
    const observedAt = Math.min(...facets.map((facet) => Date.parse(facet.observed_at!)));
    if (!Number.isFinite(observedAt)) return [];
    const periodEnds = [...(snapshot.balances?.value ?? []), ...(snapshot.spending?.value ?? [])]
      .map((row) => Date.parse(row.period?.ends_at ?? ""))
      .filter(Number.isFinite);
    return [
      {
        target: snapshot.target,
        key: [snapshot.target.harness, snapshot.target.profile_id].join("\0"),
        observedAt,
        dueAt: Math.min(observedAt + 300_000, ...periodEnds),
      },
    ];
  });
}
