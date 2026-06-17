import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codexTranscriptModel } from "./index.js";

// B9: codex's `--json` stream never carries the model, but the CLI records it in
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
        JSON.stringify({ type: "turn_context", payload: { turn_id: "t1", model: "gpt-5.5", effort: "high" } }),
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
