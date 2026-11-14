import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

// NIT1: deterministically exercise the EEXIST -> race_lost branch of
// ensureClaudeBridge. In production the no-follow `lstat` check sees a FREE path
// (ENOENT), and only then a CONCURRENT prep wins the exclusive `O_CREAT|O_EXCL`
// create — so THIS caller's open fails EEXIST and it must report `race_lost`
// without overwriting. The window between the two awaited calls is not under
// the test's control, so we mock `node:fs/promises.lstat` to report the path
// free EXACTLY ONCE while the file already exists on disk; the real
// `open(..., "wx")` then rejects with the real EEXIST.
const state = vi.hoisted(() => ({ reportFreeOnce: false }));

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  const lstat = (path: Parameters<typeof actual.lstat>[0], ...rest: unknown[]) => {
    if (state.reportFreeOnce && String(path).endsWith("CLAUDE.md")) {
      state.reportFreeOnce = false;
      return Promise.reject(
        Object.assign(new Error("ENOENT: simulated free path (race)"), { code: "ENOENT" }),
      );
    }
    return (actual.lstat as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
  };
  return { ...actual, default: { ...actual, lstat }, lstat };
});

// Imported AFTER the mock declaration; vi.mock is hoisted so claude-bridge's
// named `lstat` binding resolves to the mocked module (open stays real).
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
const { ensureClaudeBridge } = await import("./claude-bridge.js");

describe("ensureClaudeBridge EEXIST race_lost branch (NIT1)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-claude-bridge-race-"));
    state.reportFreeOnce = false;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }), 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  it("returns race_lost and never overwrites when the exclusive create loses the race", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "# a\n");
    const handWritten = "# hand-written, must survive\n";
    writeFileSync(join(dir, "CLAUDE.md"), handWritten);

    state.reportFreeOnce = true; // the free-path check is fooled exactly once
    const res = await ensureClaudeBridge(dir);

    expect(res.created).toBe(false);
    expect(res.reason).toBe("race_lost");
    // The pre-existing bytes were NOT clobbered by the exclusive create.
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(handWritten);
  });
});
