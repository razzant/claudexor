import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fsyncDirectoryAsync } from "./index.js";

const flush = vi.hoisted(() => ({ refuse: false, closed: 0 }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (flush.refuse)
        vi.spyOn(handle, "sync").mockRejectedValue(new Error("fixture flush refused"));
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        flush.closed++;
        await close();
      });
      return handle;
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  flush.refuse = false;
  flush.closed = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
it.each(["linux", "darwin", "win32"] as const)(
  "uses the shared %s durability rule and closes both successful and refused handles",
  async (platform) => {
    const root = mkdtempSync(join(tmpdir(), "async-directory-flush-"));
    roots.push(root);
    await expect(fsyncDirectoryAsync(root, platform)).resolves.toBeUndefined();
    flush.refuse = true;
    if (platform === "win32")
      await expect(fsyncDirectoryAsync(root, platform)).resolves.toBeUndefined();
    else await expect(fsyncDirectoryAsync(root, platform)).rejects.toThrow("fixture flush refused");
    expect(flush.closed).toBe(2);
  },
);
