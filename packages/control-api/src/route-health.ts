/**
 * `GET /v2/daemon/route-health`: per-route outcome counts over the last seven
 * days, computed on demand from the retained run records. Nothing is stored
 * and no background job exists. A route is one harness crossed with one
 * effective access profile.
 *
 * The window is a creation cohort: the terminal product runs created inside
 * it. The scan walks the public run page newest-first by creation (the same
 * keyset page and index as `GET /v2/runs`), so reaching the first older record
 * proves every run of the window was seen. Each selected run contributes its
 * bounded route facts (route-health-facts.ts), read in the shared bulk worker
 * one run at a time with a yield between runs, so the control plane stays
 * responsive; terminal runs do not change, so a cache of the last answer's
 * runs keeps a repeated scan from reading an unchanged run twice. The
 * lifecycle comes from the daemon job state, so a run whose artifacts are
 * unreadable still counts under its real lifecycle.
 */
import {
  ControlRouteHealth,
  RETIRED_EXTERNAL_SANDBOX_FULL,
  ROUTE_HEALTH_MESSAGE_MAX_CHARS,
  ROUTE_HEALTH_TOP_FAILURES,
  ROUTE_HEALTH_WINDOW_DAYS,
  isTerminalLifecycle,
  selectRunListPage,
  type ControlRouteHealthFailure,
  type ControlRouteHealthRoute,
  type RunListQuery,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import type { DaemonRunRecord } from "./run-record.js";
import type { RouteHealthFacts } from "./route-health-facts.js";
import { summarizeRunPage } from "./run-list.js";

/** Records read per daemon page while scanning (the run list's own default page). */
export const ROUTE_HEALTH_PAGE_LIMIT = 200;
/** Most run records one answer reads, newest first; reaching it inside the
 * window is disclosed as `complete: false, incompleteReason: "scan_bound"`. */
export const ROUTE_HEALTH_SCAN_BOUND = 2_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** One terminal run of the window: its lifecycle plus its bounded route facts. */
export interface RouteHealthRun {
  /** The daemon job state (the run lifecycle, D8), read before the facts. */
  lifecycle: string;
  facts: RouteHealthFacts;
}

/** Route facts of the runs the last answered scan read, by record id. An
 * entry is valid while the record's lifecycle, finish time, error and run
 * directory stay the same (a run writes these artifacts before its job turns
 * terminal). Each answer replaces the cache with its own runs, so it never
 * holds more than one scan bound and has no eviction order to defeat. */
export type RouteHealthFactsCache = Map<string, { key: string; facts: RouteHealthFacts }>;

export interface RouteHealthScan {
  from: string;
  generatedAt: string;
  complete: boolean;
  incompleteReason: ControlRouteHealth["incompleteReason"];
}

export interface RouteHealthSource {
  /** One public run page (`GET /v2/runs` semantics: newest first, limit + 1 rows). */
  list(query: RunListQuery): Promise<DaemonRunRecord[]>;
  /** The bounded route facts of one run (the bulk worker's `route-facts` job); a worker failure is a typed 503. */
  facts(record: DaemonRunRecord): Promise<RouteHealthFacts>;
  /** Facts of runs read by earlier scans; without it every scan reads every run. */
  cache?: RouteHealthFactsCache;
  /** False once the caller stopped waiting; the scan then ends without an answer. */
  active?(): boolean;
}

type RouteKey = Pick<ControlRouteHealthRoute, "harnessId" | "access">;
type FailureGroup = Omit<ControlRouteHealthFailure, "count">;

function nonEmpty(value: string | null | undefined): string | null {
  return value ? value : null;
}

/** harness: settled route, else the failure's harness, else the primary harness, else unknown. */
function routeOf(facts: RouteHealthFacts): RouteKey {
  const harnessId =
    nonEmpty(facts.route?.harnessId) ??
    nonEmpty(facts.failure?.harnessId) ??
    nonEmpty(facts.primaryHarness) ??
    "unknown";
  const recorded = facts.effectiveAccess;
  const access =
    recorded === undefined
      ? "unknown"
      : recorded === RETIRED_EXTERNAL_SANDBOX_FULL
        ? "full"
        : recorded;
  return { harnessId, access };
}

/** First line of a display-safe message, redacted, at most 160 UTF-16 units
 * (an ellipsis marks a cut; a cut never splits a surrogate pair). */
export function failureMessageLine(text: string): string {
  const line = (redactSecrets(text).split(/\r?\n/, 1)[0] ?? "").trim();
  if (line.length <= ROUTE_HEALTH_MESSAGE_MAX_CHARS) return line;
  let cut = line.slice(0, ROUTE_HEALTH_MESSAGE_MAX_CHARS - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** A failed run without a typed failure record (and without a job error) is one
 * `unknown` group with an empty message: absence is reported, never invented. */
function failureGroupOf(facts: RouteHealthFacts): FailureGroup {
  const failure = facts.failure;
  return {
    category: failure?.category ?? "unknown",
    code: failure?.code ?? null,
    message: failureMessageLine(failure?.safeMessage ?? facts.error ?? ""),
  };
}

/** Deterministic, locale-independent text order (code units). */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface RouteTally extends RouteKey {
  succeeded: number;
  failed: number;
  cancelled: number;
  other: number;
  failures: Map<string, ControlRouteHealthFailure>;
}

/** Pure grouping of already selected window runs into the typed answer. */
export function aggregateRouteHealth(
  runs: readonly RouteHealthRun[],
  scan: RouteHealthScan,
): ControlRouteHealth {
  const tallies = new Map<string, RouteTally>();
  for (const run of runs) {
    const key = routeOf(run.facts);
    const id = JSON.stringify([key.harnessId, key.access]);
    let tally = tallies.get(id);
    if (!tally) {
      tally = { ...key, succeeded: 0, failed: 0, cancelled: 0, other: 0, failures: new Map() };
      tallies.set(id, tally);
    }
    switch (run.lifecycle) {
      case "succeeded":
        tally.succeeded += 1;
        break;
      case "failed": {
        tally.failed += 1;
        const group = failureGroupOf(run.facts);
        const groupId = JSON.stringify([group.category, group.code, group.message]);
        const counted = tally.failures.get(groupId);
        if (counted) counted.count += 1;
        else tally.failures.set(groupId, { ...group, count: 1 });
        break;
      }
      case "cancelled":
      case "interrupted":
        tally.cancelled += 1;
        break;
      default:
        tally.other += 1;
    }
  }
  const routes = [...tallies.values()]
    .sort((a, b) => compareText(a.harnessId, b.harnessId) || compareText(a.access, b.access))
    .map(({ failures, ...tally }) => ({
      ...tally,
      runs: tally.succeeded + tally.failed + tally.cancelled + tally.other,
      topFailures: [...failures.values()]
        .sort(
          (a, b) =>
            b.count - a.count ||
            compareText(a.category, b.category) ||
            compareText(a.code ?? "", b.code ?? "") ||
            compareText(a.message, b.message),
        )
        .slice(0, ROUTE_HEALTH_TOP_FAILURES),
    }));
  return ControlRouteHealth.parse({
    windowDays: ROUTE_HEALTH_WINDOW_DAYS,
    from: scan.from,
    generatedAt: scan.generatedAt,
    scannedRuns: runs.length,
    complete: scan.complete,
    incompleteReason: scan.incompleteReason,
    routes,
  });
}

function timeOf(value: string | undefined): number {
  return value === undefined ? Number.NaN : Date.parse(value);
}

/** One run's facts, from the cache while its record is unchanged; either way
 * they join this answer's working set. */
async function factsOf(
  source: RouteHealthSource,
  record: DaemonRunRecord,
  working: RouteHealthFactsCache,
): Promise<RouteHealthFacts> {
  const key = JSON.stringify([
    record.state,
    record.finishedAt ?? null,
    record.error ?? null,
    record.runDir ?? null,
  ]);
  const cached = source.cache?.get(record.id);
  const facts = cached?.key === key ? cached.facts : await source.facts(record);
  working.set(record.id, { key, facts });
  return facts;
}

/**
 * Walk the retained run records newest-first by creation time and answer for
 * the fixed window. The walk ends at the first record created before the
 * window start (every later record is older, so the cohort is complete), at
 * the end of the retained records, or at the scan bound; only the bound makes
 * the answer incomplete. A run that finished after `generatedAt` belongs to a
 * later answer. Returns null when the caller stopped waiting before the
 * answer was ready.
 */
export async function scanRouteHealth(
  source: RouteHealthSource,
  now: Date = new Date(),
): Promise<ControlRouteHealth | null> {
  const generatedAt = now.toISOString();
  const nowMs = now.getTime();
  const fromMs = nowMs - ROUTE_HEALTH_WINDOW_DAYS * DAY_MS;
  const from = new Date(fromMs).toISOString();
  const selected: DaemonRunRecord[] = [];
  let cursor: RunListQuery["cursor"] = null;
  let read = 0;
  let incompleteReason: ControlRouteHealth["incompleteReason"] = null;
  scanning: while (true) {
    const query: RunListQuery = {
      limit: Math.min(ROUTE_HEALTH_PAGE_LIMIT, ROUTE_HEALTH_SCAN_BOUND - read),
      state: null,
      cursor,
    };
    const { page, hasMore } = selectRunListPage(await source.list(query), query);
    if (source.active && !source.active()) return null;
    for (const record of page) {
      read += 1;
      const created = timeOf(record.createdAt);
      if (created < fromMs) break scanning;
      if (Number.isNaN(created) || !isTerminalLifecycle(record.state)) continue;
      if (timeOf(record.finishedAt) > nowMs) continue;
      selected.push(record);
    }
    if (!hasMore) break;
    if (read >= ROUTE_HEALTH_SCAN_BOUND) {
      incompleteReason = "scan_bound";
      break;
    }
    const tail = page[page.length - 1]!;
    cursor = { createdAt: tail.createdAt ?? "", id: tail.id };
  }
  const working: RouteHealthFactsCache = new Map();
  const runs = await summarizeRunPage(
    selected,
    async (record) => ({ lifecycle: record.state, facts: await factsOf(source, record, working) }),
    source.active,
  );
  if (source.active && !source.active()) return null;
  if (source.cache) {
    source.cache.clear();
    for (const [id, entry] of working) source.cache.set(id, entry);
  }
  return aggregateRouteHealth(runs, {
    from,
    generatedAt,
    complete: incompleteReason === null,
    incompleteReason,
  });
}
