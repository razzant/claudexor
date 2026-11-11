import { parseArgs } from "node:util";
import ts from "typescript-api";

export function benchmarkOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string", default: "0919faac4" },
      seconds: { type: "string", default: "30" },
      rounds: { type: "string", default: "2" },
      out: { type: "string", default: "daemon-load-results.json" },
    },
    strict: true,
    allowPositionals: false,
  });
  const seconds = Number(values.seconds),
    rounds = Number(values.rounds);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120)
    throw new Error("seconds must be 1..120");
  if (!Number.isSafeInteger(rounds) || rounds < 1)
    throw new Error("rounds must be a positive integer (each round is a pair of trials)");
  return { ...values, seconds, rounds };
}

/** Each two pairs form ABBA; an odd final pair is AB. */
export function* trialOrder(rounds) {
  for (let round = 1; round <= rounds; round++)
    for (const label of round % 2 ? ["base", "candidate"] : ["candidate", "base"])
      yield { round, label };
}

/** Wrap the same synchronous function body on both source trees, in memory.
 * Fail closed on a renamed/async function so a comparison cannot lose labels.
 * No native calls, branches, SQL, pragmas or worker code are changed. */
export function instrumentSyncFunction(source, name, operation) {
  const file = ts.createSourceFile("bench.ts", source, ts.ScriptTarget.Latest, true);
  const matches = file.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name && node.body,
  );
  if (
    matches.length !== 1 ||
    matches[0].asteriskToken ||
    matches[0].modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
  )
    throw new Error(`benchmark needs exactly one synchronous function ${name}`);
  const body = matches[0].body;
  const start = body.getStart(file) + 1,
    end = body.end - 1;
  return (
    'import { measureSyncSection as __benchMeasureSync } from "@bench/sync-observer";\n' +
    source.slice(0, start) +
    `return __benchMeasureSync(${JSON.stringify(operation)}, () => {` +
    source.slice(start, end) +
    "});" +
    source.slice(end)
  );
}

const maximum = (values) => {
  const present = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return present.length ? Math.max(...present) : null;
};

export function loopTail(loops) {
  const maxWindow = loops.reduce(
    (worst, window) => ((window.delay?.maxMs ?? -1) > (worst?.delay?.maxMs ?? -1) ? window : worst),
    null,
  );
  return {
    // Window p99s cannot be averaged or treated as a pooled run percentile.
    worstWindowP99Ms: maximum(loops.map((window) => window.delay?.p99Ms)),
    maxMs: maxWindow?.delay?.maxMs ?? null,
    maxWindow: maxWindow && {
      windowEndedAt: maxWindow.windowEndedAt,
      windowMs: maxWindow.windowMs,
      worstSync: maxWindow.worstSync,
    },
  };
}

export function runSummary(row) {
  return {
    kind: "run_summary",
    build: row.label,
    round: row.round,
    writes: row.writes,
    reads: row.reads,
    commit: {
      attempts: row.commit.attempts,
      failures: row.commit.failures,
      p99Ms: row.commit.p99_ms,
      maxMs: row.commit.max_ms,
    },
    eventLoop: loopTail(row.loops),
    walMaxMiB: row.walMaxMiB,
    load1: [row.loadStart, row.loadEnd],
  };
}

export function buildSummaries(trials) {
  return ["base", "candidate"].map((build) => {
    const rows = trials.filter((row) => row.label === build);
    return {
      kind: "build_summary",
      build,
      runs: rows.length,
      commit: {
        worstRunP99Ms: maximum(rows.map((row) => row.commit.p99_ms)),
        maxMs: maximum(rows.map((row) => row.commit.max_ms)),
      },
      eventLoop: loopTail(rows.flatMap((row) => row.loops)),
    };
  });
}
