/** The in-run packet's retained output reads the run log's own projection:
 * exact fragments per physical session, rejected sessions excluded, earlier
 * good tries kept, unreadable records disclosed, constrained machine truth
 * kept. Scripted fake harness through the real Orchestrator (no vendor). */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnswerAssembly, CONTINUITY_IDENTITY_MISMATCH_CODE } from "@claudexor/core";
import { RetainedAttemptOutput } from "./inrun-retained-output.js";
import { crash, run, seedSession } from "./inrun-continuity.test-support.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const row = (seq: number, attempt: string, session: string, text: string, delta = true) =>
  JSON.stringify({
    seq,
    ts: "2026-11-02T00:00:00.000Z",
    run_id: "run-1",
    task_id: "task-1",
    type: "harness.event",
    payload: {
      attempt_id: attempt,
      harness_id: "agy",
      session_id: session,
      type: "message",
      text,
      ...(delta ? { payload: { delta: true } } : {}),
    },
  });

describe("RetainedAttemptOutput (journal projection)", () => {
  it("keeps this attempt's sessions exact, drops only rejected ones, and discloses unreadable records", () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-retained-attempt-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "events.jsonl"),
      [
        row(1, "a01", "ses-good", " leading space"),
        row(2, "a01", "ses-good", "\n"),
        row(3, "a01", "ses-good", "ha"),
        row(4, "a01", "ses-good", "ha"),
        "{not json",
        row(5, "a01", "ses-rejected", "words of the wrong thread"),
        row(6, "a02", "ses-other-attempt", "another attempt"),
        row(7, "a01", "ses-later", "later try  "),
      ].join("\n") + "\n",
    );
    const output = new RetainedAttemptOutput(dir, "a01");
    output.add("ses-good", new AnswerAssembly(), "not_applicable");
    output.add("ses-rejected", new AnswerAssembly(), "mismatch_after_possible_effects");
    output.add("ses-later", new AnswerAssembly(), "matched_before_effects");
    const text = output.text();
    expect(text).toContain("\n\n leading space\nhaha\n");
    // The last fragment keeps its trailing whitespace: bytes, not a trimmed copy.
    expect(text).toContain("\n\nlater try  \n");
    expect(text).toContain("Session: `ses-good`");
    expect(text).toContain("Session: `ses-later`");
    expect(text).not.toContain("wrong thread");
    expect(text).not.toContain("another attempt");
    expect(text).toContain("Source log has 1 unreadable record(s); this is incomplete evidence.");
  });

  it("adds a constrained final's machine truth that its display copy does not show", () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-retained-attempt-"));
    dirs.push(dir);
    writeFileSync(join(dir, "events.jsonl"), "");
    const envelope = JSON.stringify({
      work_report: { state: "completed", required_inputs: [] },
      output: "",
    });
    const answer = new AnswerAssembly();
    answer.observe({
      type: "message",
      text: "",
      final: true,
      payload: { work_report_envelope: envelope },
    });
    const output = new RetainedAttemptOutput(dir, "a01");
    output.add("ses-1", answer, "not_applicable");
    expect(output.text()).toBe(`Machine-readable final of session \`ses-1\`:\n\n${envelope}`);
  });
});

