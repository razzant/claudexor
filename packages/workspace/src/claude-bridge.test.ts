import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_BRIDGE_CONTENT,
  CLAUDE_BRIDGE_MARKER,
  ensureClaudeBridge,
} from "./claude-bridge.js";

describe("ensureClaudeBridge (D-14 layer 3)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-claude-bridge-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing when there is no AGENTS.md", () => {
    const res = ensureClaudeBridge(dir);
    expect(res.created).toBe(false);
    expect(res.reason).toBe("no_agents");
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  });

  it("creates a thin @AGENTS.md import + ownership marker when AGENTS.md exists", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# instructions\n");
    const res = ensureClaudeBridge(dir);
    expect(res.created).toBe(true);
    expect(res.reason).toBe("created");
    const body = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(body).toBe(CLAUDE_BRIDGE_CONTENT);
    expect(body).toContain("@AGENTS.md");
    expect(body).toContain(CLAUDE_BRIDGE_MARKER);
    // Exactly one @-import line so the file stays a pure bridge.
    expect(body.split("\n").filter((l) => l.startsWith("@AGENTS.md"))).toHaveLength(1);
  });

  it("is idempotent: a second run sees the file and does nothing (no overwrite)", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# instructions\n");
    expect(ensureClaudeBridge(dir).created).toBe(true);
    const first = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    const second = ensureClaudeBridge(dir);
    expect(second.created).toBe(false);
    expect(second.reason).toBe("claude_exists");
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(first);
  });

  it("NEVER overwrites a hand-written CLAUDE.md", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# a\n");
    writeFileSync(join(dir, "CLAUDE.md"), "# my own instructions\n");
    const res = ensureClaudeBridge(dir);
    expect(res.created).toBe(false);
    expect(res.reason).toBe("claude_exists");
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("# my own instructions\n");
  });

  it("refuses to follow a symlink at CLAUDE.md (no-follow), even a dangling one", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# a\n");
    const target = join(dir, "secret-elsewhere.md");
    symlinkSync(target, join(dir, "CLAUDE.md")); // dangling: target does not exist
    const res = ensureClaudeBridge(dir);
    expect(res.created).toBe(false);
    expect(res.reason).toBe("claude_exists");
    // The symlink target was never created through the link.
    expect(existsSync(target)).toBe(false);
  });

  it("two concurrent preps yield exactly one file, one created=true, and a typed refusal for the loser", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "# a\n");
    const results = await Promise.all([
      Promise.resolve().then(() => ensureClaudeBridge(dir)),
      Promise.resolve().then(() => ensureClaudeBridge(dir)),
    ]);
    const created = results.filter((r) => r.created);
    expect(created).toHaveLength(1);
    expect(created[0]?.reason).toBe("created");
    const losers = results.filter((r) => !r.created);
    expect(losers).toHaveLength(1);
    // The loser reports a TYPED refusal, never a create or a throw.
    expect(["race_lost", "claude_exists"]).toContain(losers[0]?.reason);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(CLAUDE_BRIDGE_CONTENT);
  });
});
