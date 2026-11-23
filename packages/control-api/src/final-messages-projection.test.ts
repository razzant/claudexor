/**
 * #307 at the Control API: run detail serves the final-messages outcome the
 * run's first terminal recorded: its pointer only while the document still has
 * that size, otherwise a typed gap; null only when no terminal settled one. The
 * run artifact route transfers a recorded document exactly at any size; every
 * other artifact keeps its existing caps. Synthetic neutral run trees only.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { stringify } from "yaml";
import { readRunEvents, writeFinalMessages } from "@claudexor/event-log";
import {
  ControlRunDetail,
  ControlOperationCatalog,
  CONTROL_PROTOCOL_MAJOR,
  FINAL_MESSAGES_PATH,
  type FinalMessagesOutcome,
  type FinalMessagesPointer,
  type RunEvent,
} from "@claudexor/schema";
import { readArtifact } from "./artifact-read.js";
import { projectBulkJob } from "./bulk-worker.js";
import { streamFilesArtifact } from "./files-artifact-stream.js";
import {
  addFinalMessagesEvent,
  emptyFinalMessagesFold,
  projectedFinalMessages,
} from "./final-messages-projection.js";
import { detailFor } from "./run-projection.js";
import type { DaemonRunRecord } from "./run-record.js";
import { DaemonControlApiServer } from "./daemon-server.js";
import { releasedRunReader } from "../../schema/fixtures/run-results-6.2.0.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const TS = "2026-11-17T00:00:00.000Z";
const ACK = "The background check finished; its result is already in the report above.";
const GONE = { state: "unavailable", reason: "artifact_unavailable" } as const;

function event(seq: number, type: RunEvent["type"], payload: Record<string, unknown>): RunEvent {
  return { seq, ts: TS, run_id: "run-fm", task_id: "task-fm", type, payload };
}

const final = (seq: number, text: string) =>
  event(seq, "harness.event", {
    harness_id: "claude",
    attempt_id: "a01",
    session_id: "s1",
    type: "message",
    text,
    final: true,
  });

/**
 * A finished Ask run. `recorded` is what its terminal settled: "document" (the
 * producer's pointer), a typed gap, or "legacy" (an older engine recorded none).
 */
function finishedRun(report: string, recorded: "document" | "legacy" | FinalMessagesOutcome) {
  const runDir = mkdtempSync(join(tmpdir(), "cx-final-messages-api-"));
  roots.push(runDir);
  mkdirSync(join(runDir, "final"));
  writeFileSync(join(runDir, "final/answer.md"), `# Answer\n\n${ACK}\n`);
  const events = [event(1, "run.created", { mode: "ask" }), final(2, report), final(3, ACK)];
  const pointer = writeFinalMessages(runDir, "run-fm", { events, malformed: 0 });
  const outcome = recorded === "document" ? pointer : recorded === "legacy" ? null : recorded;
  const terminal = event(4, "run.completed", {
    lifecycle: "succeeded",
    ...(outcome ? { final_messages: outcome } : {}),
  });
  const path = join(runDir, "events.jsonl");
  writeFileSync(path, [...events, terminal].map((row) => `${JSON.stringify(row)}\n`).join(""));
  const record: DaemonRunRecord = {
    id: "job-fm",
    runId: "run-fm",
    taskId: "task-fm",
    state: "succeeded",
    runDir,
    params: { mode: "ask", scope: { kind: "project", root: runDir }, prompt: "fixture" },
  };
  const append = (row: RunEvent) => appendFileSync(path, `${JSON.stringify(row)}\n`);
  return { runDir, record, pointer, append };
}

function response() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      setImmediate(callback);
    },
  });
  return { stream: Object.assign(stream, { writeHead: vi.fn() }), chunks };
}

const sha256 = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const requestedDetail = (record: DaemonRunRecord) =>
  detailFor(record, [], undefined, null, [], { includeFinalMessages: true });

function fetchDocument(root: string, relative: string = FINAL_MESSAGES_PATH, runArtifact = true) {
  return readArtifact({ kind: "fetch", root, relative, runArtifact });
}

