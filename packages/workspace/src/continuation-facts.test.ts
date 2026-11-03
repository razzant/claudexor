import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  continuationRefusal,
  RunResumable,
  RunTelemetry,
  SCHEMA_VERSION,
  type RunContinuityReceipt,
  type RunEvent,
} from "@claudexor/schema";
import { readContinuationEvidence, unrepresentedOutput } from "./continuation-evidence.js";
import { retainedOutput } from "@claudexor/event-log";
import {
  addExecutionEvent,
  continuedTryStarted,
  copyExecutionFold,
  emptyExecutionFold,
  executionFactsOf,
  recordedSessionMemory,
  runExecutionFacts,
  uncoveredAttempts,
} from "./continuation-facts.js";

const roots: string[] = [];
afterEach(
  () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  0,
); // synchronous removal: no deadline (#376, see vitest.setup.ts)

let seq = 0;
const row = (type: string, payload: Record<string, unknown>): RunEvent =>
  ({ seq: seq++, ts: "t", run_id: "r", task_id: "k", type, payload }) as RunEvent;
const started = (attempt: string, session: string, native?: string) =>
  row("harness.event", {
    attempt_id: attempt,
    session_id: session,
    type: "started",
    ...(native ? { payload: { native_session_id: native } } : {}),
  });
const receipt = (
  attempt: string,
  session: string,
  over: Partial<RunContinuityReceipt> = {},
): RunEvent =>
  row("run.continuity", {
    attempt_id: attempt,
    session_id: session,
    receipt: {
      tryIndex: 0,
      attemptId: attempt,
      carrier: "native",
      cause: "transport",
      from: { runId: "p", attemptId: "a01", profileId: null },
      to: { profileId: null },
      workspace: "same_root",
      memory: "full",
      instructions: "as_sent",
      reingestedTokens: null,
      observedModel: null,
      modelMismatch: null,
      identityCheck: "matched_before_effects",
      inputDelivery: "confirmed",
      ...over,
    },
  });

describe("recorded execution facts", () => {
  it("joins a receipt to its own start by attempt, process session and order", () => {
    const facts = runExecutionFacts([
      started("a01", "s0", "sid-A"),
      receipt("a01", "s0", { identityCheck: "mismatch_before_effects" }),
      started("a01", "s1", "sid-B"),
      receipt("a01", "s1", { tryIndex: 1, carrier: "packet", memory: "partial" }),
      // A later start of the same attempt cannot claim an earlier receipt.
      receipt("a02", "s2"),
      started("a02", "s2", "sid-C"),
    ]);
    expect(facts.attempts).toEqual(["a01", "a02"]);
    expect(facts.accepted.map((start) => start.nativeSessionId)).toEqual(["sid-B", "sid-C"]);
    expect(facts.receiptOf(facts.accepted[1]!)).toBeNull();
    expect(continuedTryStarted(facts)).toBe(true);
    expect(continuedTryStarted(facts, true)).toBe(false);
  });

  it("a fallback's first try proves delivery; a reviewer start without a receipt proves nothing", () => {
    const fallback = runExecutionFacts([
      receipt("a01", "s0"),
      started("a01-fb", "s1", "sid-FB"),
      receipt("a01-fb", "s1", { carrier: "packet", memory: "partial" }),
    ]);
    expect(continuedTryStarted(fallback, true)).toBe(true);
    const reviewer = runExecutionFacts([started("rev1", "r0"), receipt("a01", "s0")]);
    expect(continuedTryStarted(reviewer)).toBe(false);
  });

  it("history quality follows the chosen session's own record and never guesses", () => {
    const facts = runExecutionFacts([
      started("a01", "s0", "sid-A"),
      started("a01", "s1", "sid-P"),
      receipt("a01", "s1", { tryIndex: 1, carrier: "packet", memory: "partial" }),
      started("a01-fb", "s2", "sid-FB"),
    ]);
    const held = (attemptId: string, nativeSessionId: string) => ({ attemptId, nativeSessionId });
    expect(recordedSessionMemory(facts, held("a01", "sid-A"), false)).toBe("full");
    expect(recordedSessionMemory(facts, held("a01", "sid-A"), true)).toBe("unknown");
    expect(recordedSessionMemory(facts, held("a01", "sid-P"), false)).toBe("partial");
    // A later attempt's own session without a receipt has no recorded origin.
    expect(recordedSessionMemory(facts, held("a01-fb", "sid-FB"), false)).toBe("unknown");
    expect(recordedSessionMemory(facts, held("a09", "sid-missing"), false)).toBe("unknown");
    // A seeded native first try that never started keeps its receipt's recorded memory.
    const seeded = runExecutionFacts([receipt("a01", "s0", { memory: "partial" })]);
    expect(recordedSessionMemory(seeded, held("a01", "sid-seeded"), true)).toBe("partial");
  });
});

