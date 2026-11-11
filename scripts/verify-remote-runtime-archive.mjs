#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  assertLinkFreeExtractedTree,
  validateArchiveListings,
  validateNodeBinaryTarget,
} from "./lib/remote-runtime-archive.mjs";
import { pinnedRelease, sha256File } from "./lib/betterleaks-stage.mjs";

// Node's execFileSync default is only 1 MiB. A valid four-target runtime carries
// the full Browser MCP dependency tree, whose tar listing exceeds that even
// though the compressed archive itself is bounded by the release asset. Keep a
// finite explicit ceiling so a pathological archive still fails closed.
const TAR_LIST_MAX_BUFFER = 64 * 1024 * 1024;

function main() {
  const archive = resolve(process.argv[2] ?? "");
  const match =
    /^claudexor-remote-runtime-(\d+\.\d+\.\d+)-(linux|darwin)-(x64|arm64)\.tar\.gz$/.exec(
      basename(archive),
    );
  if (!match || !statSync(archive).isFile()) {
    throw new Error("expected claudexor-remote-runtime-VERSION-TARGET.tar.gz");
  }
  const [, version, platform, arch] = match;
  const target = `${platform}-${arch}`;
  const names = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: TAR_LIST_MAX_BUFFER,
  });
  const verbose = execFileSync("tar", ["-tvzf", archive], {
    encoding: "utf8",
    maxBuffer: TAR_LIST_MAX_BUFFER,
  });
  validateArchiveListings(names, verbose);

  const work = mkdtempSync(join(tmpdir(), "claudexor-remote-verify-"));
  try {
    // Extraction happens only after the entry-name and type fence above. The
    // resulting tree is checked again with lstat so verifier behavior does not
    // depend solely on tar's presentation format.
    execFileSync("tar", ["-xzf", archive, "-C", work]);
    assertLinkFreeExtractedTree(work);
    const runtime = JSON.parse(readFileSync(join(work, "runtime.json"), "utf8"));
    if (
      runtime.schemaVersion !== 1 ||
      runtime.version !== version ||
      runtime.target !== target ||
      runtime.protocolMajor !== 3
    ) {
      throw new Error("runtime.json does not match the archive identity");
    }
    validateNodeBinaryTarget(join(work, "node", "bin", "node"), target);
    // The publication scanner: exactly this target's pinned build, its license
    // and provenance, never another platform's copy (INV-146).
    const scanners = readdirSync(join(work, "lib", "native", "betterleaks"));
    if (scanners.length !== 1 || scanners[0] !== target) {
      throw new Error(`runtime must carry only the ${target} publication scanner`);
    }
    const scannerDir = join(work, "lib", "native", "betterleaks", target);
    const release = pinnedRelease(target);
    const scanner = join(scannerDir, release.binary);
    if ((statSync(scanner).mode & 0o111) === 0) throw new Error("scanner is not executable");
    if (sha256File(scanner) !== release.binarySha256) {
      throw new Error("bundled scanner is not the pinned Betterleaks build");
    }
    const provenance = JSON.parse(readFileSync(join(scannerDir, "provenance.json"), "utf8"));
    if (provenance.bundledSha256 !== release.binarySha256 || provenance.license !== "MIT") {
      throw new Error("scanner provenance does not match the pinned build");
    }
    if (!readFileSync(join(scannerDir, "LICENSE"), "utf8").includes("MIT License")) {
      throw new Error("scanner LICENSE is missing");
    }
    for (const wrapper of ["claudexor", "claudexord"]) {
      const path = join(work, "bin", wrapper);
      if ((statSync(path).mode & 0o111) === 0) {
        throw new Error(`${wrapper} wrapper is not executable`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  process.stdout.write(`verified ${basename(archive)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`verify-remote-runtime-archive failed: ${String(error)}\n`);
  process.exit(1);
}
