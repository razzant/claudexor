import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";
import { writeExternalIncremental } from "./external-files.js";
import { readUploadRow } from "./resource-rows.js";
import {
  chunks,
  resourceFixture,
  uploadRequest,
  type ResourceFixture,
} from "./test-support/resource-fixture.js";

/** The store runs only where `node:sqlite` exists; elsewhere these cases are skipped, not failed. */
const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;

/**
 * A PUT's bytes go through `fs.promises`. Holding that write keeps the transfer
 * in flight while the request thread answers status; a pass-through otherwise
 * leaves the real pool write (and the FIFO probe) untouched.
 */
const hold = vi.hoisted(() => ({
  suffix: "",
  release: null as null | (() => void),
  entered: null as null | (() => void),
  /** Regular-file path → FIFO whose unread byte occupies one libuv thread. */
  blockOn: new Map<string, string>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const target = String(args[0]);
      const fifo = hold.blockOn.get(target);
      const gate = Boolean(hold.suffix) && target.endsWith(hold.suffix);
      if (!fifo && !gate) return handle;
      const write = handle.write.bind(handle);
      let held = false;
      handle.write = (async (...writeArgs: Parameters<typeof write>) => {
        if (gate && !held) {
          held = true;
          hold.entered?.();
          await new Promise<void>((resolveHold) => {
            hold.release = resolveHold;
          });
        }
        // A positioned write cannot block on a FIFO (ESPIPE). A slow O_DSYNC
        // write holds its libuv thread until the syscall returns; this unread
        // FIFO does the same for the duration of the probe.
        if (fifo) {
          const blocker = await actual.open(fifo, actual.constants.O_RDONLY);
          try {
            await blocker.read(Buffer.alloc(1), 0, 1, null);
          } finally {
            await blocker.close();
          }
        }
        return write(...writeArgs);
      }) as typeof handle.write;
      return handle;
    },
  };
});

const distStore = resolve(import.meta.dirname, "../../dist/store");
const roots: string[] = [];
const fixtures: ResourceFixture[] = [];
const children: ChildProcess[] = [];

function freshRoot(prefix: string): string {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(path);
  return path;
}
async function fixture(): Promise<ResourceFixture> {
  const opened = await resourceFixture(freshRoot("cx-upload-offloop-"));
  fixtures.push(opened);
  return opened;
}

afterEachClosed(async () => {
  const ownedRoots = roots.splice(0);
  const ownedChildren = children.splice(0);
  hold.suffix = "";
  hold.release?.();
  hold.release = null;
  hold.entered = null;
  hold.blockOn.clear();
  for (const child of ownedChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const opened of fixtures.splice(0)) await opened.close();
  return () => {
    for (const path of ownedRoots) rmSync(path, { recursive: true, force: true });
  };
});

describeStore("upload bytes leave the request thread", () => {
  it("answers status while a pool write is still pending, then records the finished total", async () => {
    const f = await fixture();
    const body = Buffer.from("testdata");
    const initial = f.resources.create({ ...uploadRequest, sizeBytes: body.length }, "pending");
    hold.suffix = `${initial.uploadId}.part`;
    hold.release = null;
    let settled = false;
    const writing = f.resources.write(initial.uploadId, chunks(body)).finally(() => {
      settled = true;
    });
    const entered = new Promise<void>((resolve, reject) => {
      hold.entered = resolve;
      writing.catch((error: unknown) => reject(error));
    });
    await entered;
    const started = performance.now();
    const during = f.resources.status(initial.uploadId);
    const elapsedMs = performance.now() - started;
    expect(settled).toBe(false);
    expect(elapsedMs).toBeLessThan(100);
    expect(during).toMatchObject({ state: "uploading", receivedBytes: 0 });
    expect(readUploadRow(f.store, initial.uploadId)?.finalizeSha).toBeNull();
    hold.release?.();
    await writing;
    const done = f.resources.status(initial.uploadId);
    expect(done).toMatchObject({ state: "uploaded", receivedBytes: body.length });
    const part = readFileSync(join(f.store.paths.uploads, `${initial.uploadId}.part`));
    expect(part).toEqual(body);
    expect(createHash("sha256").update(part).digest("hex")).toBe(
      createHash("sha256").update(body).digest("hex"),
    );
    expect(readUploadRow(f.store, initial.uploadId)?.finalizeSha).toBeNull();
    expect(f.resources.listModelResources()).toEqual([]);
  });

  it("cancels a stalled pool write, unlinks the part and publishes nothing", async () => {
    const f = await fixture();
    const body = Buffer.from("testdata");
    const initial = f.resources.create({ ...uploadRequest, sizeBytes: body.length }, "cancel");
    hold.suffix = `${initial.uploadId}.part`;
    hold.release = null;
    const writing = f.resources.write(initial.uploadId, chunks(body));
    const entered = new Promise<void>((resolve, reject) => {
      hold.entered = resolve;
      writing.catch((error: unknown) => reject(error));
    });
    await entered;
    expect(f.resources.cancel(initial.uploadId).state).toBe("cancelled");
    expect(f.resources.status(initial.uploadId)).toMatchObject({
      state: "cancelled",
      receivedBytes: 0,
    });
    hold.release?.();
    await expect(writing).rejects.toMatchObject({ code: "upload_cancelled" });
    await f.resources.drainCleanup();
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(f.store.paths.uploads, `${initial.uploadId}.part`))).toBe(false);
    expect(readUploadRow(f.store, initial.uploadId)?.finalizeSha).toBeNull();
    expect(
      (f.store.prepare("SELECT COUNT(*) AS n FROM resource").get() as { n: number }).n,
    ).toBe(0);
  });
});