async function withRunApi(
  record: DaemonRunRecord,
  check: (get: (path: string) => Promise<Response>) => Promise<void>,
) {
  const token = "fixture";
  const server = new DaemonControlApiServer({
    token,
    daemon: {
      list: async (query) => ("delegatedFromRunId" in query ? [] : [record]),
      status: async () => record,
      enqueue: async () => {
        throw new Error("unexpected enqueue");
      },
      cancel: async () => {
        throw new Error("unexpected cancel");
      },
    },
  });
  const { host, port } = await server.start();
  const get = (path: string) =>
    fetch(`http://${host}:${port}/v2${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        "X-Claudexor-Protocol-Major": String(CONTROL_PROTOCOL_MAJOR),
      },
    });
  try {
    await check(get);
  } finally {
    await server.stop();
  }
}

describe("final-messages outcome fold", () => {
  const pointer: FinalMessagesPointer = {
    path: FINAL_MESSAGES_PATH,
    state: "complete",
    count: 2,
    bytes: 512,
    sha256: `sha256:${"a".repeat(64)}`,
    throughEventSeq: 3,
  };
  const fold = (rows: RunEvent[]) => {
    const state = emptyFinalMessagesFold();
    for (const row of rows) addFinalMessagesEvent(state, row as unknown as Record<string, unknown>);
    return state.outcome;
  };

  it("takes the first terminal's outcome; later rows never replace it", () => {
    const other = { ...pointer, count: 5, sha256: `sha256:${"b".repeat(64)}` };
    expect(
      fold([
        final(2, "Answer."),
        event(4, "run.completed", { final_messages: pointer }),
        event(5, "control.requested", { kind: "cancel" }),
        event(6, "run.failed", { final_messages: other }),
      ]),
    ).toEqual(pointer);
    const gap = { state: "unavailable", reason: "publication_failed" } as const;
    expect(fold([event(4, "run.failed", { final_messages: gap })])).toEqual(gap);
    // An older terminal recorded no outcome: unknown, even if a later row carries one.
    expect(
      fold([
        event(4, "run.completed", { lifecycle: "succeeded" }),
        event(5, "run.failed", { final_messages: other }),
      ]),
    ).toBeNull();
    expect(fold([final(2, "Answer.")])).toBeNull();
  });

  it.each([
    ["an unknown key", { ...pointer, extra: true }],
    ["another path", { ...pointer, path: "final/answer.md" }],
    ["a bare hex digest", { ...pointer, sha256: "a".repeat(64) }],
    ["coverage reaching its own terminal", { ...pointer, throughEventSeq: 4 }],
    ["an untyped gap reason", { state: "unavailable", reason: "disk full" }],
    ["a gap with error text", { state: "unavailable", reason: "publication_failed", error: "x" }],
    ["a gap claiming bytes", { ...pointer, state: "unavailable", reason: "publication_failed" }],
  ])("treats a terminal outcome with %s as unknown", (_label, recorded) => {
    expect(fold([event(4, "run.completed", { final_messages: recorded })])).toBeNull();
  });
});

describe("final-messages discovery and bytes over HTTP", () => {
  it("serves the 6.2.0 detail by default and negotiates a verified partial document", async () => {
    const r = finishedRun("Earlier note.", "document");
    const log = join(r.runDir, "events.jsonl");
    const notes = [final(1, "First note."), { type: "run.failed" }, final(3, ACK)];
    writeFileSync(log, notes.map((row) => JSON.stringify(row) + "\n").join(""));
    const source = readRunEvents(log);
    expect(source.malformed).toBe(1);
    const pointer = writeFinalMessages(r.runDir, "run-fm", source);
    r.append(event(4, "run.completed", { final_messages: pointer }));

    await withRunApi(r.record, async (get) => {
      const discovery = await get("/operations");
      expect(discovery.status).toBe(200);
      const catalog = (await discovery.json()) as ControlOperationCatalog;
      expect(ControlOperationCatalog.safeParse(catalog).success).toBe(true);
      const op = catalog.operations.find((entry) => entry.id === "get:runs.id");
      expect(op).toEqual({
        id: "get:runs.id",
        method: "GET",
        path: "/v2/runs/:id",
        summary: "Read a run's full detail snapshot.",
        auth: "loopback_bearer",
        applicability: "run",
        mutability: "read_only",
        idempotency: "natural",
        completion: "immediate",
        requestSchema: null,
        responseKind: "json",
        responseSchema: "ControlRunDetail",
        errorSchema: "ControlProblem",
        parameters: [
          {
            name: "includeFinalMessages",
            location: "query",
            required: false,
            repeatable: false,
            enum: ["true", "false"],
            schemaRef: null,
            description:
              "Include the recorded final-messages outcome. Omission or false keeps the original run detail.",
          },
        ],
      });
      const readAs620 = releasedRunReader("ControlRunDetail");
      for (const suffix of ["", "?includeFinalMessages=false"]) {
        const res = await get("/runs/run-fm" + suffix);
        expect(res.status).toBe(200);
        const plain = await res.json();
        expect(readAs620(plain), JSON.stringify(readAs620.errors)).toBe(true);
        expect(plain).not.toHaveProperty("finalMessages");
        expect(plain).toMatchObject({ primaryOutput: { text: expect.stringContaining(ACK) } });
      }
      const enriched = await get("/runs/run-fm?includeFinalMessages=true");
      expect(enriched.status).toBe(200);
      const detail = await enriched.json();
      expect(readAs620(detail)).toBe(false);
      const outcome = ControlRunDetail.parse(detail).finalMessages;
      expect(outcome).toEqual(pointer);
      if (!outcome || outcome.state === "unavailable") throw new Error("Expected a saved document");
      expect(pointer).toMatchObject({ state: "partial", count: 2, throughEventSeq: 3 });
      const artifact = `/runs/run-fm/artifacts/${outcome.path}`;
      const document = await get(artifact);
      expect(document.status).toBe(200);
      const bytes = Buffer.from(await document.arrayBuffer());
      expect(bytes.length).toBe(pointer.bytes);
      expect(sha256(bytes)).toBe(pointer.sha256);
      expect(
        bytes
          .toString()
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        { schemaVersion: 1, runId: "run-fm", state: "partial", count: 2, throughEventSeq: 3 },
        notes[0],
        notes[2],
      ]);
      writeFileSync(join(r.runDir, pointer.path), Buffer.alloc(bytes.length, 0x20));
      const mismatch = await get(artifact);
      expect(mismatch.status).toBe(409);
      expect(await mismatch.json()).toMatchObject({
        code: "final_messages_unavailable",
        context: { reason: "artifact_unavailable" },
      });
      const gap = { state: "unavailable", reason: "publication_failed" };
      writeFileSync(log, `${JSON.stringify(event(4, "run.completed", { final_messages: gap }))}\n`);
      const withGap = await get("/runs/run-fm?includeFinalMessages=true");
      expect(await withGap.json()).toMatchObject({ finalMessages: gap });
      const unavailable = await get(artifact);
      expect(unavailable.status).toBe(409);
      expect(await unavailable.json()).toMatchObject({
        code: "final_messages_unavailable",
        context: { reason: gap.reason },
      });
      const malformed = await get("/runs/run-fm?includeFinalMessages=notes");
      expect(malformed.status).toBe(400);
    });
  });
});

describe("final-messages outcome on run detail", () => {
  it("serves the recorded pointer beside the unchanged primary output", async () => {
    const r = finishedRun("# Review\n\nA substantive generated report.", "document");
    r.append(event(5, "control.requested", { kind: "cancel" }));
    const detail = ControlRunDetail.parse(requestedDetail(r.record));
    expect(detail.finalMessages).toEqual(r.pointer);
    expect(detail.primaryOutput).toMatchObject({ kind: "answer", path: "final/answer.md" });
    expect(detail.primaryOutput?.text).toBe(`# Answer\n\n${ACK}\n`);
    const kept = (await projectBulkJob(
      {
        kind: "detail",
        input: {
          record: r.record,
          cursor: 5,
          pending: [],
          operator: null,
          children: [],
          includeFinalMessages: true,
        },
      },
      async () => null,
    )) as string;
    expect(ControlRunDetail.parse(JSON.parse(kept)).finalMessages).toEqual(r.pointer);
  });

  it.each([["source_unreadable"], ["publication_failed"]] as const)(
    "serves a %s gap its terminal settled, with no address",
    (reason) => {
      const r = finishedRun("Report.", { state: "unavailable", reason });
      expect(requestedDetail(r.record).finalMessages).toEqual({ state: "unavailable", reason });
      expect(fetchDocument(r.runDir)).toMatchObject({
        kind: "error",
        status: 409,
        body: { code: "final_messages_unavailable", reason },
      });
      expect(detailFor(r.record, []).primaryOutput?.text).toBe(`# Answer\n\n${ACK}\n`);
    },
  );

  it("states a gap for a recorded document that is gone, resized or replaced by a link", () => {
    const resized = finishedRun("Report.", "document");
    appendFileSync(join(resized.runDir, FINAL_MESSAGES_PATH), "\n");
    expect(requestedDetail(resized.record).finalMessages).toEqual(GONE);
    expect(projectedFinalMessages(resized.runDir, resized.pointer)).toEqual(GONE);

    const missing = finishedRun("Report.", "document");
    rmSync(join(missing.runDir, FINAL_MESSAGES_PATH));
    expect(requestedDetail(missing.record).finalMessages).toEqual(GONE);

    const linked = finishedRun("Report.", "document");
    const elsewhere = join(linked.runDir, "copy.jsonl");
    writeFileSync(elsewhere, readFileSync(join(linked.runDir, FINAL_MESSAGES_PATH)));
    rmSync(join(linked.runDir, FINAL_MESSAGES_PATH));
    symlinkSync(elsewhere, join(linked.runDir, FINAL_MESSAGES_PATH));
    expect(requestedDetail(linked.record).finalMessages).toEqual(GONE);
    for (const run of [resized, missing, linked]) {
      expect(fetchDocument(run.runDir)).toMatchObject({
        kind: "error",
        status: 409,
        body: { code: "final_messages_unavailable", reason: GONE.reason },
      });
    }
  });

  it("is null, never a guessed list or a debt, when no terminal settled an outcome", () => {
    const legacy = finishedRun("Report.", "legacy");
    expect(requestedDetail(legacy.record).finalMessages).toBeNull();

    const active = finishedRun("Report.", "document");
    writeFileSync(
      join(active.runDir, "events.jsonl"),
      `${JSON.stringify(event(1, "run.created", { mode: "ask" }))}\n`,
    );
    expect(requestedDetail({ ...active.record, state: "running" }).finalMessages).toBeNull();
    expect(fetchDocument(active.runDir)).toMatchObject({
      kind: "error",
      status: 404,
      body: { code: "final_messages_unknown" },
    });
    expect(projectedFinalMessages(active.runDir, null)).toBeNull();
  });

  it("refuses an incomplete declaration while the file still exists", () => {
    const r = finishedRun("Saved note.", "document");
    const terminal = event(4, "run.completed", { final_messages: { state: "complete" } });
    writeFileSync(join(r.runDir, "events.jsonl"), `${JSON.stringify(terminal)}\n`);
    expect(requestedDetail(r.record).finalMessages).toBeNull();
    expect(fetchDocument(r.runDir)).toMatchObject({
      kind: "error",
      status: 409,
      body: { code: "final_messages_invalid" },
    });
  });
});

