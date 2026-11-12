import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeExternalIncremental } from "./external-files.js";
import {
  createUploadWriteGate,
  libuvPoolSize,
  libuvPoolSizeFrom,
  uploadWriteSlots,
} from "./libuv-pool.js";

const roots: string[] = [];

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("libuv pool size", () => {
  it("keeps the operator value inside libuv's range and uses 4 when unset", () => {
    expect(libuvPoolSizeFrom(undefined)).toBe(4);
    expect(libuvPoolSizeFrom("")).toBe(4);
    expect(libuvPoolSizeFrom("0")).toBe(1);
    expect(libuvPoolSizeFrom("nope")).toBe(1);
    expect(libuvPoolSizeFrom("8")).toBe(8);
    expect(libuvPoolSizeFrom("5000")).toBe(1024);
  });

  it("uses the size the daemon entry applied after it removed the variable", () => {
    const key = Symbol.for("claudexor.libuvPoolSize");
    const global = globalThis as Record<symbol, unknown>;
    const savedEnv = process.env.UV_THREADPOOL_SIZE;
    const savedApplied = global[key];
    try {
      delete process.env.UV_THREADPOOL_SIZE;
      global[key] = 22;
      expect(libuvPoolSize()).toBe(22);
      expect(uploadWriteSlots()).toBe(20);
      delete global[key];
      expect(libuvPoolSize()).toBe(4);
      process.env.UV_THREADPOOL_SIZE = "6";
      expect(uploadWriteSlots()).toBe(4);
    } finally {
      if (savedEnv === undefined) delete process.env.UV_THREADPOOL_SIZE;
      else process.env.UV_THREADPOOL_SIZE = savedEnv;
      if (savedApplied === undefined) delete global[key];
      else global[key] = savedApplied;
    }
  });
});

describe("upload write gate", () => {
  it("lets the next waiter through when a holder releases, in arrival order", async () => {
    const gate = createUploadWriteGate(() => 1);
    const releaseA = await gate.acquire();
    const order: string[] = [];
    const pendingB = gate.acquire().then((release) => {
      order.push("b");
      return release;
    });
    const pendingC = gate.acquire().then((release) => {
      order.push("c");
      return release;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual([]);
    releaseA();
    const releaseB = await pendingB;
    expect(order).toEqual(["b"]);
    releaseB();
    const releaseC = await pendingC;
    expect(order).toEqual(["b", "c"]);
    releaseC();
    releaseC();
  });

  it("rejects a waiter when cancellation wakes it, then accepts a later writer", async () => {
    const gate = createUploadWriteGate(() => 1);
    const releaseA = await gate.acquire();
    let stop = false;
    const pending = gate.acquire(() => {
      if (stop) throw Object.assign(new Error("cancelled"), { code: "upload_cancelled" });
    });
    await new Promise((resolve) => setImmediate(resolve));
    stop = true;
    gate.wake();
    await expect(pending).rejects.toMatchObject({ code: "upload_cancelled" });
    releaseA();
    const releaseC = await gate.acquire();
    releaseC();
  });
});

describe("incremental upload slot", () => {
  it("releases the slot when the open fails, so a later write still finishes", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-upload-slot-")));
    roots.push(root);
    const slots = uploadWriteSlots();
    for (let index = 0; index < slots; index += 1) {
      await expect(
        writeExternalIncremental(join(root, "missing", `part-${index}`), (async function* () {})()),
      ).rejects.toThrow();
    }
    const path = join(root, "ok");
    writeFileSync(path, Buffer.alloc(0));
    const received = await Promise.race([
      writeExternalIncremental(
        path,
        (async function* () {
          yield Buffer.from("xy");
        })(),
      ),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("upload write slot was not released")), 1_000),
      ),
    ]);
    expect(received).toBe(2);
    expect(readFileSync(path)).toEqual(Buffer.from("xy"));
  });
});