const childSource = (worker: string) => `
import { createHash } from "node:crypto";
import { writeSync, readFileSync } from "node:fs";
import { EngineStore } from ${JSON.stringify(pathToFileURL(join(distStore, "store.js")).href)};
import { BlobFiles } from ${JSON.stringify(pathToFileURL(join(distStore, "blob-files.js")).href)};
import { Obligations } from ${JSON.stringify(pathToFileURL(join(distStore, "obligations.js")).href)};
import { SqlResourceStore } from ${JSON.stringify(pathToFileURL(join(distStore, "resources.js")).href)};

const say = (line) => writeSync(1, line + "\\n");
const [daemonDir, mode] = process.argv.slice(2);
const store = await EngineStore.open({
  daemonDir,
  workerEntry: ${JSON.stringify(worker)},
});
const resources = new SqlResourceStore(store, new BlobFiles(store), new Obligations(store));
const body = Buffer.from("abcdefgh");
const status = resources.create({
  kind: "file",
  mime: "application/json",
  name: "request.json",
  sizeBytes: body.length,
}, "kill");
say("ID " + status.uploadId);
async function* chunks() {
  yield body.subarray(0, 4);
  if (mode === "mid") {
    say("MID");
    await new Promise(() => {});
  }
  yield body.subarray(4);
}
const finished = await resources.write(status.uploadId, chunks());
const part = readFileSync(daemonDir + "/resource-store/uploads/" + status.uploadId + ".part");
say("DONE " + finished.receivedBytes + " " + createHash("sha256").update(part).digest("hex"));
await new Promise(() => {});
`;

interface KilledUpload {
  uploadId: string;
  daemonDir: string;
  done: { receivedBytes: number; sha256: string } | undefined;
}

function driveKill(mode: "mid" | "done"): {
  result: Promise<KilledUpload>;
  child: ChildProcess;
} {
  const parent = freshRoot("cx-upload-kill-");
  const daemonDir = join(parent, "daemon");
  const script = join(parent, "child.mjs");
  writeFileSync(script, childSource(join(distStore, "flusher-worker.js")));
  const child = spawn(process.execPath, [script, daemonDir, mode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let buffered = "";
  let uploadId = "";
  let done: KilledUpload["done"];
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const result = new Promise<KilledUpload>((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    child.stdout!.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("ID ")) uploadId = line.slice(3);
        if (line === "MID" || line.startsWith("DONE ")) {
          if (line.startsWith("DONE ")) {
            const [, bytes, sha256] = line.split(" ");
            done = { receivedBytes: Number(bytes), sha256: sha256 ?? "" };
          }
          child.kill("SIGKILL");
        }
      }
    });
    child.once("exit", (code, signal) => {
      if (signal === "SIGKILL" && uploadId)
        resolve({ uploadId, daemonDir, done });
      else fail(new Error(`child exited early (code ${code}, signal ${signal}): ${stderr}`));
    });
  });
  return { result, child };
}