describe("execution facts folded event by event (a bounded detail fold)", () => {
  const events = [
    started("a01", "s0", "sid-A"),
    receipt("a01", "s0", { identityCheck: "mismatch_before_effects" }),
    started("a01", "s1", "sid-B"),
    row("harness.event", { attempt_id: "a01", session_id: "s1", type: "tool_call" }),
    receipt("a01", "s1", { tryIndex: 1, carrier: "packet", memory: "partial" }),
    started("a02", "s2", "sid-C"),
  ];

  it("equal the batch facts, also when a copy continues from a kept prefix", () => {
    const batch = runExecutionFacts(events);
    const prefix = emptyExecutionFold();
    events.slice(0, 3).forEach((event) => addExecutionEvent(prefix, event));
    const continued = copyExecutionFold(prefix);
    events.slice(3).forEach((event) => addExecutionEvent(continued, event));
    const folded = executionFactsOf(continued);
    expect(folded.attempts).toEqual(batch.attempts);
    expect([...folded.progressed]).toEqual([...batch.progressed]);
    expect(folded.accepted).toEqual(batch.accepted);
    expect(folded.receipts).toEqual(batch.receipts);
    expect(folded.recordedWork).toBe(batch.recordedWork);
    // The kept prefix itself is unchanged by the continuation.
    expect(executionFactsOf(prefix).attempts).toEqual(["a01"]);
  });

  it("record own work exactly when the retained-output projection or a tool call or edit would", () => {
    const say = (text: string, extra: Record<string, unknown> = {}) =>
      row("harness.event", { attempt_id: "a01", session_id: "s", type: "message", text, ...extra });
    const cases: RunEvent[][] = [
      [say("finding")],
      [say("   ")],
      [say("switched", { payload: { auth_switched: true } })],
      [row("run.failed", {}), say("after the terminal row")],
      [row("output.ready", { kind: "artifact", path: "attempts/a01/produced/report.md" })],
      [row("output.ready", { kind: "artifact", path: "final/answer.md" })],
      [row("harness.event", { attempt_id: "a01", session_id: "s", type: "file_change" })],
      [started("a01", "s", "sid")],
    ];
    for (const rows of cases) {
      const actions = rows.some(
        (event) =>
          event.type === "harness.event" &&
          ["tool_call", "file_change"].includes(String(event.payload["type"])),
      );
      expect(runExecutionFacts(rows).recordedWork).toBe(retainedOutput(rows) !== null || actions);
    }
  });
});

