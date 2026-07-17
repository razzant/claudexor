import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateTypedStream } from "@claudexor/core";
import { createCursorParser } from "./parse.js";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

describe("cursor adapter conformance fixtures", () => {
  for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"))) {
    it(`parses ${name} into a conformant typed stream`, () => {
      const parse = createCursorParser();
      const events = readFileSync(join(FIXTURES, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => parse(JSON.parse(line), "ses-fixture") ?? []);
      const stats = validateTypedStream(events);
      expect(stats.started).toBeGreaterThan(0);
      expect(stats.toolCalls).toBeGreaterThan(0);
      expect(stats.toolResults).toBeGreaterThan(0);
      expect(stats.statuslessToolResults).toBe(0);
      expect(stats.errorToolResults).toBeGreaterThan(0);
      expect(stats.usageEvents).toBeGreaterThan(0);
      if (name.startsWith("session-resume")) {
        // v0.9 contract: the native session id is surfaced for thread resume.
        const started = events.find((e) => (e as { type?: string }).type === "started") as
          { payload?: Record<string, unknown> } | undefined;
        expect(started?.payload?.["native_session_id"]).toBeTruthy();
      }
    });
  }
});
