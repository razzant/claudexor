/**
 * The closure, gap and retirement contract over real SQL owners, real adapter
 * declarations and synthetic stores. A synthetic store proves what the engine
 * does with these bytes, never that a vendor writes them; that is why Claude
 * and Codex stay `native_format_unqualified` throughout.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import type { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { resolve } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DaemonControlApiServer, collectNativeRunSessions } from "@claudexor/control-api";
import {
  EngineStore,
  createPartition,
  createSqlDaemonServices,
  currentGeneration,
  readRunObservations,
  setGlobalGenerationInTx,
} from "@claudexor/daemon";
import { defaultNativeClaudeConfigDir } from "@claudexor/harness-claude";
import { defaultNativeCodexHome } from "@claudexor/harness-codex";
import {
  CONTROL_PROTOCOL_MAJOR,
  ThreadExportManifest,
  threadExportDigest,
  type Thread,
} from "@claudexor/schema";
import { noProjectRepoRoot, ownedProjectRuntimeDir, projectRuntimeDir } from "@claudexor/util";
import { createRevertAnchorOrNull, snapshotTree } from "@claudexor/workspace";
import { applyCommandInTx, prepareCommandRow } from "../../daemon/src/store/command-rows.js";
import { readThreadClosure } from "../../daemon/src/store/thread-closure.js";
import { parseCommandListQuery } from "../../daemon/src/command-list-select.js";
import { publicAcceptedCommand } from "../../daemon/src/command-rpc.js";
import { enqueueStaged } from "../../daemon/src/enqueue-command.js";
import { publicJobRecord } from "../../daemon/src/job-record.js";
import { registerConfigDirProfile } from "./profile-registration.js";
import { createRetentionRunner } from "./retention-service.js";
import { sqlActivityRecords } from "./sql-daemon-queries.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";
import { exportThreadBundle, retireThreadBundle } from "./thread-export-command.js";
import { laneCredentialStores, threadExportService } from "./thread-export-services.js";
import { startupPurgeEffect, threadPurgeEffect, threadPurgeOwner } from "./thread-purge.js";
import { threadTurnServices } from "./thread-turn-services.js";

const SID_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SID_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SID_C = "cccccccc-3333-4333-8333-cccccccccccc";
const OTHER = "dddddddd-4444-4444-8444-dddddddddddd";

// Closes, permission restores and removals are separate lists: a test's removals all follow its
// closes, and a close that fails or times out keeps every folder of that test.
const cleanup: (() => Promise<void>)[] = [];
const restores: (() => void)[] = [];
const removals: (() => void)[] = [];
afterEachClosed(async () => {
  // This test's entries, taken before any await: a late close never reaches the next test's.
  const ownedRestores = restores.splice(0).reverse();
  const ownedCloses = cleanup.splice(0).reverse();
  const ownedRemovals = removals.splice(0).reverse();
  // Nothing here deletes, so a folder a failed test left read-only stays removable.
  for (const restore of ownedRestores) restore();
  for (const close of ownedCloses) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

function write(path: string, text: string | Buffer): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/**
 * The maintenance worker's closure-read barrier (`MaintenanceWorkerHooks`): each
 * snapshot read waits inside its snapshot, after it is fixed and before any closure
 * row is read, until released in arrival order.
 */
function snapshotBarrier() {
  const slots = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
  return {
    buffer: slots.buffer as SharedArrayBuffer,
    /** Reads that fixed their snapshot so far. */
    arrivals: () => Atomics.load(slots, 0),
    /** Bounded: a read that never reaches the worker's snapshot fails the test. */
    async arrived(count: number, withinMs = 10_000) {
      const deadline = Date.now() + withinMs;
      for (let seen = Atomics.load(slots, 0); seen < count; seen = Atomics.load(slots, 0)) {
        if (Date.now() >= deadline)
          throw new Error(`${seen} of ${count} closure reads reached the worker's snapshot`);
        await new Promise((settle) => setTimeout(settle, 2));
      }
    },
    /** Let the first `count` arrivals continue. */
    release(count: number) {
      Atomics.store(slots, 1, count);
      Atomics.notify(slots, 1);
    },
  };
}

