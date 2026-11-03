import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inRunProjection } from "./projection-context.js";
import {
  eventsParseCountForTests,
  latestPlanProgress,
  readRunEventsWithIntegrity,
  resetEventsParseCountForTests,
} from "./run-timeline.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const roots: string[] = [];
function fixture(): { runDir: string; path: string } {
  const runDir = mkdtempSync(join(tmpdir(), "claudexor-timeline-read-"));
  roots.push(runDir);
  return { runDir, path: join(runDir, "events.jsonl") };
}
afterEach(() => {
  vi.mocked(readSync).mockImplementation(actualFs.readSync);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

describe("complete event snapshots through bounded read buffers", () => {
  it.each([true, false])(
    "keeps explicit history tails separate from complete snapshots (full first=%s)",
    (fullFirst) => {
      const { runDir, path } = fixture();
      const events = Array.from({ length: 20 }, (_, i) => ({
        seq: i + 1,
        type: "text",
        text: "🙂",
      }));
      const lines = events.map((event) => JSON.stringify(event) + "\n");
      writeFileSync(path, lines.join(""));
      const maxBytes = Buffer.byteLength(lines.slice(-3).join("")) + 5;
      inRunProjection(() => {
        const full = () => {
          const read = readRunEventsWithIntegrity({ runDir });
          expect(read.events).toEqual(events);
          expect(read.integrity.tailTruncated).not.toBe(true);
        };
        const bounded = () => {
          const read = readRunEventsWithIntegrity({ runDir }, maxBytes);
          expect(read.events).toEqual(events.slice(-3));
          expect(read.integrity).toMatchObject({ tailTruncated: true, malformedLines: 0 });
        };
        if (fullFirst) full();
        else bounded();
        full();
        bounded();
        const all = readRunEventsWithIntegrity({ runDir }, Buffer.byteLength(lines.join("")));
        expect(all.events).toEqual(events);
        expect(all.integrity.tailTruncated).toBe(false);
      });
    },
  );

  it("shares one parse within a projection and reads fresh outside it", () => {
    const { runDir, path } = fixture();
    writeFileSync(path, '{"seq":1,"type":"first"}\n');
    resetEventsParseCountForTests();
    inRunProjection(() => {
      const first = readRunEventsWithIntegrity({ runDir });
      appendFileSync(path, '{"seq":2,"type":"later"}\n');
      expect(readRunEventsWithIntegrity({ runDir })).toBe(first);
      expect(first.events).toHaveLength(1);
      expect(eventsParseCountForTests()).toBe(1);
    });
    expect(readRunEventsWithIntegrity({ runDir }).events).toHaveLength(2);
    expect(eventsParseCountForTests()).toBe(2);
  });

  it("retains early cash and plan evidence above the former 24 MiB tail boundary", () => {
    const { runDir, path } = fixture();
    const prefix = [
      { type: "budget.cash", payload: { cash_spend_usd: 3.25 } },
      {
        type: "plan.progress",
        payload: { items: [{ id: "p1", title: "Keep early plan", status: "completed" }] },
      },
    ];
    const line = `${JSON.stringify({ type: "harness.event", payload: { text: "x".repeat(8192) } })}\n`;
    const fd = openSync(path, "w");
    try {
      writeSync(fd, prefix.map((event) => JSON.stringify(event)).join("\n") + "\n");
      const chunk = line.repeat(128);
      for (let i = 0; i < 25; i++) writeSync(fd, chunk);
    } finally {
      closeSync(fd);
    }
    expect(statSync(path).size).toBeGreaterThan(24 * 1024 * 1024);
    resetEventsParseCountForTests();
    const read = readRunEventsWithIntegrity({ runDir });
    expect(eventsParseCountForTests()).toBe(1);
    expect(read.events).toHaveLength(3202);
    expect(read.events.slice(0, 2)).toEqual(prefix);
    expect(read.integrity).toEqual({
      absent: false,
      unreadable: false,
      malformedLines: 0,
      nonObjectLines: 0,
    });
    expect(latestPlanProgress({}, null, read.events, read.integrity)?.items).toEqual(
      prefix[1]!.payload.items,
    );
  });

  it("preserves UTF-8 split across buffers, CRLF and a complete final line without newline", () => {
    const { runDir, path } = fixture();
    const prefix = '{"type":"harness.event","payload":{"text":"';
    const text = "a".repeat(64 * 1024 - Buffer.byteLength(prefix) - 1) + "🙂終わり";
    const first = { type: "harness.event", payload: { text } };
    const last = { type: "run.completed", payload: {} };
    writeFileSync(path, `${JSON.stringify(first)}\r\n${JSON.stringify(last)}`);
    const read = readRunEventsWithIntegrity({ runDir });
    expect(read.events).toEqual([first, last]);
    expect(read.integrity.malformedLines).toBe(0);
  });

  it("counts malformed and non-object lines without counting whitespace", () => {
    const { runDir, path } = fixture();
    writeFileSync(path, ' \r\n\n{broken\n[]\nnull\nfalse\n7\n"scalar"\n{"type":"last"}');
    const read = readRunEventsWithIntegrity({ runDir });
    expect(read.events).toEqual([{ type: "last" }]);
    expect(read.integrity).toMatchObject({ malformedLines: 1, nonObjectLines: 5 });
  });

  it("uses a finite descriptor snapshot while later appends remain available to the next read", () => {
    const { runDir, path } = fixture();
    writeFileSync(path, '{"seq":1,"type":"first"}\n');
    let appended = false;
    vi.mocked(readSync).mockImplementation((...args: Parameters<typeof readSync>) => {
      if (!appended) {
        appended = true;
        appendFileSync(path, '{"seq":2,"type":"later"}\n');
      }
      return actualFs.readSync(...args);
    });
    expect(readRunEventsWithIntegrity({ runDir }).events).toEqual([{ seq: 1, type: "first" }]);
    expect(readRunEventsWithIntegrity({ runDir }).events).toEqual([
      { seq: 1, type: "first" },
      { seq: 2, type: "later" },
    ]);
  });

  it("discloses a file shortened during the snapshot as unavailable", () => {
    const { runDir, path } = fixture();
    writeFileSync(path, '{"seq":1,"type":"first"}\n');
    vi.mocked(readSync).mockImplementation((...args: Parameters<typeof readSync>) => {
      truncateSync(path, 0);
      return actualFs.readSync(...args);
    });
    expect(readRunEventsWithIntegrity({ runDir })).toMatchObject({
      events: [],
      integrity: { unreadable: true, malformedLines: 0, nonObjectLines: 0 },
    });
  });
});
