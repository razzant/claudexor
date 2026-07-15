import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLocalAttachment } from "./local-attachment.js";

describe("resolveLocalAttachment", () => {
  it("accepts a regular text file", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-local-attachment-"));
    const path = join(root, "note.txt");
    writeFileSync(path, "sentinel");
    expect(resolveLocalAttachment(path, false)).toMatchObject({
      kind: "file",
      mime: "text/plain",
      sizeBytes: 8,
    });
  });

  it("rejects symlinks and non-regular sources before upload", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-local-attachment-bad-"));
    const target = join(root, "target.txt");
    const link = join(root, "link.txt");
    const dir = join(root, "dir");
    writeFileSync(target, "sentinel");
    symlinkSync(target, link);
    mkdirSync(dir);
    expect(() => resolveLocalAttachment(link, false)).toThrow(/regular non-symlink/);
    expect(() => resolveLocalAttachment(dir, false)).toThrow(/regular non-symlink/);
  });
});