describeStore("an interrupted upload restarts from byte zero", () => {
  it("kill during the PUT reopens the upload at byte zero", async () => {
    const { existsSync } = await import("node:fs");
    if (!existsSync(join(distStore, "store.js")))
      throw new Error("run pnpm build before the upload durability tests");
    const killed = await driveKill("mid").result;
    const reopened = await resourceFixture(join(killed.daemonDir, ".."));
    fixtures.push(reopened);
    expect(reopened.resources.status(killed.uploadId)).toMatchObject({
      state: "open",
      receivedBytes: 0,
    });
  });

  it("kill after the finish receipt keeps the part and its hash", async () => {
    const { existsSync } = await import("node:fs");
    if (!existsSync(join(distStore, "store.js")))
      throw new Error("run pnpm build before the upload durability tests");
    const killed = await driveKill("done").result;
    expect(killed.done?.receivedBytes).toBe(8);
    const reopened = await resourceFixture(join(killed.daemonDir, ".."));
    fixtures.push(reopened);
    expect(reopened.resources.status(killed.uploadId)).toMatchObject({
      state: "uploaded",
      receivedBytes: 8,
    });
    const part = readFileSync(
      join(reopened.store.paths.uploads, `${killed.uploadId}.part`),
    );
    expect(createHash("sha256").update(part).digest("hex")).toBe(killed.done?.sha256);
    expect(part).toEqual(Buffer.from("abcdefgh"));
  });
});

describe("libuv pool under four blocked upload writes", () => {
  it("keeps the request loop ticking and records dns.lookup time", async () => {
    const dir = freshRoot("cx-upload-pool-");
    const paths = [0, 1, 2, 3].map((index) => join(dir, `part-${index}`));
    const fifos = paths.map((path) => `${path}.fifo`);
    for (const path of paths) writeFileSync(path, Buffer.alloc(0));
    await new Promise<void>((resolve, reject) => {
      const maker = spawn("/usr/bin/mkfifo", fifos);
      maker.once("error", reject);
      maker.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`mkfifo exited ${code}`)),
      );
    });
    paths.forEach((path, index) => hold.blockOn.set(path, fifos[index]!));
    const holders: ChildProcess[] = [];
    const ready: Array<Promise<void>> = [];
    for (const fifo of fifos) {
      const holder = spawn(
        "/usr/bin/python3",
        [
          "-c",
          "import os,sys\nfd=os.open(sys.argv[1], os.O_WRONLY)\nsys.stdout.buffer.write(b'ready\\n'); sys.stdout.buffer.flush()\nsys.stdin.buffer.read(1)\nos.write(fd, b'x')\nos.close(fd)\n",
          fifo,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      holders.push(holder);
      children.push(holder);
      ready.push(
        new Promise<void>((resolve, reject) => {
          let text = "";
          holder.stdout!.on("data", (chunk: Buffer) => {
            text += chunk.toString("utf8");
            if (text.includes("ready")) resolve();
          });
          holder.once("exit", (code) => {
            if (!text.includes("ready")) reject(new Error(`fifo holder ${fifo} exited ${code}`));
          });
        }),
      );
    }
    const payload = Buffer.alloc(64, 7);
    const writes = paths.map((path) => {
      let settled = false;
      const done = writeExternalIncremental(
        path,
        (async function* () {
          yield payload;
        })(),
      ).finally(() => {
        settled = true;
      });
      return { done, settled: () => settled };
    });
    const releaseHolders = (): void => {
      for (const holder of holders) {
        try {
          holder.stdin?.write("\n");
        } catch {
          /* already gone */
        }
      }
    };
    try {
      await Promise.race([
        Promise.all(ready),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("fifo holders did not open")), 5_000),
        ),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(writes.every((write) => write.settled() === false)).toBe(true);
      const histogram = monitorEventLoopDelay({ resolution: 10 });
      histogram.enable();
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 10);
      const dnsStarted = performance.now();
      const dnsOutcome = await Promise.race([
        lookup("localhost").then(() => "ok" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 400)),
      ]);
      const dnsMs = performance.now() - dnsStarted;
      await new Promise((resolve) => setTimeout(resolve, 150));
      clearInterval(timer);
      histogram.disable();
      const probe = {
        ticks,
        dnsMs: Math.round(dnsMs),
        dnsOutcome,
        loopMeanMs: Math.round(histogram.mean / 1e6),
        loopMaxMs: Math.round(histogram.max / 1e6),
        uv: process.env.UV_THREADPOOL_SIZE ?? null,
      };
      process.stdout.write(`UPLOAD_POOL_PROBE ${JSON.stringify(probe)}\n`);
      expect(ticks).toBeGreaterThan(8);
    } finally {
      releaseHolders();
      await Promise.allSettled(writes.map((write) => write.done));
      for (const holder of holders) {
        if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
      }
    }
  });
});
