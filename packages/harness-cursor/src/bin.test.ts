import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findOnPath, isCursorInstall, resolveCursorBin } from "./bin.js";

const roots: string[] = [];
function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "cursor-bin-"));
  roots.push(root);
  return root;
}
function exe(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("resolveCursorBin", () => {
  it("prefers the explicit override", () => {
    expect(resolveCursorBin({ CLAUDEXOR_CURSOR_BIN: "/opt/cursor", PATH: "" })).toBe("/opt/cursor");
  });

  it("keeps cursor-agent when it is on PATH", () => {
    const bin = join(sandbox(), "bin");
    exe(join(bin, "cursor-agent"));
    expect(resolveCursorBin({ PATH: bin })).toBe("cursor-agent");
  });

  it("falls back to `agent` when it resolves into a Cursor install", () => {
    const root = sandbox();
    const real = exe(join(root, "share", "cursor-agent", "versions", "2026.09.02-c22c1a3", "cursor-agent"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(real, join(bin, "agent"));
    expect(resolveCursorBin({ PATH: bin })).toBe("agent");
  });

  it("ignores an unrelated `agent` command", () => {
    const bin = join(sandbox(), "bin");
    exe(join(bin, "agent"));
    expect(resolveCursorBin({ PATH: bin })).toBe("cursor-agent");
  });

  it("skips a dangling cursor-agent link left by an update", () => {
    const root = sandbox();
    const real = exe(join(root, "share", "cursor-agent", "versions", "2026.09.02-c22c1a3", "cursor-agent"));
    const stale = join(root, "stale");
    mkdirSync(stale);
    symlinkSync(join(root, "share", "cursor-agent", "versions", "gone", "cursor-agent"), join(stale, "cursor-agent"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(real, join(bin, "agent"));
    expect(findOnPath("cursor-agent", stale)).toBeNull();
    expect(resolveCursorBin({ PATH: [stale, bin].join(delimiter) })).toBe("agent");
  });

  it("recognises the installer layout only", () => {
    const root = sandbox();
    expect(isCursorInstall(exe(join(root, "share", "cursor-agent", "versions", "1", "cursor-agent")))).toBe(true);
    expect(isCursorInstall(exe(join(root, "other", "agent")))).toBe(false);
  });
});
