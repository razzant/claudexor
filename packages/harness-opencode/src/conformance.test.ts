import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateTypedStream } from "@claudexor/core";
import { parseOpenCodeEvent } from "./parse.js";

const FIXTURES = join(__dirname, "..", "fixtures");

describe("opencode adapter conformance fixtures", () => {
  for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"))) {
    it(`parses ${name} into a conformant typed stream`, () => {
      const events = readFileSync(join(FIXTURES, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => parseOpenCodeEvent(JSON.parse(line), "ses-fixture") ?? []);
      const stats = validateTypedStream(events);
      expect(stats.started).toBeGreaterThan(0);
      expect(stats.toolCalls).toBeGreaterThan(0);
      expect(stats.toolResults).toBeGreaterThan(0);
      expect(stats.statuslessToolResults).toBe(0);
      expect(stats.errorToolResults).toBeGreaterThan(0);
      expect(stats.usageEvents).toBeGreaterThan(0);
    });
  }
});
