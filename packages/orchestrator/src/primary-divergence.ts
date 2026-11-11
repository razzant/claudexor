import type { EventLog } from "@claudexor/event-log";
import { RoutePrimaryDivergedPayload as RoutePrimaryDivergedPayloadSchema } from "@claudexor/schema";

/** Disclose a requested or configured primary lost before dispatch. Browser
 * omissions carry their capability cause; existing pool/quota drops keep
 * their original classification. A degraded primary the Auto pool never
 * admitted was passed over for a doctor-ok route, not missing auth, so its
 * doctor status speaks (#133). No-op when the primary remains ordered. */
export function emitPrimaryDivergence(
  log: EventLog | undefined,
  requested: string | undefined,
  ordered: { adapter: { id: string } }[],
  pool: { adapter: { id: string } }[],
  dropped: string[],
  browserOmissions: string[] = [],
  statuses: ReadonlyMap<string, { status: string; reasons: string[] }> = new Map(),
): void {
  if (!log || !requested || ordered.some((r) => r.adapter.id === requested)) return;
  const survivedPool = pool.some((r) => r.adapter.id === requested);
  const droppedDetail = dropped.find(
    (d) => d.startsWith(`${requested} `) || d.startsWith(`${requested}(`),
  );
  const doctor = statuses.get(requested);
  const degraded = !survivedPool && !droppedDetail && doctor?.status === "degraded";
  const reasons = doctor?.reasons.length ? `: ${doctor.reasons.join("; ")}` : "";
  log.emit(
    "route.primary.diverged",
    RoutePrimaryDivergedPayloadSchema.parse({
      requested,
      effective: ordered[0]?.adapter.id ?? null,
      reason: browserOmissions.includes(requested)
        ? "capability_incompatible"
        : survivedPool
          ? "quota_exhausted"
          : degraded
            ? "readiness_preferred"
            : "auth_unavailable",
      detail: survivedPool
        ? `${requested} is on cooldown or over its budget/quota pace`
        : (droppedDetail ??
          (degraded ? `${requested} is degraded${reasons}` : `${requested} is unavailable`)),
    }) as unknown as Record<string, unknown>,
  );
}
