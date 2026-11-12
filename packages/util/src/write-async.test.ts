import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const { processTiming, writeText, writeTextAsync } = await import("./index.js");

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
});
