import { createServer, type Server, type ServerResponse } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type Mode,
  type OpenMode,
  type PathLike,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  THREAD_EXPORT_SCHEMA_VERSION,
  threadExportDigest,
  threadExportItemId,
  threadExportLinkIdentity,
  type ThreadExportItem,
} from "@claudexor/schema";
import { parseArgs } from "./args.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";
import {
  exportThreadBundle,
  retireThreadBundle,
  threadRetireCommand,
} from "./thread-export-command.js";

// The command's own daemon discovery, pointed at the double below.
const discovered = vi.hoisted(() => ({ addr: null as null | { baseUrl: string; token: string } }));
vi.mock("./mcp-run-wait.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-run-wait.js")>()),
  connectForObservation: async () => (discovered.addr ? { addr: discovered.addr } : null),
}));

// The command's own file calls, observed. `linkSync` fails as a volume without hard
// links fails it, and keeps the ask, so one test can fence that the command never
// needs one. These are mocks: no real FAT or Windows volume is exercised here.
const fsHooks = vi.hoisted(() => ({
  /** Every hard link the command asked for. */
  linked: [] as string[],
  /** Runs once, at the first bundle byte read for hashing. */
  onRead: null as null | (() => void),
  /** The path each hashing read opened, in order. */
  hashed: [] as string[],
  /** The flags each open of a path used, latest last. */
  openedWith: new Map<string, unknown[]>(),
  /** The path each fsync reached, in order. */
  synced: [] as string[],
  /** A path whose fsync fails, as on a volume that cannot make it durable. */
  failSync: null as null | ((path: string) => boolean),
  /** What such an fsync fails with. */
  syncErrno: "EIO",
  /** A path that reads as another volume: this host has no second one to rely on. */
  otherVolume: null as null | ((path: string) => boolean),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const opened = new Map<number, string>();
  return {
    ...actual,
    linkSync: ((_existing: PathLike, target: PathLike) => {
      fsHooks.linked.push(String(target));
      throw Object.assign(new Error(`EPERM: operation not permitted, link '${String(target)}'`), {
        code: "EPERM",
        syscall: "link",
      });
    }) as typeof actual.linkSync,
    openSync: ((path: PathLike, flags: OpenMode, mode?: Mode | null) => {
      const fd = actual.openSync(path, flags, mode);
      opened.set(fd, String(path));
      const seen = fsHooks.openedWith.get(String(path)) ?? [];
      fsHooks.openedWith.set(String(path), [...seen, flags]);
      return fd;
    }) as typeof actual.openSync,
    fsyncSync: ((fd: number) => {
      const path = opened.get(fd) ?? `fd ${fd}`;
      if (fsHooks.failSync?.(path))
        throw Object.assign(new Error(`${fsHooks.syncErrno}: injected, fsync '${path}'`), {
          code: fsHooks.syncErrno,
          syscall: "fsync",
        });
      fsHooks.synced.push(path);
      actual.fsyncSync(fd);
    }) as typeof actual.fsyncSync,
    statSync: ((path: PathLike, options?: Parameters<typeof actual.statSync>[1]) => {
      const stat = actual.statSync(path, options)!;
      return fsHooks.otherVolume?.(String(path))
        ? Object.assign(Object.create(stat), { dev: Number(stat.dev) + 1 })
        : stat;
    }) as typeof actual.statSync,
    createReadStream: ((
      path: PathLike,
      options?: Parameters<typeof actual.createReadStream>[1],
    ) => {
      const hook = fsHooks.onRead;
      fsHooks.onRead = null;
      hook?.();
      fsHooks.hashed.push(String(path));
      return actual.createReadStream(path, options);
    }) as typeof actual.createReadStream,
  };
});

const roots: string[] = [];
const servers: Server[] = [];
afterEachClosed(async () => {
  fsHooks.linked.length = 0;
  fsHooks.onRead = null;
  fsHooks.hashed.length = 0;
  fsHooks.openedWith.clear();
  fsHooks.synced.length = 0;
  fsHooks.failSync = null;
  fsHooks.syncErrno = "EIO";
  fsHooks.otherVolume = null;
  // This test's entries, taken before their closes: a late close never reaches the next test's.
  const ownedRoots = roots.splice(0);
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  return () => {
    for (const root of ownedRoots) rmSync(root, { recursive: true, force: true });
  };
});

const THREAD = "th-consumer";
const digest = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fileItem = (
  plane: ThreadExportItem["plane"],
  path: string,
  size: number | null = null,
): ThreadExportItem => ({
  itemId: threadExportItemId(plane, path),
  plane,
  path,
  kind: "file",
  sizeBytes: size,
  mtimeMs: 1,
  sha256: null,
  projectionOf: null,
  linkTarget: null,
});

/** A daemon double speaking the exact wire: manifest, then items by id. */
async function daemon(
  items: ThreadExportItem[],
  body: (item: ThreadExportItem) => { bytes: string; etag?: string },
) {
  const manifest = {
    schemaVersion: THREAD_EXPORT_SCHEMA_VERSION,
    storeId: "store-1",
    threadId: THREAD,
    exportId: digest("export"),
    closureDigest: digest("closure"),
    threadState: "active",
    headRevision: 1,
    workspaceMode: "delegated",
    coverage: "complete",
    retirable: true,
    gaps: [],
    disclosures: [],
    closure: { turns: [], runs: [] },
    sessions: [],
    items,
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x").pathname;
    if (url.endsWith("/export")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(manifest));
      return;
    }
    const item = items.find((candidate) => url.endsWith(`/items/${candidate.itemId}`))!;
    const { bytes, etag } = body(item);
    res.writeHead(200, { etag: `"${etag ?? digest(bytes)}"` });
    res.end(bytes);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as { port: number };
  const root = mkdtempSync(join(tmpdir(), "cx-consumer-"));
  roots.push(root);
  return {
    out: join(root, "bundle"),
    address: { baseUrl: `http://127.0.0.1:${port}`, token: "t" },
  };
}

describe("thread export consumer", () => {
  it("verifies and writes each item, then computes the published digests", async () => {
    const link = threadExportLinkIdentity("/elsewhere");
    const symlink: ThreadExportItem = {
      ...fileItem("lane", "lanes/t/l"),
      kind: "symlink",
      linkTarget: "/elsewhere",
      sizeBytes: link.sizeBytes,
      sha256: link.sha256,
    };
    const run = fileItem("run", "runs/r/a.txt", 1);
    const lane = fileItem("lane", "lanes/t/b.txt", 1);
    const d = await daemon([run, lane, symlink], (item) => ({
      bytes: item === run ? "a" : "b",
    }));
    const { receipt } = await exportThreadBundle(d.address, THREAD, d.out);
    expect(readdirSync(d.out).sort()).toEqual(["lanes", "manifest.json", "receipt.json", "runs"]);
    expect(statSync(join(d.out, "runs/r/a.txt")).size).toBe(1);
    // A link is a manifest record; its target is neither read nor written.
    expect(existsSync(join(d.out, "lanes/t/l"))).toBe(false);
    const laneEntries = [
      { itemId: lane.itemId, sha256: digest("b"), sizeBytes: 1 },
      { itemId: symlink.itemId, ...link },
    ];
    expect(receipt.laneDigest).toBe(threadExportDigest(laneEntries));
    expect(receipt.contentDigest).toBe(
      threadExportDigest([
        ...laneEntries,
        { itemId: run.itemId, sha256: digest("a"), sizeBytes: 1 },
      ]),
    );
  });

  it("refuses received bytes that do not match the declared digest and writes no receipt", async () => {
    const item = fileItem("run", "runs/r/a.txt");
    const d = await daemon([item], () => ({ bytes: "a", etag: digest("something else") }));
    await expect(exportThreadBundle(d.address, THREAD, d.out)).rejects.toMatchObject({
      code: "thread_export_transfer_mismatch",
    });
    expect(existsSync(join(d.out, "receipt.json"))).toBe(false);
    expect(existsSync(join(d.out, "runs/r/a.txt"))).toBe(false);
    expect(readdirSync(d.out).filter((name) => name.includes(".partial-"))).toEqual([]);
  });

  it("refuses a manifest path that leaves the bundle", async () => {
    const d = await daemon([fileItem("run", "../escaped.txt")], () => ({ bytes: "a" }));
    await expect(exportThreadBundle(d.address, THREAD, d.out)).rejects.toMatchObject({
      code: "invalid_service_response",
    });
  });

  it("refuses to write into a directory that already holds something", async () => {
    const d = await daemon([], () => ({ bytes: "" }));
    await exportThreadBundle(d.address, THREAD, d.out);
    await expect(exportThreadBundle(d.address, THREAD, d.out)).rejects.toThrow("new or empty");
  });
});

describe("thread export names that collide in the destination", () => {
  it("never replaces a payload already placed at the same name", async () => {
    const zst = fileItem("native", "native/s/x.jsonl.zst", 1);
    const projection: ThreadExportItem = {
      ...fileItem("projection", "native/s/x.jsonl.zst.decoded.jsonl", 1),
      projectionOf: zst.itemId,
    };
    const real = fileItem("native", "native/s/x.jsonl.zst.decoded.jsonl", 1);
    const d = await daemon([zst, projection, real], (item) => ({
      bytes: item === projection ? "p" : item === real ? "q" : "z",
    }));
    await expect(exportThreadBundle(d.address, THREAD, d.out)).rejects.toMatchObject({
      code: "thread_export_path_collision",
    });
    expect(readFileSync(join(d.out, real.path), "utf8")).toBe("p");
    expect(existsSync(join(d.out, "receipt.json"))).toBe(false);
  });

  it("keeps one copy when both names hold the same bytes", async () => {
    const zst = fileItem("native", "native/s/x.jsonl.zst", 1);
    const projection: ThreadExportItem = {
      ...fileItem("projection", "native/s/x.jsonl.zst.decoded.jsonl", 1),
      projectionOf: zst.itemId,
    };
    const real = fileItem("native", "native/s/x.jsonl.zst.decoded.jsonl", 1);
    const d = await daemon([zst, projection, real], (item) => ({
      bytes: item === zst ? "z" : "p",
    }));
    const { receipt } = await exportThreadBundle(d.address, THREAD, d.out);
    expect(receipt.transferred.map((entry) => entry.path)).toEqual([
      zst.path,
      projection.path,
      real.path,
    ]);
    expect(readFileSync(join(d.out, real.path), "utf8")).toBe("p");
  });

  it("treats names a case-insensitive destination cannot tell apart as one", async () => {
    const upper = fileItem("run", "runs/r/A.txt", 1);
    const lower = fileItem("run", "runs/r/a.txt", 1);
    const d = await daemon([upper, lower], (item) => ({ bytes: item === upper ? "A" : "a" }));
    const probe = join(dirname(d.out), "Case-Probe");
    writeFileSync(probe, "");
    const insensitive = existsSync(join(dirname(d.out), "case-probe"));
    if (insensitive) {
      await expect(exportThreadBundle(d.address, THREAD, d.out)).rejects.toMatchObject({
        code: "thread_export_path_collision",
      });
      expect(readFileSync(join(d.out, upper.path), "utf8")).toBe("A");
    } else {
      await exportThreadBundle(d.address, THREAD, d.out);
      expect(readFileSync(join(d.out, upper.path), "utf8")).toBe("A");
      expect(readFileSync(join(d.out, lower.path), "utf8")).toBe("a");
    }
  });
});

type Answer = "accept" | "unavailable" | "broken" | "hang-up" | "refuse" | "unbound" | "foreign";

/** One engine double for export, retire, abandon and the retirement read. */
async function engine(extra: { item: ThreadExportItem; bytes: string }[] = []) {
  const run = fileItem("run", "runs/r/a.txt", 1);
  const lane = fileItem("lane", "lanes/t/b.txt", 1);
  const items = [run, lane, ...extra.map((entry) => entry.item)];
  const bytes = (item: ThreadExportItem) =>
    item === run ? "a" : item === lane ? "b" : extra.find((entry) => entry.item === item)!.bytes;
  const manifest = {
    schemaVersion: THREAD_EXPORT_SCHEMA_VERSION,
    storeId: "store-1",
    threadId: THREAD,
    exportId: digest("export"),
    closureDigest: digest("closure"),
    threadState: "active",
    headRevision: 1,
    workspaceMode: "delegated",
    coverage: "complete",
    retirable: true,
    gaps: [],
    disclosures: [],
    closure: { turns: [], runs: [] },
    sessions: [],
    items,
  };
  /** Each request, with what had been synced when it arrived. */
  const posts: {
    path: string;
    body: Record<string, any>;
    syncedKept: number;
    synced: string[];
  }[] = [];
  const answers: Answer[] = [];
  /** Retire requests are held unanswered until this many were seen (or 3 s passed). */
  let holding = 0;
  const held: (() => void)[] = [];
  const release = () => {
    holding = 0;
    for (const answer of held.splice(0)) answer();
  };
  /** What the engine has bound, as its retirement read reports it. */
  const bound = new Map<
    string,
    { outcome: "accepted" | "refused" | "abandoned"; code: string | null }
  >();
  const operation = (operationId: string) => ({
    operationId,
    ...bound.get(operationId)!,
    message: null,
    settledAt: "2026-11-03T00:00:00.000Z",
  });
  const retirement = (operationId: string | null, request?: Record<string, any>) => {
    const outcome = operationId ? bound.get(operationId)?.outcome : undefined;
    return {
      schemaVersion: THREAD_EXPORT_SCHEMA_VERSION,
      storeId: "store-1",
      threadId: THREAD,
      threadState: outcome === "accepted" ? "purged" : "active",
      status: outcome === "accepted" ? "removed" : "not_accepted",
      acceptance:
        outcome === "accepted" && request
          ? { ...request, acceptedAt: "2026-11-03T00:00:00.000Z" }
          : null,
      cleanup: null,
      operation: outcome && operationId ? operation(operationId) : null,
    };
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  /** A retirement read that names something else than what was asked, when a test sets it. */
  let readsAs: null | "another operation" | "another thread" = null;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const path = url.pathname;
    if (req.method === "GET" && path.endsWith("/export")) return json(res, 200, manifest);
    if (req.method === "GET" && path.endsWith("/retirement")) {
      const operationId = url.searchParams.get("operationId");
      if (readsAs === "another thread")
        return json(res, 200, { ...retirement(operationId), threadId: "th-other" });
      if (readsAs === "another operation") {
        const settledAt = "2026-11-03T00:00:00.000Z";
        const foreign = { operationId: "op-foreign", outcome: "accepted", code: null };
        return json(res, 200, {
          ...retirement(null),
          operation: { ...foreign, message: null, settledAt },
        });
      }
      return json(res, 200, retirement(operationId));
    }
    if (req.method === "GET") {
      const item = items.find((candidate) => path.endsWith(`/items/${candidate.itemId}`))!;
      res.writeHead(200, { etag: `"${digest(bytes(item))}"` });
      return res.end(bytes(item));
    }
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, any>;
      posts.push({
        path,
        body,
        syncedKept: fsHooks.synced.filter((synced) => synced.endsWith("retire-request.json"))
          .length,
        synced: [...fsHooks.synced],
      });
      const operationId = String(body["operationId"]);
      if (path.endsWith("/retire/abandon")) {
        if (!bound.has(operationId)) bound.set(operationId, { outcome: "abandoned", code: null });
        return json(res, 200, retirement(operationId));
      }
      const refuse = (code: string, message: string) => {
        if (!bound.has(operationId)) bound.set(operationId, { outcome: "refused", code });
        return json(res, 409, { code, message, retryable: false, context: { settled: true } });
      };
      const respond = (answer: Answer) => {
        // A bound operation answers its one outcome and evaluates nothing.
        const prior = bound.get(operationId);
        if (prior?.outcome === "accepted") return json(res, 200, retirement(operationId, body));
        if (prior?.outcome === "abandoned")
          return refuse("thread_retirement_abandoned", "this operation was abandoned");
        if (prior) return refuse(prior.code!, "this operation was refused");
        const winner = [...bound].find(([, settled]) => settled.outcome === "accepted")?.[0];
        if (winner)
          return refuse(
            "thread_retirement_conflict",
            `thread already retired by operation ${winner}`,
          );
        if (answer === "hang-up") return req.socket.destroy();
        if (answer === "unavailable")
          return json(res, 503, {
            code: "thread_retirement_unavailable",
            message: "the engine stopped",
            retryable: true,
          });
        if (answer === "broken") {
          res.writeHead(200, { "content-type": "application/json", "content-length": "4096" });
          res.write('{"schemaVersion":');
          return setImmediate(() => res.destroy());
        }
        if (answer === "refuse")
          return refuse("thread_export_stale", "exported bytes differ from the content digest");
        // Schema-valid 200s that bind nothing for this operation.
        if (answer === "unbound") return json(res, 200, retirement(null));
        if (answer === "foreign")
          return json(res, 200, {
            ...retirement(null),
            operation: {
              operationId: "op-foreign",
              outcome: "accepted",
              code: null,
              message: null,
              settledAt: "2026-11-03T00:00:00.000Z",
            },
          });
        bound.set(operationId, { outcome: "accepted", code: null });
        return json(res, 200, retirement(operationId, body));
      };
      const answer = answers.shift() ?? "accept";
      if (holding === 0) return respond(answer);
      held.push(() => respond(answer));
      if (held.length >= holding) release();
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as { port: number };
  const root = mkdtempSync(join(tmpdir(), "cx-retire-consumer-"));
  roots.push(root);
  const address = { baseUrl: `http://127.0.0.1:${port}`, token: "t" };
  discovered.addr = address;
  let bundles = 0;
  return {
    run,
    lane,
    posts,
    bound,
    address,
    answer: (...next: Answer[]) => answers.push(...next),
    readAs: (what: typeof readsAs) => (readsAs = what),
    holdUntil: (seen: number) => {
      holding = seen;
      setTimeout(release, 3_000).unref();
    },
    exported: async (...newParents: string[]) => {
      const out = join(root, ...newParents, `bundle-${(bundles += 1)}`);
      await exportThreadBundle(address, THREAD, out);
      return out;
    },
  };
}

/** The real command, as `claudexor thread-retire ... --json` runs it. */
async function retire(...argv: string[]) {
  const written: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    const code = await threadRetireCommand(parseArgs(["thread-retire", THREAD, ...argv]), true);
    return { code, json: JSON.parse(written.join("")) as Record<string, any> };
  } finally {
    spy.mockRestore();
  }
}

describe("thread-retire: one operation per export until it is settled", () => {
  afterEach(() => {
    discovered.addr = null;
  }, 0); // synchronous restore: no deadline (#376, see vitest.setup.ts)

  it("names its operation on every uncertain answer and repeats that same operation", async () => {
    const e = await engine();
    const out = await e.exported();
    const receipt = JSON.parse(readFileSync(join(out, "receipt.json"), "utf8"));
    e.answer("unavailable", "broken", "hang-up");
    const unavailable = await retire("--export", out);
    const op = e.posts[0]!.body["operationId"] as string;
    for (const answered of [
      unavailable,
      await retire("--export", out),
      await retire("--export", out),
    ]) {
      expect(answered.code).toBe(1);
      expect(answered.json).toMatchObject({
        code: "thread_retirement_outcome_unknown",
        retryable: true,
        details: { operationId: op },
      });
      expect(answered.json["message"]).toContain(op);
    }
    const accepted = await retire("--export", out);
    expect(accepted.code).toBe(0);
    expect(accepted.json).toMatchObject({ operation: { operationId: op, outcome: "accepted" } });
    // Its outcome is known, so nothing stays kept: naming it joins that acceptance,
    // and any other operation is the engine's to refuse.
    expect(existsSync(join(out, "retire-request.json"))).toBe(false);
    expect((await retire("--export", out, "--operation-id", op)).code).toBe(0);
    const another = await retire("--export", out);
    expect(another.json).toMatchObject({
      code: "thread_retirement_conflict",
      context: { settled: true },
    });
    const sent = e.posts.map((post) => post.body["operationId"]);
    expect(sent.slice(0, 5)).toEqual([op, op, op, op, op]);
    expect(sent[5]).not.toBe(op);
    for (const post of e.posts.slice(0, 5))
      expect(post.body).toEqual({
        operationId: op,
        exportId: receipt.exportId,
        closureDigest: receipt.closureDigest,
        contentDigest: receipt.contentDigest,
        laneDigest: receipt.laneDigest,
      });
  });

  it("starts another operation only after a settled refusal", async () => {
    const e = await engine();
    const out = await e.exported();
    e.answer("refuse", "accept");
    const refused = await retire("--export", out);
    expect(refused.code).toBe(1);
    expect(refused.json).toMatchObject({ code: "thread_export_stale", context: { settled: true } });
    expect((await retire("--export", out)).code).toBe(0);
    const [first, second] = e.posts.map((post) => post.body["operationId"]);
    expect(second).not.toBe(first);
  });

  it("keeps an explicit operation until it is settled, then releases it", async () => {
    const e = await engine();
    const explicit = await e.exported();
    e.answer("unavailable");
    expect((await retire("--export", explicit, "--operation-id", "op-explicit")).code).toBe(1);
    // That unsettled operation is the export's until it is settled.
    const other = await retire("--export", explicit, "--operation-id", "op-other");
    expect(other.code).toBe(2);
    expect(other.json["message"]).toContain("op-explicit");
    expect((await retire("--abandon", "--operation-id", "op-explicit")).code).toBe(0);
    const settled = await retire("--export", explicit);
    expect(settled.json).toMatchObject({
      code: "thread_retirement_abandoned",
      context: { settled: true },
    });
    // Released: the next command is a new operation from the same verified bundle.
    expect((await retire("--export", explicit)).code).toBe(0);
    const sent = e.posts
      .filter((post) => post.path.endsWith("/retire"))
      .map((post) => post.body["operationId"]);
    expect(sent.slice(0, 2)).toEqual(["op-explicit", "op-explicit"]);
    expect(sent[2]).not.toBe("op-explicit");
  });

  it.each([false, true])(
    "honours literal --abandon=false (with export: %s)",
    async (withExport) => {
      const e = await engine();
      const out = await e.exported();
      e.answer("unavailable");
      expect((await retire("--export", out, "--operation-id", "op-false")).code).toBe(1);
      const before = e.posts.length;
      const answer = await retire(
        "--abandon=false",
        "--operation-id",
        "op-false",
        ...(withExport ? ["--export", out] : []),
      );
      expect(answer.code).toBe(withExport ? 0 : 2);
      expect(e.posts.slice(before).map((post) => post.path)).toEqual(
        withExport ? [`/v2/threads/${THREAD}/retire`] : [],
      );
      expect(e.bound.get("op-false")?.outcome).toBe(withExport ? "accepted" : undefined);
      expect(existsSync(join(out, "retire-request.json"))).toBe(!withExport);
    },
  );

  it("sends only the request kept first when two invocations race on one bundle", async () => {
    const e = await engine();
    const out = await e.exported();
    // Both requests are held until the double has seen two, then both are unknown.
    e.holdUntil(2);
    e.answer("unavailable", "unavailable");
    const connectTo = async () => e.address;
    const raced = await Promise.allSettled([
      retireThreadBundle(connectTo, THREAD, out),
      retireThreadBundle(connectTo, THREAD, out),
    ]);
    const kept = JSON.parse(readFileSync(join(out, "retire-request.json"), "utf8")) as {
      operationId: string;
    };
    // Every request that left is the one this bundle keeps, and no private copy stays.
    expect(e.posts.map((post) => post.body["operationId"])).toEqual([
      kept.operationId,
      kept.operationId,
    ]);
    expect(readdirSync(out).filter((name) => name.includes(".partial-"))).toEqual([]);
    // Each sender synced the kept request itself before its request left, the
    // second one included, which may have read it before its writer synced it.
    const synced = e.posts.map((post) => post.syncedKept).sort((a, b) => a - b);
    expect(synced[0]).toBeGreaterThanOrEqual(1);
    expect(synced[1]).toBeGreaterThanOrEqual(2);
    for (const result of raced)
      expect(result).toMatchObject({
        status: "rejected",
        reason: {
          code: "thread_retirement_outcome_unknown",
          details: { operationId: kept.operationId },
        },
      });
  });

  it("exports, refuses a collision and retires without ever asking for a hard link", async () => {
    // The fence against the capability a linking install once cost a volume without
    // links: nothing here reaches one, whichever way an item's bytes are placed.
    const zst = fileItem("native", "native/s/x.jsonl.zst", 1);
    const projection: ThreadExportItem = {
      ...fileItem("projection", "native/s/x.jsonl.zst.decoded.jsonl", 1),
      projectionOf: zst.itemId,
    };
    const real = fileItem("native", "native/s/x.jsonl.zst.decoded.jsonl", 1);
    const refused = await daemon([zst, projection, real], (item) => ({
      bytes: item === projection ? "p" : item === real ? "q" : "z",
    }));
    await expect(exportThreadBundle(refused.address, THREAD, refused.out)).rejects.toMatchObject({
      code: "thread_export_path_collision",
    });
    const e = await engine([
      { item: zst, bytes: "z" },
      { item: projection, bytes: "p" },
      { item: real, bytes: "p" },
    ]);
    const out = await e.exported();
    const retired = await retire("--export", out);
    expect(retired.code).toBe(0);
    const op = e.posts[0]!.body["operationId"] as string;
    expect(retired.json).toMatchObject({ operation: { operationId: op, outcome: "accepted" } });
    expect(e.posts.map((post) => [post.body["operationId"], post.syncedKept])).toEqual([[op, 1]]);
    expect(existsSync(join(out, "retire-request.json"))).toBe(false);
    expect(fsHooks.linked).toEqual([]);
  });

  it("sends a request another invocation kept only once it is synced here too", async () => {
    const e = await engine();
    const out = await e.exported();
    const receipt = JSON.parse(readFileSync(join(out, "receipt.json"), "utf8"));
    // Whole, from a writer that has not synced it yet.
    writeFileSync(
      join(out, "retire-request.json"),
      `${JSON.stringify({
        operationId: "retire-kept-elsewhere",
        exportId: receipt.exportId,
        closureDigest: receipt.closureDigest,
        contentDigest: receipt.contentDigest,
        laneDigest: receipt.laneDigest,
      })}\n`,
    );
    expect((await retire("--export", out)).code).toBe(0);
    expect(e.posts.map((post) => [post.body["operationId"], post.syncedKept])).toEqual([
      ["retire-kept-elsewhere", 1],
    ]);
  });

  it.each([
    ["torn, found while keeping", (whole: string): string => whole.slice(0, 40), true],
    ["empty, kept before this invocation", (_whole: string): string => "", false],
  ] as const)(
    "refuses before sending, replacing nothing, when the kept request is %s",
    async (_state, written, whileKeeping) => {
      const e = await engine();
      const out = await e.exported();
      const receipt = JSON.parse(readFileSync(join(out, "receipt.json"), "utf8"));
      const bytes = written(
        JSON.stringify({
          operationId: "retire-other",
          exportId: receipt.exportId,
          closureDigest: receipt.closureDigest,
          contentDigest: receipt.contentDigest,
          laneDigest: receipt.laneDigest,
        }),
      );
      const kept = join(out, "retire-request.json");
      // Another writer created it and has not finished, or stopped part way.
      if (whileKeeping) fsHooks.onRead = () => writeFileSync(kept, bytes);
      else writeFileSync(kept, bytes);
      const refused = await retire("--export", out);
      expect(refused.code).toBe(1);
      expect(refused.json).toMatchObject({
        code: "thread_retirement_request_incomplete",
        retryable: true,
      });
      expect(e.posts).toEqual([]);
      expect(readFileSync(kept, "utf8")).toBe(bytes);
      expect(readdirSync(out).filter((name) => name.includes(".partial-"))).toEqual([]);
    },
  );

  it.each(["unbound", "foreign"] as const)(
    "keeps and names its operation when a 200 binds no outcome to it (%s)",
    async (answer) => {
      const e = await engine();
      const out = await e.exported();
      e.answer(answer);
      const first = await retire("--export", out);
      const op = e.posts[0]!.body["operationId"] as string;
      expect(first.code).toBe(1);
      expect(first.json).toMatchObject({
        code: "thread_retirement_outcome_unknown",
        details: { operationId: op },
      });
      const kept = JSON.parse(readFileSync(join(out, "retire-request.json"), "utf8"));
      expect(kept.operationId).toBe(op);
      // The next command repeats that operation, which the engine then accepts.
      const second = await retire("--export", out);
      expect(second.code).toBe(0);
      expect(second.json).toMatchObject({ operation: { operationId: op, outcome: "accepted" } });
      expect(e.posts.map((post) => post.body["operationId"])).toEqual([op, op]);
    },
  );

  it("sends no new retirement for a bundle that no longer holds its bytes", async () => {
    const e = await engine();
    const out = await e.exported();
    writeFileSync(join(out, e.lane.path), "B");
    const changed = await retire("--export", out);
    expect(changed.code).toBe(1);
    expect(changed.json).toMatchObject({ code: "thread_export_bundle_changed" });
    rmSync(join(out, e.run.path));
    expect((await retire("--export", out)).json).toMatchObject({
      code: "thread_export_bundle_changed",
    });
    expect(e.posts).toEqual([]);
  });

  it("repeats an unsettled operation of a damaged bundle only once the engine bound it", async () => {
    const e = await engine();
    const out = await e.exported();
    e.answer("unavailable");
    await retire("--export", out);
    const op = e.posts[0]!.body["operationId"] as string;
    writeFileSync(join(out, e.lane.path), "B");
    // Unbound: repeating it now would be a new decision over changed bytes.
    const held = await retire("--export", out);
    expect(held.code).toBe(1);
    expect(held.json).toMatchObject({
      code: "thread_export_bundle_changed",
      details: { operationId: op },
    });
    expect(e.posts).toHaveLength(1);
    // Once the engine reports it accepted, the same operation is joined.
    e.bound.set(op, { outcome: "accepted", code: null });
    const joined = await retire("--export", out);
    expect(joined.code).toBe(0);
    // A known acceptance is joined again by naming it; an unnamed request from
    // changed bytes is never sent.
    expect((await retire("--export", out, "--operation-id", op)).code).toBe(0);
    expect((await retire("--export", out)).json).toMatchObject({
      code: "thread_export_bundle_changed",
    });
    expect(e.posts.map((post) => post.body["operationId"])).toEqual([op, op, op]);
  });
});

const attachment = (name: string, id = "res-1") =>
  fileItem("resource", `resources/${id}/${encodeURIComponent(name)}`);
const receiptOf = (out: string) =>
  JSON.parse(readFileSync(join(out, "receipt.json"), "utf8")) as {
    transferred: { itemId: string; path: string; placedAt?: string; sha256: string }[];
  };
const entryOf = (out: string, item: ThreadExportItem) =>
  receiptOf(out).transferred.find((entry) => entry.itemId === item.itemId)!;
const partials = (out: string) => readdirSync(out).filter((name) => name.includes(".partial-"));

describe("thread export names this volume cannot hold", () => {
  afterEach(() => {
    discovered.addr = null;
  }, 0); // synchronous restore: no deadline (#376, see vitest.setup.ts)

  it.each([
    ["Cyrillic", `${"Презентация для инвесторов ".repeat(12)}финал.pdf`],
    ["CJK", `${"投資家向けプレゼンテーション資料".repeat(12)}.pdf`],
    ["ASCII", `${"a".repeat(300)}.pdf`],
  ])("keeps a long %s name complete as metadata and its bytes by item id", async (_kind, name) => {
    const item = attachment(name);
    const e = await engine([{ item, bytes: "long name bytes" }]);
    const out = await e.exported();
    const entry = entryOf(out, item);
    expect(entry.path).toBe(item.path);
    expect(decodeURIComponent(entry.path.split("/").at(-1)!)).toBe(name);
    expect(entry.placedAt).toBe(`relocated/${item.itemId}.pdf`);
    expect(readFileSync(join(out, entry.placedAt!), "utf8")).toBe("long name bytes");
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest.items.map((listed: ThreadExportItem) => listed.path)).toContain(item.path);
    // What fits stays where its path says.
    expect(readFileSync(join(out, e.run.path), "utf8")).toBe("a");
    expect(entryOf(out, e.run).placedAt).toBeUndefined();
    expect(partials(out)).toEqual([]);
    // The bundle verifies where the bytes are, so it retires from there.
    const retired = await retire("--export", out);
    expect(retired.code).toBe(0);
    expect(fsHooks.hashed).toContain(join(out, entry.placedAt!));
  });

  it.each([
    ["an ordinary 43 character Cyrillic name", "Презентация для инвесторов финал версия.pdf"],
    ["a 230 byte ASCII name", `${"b".repeat(226)}.pdf`],
    ["a 255 byte ASCII name, nothing to spare", `${"c".repeat(251)}.pdf`],
  ])("keeps %s at that name: receiving it adds nothing to it", async (_kind, name) => {
    const item = attachment(name);
    const d = await daemon([item], () => ({ bytes: "fits" }));
    const { receipt } = await exportThreadBundle(d.address, THREAD, d.out);
    expect(receipt.transferred).toEqual([
      expect.objectContaining({ itemId: item.itemId, path: item.path }),
    ]);
    expect(receipt.transferred[0]).not.toHaveProperty("placedAt");
    expect(readFileSync(join(d.out, item.path), "utf8")).toBe("fits");
    expect(partials(d.out)).toEqual([]);
  });

  it("keeps long names that differ only at their end or in letter case apart", async () => {
    const long = "x".repeat(300);
    const names = [`${long}1.pdf`, `${long}2.pdf`, `${long.toUpperCase()}1.pdf`];
    const items = names.map((name) => attachment(name));
    const e = await engine(items.map((item, index) => ({ item, bytes: `bytes ${index}` })));
    const out = await e.exported();
    const places = items.map((item) => entryOf(out, item).placedAt!);
    expect(new Set(places).size).toBe(3);
    places.forEach((place, index) =>
      expect(readFileSync(join(out, place), "utf8")).toBe(`bytes ${index}`),
    );
    expect((await retire("--export", out)).code).toBe(0);
  });

  it("relocates what a long directory name holds, within the bundle", async () => {
    const item = fileItem("run", `runs/r/${"d".repeat(300)}/note.txt`);
    const e = await engine([{ item, bytes: "under a long directory" }]);
    const out = await e.exported();
    expect(entryOf(out, item).placedAt).toBe(`relocated/${item.itemId}.txt`);
    expect(readFileSync(join(out, `relocated/${item.itemId}.txt`), "utf8")).toBe(
      "under a long directory",
    );
    expect((await retire("--export", out)).code).toBe(0);
  });

  it("relocates a path too long as a whole, though each of its names fits", async () => {
    const item = fileItem("run", `runs/r/${`${"s".repeat(200)}/`.repeat(30)}note.txt`);
    const e = await engine([{ item, bytes: "deep" }]);
    const out = await e.exported();
    const entry = entryOf(out, item);
    // Past both PATH_MAX values in use; a volume whose API takes it may keep the path.
    if (process.platform !== "win32") expect(entry.placedAt).toBe(`relocated/${item.itemId}.txt`);
    expect(readFileSync(join(out, entry.placedAt ?? item.path), "utf8")).toBe("deep");
    expect((await retire("--export", out)).code).toBe(0);
  });

  it("relocates a projection its suffix makes too long, and not its original", async () => {
    const zst = fileItem("native", `native/s/${"n".repeat(245)}.jsonl.zst`);
    const projection: ThreadExportItem = {
      ...fileItem("projection", `${zst.path}.decoded.jsonl`),
      projectionOf: zst.itemId,
    };
    const e = await engine([
      { item: zst, bytes: "compressed" },
      { item: projection, bytes: "decoded" },
    ]);
    const out = await e.exported();
    expect(entryOf(out, zst).placedAt).toBeUndefined();
    expect(readFileSync(join(out, zst.path), "utf8")).toBe("compressed");
    expect(entryOf(out, projection).placedAt).toBe(`relocated/${projection.itemId}.jsonl`);
    expect((await retire("--export", out)).code).toBe(0);
  });

  it("refuses a relocation another item's path already holds with other bytes", async () => {
    const item = attachment(`${"y".repeat(300)}.pdf`);
    const squatter = fileItem("run", `relocated/${item.itemId}.pdf`);
    const d = await daemon([squatter, item], (served) => ({
      bytes: served === item ? "long" : "squatter",
    }));
    await expect(exportThreadBundle(d.address, THREAD, d.out)).rejects.toMatchObject({
      code: "thread_export_path_collision",
    });
    expect(readFileSync(join(d.out, squatter.path), "utf8")).toBe("squatter");
    expect(existsSync(join(d.out, "receipt.json"))).toBe(false);
    // The same bytes serve both, as any two names of one place do.
    const same = await daemon([squatter, item], () => ({ bytes: "same" }));
    const { receipt } = await exportThreadBundle(same.address, THREAD, same.out);
    expect(receipt.transferred.map((entry) => entry.path)).toEqual([squatter.path, item.path]);
    expect(readFileSync(join(same.out, squatter.path), "utf8")).toBe("same");
  });

  it("sends nothing when relocated bytes changed, or a receipt places them outside", async () => {
    const item = attachment(`${"z".repeat(300)}.pdf`);
    const e = await engine([{ item, bytes: "long" }]);
    const out = await e.exported();
    const place = join(out, entryOf(out, item).placedAt!);
    writeFileSync(place, "LONG");
    expect((await retire("--export", out)).json).toMatchObject({
      code: "thread_export_bundle_changed",
    });
    writeFileSync(place, "long");
    const receiptPath = join(out, "receipt.json");
    const receipt = readFileSync(receiptPath, "utf8");
    writeFileSync(
      receiptPath,
      receipt.replace(entryOf(out, item).placedAt!, "../outside-the-bundle"),
    );
    expect((await retire("--export", out)).json).toMatchObject({
      code: "invalid_service_response",
    });
    expect(e.posts).toEqual([]);
    writeFileSync(receiptPath, receipt);
    expect((await retire("--export", out)).code).toBe(0);
  });
});

