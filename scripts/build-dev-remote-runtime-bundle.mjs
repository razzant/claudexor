#!/usr/bin/env node
/**
 * Build a complete four-target SSH runtime package for a local ad-hoc-signed
 * (non-Developer-ID) Claudexor.app. The package is signed with an ephemeral
 * Ed25519 authority whose public half is bundled beside the manifest; the
 * private half exists only in this process and is never written.
 *
 * Production builds must never consume this source. build-app.sh compiles the
 * reader behind CLAUDEXOR_DEV_REMOTE_RUNTIME and refuses that flag together
 * with SIGN_IDENTITY.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  REMOTE_RUNTIME_PROTOCOL_MAJOR,
  REMOTE_RUNTIME_TARGETS,
  signRemoteRuntimeManifest,
  verifyRemoteRuntimeManifest,
} from "./lib/remote-runtime-manifest-contract.mjs";
import { downloadArchive, pinnedRelease } from "./lib/betterleaks-stage.mjs";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function checkedNodeArchive({ target, nodeVersion, expectedSha256, cacheDirectory }) {
  const name = `node-v${nodeVersion}-${target}.tar.gz`;
  const path = join(cacheDirectory, name);
  if (existsSync(path) && sha256File(path) !== expectedSha256) {
    rmSync(path, { force: true });
  }
  if (!existsSync(path)) {
    const temporary = `${path}.download-${process.pid}`;
    const url = `https://nodejs.org/dist/v${nodeVersion}/${name}`;
    rmSync(temporary, { force: true });
    try {
      execFileSync(
        "/usr/bin/curl",
        ["--fail", "--location", "--retry", "3", "--output", temporary, url],
        { stdio: "inherit" },
      );
      if (sha256File(temporary) !== expectedSha256) {
        throw new Error(`${target} Node archive does not match the pinned SHA-256`);
      }
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  if (!statSync(path).isFile() || sha256File(path) !== expectedSha256) {
    throw new Error(`${target} Node archive cache entry is invalid`);
  }
  return path;
}

/** The pinned publication-scanner archive for one target, cached like Node. */
async function checkedScannerArchive({ target, cacheDirectory }) {
  const release = pinnedRelease(target);
  const path = join(cacheDirectory, release.asset);
  if (existsSync(path) && sha256File(path) !== release.archiveSha256) rmSync(path, { force: true });
  if (!existsSync(path)) await downloadArchive(target, cacheDirectory);
  if (sha256File(path) !== release.archiveSha256) {
    throw new Error(`${target} Betterleaks archive does not match the pinned SHA-256`);
  }
  return path;
}

async function main() {
  const version = option("version");
  const buildSha = option("build-sha");
  const resources = option("resources");
  const output = option("out");
  if (!version || !buildSha || !resources || !output) {
    throw new Error(
      "usage: build-dev-remote-runtime-bundle.mjs --version X --build-sha SHA --resources DIR --out DIR",
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("invalid --version");
  if (!/^[0-9a-f]{40}$/.test(buildSha)) throw new Error("invalid --build-sha");

  const out = resolve(output);
  if (basename(out) !== "remote-runtime-dev") {
    throw new Error("--out must end in remote-runtime-dev");
  }
  if (existsSync(out)) throw new Error("development remote runtime output already exists");
  const assetsDirectory = join(out, "assets");
  mkdirSync(assetsDirectory, { recursive: true, mode: 0o700 });

  const nodeLock = JSON.parse(
    readFileSync(new URL("./remote-node-sha256.json", import.meta.url), "utf8"),
  );
  const nodeVersion = nodeLock.nodeVersion;
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) {
    throw new Error("pinned remote Node version is invalid");
  }
  const cacheDirectory = join(
    homedir(),
    "Library",
    "Caches",
    "Claudexor",
    "remote-runtime-build",
    nodeVersion,
  );
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });

  const metadata = [];
  for (const target of REMOTE_RUNTIME_TARGETS) {
    const expectedSha256 = nodeLock.assets?.[target];
    if (!/^[0-9a-f]{64}$/.test(expectedSha256 ?? "")) {
      throw new Error(`missing pinned Node digest for ${target}`);
    }
    const nodeArchive = checkedNodeArchive({
      target,
      nodeVersion,
      expectedSha256,
      cacheDirectory,
    });
    const scannerArchive = await checkedScannerArchive({ target, cacheDirectory });
    execFileSync(
      process.execPath,
      [
        new URL("./build-remote-runtime.mjs", import.meta.url).pathname,
        "--target",
        target,
        "--version",
        version,
        "--build-sha",
        buildSha,
        "--resources",
        resolve(resources),
        "--node-archive",
        nodeArchive,
        "--node-sha256",
        expectedSha256,
        "--node-version",
        nodeVersion,
        "--betterleaks-archive",
        scannerArchive,
        "--out",
        assetsDirectory,
      ],
      { stdio: "inherit" },
    );
    metadata.push(
      JSON.parse(
        readFileSync(
          join(assetsDirectory, `claudexor-remote-runtime-${version}-${target}.json`),
          "utf8",
        ),
      ),
    );
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = String(publicKey.export({ type: "spki", format: "pem" }));
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const authority = {
    schemaVersion: 1,
    keyId: `claudexor-dev-remote-runtime-ed25519-${sha256Bytes(publicKeyDer).slice(0, 16)}`,
    algorithm: "Ed25519",
    role: "development-remote-runtime",
    publicKeyPem,
  };
  const unsigned = {
    schemaVersion: 1,
    kind: "claudexor-remote-runtime",
    version,
    buildSha,
    protocolMajor: REMOTE_RUNTIME_PROTOCOL_MAJOR,
    minAppVersion: version,
    notes: `Local ad-hoc-signed (non-Developer-ID) Claudexor.app development SSH runtime ${version}.`,
    assets: metadata,
    keyId: "unsigned",
    algorithm: "Ed25519",
  };
  const privateKeyPem = String(privateKey.export({ type: "pkcs8", format: "pem" }));
  const manifest = signRemoteRuntimeManifest(unsigned, privateKeyPem, authority);
  const verification = verifyRemoteRuntimeManifest(manifest, authority);
  if (!verification.ok) {
    throw new Error(
      `development manifest self-verification failed: ${verification.reasons.join("; ")}`,
    );
  }
  mkdirSync(dirname(join(out, "authority.json")), { recursive: true });
  writeFileSync(join(out, "authority.json"), `${JSON.stringify(authority, null, 2)}\n`, {
    mode: 0o644,
    flag: "wx",
  });
  writeFileSync(
    join(out, "remote-runtime-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644, flag: "wx" },
  );
  process.stdout.write(
    `development remote runtime: ${REMOTE_RUNTIME_TARGETS.length} targets, authority ${authority.keyId}\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`build-dev-remote-runtime-bundle failed: ${String(error)}\n`);
  process.exit(1);
}
