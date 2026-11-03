/**
 * What a recorded real Claude session proves about thread export, through the
 * real adapter declaration, store walk, transfer and retirement. The structural
 * fixture keeps a recording's layout, record types and keys with every value
 * replaced. Pointing CLAUDEXOR_TEST_REAL_CLAUDE_FIXTURE at the private recording
 * reruns the same proof over its exact bytes; those never enter this repository.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  EngineStore,
  createPartition,
  createSqlDaemonServices,
  currentGeneration,
  setGlobalGenerationInTx,
} from "@claudexor/daemon";
import { threadExportDigest } from "@claudexor/schema";
import { noProjectRepoRoot, projectRuntimeDir } from "@claudexor/util";
import { applyCommandInTx, prepareCommandRow } from "../../daemon/src/store/command-rows.js";
import { registerConfigDirProfile } from "./profile-registration.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";
import { laneCredentialStores, threadExportService } from "./thread-export-services.js";
import { threadPurgeEffect, threadPurgeOwner } from "./thread-purge.js";

interface Recording {
  sessionId: string;
  storeDir: string;
  files: { rel: string; sizeBytes: number; sha256: string }[];
}

function recording(): Recording {
  const real = process.env["CLAUDEXOR_TEST_REAL_CLAUDE_FIXTURE"];
  if (real) {
    const provenance = JSON.parse(readFileSync(join(real, "provenance.json"), "utf8")) as {
      nativeSessionId: string;
    };
    const candidates = JSON.parse(readFileSync(join(real, "candidates.json"), "utf8")) as {
      relpath: string;
      type?: string;
      state: string;
      sizeBytes: number;
      sha256: string;
    }[];
    return {
      sessionId: provenance.nativeSessionId,
      storeDir: join(real, "bytes"),
      files: candidates
        .filter((row) => row.state === "present" && row.type === "file")
        .map((row) => ({ rel: row.relpath, sizeBytes: row.sizeBytes, sha256: row.sha256 })),
    };
  }
  const dir = resolve(import.meta.dirname, "../../harness-claude/fixtures/native-session/2.1.316");
  const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as {
    nativeSessionId: string;
    present: Recording["files"];
  };
  return {
    sessionId: expected.nativeSessionId,
    storeDir: join(dir, "store"),
    files: expected.present,
  };
}

/** The one platform a real session was recorded on; a test of another holds every copy. */
const RECORDED = "darwin";
/** Every gap but the one this host's own platform adds, wherever these tests run. */
const beyondPlatform = (manifest: { gaps: { message: string }[] }) =>
  manifest.gaps.filter((gap) => !gap.message.includes("no recording exercised a session on"));

/** Report another platform to one call: only `proveCopy` asks, and no file call depends on it. */
async function onPlatform<T>(platform: string, read: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return await read();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

const cleanup: (() => Promise<void>)[] = [];
const removals: (() => void)[] = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a late close never reaches the next test's.
  const ownedRemovals = removals.splice(0).reverse();
  for (const close of cleanup.splice(0).reverse()) await close();
  return () => {
    vi.unstubAllEnvs();
    for (const remove of ownedRemovals) remove();
  };
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cx-claude-fixture-"));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  // A private config root per test: the shared sandbox store must not hold another copy.
  vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(root, "config"));
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
  });
  if (!currentGeneration(store, "global"))
    store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  const noProject = noProjectRepoRoot();
  const graph = createSqlDaemonServices(store, {
    purgeFiles: threadPurgeEffect(noProject, laneCredentialStores),
  });
  cleanup.push(async () => {
    await graph.close();
    await store.close();
  });
  const owner = threadPurgeOwner(graph.threads, noProject, graph.purgeFiles, laneCredentialStores);
  const service = threadExportService(
    graph.threads,
    { resolve: () => [] },
    (thread) => owner.finishPurge(thread),
    (thread) => owner.hasPurgeLeftovers(thread),
  );
  const thread = graph.threads.createThread({ title: "seat" });
  const pid = graph.threads.generationForThread(thread.id)!.pid;
  const lanes = join(projectRuntimeDir(noProject), "lanes", thread.id);
  const seed = (sessionId: string) => {
    const turn = graph.threads.createTurn(thread.id, "question");
    const runDir = join(root, "runs", "run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "events.jsonl"),
      `${JSON.stringify({
        type: "harness.event",
        payload: {
          harness_id: "claude",
          attempt_id: "a01",
          type: "started",
          payload: { native_session_id: sessionId },
        },
      })}\n`,
    );
    const prepared = prepareCommandRow(
      {
        id: "job-1",
        runId: "run-1",
        runDir,
        taskId: "task-1",
        state: "succeeded",
        createdAt: "2026-11-01T10:00:00.000Z",
        finishedAt: "2026-11-01T10:00:02.000Z",
        params: { mode: "ask", prompt: "question", threadId: thread.id, turnId: turn.id },
      },
      { pid, live: true, operation: "ask", clientId: null },
      (bytes) => graph.blobs.prepareBody(bytes),
    );
    store.transaction(() => applyCommandInTx(store, prepared, "accept"));
    graph.threads.bindTurnRun(turn.id, "run-1");
  };
  return { root, graph, service, thread, lanes, seed };
}

