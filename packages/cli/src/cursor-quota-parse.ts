import {
  AccountResourceObservation,
  emptyResourceFacet,
  observedResourceFacet,
  type AccountBalance,
  type AccountSpending,
} from "@claudexor/schema";

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
function amount(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? String(value) : null;
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? value : null;
}
function instant(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(/^\d+$/.test(value) ? Number(value) : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Cursor's internal dashboard source, not a promised public API. Its USD-cent
 * figures are distinct from quota windows: none of these rows is admission
 * evidence. Unknown members stay null, and an unrecognized body is not zero. */
export function parseCursorResources(
  raw: unknown,
  profileId: string,
  at: Date,
): AccountResourceObservation {
  const body = row(raw);
  const target = { harness: "cursor", profile_id: profileId };
  const failed = (reason: string) =>
    AccountResourceObservation.parse({
      target,
      balances: { ...emptyResourceFacet(), last_attempt_at: at.toISOString(), last_error: reason },
      spending: { ...emptyResourceFacet(), last_attempt_at: at.toISOString(), last_error: reason },
      diagnostics: observedResourceFacet(
        [{ code: "cursor_dashboard_unrecognized", detail: reason }],
        "cursor_dashboard",
        at,
      ),
    });
  if (!body || body.error) return failed("unrecognized_dashboard_response");
  const personal = row(body.individualUsage),
    team = row(body.teamUsage);
  const plan = row(personal?.plan),
    personalDemand = row(personal?.onDemand),
    teamDemand = row(team?.onDemand);
  const period = {
    starts_at: instant(body.billingCycleStart),
    ends_at: instant(body.billingCycleEnd),
  };
  // Missing/null is unknown; present malformed values are a failed observation,
  // not a fresh null that replaces the last successful facet.
  const invalidPeriod =
    (["billingCycleStart", "billingCycleEnd"] as const).some(
      (key) => body[key] != null && instant(body[key]) === null,
    ) ||
    (period.starts_at !== null && period.ends_at !== null && period.starts_at >= period.ends_at);
  if (invalidPeriod) return failed("invalid_dashboard_period");
  const numericRows = [plan, personalDemand, teamDemand, row(plan?.breakdown)];
  if (
    numericRows.some(
      (entry) =>
        entry &&
        ["used", "limit", "remaining", "included", "bonus", "total"].some(
          (key) => entry[key] != null && amount(entry[key]) === null,
        ),
    )
  )
    return failed("invalid_dashboard_amount");
  if (
    [plan, personalDemand, teamDemand].some(
      (entry) => entry?.enabled != null && typeof entry.enabled !== "boolean",
    )
  )
    return failed("invalid_dashboard_enabled");
  const balances: AccountBalance[] = [],
    spending: AccountSpending[] = [];
  const common = { unit: "minor", currency: "USD", decimal_places: 2, period, fee_included: null };
  const add = (
    entry: Row | null,
    scope: "personal" | "team",
    usage_kind: "included" | "on_demand",
  ) => {
    if (!entry) return;
    const used = amount(entry.used),
      limit = amount(entry.limit),
      remaining = amount(entry.remaining);
    if (used === null && limit === null && remaining === null && typeof entry.enabled !== "boolean")
      return;
    const id = `cursor_${scope}_${usage_kind}`;
    const label = `${scope === "team" ? "Team pool" : "Personal"} ${usage_kind === "included" ? "included usage" : "on-demand spending"}`;
    spending.push({
      ...common,
      id,
      label,
      scope,
      usage_kind,
      used,
      limit,
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : null,
      resets_at: period.ends_at,
      reason:
        scope === "team"
          ? "Shared team pool; not this account's personal balance"
          : "Internal dashboard observation; not execution availability",
    });
    balances.push({
      ...common,
      id,
      label: `${scope === "team" ? "Team pool" : "Personal"} ${usage_kind === "included" ? "included" : "on-demand"} remaining`,
      scope,
      usage_kind,
      amount: remaining,
      has_balance: remaining === null ? null : Number(remaining) > 0,
      unlimited:
        typeof body.isUnlimited === "boolean" && usage_kind === "included"
          ? body.isUnlimited
          : null,
    });
  };
  add(plan, "personal", "included");
  add(personalDemand, "personal", "on_demand");
  add(teamDemand, "team", "on_demand");
  const breakdown = row(plan?.breakdown);
  for (const [key, usage_kind] of [
    ["bonus", "bonus"],
    ["total", "total"],
  ] as const) {
    const used = amount(breakdown?.[key]);
    if (used !== null)
      spending.push({
        ...common,
        id: `cursor_personal_${usage_kind}`,
        label: `Personal ${usage_kind} usage`,
        scope: "personal",
        usage_kind,
        enabled: null,
        used,
        limit: null,
        resets_at: period.ends_at,
        reason: "Reported spending, not remaining budget",
      });
  }
  if (!spending.length) return failed("unrecognized_dashboard_response");
  return AccountResourceObservation.parse({
    target,
    balances: observedResourceFacet(balances, "cursor_dashboard", at),
    spending: observedResourceFacet(spending, "cursor_dashboard", at),
    diagnostics: observedResourceFacet(
      [
        {
          code: "cursor_dashboard_internal_api",
          detail:
            "Internal dashboard schema may change; numeric resources do not establish execution availability",
        },
        {
          code: "cursor_dashboard_fee_inclusion_unknown",
          detail: "The aggregate source does not identify fee inclusion",
        },
      ],
      "cursor_dashboard",
      at,
    ),
  });
}
