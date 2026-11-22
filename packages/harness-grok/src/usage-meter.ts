import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Local spend of one Grok account, read from the files the Grok CLI itself
 * writes: `<GROK_HOME>/sessions/<project>/<session>/usage.json`. Each file
 * lists the session's turns with `endedAt` and `costUsdTicks`.
 *
 * The unit is the vendor's: xAI's API reference defines `cost_in_usd_ticks`
 * with `TICKS_IN_USD_CENT = 100_000_000`, that is 10,000,000,000 ticks per USD
 * (docs.x.ai/docs/api-reference, read 2026-11-23). The CLI's `costUsdTicks`
 * is taken to be that same unit.
 *
 * Only `usage.json` is opened. The directory holds the account's credential
 * and its conversations beside it, and neither is read, listed by content, or
 * copied. This is translation of the CLI's own bookkeeping, not a vendor
 * answer: it says nothing about the credential.
 */
export const GROK_TICKS_PER_USD = 10_000_000_000;

export interface GrokUsageSpend {
  /** Sum over turns that ended inside the period. */
  usd: number;
  turns: number;
  totalTokens: number;
  /** Spend per model id, for the turns that name one. */
  usdByModel: Record<string, number>;
  /** Files modified inside the period that could not be read as usage records.
   * Their spend is unknown, so a nonzero count means `usd` is a lower bound. */
  unreadable: number;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    // No sessions directory yet is an account that has not spent anything.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Sum the turns of one usage record that ended in [start, end); null = malformed. */
function sumTurns(raw: string, start: number, end: number, into: GrokUsageSpend): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const turns = (parsed as { turns?: unknown } | null)?.turns;
  if (!Array.isArray(turns)) return false;
  const rows: { ticks: number; tokens: number; byModel: [string, number][] }[] = [];
  for (const turn of turns) {
    const record = turn as Record<string, unknown> | null;
    const endedAt = typeof record?.endedAt === "string" ? Date.parse(record.endedAt) : Number.NaN;
    if (!record || !Number.isFinite(endedAt) || !isCount(record.costUsdTicks)) return false;
    if (endedAt < start || endedAt >= end) continue;
    const usage = record.modelUsage;
    const byModel: [string, number][] =
      usage && typeof usage === "object" && !Array.isArray(usage)
        ? Object.entries(usage as Record<string, { costUsdTicks?: unknown } | null>).flatMap(
            ([model, value]): [string, number][] =>
              isCount(value?.costUsdTicks) ? [[model, value.costUsdTicks]] : [],
          )
        : typeof record.primaryModelId === "string" && record.primaryModelId
          ? [[record.primaryModelId, record.costUsdTicks]]
          : [];
    rows.push({
      ticks: record.costUsdTicks,
      tokens: isCount(record.totalTokens) ? record.totalTokens : 0,
      byModel,
    });
  }
  // A record counts whole or not at all: one malformed turn voids the file.
  for (const row of rows) {
    into.usd += row.ticks / GROK_TICKS_PER_USD;
    into.turns += 1;
    into.totalTokens += row.tokens;
    for (const [model, ticks] of row.byModel)
      into.usdByModel[model] = (into.usdByModel[model] ?? 0) + ticks / GROK_TICKS_PER_USD;
  }
  return true;
}

/**
 * Spend of the account whose Grok home is `grokHome` for turns that ended in
 * [period.start, period.end). A file last modified before the period started
 * cannot hold such a turn and is not opened.
 */
export async function readGrokUsageSpend(
  grokHome: string,
  period: { start: number; end: number },
): Promise<GrokUsageSpend> {
  const spend: GrokUsageSpend = {
    usd: 0,
    turns: 0,
    totalTokens: 0,
    usdByModel: {},
    unreadable: 0,
  };
  const sessions = join(grokHome, "sessions");
  for (const project of await entries(sessions)) {
    for (const session of await entries(join(sessions, project))) {
      const file = join(sessions, project, session, "usage.json");
      try {
        if ((await stat(file)).mtimeMs < period.start) continue;
        if (!sumTurns(await readFile(file, "utf8"), period.start, period.end, spend))
          spend.unreadable += 1;
      } catch (error) {
        // A session with no usage record has no recorded spend.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") spend.unreadable += 1;
      }
    }
  }
  return spend;
}
