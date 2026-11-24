import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BETTERLEAKS_RELEASES } from "@claudexor/delivery";
import { assertLinkFreeExtractedTree } from "../../../scripts/lib/remote-runtime-archive.mjs";

const sourceRoot = resolve(import.meta.dirname, "../../..");
const sourceScript = join(sourceRoot, "scripts", "build-runtime-closure.mjs");
const sourceVersion = readFileSync(join(sourceRoot, "packages/util/src/version.ts"), "utf8").match(
  /CLAUDEXOR_VERSION = "([^"]+)"/,
)![1];
const minAppVersion: string = JSON.parse(
  readFileSync(join(sourceRoot, "release/runtime-min-app-version.json"), "utf8"),
).minAppVersion;
const semverParts = (value: string) => value.split(".").map(Number);
const semverCompare = (a: string, b: string) => {
  const [pa, pb] = [semverParts(a), semverParts(b)];
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
};
// The release this source prepares. A pending changeset may already need a
// newer app than the generated version names (the floor is then ahead of it);
// that release is at least the floor, so packaging cases build it, and the
// floor itself stays enforced by the negative controls below.
const version = semverCompare(sourceVersion, minAppVersion) >= 0 ? sourceVersion : minAppVersion;

let work: string;
let script: string;

/**
 * A release checkout for `releaseVersion`: the real builder and its real
 * `scripts/lib`, the tracked app floor byte-for-byte, a generated version
 * carrier naming `releaseVersion`, and the tracked CHANGELOG whose entry for the
 * source version is relabelled to it. Nothing tracked is rewritten.
 */
function releaseRoot(root: string, releaseVersion: string): string {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "packages", "util", "src"), { recursive: true });
  mkdirSync(join(repo, "release"), { recursive: true });
  copyFileSync(sourceScript, join(repo, "scripts", "build-runtime-closure.mjs"));
  symlinkSync(join(sourceRoot, "scripts", "lib"), join(repo, "scripts", "lib"), "junction");
  copyFileSync(
    join(sourceRoot, "release", "runtime-min-app-version.json"),
    join(repo, "release", "runtime-min-app-version.json"),
  );
  writeFileSync(
    join(repo, "packages", "util", "src", "version.ts"),
    `export const CLAUDEXOR_VERSION = "${releaseVersion}";\n`,
  );
  writeFileSync(
    join(repo, "CHANGELOG.md"),
    readFileSync(join(sourceRoot, "CHANGELOG.md"), "utf8").replace(
      `\n- **v${sourceVersion}**`,
      `\n- **v${releaseVersion}**`,
    ),
  );
  return join(repo, "scripts", "build-runtime-closure.mjs");
}

// A fixed, deterministic 40-hex "build sha" the fake bundle is stamped with, so
// the builder's stamp-consistency guard (QA-002) passes without a real esbuild.
const FAKE_BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";