describe("recorded output that what a run carries forward does not represent", () => {
  const say = (attempt: string, session: string, text: string) =>
    row("harness.event", { attempt_id: attempt, session_id: session, type: "message", text });
  const events = [
    started("a01", "s0", "sid-A"),
    say("a01", "s0", "EARLY-TRY-FACT-1"),
    started("a01", "s1", "sid-A"),
    // The represented (last) try: its raw text is a work-report envelope that the
    // carried answer, an unwrapped deliverable, does not contain verbatim.
    say("a01", "s1", '{"deliverable":"FINAL-ANSWER-2","work_report":{}}'),
    started("a02", "s2", "sid-B"),
    // Another attempt saying the carried answer's words is its own output (#568).
    say("a02", "s2", "FINAL-ANSWER-2"),
    say("a02", "s2", "OTHER-ATTEMPT-FACT-3"),
  ];

  it("keeps earlier tries and other attempts once, whatever their words, never the represented try", () => {
    const facts = runExecutionFacts(events);
    const output = unrepresentedOutput(events, facts, "a01")!;
    expect(output).toContain("EARLY-TRY-FACT-1");
    expect(output).toContain("OTHER-ATTEMPT-FACT-3");
    expect(output).not.toContain("work_report");
    expect(output).toMatch(/^FINAL-ANSWER-2$/m);
    expect(output.match(/## Attempt a01/g)).toHaveLength(1);
    expect(output).toContain("Session: `s0`");
    expect(output).not.toContain("Session: `s1`");
  });

  it("without a known represented attempt nothing is left out", () => {
    const output = unrepresentedOutput(events, runExecutionFacts(events), null)!;
    expect(output).toContain("work_report");
    expect(output).toMatch(/^FINAL-ANSWER-2$/m);
    // The represented try alone leaves nothing to add.
    expect(unrepresentedOutput(events.slice(2, 4), runExecutionFacts(events), "a01")).toBe(null);
  });

  it("still accepts the earlier call shapes, whose carried text filters nothing", () => {
    const facts = runExecutionFacts(events);
    // Every recorded word, as an earlier caller passed its carried answer.
    const carried = "# Answer\n\nEARLY-TRY-FACT-1 FINAL-ANSWER-2 OTHER-ATTEMPT-FACT-3";
    const identity = unrepresentedOutput(events, facts, "a01");
    expect(identity).toMatch(/^FINAL-ANSWER-2$/m);
    expect(unrepresentedOutput(events, facts, "a01", carried)).toBe(identity);
    // The published event-log entry keeps accepting the `text` option, inert.
    const represented = { attempt: "a01", session: "s1" };
    expect(retainedOutput(events, 0, false, { text: carried, represented })).toBe(
      retainedOutput(events, 0, false, { represented }),
    );
  });
});

describe("continuation evidence keeps output by identity, never by words (#568)", () => {
  /** A completed run: its winner's final answer, telemetry and these events with exact seqs. */
  function completedRun(rows: Array<[string, Record<string, unknown>]>, answer: string) {
    const dir = mkdtempSync(join(tmpdir(), "cx-identity-"));
    roots.push(dir);
    mkdirSync(join(dir, "final"));
    const events = rows.map(([type, payload], index) => ({
      seq: index + 1,
      ts: "t",
      run_id: "r",
      task_id: "k",
      type,
      payload: { harness_id: "fake", ...payload },
    }));
    writeFileSync(
      join(dir, "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    writeFileSync(join(dir, "final", "answer.md"), `${answer}\n`);
    writeFileSync(
      join(dir, "final", "telemetry.yaml"),
      JSON.stringify(
        RunTelemetry.parse({
          schema_version: SCHEMA_VERSION,
          run_id: "r",
          task_id: "k",
          mode: "ask",
          requested_access: "readonly",
          effective_access: "readonly",
          external_context_policy: "auto",
          effective_web_mode: "off",
          web: {
            required: false,
            policy: "off",
            effective_mode: "off",
            attempted: false,
            satisfied: false,
            status: "none",
            tool: null,
            target: null,
            error_summary: null,
          },
          final_attempt_id: "a02",
          attempts: [],
          generated_at: "2026-11-01T00:00:00.000Z",
        }),
      ),
    );
    return dir;
  }
  const start = (
    attempt: string,
    session: string,
    native: string,
  ): [string, Record<string, unknown>] => [
    "harness.event",
    {
      attempt_id: attempt,
      session_id: session,
      type: "started",
      payload: { native_session_id: native },
    },
  ];
  const text = (
    attempt: string,
    session: string,
    value: string,
    extra: Record<string, unknown> = {},
  ): [string, Record<string, unknown>] => [
    "harness.event",
    { attempt_id: attempt, session_id: session, type: "message", text: value, ...extra },
  ];
  const header = (attempt: string, session: string) =>
    `## Attempt ${attempt} · fake\n\nSession: \`${session}\`\n\n`;

  it("keeps equal and contained words of other attempts, tries and turns; leaves out the carried final once", () => {
    const dir = completedRun(
      [
        start("a01", "s1", "sid-1"), // 1
        text("a01", "s1", "OK", { final: true }), // 2: another attempt, words inside the answer
        start("a02", "s2", "sid-2"), // 3
        text("a02", "s2", "NOT OK", { final: true }), // 4: an earlier try, the answer's own words
        start("a02", "s3", "sid-2"), // 5: the represented (last accepted) try
        text("a02", "s3", "OK"), // 6: narration
        text("a02", "s3", "OK", { final: true }), // 7: its first native turn's final repeats it
        // 8-11: the second turn, keyed as Claude streams it, then its unkeyed result.
        text("a02", "s3", "NOT", {
          speech: { key: "k", op: "fragment" },
          payload: { delta: true },
        }),
        text("a02", "s3", " OK", {
          speech: { key: "k", op: "fragment" },
          payload: { delta: true },
        }),
        text("a02", "s3", "NOT OK", { speech: { key: "k", op: "complete" } }),
        text("a02", "s3", "NOT OK", { final: true }),
      ],
      "NOT OK",
    );
    expect(readContinuationEvidence(dir).output).toBe(
      "Final answer (final/answer.md, attempt a02):\n\nNOT OK\n\n# Retained output\n\n" +
        "> Recorded assistant text, not a completion verdict. The run outcome and checks remain authoritative.\n\n" +
        "Source: `events.jsonl`. Attempts and physical sessions are kept separate.\n\n" +
        `${header("a01", "s1")}### Observed final message · events 2–2\n\nOK\n\n---\n\n` +
        `${header("a02", "s2")}### Observed final message · events 4–4\n\nNOT OK\n\n---\n\n` +
        `${header("a02", "s3")}### Observed final message · events 6–7\n\nOK`,
    );
  });
});

describe("the work a held session never received", () => {
  const work = (attempt: string, session: string) =>
    row("harness.event", { attempt_id: attempt, session_id: session, type: "tool_call" });

  it("is every other attempt, whatever the event order: timing is not lineage", () => {
    const interleaved = runExecutionFacts([
      started("a01", "s1", "sid-1"),
      started("a02", "s2", "sid-2"),
      work("a02", "s2"),
      work("a01", "s1"),
    ]);
    const delayed = runExecutionFacts([
      started("a01", "s1", "sid-1"),
      work("a01", "s1"),
      started("a02", "s2", "sid-2"),
      work("a02", "s2"),
    ]);
    for (const facts of [interleaved, delayed]) {
      expect(uncoveredAttempts(facts, "a01")).toEqual(["a02"]);
      expect(uncoveredAttempts(facts, "a02")).toEqual(["a01"]);
    }
    expect(uncoveredAttempts(delayed, "a09")).toEqual([]);
  });

  it("excludes only what a packet of this run briefed it with (a successor's later attempt)", () => {
    const facts = runExecutionFacts([
      started("a01", "s0", "sid-A"),
      work("a01", "s0"),
      started("a01-fb", "s1", "sid-FB"),
      receipt("a01-fb", "s1", { carrier: "packet", memory: "partial" }),
      started("a02", "s2", "sid-2"),
    ]);
    expect(uncoveredAttempts(facts, "a01-fb")).toEqual(["a02"]);
    // The first attempt was briefed with nothing of this run: everything later is new to it.
    expect(uncoveredAttempts(facts, "a01")).toEqual(["a01-fb", "a02"]);
  });
});

describe("the carrying session of a predecessor", () => {
  function runDir(events: RunEvent[], capsules: Record<string, [string, number]>) {
    const dir = mkdtempSync(join(tmpdir(), "cx-carrier-"));
    roots.push(dir);
    writeFileSync(
      join(dir, "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    for (const [attempt, [sid, mtimeMs]] of Object.entries(capsules)) {
      mkdirSync(join(dir, "attempts", attempt), { recursive: true });
      writeFileSync(
        join(dir, "attempts", attempt, "session-capsule.json"),
        JSON.stringify({
          harness: "fake",
          nativeSessionId: sid,
          holderProfileId: "a",
          file: null,
          mtimeMs,
          sidecars: [],
          cwd: "/w",
          requestedModel: null,
        }),
      );
    }
    return dir;
  }

  it("is the last accepted start's capsule, whatever the capsule mtimes or directory order", () => {
    const dir = runDir([started("a01", "s0", "sid-A"), started("a01-fb", "s1", "sid-FB")], {
      a01: ["sid-A", 9_999],
      "a01-fb": ["sid-FB", 1],
    });
    const evidence = readContinuationEvidence(dir);
    expect(evidence.held?.attemptId).toBe("a01-fb");
    expect(evidence.attempts).toEqual(["a01", "a01-fb"]);
    expect(evidence.sessionMemory).toBe("unknown");
  });

  it("a later attempt that started but did nothing cannot evict the attempt that holds the work", () => {
    const dir = runDir(
      [
        started("a01", "s0", "sid-A"),
        row("harness.event", { attempt_id: "a01", session_id: "s0", type: "tool_call" }),
        started("a01-fb", "s1", "sid-FB"),
        // Narration of a crashed try is evidence, not progress.
        row("harness.event", {
          attempt_id: "a01-fb",
          session_id: "s1",
          type: "message",
          text: "looking around",
        }),
      ],
      { a01: ["sid-A", 1], "a01-fb": ["sid-FB", 2] },
    );
    expect(readContinuationEvidence(dir).held?.attemptId).toBe("a01");
  });

  it("a fallback that never started cannot evict the earlier carrier", () => {
    const dir = runDir(
      [started("a01", "s0", "sid-A"), row("harness.started", { attempt_id: "a01-fb" })],
      {
        a01: ["sid-A", 1],
      },
    );
    expect(readContinuationEvidence(dir).held?.capsule.nativeSessionId).toBe("sid-A");
  });

  it("a start refused by its own handshake carries nothing; a started attempt without a capsule has no native carrier", () => {
    const mismatched = runDir(
      [
        started("a01", "s0", "sid-A"),
        started("a01-fb", "s1", "sid-X"),
        receipt("a01-fb", "s1", { identityCheck: "mismatch_before_effects" }),
      ],
      { a01: ["sid-A", 1], "a01-fb": ["sid-X", 2] },
    );
    expect(readContinuationEvidence(mismatched).held?.attemptId).toBe("a01");
    const capsuleless = runDir([started("a01", "s0", "sid-A"), started("a02", "s1")], {
      a01: ["sid-A", 1],
    });
    expect(readContinuationEvidence(capsuleless).held).toBeNull();
    expect(readContinuationEvidence(capsuleless).attemptId).toBe("a02");
  });

  it("without any start or receipt, the run's only capsule carries; several stay unchosen", () => {
    const only = runDir([], { a01: ["sid-A", null as unknown as number] });
    expect(readContinuationEvidence(only).held?.capsule.nativeSessionId).toBe("sid-A");
    expect(readContinuationEvidence(only).sessionMemory).toBe("unknown");
    const several = runDir([], { a01: ["sid-A", 1], a02: ["sid-B", 9_999] });
    expect(readContinuationEvidence(several).held).toBeNull();
  });

  it("without any start, the seeded native first try's capsule carries", () => {
    const dir = runDir([receipt("a01", "s0", { carrier: "native_moved" })], {
      a01: ["sid-A", 1],
      a02: ["sid-other", 5],
    });
    expect(readContinuationEvidence(dir).held?.attemptId).toBe("a01");
  });
});

/*
 * Astra r1 review repro, verbatim assertions (`chain-review/concurrent-source.repro.test.ts`;
 * the baseline differential it also ran is recorded in its log). Imports adapted.
 */
it("keeps a concurrent predecessor terminal source when a later independent candidate also progressed", () => {
  expect(
    continuationRefusal({ mode: "agent", n: 1, continueFrom: "run-P" }, [
      { id: "job-P", runId: "run-P", state: "failed", params: { mode: "agent", n: 2 } },
    ]),
  ).toBeNull();
  const root = mkdtempSync(join(tmpdir(), "cx-concurrent-source-"));
  try {
    mkdirSync(join(root, "final"));
    const block = RunResumable.parse({
      cause: "transport",
      resetsAt: null,
      limitWindow: null,
      limitEvidence: null,
      carriers: ["native", "native_moved", "packet"],
      limitCode: null,
      session: { harness: "fake", nativeSessionId: "sid-first", holderProfileId: "a" },
      workspace: { kind: "none", root: null },
    });
    writeFileSync(join(root, "final", "resumable.yaml"), JSON.stringify(block));
    const events: unknown[] = [];
    let seq = 0;
    for (const [attempt, native] of [
      ["a01", "sid-first"],
      ["a02", "sid-later"],
    ]) {
      const dir = join(root, "attempts", attempt!);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "session-capsule.json"),
        JSON.stringify({
          harness: "fake",
          nativeSessionId: native,
          holderProfileId: "a",
          file: null,
          mtimeMs: null,
          sidecars: [],
          cwd: root,
          requestedModel: null,
        }),
      );
      for (const [type, payload] of [
        ["started", { native_session_id: native }],
        ["tool_call", {}],
      ] as const)
        events.push({
          seq: ++seq,
          ts: new Date().toISOString(),
          run_id: "run-P",
          task_id: "task-P",
          type: "harness.event",
          payload: {
            type,
            harness_id: "fake",
            attempt_id: attempt,
            session_id: `process-${attempt}`,
            payload,
          },
        });
    }
    writeFileSync(
      join(root, "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    expect(readContinuationEvidence(root).held?.capsule.nativeSessionId).toBe("sid-first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the declared terminal source speaks for a predecessor", () => {
  const capsules = (dir: string, entries: Record<string, string>) => {
    for (const [attempt, sid] of Object.entries(entries)) {
      mkdirSync(join(dir, "attempts", attempt), { recursive: true });
      writeFileSync(
        join(dir, "attempts", attempt, "session-capsule.json"),
        JSON.stringify({
          harness: "fake",
          nativeSessionId: sid,
          holderProfileId: "a",
          file: null,
          mtimeMs: null,
          sidecars: [],
          cwd: "/w",
          requestedModel: null,
        }),
      );
    }
  };
  const progressed = (attempt: string, session: string) =>
    row("harness.event", { attempt_id: attempt, session_id: session, type: "tool_call" });

  it("a block that names no session leaves no native carrier, whatever progressed", () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-declared-"));
    roots.push(dir);
    mkdirSync(join(dir, "final"));
    capsules(dir, { a01: "sid-A" });
    writeFileSync(
      join(dir, "events.jsonl"),
      [started("a01", "s0", "sid-A"), progressed("a01", "s0")]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
    writeFileSync(
      join(dir, "final", "resumable.yaml"),
      JSON.stringify({
        cause: "transport",
        resetsAt: null,
        limitWindow: null,
        limitEvidence: null,
        carriers: ["packet"],
        limitCode: null,
        session: null,
        workspace: { kind: "none", root: null },
      }),
    );
    expect(readContinuationEvidence(dir).held).toBeNull();
  });

  it("a completed concurrent run continues its final attempt, not the newest that progressed", () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-declared-"));
    roots.push(dir);
    mkdirSync(join(dir, "final"));
    capsules(dir, { a01: "sid-win", a02: "sid-lost" });
    writeFileSync(
      join(dir, "events.jsonl"),
      [
        started("a01", "s0", "sid-win"),
        started("a02", "s1", "sid-lost"),
        progressed("a01", "s0"),
        progressed("a02", "s1"),
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
    const web = {
      required: false,
      policy: "auto",
      effective_mode: "auto",
      attempted: false,
      satisfied: false,
      status: "none",
      tool: null,
      target: null,
      error_summary: null,
    };
    writeFileSync(
      join(dir, "final", "telemetry.yaml"),
      JSON.stringify(
        RunTelemetry.parse({
          schema_version: SCHEMA_VERSION,
          run_id: "run-w",
          task_id: "task-w",
          mode: "agent",
          requested_access: "workspace_write",
          effective_access: "workspace_write",
          external_context_policy: "auto",
          effective_web_mode: "auto",
          web,
          final_attempt_id: "a01",
          attempts: [],
          generated_at: "2026-10-29T00:00:00.000Z",
        }),
      ),
    );
    expect(readContinuationEvidence(dir).held?.capsule.nativeSessionId).toBe("sid-win");
  });
});
