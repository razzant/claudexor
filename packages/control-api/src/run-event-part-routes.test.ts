import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlRunEventPart, RunEvent } from "@claudexor/schema";
import {
  DaemonControlApiServer,
  type DaemonFacadeClient,
  type DaemonRunRecord,
} from "./daemon-server.js";
import { handleRunEventPartRoute } from "./run-event-part-routes.js";
import { sseDataLine } from "./sse-shared.js";

const token = "daemon-token-event-part";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SECRET = `ghp_${"a".repeat(36)}`;
// Multi-byte content forces part boundaries inside characters to back off.
const PROMPT = `${"Ж🙂确".repeat(20_000)} ${SECRET}`;

function record(): DaemonRunRecord {
  const runDir = mkdtempSync(join(tmpdir(), "claudexor-event-part-"));
  dirs.push(runDir);
  const line = (value: Record<string, unknown>) => `${JSON.stringify(value)}\n`;
  const base = { ts: "2026-10-19T00:00:00.000Z", run_id: "run-e1", task_id: "task-e1" };
  writeFileSync(
    join(runDir, "events.jsonl"),
    line({ ...base, seq: 1, type: "run.created", payload: { prompt: PROMPT } }) +
      line({ ...base, seq: 2, type: "harness.event", payload: { text: "small" } }) +
      "not json at all\n" +
      line({ ...base, type: "harness.event", payload: { text: "legacy line" } }),
  );
  return { id: "job-e1", runId: "run-e1", taskId: "task-e1", state: "running", runDir };
}

function facade(records: DaemonRunRecord[]): DaemonFacadeClient {
  return {
    enqueue: async () => {
      throw new Error("enqueue is not part of this suite");
    },
    status: async (id) => records.find((r) => r.id === id || r.runId === id)!,
    list: async (query) => {
      const id = (query as { id?: string } | undefined)?.id;
      return id ? records.filter((r) => r.id === id || r.runId === id) : records;
    },
    cancel: async () => ({}),
  };
}

async function withServer(records: DaemonRunRecord[], fn: (base: string) => Promise<void>) {
  const server = new DaemonControlApiServer({ token, daemon: facade(records), pollMs: 5 });
  const { host, port } = await server.start();
  try {
    await fn(`http://${host}:${port}/v2`);
  } finally {
    await server.stop();
  }
}

