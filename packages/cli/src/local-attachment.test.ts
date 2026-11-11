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
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

describe("resolveLocalAttachment", () => {
  it.each([
    ["report.pdf", "application/pdf"],
    ["report.PDF", "application/pdf"],
    ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["report.DOCX", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["report.txt", "text/plain"],
    ["report.md", "text/markdown"],
    ["report.markdown", "text/markdown"],
    ["report.json", "application/json"],
    ["image.png", "image/png"],
    ["unknown.bin", "application/octet-stream"],
  ])("detects the MIME of %s before upload", (name, mime) => {
    const root = reapMk(join(tmpdir(), "claudexor-local-mime-"));
    const path = join(root, name);
    writeFileSync(path, "exact bytes");
    expect(resolveLocalAttachment(path, false)).toMatchObject({
      kind: mime.startsWith("image/") ? "image" : "file",
      mime,
      name,
      path,
      sizeBytes: 11,
    });
  });

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
