import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readContinuationSources, writeContinuationSources } from "./continuation-sources.js";
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), fsyncSync: vi.fn(actual.fsyncSync) };
});
const roots: string[] = [];
afterEach(() => {
  vi.mocked(fs.renameSync).mockReset();
  vi.mocked(fs.fsyncSync).mockReset();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "continuation-sources-"));
  roots.push(root);
  return root;
}
it("publishes a flushed continuation list atomically and preserves the prior list on failure", () => {
  const root = fixture();
  const before = [{ runId: "prior", runDir: join(root, "prior"), state: "failed" }];
  const after = [{ runId: "next", runDir: join(root, "next"), state: "failed" }];
  writeContinuationSources(root, before);
  const file = join(root, "context", "continuation.json");
  const rename = vi.mocked(fs.renameSync);
  const original = rename.getMockImplementation()!;
  vi.mocked(fs.fsyncSync).mockClear();
  rename.mockImplementationOnce(() => {
    throw new Error("publication failed");
  });
  expect(() => writeContinuationSources(root, after)).toThrow("publication failed");
  expect(readContinuationSources(root, { strict: true })).toEqual(before);
  rename.mockImplementationOnce((temp, target) => {
    expect(target).toBe(file);
    expect(temp).not.toBe(file);
    expect(fs.fsyncSync).toHaveBeenCalled();
    expect(readContinuationSources(root, { strict: true })).toEqual(before);
    original(temp, target);
  });
  writeContinuationSources(root, after);
  expect(readContinuationSources(root, { strict: true })).toEqual(after);
  expect(fs.readdirSync(join(root, "context"))).toEqual(["continuation.json"]);
});
it("names unreadable continuation evidence while treating an absent list as normal", () => {
  const root = fixture();
  expect(readContinuationSources(root, { strict: true })).toEqual([]);
  const file = join(root, "context", "continuation.json");
  fs.mkdirSync(join(root, "context"));
  fs.writeFileSync(file, "torn");
  expect(() => readContinuationSources(root, { strict: true })).toThrow(file);
});
