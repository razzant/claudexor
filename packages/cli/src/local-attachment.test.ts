import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openLocalAttachment, resolveLocalAttachment } from "./local-attachment.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

describe("resolveLocalAttachment", () => {
  it("accepts a regular text file", () => {
    const root = reapMk(join(tmpdir(), "claudexor-local-attachment-"));
    const path = join(root, "note.txt");
    writeFileSync(path, "sentinel");
    expect(resolveLocalAttachment(path, false)).toMatchObject({
      kind: "file",
      mime: "text/plain",
      sizeBytes: 8,
    });
  });

  it("rejects symlinks and non-regular sources before upload", () => {
    const root = reapMk(join(tmpdir(), "claudexor-local-attachment-bad-"));
    const target = join(root, "target.txt");
    const link = join(root, "link.txt");
    const dir = join(root, "dir");
    writeFileSync(target, "sentinel");
    symlinkSync(target, link);
    mkdirSync(dir);
    expect(() => resolveLocalAttachment(link, false)).toThrow(/regular non-symlink/);
    expect(() => resolveLocalAttachment(dir, false)).toThrow(/regular non-symlink/);
  });

  it("refuses a same-sized pathname replacement after selection", () => {
    const root = reapMk(join(tmpdir(), "claudexor-local-attachment-swap-"));
    const path = join(root, "note.txt");
    const moved = join(root, "original.txt");
    writeFileSync(path, "original");
    const selected = resolveLocalAttachment(path, false);
    renameSync(path, moved);
    writeFileSync(path, "replaced");
    expect(() => openLocalAttachment(selected)).toThrow(/changed before upload/);
  });
});