describe("in-run packet carries the journal projection (scripted fake harness)", () => {
  it("identity mismatch after good text: the packet keeps the good try and drops the rejected session", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a"],
      maxRetries: 3,
      script: function* ({ spec, emit, resume, tryOfProfile }) {
        if (tryOfProfile === 1) {
          seedSession(spec.cwd, "a", "sid-A");
          yield emit({ type: "started", payload: { native_session_id: "sid-A" } });
          yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
          yield emit({ type: "message", text: "good ", payload: { delta: true } });
          yield emit({ type: "message", text: " text\n", payload: { delta: true } });
          yield* crash(emit);
          return;
        }
        if (tryOfProfile === 2) {
          expect(resume).toBe("sid-A");
          yield emit({ type: "message", text: "words of the wrong thread" });
          yield emit({
            type: "error",
            error: "recovered thread differs",
            payload: { code: CONTINUITY_IDENTITY_MISMATCH_CODE },
          });
          yield emit({ type: "completed" });
          return;
        }
        expect(resume).toBeNull();
        yield emit({ type: "started", payload: { native_session_id: "sid-P" } });
        yield emit({ type: "message", text: "finished", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
    expect(o.receipts.map((r) => r["carrier"])).toEqual(["native", "packet"]);
    const packet = o.spawns[2]!.prompt;
    expect(packet).toContain("good  text\n");
    expect(packet).not.toContain("wrong thread");
    expect(packet).toContain(
      `- Complete retained assistant output: ${join(o.attemptDir!, "continuation", "retained-output-try2.md")}`,
    );
  });

  it("an errored try's constrained envelope final stays in the packet (machine truth control)", async () => {
    const envelope = JSON.stringify({
      work_report: { state: "completed", required_inputs: [] },
      output: "",
    });
    const o = await run({
      mode: "agent",
      profiles: ["a"],
      continuity: null,
      script: function* ({ emit, tryOfProfile }) {
        if (tryOfProfile === 1) {
          yield emit({ type: "started" });
          yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
          yield emit({
            type: "message",
            text: "",
            final: true,
            payload: { work_report_envelope: envelope },
          });
          yield* crash(emit);
          return;
        }
        yield emit({ type: "started" });
        yield emit({ type: "message", text: "finished", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(o.receipts.map((r) => r["carrier"])).toEqual(["packet"]);
    expect(o.spawns[1]!.prompt).toContain(envelope);
  });

  it("a delta-only try of another adapter now reaches the packet as its exact text (cross-adapter evidence change)", async () => {
    const o = await run({
      mode: "ask",
      profiles: ["a"],
      continuity: null,
      script: function* ({ emit, tryOfProfile }) {
        if (tryOfProfile === 1) {
          yield emit({ type: "started" });
          yield emit({ type: "tool_call", tool: { name: "Grep", kind: "search", target: "x" } });
          yield emit({ type: "message", text: "cross ", payload: { delta: true } });
          yield emit({ type: "message", text: "adapter\n", payload: { delta: true } });
          yield* crash(emit);
          return;
        }
        yield emit({ type: "started" });
        yield emit({ type: "message", text: "finished", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(o.receipts.map((r) => r["carrier"])).toEqual(["packet"]);
    expect(o.spawns[1]!.prompt).toContain("cross adapter\n");
    expect(o.spawns[1]!.prompt).not.toContain("(no output retained)");
  });

  it("a whitespace-only fragment between tools stays an exact block in the packet and its complete file", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a"],
      continuity: null,
      script: function* ({ emit, tryOfProfile }) {
        if (tryOfProfile === 1) {
          yield emit({ type: "started" });
          for (const text of ["left", " \n", "right"]) {
            yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
            yield emit({ type: "message", text, payload: { delta: true } });
          }
          yield* crash(emit);
          return;
        }
        yield emit({ type: "started" });
        yield emit({ type: "message", text: "finished", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(o.receipts.map((r) => r["carrier"])).toEqual(["packet"]);
    const prompt = o.spawns[1]!.prompt;
    const file = prompt.match(/- Complete retained assistant output: ([^\n]+)/)?.[1];
    // The in-prompt section is a bounded display (its blank-line runs folded);
    // the complete file beside the index holds the exact projection.
    expect(prompt).toMatch(/\n\nleft\n\n### Streamed text · events \d+–\d+\n\n \n/);
    expect(readFileSync(file!, "utf8")).toMatch(
      /\n\nleft\n\n### Streamed text · events \d+–\d+\n\n \n\n\n### Streamed text · events \d+–\d+\n\nright\n/,
    );
  });
});
