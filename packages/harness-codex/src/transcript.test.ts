import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  codexRateLimitCursor,
  codexTranscriptModel,
  codexTranscriptRateLimits,
  codexTranscriptVendorFailure,
} from "./transcript.js";

// codex's `--json` stream never carries the model, but the CLI records it in
// its own rollout transcript. codexTranscriptModel reads that file so the
// cross-family route proof can verify honestly (a real observation, not argv).
describe("codexTranscriptModel", () => {
  let home: string;
  const thread = "019ea4db-1412-7863-8d54-946e4e6ad171";

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "codex-transcript-test-"));
    const dayDir = join(home, "sessions", "2026", "06", "17");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(
      join(dayDir, `rollout-2026-06-17T21-00-00-${thread}.jsonl`),
      [
        JSON.stringify({ type: "session_meta", payload: { id: thread } }),
        JSON.stringify({
          type: "turn_context",
          payload: { turn_id: "t1", model: "gpt-5.5", effort: "high" },
        }),
      ].join("\n") + "\n",
    );
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("reads the model codex recorded for the matching thread (verified-tier evidence)", () => {
    expect(codexTranscriptModel(home, thread)).toBe("gpt-5.5");
  });

  it("returns null for an unknown thread id (no fabrication)", () => {
    expect(codexTranscriptModel(home, "no-such-thread")).toBeNull();
  });

  it("returns null when the thread id is missing", () => {
    expect(codexTranscriptModel(home, undefined)).toBeNull();
  });

  it("returns null for a missing CODEX_HOME (safe degradation)", () => {
    expect(codexTranscriptModel(join(home, "does-not-exist"), thread)).toBeNull();
  });

  it("returns the LAST turn_context model for a resumed session (most recent turn, not stale)", () => {
    const resumed = "019eaaaa-2222-7863-8d54-resumeexample0";
    const dayDir = join(home, "sessions", "2026", "06", "18");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(
      join(dayDir, `rollout-2026-06-18T10-00-00-${resumed}.jsonl`),
      [
        JSON.stringify({ type: "turn_context", payload: { turn_id: "t1", model: "gpt-5-mini" } }),
        JSON.stringify({ type: "item.completed", payload: { item: { type: "agent_message" } } }),
        JSON.stringify({ type: "turn_context", payload: { turn_id: "t2", model: "gpt-5.5" } }),
      ].join("\n") + "\n",
    );
    expect(codexTranscriptModel(home, resumed)).toBe("gpt-5.5");
  });
});

describe("codexTranscriptRateLimits (quota)", () => {
  it("reads every window from the LAST token_count rate_limits record", async () => {
    const { codexTranscriptRateLimits } = await import("./transcript.js");
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const day = join(home, "sessions", "2026", "07", "03");
    mkdirSync(day, { recursive: true });
    const threadId = "0199aaaa-bbbb-cccc-dddd-eeeeffff0000";
    const line = (primaryUsed: number, secondaryUsed: number) =>
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: primaryUsed, window_minutes: 300, resets_at: 1782368577 },
            secondary: {
              used_percent: secondaryUsed,
              window_minutes: 10080,
              resets_at: 1782387153,
            },
          },
        },
      });
    writeFileSync(
      join(day, `rollout-2026-07-03T00-00-00-${threadId}.jsonl`),
      [line(1, 2), line(12.5, 40)].join("\n") + "\n",
    );
    const rl = codexTranscriptRateLimits(home, threadId);
    expect(rl).not.toBeNull();
    expect(rl?.source).toBe("codex_rollout");
    expect(rl?.constraints).toEqual([
      expect.objectContaining({ id: "primary", used_ratio: 0.125, window_seconds: 18_000 }),
      expect.objectContaining({ id: "secondary", used_ratio: 0.4, window_seconds: 604_800 }),
    ]);
    expect(rl?.constraints[1]?.resets_at).toBe(new Date(1782387153 * 1000).toISOString());
    // Missing rollout -> null (fail-honest, no signal).
    expect(codexTranscriptRateLimits(home, "unknown-thread")).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });
});

