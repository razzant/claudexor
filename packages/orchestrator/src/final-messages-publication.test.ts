/**
 * #307: what the terminal preparation settles about the final-messages
 * document. A pointer when the bytes are saved (partial when a record of the
 * log was unreadable); otherwise a typed gap that carries no error text, whose
 * diagnostic is only the run's own status event.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { EARLIER_ASSISTANT_OUTPUT_PATH, EventLog } from "@claudexor/event-log";
import {
  COMMAND_OUTCOME_REFINED,
  FINAL_MESSAGES_PATH,
  RunTelemetry,
  SCHEMA_VERSION,
} from "@claudexor/schema";
import { publishTerminalOutputs } from "./retainedOutput.js";
import type { AnnouncedRunContext } from "./runTerminalContext.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function fixture() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "cx-final-publication-")));
  dirs.push(repo);
  const store = new ArtifactStore(repo);
  const paths = store.createRun("run-pub");
  const log = new EventLog(paths.eventsPath, "run-pub", "task-pub");
  log.emit("run.created", { mode: "ask", prompt: "Review the change." });
  log.emit("harness.event", {
    harness_id: "claude",
    attempt_id: "a01",
    session_id: "s1",
    type: "message",
    text: "Generated example answer.",
    final: true,
  });
  const context: AnnouncedRunContext = {
    log,
    store,
    paths,
    runId: "run-pub",
    taskId: "task-pub",
    mode: "ask",
    phase: "report",
  };
  /** The run's own diagnostics for an unsaved document. */
  const failures = () =>
    readFileSync(paths.eventsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.type === "harness.event" && row.payload.type === "status")
      .map((row) => String(row.payload.text))
      .filter((text) => text.startsWith("Final messages could not be saved"));
  const document = join(paths.root, FINAL_MESSAGES_PATH);
  return { log, context, failures, document };
}

describe("final-messages outcome at terminal preparation", () => {
  it.each([
    ["has no readable event", "empty"],
    ["cannot be read at all", "throws"],
  ] as const)("settles source_unreadable when the run's log %s", (_label, read) => {
    const f = fixture();
    try {
      vi.spyOn(f.log, "readAll").mockImplementation(() => {
        if (read === "throws") throw new Error("EIO: injected read failure");
        return { events: [], malformed: 2 };
      });
      const { finalMessages } = publishTerminalOutputs(f.context, true, false);
      expect(finalMessages).toEqual({ state: "unavailable", reason: "source_unreadable" });
      expect(existsSync(f.document)).toBe(false);
      expect(f.failures()).toHaveLength(1);
    } finally {
      f.log.dispose();
    }
  });

  it("settles publication_failed when the document cannot be written", () => {
    const f = fixture();
    try {
      mkdirSync(f.document);
      const { finalMessages } = publishTerminalOutputs(f.context, true, false);
      expect(finalMessages).toEqual({ state: "unavailable", reason: "publication_failed" });
      expect(f.failures()).toHaveLength(1);
    } finally {
      f.log.dispose();
    }
  });

  it("keeps a partially read log's document as a partial pointer", () => {
    const f = fixture();
    try {
      const read = f.log.readAll();
      vi.spyOn(f.log, "readAll").mockReturnValue({ ...read, malformed: 1 });
      const { finalMessages } = publishTerminalOutputs(f.context, true, false);
      expect(finalMessages).toMatchObject({ state: "partial", count: 1 });
      const header = JSON.parse(readFileSync(f.document, "utf8").split("\n")[0]!);
      expect(header).toMatchObject({ state: "partial", count: 1 });
      expect(f.failures()).toEqual([]);
    } finally {
      f.log.dispose();
    }
  });
});

it("publishes the accepted Cursor attempt's earlier text when both attempts are eligible (#756)", () => {
  const { context, log } = fixture();
  const { store, paths, runId, taskId, mode } = context;
  const attempts = ["a01", "a02"].map((attempt_id) => ({
    attempt_id,
    harness_id: "cursor",
    web: {},
    outcome: { status: "success", deliverable_present: true },
  }));
  const speech = (attemptId: string) => {
    const emit = (payload: Record<string, unknown>) =>
      log.emit("harness.event", {
        harness_id: "cursor",
        attempt_id: attemptId,
        session_id: `cursor-${attemptId}`,
        ...payload,
      });
    const shell = { name: "Shell", kind: "command", use_id: "shell" };
    emit({
      type: "tool_result",
      tool: { ...shell, command_outcome: { state: "backgrounded", shell_id: "shell" } },
    });
    emit({ type: "message", text: `Swatch report ${attemptId}.` });
    emit({
      type: "status",
      payload: { code: COMMAND_OUTCOME_REFINED },
      tool: {
        ...shell,
        command_outcome: {
          state: "completion_reported",
          completion_status: "success",
          shell_id: "shell",
        },
      },
    });
    emit({ type: "message", text: `Follow-up ${attemptId}.` });
    emit({
      type: "message",
      text: `Accepted candidate text ${attemptId}.`,
      final: true,
      payload: { final_source: "assistant_message" },
    });
    emit({ type: "completed" });
  };
  try {
    const accepted = "Accepted candidate text a02.\n";
    const answer = join(paths.finalDir, "answer.md");
    store.writeText(answer, accepted);
    store.writeYaml(
      join(paths.finalDir, "telemetry.yaml"),
      RunTelemetry.parse({
        schema_version: SCHEMA_VERSION,
        run_id: runId,
        task_id: taskId,
        mode,
        requested_access: "readonly",
        effective_access: "readonly",
        external_context_policy: "off",
        effective_web_mode: "off",
        web: {},
        attempts,
        final_attempt_id: "a02",
        generated_at: "2026-11-27T00:00:00.000Z",
      }),
    );
    for (const { attempt_id } of attempts) {
      log.emit("harness.event", {
        harness_id: "cursor",
        attempt_id,
        session_id: `cursor-${attempt_id}`,
        type: "started",
      });
    }
    speech("a02");
    speech("a01"); // The eligible loser speaks last; the settled strategy receipt wins.
    log.emit("output.ready", { kind: "answer", path: "final/answer.md", state: "ready" });

    publishTerminalOutputs(context, true, false);

    const result = readFileSync(join(paths.root, EARLIER_ASSISTANT_OUTPUT_PATH), "utf8");
    expect(result).toContain("Swatch report a02.");
    expect(result).toContain("Follow-up a02.");
    expect(result).not.toContain("a01");
    expect(result).not.toContain("Accepted candidate text");
    expect(readFileSync(answer, "utf8")).toBe(accepted);
  } finally {
    log.dispose();
  }
});
