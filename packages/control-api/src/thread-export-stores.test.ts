/**
 * A store the export cannot read may hold a copy of a session, so it is a named
 * gap even when another store holds a complete copy; a store that does not exist
 * holds nothing. Failures are injected at the filesystem boundary, so this does
 * not depend on permissions the test user may bypass.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONTROL_PROTOCOL_MAJOR } from "@claudexor/schema";
import { DaemonControlApiServer } from "./daemon-server.js";
import { createThreadExport, type ThreadExportDeps } from "./thread-export.js";
import { currentDigests } from "./thread-export-digests.js";
import { buildInventory } from "./thread-export-inventory.js";
import { runSessionObservations, transcriptFacts } from "./thread-export-sessions.js";
import { walkTree } from "./thread-export-walk.js";
import { storeSessionMaterial } from "./thread-export-native.js";
import { afterEachClosed } from "../../cli/src/test-support/after-each-closed.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    realpath: vi.fn(fs.realpath),
    lstat: vi.fn(fs.lstat),
    open: vi.fn(fs.open),
    readdir: vi.fn(fs.readdir),
  };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

const THREAD = "th-stores";
const SESSION = "s-1";
const roots: string[] = [];
const stops: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  vi.mocked(fsp.realpath).mockImplementation(actual.realpath as never);
  vi.mocked(fsp.lstat).mockImplementation(actual.lstat as never);
  vi.mocked(fsp.open).mockImplementation(actual.open as never);
  vi.mocked(fsp.readdir).mockImplementation(actual.readdir as never);
});
afterEachClosed(async () => {
  // This test's roots, taken before its stops: a late stop never reaches the next test's.
  const ownedRoots = roots.splice(0);
  for (const stop of stops.splice(0)) await stop();
  return () => ownedRoots.forEach((root) => rmSync(root, { recursive: true, force: true }));
});

/** One read of the journal and transcript readers. */
const CHUNK = 256 * 1024;
/** About `bytes` of whole JSON rows, each far under the line bound. */
const rows = (bytes: number, row: Record<string, unknown>) => {
  const line = `${JSON.stringify({ ...row, text: "x".repeat(1000) })}\n`;
  return line.repeat(Math.ceil(bytes / line.length));
};

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const failure = (code: string, path: string) =>
  Object.assign(new Error(`${code}: injected, ${path}`), { code });

/**
 * Optional padding makes the run journal and the transcript span many reads: the
 * session's start is the journal's last line, and only the transcript's last row
 * may name another version, so each is found only by reading to the end.
 */
function fixture(
  options: {
    journalBytes?: number;
    transcriptBytes?: number;
    lastVersion?: string;
    platforms?: readonly string[];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "cx-export-stores-"));
  roots.push(root);
  const runDir = join(root, "run");
  const journal = join(runDir, "events.jsonl");
  write(
    journal,
    rows(options.journalBytes ?? 0, { type: "message" }) +
      `${JSON.stringify({
        type: "harness.event",
        payload: {
          harness_id: "h",
          attempt_id: "a",
          type: "started",
          payload: { native_session_id: SESSION },
        },
      })}\n`,
  );
  const storeA = join(root, "store-a");
  const storeB = join(root, "store-b");
  const transcript = join(storeA, "sessions", `${SESSION}.jsonl`);
  write(
    transcript,
    rows(options.transcriptBytes ?? 0, { type: "user", version: "1" }) +
      `${JSON.stringify({ type: "user", version: options.lastVersion ?? "1" })}\n`,
  );
  const retire = vi.fn();
  const settle = vi.fn<ThreadExportDeps["settle"]>((_id, operationId, refusal) => ({
    operationId,
    outcome: refusal ? "refused" : "abandoned",
    code: refusal?.code ?? null,
    message: refusal?.message ?? null,
    settledAt: "2026-11-02T00:00:00.000Z",
  }));
  const thread = {
    id: THREAD,
    state: "active" as const,
    repo: null,
    workspace: { mode: "delegated" as const, worktree_path: null },
  };
  const deps: ThreadExportDeps = {
    thread: () => ({ storeId: "store-1", thread }),
    closure: () => ({
      storeId: "store-1",
      thread,
      headRevision: 1,
      digest: `sha256:${"a".repeat(64)}`,
      turns: [],
      commands: [
        {
          jobId: "job-1",
          runId: "run-1",
          state: "succeeded",
          kind: "product",
          threadId: THREAD,
          turnId: null,
          continueFrom: null,
          delegatedFrom: null,
          runDir,
        },
      ],
      documents: [],
      holds: [],
    }),
    document: () => null,
    nativeLayout: (harness) =>
      harness === "h"
        ? {
            stores: [
              { storeKey: "a", profileId: null, root: storeA },
              { storeKey: "b", profileId: "pb", root: storeB },
            ],
            unresolved: [],
            sessionLocations: { sessions: 1 },
            evidence: {
              vendorVersions: ["1"],
              platforms: options.platforms ?? [process.platform],
              transcriptOf: (rel: string, id: string) =>
                rel === `sessions/${id}.jsonl` ? rel : null,
              versionField: "version",
            },
            outOfClosure: [],
          }
        : null,
    laneCredentialStores: () => [],
    laneDirectory: () => join(root, "lane"),
    isolatedWorktreeExists: () => false,
    resolveAttachments: () => [],
    retire,
    operation: () => null,
    settle,
    finishPurge: async () => undefined,
    cleanup: () => null,
    hasPurgeLeftovers: () => false,
  };
  return {
    runDir,
    journal,
    storeA,
    storeB,
    transcript,
    deps,
    retire,
    settle,
    service: createThreadExport(deps),
  };
}