async function receive(
  service: Awaited<ReturnType<typeof fixture>>["service"],
  threadId: string,
  exportId: string,
  itemId: string,
) {
  const chunks: Buffer[] = [];
  const headers: Record<string, unknown> = {};
  const res = Object.assign(new PassThrough(), {
    writeHead: (_status: number, values: Record<string, unknown>) => Object.assign(headers, values),
  });
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  await service.transferThreadExportItem(threadId, exportId, itemId, res as never);
  return { bytes: Buffer.concat(chunks), etag: String(headers["ETag"]).replaceAll('"', "") };
}

async function storeRoot(): Promise<string> {
  const { defaultNativeClaudeConfigDir } = await import("@claudexor/harness-claude");
  const dir = defaultNativeClaudeConfigDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("a recorded Claude session", () => {
  it("publishes structure only: the checked-in fixture holds no recorded value", () => {
    if (process.env["CLAUDEXOR_TEST_REAL_CLAUDE_FIXTURE"]) return;
    const recorded = recording();
    const strings = new Set<string>();
    const visit = (value: unknown): void => {
      if (typeof value === "string") strings.add(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    const transcript = recorded.files.find((file) => file.rel.endsWith(".jsonl"))!;
    for (const line of readFileSync(join(recorded.storeDir, transcript.rel), "utf8")
      .trim()
      .split("\n"))
      visit(JSON.parse(line));
    const allowed = new Set([
      "x",
      "2.1.316",
      recorded.sessionId,
      `projects/-fixture-cwd/${recorded.sessionId}/tool-results/spilled.txt`,
    ]);
    // Only placeholders and short lowercase vendor discriminators.
    expect(
      [...strings].filter((text) => !allowed.has(text) && !/^[a-z][a-z0-9_-]{0,40}$/.test(text)),
    ).toEqual([]);
  });

  it("declares the platform its provenance records, and nothing else", async () => {
    const { createClaudeAdapter } = await import("@claudexor/harness-claude");
    const dir = resolve(
      import.meta.dirname,
      "../../harness-claude/fixtures/native-session/2.1.316",
    );
    const { platform } = JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8")) as {
      platform: string;
    };
    expect(platform.split("-")[0]).toBe(RECORDED);
    expect(createClaudeAdapter().nativeSessionExport?.formatEvidence?.platforms).toEqual([
      RECORDED,
    ]);
  });

  it("is held on any other platform: its bytes export exactly, and the thread cannot retire", async () => {
    const recorded = recording();
    const f = await fixture();
    cpSync(recorded.storeDir, await storeRoot(), { recursive: true });
    f.seed(recorded.sessionId);
    const other = process.platform === RECORDED ? "linux" : process.platform;
    const manifest = await onPlatform(other, () => f.service.threadExportManifest(f.thread.id));
    expect(manifest.retirable).toBe(false);
    expect(manifest.coverage).toBe("partial");
    expect(manifest.gaps).toEqual([
      expect.objectContaining({
        code: "native_format_unqualified",
        subject: recorded.sessionId,
        message: `claude: no recording exercised a session on ${other}`,
      }),
    ]);
    expect(manifest.sessions).toEqual([
      expect.objectContaining({ harness: "claude", status: "unqualified" }),
    ]);
    expect(
      manifest.items
        .filter((item) => item.plane === "native")
        .map((item) => item.path.replace("native/claude/default/", ""))
        .sort(),
    ).toEqual(recorded.files.map((file) => file.rel).sort());
    const transcript = manifest.items.find(
      (item) => item.plane === "native" && item.path.endsWith(".jsonl"),
    )!;
    const held = await onPlatform(other, () =>
      receive(f.service, f.thread.id, manifest.exportId, transcript.itemId),
    );
    expect(createHash("sha256").update(held.bytes).digest("hex")).toBe(
      recorded.files.find((file) => file.rel.endsWith(".jsonl"))!.sha256,
    );
  });

  it("exports byte-exact, qualifies, retires, and stays readable after its sources are gone", async ({
    skip,
  }) => {
    skip(process.platform !== RECORDED, "the only recording is Darwin's");
    const recorded = recording();
    const f = await fixture();
    const store = await storeRoot();
    cpSync(recorded.storeDir, store, { recursive: true });
    mkdirSync(join(store, "session-env", recorded.sessionId), { recursive: true });
    writeFileSync(join(store, ".credentials.json"), "CREDENTIAL-SENTINEL");
    f.seed(recorded.sessionId);
    mkdirSync(f.lanes, { recursive: true });
    writeFileSync(join(f.lanes, "marker.txt"), "lane bytes\n");

    const manifest = await f.service.threadExportManifest(f.thread.id);
    expect(manifest.gaps).toEqual([]);
    expect(manifest.coverage).toBe("complete");
    expect(manifest.retirable).toBe(true);
    expect(manifest.sessions).toEqual([
      expect.objectContaining({ harness: "claude", status: "exported" }),
    ]);
    // What the recording cannot prove is named on the manifest, never implied.
    expect(manifest.disclosures.map((d) => d.source)).toContain("history.jsonl");

    const native = manifest.items.filter((item) => item.plane === "native");
    expect(native.map((item) => item.path.replace("native/claude/default/", "")).sort()).toEqual(
      recorded.files.map((file) => file.rel).sort(),
    );
    expect(JSON.stringify(manifest)).not.toContain(".credentials.json");

    const received = new Map<string, Buffer>();
    const digests: { itemId: string; sha256: string; sizeBytes: number; plane: string }[] = [];
    for (const item of manifest.items) {
      if (item.kind !== "file") continue;
      const { bytes, etag } = await receive(f.service, f.thread.id, manifest.exportId, item.itemId);
      received.set(item.path, bytes);
      digests.push({
        itemId: item.itemId,
        sha256: etag,
        sizeBytes: bytes.length,
        plane: item.plane,
      });
    }
    for (const file of recorded.files) {
      const bytes = received.get(`native/claude/default/${file.rel}`)!;
      expect(bytes.length).toBe(file.sizeBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }

    const receipt = await f.service.retireThread(f.thread.id, {
      operationId: "op-recorded",
      exportId: manifest.exportId,
      closureDigest: manifest.closureDigest,
      contentDigest: threadExportDigest(digests),
      laneDigest: threadExportDigest(digests.filter((entry) => entry.plane === "lane")),
    });
    expect(receipt.operation).toMatchObject({ outcome: "accepted" });
    expect(existsSync(f.lanes)).toBe(false);
    // Retirement never touches an account store: the vendor's own files remain.
    expect(existsSync(join(store, recorded.files[0]!.rel))).toBe(true);

    // Offline: what was received reads with the store, lane and engine gone.
    rmSync(store, { recursive: true, force: true });
    const transcript = recorded.files.find((file) => file.rel.endsWith(".jsonl"))!;
    const lines = received
      .get(`native/claude/default/${transcript.rel}`)!
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; version?: string });
    expect(lines.some((line) => line.type === "user" || line.type === "assistant")).toBe(true);
    expect(lines.some((line) => line.version === "2.1.316")).toBe(true);
  });
});

describe("what that recording does not prove stays a named gap", () => {
  const SID = () => randomUUID();
  const transcript = (id: string, extra: object = {}, version = "2.1.316") =>
    `${JSON.stringify({ type: "user", sessionId: id, version, message: { role: "user" }, ...extra })}\n`;
  const put = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const gaps = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const manifest = await f.service.threadExportManifest(f.thread.id);
    expect(manifest.retirable).toBe(false);
    expect(manifest.sessions[0]!.status).toBe("unqualified");
    return manifest.gaps.map((gap) => gap.message).join("\n");
  };

  it("another vendor version", async () => {
    const f = await fixture();
    const id = SID();
    put(join(await storeRoot(), "projects", "-w", `${id}.jsonl`), transcript(id, {}, "2.1.317"));
    f.seed(id);
    expect(await gaps(f)).toContain("vendor version 2.1.317");
  });

  it("a transcript that resumed under a second version", async () => {
    const f = await fixture();
    const id = SID();
    put(
      join(await storeRoot(), "projects", "-w", `${id}.jsonl`),
      transcript(id) + transcript(id, {}, "2.1.400"),
    );
    f.seed(id);
    expect(await gaps(f)).toContain("vendor version 2.1.400");
  });

  it.each([
    ["subagent transcripts", (id: string) => `projects/-w/${id}/subagents/agent-1.jsonl`],
    ["file history", (id: string) => `file-history/${id}/v1`],
    ["todos", (id: string) => `todos/${id}-agent-${id}.json`],
    ["a debug log", (id: string) => `debug/${id}.txt`],
    ["session-env contents", (id: string) => `session-env/${id}/env`],
    ["task state", (id: string) => `tasks/${id}/t.json`],
  ])("%s, though their bytes are still carried", async (_name, rel) => {
    const f = await fixture();
    const id = SID();
    const store = await storeRoot();
    put(join(store, "projects", "-w", `${id}.jsonl`), transcript(id));
    put(join(store, rel(id)), "content\n");
    f.seed(id);
    expect(await gaps(f)).toContain(rel(id));
    const manifest = await f.service.threadExportManifest(f.thread.id);
    expect(manifest.items.map((item) => item.path)).toContain(`native/claude/default/${rel(id)}`);
  });

  it("a store file its own transcript names that the export does not carry", async () => {
    const f = await fixture();
    const id = SID();
    const store = await storeRoot();
    put(
      join(store, "projects", "-w", `${id}.jsonl`),
      transcript(id, { planFilePath: join(store, "plans", "named.md") }),
    );
    f.seed(id);
    expect(await gaps(f)).toContain("plans/named.md");
  });

  it("does not mistake a path quoted inside prose, or a project file, for a reference", async () => {
    const f = await fixture();
    const id = SID();
    const store = await storeRoot();
    put(
      join(store, "projects", "-w", `${id}.jsonl`),
      transcript(id, {
        text: `see ${join(store, "plans", "quoted.md")} for details`,
        input: { file_path: "/somewhere/else/file.ts" },
      }),
    );
    f.seed(id);
    const manifest = await f.service.threadExportManifest(f.thread.id);
    expect(beyondPlatform(manifest)).toEqual([]);
  });

  it.each([
    [
      "spilled output whose transcript is gone",
      (id: string) => [`projects/-w/${id}/tool-results/spilled.txt`],
    ],
    [
      "spilled output beside another directory's transcript",
      (id: string) => [`projects/-w/${id}.jsonl`, `projects/-x/${id}/tool-results/spilled.txt`],
    ],
  ])("a session copy holding %s is missing its transcript", async (_name, rels) => {
    const f = await fixture();
    const id = SID();
    const store = await storeRoot();
    for (const rel of rels(id))
      put(join(store, rel), rel.endsWith(".jsonl") ? transcript(id) : "spilled\n");
    f.seed(id);
    const manifest = await f.service.threadExportManifest(f.thread.id);
    expect(manifest.retirable).toBe(false);
    expect(beyondPlatform(manifest)).toEqual([
      expect.objectContaining({ code: "native_session_missing", subject: id }),
    ]);
    // What remains is still carried byte-exact.
    for (const rel of rels(id))
      expect(manifest.items.map((item) => item.path)).toContain(`native/claude/default/${rel}`);
  });

  it.each([
    [
      "a row that is not JSON",
      (ref: string) => `{"type":"user","version":"2.1.316","planFilePath":${JSON.stringify(ref)}`,
    ],
    [
      "a row over the read bound",
      (ref: string) =>
        JSON.stringify({
          type: "user",
          version: "2.1.316",
          planFilePath: ref,
          pad: "x".repeat(9 << 20),
        }),
    ],
    ["a row that is not a record", () => "123"],
  ])("%s after a valid row leaves qualification incomplete", async (_name, row) => {
    const f = await fixture();
    const id = SID();
    const store = await storeRoot();
    put(
      join(store, "projects", "-w", `${id}.jsonl`),
      `${transcript(id)}${row(join(store, "plans", "hidden.md"))}\n`,
    );
    f.seed(id);
    const manifest = await f.service.threadExportManifest(f.thread.id);
    expect(manifest.retirable).toBe(false);
    expect(beyondPlatform(manifest)).toEqual([
      expect.objectContaining({ code: "native_format_unqualified", subject: id }),
    ]);
  });

  it("an account store that cannot be resolved, beside a complete copy", async () => {
    const f = await fixture();
    const id = SID();
    put(join(await storeRoot(), "projects", "-w", `${id}.jsonl`), transcript(id));
    // A registered account whose store is now a link out of the owned root: its
    // adapter refuses to resolve it, so whether it holds this session is unknown.
    const { profile } = registerConfigDirProfile({ harnessId: "claude", profileId: "p2" });
    const outside = mkdtempSync(join(tmpdir(), "cx-outside-store-"));
    removals.push(() => rmSync(outside, { recursive: true, force: true }));
    rmSync(profile.isolation_locator!, { recursive: true, force: true });
    symlinkSync(outside, profile.isolation_locator!);
    f.seed(id);
    const manifest = await f.service.threadExportManifest(f.thread.id);
    expect(manifest.retirable).toBe(false);
    expect(beyondPlatform(manifest)).toEqual([
      expect.objectContaining({ code: "native_session_unreadable", subject: "profile-p2" }),
    ]);
  });

  it("a transcript that names no version", async () => {
    const f = await fixture();
    const id = SID();
    put(
      join(await storeRoot(), "projects", "-w", `${id}.jsonl`),
      `${JSON.stringify({ type: "x" })}\n`,
    );
    f.seed(id);
    expect(await gaps(f)).toContain("names no vendor version");
  });

  it("a session held only in a lane home", async () => {
    const f = await fixture();
    const id = SID();
    put(
      join(f.lanes, "claude-default", "home", ".claude", "projects", "-w", `${id}.jsonl`),
      transcript(id),
    );
    f.seed(id);
    expect(await gaps(f)).toContain("lane home");
  });

  it("a lane copy beside a qualified store copy", async () => {
    const f = await fixture();
    const id = SID();
    put(join(await storeRoot(), "projects", "-w", `${id}.jsonl`), transcript(id));
    put(
      join(f.lanes, "claude-default", "home", ".claude", "projects", "-w", `${id}.jsonl`),
      transcript(id),
    );
    f.seed(id);
    expect(await gaps(f)).toContain("lane home");
  });
});