async function fixture(options: { project?: boolean; closureBarrier?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cx-retire-"));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  const projectRoot = options.project ? join(root, "project") : null;
  if (projectRoot) mkdirSync(projectRoot);
  const barrier = options.closureBarrier ? snapshotBarrier() : null;
  /** The effect the graph registers for its obligations; a restart registers its own. */
  type Registered = Parameters<typeof createSqlDaemonServices>[1]["purgeFiles"];
  const open = async (
    purgeFiles: Registered = threadPurgeEffect(noProjectRepoRoot(), laneCredentialStores),
  ) => {
    const store = await EngineStore.open({
      daemonDir: join(root, "daemon"),
      workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
    });
    if (!currentGeneration(store, "global"))
      store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
    const graph = createSqlDaemonServices(store, {
      purgeFiles,
      ...(barrier ? { maintenance: { hooks: { closureBarrier: barrier.buffer } } } : {}),
    });
    return { store, graph };
  };
  let { store, graph } = await open();
  cleanup.push(async () => {
    await graph.close();
    await store.close();
  });
  // Runs before that close: no read the test left parked holds the worker.
  if (barrier) cleanup.push(async () => barrier.release(2 ** 31 - 1));
  const noProject = noProjectRepoRoot();
  const owner = () =>
    threadPurgeOwner(graph.threads, noProject, graph.purgeFiles, laneCredentialStores);
  const build = () =>
    threadExportService(
      graph.threads,
      { resolve: () => [] },
      (thread, signal?: AbortSignal) => owner().finishPurge(thread, signal),
      (thread) => owner().hasPurgeLeftovers(thread),
    );
  let exporter = build();
  const service = () => exporter;
  const thread = graph.threads.createThread({
    title: "seat",
    ...(projectRoot ? { repoRoot: projectRoot } : {}),
  });
  const pid = graph.threads.generationForThread(thread.id)!.pid;
  const lanes = join(projectRuntimeDir(projectRoot ?? noProject), "lanes", thread.id);
  /** One command row and its run tree: the exact record shape a job leaves. */
  const command = (input: {
    id: string;
    state?: "queued" | "running" | "succeeded";
    params?: Record<string, unknown>;
    runId?: string;
    needsDecision?: boolean;
  }) => {
    const runId = input.runId ?? `run-${input.id}`;
    const runDir = join(root, "runs", runId);
    mkdirSync(join(runDir, "final"), { recursive: true });
    const state = input.state ?? "succeeded";
    const record = {
      id: input.id,
      runId,
      runDir,
      taskId: `task-${input.id}`,
      state,
      createdAt: "2026-11-01T10:00:00.000Z",
      startedAt: "2026-11-01T10:00:01.000Z",
      ...(state === "succeeded" ? { finishedAt: "2026-11-01T10:00:02.000Z" } : {}),
      params: { mode: "ask", prompt: "work", ...input.params },
    };
    const prepared = prepareCommandRow(
      record,
      { pid, live: true, operation: "ask", clientId: null },
      (bytes) => graph.blobs.prepareBody(bytes),
    );
    if (input.needsDecision) prepared.row.needs_decision = 1;
    store.transaction(() => applyCommandInTx(store, prepared, "accept"));
    return { runId, runDir, record };
  };
  const turnWithRun = (id: string, prompt = "question") => {
    const turn = graph.threads.createTurn(thread.id, prompt);
    const run = command({ id, params: { threadId: thread.id, turnId: turn.id } });
    graph.threads.bindTurnRun(turn.id, run.runId);
    return { turn, ...run };
  };
  const received = async (manifest: ThreadExportManifest) => {
    // Hash each item exactly as a consumer receives it, through the real transfer.
    const entries: { itemId: string; sha256: string; sizeBytes: number; plane: string }[] = [];
    for (const item of manifest.items) {
      if (item.kind === "symlink")
        entries.push({
          itemId: item.itemId,
          sha256: item.sha256!,
          sizeBytes: item.sizeBytes!,
          plane: item.plane,
        });
      if (item.kind !== "file") continue;
      const chunks: Buffer[] = [];
      const headers: Record<string, unknown> = {};
      const res = fakeResponse(chunks, headers);
      await service().transferThreadExportItem(
        thread.id,
        manifest.exportId,
        item.itemId,
        res as never,
      );
      const bytes = Buffer.concat(chunks);
      entries.push({
        itemId: item.itemId,
        sha256: String(headers["ETag"]).replaceAll('"', ""),
        sizeBytes: bytes.length,
        plane: item.plane,
      });
    }
    return entries;
  };
  const consumer = async (manifest: ThreadExportManifest) => {
    const entries = await received(manifest);
    return {
      contentDigest: threadExportDigest(entries),
      laneDigest: threadExportDigest(entries.filter((entry) => entry.plane === "lane")),
    };
  };
  /** The lane entries acceptance records: what the engine re-read, here what was received. */
  const acceptedLane = async (manifest: ThreadExportManifest) =>
    (await received(manifest))
      .filter((entry) => entry.plane === "lane")
      .map(({ itemId, sha256, sizeBytes }) => ({ itemId, sha256, sizeBytes }));
  return {
    root,
    projectRoot,
    store,
    graph,
    barrier,
    thread,
    pid,
    lanes,
    command,
    turnWithRun,
    service,
    owner,
    consumer,
    acceptedLane,
    reopen: async (purgeFiles?: Registered) => {
      await graph.close();
      await store.close();
      ({ store, graph } = await open(purgeFiles));
      exporter = build();
      return { store, graph };
    },
    current: () => ({ store, graph }),
  };
}

import { PassThrough } from "node:stream";
function fakeResponse(chunks: Buffer[], headers: Record<string, unknown>) {
  const stream = new PassThrough();
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return Object.assign(stream, {
    writeHead: (_status: number, values: Record<string, unknown>) => Object.assign(headers, values),
  });
}

const started = (id: string, profile?: string) =>
  `${JSON.stringify({
    type: "started",
    session_id: "ses",
    ...(profile ? { credential_profile_id: profile } : {}),
    payload: { native_session_id: id },
  })}\n`;
const runStarted = (harness: string, attempt: string, id: string) =>
  `${JSON.stringify({
    run_id: "r",
    type: "harness.event",
    payload: {
      harness_id: harness,
      attempt_id: attempt,
      type: "started",
      payload: { native_session_id: id },
    },
  })}\n`;

describe("thread export: every try, every store, exact bytes", () => {
  it("carries each try's session across accounts and refuses retirement while unqualified", async () => {
    const f = await fixture();
    const { runDir } = f.turnWithRun("job-1");
    const log = join(runDir, "attempts", "a01", "events.jsonl");
    // Try 0 on the default store, try 1 rotated to a second account, try 2 aborted
    // on a resumed-id mismatch: its `started` is logged, no capsule ever names it.
    write(log, started(SID_A) + started(SID_B, "p2") + started(SID_C));
    write(
      join(runDir, "events.jsonl"),
      runStarted("claude", "a01", SID_A) +
        `${JSON.stringify({ type: "harness.event", payload: { harness_id: "claude", attempt_id: "a01", type: "status", payload: { code: "fake_session_probe", native_session_id: OTHER } } })}\n`,
    );
    write(
      join(runDir, "attempts", "a01", "session-capsule.json"),
      JSON.stringify({
        harness: "claude",
        nativeSessionId: SID_B,
        holderProfileId: "p2",
        file: null,
        mtimeMs: null,
        sidecars: [],
        cwd: "/w",
        requestedModel: null,
      }),
    );
    // Negative control: the retention reader's capsule walk alone sees only try 1.
    const capsuleOnly = new Map<string, Set<string>>();
    collectNativeRunSessions(runDir, capsuleOnly, new Set());
    expect([...capsuleOnly.get("claude")!]).toEqual([SID_B]);

    const first = defaultNativeClaudeConfigDir();
    const { profile } = registerConfigDirProfile({ harnessId: "claude", profileId: "p2" });
    const second = profile.isolation_locator!;
    const sentinel = write(join(f.root, "outside.txt"), "OUTSIDE-SENTINEL");
    write(join(first, ".credentials.json"), "CREDENTIAL-SENTINEL");
    write(join(first, ".claude.json"), "IDENTITY-SENTINEL");
    write(join(first, "projects", "-w", `${SID_A}.jsonl`), "transcript a\n");
    write(join(first, "projects", "-w", SID_A, "tool-results", "big.txt"), "spilled a\n");
    write(join(first, "projects", "-w", SID_A, "subagents", "agent-1.jsonl"), "sub a\n");
    symlinkSync(sentinel, join(first, "projects", "-w", SID_A, "linked"));
    write(join(first, "file-history", SID_A, "v1"), "history a\n");
    write(join(first, "todos", `${SID_A}-agent-${SID_A}.json`), "[]\n");
    write(join(first, "projects", "-w", `${OTHER}.jsonl`), "another session entirely\n");
    write(join(first, "unlisted", `${SID_A}.txt`), "outside declared locations\n");
    write(join(second, "projects", "-w", `${SID_B}.jsonl`), "transcript b\n");
    // One session held twice with different bytes: both copies stay.
    write(join(first, "projects", "-a", `${SID_C}.jsonl`), "copy one\n");
    write(join(second, "projects", "-b", `${SID_C}.jsonl`), "copy two\n");
    mkdirSync(f.lanes, { recursive: true });

    const manifest = await f.service().threadExportManifest(f.thread.id);
    const paths = manifest.items.map((item) => item.path);
    const native = (store: string, rel: string) => `native/claude/${store}/${rel}`;
    expect(paths).toEqual(
      expect.arrayContaining([
        native("default", `projects/-w/${SID_A}.jsonl`),
        native("default", `projects/-w/${SID_A}/tool-results/big.txt`),
        native("default", `projects/-w/${SID_A}/subagents/agent-1.jsonl`),
        native("default", `file-history/${SID_A}/v1`),
        native("default", `todos/${SID_A}-agent-${SID_A}.json`),
        native("profile-p2", `projects/-w/${SID_B}.jsonl`),
        native("default", `projects/-a/${SID_C}.jsonl`),
        native("profile-p2", `projects/-b/${SID_C}.jsonl`),
      ]),
    );
    const everything = JSON.stringify(manifest);
    expect(everything).not.toContain(".credentials.json");
    expect(everything).not.toContain(".claude.json");
    expect(everything).not.toContain(`${OTHER}.jsonl`);
    expect(everything).not.toContain("unlisted");
    expect(manifest.sessions.map((s) => s.nativeSessionId).sort()).toEqual([SID_A, SID_B, SID_C]);
    // A probe row names the key without being a start.
    expect(manifest.sessions.some((s) => s.nativeSessionId === OTHER)).toBe(false);
    const link = manifest.items.find((item) => item.path.endsWith("/linked"))!;
    expect(link).toMatchObject({ kind: "symlink", linkTarget: sentinel });
    const c = manifest.sessions.find((s) => s.nativeSessionId === SID_C)!;
    expect(c.copies.map((copy) => copy.storeKey).sort()).toEqual(["default", "profile-p2"]);
    expect(c.provenance.map((p) => p.profileId)).toEqual([null]);

    // The bytes are preserved; the format is not proven, so nothing can retire.
    expect(manifest.coverage).toBe("partial");
    expect(manifest.retirable).toBe(false);
    expect(new Set(manifest.gaps.map((gap) => gap.code))).toEqual(
      new Set(["native_format_unqualified"]),
    );
    const digests = await f.consumer(manifest);
    await expect(
      f.service().retireThread(f.thread.id, {
        operationId: "op-unqualified",
        exportId: manifest.exportId,
        closureDigest: manifest.closureDigest,
        ...digests,
      }),
    ).rejects.toMatchObject({ code: "thread_export_incomplete", status: 409 });
    expect(f.graph.threads.getThread(f.thread.id)!.state).toBe("active");
    expect(existsSync(f.lanes)).toBe(true);
  });

  it("names a session held nowhere instead of treating absence as complete", async () => {
    const f = await fixture();
    const { runDir } = f.turnWithRun("job-1");
    const absent = randomUUID();
    write(join(runDir, "events.jsonl"), runStarted("claude", "a01", absent));
    const manifest = await f.service().threadExportManifest(f.thread.id);
    expect(manifest.sessions[0]).toMatchObject({ nativeSessionId: absent, status: "missing" });
    expect(manifest.gaps).toEqual([expect.objectContaining({ code: "native_session_missing" })]);
    expect(manifest.retirable).toBe(false);
  });

  it("names harnesses with no declared format, and starts with no named harness", async () => {
    const f = await fixture();
    const { runDir } = f.turnWithRun("job-1");
    write(join(runDir, "events.jsonl"), runStarted("cursor", "a01", SID_A));
    write(
      join(runDir, "reviews", "x-reviewers", "r1", "raw-normalized-stream.jsonl"),
      started(SID_B),
    );
    const manifest = await f.service().threadExportManifest(f.thread.id);
    expect(manifest.gaps.map((gap) => gap.code).sort()).toEqual([
      "native_session_unattributed",
      "native_session_unsupported",
    ]);
    expect(manifest.sessions[0]).toMatchObject({ harness: "cursor", status: "unsupported" });
  });

  it("decodes real zstd frames beside exact originals, and names a corrupt part", async () => {
    const f = await fixture();
    const { runDir } = f.turnWithRun("job-1");
    write(join(runDir, "events.jsonl"), runStarted("codex", "a01", SID_A));
    const home = defaultNativeCodexHome();
    const day = join(home, "sessions", "2026", "11", "01");
    const decoded = `${JSON.stringify({ text: "non-ascii é中" })}\n`;
    write(
      join(day, `rollout-2026-11-01T10-00-00-${SID_A}.jsonl.zst`),
      zstdCompressSync(Buffer.from(decoded)),
    );
    write(join(day, `rollout-2026-11-01T11-00-00-${SID_A}.jsonl`), "plain part\n");
    let manifest = await f.service().threadExportManifest(f.thread.id);
    const part = manifest.items.find((item) => item.path.endsWith(".jsonl.zst"))!;
    const projection = manifest.items.find((item) => item.projectionOf === part.itemId)!;
    expect(projection).toMatchObject({
      plane: "projection",
      sizeBytes: Buffer.byteLength(decoded),
    });
    const chunks: Buffer[] = [];
    const headers = {};
    await f
      .service()
      .transferThreadExportItem(
        f.thread.id,
        manifest.exportId,
        projection.itemId,
        fakeResponse(chunks, headers) as never,
      );
    expect(Buffer.concat(chunks).toString()).toBe(decoded);
    expect(manifest.gaps.map((gap) => gap.code)).toEqual(["native_format_unqualified"]);

    write(join(day, `rollout-2026-11-01T12-00-00-${SID_A}.jsonl.zst`), "not a zstd frame");
    manifest = await f.service().threadExportManifest(f.thread.id);
    expect(manifest.gaps.map((gap) => gap.code)).toContain("native_projection_failed");
  });

  it("never opens an exact lane credential store, and keeps working files named like secrets", async () => {
    const f = await fixture();
    f.turnWithRun("job-1");
    const home = join(f.lanes, "codex-default", "home");
    const auth = write(join(home, ".codex", "auth.json"), "AUTH-SENTINEL");
    // Unreadable to prove it was not opened: a read attempt would be a named gap.
    chmodSync(auth, 0o000);
    restores.push(() => chmodSync(auth, 0o600));
    write(join(home, ".env"), "API_KEY=working-content\n");
    write(join(f.lanes, "summaries", "turn.md"), "summary\n");
    symlinkSync("/nowhere", join(home, "dangling"));
    write(join(f.lanes, "cursor-default", "home", ".cursor", "auth.json"), "UNDECLARED-SENTINEL");
    const manifest = await f.service().threadExportManifest(f.thread.id);
    const lane = (rel: string) =>
      manifest.items.find((item) => item.path === `lanes/${f.thread.id}/${rel}`);
    expect(lane("codex-default/home/.codex/auth.json")).toMatchObject({
      kind: "credential_store",
      sizeBytes: null,
      sha256: null,
    });
    expect(lane("codex-default/home/.env")).toMatchObject({ kind: "file", plane: "lane" });
    expect(lane("summaries/turn.md")).toMatchObject({ kind: "file" });
    expect(lane("codex-default/home/dangling")).toMatchObject({ kind: "symlink" });
    // A lane whose harness declares no stores is named and its files are not read.
    expect(JSON.stringify(manifest)).not.toContain("cursor-default/home");
    expect(manifest.gaps).toEqual([
      expect.objectContaining({ code: "lane_credentials_undeclared", subject: "cursor-default" }),
    ]);
  });

  it("carries attachment bytes by their recorded digest, and names missing ones", async () => {
    const f = await fixture();
    const bytes = Buffer.from("attached exact bytes");
    const path = write(join(f.root, "blobs", "one"), bytes);
    const attachment = {
      resource_id: "res-1",
      kind: "file",
      mime: "text/plain",
      name: "note.txt",
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size_bytes: bytes.length,
      path,
    } as const;
    const turn = f.graph.threads.createTurn(f.thread.id, "with a file", {
      attachments: [attachment],
    });
    const run = f.command({ id: "job-1", params: { threadId: f.thread.id, turnId: turn.id } });
    f.graph.threads.bindTurnRun(turn.id, run.runId);
    const manifest = await f.service().threadExportManifest(f.thread.id);
    expect(manifest.items.find((item) => item.plane === "resource")).toMatchObject({
      path: "resources/res-1/note.txt",
      sha256: attachment.sha256,
    });
    expect(manifest.gaps).toEqual([]);
    rmSync(path);
    expect((await f.service().threadExportManifest(f.thread.id)).gaps).toEqual([
      expect.objectContaining({ code: "attachment_unavailable", subject: "res-1" }),
    ]);
  });

  it("walks a continuation source named only on disk, and names retired or missing runs", async () => {
    const f = await fixture();
    const { runDir } = f.turnWithRun("job-1");
    const sourceDir = join(f.root, "runs", "run-source");
    write(join(sourceDir, "final", "answer.md"), "from the source run\n");
    write(
      join(runDir, "context", "continuation.json"),
      JSON.stringify([{ runId: "run-source", runDir: sourceDir, state: "succeeded" }]),
    );
    const first = await f.service().threadExportManifest(f.thread.id);
    expect(first.items.map((item) => item.path)).toContain("runs/run-source/final/answer.md");
    write(join(sourceDir, "tombstone.yaml"), "expired: true\n");
    expect((await f.service().threadExportManifest(f.thread.id)).gaps).toEqual([
      expect.objectContaining({ code: "run_files_expired", subject: "run-source" }),
    ]);
    rmSync(sourceDir, { recursive: true });
    expect((await f.service().threadExportManifest(f.thread.id)).gaps).toEqual([
      expect.objectContaining({ code: "run_directory_missing", subject: "run-source" }),
    ]);
  });

  it("writes nothing when a manifest is read", async () => {
    const f = await fixture();
    f.turnWithRun("job-1");
    const before = f.store.prepare("SELECT count(*) AS n FROM event").get() as { n: number };
    const revision = (await f.graph.threads.threadClosure(f.thread.id))!.headRevision;
    await f.service().threadExportManifest(f.thread.id);
    expect(existsSync(f.lanes)).toBe(false);
    expect((await f.graph.threads.threadClosure(f.thread.id))!.headRevision).toBe(revision);
    expect((f.store.prepare("SELECT count(*) AS n FROM event").get() as { n: number }).n).toBe(
      before.n,
    );
  });
});

describe("closure: what keeps a thread from retiring", () => {
  const request = (closureDigest: string, operationId: string) => ({
    operationId,
    exportId: `sha256:${"e".repeat(64)}`,
    closureDigest,
    contentDigest: `sha256:${"c".repeat(64)}`,
    laneDigest: `sha256:${"f".repeat(64)}`,
  });

  it("follows standalone continuations and delegated children past an idle thread", async () => {
    const f = await fixture();
    const { runId } = f.turnWithRun("job-1");
    const child = f.command({ id: "child", params: { delegatedFromRunId: runId } });
    const grandchild = f.command({
      id: "continued",
      state: "running",
      params: { continueFrom: child.runId },
    });
    const closure = (await f.graph.threads.threadClosure(f.thread.id))!;
    expect(closure.commands.map((c) => c.jobId).sort()).toEqual(["child", "continued", "job-1"]);
    // Negative control: the ordinary purge route's check sees only the thread.
    expect(
      f.graph.commands.queries.select({ threadId: f.thread.id, activeOnly: true }).map((r) => r.id),
    ).toEqual([]);
    expect(closure.holds).toEqual([
      expect.objectContaining({ code: "closure_not_quiescent", subject: grandchild.runId }),
    ]);
    expect(() =>
      f.graph.threads.retireThread(f.thread.id, request(closure.digest, "op-1"), []),
    ).toThrowError(expect.objectContaining({ code: "thread_busy" }) as never);
    expect(f.graph.threads.getThread(f.thread.id)!.state).toBe("active");
    expect(f.graph.obligations.get("purge_fs", f.thread.id)).toBeUndefined();
    expect(f.graph.threads.retirementOperation(f.thread.id, "op-1")).toMatchObject({
      outcome: "refused",
      code: "thread_busy",
    });
  });

  it.each([
    [
      "a pending interaction",
      (f: Awaited<ReturnType<typeof fixture>>, runId: string) =>
        f.store.transaction(() => {
          f.store
            .prepare(
              "INSERT INTO interaction(id,pid,run_id,state,request) VALUES(?,?,?,'pending',?)",
            )
            .run(`${runId}\0q1`, f.pid, runId, Buffer.from("{}"));
        }),
    ],
    [
      "a waiting deferred message",
      (f: Awaited<ReturnType<typeof fixture>>) =>
        f.store.transaction(() => {
          f.store
            .prepare(
              "INSERT INTO deferred_message(id,pid,predecessor_job_id,revision,state,body_sha,created_at) VALUES('d1',?,'job-1',1,'waiting','x',?)",
            )
            .run(f.pid, new Date().toISOString());
        }),
    ],
    [
      "a pending terminal file effect",
      (f: Awaited<ReturnType<typeof fixture>>, runId: string) =>
        f.store.transaction(() => {
          f.store
            .prepare(
              "INSERT INTO effect_obligation(kind,key,pid,created_at,payload,state) VALUES('terminal_files',?,?,?,?,'pending')",
            )
            .run(runId, f.pid, new Date().toISOString(), Buffer.from("{}"));
        }),
    ],
    [
      "a turn with no run and no refusal",
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.graph.threads.createTurn(f.thread.id, "start still pending");
      },
    ],
  ])("holds for %s", async (_name, arrange) => {
    const f = await fixture();
    const { runId } = f.turnWithRun("job-1");
    arrange(f, runId);
    expect((await f.graph.threads.threadClosure(f.thread.id))!.holds).toEqual([
      expect.objectContaining({ code: "closure_not_quiescent" }),
    ]);
  });

  it("holds for a run awaiting a decision", async () => {
    const f = await fixture();
    f.command({ id: "job-1", params: { threadId: f.thread.id }, needsDecision: true });
    expect((await f.graph.threads.threadClosure(f.thread.id))!.holds).toEqual([
      expect.objectContaining({ code: "closure_awaiting_decision" }),
    ]);
  });

  it("names a run its thread records but no command row retains", async () => {
    const f = await fixture();
    const turn = f.graph.threads.createTurn(f.thread.id, "q");
    f.graph.threads.bindTurnRun(turn.id, "run-pruned");
    expect((await f.graph.threads.threadClosure(f.thread.id))!.holds).toEqual([
      expect.objectContaining({ code: "command_record_not_retained", subject: "run-pruned" }),
    ]);
  });

  it("changes identity with every closure row, not merely the thread head", async () => {
    const f = await fixture();
    const { runId } = f.turnWithRun("job-1");
    /** The store's observation, equal to the reader acceptance runs in its transaction. */
    const observe = async () => {
      const observed = (await f.graph.threads.threadClosure(f.thread.id))!;
      expect(observed).toEqual(readThreadClosure(f.store, f.thread.id));
      return observed;
    };
    const start = await observe();
    expect((await observe()).digest).toBe(start.digest);
    f.command({ id: "child", params: { delegatedFromRunId: runId } });
    const withChild = await observe();
    expect(withChild.digest).not.toBe(start.digest);
    // These rows move no thread head: only the closure identity notices.
    expect(withChild.headRevision).toBe(start.headRevision);
    f.store.transaction(() => {
      f.store
        .prepare("INSERT INTO operator_decision(run_id,pid,body) VALUES(?,?,?)")
        .run(runId, f.pid, Buffer.from('{"decision":"x"}'));
    });
    const decided = await observe();
    expect(decided.digest).not.toBe(withChild.digest);
    expect(decided.headRevision).toBe(start.headRevision);
  });

  it("accepts atomically, keeps the ordinary routes as they were, and refuses later turns", async () => {
    const f = await fixture();
    f.turnWithRun("job-1");
    expect(() => f.graph.threads.purgeThread(f.thread.id)).toThrowError(
      expect.objectContaining({ code: "thread_not_trashed" }) as never,
    );
    const { digest } = (await f.graph.threads.threadClosure(f.thread.id))!;
    const next = f.graph.threads.retireThread(f.thread.id, request(digest, "op-ok"), []);
    expect(next.state).toBe("purged");
    expect(next.retirement).toMatchObject({ operationId: "op-ok", closureDigest: digest });
    const obligation = f.graph.obligations.get("purge_fs", f.thread.id)!;
    expect(obligation.state).toBe("pending");
    expect((obligation.payload as { retirement: unknown }).retirement).toEqual(next.retirement);
    expect(f.graph.threads.retirementOperation(f.thread.id, "op-ok")).toMatchObject({
      outcome: "accepted",
    });
    expect(() => f.graph.threads.createTurn(f.thread.id, "too late")).toThrowError(
      expect.objectContaining({ code: "thread_purged" }) as never,
    );
  });

  it("refuses a stale digest and binds that refusal as the operation's only outcome", async () => {
    const f = await fixture();
    f.turnWithRun("job-1");
    expect(() =>
      f.graph.threads.retireThread(
        f.thread.id,
        request(`sha256:${"0".repeat(64)}`, "op-stale"),
        [],
      ),
    ).toThrowError(expect.objectContaining({ code: "thread_export_stale" }) as never);
    expect(f.graph.threads.getThread(f.thread.id)!.state).toBe("active");
    const { digest } = (await f.graph.threads.threadClosure(f.thread.id))!;
    expect(f.graph.threads.retirementOperation(f.thread.id, "op-stale")).toMatchObject({
      outcome: "refused",
    });
    // The first binding stands; another request cannot rewrite the outcome.
    const settled = f.graph.threads.settleRetirement(f.thread.id, "op-stale", null);
    expect(settled.outcome).toBe("refused");
    expect(digest).toMatch(/^sha256:/);
  });
});

