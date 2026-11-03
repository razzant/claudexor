import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "@claudexor/schema";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog, appendRunEvent } from "./index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

/** A run with the daemon's shape: a synchronous terminal sink that owns the
 * per-run terminal line, and a terminal held for settlement. */
function fixture(options: { failCommits?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-terminal-staging-"));
  dirs.push(dir);
  const path = join(dir, "events.jsonl");
  const log = new EventLog(path, "run-1", "task-1");
  const order: string[] = [];
  let failures = options.failCommits ?? 0;
  log.setBeforeTerminal((type, payload) => {
    order.push("prepare");
    return { type, payload: { ...payload, verdict: "frozen" } };
  });
  log.setTerminalPersistence((event) => {
    order.push(`commit:${event.seq}`);
    if (failures-- > 0) throw new Error("terminal store unavailable");
    appendFileSync(path, `${JSON.stringify(event)}\n`);
    return { state: "materialized" };
  });
  log.emit("run.created");
  log.deferTerminal();
  log.emit("run.completed", { lifecycle: "succeeded" });
  const events = () => log.readAll().events.map((event) => [event.seq, event.type]);
  return { path, log, order, events };
}

describe("a terminal's durable bytes are staged before its synchronous commit", () => {
  it("prepares the held terminal once, stages that verdict, then commits it", async () => {
    const f = fixture();
    f.log.setTerminalStaging(async (event) => {
      f.order.push(`stage:${event.seq}:${String(event.payload["verdict"])}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const committed = await f.log.commitDeferredTerminal();
    expect(f.order).toEqual(["prepare", "stage:2:frozen", "commit:2"]);
    expect(committed?.payload["verdict"]).toBe("frozen");
    expect(f.log.terminalCommitted()).toBe(true);
    expect(f.events()).toEqual([
      [1, "run.created"],
      [2, "run.completed"],
    ]);
  });

  it("appends an audit that arrives while staging before the terminal, which takes the next seq", async () => {
    const f = fixture();
    let prepared: RunEvent | undefined;
    f.log.setTerminalStaging(async (event) => {
      prepared = event;
      await new Promise((resolve) => setTimeout(resolve, 5));
      // A cancel request's audit through the live writer, during the await.
      appendRunEvent(f.path, "run-1", "task-1", "control.requested", { kind: "cancel" });
    });
    const committed = await f.log.commitDeferredTerminal();
    expect(f.events()).toEqual([
      [1, "run.created"],
      [2, "control.requested"],
      [3, "run.completed"],
    ]);
    expect(committed?.seq).toBe(3);
    // The verdict and its time are the ones prepared before the await.
    expect(committed?.ts).toBe(prepared?.ts);
    expect(committed?.payload["verdict"]).toBe("frozen");
    expect(f.order).toEqual(["prepare", "commit:3"]);
  });

  it("refuses another terminal while staging and commits the prepared one", async () => {
    const f = fixture();
    let refused: unknown;
    f.log.setTerminalStaging(async () => {
      await Promise.resolve();
      try {
        f.log.emit("run.failed", { lifecycle: "failed" });
      } catch (error) {
        refused = error;
      }
    });
    await expect(f.log.commitDeferredTerminal()).resolves.toMatchObject({ type: "run.completed" });
    expect(String(refused)).toMatch(/already in progress/);
    expect(f.events().filter(([, type]) => String(type).startsWith("run."))).toEqual([
      [1, "run.created"],
      [2, "run.completed"],
    ]);
  });

  it("leaves to the commit whatever staging could not write", async () => {
    const f = fixture();
    f.log.setTerminalStaging(async () => {
      throw new Error("drive unavailable");
    });
    await expect(f.log.commitDeferredTerminal()).resolves.toMatchObject({ seq: 2 });
    expect(f.log.terminalCommitted()).toBe(true);
  });

  it("commits before its first yield when there is no staging hook", async () => {
    const f = fixture();
    const committing = f.log.commitDeferredTerminal();
    expect(f.log.terminalCommitted()).toBe(true);
    await committing;
  });

  it("keeps events appended while staging when the commit rolls back, and stays committable", async () => {
    const f = fixture({ failCommits: 1 });
    let audits = 0;
    f.log.setTerminalStaging(async () => {
      if (audits++ === 0)
        appendRunEvent(f.path, "run-1", "task-1", "control.requested", { kind: "cancel" });
    });
    await expect(f.log.commitDeferredTerminal()).rejects.toThrow(/terminal store unavailable/);
    expect(f.log.terminalCommitted()).toBe(false);
    expect(f.events()).toEqual([
      [1, "run.created"],
      [2, "control.requested"],
    ]);
    await f.log.emitTerminal("run.failed", { lifecycle: "failed" });
    expect(f.events().at(-1)).toEqual([3, "run.failed"]);
  });
});
