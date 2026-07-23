import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HarnessEvent } from "@claudexor/schema";
import { createClaudeParser } from "./parse.js";

/**
 * D-16c fixture-parity: the SIGNAL-bearing claude 2.1.165 frames (context
 * exhaustion, compaction boundary, the typed rate-limit heartbeat) map onto
 * typed HarnessEvents — never dropped, never prose-matched. These fixtures
 * live in fixtures/signals/ (out of the top-level conformance loop, which
 * asserts tool/usage shapes every fixture must carry).
 */
const SIGNALS = fileURLToPath(new URL("../fixtures/signals", import.meta.url));

function parseFixture(name: string): HarnessEvent[] {
  const parser = createClaudeParser();
  const out: HarnessEvent[] = [];
  let dropped = 0;
  for (const line of readFileSync(`${SIGNALS}/${name}`, "utf8").split("\n").filter(Boolean)) {
    const events = parser(JSON.parse(line), "sig");
    if (events === null) {
      dropped += 1;
      continue;
    }
    for (const ev of events) {
      expect(() => HarnessEvent.parse(ev)).not.toThrow();
      out.push(ev);
    }
  }
  // Every frame in these captures is recognized plumbing or a typed signal:
  // a clean run must never report a dropped event (QA-015).
  expect(dropped).toBe(0);
  return out;
}

describe("claude D-16 signal fixtures", () => {
  it("terminal-prompt-too-long: capacity_exhausted (prompt_too_long), no final answer", () => {
    const events = parseFixture("terminal-prompt-too-long.jsonl");
    const ctx = events.filter((e) => e.type === "context");
    expect(ctx).toHaveLength(1);
    expect(ctx[0]?.context?.kind).toBe("capacity_exhausted");
    expect(ctx[0]?.context?.cause).toBe("prompt_too_long");
    expect(ctx[0]?.context?.native_code).toBe("prompt_too_long");
    // The is_error result prose must NOT become the authoritative final answer.
    expect(events.some((e) => e.type === "message" && e.final === true)).toBe(false);
  });

  it("compact-boundary: compaction_completed carries trigger + pre_tokens; run still completes", () => {
    const events = parseFixture("compact-boundary.jsonl");
    const ctx = events.filter((e) => e.type === "context");
    expect(ctx).toHaveLength(1);
    expect(ctx[0]?.context?.kind).toBe("compaction_completed");
    expect(ctx[0]?.context?.trigger).toBe("auto");
    expect(ctx[0]?.context?.pre_tokens).toBe(153000);
    // A completed run emits its final answer; no capacity exhaustion here.
    expect(ctx.some((e) => e.context?.kind === "capacity_exhausted")).toBe(false);
    expect(events.some((e) => e.type === "message" && e.final === true)).toBe(true);
  });

  it("terminal-completed-rate-limit-event: typed rate_limit heartbeat is recognized, not dropped, and the allowed status arms no signal", () => {
    const events = parseFixture("terminal-completed-rate-limit-event.jsonl");
    // status:"allowed" is a routine heartbeat — recognized (dropped==0 above)
    // but it must NOT emit a rate_limit signal that would arm rotation.
    expect(events.some((e) => e.rate_limit !== undefined)).toBe(false);
    // The 2.1.165 post_turn_summary frame is likewise recognized plumbing.
    expect(events.some((e) => e.type === "context")).toBe(false);
    expect(events.some((e) => e.type === "message" && e.final === true)).toBe(true);
  });

  it("maps a limiting rate_limit_event to a typed rate_limit signal with resets_at", () => {
    const parser = createClaudeParser();
    const out = parser(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1784774400 },
        session_id: "sig",
      },
      "sig",
    );
    expect(out).toHaveLength(1);
    expect(out?.[0]?.type).toBe("status");
    expect(out?.[0]?.rate_limit?.resets_at).toBe(new Date(1784774400 * 1000).toISOString());
    expect(() => HarnessEvent.parse(out?.[0])).not.toThrow();
  });

  it("maps rapid_refill_breaker terminal_reason to the continuation-eligible repeated_refill cause", () => {
    const parser = createClaudeParser();
    const out = parser(
      {
        type: "result",
        subtype: "success",
        is_error: true,
        terminal_reason: "rapid_refill_breaker",
      },
      "sig",
    );
    const ctx = (out ?? []).filter((e) => e.type === "context");
    expect(ctx).toHaveLength(1);
    expect(ctx[0]?.context?.cause).toBe("repeated_refill");
    expect(ctx[0]?.context?.native_code).toBe("rapid_refill_breaker");
  });
});
