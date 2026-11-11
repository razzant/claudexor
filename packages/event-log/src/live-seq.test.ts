import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog, liveRunEventSeq } from "./index.js";

const roots: string[] = [];
const logs: EventLog[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "claudexor-live-seq-"));
  roots.push(root);
  return join(root, "events.jsonl");
}

function writer(path: string, onPersist?: ConstructorParameters<typeof EventLog>[3]): EventLog {
  const log = new EventLog(path, "run-1", "task-1", onPersist);
  logs.push(log);
  return log;
}

afterEach(() => {
  // This test's folders, taken before its closes: a later test never removes them.
  const ownedRoots = roots.splice(0);
  for (const log of logs.splice(0)) log.dispose();
  for (const root of ownedRoots) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

describe("liveRunEventSeq", () => {
  it("returns null for absent and retained-only logs without parsing their files", () => {
    const path = fixture();
    expect(liveRunEventSeq(path)).toBeNull();
    writeFileSync(path, '{"seq":42}\n');
    expect(liveRunEventSeq(path)).toBeNull();
  });

  it("uses the registered writer's counter without inspecting a later file tail", () => {
    const path = fixture();
    const log = writer(path);
    expect(liveRunEventSeq(path)).toBe(0);
    log.emit("run.created");
    expect(liveRunEventSeq(path)).toBe(1);
    appendFileSync(path, '{"seq":99}\n');
    expect(liveRunEventSeq(path)).toBe(1);
  });

  it("returns null after disposal even when events remain on disk", () => {
    const path = fixture();
    const log = writer(path);
    log.emit("run.created");
    log.dispose();
    expect(liveRunEventSeq(path)).toBeNull();
  });

  it("returns null after a committed terminal releases the live owner", () => {
    const path = fixture();
    const log = writer(path);
    log.emit("run.created");
    log.emit("run.completed");
    expect(liveRunEventSeq(path)).toBeNull();
  });

  it("keeps a poisoned writer's conservative counter without triggering file recovery", () => {
    const path = fixture();
    const log = writer(path, (event) => {
      if (event.type === "run.completed") throw new Error("durable journal unavailable");
    });
    log.setBeforeTerminal(() => ({
      type: "run.completed",
      payload: {},
      rollback: () => {
        throw new Error("receipt restore failed");
      },
    }));
    const created = log.emit("run.created");
    expect(() => log.emit("run.completed")).toThrow(/rollback was incomplete/);
    const recovery = vi.spyOn(log, "releaseRecoveredTerminalFence");
    appendFileSync(path, `${JSON.stringify({ ...created, seq: 2, type: "run.completed" })}\n`);

    expect(liveRunEventSeq(path)).toBe(1);
    expect(log.terminalCommitted()).toBe(false);
    expect(recovery).not.toHaveBeenCalled();

    expect(log.releaseRecoveredTerminalFence()).toBe(true);
    expect(liveRunEventSeq(path)).toBeNull();
  });
});