describe("the platform a recording was made on", () => {
  it("qualifies a copy only there; elsewhere its bytes export and it cannot retire", async () => {
    const elsewhere = fixture({ platforms: ["recorded-elsewhere"] });
    const held = await buildInventory(elsewhere.deps, THREAD);
    expect(held.manifest.gaps).toEqual([
      expect.objectContaining({
        code: "native_format_unqualified",
        subject: SESSION,
        message: `h: no recording exercised a session on ${process.platform}`,
      }),
    ]);
    expect(held.manifest.retirable).toBe(false);
    expect(held.manifest.sessions[0]).toMatchObject({ status: "unqualified" });
    expect(held.manifest.items.map((item) => item.path)).toContain(
      `native/h/a/sessions/${SESSION}.jsonl`,
    );
    const here = await buildInventory(fixture().deps, THREAD);
    expect(here.manifest.gaps).toEqual([]);
    expect(here.manifest.sessions[0]).toMatchObject({ status: "exported" });
  });
});

describe("a second store beside a complete readable copy", () => {
  it("that does not exist holds nothing and blocks nothing", async () => {
    const f = fixture();
    const manifest = await f.service.threadExportManifest(THREAD);
    expect(manifest.gaps).toEqual([]);
    expect(manifest.retirable).toBe(true);
  });

  it("names a transcript it cannot open instead of failing the whole export", async () => {
    const f = fixture();
    const transcript = join(f.storeA, "sessions", `${SESSION}.jsonl`);
    vi.mocked(fsp.open).mockImplementation((async (path: string, ...rest: unknown[]) => {
      if (String(path) === transcript) throw failure("EACCES", String(path));
      return (actual.open as (...args: unknown[]) => unknown)(path, ...rest);
    }) as never);
    const manifest = await f.service.threadExportManifest(THREAD);
    expect(manifest.retirable).toBe(false);
    expect(manifest.sessions[0]).toMatchObject({ status: "unreadable" });
    expect(manifest.gaps).toEqual([
      expect.objectContaining({
        code: "native_session_unreadable",
        subject: `a/sessions/${SESSION}.jsonl`,
      }),
    ]);
  });

  it.each([
    ["its root cannot be resolved", "realpath", "EACCES"],
    ["its root cannot be read", "lstat", "EIO"],
  ] as const)("is a named gap when %s", async (_name, call, code) => {
    const f = fixture();
    mkdirSync(f.storeB, { recursive: true });
    const real = await actual.realpath(f.storeB);
    if (call === "realpath")
      vi.mocked(fsp.realpath).mockImplementation((async (path: string) => {
        if (String(path) === f.storeB) throw failure(code, String(path));
        return actual.realpath(path);
      }) as never);
    else
      vi.mocked(fsp.lstat).mockImplementation((async (path: string) => {
        if (String(path) === real) throw failure(code, String(path));
        return actual.lstat(path);
      }) as never);
    const manifest = await f.service.threadExportManifest(THREAD);
    expect(manifest.retirable).toBe(false);
    expect(manifest.gaps).toEqual([
      expect.objectContaining({ code: "native_session_unreadable", subject: "b" }),
    ]);
  });
});

