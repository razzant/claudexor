import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

// NIT1: deterministically exercise the EEXIST -> race_lost branch of
// ensureClaudeBridge. In production the no-follow `lstat` check sees a FREE path
// (ENOENT), and only then a CONCURRENT prep wins the exclusive `O_CREAT|O_EXCL`
// create — so THIS caller's open fails EEXIST and it must report `race_lost`
// without overwriting. That mid-function window cannot be hit by microtask
// ordering (the function is synchronous), so we mock `node:fs.lstatSync` to
// report the path free EXACTLY ONCE while the file already exists on disk; the
// real `openSync(..., "wx")` then throws the real EEXIST.
const state = vi.hoisted(() => ({ reportFreeOnce: false }));

vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    lstatSync: (path: Parameters<typeof actual.lstatSync>[0], ...rest: unknown[]) => {
      if (state.reportFreeOnce && String(path).endsWith("CLAUDE.md")) {
        state.reportFreeOnce = false;
        throw Object.assign(new Error("ENOENT: simulated free path (race)"), { code: "ENOENT" });
      }
      return (actual.lstatSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

// Imported AFTER the mock declaration; vi.mock is hoisted so claude-bridge's
// named `lstatSync` binding resolves to the mocked module (openSync stays real).
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
const { ensureClaudeBridge } = await import("./claude-bridge.js");

describe("ensureClaudeBridge EEXIST race_lost branch (NIT1)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-claude-bridge-race-"));
    state.reportFreeOnce = false;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns race_lost and never overwrites when the exclusive create loses the race", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# a\n");
    const handWritten = "# hand-written, must survive\n";
    writeFileSync(join(dir, "CLAUDE.md"), handWritten);

    state.reportFreeOnce = true; // the free-path check is fooled exactly once
    const res = ensureClaudeBridge(dir);

    expect(res.created).toBe(false);
    expect(res.reason).toBe("race_lost");
    // The pre-existing bytes were NOT clobbered by the exclusive create.
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(handWritten);
  });
});
