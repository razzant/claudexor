import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "@claudexor/event-log";
import { ControlTimelineEvent, type HarnessEvent } from "@claudexor/schema";
import { AnswerAssembly } from "../../core/src/answer-assembly.js";
import { countsAsAgentProgress } from "../../core/src/inactivity.js";
import { createClaudeParser } from "../../harness-claude/src/parse.js";
import { parseCodexEvent } from "../../harness-codex/src/parse.js";
import { codexAppServerEvents } from "../../harness-codex/src/app-server-protocol.js";
import { createCursorParser } from "../../harness-cursor/src/parse.js";
import { harnessEventPayload } from "../../orchestrator/src/runSupport.js";
import {
  createAttemptTelemetry,
  observeAttemptTelemetry,
} from "../../orchestrator/src/attemptTelemetry.js";
import { readRunEventsWithIntegrity, timelineEvents } from "./run-timeline.js";

function runEvents(harnessId: string, events: HarnessEvent[]): Record<string, unknown>[] {
  return events.map((event, index) => ({
    type: "harness.event",
    seq: index + 1,
    payload: harnessEventPayload(harnessId, "a01", event),
  }));
}

describe("timeline text metadata across native parser and event-log projection", () => {
  it("keeps Codex retry text and native evidence without triggering outer retry policy", () => {
    const notifications = readFileSync(
      new URL(
        "../../harness-codex/fixtures/app-server/retry-status-0.156.1.jsonl",
        import.meta.url,
      ),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const notification = notifications[1];
    const token = `sk-ant-${"a".repeat(40)}`;
    notification.params.error.message += ` ${token}`;
    notification.params.error.additionalDetails += ` ${token}`;
    const events = codexAppServerEvents(notification, "retry-session", {})!;
    expect(events).toHaveLength(1);
    const telemetry = createAttemptTelemetry("auto", false);
    observeAttemptTelemetry(telemetry, events[0]!);
    expect(telemetry.transientFailures).toEqual([]);
    expect(telemetry.rateLimits).toEqual([]);
    expect(countsAsAgentProgress(events[0]!)).toBe(false);

    const projected = runEvents("codex", events);
    const payload = projected[0]!["payload"] as Record<string, unknown>;
    expect(payload["status"]).toEqual({ kind: "api_retry" });
    expect(payload["payload"]).toMatchObject({
      willRetry: true,
      threadId: "thread-retry-fixture",
      turnId: "turn-retry-fixture",
      error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 403 } } },
    });
    expect(JSON.stringify(projected)).not.toContain(token);
    expect(JSON.stringify(payload["payload"])).toContain("[redacted]");
    const rows = timelineEvents({}, projected);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "Reconnecting... 1/5 [redacted]",
      detail: "Reconnecting... 1/5 [redacted]",
      severity: "info",
      textKind: null,
      textDelta: false,
      errorSummary: null,
    });
  });

  it("projects Cursor fragments, tool boundaries, and complete messages distinctly", () => {
    const parse = createCursorParser();
    const native = readFileSync(
      new URL("../../harness-cursor/fixtures/stream/text-deltas.jsonl", import.meta.url),
      "utf8",
    );
    const events = native
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => parse(JSON.parse(line), "s1") ?? []);
    const rows = timelineEvents({}, runEvents("cursor", events));
    expect(rows.slice(1, 5).map((row) => [row.textKind, row.textDelta, row.detail])).toEqual([
      ["thinking", true, "UX and inter"],
      ["thinking", true, "action"],
      ["thinking", true, " "],
      ["thinking", true, "plan · with authored punctuation.\n"],
    ]);
    expect(rows.slice(5, 7).map((row) => [row.textKind, row.textDelta, row.toolName])).toEqual([
      [null, false, "read"],
      [null, false, "read"],
    ]);
    expect(
      rows.filter((row) => row.textKind === "message").map((row) => [row.textDelta, row.detail]),
    ).toEqual([
      [true, "Final"],
      [true, " answer."],
      [false, "Final answer."],
      [false, "Final answer."],
    ]);
    expect(rows.every((row) => row.harnessId === "cursor" && row.attemptId === "a01")).toBe(true);
  });

  it("does not turn complete Claude or Codex blocks into text fragments", () => {
    const claude = createClaudeParser();
    const claudeEvents = claude(
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "A complete thought." },
            { type: "text", text: "A complete message." },
          ],
        },
      },
      "s1",
    )!;
    const codexEvents = [
      { type: "reasoning", text: "A complete thought." },
      { type: "agent_message", text: "A complete message." },
    ].flatMap((item) => parseCodexEvent({ type: "item.completed", item }, "s2") ?? []);
    for (const [harness, events] of [
      ["claude", claudeEvents],
      ["codex", codexEvents],
    ] as const) {
      const rows = timelineEvents({}, runEvents(harness, events));
      expect(rows.map((row) => [row.textKind, row.textDelta, row.detail])).toEqual([
        ["thinking", false, "A complete thought."],
        ["message", false, "A complete message."],
      ]);
    }
  });

  it("preserves existing Claude text deltas through the same harness-neutral projection", () => {
    const parse = createClaudeParser();
    const events = ["cla", "ude", " ", "text"].flatMap(
      (text) =>
        parse(
          {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text } },
          },
          "s1",
        ) ?? [],
    );
    const rows = timelineEvents({}, runEvents("claude", events));
    expect(rows.every((row) => row.textKind === "message" && row.textDelta)).toBe(true);
    expect(rows.map((row) => row.detail).join("")).toBe("claude text");
  });

  it("carries Claude speech keys, the CLI's abandon marker and the unkeyed final from native frames through events.jsonl to timeline rows (issue1698)", () => {
    const parse = createClaudeParser();
    const native = readFileSync(
      new URL("../../harness-claude/fixtures/recorded-partial-replay.jsonl", import.meta.url),
      "utf8",
    );
    const events = native
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => parse(JSON.parse(line), "s1") ?? []);
    const dir = mkdtempSync(join(tmpdir(), "claude-speech-chain-"));
    try {
      // The orchestrator's journaling path: one harness.event per normalized event.
      const log = new EventLog(join(dir, "events.jsonl"), "run-speech", "task-speech");
      for (const event of events)
        log.emit("harness.event", harnessEventPayload("claude", "a01", event));
      log.dispose();
      const read = readRunEventsWithIntegrity({ runDir: dir });
      const journaled = read.events.map((ev) => ev["payload"] as Record<string, unknown>);
      const final = journaled.find((payload) => payload["final"] === true)!;
      expect(final["speech"]).toBeUndefined();
      expect((final["payload"] as Record<string, unknown>)["final_source"]).toBe("result");
      const marker = journaled.find(
        (payload) => (payload["speech"] as { op?: string } | undefined)?.op === "abandoned",
      )!;
      expect(marker["type"]).toBe("status");
      expect(marker["payload"]).toEqual({ code: "speech_abandoned", from_block_index: 0 });

      const rows = timelineEvents({ runDir: dir }, read.events, read.integrity);
      const names = new Map<string, string>();
      const label = (key: string | null) => {
        if (key === null) return null;
        if (!names.has(key)) names.set(key, `K${names.size + 1}`);
        return names.get(key);
      };
      expect(
        rows
          .filter((row) => row.textKind === "message" || row.speechOp !== null)
          .map((row) => [
            row.textKind,
            row.textDelta,
            label(row.speechKey),
            row.speechOp,
            row.textFinal,
            row.detail,
          ]),
      ).toEqual([
        ["message", true, "K1", "fragment", false, "Checking"],
        ["message", true, "K1", "fragment", false, " the"],
        [null, false, "K1", "abandoned", false, "streamed text abandoned by the CLI"],
        ["message", true, "K2", "fragment", false, "Checking"],
        ["message", true, "K2", "fragment", false, " the"],
        ["message", true, "K2", "fragment", false, " file first."],
        ["message", false, "K2", "complete", false, "Checking the file first."],
        ["message", true, "K3", "fragment", false, "The file"],
        ["message", true, "K3", "fragment", false, " does not exist."],
        ["message", false, "K3", "complete", false, "The file does not exist."],
        ["message", false, null, null, true, "The file does not exist."],
      ]);
      expect(
        rows
          .filter((row) => row.textKind === null && row.speechOp === null)
          .every((row) => row.speechKey === null && row.textFinal === false),
      ).toBe(true);

      // The answer consumer still takes the typed final verbatim.
      const answer = new AnswerAssembly();
      for (const event of events) answer.observe(event);
      expect(answer.hasFinal()).toBe(true);
      expect(answer.text()).toBe("The file does not exist.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps full exact text in detail when the title is abbreviated", () => {
    const text = `  ${"word ".repeat(130)}\n`;
    const rows = timelineEvents(
      {},
      runEvents("cursor", [{ type: "thinking", session_id: "s1", ts: "t", text }]),
    );
    expect(rows[0]?.title).toHaveLength(500);
    expect(rows[0]?.detail).toBe(text);
    expect(rows[0]?.textKind).toBe("thinking");
    expect(rows[0]?.textDelta).toBe(false);

    const secret = `sk-ant-${"a".repeat(40)}`;
    const redacted = timelineEvents(
      {},
      runEvents("claude", [
        { type: "message", session_id: "s1", ts: "t", text: `value ${secret} end` },
      ]),
    );
    expect(redacted[0]?.detail).toBe(`value ${secret} end`);
  });

  it("leaves legacy and non-text rows separate even when they carry incidental delta fields", () => {
    const rows = timelineEvents({}, [
      { type: "harness.event", payload: { title: "legacy text" } },
      { type: "harness.event", payload: { type: "thinking", title: "legacy title only" } },
      {
        type: "harness.event",
        payload: { type: "status", text: "working", payload: { delta: true } },
      },
      {
        type: "other.event",
        payload: { type: "thinking", text: "not a harness text event", payload: { delta: true } },
      },
    ]);
    expect(rows.every((row) => row.textKind === null && row.textDelta === false)).toBe(true);
    const legacy = ControlTimelineEvent.parse({ type: "harness.event", title: "old row" });
    expect(legacy.textKind).toBeNull();
    expect(legacy.textDelta).toBe(false);
    expect([legacy.speechKey, legacy.speechOp, legacy.textFinal]).toEqual([null, null, false]);
    // Only a well-formed typed speech projects; finality is a text-row fact.
    const odd = timelineEvents({}, [
      {
        type: "harness.event",
        payload: {
          type: "status",
          text: "working",
          speech: { key: "k", op: "merge" },
          final: true,
        },
      },
      {
        type: "harness.event",
        payload: { type: "message", text: "x", speech: { key: "", op: "fragment" } },
      },
    ]);
    expect(odd.map((row) => [row.speechKey, row.speechOp, row.textFinal])).toEqual([
      [null, null, false],
      [null, null, false],
    ]);
  });

  it("preserves timeline omission markers as non-text boundaries", () => {
    const events = runEvents(
      "cursor",
      Array.from({ length: 502 }, () => ({
        type: "thinking" as const,
        session_id: "s1",
        ts: "t",
        text: "x",
        payload: { delta: true },
      })),
    );
    const rows = timelineEvents({}, events, {
      absent: false,
      unreadable: false,
      malformedLines: 1,
      nonObjectLines: 0,
    });
    expect(rows.slice(0, 2).map((row) => [row.type, row.textKind, row.textDelta])).toEqual([
      ["timeline.evidence_incomplete", null, false],
      ["timeline.truncated", null, false],
    ]);
    expect(rows[0]?.title).toContain("1 malformed");
    expect(rows[1]?.title).toContain("2 earlier event(s)");
    expect(rows.slice(2)).toHaveLength(500);
  });
});