describe("directory boundaries of session export", () => {
  it.each(["tree", "native"] as const)("checks Stop inside a flat directory (%s)", async (kind) => {
    const f = fixture();
    const dir = join(f.storeA, "flat");
    const ids = Array.from({ length: 8 }, (_, i) => `session-${i}`);
    for (const id of ids) write(join(dir, `${id}.jsonl`), "{}\n");
    const control = async (signal?: AbortSignal) =>
      kind === "tree"
        ? walkTree(dir, "", signal)
        : storeSessionMaterial(
            { root: f.storeA, storeKey: "a", profileId: null },
            { flat: 1 },
            ids,
            signal,
          );
    const completed = await control();
    expect(
      "entries" in completed
        ? completed.entries.length
        : [...completed.owned.values()].flat().length,
    ).toBe(8);
    const controller = new AbortController();
    const reason = new Error("Stop at the first file");
    const seen: string[] = [];
    vi.mocked(fsp.lstat).mockImplementation((async (path: string) => {
      const answer = await actual.lstat(path);
      if (dirname(String(path)) === dir) {
        seen.push(String(path));
        if (seen.length === 1) controller.abort(reason);
      }
      return answer;
    }) as never);
    const answer = await control(controller.signal).catch((error: unknown) => error);
    expect({ stopped: answer === reason, visited: seen.length }).toEqual({
      stopped: true,
      visited: 1,
    });
  });

  it("does not follow a symlink at a declared session location", async () => {
    const f = fixture();
    const location = join(f.storeA, "sessions");
    const elsewhere = join(f.storeA, "elsewhere");
    renameSync(location, elsewhere);
    symlinkSync(elsewhere, location, "junction");
    const manifest = await f.service.threadExportManifest(THREAD);
    expect(manifest.retirable).toBe(false);
    expect(manifest.gaps).toContainEqual(
      expect.objectContaining({ code: "native_session_unreadable", subject: "a/sessions" }),
    );
    expect(vi.mocked(fsp.readdir).mock.calls.some(([path]) => String(path) === location)).toBe(
      false,
    );
    expect(manifest.items.some((item) => item.path.startsWith("native/h/a/"))).toBe(false);
  });

  it("still canonicalizes the explicitly selected whole store root", async () => {
    const f = fixture();
    const target = `${f.storeA}-canonical`;
    renameSync(f.storeA, target);
    symlinkSync(target, f.storeA, "junction");
    const manifest = await f.service.threadExportManifest(THREAD);
    expect(manifest.gaps).toEqual([]);
    expect(manifest.retirable).toBe(true);
  });

  it("lets Stop run through a flat list of unmatched names", async () => {
    const f = fixture();
    const dir = join(f.storeA, "unmatched");
    for (let i = 0; i < 512; i += 1) write(join(dir, `other-${i}.jsonl`), "{}\n");
    const controller = new AbortController();
    const reason = new Error("Stop after enumeration");
    let delivered!: () => void;
    const stopDelivered = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    vi.mocked(fsp.readdir).mockImplementation((async (
      ...args: Parameters<typeof actual.readdir>
    ) => {
      const entries = await actual.readdir(...args);
      if (String(args[0]) === dir)
        setImmediate(() => {
          controller.abort(reason);
          delivered();
        });
      return entries;
    }) as never);
    const answer = await storeSessionMaterial(
      { root: f.storeA, storeKey: "a", profileId: null },
      { unmatched: 1 },
      [SESSION],
      controller.signal,
    ).catch((error: unknown) => error);
    await stopDelivered;
    expect(answer).toBe(reason);
  });
});

describe("a journal and a transcript of many reads", () => {
  it("are read to their last row", async () => {
    const whole = fixture({ journalBytes: 3 << 20, transcriptBytes: 3 << 20 });
    const manifest = await whole.service.threadExportManifest(THREAD);
    expect(manifest.gaps).toEqual([]);
    expect(manifest.retirable).toBe(true);
    expect(manifest.sessions).toEqual([
      expect.objectContaining({ nativeSessionId: SESSION, status: "exported" }),
    ]);
    const last = fixture({ journalBytes: 3 << 20, transcriptBytes: 3 << 20, lastVersion: "2" });
    const unqualified = await last.service.threadExportManifest(THREAD);
    expect(unqualified.retirable).toBe(false);
    expect(unqualified.gaps).toEqual([
      expect.objectContaining({
        code: "native_format_unqualified",
        subject: SESSION,
        message: expect.stringContaining("vendor version 2"),
      }),
    ]);
  });
});

/**
 * Every read of one file through the real filesystem, observed where this file
 * already injects: on the first read that returns bytes, `stop` is asked; what
 * the reader still takes from that file afterwards is counted.
 */
function stopAtFirstRead(path: string, stop: () => void) {
  const watch = { stopAsked: false, bytesAfterStop: 0 };
  const open = actual.open as (...args: unknown[]) => Promise<fsp.FileHandle>;
  vi.mocked(fsp.open).mockImplementation((async (file: string, ...rest: unknown[]) => {
    const handle = await open(file, ...rest);
    if (String(file) !== path) return handle;
    const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<{ bytesRead: number }>;
    handle.read = (async (...args: unknown[]) => {
      const result = await read(...args);
      if (watch.stopAsked) watch.bytesAfterStop += result.bytesRead;
      else if (result.bytesRead > 0) {
        watch.stopAsked = true;
        stop();
      }
      return result;
    }) as never;
    return handle;
  }) as never);
  return watch;
}

