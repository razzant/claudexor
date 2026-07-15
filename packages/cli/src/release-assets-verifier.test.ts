import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyReleaseAssetNames } from "../../../scripts/verify-release-assets.mjs";

const fixtures = resolve(import.meta.dirname, "fixtures/release-assets");
const expected = ["Claudexor-2.0.0.dmg", "Claudexor-2.0.0.zip", "SHA256SUMS"];
const names = (fixture: string) =>
  readFileSync(resolve(fixtures, fixture), "utf8").trim().split("\n");

describe("release asset verifier", () => {
  it("accepts a retry-safe subset before upload and exact set after upload", () => {
    expect(verifyReleaseAssetNames(expected, names("remote-subset.txt"), "before")).toEqual({
      ok: true,
      reasons: [],
    });
    expect(verifyReleaseAssetNames(expected, names("remote-exact.txt"), "after")).toEqual({
      ok: true,
      reasons: [],
    });
    expect(verifyReleaseAssetNames(expected, names("remote-subset.txt"), "after").ok).toBe(false);
  });

  it("fails before upload when the draft contains an unexpected asset", () => {
    expect(verifyReleaseAssetNames(expected, names("remote-extra.txt"), "before")).toEqual({
      ok: false,
      reasons: ["unexpected remote release asset: old-unsigned-build.zip"],
    });
  });

  it("runs as an executable fail-closed verifier", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-release-assets-"));
    const expectedDir = join(root, "expected");
    mkdirSync(expectedDir);
    for (const name of expected) writeFileSync(join(expectedDir, name), name);
    const remoteManifest = join(root, "remote.txt");
    writeFileSync(remoteManifest, names("remote-exact.txt").join("\n"));
    try {
      expect(() =>
        execFileSync(
          process.execPath,
          [
            resolve("scripts/verify-release-assets.mjs"),
            "--phase",
            "after",
            "--expected-dir",
            expectedDir,
            "--remote-manifest",
            remoteManifest,
          ],
          { stdio: "pipe" },
        ),
      ).not.toThrow();
      writeFileSync(remoteManifest, names("remote-extra.txt").join("\n"));
      expect(() =>
        execFileSync(
          process.execPath,
          [
            resolve("scripts/verify-release-assets.mjs"),
            "--phase",
            "before",
            "--expected-dir",
            expectedDir,
            "--remote-manifest",
            remoteManifest,
          ],
          { stdio: "pipe" },
        ),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
