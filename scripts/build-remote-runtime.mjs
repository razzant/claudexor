#!/usr/bin/env node
/**
 * Build one complete SSH runtime archive from already-gated app resources, an
 * official Node distribution archive and the official publication-scanner
 * (Betterleaks) archive for the same target. The Node digest is an explicit
 * input supplied from the reviewed release lock; the scanner archive and binary
 * are checked against the pin in packages/delivery/src/publication-scanner-pin.ts.
 * Both are verified before extraction, and only the target's scanner ships.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  REMOTE_RUNTIME_TARGETS,
  remoteRuntimeArchiveName,
  remoteRuntimeArchiveUrl,
} from "./lib/remote-runtime-manifest-contract.mjs";
import {
  assertLinkFreeExtractedTree,
  copyTreeMaterialized,
  remoteRuntimeShellWrapper,
} from "./lib/remote-runtime-archive.mjs";
import { stagePlatform } from "./lib/betterleaks-stage.mjs";

const REQUIRED_RESOURCES = [
  "claudexor.bundle.cjs",
  "claudexord.bundle.cjs",
  "setup-login-runner.cjs",
  "browser-mcp-runtime",
];

function parseArgs(argv) {
  if (argv.length % 2 !== 0) throw new Error("arguments must be --name value pairs");
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith("--")) throw new Error(`invalid argument ${key ?? ""}`);
    result[key.slice(2)] = argv[index + 1];
  }
  return result;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertSafeArchive(path) {
  const listing = execFileSync("tar", ["-tf", path], { encoding: "utf8" });
  for (const raw of listing.split(/\r?\n/)) {
    if (!raw) continue;
    const name = raw.replaceAll("\\", "/");
    const parts = name.split("/");
    if (name.startsWith("/") || parts.includes("..")) {
      throw new Error(`Node archive contains unsafe entry: ${raw}`);
    }
  }
}

function singleExtractedRoot(directory) {
  const rows = readdirSync(directory).filter((name) => name !== ".DS_Store");
  if (rows.length !== 1) throw new Error("Node archive must contain exactly one root directory");
  const root = join(directory, rows[0]);
  if (!statSync(root).isDirectory()) throw new Error("Node archive root is not a directory");
  return root;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const key of [
    "target",
    "version",
    "build-sha",
    "resources",
    "node-archive",
    "node-sha256",
    "node-version",
    "betterleaks-archive",
    "out",
  ]) {
    if (!options[key]) throw new Error(`missing --${key}`);
  }
  if (!REMOTE_RUNTIME_TARGETS.includes(options.target)) {
    throw new Error(`unsupported --target ${options.target}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) throw new Error("invalid --version");
  if (!/^[0-9a-f]{40}$/.test(options["build-sha"])) throw new Error("invalid --build-sha");
  if (!/^[0-9a-f]{64}$/.test(options["node-sha256"])) {
    throw new Error("invalid --node-sha256");
  }
  if (!/^\d+\.\d+\.\d+$/.test(options["node-version"])) {
    throw new Error("invalid --node-version");
  }
  const nodeLock = JSON.parse(
    readFileSync(new URL("./remote-node-sha256.json", import.meta.url), "utf8"),
  );
  if (
    nodeLock.nodeVersion !== options["node-version"] ||
    nodeLock.assets?.[options.target] !== options["node-sha256"]
  ) {
    throw new Error("Node version or digest does not match scripts/remote-node-sha256.json");
  }

  const resources = resolve(options.resources);
  for (const entry of REQUIRED_RESOURCES) {
    if (!existsSync(join(resources, entry))) throw new Error(`missing resource ${entry}`);
  }
  const targetPlatform = options.target.split("-")[0];
  const nativePath = join(resources, "native");
  if (targetPlatform === "darwin" && !existsSync(nativePath)) {
    throw new Error("Darwin remote runtime requires the native process identity helper");
  }

  const nodeArchive = resolve(options["node-archive"]);
  if (sha256(nodeArchive) !== options["node-sha256"]) {
    throw new Error("Node archive digest does not match the reviewed lock");
  }
  assertSafeArchive(nodeArchive);

  const work = mkdtempSync(join(tmpdir(), "claudexor-remote-runtime-"));
  try {
    const extracted = join(work, "node-extracted");
    const root = join(work, "runtime");
    mkdirSync(extracted, { recursive: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "lib"), { recursive: true });
    execFileSync("tar", ["-xf", nodeArchive, "-C", extracted]);
    // The remote extractor rejects every link entry before unpacking. Materialize
    // official Node and pnpm package links into ordinary files/directories while
    // refusing any link whose real target leaves its own source tree.
    copyTreeMaterialized(singleExtractedRoot(extracted), join(root, "node"));
    for (const entry of REQUIRED_RESOURCES) {
      copyTreeMaterialized(join(resources, entry), join(root, "lib", entry));
    }
    if (targetPlatform === "darwin") {
      copyTreeMaterialized(nativePath, join(root, "lib", "native"));
    }
    // One platform's scanner per runtime: drop any copy the shared resources
    // carry for the app, then stage exactly this target's verified build.
    rmSync(join(root, "lib", "native", "betterleaks"), { recursive: true, force: true });
    stagePlatform(
      options.target,
      resolve(options["betterleaks-archive"]),
      join(root, "lib", "native"),
    );

    writeFileSync(
      join(root, "bin", "claudexor"),
      remoteRuntimeShellWrapper(
        'export CLAUDEXOR_DAEMON_ENTRY="$RUNTIME_DIR/lib/claudexord.bundle.cjs"\n' +
          `export CLAUDEXOR_BUILD_SHA='${options["build-sha"]}'\n` +
          'exec "$RUNTIME_DIR/node/bin/node" "$RUNTIME_DIR/lib/claudexor.bundle.cjs" "$@"',
      ),
      { mode: 0o755 },
    );
    writeFileSync(
      join(root, "bin", "claudexord"),
      remoteRuntimeShellWrapper(
        `export CLAUDEXOR_BUILD_SHA='${options["build-sha"]}'\n` +
          'exec "$RUNTIME_DIR/node/bin/node" "$RUNTIME_DIR/lib/claudexord.bundle.cjs" "$@"',
      ),
      { mode: 0o755 },
    );
    writeFileSync(
      join(root, "runtime.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          version: options.version,
          buildSha: options["build-sha"],
          protocolMajor: 3,
          target: options.target,
          nodeVersion: options["node-version"],
        },
        null,
        2,
      )}\n`,
      { mode: 0o644 },
    );
    assertLinkFreeExtractedTree(root);

    const out = resolve(options.out);
    mkdirSync(out, { recursive: true });
    const archiveName = remoteRuntimeArchiveName(options.version, options.target);
    const archivePath = join(out, archiveName);
    rmSync(archivePath, { force: true });
    execFileSync("tar", ["-czf", archivePath, "-C", root, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    if (!existsSync(archivePath) || statSync(archivePath).size === 0) {
      throw new Error("runtime archive was not created");
    }
    execFileSync(
      process.execPath,
      [new URL("./verify-remote-runtime-archive.mjs", import.meta.url).pathname, archivePath],
      { stdio: "inherit" },
    );
    const [platform, arch] = options.target.split("-");
    const metadata = {
      target: options.target,
      platform,
      arch,
      nodeVersion: options["node-version"],
      archiveName,
      archiveUrl: remoteRuntimeArchiveUrl(options.version, options.target),
      sha256: sha256(archivePath),
    };
    const metadataPath = join(out, `${basename(archiveName, ".tar.gz")}.json`);
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644 });
    process.stdout.write(`${JSON.stringify({ archivePath, metadataPath, ...metadata })}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`build-remote-runtime failed: ${String(error)}\n`);
  process.exit(1);
}