/**
 * An export observes the closure in the store maintenance worker's read-only
 * snapshot; only acceptance reads it on the writer, inside its transaction. The
 * barrier parks a worker read inside its fixed snapshot, so what commits meanwhile,
 * and what the control plane answers meanwhile, is ordered exactly.
 */
describe("closure observations read the store's snapshot, off the writer's thread", () => {
  const request = (closureDigest: string, operationId: string) => ({
    operationId,
    exportId: `sha256:${"e".repeat(64)}`,
    closureDigest,
    contentDigest: `sha256:${"c".repeat(64)}`,
    laneDigest: `sha256:${"f".repeat(64)}`,
  });
  const resolvedInteraction = (f: Fixture, runId: string) =>
    f.store.transaction(() => {
      f.store
        .prepare(
          "INSERT INTO interaction(id,pid,run_id,state,request,resolution) VALUES(?,?,?,'resolved',?,?)",
        )
        .run(`${runId}\0q1`, f.pid, runId, Buffer.from("{}"), Buffer.from('{"answers":{}}'));
    });
  const pause = (ms: number) => new Promise((settle) => setTimeout(settle, ms));

  it("answers exactly what acceptance's own reader answers, and null for no thread", async () => {
    const f = await fixture();
    const { runId } = f.turnWithRun("job-1");
    const child = f.command({ id: "child", params: { delegatedFromRunId: runId } });
    f.command({ id: "continued", params: { continueFrom: child.runId } });
    resolvedInteraction(f, runId);
    f.store.transaction(() => {
      f.store
        .prepare("INSERT INTO operator_decision(run_id,pid,body) VALUES(?,?,?)")
        .run(runId, f.pid, Buffer.from('{"decision":"x"}'));
    });
    const observed = (await f.graph.threads.threadClosure(f.thread.id))!;
    expect(observed.commands.map((c) => c.jobId).sort()).toEqual(["child", "continued", "job-1"]);
    expect(observed.documents.map((d) => d.key)).toEqual(
      expect.arrayContaining([`decision:${runId}`, `interaction:${runId}\0q1`]),
    );
    expect(observed).toEqual(readThreadClosure(f.store, f.thread.id));
    expect(await f.graph.threads.threadClosure("no-such-thread")).toBeNull();
  });

  it.each([
    [
      "a delegated child",
      (f: Fixture, runId: string) =>
        void f.command({ id: "child", params: { delegatedFromRunId: runId } }),
    ],
    [
      "a continuation",
      (f: Fixture, runId: string) =>
        void f.command({ id: "continued", params: { continueFrom: runId } }),
    ],
    ["a resolved interaction", resolvedInteraction],
  ])(
    "keeps its snapshot while %s commits, and acceptance refuses that snapshot's digest",
    async (_name, change) => {
      const f = await fixture({ closureBarrier: true });
      const { runId } = f.turnWithRun("job-1");
      const before = readThreadClosure(f.store, f.thread.id)!;
      const observing = f.graph.threads.threadClosure(f.thread.id);
      await f.barrier!.arrived(1);
      change(f, runId);
      const after = readThreadClosure(f.store, f.thread.id)!;
      // The row moves no thread head: only the closure identity notices.
      expect(after.digest).not.toBe(before.digest);
      expect(after.headRevision).toBe(before.headRevision);
      f.barrier!.release(1);
      expect(await observing).toEqual(before);
      expect(() =>
        f.graph.threads.retireThread(f.thread.id, request(before.digest, "op-snapshot"), []),
      ).toThrowError(expect.objectContaining({ code: "thread_export_stale" }) as never);
      expect(f.graph.threads.retirementOperation(f.thread.id, "op-snapshot")).toMatchObject({
        outcome: "refused",
        code: "thread_export_stale",
      });
      expect(f.graph.threads.getThread(f.thread.id)!.state).toBe("active");
    },
  );

  it("ignores unrelated writes inside and around its snapshots, and that export retires", async () => {
    const f = await fixture({ closureBarrier: true });
    f.turnWithRun("job-1");
    const other = f.graph.threads.createThread({ title: "neighbour" });
    const unrelated = (n: number) => {
      const turn = f.graph.threads.createTurn(other.id, `other ${n}`);
      const run = f.command({ id: `other-${n}`, params: { threadId: other.id, turnId: turn.id } });
      f.graph.threads.bindTurnRun(turn.id, run.runId);
      f.command({ id: `loose-${n}` });
    };
    const reading = f.service().threadExportManifest(f.thread.id);
    await f.barrier!.arrived(1);
    unrelated(1);
    f.barrier!.release(1);
    // The manifest's second observation, which must still agree with its first.
    await f.barrier!.arrived(2);
    unrelated(2);
    f.barrier!.release(2);
    const manifest = await reading;
    expect(manifest.gaps).toEqual([]);
    expect(manifest.closureDigest).toBe(readThreadClosure(f.store, f.thread.id)!.digest);
    unrelated(3);
    f.barrier!.release(2 ** 31 - 1);
    const retired = await f.service().retireThread(f.thread.id, {
      operationId: "op-unrelated",
      exportId: manifest.exportId,
      closureDigest: manifest.closureDigest,
      ...(await f.consumer(manifest)),
    });
    expect(retired.operation).toMatchObject({ outcome: "accepted" });
    expect(f.graph.threads.getThread(f.thread.id)!.state).toBe("purged");
  });

  it("serves health, admission, inbox attention and Stop while an export's read holds the worker", async () => {
    const f = await fixture({ closureBarrier: true });
    const { runId } = f.turnWithRun("job-1");
    const other = f.graph.threads.createThread({ title: "neighbour" });
    const api = await served(f);
    const exporting = api.call("GET", `/threads/${f.thread.id}/export`);
    await f.barrier!.arrived(1);
    const health = await fetch(`${api.address.baseUrl}/healthz`);
    expect(health.status).toBe(200);
    await health.arrayBuffer();
    expect((await api.call("GET", `/threads/${other.id}`)).status).toBe(200);
    const admitted = await api.call(
      "POST",
      `/threads/${other.id}/turns`,
      { prompt: "while exporting" },
      "turn-during-export",
    );
    expect(admitted.status, JSON.stringify(admitted.body)).toBe(202);
    const attention = await api.call("POST", "/runs/wait-many", {
      targets: [{ runId }],
      waitMs: 0,
    });
    expect(attention.status, JSON.stringify(attention.body)).toBe(200);
    expect(attention.body.summaries).toEqual([
      expect.objectContaining({ status: "succeeded", problem: null }),
    ]);
    // None of that waited for the export's read, which still holds the worker.
    expect(f.barrier!.arrivals()).toBe(1);
    const stopped = api.server.stop();
    const answer = await exporting;
    expect(answer.status, JSON.stringify(answer.body)).toBe(503);
    expect(answer.body).toMatchObject({ code: "daemon_stopping", retryable: true });
    await stopped;
    // Stop ended the wait, not the read: it keeps the worker until it ends.
    expect(f.barrier!.arrivals()).toBe(1);
    f.barrier!.release(2);
    expect(await f.graph.threads.threadClosure(f.thread.id)).toEqual(
      readThreadClosure(f.store, f.thread.id),
    );
  });

  it("a Stop while retirement observes decides nothing, and the repeated operation retires", async () => {
    const f = await fixture({ closureBarrier: true });
    f.turnWithRun("job-1");
    // The manifest the request names reads twice; retirement's own read is the third.
    f.barrier!.release(2);
    const request = await retireRequest(f, "op-stop-observing");
    const api = await served(f);
    const answer = api.call("POST", `/threads/${f.thread.id}/retire`, request);
    await f.barrier!.arrived(3);
    const stopped = api.server.stop();
    const unknown = await answer;
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(503);
    expect(unknown.body).toMatchObject({ code: "thread_retirement_unavailable", retryable: true });
    await stopped;
    expect(f.graph.threads.retirementOperation(f.thread.id, request.operationId)).toBeNull();
    expect(f.graph.threads.getThread(f.thread.id)!.state).toBe("active");
    f.barrier!.release(2 ** 31 - 1);
    const again = await served(f);
    const retired = await again.call("POST", `/threads/${f.thread.id}/retire`, request);
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body.operation).toMatchObject({ outcome: "accepted" });
  });

  it("drops a cancelled read before the worker takes it, and keeps a running one there until it ends", async () => {
    const f = await fixture({ closureBarrier: true });
    f.turnWithRun("job-1");
    const exact = readThreadClosure(f.store, f.thread.id);
    const gone = new Error("this caller left");
    await expect(f.graph.threads.threadClosure(f.thread.id, AbortSignal.abort(gone))).rejects.toBe(
      gone,
    );
    const running = new AbortController();
    const queued = new AbortController();
    const first = f.graph.threads.threadClosure(f.thread.id, running.signal);
    await f.barrier!.arrived(1);
    // The worker running that read: no single caller's cancellation ends it.
    const maintenance = f.graph.maintenance as unknown as { worker: Worker | null };
    const worker = maintenance.worker!;
    let exited = false;
    worker.once("exit", () => (exited = true));
    const second = f.graph.threads.threadClosure(f.thread.id, queued.signal);
    const third = f.graph.threads.threadClosure(f.thread.id);
    queued.abort(gone);
    await expect(second).rejects.toBe(gone);
    running.abort(gone);
    await expect(first).rejects.toBe(gone);
    // The running read still holds the worker, so nothing else was handed to it.
    await pause(50);
    expect({ exited, arrivals: f.barrier!.arrivals() }).toEqual({ exited: false, arrivals: 1 });
    f.barrier!.release(1);
    // The next read that worker takes is the third: the cancelled second never ran.
    await f.barrier!.arrived(2);
    f.barrier!.release(2);
    expect(await third).toEqual(exact);
    await pause(50);
    expect({
      exited,
      arrivals: f.barrier!.arrivals(),
      same: maintenance.worker === worker,
    }).toEqual({ exited: false, arrivals: 2, same: true });
  });

  it("answers a failed snapshot read as retryable, never by reading on the writer's thread", async () => {
    const f = await fixture();
    const { turn } = f.turnWithRun("job-1");
    const kept = f.store.prepare("SELECT body FROM turn WHERE id=?").get(turn.id) as {
      body: Uint8Array;
    };
    const setBody = (body: Uint8Array) =>
      f.store.transaction(() => {
        f.store.prepare("UPDATE turn SET body=? WHERE id=?").run(body, turn.id);
      });
    // A turn record the reader cannot decode fails the read inside the worker's snapshot.
    setBody(Buffer.from("{"));
    await expect(f.graph.threads.threadClosure(f.thread.id)).rejects.toMatchObject({
      code: "store_maintenance_failed",
      status: 503,
      retryable: true,
    });
    const api = await served(f);
    const answer = await api.call("GET", `/threads/${f.thread.id}/export`);
    expect(answer.status, JSON.stringify(answer.body)).toBe(503);
    expect(answer.body).toMatchObject({ code: "store_maintenance_failed", retryable: true });
    setBody(kept.body);
    // A snapshot that proves another store identity is refused the same way.
    const own = f.store.storeId!;
    const setStoreId = (value: string) =>
      f.store.transaction(() => {
        f.store.prepare("UPDATE meta SET value=? WHERE key='store_id'").run(value);
      });
    setStoreId("another-store");
    await expect(f.graph.threads.threadClosure(f.thread.id)).rejects.toMatchObject({
      code: "store_maintenance_failed",
      status: 503,
      retryable: true,
    });
    setStoreId(own);
    // The same worker reads again once both do.
    expect(await f.graph.threads.threadClosure(f.thread.id)).toEqual(
      readThreadClosure(f.store, f.thread.id),
    );
  });

  it("fails a read whose worker exits as retryable, and a fresh worker serves the queue", async () => {
    const f = await fixture({ closureBarrier: true });
    f.turnWithRun("job-1");
    const first = f.graph.threads.threadClosure(f.thread.id);
    await f.barrier!.arrived(1);
    const second = f.graph.threads.threadClosure(f.thread.id);
    // Observed before the worker ends, as a caller awaiting it is.
    const ended = first.then(
      () => "answered",
      (error: unknown) => error,
    );
    // The worker the store's controller spawned, ended from outside mid-read.
    await (f.graph.maintenance as unknown as { worker: Worker }).worker.terminate();
    expect(await ended).toMatchObject({
      code: "store_maintenance_unavailable",
      status: 503,
      retryable: true,
    });
    await f.barrier!.arrived(2);
    f.barrier!.release(2);
    expect(await second).toEqual(readThreadClosure(f.store, f.thread.id));
    // No snapshot outlives its worker: with both reads ended, the writer resets the WAL.
    const deadline = Date.now() + 10_000;
    let checkpoint = { busy: 1, log: -1 };
    while (Date.now() < deadline) {
      checkpoint = f.store.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as typeof checkpoint;
      if (Number(checkpoint.busy) === 0 && Number(checkpoint.log) === 0) break;
      await pause(10);
    }
    expect({ busy: Number(checkpoint.busy), log: Number(checkpoint.log) }).toEqual({
      busy: 0,
      log: 0,
    });
  });

  it("rejects running and queued reads when the store stops its worker, and every read after", async () => {
    const f = await fixture({ closureBarrier: true });
    f.turnWithRun("job-1");
    const running = f.graph.threads.threadClosure(f.thread.id);
    await f.barrier!.arrived(1);
    const queued = f.graph.threads.threadClosure(f.thread.id);
    // Observed before the stop, as callers awaiting them are.
    const outcomes = Promise.allSettled([running, queued]);
    await f.graph.maintenance.stop();
    expect(await outcomes).toEqual([
      {
        status: "rejected",
        reason: expect.objectContaining({ code: "store_closed", status: 503 }),
      },
      {
        status: "rejected",
        reason: expect.objectContaining({ code: "store_closed", status: 503 }),
      },
    ]);
    await expect(f.graph.threads.threadClosure(f.thread.id)).rejects.toMatchObject({
      code: "store_closed",
    });
    expect(f.barrier!.arrivals()).toBe(1);
  });
});

