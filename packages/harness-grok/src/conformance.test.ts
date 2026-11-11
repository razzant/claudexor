import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  streamExpectationViolations,
  validateTypedStream,
  type FixtureStreamExpectations,
} from "@claudexor/core";
import { parse as parseYaml } from "yaml";
import { createGrokParser } from "./parse.js";

const fixtures = new URL("../fixtures/", import.meta.url);
/** Per-fixture stream semantics, declared beside provenance in the manifest. */
const manifest = parseYaml(readFileSync(new URL("manifest.yaml", fixtures), "utf8")) as {
  fixtures: Record<string, { source: string; expectations?: FixtureStreamExpectations }>;
};

describe("Grok recorded stream conformance", () => {
  for (const [name, entry] of Object.entries(manifest.fixtures)) {
    it(name, () => {
      const parser = createGrokParser();
      const events = readFileSync(new URL(name, fixtures), "utf8")
        .trim()
        .split("\n")
        .flatMap((line) => parser.parseEvent(JSON.parse(line), "fixture") ?? []);
      expect(entry.expectations, `manifest expectations missing for ${name}`).toBeTruthy();
      expect(streamExpectationViolations(events, entry.expectations!)).toEqual([]);
      const stats = validateTypedStream(events);
      expect(stats.started).toBe(1);
      expect(stats.usageEvents).toBe(1);
      expect(stats.statuslessToolResults).toBe(0);
      if (entry.source === "recorded") {
        expect(stats.errors).toBe(0);
        expect(events.find((event) => event.final)?.text).toBe("OK");
      }
      if (name === "write.jsonl") {
        expect(stats.toolCalls).toBeGreaterThan(0);
        expect(stats.toolResults).toBe(stats.toolCalls);
        expect(stats.fileChanges).toBe(1);
      }
    });
  }
});
