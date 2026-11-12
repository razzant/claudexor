import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_BRIDGE_CONTENT,
  CLAUDE_BRIDGE_MARKER,
  CURRENT_CLAUDE_BRIDGE_GENERATION,
  LEGACY_CLAUDE_BRIDGE_CONTENT,
  bridgeCreatedMarkerGeneration,
  ensureClaudeBridge,
  isGeneratedClaudeBridge,
  writeBridgeCreatedMarker,
} from "./claude-bridge.js";

describe("ensureClaudeBridge (D-14 layer 3)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-claude-bridge-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  }, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

  it("does nothing when there is no AGENTS.md", async () => {
    const res = await ensureClaudeBridge(dir);
    expect(res.created).toBe(false);
    expect(res.reason).toBe("no_agents");
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  });

  it("creates a thin @AGENTS.md import + ownership marker when AGENTS.md exists", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "# instructions\n");
    const res = await ensureClaudeBridge(dir);
    expect(res.created).toBe(true);
    expect(res.reason).toBe("created");
    const body = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(body).toBe(CLAUDE_BRIDGE_CONTENT);
    expect(body).toContain("@AGENTS.md");
    expect(body).toContain(CLAUDE_BRIDGE_MARKER);
    // Exactly one @-import line so the file stays a pure bridge.
    expect(body.split("\n").filter((l) => l.startsWith("@AGENTS.md"))).toHaveLength(1);
  });

  it("is idempotent: a second run sees the file and does nothing (no overwrite)", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "# instructions\n");
    expect((await ensureClaudeBridge(dir)).created).toBe(true);
    const first = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    const second = await ensureClaudeBridge(dir);
    expect(second.created).toBe(false);
    expect(second.reason).toBe("claude_exists");
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(first);
  });

  it("NEVER overwrites a hand-written CLAUDE.md", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "# a\n");
    writeFileSync(join(dir, "CLAUDE.md"), "# my own instructions\n");
    const res = await ensureClaudeBridge(dir);
    expect(res.created).toBe(false);
    expect(res.reason).toBe("claude_exists");
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("# my own instructions\n");
  });

  it("refuses to follow a symlink at CLAUDE.md (no-follow), even a dangling one", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "# a\n");
    const target = join(dir, "secret-elsewhere.md");
    symlinkSync(target, join(dir, "CLAUDE.md")); // dangling: target does not exist
    const res = await ensureClaudeBridge(dir);
    expect(res.created).toBe(false);
    expect(res.reason).toBe("claude_exists");
    // The symlink target was never created through the link.
    expect(existsSync(target)).toBe(false);
  });

  it("two concurrent preps yield exactly one file, one created=true, and a typed refusal for the loser", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "# a\n");
    const results = await Promise.all([ensureClaudeBridge(dir), ensureClaudeBridge(dir)]);
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

describe("isGeneratedClaudeBridge (A-3: byte-equality, not marker substring)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-bridge-eq-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  }, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

  it("is true only for a byte-identical generated bridge", () => {
    writeFileSync(join(dir, "CLAUDE.md"), CLAUDE_BRIDGE_CONTENT);
    expect(isGeneratedClaudeBridge(dir)).toBe(true);
  });

  it("matches each generation's exact bytes and never the other's", () => {
    // A pristine bridge from before CX590 stays recognizable after an upgrade,
    // but only as the legacy generation: a rewrite between generations is an edit.
    writeFileSync(join(dir, "CLAUDE.md"), LEGACY_CLAUDE_BRIDGE_CONTENT);
    expect(isGeneratedClaudeBridge(dir, "legacy-v1")).toBe(true);
    expect(isGeneratedClaudeBridge(dir, "envelope-v1")).toBe(false);
    expect(isGeneratedClaudeBridge(dir)).toBe(false);
    writeFileSync(join(dir, "CLAUDE.md"), CLAUDE_BRIDGE_CONTENT);
    expect(isGeneratedClaudeBridge(dir, "legacy-v1")).toBe(false);
    expect(isGeneratedClaudeBridge(dir, "envelope-v1")).toBe(true);
  });

  it("is FALSE for a candidate edit that keeps the marker (the A-3 work-loss bug)", () => {
    // Substring-on-marker would call this "ours" and drop it; byte-equality does not.
    writeFileSync(join(dir, "CLAUDE.md"), CLAUDE_BRIDGE_CONTENT + "\n# candidate rules\n");
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toContain(CLAUDE_BRIDGE_MARKER);
    expect(isGeneratedClaudeBridge(dir)).toBe(false);
  });

  it("is false for a hand-written CLAUDE.md and when absent", () => {
    expect(isGeneratedClaudeBridge(dir)).toBe(false);
    writeFileSync(join(dir, "CLAUDE.md"), "# my own notes\n");
    expect(isGeneratedClaudeBridge(dir)).toBe(false);
  });

  it("is false for a symlink at CLAUDE.md (no-follow)", () => {
    writeFileSync(join(dir, "target.md"), CLAUDE_BRIDGE_CONTENT);
    symlinkSync(join(dir, "target.md"), join(dir, "CLAUDE.md"));
    expect(isGeneratedClaudeBridge(dir)).toBe(false);
  });
});

describe("bridgeCreatedMarkerGeneration (created-this-run fact names its bytes)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-bridge-marker-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  }, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

  const writeMarker = (marker: unknown) =>
    writeFileSync(join(dir, "bridge-created.json"), JSON.stringify(marker) + "\n");

  it("reads back the current generation the writer records", async () => {
    await writeBridgeCreatedMarker(dir, "env-1");
    expect(bridgeCreatedMarkerGeneration(dir, "env-1")).toBe(CURRENT_CLAUDE_BRIDGE_GENERATION);
    expect(bridgeCreatedMarkerGeneration(dir, "env-2")).toBeNull();
  });

  it("treats an id-only marker as the pre-CX590 legacy writer", () => {
    writeMarker({ envelope_id: "env-1", created_at: "2026-11-01T00:00:00.000Z" });
    expect(bridgeCreatedMarkerGeneration(dir, "env-1")).toBe("legacy-v1");
  });

  it("fails toward capture on an unknown generation, a foreign id or no marker", () => {
    expect(bridgeCreatedMarkerGeneration(dir, "env-1")).toBeNull();
    writeMarker({ envelope_id: "env-1", generation: "envelope-v9" });
    expect(bridgeCreatedMarkerGeneration(dir, "env-1")).toBeNull();
    writeMarker({ envelope_id: "env-other", generation: CURRENT_CLAUDE_BRIDGE_GENERATION });
    expect(bridgeCreatedMarkerGeneration(dir, "env-1")).toBeNull();
  });
});