describe("Stop inside one journal or transcript read", () => {
  it.each([
    ["a run journal", "journal"],
    ["a session transcript", "transcript"],
  ] as const)(
    "ends %s at its next read, as cancellation rather than an unreadable record",
    async (_name, target) => {
      const f = fixture({ journalBytes: 8 << 20, transcriptBytes: 8 << 20 });
      const { entries } = await walkTree(f.runDir);
      const controller = new AbortController();
      const reason = new Error("Stop");
      const watch = stopAtFirstRead(f[target], () => controller.abort(reason));
      const reading =
        target === "journal"
          ? runSessionObservations("run-1", entries, controller.signal)
          : transcriptFacts(
              f.transcript,
              "version",
              [f.storeA],
              process.platform,
              controller.signal,
            );
      await expect(reading).rejects.toBe(reason);
      expect(watch.stopAsked).toBe(true);
      // At most the one read the stream had already asked for, never the rest.
      expect(watch.bytesAfterStop).toBeLessThanOrEqual(CHUNK);
    },
  );

  it("never becomes a gap that would refuse, and so spend, a retirement", async () => {
    const f = fixture({ transcriptBytes: 8 << 20 });
    const request = await currentRequest(f, "op-stop");
    const controller = new AbortController();
    const reason = new Error("Stop");
    const watch = stopAtFirstRead(f.transcript, () => controller.abort(reason));
    await expect(f.service.retireThread(THREAD, request, controller.signal)).rejects.toBe(reason);
    expect(watch.stopAsked).toBe(true);
    expect(watch.bytesAfterStop).toBeLessThanOrEqual(CHUNK);
    expect(f.settle).not.toHaveBeenCalled();
    expect(f.retire).not.toHaveBeenCalled();
  });
});

/** The retirement that, without Stop, is accepted: it names the current export. */
async function currentRequest(f: ReturnType<typeof fixture>, operationId: string) {
  const inventory = await buildInventory(f.deps, THREAD);
  const digests = await currentDigests(f.deps, inventory);
  return {
    operationId,
    exportId: inventory.manifest.exportId,
    closureDigest: inventory.manifest.closureDigest,
    contentDigest: digests.content,
    laneDigest: digests.lane,
  };
}

/** The real control API server over this fixture's export service. */
async function served(f: ReturnType<typeof fixture>) {
  const server = new DaemonControlApiServer({
    token: "stores-token",
    daemon: {} as never,
    services: { threadExport: f.service },
  });
  const stop = () => server.stop();
  stops.push(stop);
  const { host, port } = await server.start();
  const call = (path: string, init: { method?: string; body?: string } = {}) =>
    fetch(`http://${host}:${port}/v2/threads/${THREAD}${path}`, {
      ...init,
      headers: {
        authorization: "Bearer stores-token",
        "content-type": "application/json",
        "x-claudexor-protocol-major": String(CONTROL_PROTOCOL_MAJOR),
      },
    }).then(
      async (response) => ({ status: response.status, body: await response.text() }),
      (error: unknown) => ({ status: 0, body: String(error) }),
    );
  return { call, stop };
}

describe("the server's Stop inside one journal or transcript read", () => {
  it("ends a manifest read inside a run journal", async () => {
    const f = fixture({ journalBytes: 8 << 20 });
    const api = await served(f);
    let stopped: Promise<void> | undefined;
    const watch = stopAtFirstRead(f.journal, () => (stopped = api.stop()));
    const answer = await api.call("/export");
    await stopped;
    expect(watch.stopAsked).toBe(true);
    expect(watch.bytesAfterStop).toBeLessThanOrEqual(CHUNK);
    expect(answer.status).not.toBe(200);
  });

  it("ends a retirement inside a session transcript, binding no outcome", async () => {
    const f = fixture({ transcriptBytes: 8 << 20 });
    const request = await currentRequest(f, "op-stop");
    const api = await served(f);
    let stopped: Promise<void> | undefined;
    const watch = stopAtFirstRead(f.transcript, () => (stopped = api.stop()));
    const answer = await api.call("/retire", { method: "POST", body: JSON.stringify(request) });
    await stopped;
    expect(watch.stopAsked).toBe(true);
    expect(watch.bytesAfterStop).toBeLessThanOrEqual(CHUNK);
    // Cancelled, never refused: no outcome is bound, and the caller repeats this operation.
    expect(f.retire).not.toHaveBeenCalled();
    expect(f.settle).not.toHaveBeenCalled();
    expect(answer.status).toBe(503);
    expect(JSON.parse(answer.body)).toMatchObject({
      code: "thread_retirement_unavailable",
      retryable: true,
    });
  });
});
