import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { BETTERLEAKS_RELEASES } from "../../packages/delivery/src/publication-scanner-pin.ts";
import { refreshProvenance, stagePlatform, stagedPlatforms } from "./betterleaks-stage.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tarTest = process.platform === "win32" ? test.skip : test;

/** A synthetic upstream archive (stand-in binary + license) and the release
 * record that pins it; the real pins are exercised by the staging builds. */
function archive({ license = "MIT License\n\nCopyright (c) fixture\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "betterleaks-stage-"));
  roots.push(root);
  const content = join(root, "content");
  mkdirSync(content);
  const binary = "#!/bin/sh\necho 1.9.0\n";
  writeFileSync(join(content, "betterleaks"), binary, { mode: 0o755 });
  writeFileSync(join(content, "LICENSE"), license);
  writeFileSync(join(content, "README.md"), "not staged\n");
  const path = join(root, "betterleaks_1.9.0_linux_x64.tar.gz");
  execFileSync("tar", ["-czf", path, "-C", content, "betterleaks", "LICENSE", "README.md"]);
  const release = {
    ...BETTERLEAKS_RELEASES["linux-x64"],
    archiveSha256: sha(readFileSync(path)),
    binarySha256: sha(binary),
  };
  return { root, path, release, native: join(root, "native") };
}

tarTest("stages exactly the verified binary, its license and provenance", () => {
  const a = archive();
  const layout = stagePlatform("linux-x64", a.path, a.native, a.release);
  expect(stagedPlatforms(a.native)).toEqual(["linux-x64"]);
  expect(sha(readFileSync(layout.binary))).toBe(a.release.binarySha256);
  expect(statSync(layout.binary).mode & 0o777).toBe(0o755);
  expect(readFileSync(layout.license, "utf8")).toContain("MIT License");
  expect(existsSync(join(layout.dir, "README.md"))).toBe(false);
  expect(JSON.parse(readFileSync(layout.provenance, "utf8"))).toEqual({
    name: "betterleaks",
    version: "1.9.0",
    platform: "linux-x64",
    license: "MIT",
    source: `https://github.com/betterleaks/betterleaks/releases/download/v1.9.0/${a.release.asset}`,
    archiveSha256: a.release.archiveSha256,
    upstreamBinarySha256: a.release.binarySha256,
    bundledSha256: a.release.binarySha256,
  });
});

tarTest("refuses an archive, binary or license that is not the pinned upstream build", () => {
  const a = archive();
  // The real pin never matches the synthetic archive.
  expect(() => stagePlatform("linux-x64", a.path, a.native)).toThrow(/archive digest/);
  expect(() =>
    stagePlatform("linux-x64", a.path, a.native, { ...a.release, binarySha256: "0".repeat(64) }),
  ).toThrow(/binary digest/);
  expect(() => stagePlatform("win32-x64", a.path, a.native)).toThrow(/archive digest/);
  expect(() => stagePlatform("plan9-mips", a.path, a.native)).toThrow(/no pinned Betterleaks/);
  const other = archive({ license: "Proprietary\n" });
  expect(() => stagePlatform("linux-x64", other.path, other.native, other.release)).toThrow(
    /MIT license/,
  );
  expect(stagedPlatforms(a.native)).toEqual([]);
  expect(stagedPlatforms(other.native)).toEqual([]);
});

tarTest("records a signed copy's digest only for provenance naming the pinned upstream", () => {
  const a = archive();
  const layout = stagePlatform("linux-x64", a.path, a.native, a.release);
  appendFileSync(layout.binary, "# signature\n");
  expect(refreshProvenance(a.native, () => a.release)).toEqual(["linux-x64"]);
  const provenance = JSON.parse(readFileSync(layout.provenance, "utf8"));
  expect(provenance.bundledSha256).toBe(sha(readFileSync(layout.binary)));
  expect(provenance.upstreamBinarySha256).toBe(a.release.binarySha256);
  // Against the real pin the synthetic upstream digest is refused.
  expect(() => refreshProvenance(a.native)).toThrow(/does not name the pinned upstream binary/);
});
