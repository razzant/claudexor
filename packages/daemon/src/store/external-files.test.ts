import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processTiming } from "@claudexor/util";
import { EngineStore } from "./store.js";
import {
  ensureDirectory,
  externalWriteFlags,
  linkExternalFile,
  stageExternalFile,
  unlinkExternalFile,
  writeExternalFile,
  type ExternalRegistry,
} from "./external-files.js";

/** The store runs only where `node:sqlite` exists; elsewhere these cases are skipped, not failed. */
const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;

const openSpy = vi.hoisted(() => vi.fn());
/** The pool-side write: its open flags, and a gate that holds its data write. */
const pool = vi.hoisted(() => ({
  flags: [] as number[],
  hold: null as Promise<void> | null,
  entered: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = async (...args: Parameters<typeof actual.open>) => {
    pool.flags.push(Number(args[1]));
    const handle = await actual.open(...args);
    const write = handle.write.bind(handle) as (...input: unknown[]) => Promise<unknown>;
    return Object.assign(handle, {
      write: async (...input: unknown[]) => {
        pool.entered = true;
        if (pool.hold) await pool.hold;
        return write(...input);
      },
    });
  };
  return { ...actual, open, default: { ...actual, open } };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = (...args: Parameters<typeof actual.openSync>) => {
    openSpy(...args);
    return actual.openSync(...args);
  };
  return { ...actual, openSync, default: { ...actual, openSync } };
});

let root: string;
let registered: string[];
const registry: ExternalRegistry = {
  registerExternal: (dir) => {
    registered.push(dir);
    return registered.length;
  },
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-external-"));
  registered = [];
  openSpy.mockClear();
  Object.assign(pool, { flags: [], hold: null, entered: false });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describeStore("external files (SYNTHESIS_R5 §4.4)", () => {
  it("translates the Windows write-through bit without relying on POSIX flag exports", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...original, value: "win32" });
    try {
      // Pure flag translation only; the file-writing test exercises the actual
      // host path, including in the native Windows CI lane.
      const flags = externalWriteFlags(2);
      expect(flags & 0x04000000).toBe(0x04000000); // libuv UV_FS_O_DSYNC
      expect(flags & 2).toBe(2); // preserve the caller's read/write access
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it("writes through an O_DSYNC temp, renames, registers the directory, leaves no temp", async () => {
    const { constants } = await import("node:fs");
    const dir = join(root, "final");
    const receipt = writeExternalFile(registry, {
      dir,
      name: "run_facts.yaml",
      bytes: Buffer.from("facts"),
      purpose: "terminal_receipt",
    });
    expect(receipt).toEqual({ path: join(dir, "run_facts.yaml"), generation: 2, written: true });
    expect(readFileSync(receipt.path, "utf8")).toBe("facts");
    expect(readdirSync(dir)).toEqual(["run_facts.yaml"]);
    // The directory was created, so its parent was registered first; then the directory itself.
    expect(registered).toEqual([root, dir]);
    const tempOpen = openSpy.mock.calls.find(([path]) => String(path).endsWith(".tmp"));
    expect(tempOpen, "temp file opened").toBeDefined();
    const flags = Number(tempOpen![1]);
    const sync = process.platform === "win32" ? 0x04000000 : constants.O_DSYNC;
    expect(flags & sync).toBe(sync);
    expect(flags & constants.O_EXCL).toBe(constants.O_EXCL);
    if (constants.O_NOFOLLOW !== undefined)
      expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  });

  it("replaces by default and keeps an existing content-addressed file", () => {
    const dir = join(root, "blobs");
    const body = (text: string) => ({ dir, name: "abc", bytes: Buffer.from(text) });
    const first = writeExternalFile(registry, { ...body("one"), purpose: "blob_body" });
    const before = statSync(first.path);
    const replaced = writeExternalFile(registry, { ...body("two"), purpose: "blob_body" });
    expect(replaced.written).toBe(true);
    expect(readFileSync(replaced.path, "utf8")).toBe("two");
    const kept = writeExternalFile(registry, {
      ...body("three"),
      keepExisting: true,
      purpose: "blob_body",
    });
    expect(kept.written).toBe(false);
    expect(readFileSync(kept.path, "utf8")).toBe("two");
    expect(statSync(kept.path).ino).toBe(statSync(replaced.path).ino);
    expect(before.ino).not.toBe(statSync(kept.path).ino);
    expect(readdirSync(dir)).toEqual(["abc"]);
  });

  it("links a source into place once and reports an existing target", () => {
    const parts = join(root, "uploads");
    const blobs = join(root, "blobs");
    const part = writeExternalFile(registry, {
      dir: parts,
      name: "u1.part",
      bytes: Buffer.from("bytes"),
      purpose: "blob_body",
    });
    const linked = linkExternalFile(registry, { source: part.path, dir: blobs, name: "sha" });
    expect(linked.written).toBe(true);
    expect(statSync(linked.path).nlink).toBe(2);
    const again = linkExternalFile(registry, { source: part.path, dir: blobs, name: "sha" });
    expect(again.written).toBe(false);
    expect(registered.at(-1)).toBe(blobs);
    const g = unlinkExternalFile(registry, part.path);
    expect(existsSync(part.path)).toBe(false);
    expect(registered[g - 1]).toBe(parts);
    expect(unlinkExternalFile(registry, part.path)).toBe(g + 1);
  });

  it("names the purpose, size and phase split of a write that enters the worst sections", () => {
    const retained = vi.spyOn(processTiming, "recordSync").mockReturnValue(true);
    const lines: string[] = [];
    const logging: ExternalRegistry = { ...registry, logSlowWrite: (line) => lines.push(line) };
    const bytes = Buffer.alloc(70_000, 7);
    writeExternalFile(logging, {
      dir: join(root, "blobs"),
      name: "d1",
      bytes,
      purpose: "blob_body",
    });
    writeExternalFile(logging, {
      dir: join(root, "blobs"),
      name: "d1",
      bytes,
      keepExisting: true,
      purpose: "blob_body",
    });
    expect(retained.mock.calls.map(([operation]) => operation)).toEqual([
      "store.external_write",
      "store.external_write",
    ]);
    const [written, kept] = lines.map((line) => {
      expect(line.startsWith("store.external_write {")).toBe(true);
      return JSON.parse(line.slice("store.external_write ".length)) as Record<string, unknown>;
    });
    expect(written).toMatchObject({ purpose: "blob_body", bytes: 70_000, written: true });
    for (const phase of ["metadata_before_ms", "data_write_ms", "metadata_publish_ms", "total_ms"])
      expect(written![phase]).toBeTypeOf("number");
    // The content-addressed fast path never opened a file: all of it is metadata.
    expect(kept).toMatchObject({ written: false, data_write_ms: 0, metadata_publish_ms: 0 });
  });

  it("logs nothing for a write outside the worst sections", () => {
    vi.spyOn(processTiming, "recordSync").mockReturnValue(false);
    const lines: string[] = [];
    writeExternalFile(
      { ...registry, logSlowWrite: (line) => lines.push(line) },
      {
        dir: join(root, "final"),
        name: "run_facts.yaml",
        bytes: Buffer.from("f"),
        purpose: "terminal_receipt",
      },
    );
    expect(lines).toEqual([]);
  });

  it("routes a slow write's line to the store's daemon log", async () => {
    vi.spyOn(processTiming, "recordSync").mockReturnValue(true);
    const log = vi.fn();
    const store = await EngineStore.open({
      daemonDir: join(root, "daemon"),
      workerEntry: join(import.meta.dirname, "../../dist/store/flusher-worker.js"),
      log,
    });
    try {
      writeExternalFile(store, {
        dir: join(root, "daemon", "final"),
        name: "telemetry.yaml",
        bytes: Buffer.from("t"),
        purpose: "terminal_receipt",
      });
    } finally {
      await store.close();
    }
    expect(log.mock.calls.map(([line]) => String(line))).toContainEqual(
      expect.stringContaining('"purpose":"terminal_receipt"'),
    );
  });

  it("stages a body on the pool with the same write-through flags and publishes it once", async () => {
    const { constants } = await import("node:fs");
    const dir = join(root, "blobs");
    mkdirSync(dir);
    const bytes = Buffer.alloc(70_000, 3);
    const published = await Promise.all([
      stageExternalFile({ dir, name: "sha", bytes }),
      stageExternalFile({ dir, name: "sha", bytes }),
    ]);
    expect(published.filter(Boolean)).toHaveLength(1);
    expect(readFileSync(join(dir, "sha")).equals(bytes)).toBe(true);
    // An existing content-addressed target is never rewritten, and no temp stays.
    expect(await stageExternalFile({ dir, name: "sha", bytes: Buffer.from("other") })).toBe(false);
    expect(readFileSync(join(dir, "sha")).equals(bytes)).toBe(true);
    expect(readdirSync(dir)).toEqual(["sha"]);
    const sync = process.platform === "win32" ? 0x04000000 : constants.O_DSYNC;
    expect(pool.flags.length).toBeGreaterThan(0);
    for (const flags of pool.flags) expect(flags & sync).toBe(sync);
    // The request thread opened nothing and nothing was registered.
    expect(openSpy).not.toHaveBeenCalled();
    expect(registered).toEqual([]);
  });

  it("keeps the request thread serving timers while a staged write waits on the drive", async () => {
    const dir = join(root, "blobs");
    mkdirSync(dir);
    let release!: () => void;
    pool.hold = new Promise((resolve) => {
      release = resolve;
    });
    const staging = stageExternalFile({ dir, name: "slow", bytes: Buffer.alloc(70_000, 5) });
    try {
      await vi.waitFor(() => expect(pool.entered).toBe(true));
      // A real timer must run while the write is held. Its throughput is not
      // the contract: Windows and loaded hosts need not fit four ticks in 60 ms.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(existsSync(join(dir, "slow"))).toBe(false);
      release();
      expect(await staging).toBe(true);
    } finally {
      release();
      await staging;
    }
  });

  it("ensureDirectory registers only when it created something", () => {
    const dir = join(root, "a", "b");
    ensureDirectory(registry, dir);
    expect(registered).toEqual([join(root, "a")]);
    ensureDirectory(registry, dir);
    expect(registered).toEqual([join(root, "a")]);
  });
});
