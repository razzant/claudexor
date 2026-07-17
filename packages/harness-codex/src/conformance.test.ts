import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  streamExpectationViolations,
  validateTypedStream,
  type FixtureStreamExpectations,
} from "@claudexor/core";
import { parseCodexEvent, type CodexParseState } from "./parse.js";
import { parse as parseYaml } from "yaml";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
/** W3.8: per-fixture STREAM SEMANTICS expectations, declared next to the
 * fixture's provenance and asserted through the one core owner. */
const manifest = parseYaml(readFileSync(join(FIXTURES, "manifest.yaml"), "utf8")) as {
  fixtures: Record<string, { expectations?: FixtureStreamExpectations }>;
};

/**
 * Real codex stdout can TEAR lines under concurrent writes (observed live on
 * codex 0.137: a web_search item interleaved with an agent_message mid-string).
 * The shared run loop counts such lines as drops instead of failing the run;
 * the parity test mirrors that and bounds the damage.
 */
function parseLines(raw: string): {
  events: unknown[];
  invalidLines: number;
  recognizedLines: number;
} {
  let invalidLines = 0;
  let recognizedLines = 0;
  const events: unknown[] = [];
  // The run loop threads per-run finality state; the parity test must too —
  // without it codex's typed final (stamped on turn.completed) never exists
  // and the test could only check SHAPE, not finality semantics (W3.8).
  const state: CodexParseState = {};
  for (const line of raw.split("\n").filter(Boolean)) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }
    const parsed = parseCodexEvent(obj, "ses-fixture", state);
    if (parsed === null) continue; // unrecognized type: counted by the run loop
    recognizedLines += 1;
    events.push(...parsed);
  }
  return { events, invalidLines, recognizedLines };
}

describe("codex adapter conformance fixtures", () => {
  for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"))) {
    it(`parses ${name} into a conformant typed stream`, () => {
      const { events, invalidLines, recognizedLines } = parseLines(
        readFileSync(join(FIXTURES, name), "utf8"),
      );
      const stats = validateTypedStream(events);
      // Stream SEMANTICS, not just shape (W3.8): finality/delta/lifecycle/
      // rate-limit counts pinned by the manifest expectations.
      const expectations = manifest.fixtures[name]?.expectations;
      expect(expectations, `manifest expectations missing for ${name}`).toBeTruthy();
      expect(streamExpectationViolations(events, expectations!)).toEqual([]);
      expect(recognizedLines).toBeGreaterThan(3);
      expect(invalidLines).toBeLessThanOrEqual(2); // torn-line tolerance, never silence
      expect(stats.started).toBeGreaterThan(0);
      expect(stats.toolCalls).toBeGreaterThan(0);
      expect(stats.toolResults).toBeGreaterThan(0);
      expect(stats.statuslessToolResults).toBe(0);
      expect(stats.usageEvents).toBeGreaterThan(0);
      if (name.startsWith("basic-run")) {
        expect(stats.errorToolResults).toBeGreaterThan(0); // synthetic fixture exercises the failure path
      }
      if (name.startsWith("session-resume")) {
        // v0.9 contract: the native session id is surfaced for thread resume,
        // and a 429 becomes the TYPED rate_limit signal (never prose-matched).
        const started = events.find((e) => (e as { type?: string }).type === "started") as
          { payload?: Record<string, unknown> } | undefined;
        expect(started?.payload?.["native_session_id"]).toBeTruthy();
        const limited = events.find(
          (e) => (e as { rate_limit?: unknown }).rate_limit !== undefined,
        );
        expect(limited).toBeTruthy();
      }
    });
  }
});
