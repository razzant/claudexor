import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  streamExpectationViolations,
  validateTypedStream,
  type FixtureStreamExpectations,
} from "@claudexor/core";
import { createClaudeParser } from "./parse.js";
import { parse as parseYaml } from "yaml";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
/** W3.8: per-fixture STREAM SEMANTICS expectations, declared next to the
 * fixture's provenance and asserted through the one core owner. */
const manifest = parseYaml(readFileSync(join(FIXTURES, "manifest.yaml"), "utf8")) as {
  fixtures: Record<string, { expectations?: FixtureStreamExpectations }>;
};

/**
 * Adapter conformance parity (one test per harness, shared core validator):
 * recorded native streams must parse into schema-valid typed events with
 * tool_call/tool_result pairs, statusful results, and usage. `recorded-*`
 * fixtures come from real CLI streams; `basic-run` is the synthetic shape
 * fixture that also exercises the failure path.
 */
describe("claude adapter conformance fixtures", () => {
  for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"))) {
    it(`parses ${name} into a conformant typed stream`, () => {
      const parse = createClaudeParser();
      let invalidLines = 0;
      const events: unknown[] = [];
      for (const line of readFileSync(join(FIXTURES, name), "utf8").split("\n").filter(Boolean)) {
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          invalidLines += 1; // the run loop counts torn lines as drops
          continue;
        }
        events.push(...(parse(obj, "ses-fixture") ?? []));
      }
      const stats = validateTypedStream(events);
      // Stream SEMANTICS, not just shape (W3.8): finality/delta/lifecycle/
      // rate-limit counts pinned by the manifest expectations.
      const expectations = manifest.fixtures[name]?.expectations;
      expect(expectations, `manifest expectations missing for ${name}`).toBeTruthy();
      expect(streamExpectationViolations(events, expectations!)).toEqual([]);
      expect(invalidLines).toBeLessThanOrEqual(2);
      expect(stats.started).toBeGreaterThan(0);
      expect(stats.toolCalls).toBeGreaterThan(0);
      expect(stats.toolResults).toBeGreaterThan(0);
      expect(stats.statuslessToolResults).toBe(0);
      expect(stats.errorToolResults).toBeGreaterThan(0); // every fixture includes a real failed tool
      expect(stats.usageEvents).toBeGreaterThan(0);
      if (name.startsWith("session-resume")) {
        // v0.9 contract: native session id surfaced for thread resume, and the
        // api_retry rate limit becomes the TYPED rate_limit signal.
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