describe("codexTranscriptRateLimits reads the rollout incrementally", () => {
  const threadId = "0199bbbb-cccc-dddd-eeee-ffff00001111";
  const record = (primaryUsed: number) =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: { primary: { used_percent: primaryUsed, window_minutes: 300 } },
      },
    }) + "\n";
  const other = (text: string) =>
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", text } }) + "\n";
  function rollout(): { home: string; file: string } {
    const home = mkdtempSync(join(tmpdir(), "codex-incremental-"));
    const day = join(home, "sessions", "2026", "10", "10");
    mkdirSync(day, { recursive: true });
    const file = join(day, `rollout-2026-10-10T00-00-00-${threadId}.jsonl`);
    writeFileSync(file, "");
    return { home, file };
  }
  const used = (quota: ReturnType<typeof codexTranscriptRateLimits>) =>
    quota?.constraints[0]?.used_ratio ?? null;

  it("answers like a whole-file read at every step of a growing rollout", () => {
    const { home, file } = rollout();
    const cursor = codexRateLimitCursor();
    const steps: Array<[string, number | null]> = [
      [other("hello"), null],
      [record(10), 0.1],
      [other("ж".repeat(40)), 0.1],
      [record(20).slice(0, 30), 0.1], // torn: codex is mid-write
      [record(20).slice(30), 0.2], // the same record completes
      [record(35).trimEnd(), 0.35], // whole but not yet newline-terminated
      ["\n" + other("after"), 0.35],
    ];
    for (const [bytes, expected] of steps) {
      appendFileSync(file, bytes);
      const incremental = codexTranscriptRateLimits(home, threadId, cursor);
      expect(used(incremental)).toBe(expected);
      expect(incremental).toEqual(codexTranscriptRateLimits(home, threadId));
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("reads only the bytes appended since the last call", () => {
    const { home, file } = rollout();
    const cursor = codexRateLimitCursor();
    writeFileSync(file, record(10) + other("x"));
    expect(used(codexTranscriptRateLimits(home, threadId, cursor))).toBe(0.1);
    // Rewrite the consumed bytes in place (same size and file): a whole-file
    // read no longer sees the record, the cursor never reads those bytes again.
    const consumed = readFileSync(file, "utf8");
    writeFileSync(file, " ".repeat(Buffer.byteLength(consumed)), { flag: "r+" });
    appendFileSync(file, other("y"));
    expect(codexTranscriptRateLimits(home, threadId)).toBeNull();
    expect(used(codexTranscriptRateLimits(home, threadId, cursor))).toBe(0.1);
    appendFileSync(file, record(55));
    expect(used(codexTranscriptRateLimits(home, threadId, cursor))).toBe(0.55);
    rmSync(home, { recursive: true, force: true });
  });

  it("starts over on a replaced or truncated rollout, and for another thread", () => {
    const { home, file } = rollout();
    const cursor = codexRateLimitCursor();
    writeFileSync(file, record(40) + record(41));
    expect(used(codexTranscriptRateLimits(home, threadId, cursor))).toBe(0.41);
    const replacement = `${file}.next`;
    writeFileSync(replacement, other("fresh") + record(5));
    renameSync(replacement, file);
    expect(used(codexTranscriptRateLimits(home, threadId, cursor))).toBe(0.05);
    writeFileSync(file, record(7)); // truncated below the consumed offset
    expect(used(codexTranscriptRateLimits(home, threadId, cursor))).toBe(0.07);
    expect(codexTranscriptRateLimits(home, "other-thread", cursor)).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });
});

describe("no real ~/.codex fallback (v3.0.3 S9)", () => {
  it("returns null for an absent/empty CODEX_HOME instead of reading the operator's real home", () => {
    // Poison a fake real home: if the reader fell back to ~/.codex it would
    // find this planted rollout and report its model.
    const fakeHome = mkdtempSync(join(tmpdir(), "claudexor-transcript-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    const day = join(fakeHome, ".codex", "sessions", "2026", "07", "21");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, "rollout-2026-07-21T00-00-00-poisoned-thread.jsonl"),
      JSON.stringify({ type: "turn_context", payload: { model: "poisoned-model" } }) + "\n",
    );
    try {
      expect(codexTranscriptModel(null, "poisoned-thread")).toBeNull();
      expect(codexTranscriptModel("", "poisoned-thread")).toBeNull();
      expect(codexTranscriptModel("   ", "poisoned-thread")).toBeNull();
      expect(codexTranscriptRateLimits(undefined, "poisoned-thread")).toBeNull();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

// codex's `--json` stream reduces a failed turn to a sentence; the CLI's own
// rollout keeps the typed record. codexTranscriptVendorFailure reads it after
// exit and forwards it verbatim — or returns null on ANY doubt about whether
// the record speaks for the turn this process just ran.
describe("codexTranscriptVendorFailure", () => {
  const ROLLOUT_FIXTURES = fileURLToPath(new URL("../fixtures/rollout", import.meta.url));
  const recorded = (name: string): string =>
    readFileSync(join(ROLLOUT_FIXTURES, name), { encoding: "utf8" });
  const homes: string[] = [];
  let seq = 0;
  afterAll(() => {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  });

  /** Install `content` as the rollout of a fresh thread in a fresh CODEX_HOME. */
  function install(content: string): { home: string; thread: string; file: string } {
    const home = mkdtempSync(join(tmpdir(), "codex-vendor-failure-"));
    homes.push(home);
    const thread = `00000000-0000-7000-0000-${String(++seq).padStart(12, "0")}`;
    const day = join(home, "sessions", "2026", "09", "15");
    mkdirSync(day, { recursive: true });
    const file = join(day, `rollout-2026-09-15T12-00-00-${thread}.jsonl`);
    writeFileSync(file, content);
    return { home, thread, file };
  }

  // Synthetic turn records in the recorded shape (seconds since the epoch).
  const SPAWN_S = 1789465372;
  const SPAWN_MS = SPAWN_S * 1000 + 400;
  const startedLine = (turn: string, startedAt: number): string =>
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: turn, started_at: startedAt },
    });
  const completeLine = (turn: string, startedAt: number, error?: unknown): string =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: turn,
        last_agent_message: error === undefined ? "done" : null,
        ...(error === undefined ? {} : { error }),
        started_at: startedAt,
        completed_at: startedAt + 5,
      },
    });
  const overloaded = {
    message: "Selected model is at capacity.",
    codex_error_info: "server_overloaded",
  };
  const rollout = (...lines: string[]): string => lines.join("\n") + "\n";
  const read = (content: string, notBeforeMs = SPAWN_MS) => {
    const { home, thread } = install(content);
    return codexTranscriptVendorFailure(home, thread, notBeforeMs);
  };

  describe("fires", () => {
    it("reads codex's own failure code for the turn that just ended (recorded)", () => {
      expect(read(recorded("recorded-server-overloaded-0.153.3.jsonl"), 1789465372_000)).toEqual({
        code: "server_overloaded",
        message: "Selected model is at capacity. Please try a different model.",
        source: "codex_rollout",
      });
    });

    it("reads a second recorded code the same way", () => {
      expect(read(recorded("recorded-usage-limit-exceeded-0.153.3.jsonl"), 1789198058_000)).toEqual(
        {
          code: "usage_limit_exceeded",
          message:
            "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
          source: "codex_rollout",
        },
      );
    });

    it("forwards a code Claudexor has never heard of, unchanged (no mapping table)", () => {
      const other = read(recorded("recorded-other-0.153.3.jsonl"), 1789543114_000);
      expect(other?.code).toBe("other");
      expect(other?.message).toContain("stream disconnected before completion");
      const brandNew = read(
        rollout(
          startedLine("t1", SPAWN_S),
          completeLine("t1", SPAWN_S, { message: "m", codex_error_info: "brand_new_code_2031" }),
        ),
      );
      expect(brandNew).toEqual({
        code: "brand_new_code_2031",
        message: "m",
        source: "codex_rollout",
      });
    });

    it("yields the variant name for the tagged-object form and drops its inner detail", () => {
      const tagged = read(
        rollout(
          startedLine("t1", SPAWN_S),
          completeLine("t1", SPAWN_S, {
            message: "stream disconnected",
            codex_error_info: { response_stream_disconnected: { http_status_code: 502 } },
          }),
        ),
      );
      expect(tagged).toEqual({
        code: "response_stream_disconnected",
        message: "stream disconnected",
        source: "codex_rollout",
      });
    });

    it("returns the LAST turn's failure in a resumed session (recorded: success, then overloaded)", () => {
      // Spawn second of the SECOND (resumed) process.
      expect(
        read(recorded("recorded-resumed-overloaded-0.153.3.jsonl"), 1789939141_000)?.code,
      ).toBe("server_overloaded");
    });

    it("keeps the vendor's words with a null code when the record has no usable code", () => {
      for (const info of [undefined, null, 7, {}, { a: {}, b: {} }]) {
        const value = read(
          rollout(
            startedLine("t1", SPAWN_S),
            completeLine("t1", SPAWN_S, { message: "only words", codex_error_info: info }),
          ),
        );
        expect(value, JSON.stringify(info)).toEqual({
          code: null,
          message: "only words",
          source: "codex_rollout",
        });
      }
    });

    it("bounds what it forwards (code 128, message 2000) and accepts a rollout with no task_started markers", () => {
      const value = read(
        rollout(
          completeLine("t1", SPAWN_S, {
            message: "w".repeat(5000),
            codex_error_info: "c".repeat(500),
          }),
        ),
      );
      expect(value?.code).toHaveLength(128);
      expect(value?.message).toHaveLength(2000);
    });
  });

  describe("stays quiet (null)", () => {
    it("when the last turn succeeded", () => {
      expect(read(rollout(startedLine("t1", SPAWN_S), completeLine("t1", SPAWN_S)))).toBeNull();
    });

    it("when the session FAILED earlier and the resumed turn then succeeded", () => {
      expect(
        read(
          rollout(
            startedLine("t1", SPAWN_S - 600),
            completeLine("t1", SPAWN_S - 600, overloaded),
            startedLine("t2", SPAWN_S),
            completeLine("t2", SPAWN_S),
          ),
        ),
      ).toBeNull();
    });

    it("when an EARLIER turn failed and the current turn wrote no completion (killed mid-turn)", () => {
      expect(
        read(
          rollout(
            startedLine("t1", SPAWN_S - 600),
            completeLine("t1", SPAWN_S - 600, overloaded),
            startedLine("t2", SPAWN_S),
          ),
        ),
      ).toBeNull();
      // Even inside the same second, the turn marker alone settles it.
      expect(
        read(
          rollout(
            startedLine("t1", SPAWN_S),
            completeLine("t1", SPAWN_S, overloaded),
            startedLine("t2", SPAWN_S),
          ),
        ),
      ).toBeNull();
    });

    it("when the last failure belongs to a turn from BEFORE this process was spawned", () => {
      const prior = rollout(
        startedLine("t1", SPAWN_S - 1),
        completeLine("t1", SPAWN_S - 1, overloaded),
      );
      expect(read(prior)).toBeNull();
      // The very same record IS this run's once the spawn second does not follow it.
      expect(read(prior, (SPAWN_S - 1) * 1000 + 999)?.code).toBe("server_overloaded");
      // The recorded resumed session read as if a THIRD process had just spawned.
      expect(
        read(recorded("recorded-resumed-overloaded-0.153.3.jsonl"), 1789939198_000),
      ).toBeNull();
    });

    it("for a TEXT MENTION of codex_error_info in message or tool-output lines", () => {
      const quoted = JSON.stringify({
        message: "at capacity",
        codex_error_info: "server_overloaded",
      });
      const decoys = [
        {
          type: "response_item",
          payload: { type: "message", content: [{ text: `task_complete ${quoted}` }] },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            output: `{"type":"task_complete","error":${quoted}}`,
          },
        },
        {
          type: "event_msg",
          payload: { type: "item_completed", item: { text: `task_complete error ${quoted}` } },
        },
        { type: "compacted", payload: { message: `task_complete ${quoted}` } },
        // Right payload type, wrong envelope: not an event_msg.
        {
          type: "response_item",
          payload: { type: "task_complete", turn_id: "t1", started_at: SPAWN_S, error: overloaded },
        },
      ].map((o) => JSON.stringify(o));
      expect(read(rollout(startedLine("t1", SPAWN_S), ...decoys))).toBeNull();
      // ...and decoys never displace the real, successful completion either.
      expect(
        read(rollout(startedLine("t1", SPAWN_S), ...decoys, completeLine("t1", SPAWN_S))),
      ).toBeNull();
    });

    it("on a malformed completion: no started_at, a non-object error, or an error with neither code nor words", () => {
      const noStartedAt = JSON.stringify({
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "t1", error: overloaded },
      });
      expect(read(rollout(startedLine("t1", SPAWN_S), noStartedAt))).toBeNull();
      for (const error of ["server_overloaded", ["server_overloaded"], {}, { message: 5 }]) {
        expect(
          read(rollout(startedLine("t1", SPAWN_S), completeLine("t1", SPAWN_S, error))),
          JSON.stringify(error),
        ).toBeNull();
      }
    });

    it("on a TORN last line, never throwing", () => {
      const torn = completeLine("t2", SPAWN_S, overloaded).slice(0, 60);
      expect(
        read(rollout(startedLine("t1", SPAWN_S), completeLine("t1", SPAWN_S, overloaded)) + torn),
      ).toBeNull();
    });

    it("on a missing thread id, a missing or empty home, an unknown thread, or an unreadable rollout — never throwing", () => {
      const content = rollout(startedLine("t1", SPAWN_S), completeLine("t1", SPAWN_S, overloaded));
      const { home, thread, file } = install(content);
      expect(codexTranscriptVendorFailure(home, thread, SPAWN_MS)?.code).toBe("server_overloaded");
      expect(codexTranscriptVendorFailure(home, undefined, SPAWN_MS)).toBeNull();
      expect(codexTranscriptVendorFailure(undefined, thread, SPAWN_MS)).toBeNull();
      expect(codexTranscriptVendorFailure("  ", thread, SPAWN_MS)).toBeNull();
      expect(codexTranscriptVendorFailure(join(home, "absent"), thread, SPAWN_MS)).toBeNull();
      expect(codexTranscriptVendorFailure(home, "no-such-thread", SPAWN_MS)).toBeNull();
      // A rollout path that cannot be read as a file (a directory with the
      // rollout's name) exercises the read failure on every platform.
      const dirHome = mkdtempSync(join(tmpdir(), "codex-vendor-failure-dir-"));
      homes.push(dirHome);
      mkdirSync(join(dirHome, "sessions", "2026", "09", "15", `rollout-x-${thread}.jsonl`), {
        recursive: true,
      });
      expect(() => codexTranscriptVendorFailure(dirHome, thread, SPAWN_MS)).not.toThrow();
      expect(codexTranscriptVendorFailure(dirHome, thread, SPAWN_MS)).toBeNull();
      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        chmodSync(file, 0o000);
        try {
          expect(codexTranscriptVendorFailure(home, thread, SPAWN_MS)).toBeNull();
        } finally {
          chmodSync(file, 0o600);
        }
      }
    });
  });

  // DISCLOSED RESIDUAL, pinned so a future change to it is deliberate. A
  // resumed process that dies before writing ANY turn marker of its own leaves
  // the previous turn's failure as the last record. The spawn-second guard
  // rejects it — unless that previous turn started within the SAME wall-clock
  // second as this spawn (the rollout stores whole seconds). Then the earlier
  // turn's failure is attributed to this run. Accepted: it needs a failed turn,
  // a resume and a pre-turn death inside one second, the failure mode is an
  // extra (true, same-session) vendor record on an already-failed run, and
  // nothing decides behaviour from it.
  it("RESIDUAL: a previous turn that failed in the same second as this spawn is attributed to this run", () => {
    const previousTurnOnly = rollout(
      startedLine("t1", SPAWN_S),
      completeLine("t1", SPAWN_S, overloaded),
    );
    expect(read(previousTurnOnly, SPAWN_S * 1000 + 900)?.code).toBe("server_overloaded");
    // One second later the guard holds.
    expect(read(previousTurnOnly, (SPAWN_S + 1) * 1000)).toBeNull();
  });
});
