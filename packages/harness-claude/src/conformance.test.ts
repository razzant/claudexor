import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateTypedStream } from "@claudexor/core";
import { createClaudeParser } from "./parse.js";

const FIXTURES = join(__dirname, "..", "fixtures");

/**
 * Adapter conformance parity (one test per harness, shared core validator):
 * recorded native streams must parse into schema-valid typed events with
 * tool_call/tool_result pairs, statusful results, and usage. Fixtures are
 * refreshed from real CLI streams during paid smoke runs.
 */
describe("claude adapter conformance fixtures", () => {
  for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"))) {
    it(`parses ${name} into a conformant typed stream`, () => {
      const parse = createClaudeParser();
      const events = readFileSync(join(FIXTURES, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => parse(JSON.parse(line), "ses-fixture") ?? []);
      const stats = validateTypedStream(events);
      expect(stats.started).toBeGreaterThan(0);
      expect(stats.toolCalls).toBeGreaterThan(0);
      expect(stats.toolResults).toBeGreaterThan(0);
      expect(stats.statuslessToolResults).toBe(0);
      expect(stats.errorToolResults).toBeGreaterThan(0); // fixture includes a failed tool
      expect(stats.usageEvents).toBeGreaterThan(0);
    });
  }
});
