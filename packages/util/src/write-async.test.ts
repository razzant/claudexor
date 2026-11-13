import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Count util's own filesystem calls (it imports both modules by name).
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(actual.mkdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const patched = { mkdir: vi.fn(actual.mkdir), writeFile: vi.fn(actual.writeFile) };
  return { ...actual, ...patched, default: { ...actual, ...patched } };
});
const { processTiming, withPoolWriteSlot, writeText, writeTextAsync } = await import("./index.js");

const root = mkdtempSync(join(tmpdir(), "claudexor-write-text-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

beforeEach(() => {
  for (const spy of [fs.mkdirSync, fs.writeFileSync, fsp.mkdir, fsp.writeFile])
    vi.mocked(spy).mockClear();
});

describe("writeText (#688)", () => {
  it("creates a missing directory once, then writes without mkdir, and labels each write", () => {
    const recorded = vi.spyOn(processTiming, "recordSync");
    const dir = join(root, "sync", "nested");
    writeText(join(dir, "first.md"), "first\n");
    expect(fs.mkdirSync).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i += 1) writeText(join(dir, `file-${i}.md`), `body ${i}\n`);
    // Steady state: one write per file, no further mkdir.
    expect(fs.mkdirSync).toHaveBeenCalledTimes(1);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(22); // the first file's refused try + 21
    expect(readFileSync(join(dir, "file-19.md"), "utf8")).toBe("body 19\n");
    expect(statSync(join(dir, "first.md")).mode & 0o777).toBe(0o600);
    // The deliberately synchronous write names itself in worstSync.
    expect(recorded.mock.calls.filter(([op]) => op === "file.write_text")).toHaveLength(21);
    recorded.mockRestore();
  });

  it("still fails loudly when the parent is not a directory", () => {
    const file = join(root, "plain-file");
    writeText(file, "x");
    expect(() => writeText(join(file, "child.md"), "y")).toThrow(/ENOTDIR/);
  });
});

describe("writeTextAsync (#688)", () => {
  it("awaits the write off the main thread, creating a missing directory only once", async () => {
    const dir = join(root, "async", "nested");
    await writeTextAsync(join(dir, "first.md"), "first\n");
    expect(fsp.mkdir).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i += 1) await writeTextAsync(join(dir, `file-${i}.md`), `body ${i}\n`);
    expect(fsp.mkdir).toHaveBeenCalledTimes(1);
    expect(fsp.writeFile).toHaveBeenCalledTimes(22); // the first file's refused try + 21
    // Nothing waited on the disk synchronously.
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "file-19.md"), "utf8")).toBe("body 19\n");
    expect(statSync(join(dir, "first.md")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("still rejects when the parent is not a directory", async () => {
    const file = join(root, "plain-file-async");
    await writeTextAsync(file, "x");
    await expect(writeTextAsync(join(file, "child.md"), "y")).rejects.toThrow(/ENOTDIR/);
  });

  it("replaces a file whole, so a reader sees the old text or the new one, and keeps its mode (#704)", async () => {
    const path = join(root, "replace", "summary.md");
    await writeTextAsync(path, "old text\n");
    chmodSync(path, 0o640);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let midway: string | null = null;
    vi.mocked(fsp.writeFile).mockImplementationOnce(async (file, data, options) => {
      // The new text is half written where the write goes; a reader looks now.
      await actual.writeFile(file, String(data).slice(0, 4), options as never);
      midway = readFileSync(path, "utf8");
      await actual.writeFile(file, data, options as never);
    });
    await writeTextAsync(path, "new text\n");
    // Direction 1: the file read whole and unchanged while the new text was written.
    expect(midway).toBe("old text\n");
    // Direction 2: the new text replaced it whole (a rename over the existing
    // file), with the file's own mode, and no temporary sibling is left.
    expect(readFileSync(path, "utf8")).toBe("new text\n");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(dirname(path))).toEqual(["summary.md"]);
  });
});

describe("writeTextAsync under the pool write gate (#688)", () => {
  it("waits for a write slot while the gate is full, and writes once one is released", async () => {
    const applied = Symbol.for("claudexor.libuvPoolSize");
    const global = globalThis as Record<symbol, unknown>;
    const saved = global[applied];
    global[applied] = 3; // a pool of three leaves one write slot
    try {
      let release!: () => void;
      const holder = withPoolWriteSlot(
        undefined,
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      const path = join(root, "gated", "file.md");
      const write = writeTextAsync(path, "gated\n");
      for (let turn = 0; turn < 20; turn += 1) await new Promise((r) => setImmediate(r));
      // Direction 1: while another write holds the only slot, nothing reached the disk.
      expect(fsp.writeFile).not.toHaveBeenCalled();
      expect(fsp.mkdir).not.toHaveBeenCalled();
      expect(existsSync(path)).toBe(false);
      release();
      await holder;
      await write;
      // Direction 2: released, the write ran, its directory made on the way, each in its own slot.
      expect(readFileSync(path, "utf8")).toBe("gated\n");
      expect(fsp.mkdir).toHaveBeenCalledTimes(1);
      expect(fsp.writeFile).toHaveBeenCalledTimes(2);
    } finally {
      if (saved === undefined) delete global[applied];
      else global[applied] = saved;
    }
  });
});