const get = (base: string, path: string) =>
  fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}`, "X-Claudexor-Protocol-Major": "3" },
  });

/** The data line the run event stream delivers for its first frame. */
async function firstStreamData(base: string, runId: string): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(`${base}/runs/${runId}/events`, {
    headers: {
      authorization: `Bearer ${token}`,
      "X-Claudexor-Protocol-Major": "3",
      "Last-Event-ID": "0",
    },
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    const frame = text.indexOf("\n\n", text.indexOf("id: 1\n"));
    if (text.includes("id: 1\n") && frame >= 0) break;
  }
  controller.abort();
  const start = text.indexOf("data: ", text.indexOf("id: 1\n")) + "data: ".length;
  return text.slice(start, text.indexOf("\n", start));
}

describe("GET /v2/runs/:id/events/:seq parts", () => {
  it("reassembles the exact stream serialization from bounded character-safe parts", async () => {
    const rec = record();
    await withServer([rec], async (base) => {
      const parts: ControlRunEventPart[] = [];
      let offset = 0;
      for (;;) {
        const response = await get(base, `/runs/job-e1/events/1?offset=${offset}&limit=4097`);
        expect(response.status).toBe(200);
        const part = ControlRunEventPart.parse(await response.json());
        parts.push(part);
        // Bounded, never splitting a character, and never empty.
        expect(part.nextOffset - part.offset).toBeGreaterThan(0);
        expect(part.nextOffset - part.offset).toBeLessThanOrEqual(4097);
        expect(Buffer.byteLength(part.text)).toBe(part.nextOffset - part.offset);
        offset = part.nextOffset;
        if (offset === part.totalBytes) break;
      }
      expect(parts.length).toBeGreaterThan(20);
      expect(new Set(parts.map((p) => p.runId))).toEqual(new Set(["run-e1"]));
      const text = parts.map((p) => p.text).join("");
      const bytes = Buffer.from(text, "utf8");
      expect(bytes.length).toBe(parts[0]!.totalBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(parts[0]!.sha256);
      expect(text).toBe(await firstStreamData(base, "run-e1"));
      expect(text).toContain(SECRET);
      expect(RunEvent.parse(JSON.parse(text))).toMatchObject({ seq: 1, type: "run.created" });
    });
  });

  it("refuses an offset inside a character instead of splitting it", async () => {
    await withServer([record()], async (base) => {
      const head = ControlRunEventPart.parse(
        await (await get(base, "/runs/run-e1/events/1?limit=200")).json(),
      );
      const firstMultibyte = Buffer.byteLength(head.text.slice(0, head.text.indexOf("Ж")));
      const inside = await get(base, `/runs/run-e1/events/1?offset=${firstMultibyte + 1}`);
      expect(inside.status).toBe(400);
      expect(await inside.json()).toMatchObject({ code: "invalid_request" });
      const at = await get(base, `/runs/run-e1/events/1?offset=${firstMultibyte}&limit=5`);
      // "Ж" is 2 bytes and "🙂" 4: five bytes would split the emoji, so the part backs off.
      expect(ControlRunEventPart.parse(await at.json())).toMatchObject({
        offset: firstMultibyte,
        nextOffset: firstMultibyte + 2,
        text: "Ж",
      });
    });
  });

  it("addresses legacy lines by the stream's line-number id and refuses malformed lines", async () => {
    await withServer([record()], async (base) => {
      const legacy = await get(base, "/runs/run-e1/events/4");
      expect(legacy.status).toBe(200);
      expect(ControlRunEventPart.parse(await legacy.json())).toMatchObject({
        seq: 4,
        type: "harness.event",
        offset: 0,
      });
      const malformed = await get(base, "/runs/run-e1/events/3");
      expect(malformed.status).toBe(422);
      expect(await malformed.json()).toMatchObject({ code: "run_event_invalid" });
    });
  });

  it.each([
    ["/runs/run-e1/events/1?limit=3", "invalid_request"],
    ["/runs/run-e1/events/1?limit=65537", "invalid_request"],
    ["/runs/run-e1/events/1?offset=-1", "invalid_request"],
    ["/runs/run-e1/events/01", "invalid_request"],
    ["/runs/run-e1/events/0", "invalid_request"],
    ["/runs/run-e1/events/1?path=events.jsonl", "invalid_request"],
    ["/runs/run-e1/events/2?offset=999999", "invalid_request"],
  ])("refuses %s before reading parts", async (path, code) => {
    await withServer([record()], async (base) => {
      const response = await get(base, path);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code });
    });
  });

  it("separates unknown runs, absent events, unbound jobs and retained-out runs", async () => {
    const rec = record();
    const queued: DaemonRunRecord = { id: "job-q", state: "queued" };
    const expired = record();
    expired.id = "job-x";
    expired.runId = "run-x";
    writeFileSync(
      join(expired.runDir!, "tombstone.yaml"),
      "run_id: run-x\ndeleted_at: 2026-10-01T00:00:00.000Z\nreason: retention\n",
    );
    await withServer([rec, queued, expired], async (base) => {
      expect((await get(base, "/runs/run-none/events/1")).status).toBe(404);
      const absent = await get(base, "/runs/run-e1/events/99");
      expect(absent.status).toBe(404);
      expect(await absent.json()).toMatchObject({ code: "run_event_not_found" });
      const unbound = await get(base, "/runs/job-q/events/1");
      expect(unbound.status).toBe(404);
      expect(await unbound.json()).toMatchObject({ code: "run_event_not_found" });
      const gone = await get(base, "/runs/run-x/events/1");
      expect(gone.status).toBe(410);
      expect(await gone.json()).toMatchObject({ code: "run_expired_by_retention" });
    });
  });

  it("does not serve an unterminated tail the stream has not delivered", async () => {
    const rec = record();
    appendFileSync(
      join(rec.runDir!, "events.jsonl"),
      JSON.stringify({ seq: 5, ts: "t", run_id: "run-e1", task_id: "task-e1", type: "run.failed" }),
    );
    await withServer([rec], async (base) => {
      expect((await get(base, "/runs/run-e1/events/5")).status).toBe(404);
    });
  });

  it("addresses every line exactly as the event stream names it", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "claudexor-event-part-ids-"));
    dirs.push(runDir);
    const json = (value: Record<string, unknown>) =>
      JSON.stringify({ ts: "2026-10-19T00:00:00.000Z", run_id: "run-i1", task_id: "t", ...value });
    const later = json({ type: "harness.event", payload: {} }).slice(1);
    writeFileSync(
      join(runDir, "events.jsonl"),
      [
        json({ seq: 1, type: "run.created", payload: {} }),
        "", // blank lines are never counted
        "not json at all",
        "null",
        json({ type: "harness.event", payload: { text: "legacy" } }),
        `{"seq":"9",${later}`, // a non-number seq falls back to the line number
        `{"seq":1e400,${later}`, // so does a non-finite one
        `${json({ seq: 70, type: "harness.event", payload: {} })}\r`,
      ].join("\n") + "\n",
    );
    const rec: DaemonRunRecord = { id: "job-i1", runId: "run-i1", state: "running", runDir };
    await withServer([rec], async (base) => {
      const frames = await streamFrames(base, "run-i1", 7);
      expect(frames.map(({ id, event }) => [id, event])).toEqual([
        [1, "run.created"],
        [2, "malformed"],
        [3, "malformed"],
        [4, "harness.event"],
        [5, "harness.event"],
        [6, "harness.event"],
        [70, "harness.event"],
      ]);
      for (const frame of frames) {
        const response = await get(base, `/runs/run-i1/events/${frame.id}?limit=65536`);
        if (![1, 4, 70].includes(frame.id)) {
          // Named by the stream, yet no valid event: typed and never readable as parts.
          expect(response.status).toBe(422);
          expect(await response.json()).toMatchObject({ code: "run_event_invalid" });
          continue;
        }
        expect(response.status).toBe(200);
        const part = ControlRunEventPart.parse(await response.json());
        expect(part).toMatchObject({ seq: frame.id, type: frame.event, offset: 0 });
        expect(part.nextOffset).toBe(part.totalBytes);
        expect(part.text).toBe(frame.data);
      }
      // A line with its own seq is not also addressable by its line number.
      expect((await get(base, "/runs/run-i1/events/7")).status).toBe(404);
    });
  });
});

/** The first `count` data frames the run event stream delivers from the start. */
async function streamFrames(base: string, runId: string, count: number) {
  const controller = new AbortController();
  const response = await fetch(`${base}/runs/${runId}/events`, {
    headers: {
      authorization: `Bearer ${token}`,
      "X-Claudexor-Protocol-Major": "3",
      "Last-Event-ID": "0",
    },
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: { id: number; event: string; data: string }[] = [];
  let text = "";
  while (frames.length < count) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    for (let end = text.indexOf("\n\n"); end >= 0; end = text.indexOf("\n\n")) {
      const fields = new Map(
        text
          .slice(0, end)
          .split("\n")
          .map((line) => [line.slice(0, line.indexOf(": ")), line.slice(line.indexOf(": ") + 2)]),
      );
      text = text.slice(end + 2);
      if (fields.has("data"))
        frames.push({
          id: Number(fields.get("id")),
          event: fields.get("event")!,
          data: fields.get("data")!,
        });
    }
  }
  controller.abort();
  return frames;
}

/** A long valid history ahead of one oversized multi-byte event. */
function longHistory(rows: number) {
  const runDir = mkdtempSync(join(tmpdir(), "claudexor-event-part-long-"));
  dirs.push(runDir);
  const row = (seq: number, type: string, text: string) =>
    JSON.stringify({
      seq,
      ts: "2026-10-20T00:00:00.000Z",
      run_id: "run-l1",
      task_id: "t",
      type,
      payload: { text },
    });
  let history = "";
  for (let seq = 1; seq <= rows; seq += 1)
    history += `${row(seq, "harness.event", "x".repeat(1_000))}\n`;
  const raw = row(rows + 1, "message.accepted", "漢".repeat(60_000));
  writeFileSync(join(runDir, "events.jsonl"), `${history}${raw}\n`);
  const rec: DaemonRunRecord = { id: "job-l1", runId: "run-l1", state: "running", runDir };
  return { rec, raw, seq: rows + 1, historyBytes: Buffer.byteLength(history) };
}

/** One part through the route owner, counting event-loop turns while it is in flight. */
async function partWithTurns(rec: DaemonRunRecord, seq: number, offset: number) {
  let turns = 0;
  let inFlight = true;
  const tick = () => {
    if (!inFlight) return;
    turns += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  const reply: { status?: number; body?: unknown } = {};
  const url = new URL(`http://daemon/runs/${rec.runId}/events/${seq}?offset=${offset}`);
  await handleRunEventPartRoute(
    {
      findRun: async () => rec,
      json: (_res, status, body) => Object.assign(reply, { status, body }),
    },
    "GET",
    url.pathname,
    url,
    {} as ServerResponse,
  );
  inFlight = false;
  return { ...reply, turns };
}

describe("GET /v2/runs/:id/events/:seq behind a long history", () => {
  it("keeps the event loop turning through every part's scan and reassembles the exact bytes", async () => {
    const { rec, raw, seq, historyBytes } = longHistory(4_000);
    const parts: ControlRunEventPart[] = [];
    let offset = 0;
    do {
      const { status, body, turns } = await partWithTurns(rec, seq, offset);
      expect(status).toBe(200);
      // The scan yields after every bounded 64 KiB read instead of blocking the daemon.
      expect(turns).toBeGreaterThanOrEqual(Math.floor(historyBytes / 65_536));
      const part = ControlRunEventPart.parse(body);
      parts.push(part);
      offset = part.nextOffset;
    } while (offset < parts[0]!.totalBytes);
    const expected = sseDataLine(raw);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((part) => part.text).join("")).toBe(expected);
    expect(parts[0]!.sha256).toBe(createHash("sha256").update(expected).digest("hex"));
  });

  it("answers retention's 410 when the run is reclaimed while its history is scanned", async () => {
    const { rec, seq } = longHistory(4_000);
    // Retention publishes the tombstone before removing any file (retention-removal.ts).
    setImmediate(() =>
      writeFileSync(
        join(rec.runDir!, "tombstone.yaml"),
        "run_id: run-l1\ndeleted_at: 2026-10-20T00:00:00.000Z\nreason: retention\n",
      ),
    );
    const { status, body } = await partWithTurns(rec, seq, 0);
    expect(status).toBe(410);
    expect(body).toMatchObject({ code: "run_expired_by_retention" });
  });
});
