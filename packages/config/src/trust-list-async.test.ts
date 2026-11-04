import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listTrustConfigs } from "./index.js";

const hold = vi.hoisted(() => ({
  arm: false,
  release: null as null | (() => void),
  entered: null as null | (() => void),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (hold.arm) {
        hold.entered?.();
        await new Promise<void>((resolve) => {
          hold.release = resolve;
        });
      }
      return actual.readdir(...args);
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  hold.release?.();
  hold.arm = false;
  hold.release = null;
  hold.entered = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("trust enumeration leaves the request thread", () => {
  it("stays pending while the directory read is in the pool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-trust-list-"));
    dirs.push(dir);
    mkdirSync(join(dir, "trust"));
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    hold.arm = true;
    const entered = new Promise<void>((resolve) => {
      hold.entered = resolve;
    });
    let settled = false;
    const listing = listTrustConfigs().finally(() => {
      settled = true;
    });
    await entered;
    expect(settled).toBe(false);
    hold.release?.();
    await expect(listing).resolves.toEqual([]);
  });
});