describe("final-messages document through the run artifact route", () => {
  const large = `# Review\n\n${"generated line of a long report\n".repeat(140_000)}`;

  it("serves the full JSONL over loopback HTTP above 4 MiB and keeps the ordinary primary answer", async () => {
    const r = finishedRun(large, "document");
    const header = {
      schemaVersion: 1,
      runId: "run-fm",
      state: "complete",
      count: 2,
      throughEventSeq: 3,
    };
    const expected = Buffer.from(
      [header, final(2, large), final(3, ACK)].map((row) => JSON.stringify(row) + "\n").join(""),
    );
    expect(expected.byteLength).toBeGreaterThan(4 * 1024 * 1024);
    await withRunApi(r.record, async (get) => {
      const plain = await get("/runs/run-fm");
      expect(plain.status).toBe(200);
      const ordinary = ControlRunDetail.parse(await plain.json());
      expect(ordinary).not.toHaveProperty("finalMessages");
      expect(ordinary.primaryOutput).toMatchObject({
        kind: "answer",
        path: "final/answer.md",
        text: `# Answer\n\n${ACK}\n`,
      });
      const enriched = await get("/runs/run-fm?includeFinalMessages=true");
      expect(enriched.status).toBe(200);
      const { primaryOutput, finalMessages } = ControlRunDetail.parse(await enriched.json());
      expect(primaryOutput).toEqual(ordinary.primaryOutput);
      if (!finalMessages || finalMessages.state === "unavailable")
        throw new Error("Expected a document");
      expect(finalMessages).toMatchObject({
        path: FINAL_MESSAGES_PATH,
        state: "complete",
        count: 2,
        bytes: expected.byteLength,
        sha256: sha256(expected),
      });
      const response = await get(`/runs/run-fm/artifacts/${finalMessages.path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(String(expected.byteLength));
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(sha256(bytes)).toBe(finalMessages.sha256);
      expect(bytes.equals(expected)).toBe(true);
    });
  });

  it("uses the verified transfer for equivalent document names", () => {
    const r = finishedRun("Saved note.", "document");
    const transfer = fetchDocument(r.runDir);
    expect(transfer).toMatchObject({
      kind: "files",
      transfer: {
        kind: "final_messages",
        expectedHash: r.pointer.sha256,
        expectedSize: r.pointer.bytes,
      },
    });
    for (const name of ["final/./final-messages.jsonl", "final\\final-messages.jsonl"]) {
      expect(fetchDocument(r.runDir, name)).toEqual(transfer);
    }
    const saved = "final/saved-notes.jsonl";
    linkSync(join(r.runDir, FINAL_MESSAGES_PATH), join(r.runDir, saved));
    expect(fetchDocument(r.runDir, saved)).toEqual(transfer);
    const mixedCase = "final/Final-Messages.jsonl";
    if (existsSync(join(r.runDir, mixedCase))) {
      expect(fetchDocument(r.runDir, mixedCase)).toEqual(transfer);
    } else {
      // On this volume the spelling names a separate directory entry.
      writeFileSync(join(r.runDir, mixedCase), "Independent note.\n");
      const note = fetchDocument(r.runDir, mixedCase);
      if (note.kind !== "body") throw new Error("Expected an ordinary artifact");
      expect(Buffer.from(note.body).toString()).toBe("Independent note.\n");
    }
  });

  it("transfers more than 4 MiB exactly, with its size and digest checked before any header", async () => {
    const r = finishedRun(large, "document");
    const bytes = readFileSync(join(r.runDir, FINAL_MESSAGES_PATH));
    expect(bytes.byteLength).toBeGreaterThan(4 * 1024 * 1024);
    expect(r.pointer).toMatchObject({ bytes: bytes.byteLength, sha256: sha256(bytes), count: 2 });
    const result = readArtifact({
      kind: "fetch",
      root: r.runDir,
      relative: FINAL_MESSAGES_PATH,
      runArtifact: true,
    });
    if (result.kind !== "files") throw new Error("Expected the exact document transfer");
    // A plain descriptor crosses the worker boundary; the bytes stream on the serving side.
    expect(structuredClone(result)).toEqual(result);
    expect(result.transfer).toEqual({
      path: realpathSync(join(r.runDir, FINAL_MESSAGES_PATH)),
      expectedHash: r.pointer.sha256,
      expectedSize: r.pointer.bytes,
      contentType: "text/plain; charset=utf-8",
      kind: "final_messages",
    });
    const { stream, chunks } = response();
    await streamFilesArtifact(result.transfer, stream as unknown as ServerResponse);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    expect(stream.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": bytes.byteLength,
      ETag: `"${r.pointer.sha256}"`,
    });

    // Same size, other bytes: refused before any header is sent.
    writeFileSync(join(r.runDir, FINAL_MESSAGES_PATH), Buffer.alloc(bytes.byteLength, 0x78));
    const changed = response();
    await expect(
      streamFilesArtifact(result.transfer, changed.stream as unknown as ServerResponse),
    ).rejects.toThrow("Final messages artifact digest mismatch");
    expect(changed.stream.writeHead).not.toHaveBeenCalled();
    expect(changed.chunks).toEqual([]);
    changed.stream.destroy();
  });

  it("keeps every other cap: other large text, an unrecorded document and non-run roots", () => {
    const r = finishedRun(large, "document");
    writeFileSync(join(r.runDir, "final/report.md"), large);
    expect(fetchDocument(r.runDir, "final/report.md")).toMatchObject({
      kind: "error",
      status: 413,
    });
    // Outside the run artifact route the document is an ordinary capped file.
    expect(fetchDocument(r.runDir, FINAL_MESSAGES_PATH, false)).toMatchObject({
      kind: "error",
      status: 413,
    });
    const legacy = finishedRun(large, "legacy");
    expect(fetchDocument(legacy.runDir)).toMatchObject({ kind: "error", status: 413 });
    const note = "Earlier notes.\n";
    writeFileSync(join(legacy.runDir, FINAL_MESSAGES_PATH), note);
    const read = fetchDocument(legacy.runDir);
    expect(read.kind === "body" && Buffer.from(read.body).toString()).toBe(note);
  });

  it("answers a reclaimed run with its tombstone, before any outcome is read", () => {
    const r = finishedRun("Report.", "document");
    writeFileSync(
      join(r.runDir, "tombstone.yaml"),
      stringify({ run_id: "run-fm", deleted_at: "2026-11-17T01:00:00.000Z", reason: "retention" }),
    );
    expect(
      readArtifact({
        kind: "fetch",
        root: r.runDir,
        relative: FINAL_MESSAGES_PATH,
        runArtifact: true,
      }),
    ).toMatchObject({ kind: "error", status: 410, body: { code: "run_expired_by_retention" } });
  });
});
