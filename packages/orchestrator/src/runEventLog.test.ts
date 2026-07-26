import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog, lastSeqInFile } from "@claudexor/event-log";
import { createRunEventLog, prepareRunAnnouncement } from "./runEventLog.js";

describe("run event-log startup ownership", () => {
  it("releases the pre-announce writer when the durable run.created sink refuses", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-run-event-log-"));
    const path = join(root, "events.jsonl");
    try {
      const log = createRunEventLog(path, "run-startup", "task-startup", {
        onEventPersist: () => {
          throw new Error("durable startup refused");
        },
      });

      expect(() =>
        prepareRunAnnouncement(log, () =>
          log.emit("run.created", { mode: "agent", prompt: "exercise startup refusal" }),
        ),
      ).toThrow(/durable startup refused/);
      expect(lastSeqInFile(path)).toBe(1);

      const retry = new EventLog(path, "run-startup", "task-startup");
      retry.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases the writer when ledger preparation refuses before run.created", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-run-event-log-"));
    const path = join(root, "events.jsonl");
    try {
      const log = createRunEventLog(path, "run-ledger-refusal", "task-ledger-refusal", {});

      expect(() =>
        prepareRunAnnouncement(log, () => {
          throw new Error("ledger preparation refused");
        }),
      ).toThrow(/ledger preparation refused/);
      expect(lastSeqInFile(path)).toBe(0);

      const retry = new EventLog(path, "run-ledger-refusal", "task-ledger-refusal");
      retry.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
