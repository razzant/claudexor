#!/usr/bin/env tsx
/**
 * Generates the macOS transcript fixtures for Cursor streams from the engine
 * path itself: the native frames go through the Cursor normalizer and the
 * orchestrator's stored `harness.event` projection. Swift replays the rows
 * through its reducer: command outcomes (#450) into transcript presentation,
 * partial-output text (#575) through the SSE client. Only timestamps are
 * pinned, so the bytes stay stable.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { createCursorParser } from "../packages/harness-cursor/src/parse.js";
import { harnessEventPayload } from "../packages/orchestrator/src/runSupport.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const appFixtures = "apps/macos/ClaudexorApp/Tests/ClaudexorAppTests/Fixtures";
const kitFixtures = "apps/macos/ClaudexorKit/Tests/ClaudexorKitTests/Fixtures";
const targets = [
  {
    source: "packages/harness-cursor/fixtures/shell/command-outcomes.jsonl",
    fixture: `${appFixtures}/cursor-command-outcome-transcript.json`,
  },
  {
    source: "packages/harness-cursor/fixtures/stream/text-deltas.jsonl",
    fixture: `${kitFixtures}/cursor-text-deltas-transcript.json`,
  },
];

for (const { source, fixture: target } of targets) {
  const parse = createCursorParser();
  const events = readFileSync(join(repoRoot, source), "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => parse(JSON.parse(line), "ses-fixture") ?? []);
  const rows = events.map((event, index) => {
    const ts = new Date(Date.UTC(2026, 9, 29, 0, 0, index)).toISOString();
    return {
      seq: index + 1,
      ts,
      type: "harness.event",
      payload: harnessEventPayload("cursor", "a01", { ...event, ts }),
    };
  });

  const fixture = { generatedBy: ["createCursorParser", "harnessEventPayload"], source, rows };
  const body = await format(JSON.stringify(fixture), { parser: "json", printWidth: 100 });
  const fixturePath = join(repoRoot, target);
  if (process.argv.includes("--check")) {
    if (!existsSync(fixturePath) || readFileSync(fixturePath, "utf8") !== body) {
      console.error(`cursor transcript fixture drift: ${target} (regenerate: pnpm fixtures:swift)`);
      process.exit(1);
    }
    console.log(`cursor transcript fixture fresh: ${target}`);
  } else {
    writeFileSync(fixturePath, body);
    console.log(`wrote cursor transcript fixture to ${fixturePath}`);
  }
}
