import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Count the util module's own filesystem calls (it imports node:fs by name).
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(actual.mkdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});
const { appendLine } = await import("./index.js");

const root = mkdtempSync(join(tmpdir(), "claudexor-append-line-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("appendLine", () => {
  it("appends in order through the UTF-8 write, creating a missing directory once", () => {
    const mkdir = vi.mocked(fs.mkdirSync);
    const write = vi.mocked(fs.writeFileSync);
    mkdir.mockClear();
    write.mockClear();
    const path = join(root, "nested", "deeper", "events.jsonl");
    appendLine(path, '{"seq":1}');
    expect(mkdir).toHaveBeenCalledTimes(1);
    for (let seq = 2; seq <= 50; seq += 1) appendLine(path, `{"seq":${seq},"text":"ж"}\n`);
    // Steady state: one write per line, never another mkdir.
    expect(mkdir).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(51); // the first line's refused try + 50 appends
    for (const call of write.mock.calls) {
      expect(call[2]).toEqual({ flag: "a", mode: 0o600, encoding: "utf8" });
    }
    const lines = readFileSync(path, "utf8").split("\n");
    expect(lines).toHaveLength(51);
    expect(lines[0]).toBe('{"seq":1}');
    expect(lines[49]).toBe('{"seq":50,"text":"ж"}');
    expect(lines[50]).toBe("");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("still fails loudly when the path cannot be appended", () => {
    const file = join(root, "plain-file");
    appendLine(file, "x");
    expect(() => appendLine(join(file, "child.jsonl"), "y")).toThrow(/ENOTDIR/);
  });
});
