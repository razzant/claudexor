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
import { EventLog } from "@claudexor/event-log";
import { FINAL_MESSAGES_PATH } from "@claudexor/schema";
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
