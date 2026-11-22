/** The durable record's write policy: nothing is confirmed before the
 * directory entry of the replaced record is flushed. */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const flush = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; recordVisible: boolean }>,
  gate: null as Promise<void> | null,
  watch: null as string | null,
}));
vi.mock("@claudexor/util", async (original) => {
  const actual = await original<typeof import("@claudexor/util")>();
  return {
    ...actual,
    fsyncDirectoryAsync: async (path: string, platform?: NodeJS.Platform) => {
      flush.calls.push({
        path,
        recordVisible: flush.watch !== null && existsSync(flush.watch),
      });
      if (flush.gate) await flush.gate;
      return actual.fsyncDirectoryAsync(path, platform);
    },
  };
});

const { RunDeadlines } = await import("./run-deadlines.js");
const { readRecord, writeRecord } = await import("./run-deadline-record.js");

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "d-rdr-"));
  dirs.push(dir);
  return dir;
};

describe("run-deadline record durability", () => {
  it("flushes the directory after the rename, before the write resolves", async () => {
    const dir = temp();
    const path = join(dir, "job.json");
    flush.calls.length = 0;
    flush.watch = path;
    const deadlines = new RunDeadlines({ dir, spawnWarden: async () => ({ pid: 1 }) });
    await deadlines.stage("job", {
      own: deadlines.toPoint(new Date(Date.now() + 60_000).toISOString()),
      successorOf: null,
      parentJobId: null,
    });
    expect(flush.calls).toEqual([{ path: dir, recordVisible: true }]);
    await writeRecord(path, readRecord(path) as never);
    expect(flush.calls).toHaveLength(2);
    await deadlines.dispose();
  });

  it("a set is confirmed only once its directory flush completed", async () => {
    const dir = temp();
    const deadlines = new RunDeadlines({ dir, spawnWarden: async () => ({ pid: 1 }) });
    await deadlines.stage("job", {
      own: deadlines.toPoint(new Date(Date.now() + 60_000).toISOString()),
      successorOf: null,
      parentJobId: null,
    });
    deadlines.admit("job");
    let release!: () => void;
    flush.gate = new Promise<void>((resolve) => (release = resolve));
    let confirmed = false;
    const set = deadlines
      .set(
        "job",
        { at: new Date(Date.now() + 90_000).toISOString(), expectedRevision: 0 },
        {
          delegated: false,
        },
      )
      .then((snapshot) => {
        confirmed = true;
        return snapshot;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(confirmed).toBe(false);
    flush.gate = null;
    release();
    expect((await set).revision).toBe(1);
    await deadlines.dispose();
  });
});
