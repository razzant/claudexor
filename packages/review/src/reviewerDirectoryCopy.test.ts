import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileCopyHost, RunContentIndex } from "@claudexor/workspace";
import { copyReviewEvidencePacket, prepareReviewerWorkspace } from "./reviewerWorkspace.js";

// #783: a directory result's review copies keep a sparse file's holes; the
// engine's persistent record shares the immutable blobs, while everything a
// reviewer receives is its own file.
const MiB = 1024 * 1024;
const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "cx-review-directory-"));
  dirs.push(dir);
  return dir;
};

function fixture() {
  const candidate = temp();
  const evidence = temp();
  const image = join(candidate, "disk.img");
  writeFileSync(image, "A".repeat(4096));
  truncateSync(image, MiB);
  const bytes = readFileSync(image);
  const name = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(join(evidence, "final/files/content"), { recursive: true });
  writeFileSync(join(evidence, "final/files/content", name), bytes);
  writeFileSync(join(evidence, "DIFF.patch"), "preview\n");
  if (posix) symlinkSync("disk.img", join(candidate, "alias"));
  return { candidate, evidence, bytes, blob: join("final/files/content", name) };
}

const inode = (path: string) => lstatSync(path).ino;

describe("directory review copies", () => {
  it("shares only the immutable blobs into the persistent record", async () => {
    const f = fixture();
    const persistent = join(temp(), "evidence");
    await copyReviewEvidencePacket(f.evidence, persistent, false, true);
    expect(readFileSync(join(persistent, f.blob)).equals(f.bytes)).toBe(true);
    if (posix) expect(inode(join(persistent, f.blob))).toBe(inode(join(f.evidence, f.blob)));
    // A packet file the engine rewrites in place stays its own.
    writeFileSync(join(persistent, "DIFF.patch"), "rewritten\n");
    expect(readFileSync(join(f.evidence, "DIFF.patch"), "utf8")).toBe("preview\n");
  });

  it("names a blob the run's index verified without reading it; a standalone copy verifies", async () => {
    const f = fixture();
    const blob = join(f.evidence, f.blob);
    const digest = { sha256: `sha256:${f.blob.split("/").at(-1)}`, sizeBytes: f.bytes.length };
    const index = new RunContentIndex();
    index.remember(blob, lstatSync(blob), digest);
    const reads = vi.spyOn(fileCopyHost, "digest");
    await copyReviewEvidencePacket(f.evidence, join(temp(), "evidence"), false, index);
    expect(reads.mock.calls.map(([path]) => String(path))).not.toContain(blob);
    await copyReviewEvidencePacket(f.evidence, join(temp(), "evidence"), false, true);
    expect(reads.mock.calls.map(([path]) => String(path))).toContain(blob);
  });

  it("an ordinary packet is copied as before, never linked", async () => {
    const f = fixture();
    const persistent = join(temp(), "evidence");
    await copyReviewEvidencePacket(f.evidence, persistent);
    if (posix) expect(inode(join(persistent, f.blob))).not.toBe(inode(join(f.evidence, f.blob)));
  });

  const prepare = (f: ReturnType<typeof fixture>, base: string) =>
    prepareReviewerWorkspace({
      sourceRoot: f.candidate,
      sourceEvidenceDir: f.evidence,
      workspaceBaseDir: base,
      reviewerDirName: "01-reviewer",
      excludeRoots: [],
      candidateCopyPaths: new Set(["disk.img", "alias"]),
      candidatePaths: ["disk.img"],
      directoryPayload: true,
    });

  it("gives a reviewer exact independent files and keeps path filters", async () => {
    const f = fixture();
    writeFileSync(join(f.candidate, "unlisted.txt"), "not in the manifest\n");
    const workspace = await prepare(f, temp());
    expect(workspace.uninspectable).toEqual([]);
    for (const [copy, source] of [
      [join(workspace.root, "disk.img"), join(f.candidate, "disk.img")],
      [join(workspace.evidenceDir, f.blob), join(f.evidence, f.blob)],
    ] as const) {
      expect(readFileSync(copy).equals(f.bytes)).toBe(true);
      if (posix) {
        expect(inode(copy)).not.toBe(inode(source));
        expect(lstatSync(copy).nlink).toBe(1);
      }
      writeFileSync(copy, "reviewer scribble");
      expect(readFileSync(source).equals(f.bytes)).toBe(true);
    }
    expect(existsSync(join(workspace.root, "unlisted.txt"))).toBe(false);
    if (posix) expect(lstatSync(join(workspace.root, "alias")).isSymbolicLink()).toBe(true);
  });

  it.skipIf(!posix)("keeps an admitted relative link naming the reviewer's own file", async () => {
    const f = fixture();
    // A harmless alias, wholly inside the private fixture, in both copies.
    symlinkSync("DIFF.patch", join(f.evidence, "patch-alias"));
    const workspace = await prepare(f, temp());
    const alias = join(workspace.root, "alias");
    expect(readlinkSync(alias)).toBe("disk.img");
    expect(realpathSync(alias)).toBe(realpathSync(join(workspace.root, "disk.img")));
    const evidenceAlias = join(workspace.evidenceDir, "patch-alias");
    expect(readlinkSync(evidenceAlias)).toBe("DIFF.patch");
    expect(realpathSync(evidenceAlias)).toBe(
      realpathSync(join(workspace.evidenceDir, "DIFF.patch")),
    );
    const persistent = join(temp(), "evidence");
    await copyReviewEvidencePacket(f.evidence, persistent, false, true);
    expect(readlinkSync(join(persistent, "patch-alias"))).toBe("DIFF.patch");
  });

  it("copies a file smaller than the margin whole when free space cannot be read", async () => {
    const f = fixture();
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    vi.spyOn(fileCopyHost, "availableBytes").mockReturnValue(null);
    const workspace = await prepare(f, temp());
    expect(workspace.uninspectable).toEqual([]);
    expect(lstatSync(join(workspace.root, "disk.img")).size).toBe(MiB);
  });

  it("names what cannot fit when free space is too little, keeping no part of it", async () => {
    const f = fixture();
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    vi.spyOn(fileCopyHost, "availableBytes").mockReturnValue(0);
    const workspace = await prepare(f, temp());
    const named = workspace.uninspectable.map((file) => `${file.path}: ${file.reason}`);
    expect(named).toContain("disk.img: space_insufficient");
    expect(named).toContain(`.claudexor-review-evidence/${f.blob}: space_insufficient`);
    expect(existsSync(join(workspace.root, "disk.img"))).toBe(false);
    expect(existsSync(join(workspace.evidenceDir, f.blob))).toBe(false);
  });
});