describe("physical removal rechecks what was accepted", () => {
  /** `before` runs once the closure's files exist and before the export is read. */
  async function accepted(
    before?: (f: Awaited<ReturnType<typeof fixture>>, run: { runDir: string }) => void,
  ) {
    const f = await fixture();
    const run = f.turnWithRun("job-1");
    write(join(f.lanes, "codex-default", "home", "state.txt"), "lane bytes\n");
    write(join(f.lanes, "codex-default", "home", ".codex", "auth.json"), "AUTH-SENTINEL");
    write(join(f.lanes, "summaries", "t.md"), "summary\n");
    before?.(f, run);
    const manifest = await f.service().threadExportManifest(f.thread.id);
    expect(manifest.gaps).toEqual([]);
    const digests = await f.consumer(manifest);
    return {
      f,
      manifest,
      digests,
      lane: await f.acceptedLane(manifest),
      request: {
        operationId: "op-accept",
        exportId: manifest.exportId,
        closureDigest: manifest.closureDigest,
        ...digests,
      },
    };
  }

  it("deletes the lane after verified acceptance, reporting removal only after its barrier", async () => {
    const { f, request } = await accepted();
    const receipt = await f.service().retireThread(f.thread.id, request);
    expect(receipt.acceptance).toMatchObject({ operationId: "op-accept" });
    expect(receipt.operation).toMatchObject({ outcome: "accepted" });
    expect(existsSync(f.lanes)).toBe(false);
    await f.store.flushed();
    await expect
      .poll(() => f.service().threadRetirement(f.thread.id, "op-accept").status, {
        timeout: 20_000,
      })
      .toBe("removed");
  });

  it("refuses when the engine cannot reproduce the caller's digests from disk", async () => {
    const { f, request } = await accepted();
    await expect(
      f.service().retireThread(f.thread.id, {
        ...request,
        operationId: "op-forged",
        contentDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "thread_export_stale", context: { settled: true } });
    await expect(
      f.service().retireThread(f.thread.id, {
        ...request,
        operationId: "op-forged-lane",
        laneDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "thread_lane_changed" });
    expect(f.graph.threads.getThread(f.thread.id)!.state).toBe("active");
    expect(existsSync(f.lanes)).toBe(true);
  });

  // Same size, and the integer-second mtime restored after the write: the export
  // identity cannot tell, so only hashing the bytes again refuses them.
  const AT = 1_700_000_000;
  it.each([
    [
      "a lane byte",
      (f: Fixture, _run: { runDir: string }) => join(f.lanes, "codex-default", "home", "state.txt"),
      "lane bytes\n",
      "thread_lane_changed",
      "the lane bytes differ from the export's lane digest",
    ],
    [
      "a run byte",
      (_f: Fixture, run: { runDir: string }) => join(run.runDir, "final", "answer.md"),
      "the answer\n",
      "thread_export_stale",
      "exported bytes differ from the content digest",
    ],
  ] as const)(
    "refuses %s changed after export with its size and mtime restored, by its hash",
    async (_name, path, bytes, code, message) => {
      let file = "";
      const { f, request, manifest } = await accepted((f, run) => {
        file = path(f, run);
        write(file, bytes);
        utimesSync(file, AT, AT);
      });
      writeFileSync(file, bytes.toUpperCase());
      utimesSync(file, AT, AT);
      const again = await f.service().threadExportManifest(f.thread.id);
      expect(again.exportId).toBe(manifest.exportId);
      await expect(f.service().retireThread(f.thread.id, request)).rejects.toMatchObject({
        code,
        message,
        context: { settled: true },
      });
      expect(readFileSync(file, "utf8")).toBe(bytes.toUpperCase());
      expect(f.graph.threads.getThread(f.thread.id)!.state).toBe("active");
    },
  );

  it("keeps a lane changed after acceptance, stays pending with the reason, and finishes once it matches", async () => {
    const { f, request, lane } = await accepted();
    // Accepted in SQL alone: the state a crash between decision and cleanup leaves.
    f.graph.threads.retireThread(f.thread.id, request, lane);
    const file = join(f.lanes, "codex-default", "home", "state.txt");
    writeFileSync(file, "a late writer\n");
    const owner = f.owner();
    const purged = f.graph.threads.getThread(f.thread.id)!;
    await expect(owner.finishPurge(purged)).rejects.toMatchObject({ code: "thread_lane_changed" });
    expect(readFileSync(file, "utf8")).toBe("a late writer\n");
    const pending = f.service().threadRetirement(f.thread.id, null);
    expect(pending.status).toBe("accepted_pending_removal");
    expect(pending.cleanup?.reason).toContain(
      "codex-default/home/state.txt changed after acceptance",
    );

    // The orphan sweep must not delete what the recheck is holding back.
    const references = await f.graph.threads.retentionReferences(new Set());
    try {
      expect([...references.laneThreadIds!(noProjectRepoRoot())]).toContain(f.thread.id);
    } finally {
      references.close?.();
    }
    // A restart replays the same check, through the same obligation.
    const { graph } = await f.reopen();
    const replay = await graph.obligations.completeOpen();
    expect(replay.failed.map((row) => row.key)).toEqual([f.thread.id]);
    expect(existsSync(file)).toBe(true);

    writeFileSync(file, "lane bytes\n");
    const reopened = f.current();
    await threadPurgeOwner(
      reopened.graph.threads,
      noProjectRepoRoot(),
      reopened.graph.purgeFiles,
      laneCredentialStores,
    ).finishPurge(purged);
    expect(existsSync(f.lanes)).toBe(false);
  });

  // A real partial deletion through the real purge path: one directory cannot be
  // emptied, so the first attempt stops part way, then cleanup stays pending.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a retry after a real partial deletion refuses lane bytes that changed or arrived since",
    async () => {
      const f = await fixture();
      f.turnWithRun("job-1");
      const home = join(f.lanes, "codex-default", "home");
      const locked = join(home, "locked");
      write(join(home, "state.txt"), "lane bytes\n");
      const kept = write(join(locked, "kept.txt"), "accepted bytes\n");
      write(join(f.lanes, "summaries", "t.md"), "summary\n");
      const manifest = await f.service().threadExportManifest(f.thread.id);
      expect(manifest.gaps).toEqual([]);
      const digests = await f.consumer(manifest);
      chmodSync(locked, 0o555);
      restores.push(() => {
        if (existsSync(locked)) chmodSync(locked, 0o755);
      });
      const receipt = await f.service().retireThread(f.thread.id, {
        operationId: "op-partial",
        exportId: manifest.exportId,
        closureDigest: manifest.closureDigest,
        ...digests,
      });
      expect(receipt.operation).toMatchObject({ outcome: "accepted" });
      expect(receipt.status).toBe("accepted_pending_removal");
      expect(existsSync(kept)).toBe(true);
      chmodSync(locked, 0o755);
      // While the cleanup is pending, an accepted byte changes and a new file arrives.
      writeFileSync(kept, "changed after acceptance\n");
      const arrived = write(join(home, "arrived.txt"), "never exported\n");
      const purged = f.graph.threads.getThread(f.thread.id)!;
      await expect(f.owner().finishPurge(purged)).rejects.toMatchObject({
        code: "thread_lane_changed",
      });
      expect(readFileSync(kept, "utf8")).toBe("changed after acceptance\n");
      expect(existsSync(arrived)).toBe(true);
      expect(f.service().threadRetirement(f.thread.id, null)).toMatchObject({
        status: "accepted_pending_removal",
        cleanup: { reason: expect.stringContaining("lane") },
      });
      // Once only accepted bytes remain, the same pending cleanup finishes.
      writeFileSync(kept, "accepted bytes\n");
      rmSync(arrived);
      await f.owner().finishPurge(purged);
      expect(existsSync(f.lanes)).toBe(false);
    },
  );

  // A deletion that stopped part way leaves only an open obligation and fewer
  // accepted entries; there is no other state, so this is that retry exactly.
  it.each([
    ["only accepted bytes remain", () => undefined, null],
    [
      "an accepted byte changed",
      (home: string) => writeFileSync(join(home, "state.txt"), "LANE BYTES\n"),
      "codex-default/home/state.txt changed after acceptance",
    ],
    [
      "a file arrived",
      (home: string) => write(join(home, "arrived.txt"), "never exported\n"),
      "codex-default/home/arrived.txt arrived after acceptance",
    ],
    [
      "an accepted file became a link",
      (home: string) => {
        rmSync(join(home, "state.txt"));
        symlinkSync("/elsewhere", join(home, "state.txt"));
      },
      "codex-default/home/state.txt changed after acceptance",
    ],
  ] as const)(
    "a retry after a partial deletion, where %s, deletes only accepted bytes",
    async (_name, change, refusal) => {
      const { f, request, lane } = await accepted();
      f.graph.threads.retireThread(f.thread.id, request, lane);
      rmSync(join(f.lanes, "summaries"), { recursive: true });
      const home = join(f.lanes, "codex-default", "home");
      change(home);
      const purged = f.graph.threads.getThread(f.thread.id)!;
      if (refusal === null) {
        await f.owner().finishPurge(purged);
        expect(existsSync(f.lanes)).toBe(false);
        return;
      }
      await expect(f.owner().finishPurge(purged)).rejects.toMatchObject({
        code: "thread_lane_changed",
      });
      expect(existsSync(home)).toBe(true);
      expect(f.service().threadRetirement(f.thread.id, null)).toMatchObject({
        status: "accepted_pending_removal",
        cleanup: { reason: expect.stringContaining(refusal) },
      });
    },
  );

  it("a retired thread reaching cleanup without its accepted lane deletes nothing", async () => {
    const { f, request, lane } = await accepted();
    f.graph.threads.retireThread(f.thread.id, request, lane);
    const purged = f.graph.threads.getThread(f.thread.id)!;
    // The owner without its durable obligation: no accepted inventory reaches it.
    const bare = threadPurgeOwner(
      f.graph.threads,
      noProjectRepoRoot(),
      undefined,
      laneCredentialStores,
    );
    await expect(bare.finishPurge(purged)).rejects.toMatchObject({ code: "thread_lane_changed" });
    expect(existsSync(f.lanes)).toBe(true);
  });

  it("answers a busy closure as a settled refusal of that operation", async () => {
    const { f, request } = await accepted();
    f.command({ id: "live", state: "running", params: { threadId: f.thread.id } });
    await expect(f.service().retireThread(f.thread.id, request)).rejects.toMatchObject({
      code: "thread_busy",
      status: 409,
      context: { settled: true },
    });
    expect(f.service().threadRetirement(f.thread.id, request.operationId)).toMatchObject({
      status: "not_accepted",
      operation: { outcome: "refused", code: "thread_busy" },
    });
  });

  it("settles an unanswered operation so it can never accept", async () => {
    const { f, request } = await accepted();
    const fenced = f.service().abandonThreadRetirement(f.thread.id, request.operationId);
    expect(fenced).toMatchObject({
      status: "not_accepted",
      operation: { operationId: request.operationId, outcome: "abandoned" },
    });
    await expect(f.service().retireThread(f.thread.id, request)).rejects.toMatchObject({
      code: "thread_retirement_abandoned",
      context: { settled: true },
    });
    expect(f.graph.threads.getThread(f.thread.id)!.state).toBe("active");
    // A read alone settles nothing.
    expect(f.service().threadRetirement(f.thread.id, "op-unknown").operation).toBeNull();
  });

  it("abandoning an already accepted operation reports the acceptance", async () => {
    const { f, request } = await accepted();
    await f.service().retireThread(f.thread.id, request);
    expect(f.service().abandonThreadRetirement(f.thread.id, request.operationId)).toMatchObject({
      operation: { outcome: "accepted" },
      acceptance: { operationId: request.operationId },
    });
  });

  it("replays one acceptance, and refuses another operation or other digests", async () => {
    const { f, request } = await accepted();
    const first = await f.service().retireThread(f.thread.id, request);
    const again = await f.service().retireThread(f.thread.id, request);
    expect(again.acceptance).toEqual(first.acceptance);
    await expect(
      f.service().retireThread(f.thread.id, { ...request, operationId: "op-other" }),
    ).rejects.toMatchObject({ code: "thread_retirement_conflict", context: { settled: true } });
    await expect(
      f.service().retireThread(f.thread.id, { ...request, laneDigest: `sha256:${"1".repeat(64)}` }),
    ).rejects.toMatchObject({ code: "thread_retirement_conflict" });
  });

  it("isolated worktrees stay outside and block retirement", async () => {
    const { f } = await accepted();
    const thread = f.graph.threads.getThread(f.thread.id)!;
    const dir = ownedProjectRuntimeDir(noProjectRepoRoot(), "threads", thread.id);
    mkdirSync(dir, { recursive: true });
    const stored = { ...thread, workspace: { ...thread.workspace, mode: "isolated" as const } };
    f.store.transaction(() => {
      f.store
        .prepare("UPDATE thread SET body=? WHERE id=?")
        .run(Buffer.from(JSON.stringify(stored)), thread.id);
    });
    const manifest = await f.service().threadExportManifest(f.thread.id);
    expect(manifest.gaps.map((gap) => gap.code)).toContain("isolated_worktree_present");
  });
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Threads = Fixture["graph"]["threads"];

/** The fixture's SQL owners with one method observed; every other call is the owner's own. */
function observed<K extends keyof Threads>(threads: Threads, name: K, around: Threads[K]): Threads {
  return new Proxy(threads, {
    get(target, prop) {
      if (prop === name) return around;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/**
 * The real control API over the fixture's SQL owners. The daemon side is the
 * daemon's own enqueue admission (`claudexor.enqueue`) over the same command
 * store, with no runner: an accepted job stays queued, and the route answers its
 * receipt at once.
 */
async function served(f: Fixture, options: { threads?: Threads; preflight?: () => void } = {}) {
  const { graph } = f.current();
  const threads = options.threads ?? graph.threads;
  const commands = graph.commands;
  const daemon = {
    enqueue: (request: unknown, opts: Record<string, unknown> = {}) =>
      enqueueStaged(
        { request, ...opts, clientId: opts["clientId"] ?? "daemon-client" },
        { commands, stopping: () => false, publish: () => undefined },
      ),
    findAccepted: async (request: unknown, opts: Record<string, unknown>) =>
      publicAcceptedCommand(commands, { request, ...opts }),
    status: async (id: string) => {
      const record = commands.queries.select({ ids: [id] })[0];
      if (!record) throw new Error(`no such job: ${id}`);
      return publicJobRecord(record);
    },
    list: async (query: unknown) => commands.queries.publicList(parseCommandListQuery(query)),
  };
  const owner = threadPurgeOwner(
    threads,
    noProjectRepoRoot(),
    graph.purgeFiles,
    laneCredentialStores,
  );
  const server = new DaemonControlApiServer({
    token: "retire-token",
    daemon: daemon as never,
    runStartTimeoutMs: 0,
    // The inbox attention read as the daemon wires it (`sqlControlReadSources`).
    runObservations: (ids, signal) =>
      readRunObservations(commands.queries, graph.interactions, graph.store.storeId!, ids, signal),
    services: {
      ...threadTurnServices(threads, { resolve: () => [] }),
      preflightThreadRunRequirements: async () => options.preflight?.(),
      // The delivery journal and the lifecycle routes as the daemon wires them.
      beginDelivery: async (params: unknown, input: never) => commands.beginDelivery(params, input),
      completeDelivery: async (id: string, result: unknown) =>
        commands.completeDelivery(id, result),
      failDelivery: async (id: string, error: unknown) => commands.failDelivery(id, error),
      trashThread: async (id: string) => threads.trashThread(id),
      purgeThread: (id: string) => owner.purgeThread(id),
      threadExport: threadExportService(
        threads,
        { resolve: () => [] },
        (thread: Thread, signal?: AbortSignal) => owner.finishPurge(thread, signal),
        (thread: Thread) => owner.hasPurgeLeftovers(thread),
      ),
    } as never,
  });
  cleanup.push(() => server.stop());
  const { host, port } = await server.start();
  const call = async (method: string, path: string, body?: unknown, key?: string) => {
    const response = await fetch(`http://${host}:${port}/v2${path}`, {
      method,
      headers: {
        authorization: "Bearer retire-token",
        "content-type": "application/json",
        "x-claudexor-protocol-major": String(CONTROL_PROTOCOL_MAJOR),
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch((error: unknown) => ({ status: 0, text: async () => String(error) }));
    const text = await response.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* a raw answer stays text */
    }
    return { status: response.status, body: parsed };
  };
  /** Every command row the store holds for this thread. */
  const threadCommands = () =>
    f.store
      .prepare("SELECT id,state FROM command WHERE thread_id=? ORDER BY id")
      .all(f.thread.id) as {
      id: string;
      state: string;
    }[];
  /** Where the real `claudexor thread` consumer reaches these routes. */
  const address = { baseUrl: `http://${host}:${port}`, token: "retire-token" };
  return { server, call, threadCommands, address };
}

async function retireRequest(f: Fixture, operationId: string) {
  const manifest = await f.service().threadExportManifest(f.thread.id);
  expect(manifest.gaps).toEqual([]);
  return {
    operationId,
    exportId: manifest.exportId,
    closureDigest: manifest.closureDigest,
    ...(await f.consumer(manifest)),
  };
}

describe("a retired thread admits no new work, and replays what it accepted", () => {
  const refusal = () =>
    Object.assign(new Error("a fixture requirement is unavailable"), {
      status: 409,
      code: "requirement_unavailable",
      retryable: false,
    });

  it("refuses the replay of a refused turn's create after retirement, writing nothing", async () => {
    const f = await fixture();
    f.turnWithRun("job-1");
    let refusing = true;
    const api = await served(f, {
      preflight: () => {
        if (refusing) throw refusal();
      },
    });
    const turns = `/threads/${f.thread.id}/turns`;
    const refused = await api.call("POST", turns, { prompt: "once more" }, "turn-refused");
    expect(refused.status).toBe(409);
    const orphan = f.graph.threads.turnsFor(f.thread.id).at(-1)!;
    expect(orphan).toMatchObject({
      run_id: null,
      enqueue_error: { code: "requirement_unavailable" },
    });
    expect(api.threadCommands().map((row) => row.id)).toEqual(["job-1"]);

    // A refused, runless turn is finished, so the exact export retires the thread.
    const retired = await api.call(
      "POST",
      `/threads/${f.thread.id}/retire`,
      await retireRequest(f, "op-retire"),
    );
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body.operation).toMatchObject({ outcome: "accepted" });
    const head = () =>
      (
        f.store.prepare("SELECT head_revision FROM thread WHERE id=?").get(f.thread.id) as {
          head_revision: number;
        }
      ).head_revision;
    const revision = head();

    // Whatever refused the turn has cleared; the same create is repeated.
    refusing = false;
    const replay = await api.call("POST", turns, { prompt: "once more" }, "turn-refused");
    expect(replay.status, JSON.stringify(replay.body)).toBe(409);
    expect(replay.body).toMatchObject({ code: "thread_purged", retryable: false });
    expect(api.threadCommands().map((row) => row.id)).toEqual(["job-1"]);
    expect(f.graph.threads.getTurn(orphan.id)).toEqual(orphan);
    expect(head()).toBe(revision);
    expect(f.graph.threads.getThread(f.thread.id)!.state).toBe("purged");
  });

  it("answers new work with one typed refusal on every route, recording nothing", async () => {
    const f = await fixture();
    const { runId } = f.turnWithRun("job-1");
    let refusing = true;
    const api = await served(f, {
      preflight: () => {
        if (refusing) throw refusal();
      },
    });
    const turns = `/threads/${f.thread.id}/turns`;
    // A turn refused before any job existed.
    expect((await api.call("POST", turns, { prompt: "refused" }, "turn-refused")).status).toBe(409);
    const noJob = f.graph.threads.turnsFor(f.thread.id).at(-1)!;
    // A turn whose job stopped before it started, the kind a retry replays.
    refusing = false;
    const started = await api.call("POST", turns, { prompt: "stopped" }, "turn-stopped");
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    f.current().graph.commands.findById(started.body.jobId)!.update(started.body.jobId, {
      state: "cancelled",
      finishedAt: new Date().toISOString(),
    });
    f.graph.threads.setTurnEnqueueError(started.body.turnId, {
      code: "run_cancelled_before_start",
      message: "cancelled before it started",
      retryable: true,
      required_actions: [],
      context: {},
    });
    const retired = await api.call(
      "POST",
      `/threads/${f.thread.id}/retire`,
      await retireRequest(f, "op-retire"),
    );
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    const before = f.graph.threads.turnsFor(f.thread.id);
    const commandsBefore = api.threadCommands();

    const answers = {
      create: await api.call("POST", turns, { prompt: "fresh" }, "turn-fresh"),
      refusedTurnRetry: await api.call(
        "POST",
        `${turns}/${started.body.turnId}/retry`,
        {},
        "turn-retry",
      ),
      noJobTurnRetry: await api.call("POST", `${turns}/${noJob.id}/retry`, {}, "no-job-retry"),
      exactRetry: await api.call("POST", `/runs/${runId}/retry`, {}, "run-retry"),
      decisionRerun: await api.call(
        "POST",
        `/runs/${runId}/decision`,
        { action: "rerun_with_feedback", feedback: "again" },
        "run-rerun",
      ),
    };
    expect(
      Object.fromEntries(
        Object.entries(answers).map(([route, answer]) => [
          route,
          { status: answer.status, code: answer.body?.code, retryable: answer.body?.retryable },
        ]),
      ),
    ).toEqual({
      create: { status: 409, code: "thread_purged", retryable: false },
      refusedTurnRetry: { status: 409, code: "thread_purged", retryable: false },
      noJobTurnRetry: { status: 409, code: "thread_purged", retryable: false },
      exactRetry: { status: 409, code: "thread_purged", retryable: false },
      decisionRerun: { status: 409, code: "thread_purged", retryable: false },
    });
    expect(api.threadCommands()).toEqual(commandsBefore);
    expect(f.graph.threads.turnsFor(f.thread.id)).toEqual(before);
    // The thread's own lifecycle and history answer what they always did.
    expect((await api.call("POST", `/threads/${f.thread.id}/trash`)).status).toBe(410);
    expect((await api.call("GET", `/threads/${f.thread.id}/export`)).status).toBe(410);
  });

  it("still admits that replay while the thread is active", async () => {
    const f = await fixture();
    let refusing = true;
    const api = await served(f, {
      preflight: () => {
        if (refusing) throw refusal();
      },
    });
    const turns = `/threads/${f.thread.id}/turns`;
    expect((await api.call("POST", turns, { prompt: "q" }, "turn-1")).status).toBe(409);
    refusing = false;
    const replay = await api.call("POST", turns, { prompt: "q" }, "turn-1");
    expect(replay.status, JSON.stringify(replay.body)).toBe(202);
    expect(api.threadCommands()).toEqual([{ id: replay.body.jobId, state: "queued" }]);
    // The accepted command is the authority from now on: no second one.
    const again = await api.call("POST", turns, { prompt: "q" }, "turn-1");
    expect(again.body.jobId).toBe(replay.body.jobId);
    expect(api.threadCommands()).toHaveLength(1);
  });

  it("answers a create it accepted before retirement with its original command", async () => {
    const f = await fixture();
    const api = await served(f);
    const turns = `/threads/${f.thread.id}/turns`;
    const accepted = await api.call("POST", turns, { prompt: "q" }, "turn-ok");
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    // It never started: the runner's pre-start terminal and its recorded refusal.
    const job = accepted.body.jobId as string;
    f.current().graph.commands.findById(job)!.update(job, {
      state: "cancelled",
      finishedAt: new Date().toISOString(),
    });
    f.graph.threads.setTurnEnqueueError(accepted.body.turnId, {
      code: "run_cancelled_before_start",
      message: "cancelled before it started",
      retryable: true,
      required_actions: [],
      context: {},
    });
    const retired = await api.call(
      "POST",
      `/threads/${f.thread.id}/retire`,
      await retireRequest(f, "op-retire"),
    );
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    // Its terminal answer, as a problem whose context names the original job.
    const replay = await api.call("POST", turns, { prompt: "q" }, "turn-ok");
    expect(replay.body.context).toMatchObject({ jobId: job, turnId: accepted.body.turnId });
    expect(api.threadCommands()).toEqual([{ id: job, state: "cancelled" }]);
  });

  it("admits no fresh command naming a purged thread at the daemon's own admission", async () => {
    const f = await fixture();
    const { graph } = f.current();
    const enqueue = (request: Record<string, unknown>, key: string) =>
      enqueueStaged(
        { request, idempotencyKey: key, clientId: "control-api", operation: "thread.turn.create" },
        { commands: graph.commands, stopping: () => false, publish: () => undefined },
      );
    const params = { mode: "ask", prompt: "work", scope: { kind: "none" } };
    const before = await enqueue({ ...params, threadId: f.thread.id }, "before");
    expect(before.reused).toBe(false);
    graph.commands.findById(before.id)!.update(before.id, {
      state: "cancelled",
      finishedAt: new Date().toISOString(),
    });
    const { digest } = (await graph.threads.threadClosure(f.thread.id))!;
    graph.threads.retireThread(
      f.thread.id,
      {
        operationId: "op-store",
        exportId: `sha256:${"e".repeat(64)}`,
        closureDigest: digest,
        contentDigest: `sha256:${"c".repeat(64)}`,
        laneDigest: `sha256:${"f".repeat(64)}`,
      },
      [],
    );
    // An accepted command still answers its own replay.
    expect(await enqueue({ ...params, threadId: f.thread.id }, "before")).toMatchObject({
      id: before.id,
      reused: true,
    });
    await expect(enqueue({ ...params, threadId: f.thread.id }, "after")).rejects.toMatchObject({
      code: "thread_purged",
      status: 409,
    });
    // A standalone command is not a thread's work.
    expect((await enqueue(params, "standalone")).reused).toBe(false);
    expect(
      (
        f.store.prepare("SELECT count(*) AS n FROM command WHERE thread_id=?").get(f.thread.id) as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });
});

describe("a purge ends new work, never the delivery of a retained result", () => {
  /** A finished in-place turn of the fixture's thread: it changed a real
   * repository and keeps the revert anchor its run recorded. */
  async function inPlaceTurn(f: Fixture) {
    const repo = mkdtempSync(join(tmpdir(), "cx-retire-repo-"));
    removals.push(() => rmSync(repo, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "file.txt"), "before\n");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base");
    const before = await snapshotTree(repo);
    writeFileSync(join(repo, "file.txt"), "the turn's edit\n");
    const after = await snapshotTree(repo);
    const anchor = await createRevertAnchorOrNull(repo, before, after, repo);
    expect(anchor).toMatch(/^sha256:[0-9a-f]{64}$/);
    const turn = f.graph.threads.createTurn(f.thread.id, "edit the file");
    const run = f.command({
      id: "job-edit",
      params: { mode: "agent", threadId: f.thread.id, turnId: turn.id },
    });
    f.graph.threads.bindTurnRun(turn.id, run.runId);
    // The run's WorkProduct snapshot as the orchestrator stamps it (JSON is YAML).
    writeFileSync(
      join(run.runDir, "final", "work_product.yaml"),
      JSON.stringify({
        id: "wp-edit",
        kind: "patch",
        source_task_id: run.record.taskId,
        producer_attempt_id: "a01",
        meta: {
          result_kind: "patch",
          lifecycle: "succeeded",
          adopted: true,
          apply_state: "applied",
          pre_turn_sha: before,
          post_turn_sha: after,
          revert_anchor_id: anchor,
          execution_root: repo,
        },
      }),
    );
    return { repo, runId: run.runId };
  }
  const freshTurn = (f: Fixture, key: string) =>
    enqueueStaged(
      {
        request: { mode: "ask", prompt: "work", scope: { kind: "none" }, threadId: f.thread.id },
        idempotencyKey: key,
        clientId: "control-api",
        operation: "thread.turn.create",
      },
      { commands: f.current().graph.commands, stopping: () => false, publish: () => undefined },
    );

  it("reverts a purged thread's in-place turn, replays that revert, and refuses new work", async () => {
    const f = await fixture();
    const turn = await inPlaceTurn(f);
    const api = await served(f);
    expect((await api.call("POST", `/threads/${f.thread.id}/trash`)).status).toBe(200);
    const purged = await api.call("POST", `/threads/${f.thread.id}/purge`);
    expect(purged.status, JSON.stringify(purged.body)).toBe(200);
    // The ordinary purge: no retirement stands behind it.
    expect(f.graph.threads.getThread(f.thread.id)).toMatchObject({ state: "purged" });
    expect(f.graph.threads.getThread(f.thread.id)!.retirement).toBeFalsy();

    const decision = `/runs/${turn.runId}/decision`;
    const reverted = await api.call("POST", decision, { action: "revert_run" }, "revert-1");
    expect(reverted.status, JSON.stringify(reverted.body)).toBe(200);
    expect(reverted.body).toMatchObject({ accepted: true, status: "applied" });
    expect(readFileSync(join(turn.repo, "file.txt"), "utf8")).toBe("before\n");
    // One durable delivery receipt, recorded with the thread's other commands.
    expect(api.threadCommands()).toEqual([
      { id: expect.stringMatching(/^delivery-/), state: "succeeded" },
      { id: "job-edit", state: "succeeded" },
    ]);
    // Its replay answers that receipt and changes nothing.
    expect(await api.call("POST", decision, { action: "revert_run" }, "revert-1")).toEqual(
      reverted,
    );
    expect(api.threadCommands()).toHaveLength(2);

    // New work stays refused: through the route and at the daemon's own admission.
    const next = await api.call("POST", `/threads/${f.thread.id}/turns`, { prompt: "q" }, "t-2");
    expect(next.status, JSON.stringify(next.body)).toBe(409);
    expect(next.body).toMatchObject({ code: "thread_purged" });
    await expect(freshTurn(f, "fresh-after-purge")).rejects.toMatchObject({
      code: "thread_purged",
      status: 409,
    });
    expect(api.threadCommands()).toHaveLength(2);
  });

  it("admits each consumer's delivery of a retained result at the store, and no fresh command", async () => {
    const f = await fixture();
    const { turn, runId } = f.turnWithRun("job-1");
    f.graph.threads.trashThread(f.thread.id);
    await f.owner().purgeThread(f.thread.id);
    // A run's delivery names the run's own (listed) params; thread apply names the thread.
    const runParams = { mode: "ask", threadId: f.thread.id, turnId: turn.id };
    const body = { action: "x" };
    const consumers: [string, unknown, unknown][] = [
      ["run.apply", runParams, { runId, body, patchSha256: "p", repoRoot: "/r" }],
      ["run.decision.accept_clean_patch", runParams, { runId, body, patchSha256: "p" }],
      ["run.decision.discard", runParams, { runId, body }],
      ["run.decision.revert", runParams, { runId, body }],
      ["run.message", runParams, { runId, body }],
      ["thread.apply", { threadId: f.thread.id }, { threadId: f.thread.id, runIds: [runId] }],
    ];
    for (const [operation, params, request] of consumers) {
      const input = { key: `key-${operation}`, client: "control-api", operation, request };
      const begun = f.graph.commands.beginDelivery(params, input);
      expect(begun, operation).toMatchObject({ reused: false, state: "running" });
      f.graph.commands.completeDelivery(begun.id, { delivered: operation });
      expect(f.graph.commands.beginDelivery(params, input), operation).toMatchObject({
        id: begun.id,
        reused: true,
        state: "succeeded",
      });
    }
    await expect(freshTurn(f, "fresh-after-purge")).rejects.toMatchObject({
      code: "thread_purged",
      status: 409,
    });
  });
});

describe("the server's Stop decides nothing after it arrives", () => {
  /** A thread whose digest pass ends on SQL records: its turn's is the last. */
  async function stopping(at: "final record's yield" | "final record's read") {
    const f = await fixture();
    f.turnWithRun("job-1");
    write(join(f.lanes, "codex-default", "home", "state.txt"), "lane bytes\n");
    const request = await retireRequest(f, "op-stop");
    const manifest = await f.service().threadExportManifest(f.thread.id);
    const sql = manifest.items.filter((item) => item.plane === "sql").map((item) => item.path);
    expect(manifest.items.at(-1)!.path).toBe(sql.at(-1));
    expect(sql.at(-1)).toMatch(/^sql\/turns\//);
    const { graph } = f.current();
    let armed = false;
    const reads = new Map<string, number>();
    let stopped: Promise<void> | undefined;
    const threads = observed(graph.threads, "threadClosureDocument", (id, key) => {
      if (armed) {
        const seen = (reads.get(key) ?? 0) + 1;
        reads.set(key, seen);
        // The inventory reads each record once, then the digest pass again, in
        // path order: the thread's record next to last, the turn's last.
        if (seen === 2 && at === "final record's yield" && key === "thread")
          setImmediate(() => void (stopped = api.server.stop()));
        if (seen === 2 && at === "final record's read" && key.startsWith("turn:"))
          stopped = api.server.stop();
      }
      return graph.threads.threadClosureDocument(id, key);
    });
    const api = await served(f, { threads });
    armed = true;
    const answer = await api.call("POST", `/threads/${f.thread.id}/retire`, request);
    await stopped;
    return { f, request, answer, stoppedAt: stopped };
  }

  it.each(["final record's yield", "final record's read"] as const)(
    "a Stop at the %s accepts nothing and binds nothing",
    async (at) => {
      const { f, request, answer, stoppedAt } = await stopping(at);
      expect(stoppedAt).toBeDefined();
      expect(answer.status, JSON.stringify(answer.body)).toBe(503);
      expect(answer.body).toMatchObject({ code: "thread_retirement_unavailable", retryable: true });
      expect(f.graph.threads.getThread(f.thread.id)!.state).toBe("active");
      expect(f.graph.threads.retirementOperation(f.thread.id, request.operationId)).toBeNull();
      expect(f.graph.obligations.get("purge_fs", f.thread.id)).toBeFalsy();
      expect(existsSync(f.lanes)).toBe(true);
      // The same operation, repeated to a running engine, is accepted.
      const again = await served(f);
      const retired = await again.call("POST", `/threads/${f.thread.id}/retire`, request);
      expect(retired.status, JSON.stringify(retired.body)).toBe(200);
      expect(retired.body.operation).toMatchObject({ outcome: "accepted" });
    },
  );

  it("a Stop after acceptance leaves its cleanup pending, never undone or reported removed", async () => {
    const f = await fixture();
    f.turnWithRun("job-1");
    const kept = write(join(f.lanes, "codex-default", "home", "state.txt"), "lane bytes\n");
    const request = await retireRequest(f, "op-accepted");
    const { graph } = f.current();
    let stopped: Promise<void> | undefined;
    const threads = observed(graph.threads, "retireThread", (id, body, lane) => {
      const accepted = graph.threads.retireThread(id, body, lane);
      setImmediate(() => void (stopped = api.server.stop()));
      return accepted;
    });
    const api = await served(f, { threads });
    const answer = await api.call("POST", `/threads/${f.thread.id}/retire`, request);
    await stopped;
    expect(stopped).toBeDefined();
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toMatchObject({
      status: "accepted_pending_removal",
      operation: { outcome: "accepted" },
      acceptance: { operationId: "op-accepted" },
    });
    expect(readFileSync(kept, "utf8")).toBe("lane bytes\n");
    expect(f.graph.threads.getThread(f.thread.id)!.state).toBe("purged");
    expect(f.graph.obligations.get("purge_fs", f.thread.id)).toMatchObject({ state: "pending" });
    // The obligation finishes it once the engine runs again.
    const { graph: reopened } = await f.reopen();
    await reopened.obligations.completeOpen();
    expect(existsSync(f.lanes)).toBe(false);
  });
});

describe("the retention pass and a restart retry a pending cleanup, and Stop ends either retry", () => {
  /** A retirement accepted in SQL alone, the state a crash between decision and cleanup
   * leaves: its lane is on disk and its cleanup obligation is open. */
  async function acceptedNotCleaned() {
    const f = await fixture();
    f.turnWithRun("job-1");
    const home = join(f.lanes, "codex-default", "home");
    const files = [
      write(join(home, "state.txt"), "lane bytes\n"),
      write(join(home, "notes.txt"), "more lane bytes\n"),
      write(join(home, ".codex", "auth.json"), "AUTH-SENTINEL"),
      write(join(f.lanes, "summaries", "t.md"), "summary\n"),
    ];
    const request = await retireRequest(f, "op-maintenance");
    const lane = await f.acceptedLane(await f.service().threadExportManifest(f.thread.id));
    f.graph.threads.retireThread(f.thread.id, request, lane);
    const retired = f.graph.threads.getThread(f.thread.id)!;
    expect(retired).toMatchObject({
      state: "purged",
      retirement: { operationId: "op-maintenance" },
    });
    expect(f.graph.obligations.get("purge_fs", f.thread.id)).toMatchObject({ state: "pending" });
    return { f, files, retired };
  }

  /**
   * The daemon's retention pass over the fixture's SQL owners and the one purge owner,
   * wired as `controlServices` wires them. With `stopWhileVerifying`, Stop (the runner's
   * own `cancel`, which `claudexord` awaits at Stop) arrives once, when the pass first asks
   * for a lane entry's credential stores: after the lane tree is read, before a byte is hashed.
   */
  function retention(f: Fixture, options: { stopWhileVerifying: boolean }) {
    const { graph, store } = f.current();
    let stopping: Promise<void> | undefined;
    const stores = (lane: string) => {
      if (options.stopWhileVerifying) stopping ??= run.cancel!();
      return laneCredentialStores(lane);
    };
    const owner = threadPurgeOwner(graph.threads, noProjectRepoRoot(), graph.purgeFiles, stores);
    const run = createRetentionRunner({
      projects: () => graph.projects,
      threads: graph.threads,
      daemonJobs: () => sqlActivityRecords(store),
      purgeThread: owner.purgeThread,
      hasPurgeLeftovers: owner.hasPurgeLeftovers,
    });
    // An admitted pass drains before the fixture closes its store.
    cleanup.push(() => run.cancel!());
    return { run, stopping: () => stopping };
  }
  const statusOf = (f: Fixture) => () => f.service().threadRetirement(f.thread.id, null).status;

  it("finishes the pending cleanup when nothing stops it", async () => {
    const { f, files } = await acceptedNotCleaned();
    const { run, stopping } = retention(f, { stopWhileVerifying: false });
    const receipt = await run({ dry_run: false, trash_purge_report: true });
    expect(stopping()).toBeUndefined();
    expect(receipt.errors).toEqual([]);
    expect(receipt.purge_leftovers).toEqual([f.thread.id]);
    for (const file of files) expect(existsSync(file)).toBe(false);
    expect(existsSync(f.lanes)).toBe(false);
    await f.store.flushed();
    await expect.poll(statusOf(f), { timeout: 20_000 }).toBe("removed");
  });

  it("a Stop while the retry verifies the lane deletes nothing, keeps the acceptance, and the next pass finishes it", async () => {
    const { f, files, retired } = await acceptedNotCleaned();
    const before = files.map((file) => readFileSync(file, "utf8"));
    const { run, stopping } = retention(f, { stopWhileVerifying: true });
    const receipt = await run({ dry_run: false, trash_purge_report: true });
    await stopping();
    // The pass was verifying the lane when Stop arrived, and the pass ended as cancelled.
    expect(stopping()).toBeDefined();
    expect(receipt.truncated).toBe(true);
    // Stop ended the attempt: no byte went, the cleanup is not reported finished, and
    // the receipt names the thread whose cleanup it interrupted.
    expect(receipt.purge_leftovers).toEqual([]);
    expect(receipt.errors.join("\n")).toContain(f.thread.id);
    expect(files.map((file) => existsSync(file))).toEqual(files.map(() => true));
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
    // The acceptance and its obligation are exactly as they were.
    expect(f.graph.threads.getThread(f.thread.id)).toEqual(retired);
    expect(f.graph.obligations.get("purge_fs", f.thread.id)).toMatchObject({ state: "pending" });
    expect(f.service().threadRetirement(f.thread.id, "op-maintenance")).toMatchObject({
      status: "accepted_pending_removal",
      acceptance: { operationId: "op-maintenance" },
    });
    // The next pass has its own signal, and finishes the same cleanup.
    const resumed = await run({ dry_run: false, trash_purge_report: true });
    expect(resumed.errors).toEqual([]);
    expect(resumed.purge_leftovers).toEqual([f.thread.id]);
    for (const file of files) expect(existsSync(file)).toBe(false);
    expect(existsSync(f.lanes)).toBe(false);
    await f.store.flushed();
    await expect.poll(statusOf(f), { timeout: 20_000 }).toBe("removed");
  });

  it("a Stop while a restart replays the cleanup deletes nothing, keeps the acceptance, and the next start finishes it", async () => {
    const { f, files, retired } = await acceptedNotCleaned();
    const before = files.map((file) => readFileSync(file, "utf8"));
    const stop = new AbortController();
    // Stop reaches the daemon as the replay first asks for a lane entry's credential
    // stores: after the lane tree is read, before a byte is hashed.
    let asked = 0;
    const stores = (lane: string) => {
      asked += 1;
      stop.abort();
      return laneCredentialStores(lane);
    };
    // The registration `claudexord` makes, over the Stop it aborts.
    const { graph: restarted } = await f.reopen(
      startupPurgeEffect(noProjectRepoRoot(), stores, stop.signal),
    );
    const replay = await restarted.recoverAfterStartup();
    expect(asked).toBeGreaterThan(0);
    // Stop ended the attempt: no byte went, and the obligation is open with its reason.
    expect(replay.completed).toEqual([]);
    expect(replay.failed).toEqual([
      { kind: "purge_fs", key: f.thread.id, error: expect.stringMatching(/abort/i) },
    ]);
    expect(files.map((file) => existsSync(file))).toEqual(files.map(() => true));
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
    // The acceptance and its obligation are exactly as they were.
    expect(restarted.threads.getThread(f.thread.id)).toEqual(retired);
    expect(restarted.obligations.get("purge_fs", f.thread.id)).toMatchObject({ state: "pending" });
    expect(f.service().threadRetirement(f.thread.id, "op-maintenance")).toMatchObject({
      status: "accepted_pending_removal",
      acceptance: { operationId: "op-maintenance" },
    });
    // The next start has no Stop, and finishes the same cleanup.
    const { graph: next } = await f.reopen(
      startupPurgeEffect(noProjectRepoRoot(), laneCredentialStores, new AbortController().signal),
    );
    const resumed = await next.recoverAfterStartup();
    expect(resumed.failed).toEqual([]);
    expect(resumed.completed).toEqual([{ kind: "purge_fs", key: f.thread.id }]);
    for (const file of files) expect(existsSync(file)).toBe(false);
    expect(existsSync(f.lanes)).toBe(false);
    await f.current().store.flushed();
    await expect.poll(statusOf(f), { timeout: 20_000 }).toBe("removed");
  });
});

describe("one outcome per operation, also at the store", () => {
  const request = (closureDigest: string, operationId: string) => ({
    operationId,
    exportId: `sha256:${"e".repeat(64)}`,
    closureDigest,
    contentDigest: `sha256:${"c".repeat(64)}`,
    laneDigest: `sha256:${"f".repeat(64)}`,
  });

  it("never accepts an operation already abandoned or refused", async () => {
    const f = await fixture();
    f.turnWithRun("job-1");
    const { digest } = (await f.graph.threads.threadClosure(f.thread.id))!;
    f.graph.threads.settleRetirement(f.thread.id, "op-fenced", null);
    expect(() =>
      f.graph.threads.retireThread(f.thread.id, request(digest, "op-fenced"), []),
    ).toThrowError(
      expect.objectContaining({
        code: "thread_retirement_abandoned",
        context: { settled: true },
      }) as never,
    );
    expect(() =>
      f.graph.threads.retireThread(
        f.thread.id,
        request(`sha256:${"0".repeat(64)}`, "op-stale"),
        [],
      ),
    ).toThrowError(expect.objectContaining({ code: "thread_export_stale" }) as never);
    expect(() =>
      f.graph.threads.retireThread(f.thread.id, request(digest, "op-stale"), []),
    ).toThrowError(
      expect.objectContaining({ code: "thread_export_stale", context: { settled: true } }) as never,
    );
    expect(f.graph.threads.getThread(f.thread.id)!.state).toBe("active");
    expect(f.graph.obligations.get("purge_fs", f.thread.id)).toBeFalsy();
    expect(f.graph.threads.retirementOperation(f.thread.id, "op-fenced")).toMatchObject({
      outcome: "abandoned",
    });
    expect(f.graph.threads.retirementOperation(f.thread.id, "op-stale")).toMatchObject({
      outcome: "refused",
    });
    // A fresh operation still accepts.
    expect(f.graph.threads.retireThread(f.thread.id, request(digest, "op-fresh"), []).state).toBe(
      "purged",
    );
  });
});

describe("what reappears after a retirement's cleanup cleared", () => {
  async function removed() {
    const f = await fixture();
    f.turnWithRun("job-1");
    write(join(f.lanes, "codex-default", "home", "state.txt"), "lane bytes\n");
    const receipt = await f.service().retireThread(f.thread.id, await retireRequest(f, "op-r"));
    expect(receipt.operation).toMatchObject({ outcome: "accepted" });
    expect(existsSync(f.lanes)).toBe(false);
    await f.store.flushed();
    await expect
      .poll(() => f.service().threadRetirement(f.thread.id, null).status, { timeout: 20_000 })
      .toBe("removed");
    return f;
  }

  it("is held with its reason: no byte of it was exported, so none is deleted", async () => {
    const f = await removed();
    const late = write(join(f.lanes, "codex-default", "home", "late.txt"), "never exported\n");
    // The retention pass finishes purges with leftovers through the one owner.
    await expect(f.owner().purgeThread(f.thread.id)).rejects.toMatchObject({
      code: "thread_lane_changed",
    });
    expect(readFileSync(late, "utf8")).toBe("never exported\n");
    expect(f.service().threadRetirement(f.thread.id, null)).toMatchObject({
      status: "accepted_pending_removal",
      cleanup: {
        reason: expect.stringContaining("codex-default/home/late.txt arrived after acceptance"),
      },
    });
    const references = await f.graph.threads.retentionReferences(new Set());
    try {
      expect([...references.laneThreadIds!(noProjectRepoRoot())]).toContain(f.thread.id);
    } finally {
      references.close?.();
    }
    // Once nothing but directories remain, the same held cleanup finishes.
    rmSync(late);
    await f.owner().purgeThread(f.thread.id);
    expect(existsSync(f.lanes)).toBe(false);
  });

  it("an ordinary purge still deletes leftovers that reappear after it cleared", async () => {
    const f = await fixture();
    f.turnWithRun("job-1");
    f.graph.threads.trashThread(f.thread.id);
    await f.owner().purgeThread(f.thread.id);
    await f.store.flushed();
    await expect
      .poll(() => f.graph.obligations.get("purge_fs", f.thread.id) ?? null, { timeout: 20_000 })
      .toBeNull();
    write(join(f.lanes, "codex-default", "home", "late.txt"), "left over\n");
    await f.owner().purgeThread(f.thread.id);
    expect(existsSync(f.lanes)).toBe(false);
  });
});

describe("a retirement read is addressed", () => {
  /** SQL statements one read executes, counted at the store's own prepare. */
  function executions(f: Fixture, read: () => unknown): { count: number; value: unknown } {
    const store = f.current().store;
    const prepare = store.prepare.bind(store);
    let count = 0;
    const counted = (statement: ReturnType<typeof prepare>) =>
      new Proxy(statement, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target) as unknown;
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (prop === "get" || prop === "all" || prop === "run" || prop === "iterate")
              count += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    store.prepare = ((sql: string) => counted(prepare(sql))) as typeof store.prepare;
    try {
      return { value: read(), count };
    } finally {
      store.prepare = prepare as typeof store.prepare;
    }
  }

  it("costs the same over a growing closure, before and after acceptance", async () => {
    const f = await fixture();
    f.turnWithRun("job-0");
    const small = executions(f, () => f.service().threadRetirement(f.thread.id, "op-x"));
    expect(small.value).toMatchObject({ status: "not_accepted", operation: null });
    for (let index = 1; index <= 40; index += 1) f.turnWithRun(`job-${index}`);
    const grown = executions(f, () => f.service().threadRetirement(f.thread.id, "op-x"));
    expect(grown.value).toEqual(small.value);
    expect(grown.count).toBe(small.count);

    const receipt = await f.service().retireThread(f.thread.id, await retireRequest(f, "op-x"));
    expect(receipt.operation).toMatchObject({ outcome: "accepted" });
    const after = executions(f, () => f.service().threadRetirement(f.thread.id, "op-x"));
    expect(after.value).toMatchObject({
      threadState: "purged",
      operation: { outcome: "accepted" },
      acceptance: { operationId: "op-x" },
    });
    expect(after.count).toBeLessThanOrEqual(small.count + 2);
  });
});

describe("names a bundle's volume cannot hold, through the real routes and consumer", () => {
  const sha = (bytes: string | Buffer) =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  /** One finished turn carrying these display names as attachments. */
  function attachedTurn(f: Fixture, names: readonly string[]) {
    const attachments = names.map((name, index) => {
      const bytes = `attachment ${index} bytes`;
      return {
        resource_id: `res-${index}`,
        kind: "file",
        mime: "text/plain",
        name,
        sha256: sha(bytes),
        size_bytes: Buffer.byteLength(bytes),
        path: write(join(f.root, "blobs", `${index}`), bytes),
      } as const;
    });
    const turn = f.graph.threads.createTurn(f.thread.id, "with files", { attachments });
    const run = f.command({ id: "job-1", params: { threadId: f.thread.id, turnId: turn.id } });
    f.graph.threads.bindTurnRun(turn.id, run.runId);
    return { ...run, attachments };
  }
  const heldAt = (out: string, entry: { path: string; placedAt?: string }) =>
    join(out, entry.placedAt ?? entry.path);

  it("exports, retires and reads long Cyrillic, CJK and ASCII names of every plane", async () => {
    const f = await fixture();
    const names = [
      "Презентация для инвесторов финал версия.pdf",
      `${"Презентация для инвесторов ".repeat(12)}финал.pdf`,
      `${"投資家向けプレゼンテーション資料".repeat(12)}.pdf`,
      `${"b".repeat(226)}.pdf`,
      `${"a".repeat(300)}.pdf`,
    ];
    const { runDir, attachments } = attachedTurn(f, names);
    write(join(runDir, "final", `${"r".repeat(251)}.txt`), "a run file at the limit\n");
    write(join(f.lanes, "summaries", `${"l".repeat(251)}.md`), "a lane file at the limit\n");
    // Decoded text gains a suffix this volume's limit has no room for.
    const decoded = "decoded lane text\n";
    write(
      join(f.lanes, "summaries", `${"z".repeat(245)}.jsonl.zst`),
      zstdCompressSync(Buffer.from(decoded)),
    );
    const api = await served(f);
    const out = join(f.root, "bundle");
    const { manifest, receipt } = await exportThreadBundle(api.address, f.thread.id, out);
    expect(manifest.gaps).toEqual([]);

    // Every transferred byte is where the receipt says, and verifies there.
    for (const entry of receipt.transferred)
      expect(sha(readFileSync(heldAt(out, entry))), entry.path).toBe(entry.sha256);
    // The complete names stay as metadata, in the manifest and the engine's own record.
    const resources = manifest.items.filter((item) => item.plane === "resource");
    expect(
      resources.map((item) => decodeURIComponent(item.path.split("/").at(-1)!)).sort(),
    ).toEqual([...names].sort());
    const turnRecord = JSON.parse(
      readFileSync(
        heldAt(
          out,
          receipt.transferred.find((entry) => entry.path.startsWith("sql/turns/"))!,
        ),
        "utf8",
      ),
    );
    expect(turnRecord.attachments.map((a: { name: string }) => a.name)).toEqual(names);
    // Only what the volume could not name moved, and it moved inside the bundle.
    const placed = receipt.transferred.filter((entry) => entry.placedAt);
    expect(placed.map((entry) => entry.placedAt!.split("/")[0])).toEqual(
      placed.map(() => "relocated"),
    );
    const placedOf = (name: string) =>
      receipt.transferred.find((entry) => entry.path.endsWith(encodeURIComponent(name)))?.placedAt;
    expect(placedOf(names[0]!)).toBeUndefined();
    expect(placedOf(names[3]!)).toBeUndefined();
    for (const long of [names[1]!, names[2]!, names[4]!]) expect(placedOf(long)).toBeTruthy();
    const projection = manifest.items.find((item) => item.plane === "projection")!;
    const projected = receipt.transferred.find((entry) => entry.itemId === projection.itemId)!;
    expect(projected.placedAt).toBe(`relocated/${projection.itemId}.jsonl`);
    expect(readFileSync(heldAt(out, projected), "utf8")).toBe(decoded);
    expect(readdirSync(out).filter((name) => name.includes(".partial-"))).toEqual([]);

    // The real retirement verifies each byte where it is, and the engine accepts.
    const retired = await retireThreadBundle(async () => api.address, f.thread.id, out);
    expect(retired.operation).toMatchObject({ outcome: "accepted" });
    expect(existsSync(f.lanes)).toBe(false);
    for (const attachment of attachments) rmSync(attachment.path);
    for (const entry of receipt.transferred)
      expect(sha(readFileSync(heldAt(out, entry))), entry.path).toBe(entry.sha256);
  });

  it("keeps refusing two items that need one name with other bytes, and reusing the same", async () => {
    const collide = async (real: string) => {
      const f = await fixture();
      f.turnWithRun("job-1");
      const decoded = "decoded lane text\n";
      const name = join(f.lanes, "summaries", "x.jsonl.zst");
      write(name, zstdCompressSync(Buffer.from(decoded)));
      write(`${name}.decoded.jsonl`, real === "same" ? decoded : "other bytes\n");
      const api = await served(f);
      return { f, api, out: join(f.root, "bundle") };
    };
    const refused = await collide("other");
    await expect(
      exportThreadBundle(refused.api.address, refused.f.thread.id, refused.out),
    ).rejects.toMatchObject({ code: "thread_export_path_collision" });
    expect(existsSync(join(refused.out, "receipt.json"))).toBe(false);
    const same = await collide("same");
    const { receipt } = await exportThreadBundle(same.api.address, same.f.thread.id, same.out);
    expect(
      receipt.transferred.filter((entry) => entry.path.endsWith(".decoded.jsonl")),
    ).toHaveLength(2);
    expect(
      (await retireThreadBundle(async () => same.api.address, same.f.thread.id, same.out))
        .operation,
    ).toMatchObject({ outcome: "accepted" });
  });
});

describe("a retirement's outcome after its project was removed", () => {
  /** Everything an operation or a thread could write: a read must add none of it. */
  const written = (f: Fixture) =>
    f.store
      .prepare(
        "SELECT (SELECT count(*) FROM idempotency WHERE owner='thread_retire') AS bindings," +
          "(SELECT count(*) FROM thread WHERE state<>'purged') AS live," +
          "(SELECT count(*) FROM effect_obligation WHERE kind='purge_fs') AS cleanups",
      )
      .get() as { bindings: number; live: number; cleanups: number };

  /** Accepted by the engine, with its answer lost: the caller only kept its request. */
  async function acceptedThenRemoved() {
    const f = await fixture({ project: true });
    f.turnWithRun("job-1");
    write(join(f.lanes, "codex-default", "home", "state.txt"), "lane bytes\n");
    const api = await served(f);
    const out = join(f.root, "bundle");
    const { receipt } = await exportThreadBundle(api.address, f.thread.id, out);
    const request = {
      operationId: "op-lost",
      exportId: receipt.exportId,
      closureDigest: receipt.closureDigest,
      contentDigest: receipt.contentDigest,
      laneDigest: receipt.laneDigest,
    };
    const answered = await api.call("POST", `/threads/${f.thread.id}/retire`, request);
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const kept = join(out, "retire-request.json");
    writeFileSync(kept, `${JSON.stringify(request)}\n`);
    await f.store.flushed();
    await expect
      .poll(() => f.service().threadRetirement(f.thread.id, null).status, { timeout: 20_000 })
      .toBe("removed");
    const project = f.graph.threads.projects.findByRoot(f.projectRoot!)!;
    f.graph.threads.removeProject(project.id, new Set());
    // Its partition is no longer served: the thread is outside every ordinary read.
    expect(f.graph.threads.getThread(f.thread.id)).toBeUndefined();
    return { f, api, out, kept, request, storeId: receipt.storeId };
  }

  it("reads and replays the accepted operation, and the kept request settles", async () => {
    const { f, api, out, kept, request, storeId } = await acceptedThenRemoved();
    const before = written(f);
    const read = await api.call(
      "GET",
      `/threads/${f.thread.id}/retirement?operationId=op-lost&expectedStoreId=${storeId}`,
    );
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({
      threadState: "purged",
      status: "removed",
      acceptance: { operationId: "op-lost" },
      operation: { operationId: "op-lost", outcome: "accepted" },
    });
    // The same read is scoped to its store.
    expect(
      (
        await api.call(
          "GET",
          `/threads/${f.thread.id}/retirement?operationId=op-lost&expectedStoreId=00000000-0000-4000-8000-000000000000`,
        )
      ).body,
    ).toMatchObject({ code: "store_mismatch" });

    const replay = await api.call("POST", `/threads/${f.thread.id}/retire`, request);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.acceptance).toEqual(read.body.acceptance);

    // The real consumer repeats its kept operation and releases it.
    const settled = await retireThreadBundle(async () => api.address, f.thread.id, out);
    expect(settled.operation).toMatchObject({ operationId: "op-lost", outcome: "accepted" });
    expect(existsSync(kept)).toBe(false);
    expect(written(f)).toEqual(before);
    expect(f.graph.threads.getThread(f.thread.id)).toBeUndefined();
  });

  it("reads absence as absence, and binds no new operation there", async () => {
    const { f, api, request } = await acceptedThenRemoved();
    const before = written(f);
    const absent = await api.call("GET", `/threads/${f.thread.id}/retirement?operationId=op-never`);
    expect(absent.status).toBe(200);
    expect(absent.body).toMatchObject({ threadState: "purged", operation: null });
    // A new mutation still needs a served partition: nothing is settled or accepted.
    const abandon = await api.call("POST", `/threads/${f.thread.id}/retire/abandon`, {
      operationId: "op-never",
    });
    expect(abandon.status, JSON.stringify(abandon.body)).toBe(404);
    const another = await api.call("POST", `/threads/${f.thread.id}/retire`, {
      ...request,
      operationId: "op-never",
    });
    expect(another.status, JSON.stringify(another.body)).toBe(404);
    expect(written(f)).toEqual(before);
    expect(
      (await api.call("GET", `/threads/${f.thread.id}/retirement?operationId=op-never`)).body
        .operation,
    ).toBeNull();
    // An id no thread row has stays not found.
    expect((await api.call("GET", "/threads/th-none/retirement?operationId=op-lost")).status).toBe(
      404,
    );
  });
});