/** Build a minimal fake signed app bundle with exactly the closure entries. */
function fakeAppBundle(
  root: string,
  opts: {
    withNode?: boolean;
    omit?: string;
    buildSha?: string;
    nativeAddon?: boolean;
    internalLink?: boolean;
    escapingLink?: boolean;
    win32Conpty?: boolean;
  } = {},
): string {
  const resources = join(root, "Claudexor.app", "Contents", "Resources");
  mkdirSync(join(resources, "browser-mcp-runtime", "dist"), { recursive: true });
  mkdirSync(join(resources, "native"), { recursive: true });
  const sha = opts.buildSha ?? FAKE_BUILD_SHA;
  if (opts.omit !== "claudexord.bundle.cjs")
    // Stamp the sha into the bundle the way the real esbuild --define does.
    writeFileSync(join(resources, "claudexord.bundle.cjs"), `// daemon sha=${sha}\n`);
  if (opts.omit !== "claudexor.bundle.cjs")
    writeFileSync(join(resources, "claudexor.bundle.cjs"), `// cli sha=${sha}\n`);
  if (opts.omit !== "setup-login-runner.cjs")
    writeFileSync(join(resources, "setup-login-runner.cjs"), "// runner\n");
  writeFileSync(join(resources, "run-deadline-warden.cjs"), "// warden\n");
  writeFileSync(
    join(resources, "browser-mcp-runtime", "dist", "browser-mcp-launcher.js"),
    "// mcp\n",
  );
  writeFileSync(join(resources, "native", "claudexor-process-identity"), "binary");
  if (opts.win32Conpty)
    writeFileSync(join(resources, "native", "claudexor-conpty-helper.exe"), fakePe());
  // A forbidden native addon lands under a closure dir when requested.
  if (opts.nativeAddon)
    writeFileSync(join(resources, "browser-mcp-runtime", "fsevents.node"), "native");
  if (opts.internalLink || opts.escapingLink) {
    const modules = join(resources, "browser-mcp-runtime", "node_modules");
    mkdirSync(modules, { recursive: true });
    if (opts.internalLink) {
      const stored = join(modules, ".store", "fixture");
      mkdirSync(stored, { recursive: true });
      writeFileSync(join(stored, "index.js"), "materialized fixture\n");
      symlinkSync(".store/fixture", join(modules, "fixture"), "dir");
    }
    if (opts.escapingLink) {
      const outside = join(resources, "outside-browser-runtime");
      mkdirSync(outside);
      writeFileSync(join(outside, "secret.txt"), "must not be packed\n");
      symlinkSync("../../outside-browser-runtime", join(modules, "escape"), "dir");
    }
  }
  // Node and the SwiftPM UI bundle are app-owned; they may be present in the
  // real bundle but must NOT land in the closure. The reviewed CLI is part of
  // the closure so embedders can invoke exact operational commands.
  if (opts.withNode) writeFileSync(join(resources, "node"), "node-binary");
  writeFileSync(join(resources, "AppIcon.icns"), "icon");
  return join(root, "Claudexor.app");
}

function run(
  app: string,
  out: string,
  ver = version,
  buildSha = FAKE_BUILD_SHA,
  win32ConptySha256?: string,
) {
  return execFileSync(
    "node",
    [
      script,
      "--app-bundle",
      app,
      "--version",
      ver,
      "--out",
      out,
      ...(win32ConptySha256 ? ["--win32-conpty-sha256", win32ConptySha256] : []),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLAUDEXOR_BUILD_SHA: buildSha },
    },
  );
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "runtime-closure-"));
  script = releaseRoot(work, version);
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

