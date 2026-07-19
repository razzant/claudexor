import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HarnessEvent } from "@claudexor/schema";
import { createCursorParser } from "./parse.js";

const PLAN_FIXTURES = fileURLToPath(new URL("../fixtures/plan", import.meta.url));

/** Replay a plan-mode fixture through the stateful cursor parser. */
function replayPlan(fixture: string): HarnessEvent[] {
  const parse = createCursorParser("vendor_native", "native_session", true);
  return readFileSync(join(PLAN_FIXTURES, fixture), "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => parse(JSON.parse(line), "ses-plan") ?? []);
}

const isErrorResult = (e: HarnessEvent) => e.type === "tool_result" && e.tool?.status === "error";
const finalMessage = (events: HarnessEvent[]) =>
  events.find((e) => e.type === "message" && e.final === true);

describe("cursor plan-mode createPlan recovery (Defect 1)", () => {
  it("empty planUri + inline args → plan produced from inline content, disclosed", () => {
    const events = replayPlan("plan-empty-uri-inline.jsonl");
    for (const e of events) expect(() => HarnessEvent.parse(e)).not.toThrow();

    // The plan the model actually authored (inline createPlan args) is the
    // final answer — not cursor's thin trailing narration.
    const final = finalMessage(events);
    expect(final?.text).toContain("Change `-` to `+` in add.js");
    expect(final?.text).toContain("Edit add.js operator");
    expect(final?.text).not.toBe("I'll inspect add.js and draft the plan.");
    expect(final?.payload?.["final_source"]).toBe("cursor_plan_inline_args");
    expect(final?.payload?.["plan_recovered"]).toBe(true);

    // Provenance is disclosed, never fabricated as a vendor plan file.
    const disclosure = events.find((e) => e.payload?.["plan_uri_fallback"] === true);
    expect(disclosure?.type).toBe("thinking");
    expect(disclosure?.payload?.["plan_source"]).toBe("cursor_plan_inline_args");

    // The stray read-only probe miss is a disclosed benign thinking, NOT an
    // unrecovered error tool_result that would fail the read-only plan run.
    expect(events.some(isErrorResult)).toBe(false);
    const probe = events.find((e) => e.payload?.["plan_probe_miss"] === true);
    expect(probe?.type).toBe("thinking");
    expect(probe?.text).toContain("File not found");
  });

  it("valid planUri → unchanged (final is the assistant answer, no fallback)", () => {
    const events = replayPlan("plan-valid-uri.jsonl");
    for (const e of events) expect(() => HarnessEvent.parse(e)).not.toThrow();

    const final = finalMessage(events);
    expect(final?.text).toBe("Plan created.");
    expect(final?.payload?.["final_source"]).toBe("assistant_message");
    expect(final?.payload?.["plan_recovered"]).toBeUndefined();
    expect(events.some((e) => e.payload?.["plan_uri_fallback"] === true)).toBe(false);
  });

  it("no planUri and no plan text anywhere → honest failure (no recovered plan)", () => {
    const events = replayPlan("plan-no-plan.jsonl");
    for (const e of events) expect(() => HarnessEvent.parse(e)).not.toThrow();

    // Nothing to recover: no final plan message, no fabricated fallback.
    expect(events.some((e) => e.payload?.["plan_recovered"] === true)).toBe(false);
    expect(events.some((e) => e.payload?.["plan_uri_fallback"] === true)).toBe(false);
    const final = finalMessage(events);
    expect(final?.text?.trim() ?? "").toBe("");
  });

  it("read-only probe misses stay real errors in NON-plan (agent) mode", () => {
    const parse = createCursorParser("vendor_native", "native_session", false);
    const events = [
      parse({ type: "system", subtype: "init", model: "gpt-5" }, "s1"),
      parse(
        {
          type: "tool_call",
          subtype: "started",
          call_id: "r1",
          tool_call: { readToolCall: { args: { path: "missing.ts" } } },
        },
        "s1",
      ),
      parse(
        {
          type: "tool_call",
          subtype: "completed",
          call_id: "r1",
          tool_call: {
            readToolCall: {
              args: { path: "missing.ts" },
              result: { error: { errorMessage: "x" } },
            },
          },
        },
        "s1",
      ),
    ].flatMap((e) => e ?? []);
    expect(events.some(isErrorResult)).toBe(true);
  });
});
