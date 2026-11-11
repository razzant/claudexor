import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectWin32ConptyHelper,
  verifyWin32ConptyHelperCustody,
} from "./win32-conpty-artifact.mjs";

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "conpty-pe-custody-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

describe("Win32 ConPTY helper artifact custody", () => {
  it("accepts byte-identical bounded PE32+ x64 carriers", () => {
    const first = join(root, "first.exe");
    const second = join(root, "second.exe");
    const bytes = fakePe();
    writeFileSync(first, bytes);
    writeFileSync(second, bytes);
    const sha256 = inspectWin32ConptyHelper(first);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyWin32ConptyHelperCustody([first, second], sha256)).toMatchObject({
      sha256,
      files: [
        { path: first, sha256 },
        { path: second, sha256 },
      ],
    });
  });

  it("rejects the wrong architecture, symlinks, and carrier byte drift", () => {
    const good = join(root, "good.exe");
    const wrongArchitecture = join(root, "arm.exe");
    const changed = join(root, "changed.exe");
    const linked = join(root, "linked.exe");
    writeFileSync(good, fakePe());
    writeFileSync(wrongArchitecture, fakePe({ machine: 0xaa64 }));
    const changedBytes = fakePe();
    changedBytes[300] = 1;
    writeFileSync(changed, changedBytes);
    symlinkSync(good, linked);
    expect(() => inspectWin32ConptyHelper(wrongArchitecture)).toThrow(/expected x64/);
    expect(() => inspectWin32ConptyHelper(linked)).toThrow(/regular file/);
    expect(() => verifyWin32ConptyHelperCustody([good, changed])).toThrow(/byte mismatch/);
  });
});

function fakePe({ machine = 0x8664 } = {}) {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(machine, 0x84);
  bytes.writeUInt16LE(0xf0, 0x94);
  bytes.writeUInt16LE(0x0002, 0x96);
  bytes.writeUInt16LE(0x020b, 0x98);
  return bytes;
}