describe("build-runtime-closure", () => {
  it("consumes the common resource stage without an app bundle", () => {
    const app = fakeAppBundle(work, { internalLink: true });
    const resources = join(app, "Contents", "Resources");
    const out = join(work, "resource-out");
    execFileSync(
      process.execPath,
      [script, "--resources", resources, "--version", version, "--out", out],
      { env: { ...process.env, CLAUDEXOR_BUILD_SHA: FAKE_BUILD_SHA } },
    );
    const extracted = join(work, "resource-extracted");
    mkdirSync(extracted);
    execFileSync("tar", [
      "-xzf",
      join(out, `claudexor-runtime-${version}.tar.gz`),
      "-C",
      extracted,
    ]);
    for (const name of [
      "claudexord.bundle.cjs",
      "claudexor.bundle.cjs",
      "setup-login-runner.cjs",
      "run-deadline-warden.cjs",
      "native/claudexor-process-identity",
    ]) {
      expect(readFileSync(join(extracted, name))).toEqual(readFileSync(join(resources, name)));
    }
    expect(() =>
      execFileSync(
        process.execPath,
        [script, "--resources", resources, "--app-bundle", app, "--version", version, "--out", out],
        { stdio: "pipe" },
      ),
    ).toThrow();
  });

  it("emits a tarball plus a manifest whose sha256 matches the tarball", () => {
    const app = fakeAppBundle(work, { withNode: true });
    const out = join(work, "out");
    run(app, out);
    const manifest = JSON.parse(readFileSync(join(out, "runtime-manifest.json"), "utf8"));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.version).toBe(version);
    // The candidate manifest is UNSIGNED — the owner signs it offline.
    expect(manifest.signature).toBeUndefined();
    expect(manifest.keyId).toBeUndefined();
    expect(manifest.archiveName).toBe(`claudexor-runtime-${version}.tar.gz`);
    expect(manifest.archiveUrl).toBe(
      `https://github.com/razzant/claudexor/releases/download/v${version}/claudexor-runtime-${version}.tar.gz`,
    );
    expect(manifest.buildSha).toBe(FAKE_BUILD_SHA);
    expect(manifest.minAppVersion).toBe(minAppVersion);
    const tarball = readFileSync(join(out, `claudexor-runtime-${version}.tar.gz`));
    expect(createHash("sha256").update(tarball).digest("hex")).toBe(manifest.sha256);
  });

  it("carries bundled darwin publication scanners only as their pinned, recorded bytes (INV-146)", () => {
    const app = fakeAppBundle(work);
    const native = join(app, "Contents", "Resources", "native");
    const stage = (key: string, bytes = `${key} signed scanner\n`) => {
      const dir = join(native, "betterleaks", key);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "betterleaks"), bytes);
      writeFileSync(join(dir, "LICENSE"), "MIT License\n");
      writeFileSync(
        join(dir, "provenance.json"),
        JSON.stringify({
          name: "betterleaks",
          version: "1.9.0",
          platform: key,
          license: "MIT",
          upstreamBinarySha256: BETTERLEAKS_RELEASES[key]!.binarySha256,
          bundledSha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      );
      return dir;
    };
    const release = (out: string) =>
      execFileSync(
        process.execPath,
        [script, "--app-bundle", app, "--version", version, "--out", join(work, out)],
        {
          encoding: "utf8",
          stdio: "pipe",
          env: {
            ...process.env,
            CLAUDEXOR_BUILD_SHA: FAKE_BUILD_SHA,
            CLAUDEXOR_REQUIRE_BETTERLEAKS: "1",
          },
        },
      );
    expect(() => release("none")).toThrow(
      /requires the darwin-arm64 and darwin-x64 publication scanners/,
    );
    stage("darwin-arm64");
    stage("darwin-x64");
    release("out");
    const listing = execFileSync(
      "tar",
      ["-tzf", join(work, "out", `claudexor-runtime-${version}.tar.gz`)],
      { encoding: "utf8" },
    ).split("\n");
    for (const key of ["darwin-arm64", "darwin-x64"])
      for (const name of ["betterleaks", "LICENSE", "provenance.json"])
        expect(listing).toContain(`native/betterleaks/${key}/${name}`);
    writeFileSync(join(native, "betterleaks", "darwin-x64", "betterleaks"), "changed\n");
    expect(() => release("tampered")).toThrow(/darwin-x64 publication scanner does not match/);
    rmSync(join(stage("darwin-x64"), "provenance.json"));
    expect(() => release("unrecorded")).toThrow(/darwin-x64 publication scanner does not match/);
    stage("darwin-x64");
    // The universal closure never carries another platform's build.
    stage("linux-x64");
    expect(() => release("foreign")).toThrow(/only darwin publication scanners/);
  });

  it("refuses a closure carrying a forbidden .node native addon (D-2)", () => {
    const app = fakeAppBundle(work, { nativeAddon: true });
    const out = join(work, "out");
    expect(() => run(app, out)).toThrow(/native addon/i);
  });

  it("refuses to ship when the bundle is not stamped with the build sha (QA-002)", () => {
    const app = fakeAppBundle(work, { buildSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    const out = join(work, "out");
    // The bundle is stamped with all-a's but the build passes all-0's.
    expect(() => run(app, out, version, FAKE_BUILD_SHA)).toThrow(/not stamped/i);
  });

  it("packs the closure at the archive root without Node or the UI bundle", () => {
    const app = fakeAppBundle(work, { withNode: true });
    const out = join(work, "out");
    run(app, out);
    const listing = execFileSync(
      "tar",
      ["-tzf", join(out, `claudexor-runtime-${version}.tar.gz`)],
      { encoding: "utf8" },
    );
    expect(listing).toContain("claudexord.bundle.cjs");
    expect(listing).toContain("claudexor.bundle.cjs");
    expect(listing).toContain("browser-mcp-runtime/dist/browser-mcp-launcher.js");
    expect(listing).toContain("native/claudexor-process-identity");
    // Node and AppIcon stay host/app-owned — never in the closure.
    const entries = listing.split("\n");
    expect(entries).not.toContain("node");
    expect(listing).not.toContain("AppIcon.icns");
  });

  it("binds the staged Windows helper bytes without widening runtime-manifest schema v1", () => {
    const app = fakeAppBundle(work, { win32Conpty: true });
    const helper = join(app, "Contents", "Resources", "native", "claudexor-conpty-helper.exe");
    const expected = createHash("sha256").update(readFileSync(helper)).digest("hex");
    const out = join(work, "out");
    run(app, out, version, FAKE_BUILD_SHA, expected);
    const listing = execFileSync(
      "tar",
      ["-tzf", join(out, `claudexor-runtime-${version}.tar.gz`)],
      { encoding: "utf8" },
    );
    expect(listing).toContain("native/claudexor-conpty-helper.exe");
    const manifest = JSON.parse(readFileSync(join(out, "runtime-manifest.json"), "utf8"));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest).not.toHaveProperty("files");
    expect(manifest).not.toHaveProperty("win32ConptySha256");

    expect(() => run(app, join(work, "wrong"), version, FAKE_BUILD_SHA, "0".repeat(64))).toThrow(
      /byte mismatch/,
    );
  });

  it("materializes internal package links into a link-free regular tree", () => {
    const app = fakeAppBundle(work, { internalLink: true });
    const out = join(work, "out");
    run(app, out);
    const archive = join(out, `claudexor-runtime-${version}.tar.gz`);
    const extracted = join(work, "extracted");
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", archive, "-C", extracted]);
    assertLinkFreeExtractedTree(extracted);
    const materializedDirectory = join(extracted, "browser-mcp-runtime", "node_modules", "fixture");
    const materialized = join(materializedDirectory, "index.js");
    expect(lstatSync(materialized).isFile()).toBe(true);
    expect(lstatSync(materializedDirectory).isSymbolicLink()).toBe(false);
    expect(readFileSync(materialized, "utf8")).toBe("materialized fixture\n");
  });

  it("refuses a package link whose target escapes the closure entry", () => {
    const app = fakeAppBundle(work, { escapingLink: true });
    expect(() => run(app, join(work, "out"))).toThrow(/escapes its package root/);
  });

  it("captures the WHOLE multiline changelog entry as notes, not one physical line (QA-033b)", () => {
    const app = fakeAppBundle(work);
    const out = join(work, "out");
    run(app, out);
    const manifest = JSON.parse(readFileSync(join(out, "runtime-manifest.json"), "utf8"));
    // The real CHANGELOG entry the script read wraps across physical lines.
    const changelog = readFileSync(join(work, "repo", "CHANGELOG.md"), "utf8").split(/\r?\n/);
    const headerIdx = changelog.findIndex((l) => l.startsWith(`- **v${version}**`));
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    // A token from the HEADER line and from the FIRST continuation line must BOTH
    // survive: the old one-physical-line regex dropped the header entirely and
    // truncated the note mid-quote.
    const headerTail = changelog[headerIdx]!.replace(/^- \*\*v[^*]+\*\*\s*\([^)]*\)\s*[—-]\s*/, "");
    const headerWord = headerTail.trim().split(/\s+/)[0]!;
    const continuationWord = changelog[headerIdx + 1]!.trim().split(/\s+/)[0]!;
    expect(manifest.notes).toContain(headerWord);
    expect(manifest.notes).toContain(continuationWord);
    // Bounded and whitespace-collapsed — never an unbounded dump.
    expect(manifest.notes.length).toBeLessThanOrEqual(400);
    expect(manifest.notes).not.toMatch(/\n/);
  });

  it("fails when a closure entry is missing from the app bundle", () => {
    const app = fakeAppBundle(work, { omit: "setup-login-runner.cjs" });
    const out = join(work, "out");
    expect(() => run(app, out)).toThrow(/setup-login-runner\.cjs/);
  });

  it("fails when the reviewed CLI entry is missing from the app bundle", () => {
    const app = fakeAppBundle(work, { omit: "claudexor.bundle.cjs" });
    const out = join(work, "out");
    expect(() => run(app, out)).toThrow(/claudexor\.bundle\.cjs/);
  });

  it.each([false, true])(
    "refuses a universal closure without its Darwin helper (Windows helper: %s)",
    (win32Conpty) => {
      const app = fakeAppBundle(work, { win32Conpty });
      rmSync(join(app, "Contents", "Resources", "native", "claudexor-process-identity"));
      expect(() => run(app, join(work, "out"))).toThrow(
        /requires the native\/claudexor-process-identity file/,
      );
    },
  );

  it("refuses a release older than the tracked app floor before writing anything", () => {
    const [major, minor, patch] = semverParts(minAppVersion) as [number, number, number];
    const below =
      patch > 0
        ? `${major}.${minor}.${patch - 1}`
        : minor > 0
          ? `${major}.${minor - 1}.0`
          : `${major - 1}.0.0`;
    const belowScript = releaseRoot(join(work, "below"), below);
    const app = fakeAppBundle(work);
    const out = join(work, "out");
    expect(() =>
      execFileSync(
        process.execPath,
        [belowScript, "--app-bundle", app, "--version", below, "--out", out],
        {
          stdio: "pipe",
          env: { ...process.env, CLAUDEXOR_BUILD_SHA: FAKE_BUILD_SHA },
        },
      ),
    ).toThrow(`minAppVersion ${minAppVersion} is newer than the release version ${below}`);
    expect(existsSync(out)).toBe(false);
  });

  it("applies the tracked app floor to the source tree's own version", () => {
    const app = fakeAppBundle(work);
    const out = join(work, "out");
    const build = () =>
      execFileSync(
        process.execPath,
        [sourceScript, "--app-bundle", app, "--version", sourceVersion, "--out", out],
        { stdio: "pipe", env: { ...process.env, CLAUDEXOR_BUILD_SHA: FAKE_BUILD_SHA } },
      );
    if (semverCompare(sourceVersion, minAppVersion) < 0) {
      expect(build).toThrow(
        `minAppVersion ${minAppVersion} is newer than the release version ${sourceVersion}`,
      );
      expect(existsSync(out)).toBe(false);
    } else {
      build();
      const manifest = JSON.parse(readFileSync(join(out, "runtime-manifest.json"), "utf8"));
      expect(manifest.version).toBe(sourceVersion);
      expect(manifest.minAppVersion).toBe(minAppVersion);
    }
  });

  it("refuses a --version that does not match the generated CLAUDEXOR_VERSION", () => {
    const app = fakeAppBundle(work);
    const out = join(work, "out");
    expect(() => run(app, out, "9.9.9")).toThrow(/does not match/);
  });
});

function fakePe(): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(0xf0, 0x94);
  bytes.writeUInt16LE(0x0002, 0x96);
  bytes.writeUInt16LE(0x020b, 0x98);
  return bytes;
}
