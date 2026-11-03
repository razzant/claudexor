import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "@claudexor/schema";
import { HarnessEvent as EventSchema, RunEvent } from "@claudexor/schema";
import { createAgyNativeCompletion } from "./native-completion.js";
import { parseAgyEvent } from "./parse.js";

// Sanitized minimal vendor diagnostic retained from an observed zero-exit
// AGY headless turn. No operator paths, account names, work orders or tool ids.
const diagnostic =
  'jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. read_file(<target>)).';
const event = (value: Partial<HarnessEvent>): HarnessEvent => ({
  type: "completed",
  session_id: "test",
  ts: "2026-10-15T00:00:00Z",
  ...value,
});
async function replay(events: HarnessEvent[]) {
  const out = [];
  for await (const e of createAgyNativeCompletion().wrap(
    (async function* () {
      yield* events;
    })(),
  ))
    out.push(EventSchema.parse(e));
  return out;
}
describe("AGY native permission evidence", () => {
  it("replays the native completion from the sanitized historical normalized recording", async () => {
    const rows = readFileSync(
      new URL("./test-support/normalized/headless-permission-denial.jsonl", import.meta.url),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => RunEvent.parse(JSON.parse(line)));
    expect(rows.map((row) => row.seq)).toEqual([20, 21, 22, 23]);
    // Historical error prose is evidence of what the old adapter said, not
    // today's classifier. Raw vendor stdout was not retained for this capture.
    expect(rows[0]!.payload["title"]).toContain("commonly a vendor soft-deny");
    const completion = EventSchema.parse(rows[2]!.payload);
    const out = await replay([completion]);
    expect(out[0]).toMatchObject({
      type: "error",
      permission_denial: { permission: "read_file", source: "agy_native_stderr" },
    });
    expect(out.at(-1)).toMatchObject({ type: "completed", payload: { exit_code: 0 } });
    expect(rows[3]!.payload["retry"]).toBe(1); // old behavior, not a current retry expectation
  });
  it.each([false, undefined])(
    "does not promote narration (final=%s) over a native denial",
    async (final) => {
      const out = await replay([
        event({ type: "message", text: "I will read the requested file.", final }),
        event({ payload: { stderr_tail: diagnostic, exit_code: 0 } }),
      ]);
      expect(out[1]).toMatchObject({
        type: "error",
        permission_denial: { permission: "read_file" },
      });
      expect(out.some((e) => e.type === "message" && e.final)).toBe(false);
    },
  );
  it("classifies only the native diagnostic, not empty output or model prose", async () => {
    for (const text of [
      "",
      "no output produced",
      "permission denied",
      "Some tool required permission",
    ]) {
      const out = await replay([event({ payload: { stderr_tail: text, exit_code: 0 } })]);
      expect(out.some((e) => e.permission_denial)).toBe(false);
    }
    const prose = await replay([
      event({ type: "message", text: diagnostic, final: true }),
      event({}),
    ]);
    expect(prose.some((e) => e.permission_denial)).toBe(false);
    const out = await replay([event({ payload: { stderr_tail: diagnostic, exit_code: 0 } })]);
    expect(out[0]).toMatchObject({
      type: "error",
      permission_denial: { permission: "read_file", source: "agy_native_stderr" },
    });
    expect(out.at(-1)!.type).toBe("completed");
    expect(out[0]).not.toHaveProperty("tool");
  });
  it("threads the try's voiced vendor failure onto the ONE completed (zero exit included)", async () => {
    const vendor = { code: "ERROR", message: "words", source: "agy_result" };
    const errored = event({ type: "error", error: "words", payload: { vendor_failure: vendor } });
    const out = await replay([
      errored,
      event({ payload: { exit_code: 0, harness_reported_error: true } }),
    ]);
    expect(out.filter((e) => e.type === "completed")).toHaveLength(1);
    expect(out.filter((e) => e.type === "error")).toHaveLength(1);
    expect(out.at(-1)).toMatchObject({
      type: "completed",
      payload: { exit_code: 0, harness_reported_error: true, vendor_failure: vendor },
    });
    for (const completed of [
      event({ aborted: true, payload: { exit_code: 0, harness_reported_error: true } }),
      event({ payload: { exit_signal: "SIGKILL", harness_reported_error: true } }),
      event({ payload: { exit_code: 0 } }),
    ]) {
      const kept = await replay([errored, completed]);
      expect(kept.at(-1)!.payload?.["vendor_failure"]).toBeUndefined();
    }
    // A later typed final supersedes the earlier failure.
    const superseded = await replay([
      errored,
      event({ type: "message", text: "answer", final: true }),
      event({ payload: { exit_code: 0, harness_reported_error: true } }),
    ]);
    expect(superseded.at(-1)!.payload?.["vendor_failure"]).toBeUndefined();
  });

  it("a stream without its terminal result is one honest error; aborted or already-failed tries get none", async () => {
    const fragment = event({ type: "message", text: "partial", payload: { delta: true } });
    const out = await replay([fragment, event({ payload: { exit_code: 0 } })]);
    expect(out.map((e) => e.type)).toEqual(["message", "error", "completed"]);
    expect(out[1]!.error).toContain("agy ended without its terminal result");
    expect(out[1]).not.toHaveProperty("permission_denial");
    for (const ended of [
      [fragment, event({ aborted: true })],
      [fragment, event({ payload: { aborted: true } })],
      [fragment, event({ type: "error", error: "exited 1" }), event({ payload: { exit_code: 1 } })],
      [event({ type: "message", text: "final", final: true }), event({})],
    ]) {
      const kept = await replay(ended);
      expect(
        kept.filter((e) => e.type === "error" && e.error?.includes("terminal result")),
      ).toHaveLength(0);
    }
  });

  it("retains a later/partial answer and the refusal without claiming that the tool succeeded", async () => {
    const answer = event({ type: "message", text: "A useful partial answer", final: true });
    const out = await replay([
      answer,
      event({ payload: { stderr_tail: diagnostic, exit_code: 0 } }),
    ]);
    expect(out[0]).toMatchObject(answer);
    expect(out[1]).toMatchObject({
      type: "status",
      permission_denial: { permission: "read_file" },
    });
    expect(out.some((e) => e.type === "error")).toBe(false);
  });
  it("does not fabricate a successful read or file change from DONE without output", () => {
    const out = parseAgyEvent(
      {
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "DONE",
          tool_info: { name: "view_file", parameters: { TargetFile: "/fixture/input.md" } },
        },
      },
      "test",
    )!;
    expect(out).toMatchObject([{ type: "status", payload: { native_tool_state: "DONE" } }]);
    expect(out.some((e) => e.type === "tool_result" || e.type === "file_change")).toBe(false);
  });
  it("keeps DONE with actual read/write output as successful tool evidence", () => {
    for (const name of ["view_file", "write_to_file"]) {
      const out = parseAgyEvent(
        {
          event: "step_update",
          step_update: {
            step_type: "tool",
            state: "DONE",
            tool_info: {
              name,
              parameters: { TargetFile: "/fixture/input.md" },
              output: "actual tool output",
            },
          },
        },
        "test",
      )!.map((e) => EventSchema.parse(e));
      expect(out[0]).toMatchObject({
        type: "tool_result",
        tool: { name, status: "ok", content_summary: "actual tool output" },
      });
      expect(out.filter((e) => e.type === "file_change")).toEqual(
        name === "write_to_file"
          ? [expect.objectContaining({ payload: { path: "/fixture/input.md", tool: name } })]
          : [],
      );
      expect(out.some((e) => e.type === "status" || e.type === "error")).toBe(false);
    }
  });
});

