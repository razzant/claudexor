import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../../../scripts/build-runtime-closure.mjs");
const version = readFileSync(
  resolve(import.meta.dirname, "../../util/src/version.ts"),
  "utf8",
).match(/CLAUDEXOR_VERSION = "([^"]+)"/)![1];

let work: string;

// A fixed, deterministic 40-hex "build sha" the fake bundle is stamped with, so
// the builder's stamp-consistency guard (QA-002) passes without a real esbuild.
const FAKE_BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";

/** Build a minimal fake signed app bundle with exactly the closure entries. */
function fakeAppBundle(
  root: string,
  opts: { withNode?: boolean; omit?: string; buildSha?: string; nativeAddon?: boolean } = {},
): string {
  const resources = join(root, "Claudexor.app", "Contents", "Resources");
  mkdirSync(join(resources, "browser-mcp-runtime", "dist"), { recursive: true });
  mkdirSync(join(resources, "native"), { recursive: true });
  const sha = opts.buildSha ?? FAKE_BUILD_SHA;
  if (opts.omit !== "claudexord.bundle.cjs")
    // Stamp the sha into the bundle the way the real esbuild --define does.
    writeFileSync(join(resources, "claudexord.bundle.cjs"), `// daemon sha=${sha}\n`);
  if (opts.omit !== "setup-login-runner.cjs")
    writeFileSync(join(resources, "setup-login-runner.cjs"), "// runner\n");
  writeFileSync(
    join(resources, "browser-mcp-runtime", "dist", "browser-mcp-launcher.js"),
    "// mcp\n",
  );
  writeFileSync(join(resources, "native", "claudexor-process-identity"), "binary");
  // A forbidden native addon lands under a closure dir when requested.
  if (opts.nativeAddon)
    writeFileSync(join(resources, "browser-mcp-runtime", "fsevents.node"), "native");
  // Node and the SwiftPM UI bundle are app-owned; they may be present in the
  // real bundle but must NOT land in the closure.
  if (opts.withNode) writeFileSync(join(resources, "node"), "node-binary");
  writeFileSync(join(resources, "AppIcon.icns"), "icon");
  return join(root, "Claudexor.app");
}

function run(app: string, out: string, ver = version, buildSha = FAKE_BUILD_SHA) {
  return execFileSync("node", [script, "--app-bundle", app, "--version", ver, "--out", out], {
    encoding: "utf8",
    env: { ...process.env, CLAUDEXOR_BUILD_SHA: buildSha },
  });
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "runtime-closure-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("build-runtime-closure", () => {
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
    expect(manifest.minAppVersion).toMatch(/^\d+\.\d+\.\d+$/);
    const tarball = readFileSync(join(out, `claudexor-runtime-${version}.tar.gz`));
    expect(createHash("sha256").update(tarball).digest("hex")).toBe(manifest.sha256);
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
    expect(listing).toContain("browser-mcp-runtime/dist/browser-mcp-launcher.js");
    expect(listing).toContain("native/claudexor-process-identity");
    // Node and AppIcon stay app-owned — never in the update closure.
    expect(listing.split("\n")).not.toContain("node");
    expect(listing).not.toContain("AppIcon.icns");
  });

  it("captures the WHOLE multiline changelog entry as notes, not one physical line (QA-033b)", () => {
    const app = fakeAppBundle(work);
    const out = join(work, "out");
    run(app, out);
    const manifest = JSON.parse(readFileSync(join(out, "runtime-manifest.json"), "utf8"));
    // The real CHANGELOG entry the script read wraps across physical lines.
    const changelog = readFileSync(
      resolve(import.meta.dirname, "../../../CHANGELOG.md"),
      "utf8",
    ).split(/\r?\n/);
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

  it("refuses a --version that does not match the generated CLAUDEXOR_VERSION", () => {
    const app = fakeAppBundle(work);
    const out = join(work, "out");
    expect(() => run(app, out, "9.9.9")).toThrow(/does not match/);
  });
});
