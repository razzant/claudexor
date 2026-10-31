import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { noteCleanupFault, withDisposableScratch } from "./cleanup-fault.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

const fault = (outcome: unknown) => (outcome as { cleanupError?: { code?: string } }).cleanupError;

describe("a cleanup fault rides beside its outcome, never in its place", () => {
  it("a diagnostic that cannot be attached never replaces the outcome", () => {
    expect(() => noteCleanupFault(Object.freeze({ ok: true }), new Error("EACCES"))).not.toThrow();
    const outcome = {};
    noteCleanupFault(outcome, undefined);
    expect("cleanupError" in outcome).toBe(false);
    noteCleanupFault(outcome, "first");
    noteCleanupFault(outcome, "second");
    expect(fault(outcome)).toBe("first");
    expect(JSON.stringify(outcome)).toBe("{}");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a scratch that cannot be removed keeps the returned value and the thrown error",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "cx-cleanup-fault-"));
      roots.push(root);
      const allocate = (held: { dir: string | null }) => {
        held.dir = join(root, "scratch");
        mkdirSync(held.dir);
        writeFileSync(join(held.dir, "index"), "x");
        chmodSync(root, 0o500);
      };
      const returned = await withDisposableScratch(async (held) => {
        allocate(held);
        return { ok: true };
      });
      expect(returned).toEqual({ ok: true });
      expect(["EACCES", "EPERM", "ENOTEMPTY"]).toContain(fault(returned)?.code);
      chmodSync(root, 0o700);
      rmSync(join(root, "scratch"), { recursive: true });

      const primary = new Error("the operation's own failure");
      const thrown = await withDisposableScratch(async (held) => {
        allocate(held);
        throw primary;
      }).catch((error: unknown) => error);
      expect(thrown).toBe(primary);
      expect(fault(thrown)).toBeDefined();
    },
  );

  it("control: an allocated scratch is removed", async () => {
    let dir: string | null = null;
    await withDisposableScratch(async (held) => {
      held.dir = dir = mkdtempSync(join(tmpdir(), "cx-cleanup-fault-"));
    });
    expect(existsSync(dir!)).toBe(false);
  });
});