describe("AGY explicit not-retryable record (vendor stderr `AGY_ERROR` line)", () => {
  // Neutral synthetic records in the vendor's documented shape; no recorded words or ids.
  const record = (fields: Record<string, unknown>) => `AGY_ERROR: ${JSON.stringify(fields)}`;
  const failed = (stderr_tail: string, extra: Record<string, unknown> = {}) => [
    event({ type: "error", error: "agy terminal status ERROR" }),
    event({ payload: { stderr_tail, exit_code: 3, harness_reported_error: true, ...extra } }),
  ];
  const refusals = (out: HarnessEvent[]) => out.filter((e) => e.request_refusal);

  it("an explicit retryable:false on a failed try is the vendor's typed refusal", async () => {
    const out = await replay(
      failed(
        `warning: earlier line\n${record({ short_error: "fixture refusal words", retryable: false, error_id: "fixture-id-1" })}`,
      ),
    );
    expect(refusals(out)).toEqual([
      expect.objectContaining({
        type: "error",
        error: "agy marked the failed request not retryable: fixture refusal words",
        request_refusal: {
          kind: "vendor_not_retryable",
          source: "agy_stderr",
          error_id: "fixture-id-1",
        },
      }),
    ]);
    expect(out.at(-1)).toMatchObject({ type: "completed", payload: { exit_code: 3 } });
  });

  /** Live stderr lines, then the try's completion with its replayed `tail`. */
  async function live(lines: readonly string[], tail = "") {
    const completion = createAgyNativeCompletion();
    for (const line of lines) completion.observeStderr(line);
    const out = [];
    for await (const e of completion.wrap(
      (async function* () {
        yield* failed(tail);
      })(),
    ))
      out.push(e);
    return refusals(out);
  }
  const no = record({ short_error: "x", retryable: false });
  const yes = record({ short_error: "x", retryable: true });
  const unreadable = 'AGY_ERROR: {"short_error":"x","retryable":false';

  it("the last line with the marker decides, read live or from the replayed tail", async () => {
    expect(await live([no, yes])).toEqual([]);
    expect(await live([yes, no])).toHaveLength(1);
    expect(await replay(failed(`${yes}\n${no}`)).then(refusals)).toHaveLength(1);
    expect(await replay(failed(`${no}\n${yes}`)).then(refusals)).toEqual([]);
  });

  it("a later unreadable record makes the verdict unknown; other lines change nothing", async () => {
    // Live, and in the replayed tail: an earlier `false` does not survive it.
    expect(await live([no, unreadable])).toEqual([]);
    expect(await live([no, "AGY_ERROR: [false]"])).toEqual([]);
    expect(await replay(failed(`${no}\n${unreadable}`)).then(refusals)).toEqual([]);
    // Lines without the marker after it, live or replayed, keep the refusal.
    expect(await live([no, "warning: retrying later", "_ERROR: {}"])).toHaveLength(1);
    expect(await replay(failed(`${no}\nwarning: unrelated line`)).then(refusals)).toHaveLength(1);
    // A replayed tail whose lines lost the marker (cut) or hold no record keeps
    // the live verdict, either way.
    expect(await live([no], "...rror: {}\nwarning")).toHaveLength(1);
    expect(await live([yes], "warning only")).toEqual([]);
    // The same last record seen live and again in the tail counts once.
    expect(await live([no], no)).toHaveLength(1);
  });

  it.each([
    ["retryable true", record({ short_error: "x", retryable: true })],
    ["no retryable field (the minimal form)", record({ short_error: "x" })],
    ["a non-boolean retryable", record({ short_error: "x", retryable: "false" })],
    ["malformed JSON", 'AGY_ERROR: {"short_error":"x","retryable":false'],
    ["a cut tail without the marker", '_ERROR: {"short_error":"x","retryable":false}'],
    ["an array", "AGY_ERROR: [false]"],
    ["text after the marker on another word", `note ${record({ retryable: false })}`],
  ])("%s decides nothing", async (_label, line) => {
    expect(refusals(await replay(failed(line)))).toEqual([]);
  });

  it("is read only from stderr of a try that voiced its failure, never from model text", async () => {
    const line = record({ short_error: "x", retryable: false });
    // Model text carrying the same line is answer material, not a vendor record.
    expect(
      refusals(
        await replay([
          event({ type: "message", text: line, final: true }),
          event({ payload: { exit_code: 0 } }),
        ]),
      ),
    ).toEqual([]);
    // A warning the session continued past (no voiced error), an abort, a signal kill.
    for (const payload of [
      { stderr_tail: line, exit_code: 0 },
      { stderr_tail: line, exit_code: 3, harness_reported_error: true, aborted: true },
      { stderr_tail: line, harness_reported_error: true, exit_signal: "SIGKILL" },
    ])
      expect(refusals(await replay([event({ payload })]))).toEqual([]);
  });
});