describe("thread-retire: what a new operation stands on is durable before it is sent", () => {
  afterEach(() => {
    discovered.addr = null;
  }, 0); // synchronous restore: no deadline (#376, see vitest.setup.ts)

  const bundlePaths = (out: string) => ({
    payloads: [join(out, "runs/r/a.txt"), join(out, "lanes/t/b.txt")],
    records: [join(out, "manifest.json"), join(out, "receipt.json")],
    directories: [
      join(out, "runs/r"),
      join(out, "runs"),
      join(out, "lanes/t"),
      join(out, "lanes"),
      out,
      dirname(out),
    ],
  });

  it("syncs each byte it hashes, in that one read, and every directory they need", async () => {
    const e = await engine();
    const out = await e.exported();
    const paths = bundlePaths(out);
    expect(await retire("--export", out)).toMatchObject({ code: 0 });
    const synced = e.posts[0]!.synced;
    expect(synced).toEqual(
      expect.arrayContaining([
        ...paths.payloads,
        ...paths.records,
        ...(process.platform === "win32" ? [] : paths.directories),
        join(out, "retire-request.json"),
      ]),
    );
    // One read of each payload: the barrier adds a sync, never a second pass.
    for (const payload of paths.payloads)
      expect(fsHooks.hashed.filter((path) => path === payload)).toHaveLength(1);
  });

  it("does not sync on export: only a retirement needs the barrier", async () => {
    const e = await engine();
    await e.exported();
    expect(fsHooks.synced).toEqual([]);
  });

  const syncable: [string, (out: string) => string][] = [
    ["a payload", (out) => join(out, "lanes/t/b.txt")],
    ["the manifest", (out) => join(out, "manifest.json")],
    ["the receipt", (out) => join(out, "receipt.json")],
  ];
  // Windows cannot open a directory to sync it, so it never asks.
  if (process.platform !== "win32")
    syncable.push(
      ["a directory of a payload", (out) => join(out, "runs/r")],
      ["the bundle directory", (out) => out],
      ["the directory holding the bundle", (out) => dirname(out)],
    );
  it.each(syncable)("refuses before any request when %s cannot be synced", async (_what, path) => {
    const e = await engine();
    const out = await e.exported();
    fsHooks.failSync = (synced) => synced === path(out);
    const refused = await retire("--export", out);
    expect(refused.code).toBe(1);
    expect(refused.json).toMatchObject({ code: "thread_export_bundle_unsynced", retryable: false });
    expect(refused.json["message"]).toContain("Nothing was sent");
    expect(e.posts).toEqual([]);
    expect(existsSync(join(out, "retire-request.json"))).toBe(false);
    // Nothing was spent: once the volume can sync, the same bundle retires.
    fsHooks.failSync = null;
    expect((await retire("--export", out)).code).toBe(0);
  });

  it("reports changed bytes as changed even when a sync also failed", async () => {
    const e = await engine();
    const out = await e.exported();
    fsHooks.failSync = () => true;
    writeFileSync(join(out, "lanes/t/b.txt"), "B");
    expect((await retire("--export", out)).json).toMatchObject({
      code: "thread_export_bundle_changed",
    });
    expect(e.posts).toEqual([]);
  });

  it("holds an unbound operation it cannot sync for, and still joins a bound one", async () => {
    const e = await engine();
    const out = await e.exported();
    e.answer("unavailable");
    await retire("--export", out);
    const op = e.posts[0]!.body["operationId"] as string;
    fsHooks.failSync = (path) => path.endsWith("receipt.json");
    const held = await retire("--export", out);
    expect(held.code).toBe(1);
    expect(held.json).toMatchObject({
      code: "thread_export_bundle_unsynced",
      details: { operationId: op },
    });
    expect(e.posts).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(out, "retire-request.json"), "utf8")).operationId).toBe(op);
    // The engine bound it meanwhile: repeating evaluates nothing, so it needs no barrier.
    e.bound.set(op, { outcome: "accepted", code: null });
    const joined = await retire("--export", out);
    expect(joined.code).toBe(0);
    expect(joined.json).toMatchObject({ operation: { operationId: op, outcome: "accepted" } });
    expect(e.posts.map((post) => post.body["operationId"])).toEqual([op, op]);
    expect(existsSync(join(out, "retire-request.json"))).toBe(false);
  });

  describe("the request the bundle kept", () => {
    const keptFile = (out: string) => join(out, "retire-request.json");
    type Engine = Awaited<ReturnType<typeof engine>>;
    /** A first command whose answer is lost: the bundle keeps its request, and the engine may decide it. */
    const lost = async (e: Engine, out: string) => {
      e.answer("unavailable");
      await retire("--export", out);
      return e.posts[0]!.body["operationId"] as string;
    };
    /** The request another invocation kept for this bundle, written as it would write it. */
    const requestOf = (out: string, operationId: string, change: Record<string, string> = {}) => {
      const receipt = JSON.parse(readFileSync(join(out, "receipt.json"), "utf8"));
      return `${JSON.stringify({
        operationId,
        exportId: receipt.exportId,
        closureDigest: receipt.closureDigest,
        contentDigest: receipt.contentDigest,
        laneDigest: receipt.laneDigest,
        ...change,
      })}\n`;
    };
    const failing: [string, (out: string) => string][] = [["the request file", keptFile]];
    // Windows cannot open a directory to sync it, so it never asks.
    if (process.platform !== "win32") failing.push(["the directory holding it", (out) => out]);

    it.each(failing)(
      "holds an unbound operation whose kept request cannot be synced, and joins a bound one (%s)",
      async (_what, path) => {
        const e = await engine();
        const out = await e.exported();
        const op = await lost(e, out);
        fsHooks.hashed.length = 0;
        fsHooks.failSync = (synced) => synced === path(out);
        // The engine has not bound it: sending it now would stand on a request that is not durable.
        const held = await retire("--export", out);
        expect(held.code).toBe(1);
        expect(held.json).toMatchObject({
          code: "thread_export_bundle_unsynced",
          retryable: false,
          details: { operationId: op },
        });
        expect(held.json["message"]).toContain(`${path(out)} durable: EIO`);
        expect(held.json["message"]).toContain(`--abandon --operation-id ${op}`);
        expect(e.posts).toHaveLength(1);
        expect(JSON.parse(readFileSync(keptFile(out), "utf8")).operationId).toBe(op);
        expect(fsHooks.hashed).toEqual([]);
        // It was decided after all and only the answer was lost: repeating a bound
        // operation evaluates nothing, so it needs no new barrier and is joined.
        e.bound.set(op, { outcome: "accepted", code: null });
        const joined = await retire("--export", out);
        expect(joined.code).toBe(0);
        expect(joined.json).toMatchObject({ operation: { operationId: op, outcome: "accepted" } });
        expect(e.posts.map((post) => post.body["operationId"])).toEqual([op, op]);
        expect(existsSync(keptFile(out))).toBe(false);
        expect(fsHooks.hashed).toEqual([]);
      },
    );

    it("holds an unbound operation a concurrent invocation kept first and this one cannot sync, and joins a bound one", async () => {
      const e = await engine();
      const unbound = await e.exported();
      const bound = await e.exported();
      /** The other invocation creates its request after this one found none and before
       * this one kept its own, so this one's create finds it. */
      const racing = (out: string, operationId: string) => {
        const winner = requestOf(out, operationId);
        fsHooks.onRead = () => writeFileSync(keptFile(out), winner);
        fsHooks.failSync = (synced) => synced === keptFile(out);
        return winner;
      };
      const winner = racing(unbound, "retire-winner-unbound");
      const held = await retire("--export", unbound);
      expect(held.json).toMatchObject({
        code: "thread_export_bundle_unsynced",
        details: { operationId: "retire-winner-unbound" },
      });
      expect(held.json["message"]).toContain(`${keptFile(unbound)} durable: EIO`);
      // Held: nothing was sent, and the request that was kept first is untouched.
      expect(e.posts).toEqual([]);
      expect(readFileSync(keptFile(unbound), "utf8")).toBe(winner);
      // The engine decided the other one's operation: it is joined, as that same operation.
      e.bound.set("retire-winner-bound", { outcome: "accepted", code: null });
      racing(bound, "retire-winner-bound");
      const joined = await retire("--export", bound);
      expect(joined.code).toBe(0);
      expect(joined.json).toMatchObject({
        operation: { operationId: "retire-winner-bound", outcome: "accepted" },
      });
      expect(e.posts.map((post) => post.body["operationId"])).toEqual(["retire-winner-bound"]);
    });

    it.each([
      ["another operation", "another operation", "thread_export_bundle_unsynced"],
      ["another thread", "another thread", "thread_retirement_outcome_unknown"],
    ] as const)(
      "does not join an operation the readback binds to %s",
      async (_what, readsAs, code) => {
        const e = await engine();
        const out = await e.exported();
        const op = await lost(e, out);
        fsHooks.failSync = (synced) => synced === keptFile(out);
        e.bound.set(op, { outcome: "accepted", code: null });
        e.readAs(readsAs);
        const held = await retire("--export", out);
        expect(held.json).toMatchObject({ code, details: { operationId: op } });
        // Neither read binds this operation here, so nothing but the first request left.
        expect(e.posts).toHaveLength(1);
        expect(existsSync(keptFile(out))).toBe(true);
      },
    );

    it.each([
      ["incomplete", "thread_retirement_request_incomplete", (whole: string) => whole.slice(0, 40)],
      [
        "another export's",
        "thread_retirement_request_unreadable",
        (whole: string) => whole.replace(/"exportId":"[^"]*"/, `"exportId":"${digest("other")}"`),
      ],
    ] as const)(
      "refuses a kept request that is %s before it asks about a sync",
      async (_what, code, damaged) => {
        const e = await engine();
        const out = await e.exported();
        const bytes = damaged(requestOf(out, "retire-other").trim());
        writeFileSync(keptFile(out), bytes);
        fsHooks.failSync = (synced) => synced === keptFile(out);
        const refused = await retire("--export", out);
        expect(refused.json).toMatchObject({ code });
        expect(e.posts).toEqual([]);
        expect(readFileSync(keptFile(out), "utf8")).toBe(bytes);
      },
    );

    const unmade: [string, (out: string) => (synced: string) => boolean][] = [
      ["the request file", (out) => (synced) => synced === keptFile(out)],
    ];
    if (process.platform !== "win32")
      unmade.push([
        // The second sync of the bundle directory: the first is the barrier before the request.
        "the directory holding it, after the file",
        (out) => {
          let seen = 0;
          return (synced) => synced === out && (seen += 1) === 2;
        },
      ]);
    it.each(unmade)(
      "sends no new operation whose own request cannot be made durable, and repeats the one it kept (%s)",
      async (_what, fails) => {
        const e = await engine();
        const out = await e.exported();
        fsHooks.failSync = fails(out);
        const refused = await retire("--export", out);
        expect(refused.code).toBe(1);
        expect(refused.json["message"]).toContain("EIO");
        expect(e.posts).toEqual([]);
        // What it wrote stays, never sent; once the volume can sync, that one is sent.
        const kept = JSON.parse(readFileSync(keptFile(out), "utf8")).operationId as string;
        fsHooks.failSync = null;
        expect((await retire("--export", out)).code).toBe(0);
        expect(e.posts.map((post) => post.body["operationId"])).toEqual([kept]);
      },
    );
  });

  // Windows cannot open a directory to sync it, so it asks for none of these.
  describe.skipIf(process.platform === "win32")("an --out whose parents it created", () => {
    /** The export's own recursive create makes both new parents. */
    const nested = async (e: Awaited<ReturnType<typeof engine>>) => {
      const out = await e.exported("new-parent", "new-child");
      const newChild = dirname(out);
      const newParent = dirname(newChild);
      return { out, newChild, newParent, existing: dirname(newParent) };
    };

    it("syncs every directory holding an entry it made, and those above them", async () => {
      const e = await engine();
      const { out, newChild, newParent, existing } = await nested(e);
      expect(await retire("--export", out)).toMatchObject({ code: 0 });
      expect(e.posts[0]!.synced).toEqual(
        expect.arrayContaining([out, newChild, newParent, existing, dirname(existing)]),
      );
    });

    it.each([
      ["the directory holding the bundle", "newChild", "EIO"],
      ["a new directory holding a new one", "newParent", "EIO"],
      ["the existing directory holding the first new one", "existing", "EIO"],
      // A permission error from the sync itself is a failed sync like any other.
      ["a new directory, with EPERM from its sync", "newParent", "EPERM"],
      ["the directory holding the bundle, with EACCES from its sync", "newChild", "EACCES"],
    ] as const)("sends no new operation when %s cannot be synced", async (_what, which, errno) => {
      const e = await engine();
      const paths = await nested(e);
      fsHooks.syncErrno = errno;
      fsHooks.failSync = (path) => path === paths[which];
      const refused = await retire("--export", paths.out);
      expect(e.posts.map((post) => post.path)).toEqual([]);
      expect(refused.code).toBe(1);
      expect(refused.json).toMatchObject({
        code: "thread_export_bundle_unsynced",
        retryable: false,
      });
      expect(refused.json["message"]).toContain(`${paths[which]} durable: ${errno}`);
      expect(existsSync(join(paths.out, "retire-request.json"))).toBe(false);
      // Nothing was spent: once the volume can sync, the same bundle retires.
      fsHooks.failSync = null;
      expect((await retire("--export", paths.out)).code).toBe(0);
    });

    it("holds an unbound operation over a failed ancestor, and joins a bound one", async () => {
      const e = await engine();
      const { out, newParent } = await nested(e);
      e.answer("unavailable");
      await retire("--export", out);
      const op = e.posts[0]!.body["operationId"] as string;
      fsHooks.failSync = (path) => path === newParent;
      const held = await retire("--export", out);
      expect(e.posts).toHaveLength(1);
      expect(held.json).toMatchObject({
        code: "thread_export_bundle_unsynced",
        details: { operationId: op },
      });
      e.bound.set(op, { outcome: "accepted", code: null });
      const joined = await retire("--export", out);
      expect(joined.code).toBe(0);
      expect(joined.json).toMatchObject({ operation: { operationId: op, outcome: "accepted" } });
      expect(e.posts.map((post) => post.body["operationId"])).toEqual([op, op]);
    });

    it("stops at the top of its volume: nothing it needs is above a mount point", async () => {
      const e = await engine();
      const { out, newParent, existing } = await nested(e);
      const above = dirname(existing);
      fsHooks.otherVolume = (path) => !path.startsWith(existing);
      fsHooks.failSync = (path) => path === above;
      expect(await retire("--export", out)).toMatchObject({ code: 0 });
      expect(e.posts[0]!.synced).toEqual(expect.arrayContaining([newParent, existing]));
      expect(e.posts[0]!.synced).not.toContain(above);
    });

    /** Search and create without listing: this user cannot open it to sync what it holds. */
    const unreadable = async <T>(directory: string, during: () => Promise<T>): Promise<T> => {
      chmodSync(directory, 0o311);
      try {
        return await during();
      } finally {
        chmodSync(directory, 0o755);
      }
    };

    it.skipIf(process.getuid?.() === 0).each([
      ["the directory holding the bundle", "newChild"],
      ["the existing directory holding the first new one", "existing"],
    ] as const)(
      "sends no new operation while this user may not open %s, and retires once it may",
      async (_what, which) => {
        const e = await engine();
        const paths = await nested(e);
        const refused = await unreadable(paths[which], () => retire("--export", paths.out));
        expect(e.posts).toEqual([]);
        expect(refused.code).toBe(1);
        expect(refused.json).toMatchObject({
          code: "thread_export_bundle_unsynced",
          retryable: false,
        });
        expect(refused.json["message"]).toContain(`${paths[which]} durable: EACCES`);
        expect(existsSync(join(paths.out, "retire-request.json"))).toBe(false);
        // Nothing was spent: with its read permission back, the same bundle retires.
        const retired = await retire("--export", paths.out);
        expect(retired.code).toBe(0);
        expect(retired.json).toMatchObject({ operation: { outcome: "accepted" } });
        expect(e.posts[0]!.synced).toContain(paths[which]);
      },
    );

    it.skipIf(process.getuid?.() === 0)(
      "still exports, and joins an operation the engine bound, while it may not open one",
      async () => {
        const e = await engine();
        const { out, existing } = await nested(e);
        e.answer("unavailable");
        await retire("--export", out);
        const op = e.posts[0]!.body["operationId"] as string;
        await unreadable(existing, async () => {
          // Only a new destructive acceptance needs the barrier.
          expect(existsSync(join(await e.exported("another"), "receipt.json"))).toBe(true);
          const held = await retire("--export", out);
          expect(e.posts).toHaveLength(1);
          expect(held.json).toMatchObject({
            code: "thread_export_bundle_unsynced",
            details: { operationId: op },
          });
          e.bound.set(op, { outcome: "accepted", code: null });
          const joined = await retire("--export", out);
          expect(joined.code).toBe(0);
          expect(joined.json).toMatchObject({
            operation: { operationId: op, outcome: "accepted" },
          });
        });
        expect(e.posts.map((post) => post.body["operationId"])).toEqual([op, op]);
      },
    );
  });

  it("on Windows flushes through a handle open for writing, and syncs no directory", async () => {
    // A platform mock over this host's files, for the handle it asks for: no native
    // Windows volume is exercised. A directory cannot be opened to sync it there.
    const e = await engine();
    const out = await e.exported();
    const paths = bundlePaths(out);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      expect((await retire("--export", out)).code).toBe(0);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    const synced = e.posts[0]!.synced;
    expect(synced).toEqual(expect.arrayContaining([...paths.payloads, ...paths.records]));
    for (const directory of paths.directories) expect(synced).not.toContain(directory);
    for (const path of [...paths.payloads, ...paths.records])
      expect(fsHooks.openedWith.get(path)?.at(-1)).toBe("r+");
  });
});
