import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateTypedStream } from "@claudexor/core";
import { parseCodexEvent } from "./parse.js";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

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
  for (const line of raw.split("\n").filter(Boolean)) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }
    const parsed = parseCodexEvent(obj, "ses-fixture");
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
