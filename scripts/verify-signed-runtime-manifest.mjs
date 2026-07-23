#!/usr/bin/env node
/**
 * Publish-side verification of the OWNER-SIGNED runtime-update manifest (D-2).
 *
 * The candidate workflow builds the closure + an UNSIGNED manifest. The owner
 * signs it OFFLINE against the exact promoted-artifact digest. The publish
 * workflow feeds the signed manifest here and this script REFUSES to ship it
 * unless, fail-closed:
 *   - its Ed25519 signature verifies against the PINNED runtime-update authority
 *     (release/runtime-update-authority.json),
 *   - its signed `sha256` byte-matches the shipped tarball's actual digest
 *     (byte-identity of the promoted artifact),
 *   - its signed non-secret fields equal the freshly-built UNSIGNED manifest
 *     (version, minAppVersion, archiveName, buildSha) so a signature can only
 *     ever bind the artifact this run actually built.
 * On success it prints OK; the workflow then ships the SIGNED manifest as the
 * runtime-manifest.json release asset.
 *
 *   node scripts/verify-signed-runtime-manifest.mjs \
 *     --signed   SIGNED.json \
 *     --unsigned "$RUNNER_TEMP/runtime-closure/runtime-manifest.json" \
 *     --tarball  "$RUNNER_TEMP/runtime-closure/claudexor-runtime-$VERSION.tar.gz" \
 *     --version  "$VERSION"
 */
import { readFileSync } from "node:fs";
import { verifyRuntimeManifest, sha256Hex } from "./lib/runtime-manifest-contract.mjs";

const options = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i]?.startsWith("--")) fail(`bad argument: ${argv[i]}`);
  options[argv[i].slice(2)] = argv[i + 1];
}
for (const name of ["signed", "unsigned", "tarball", "version"]) {
  if (!options[name]) fail(`missing --${name}`);
}

try {
  const authority = JSON.parse(readFileSync("release/runtime-update-authority.json", "utf8"));
  const signed = JSON.parse(readFileSync(options.signed, "utf8"));
  const unsigned = JSON.parse(readFileSync(options.unsigned, "utf8"));

  const verdict = verifyRuntimeManifest(signed, authority, { expectVersion: options.version });
  if (!verdict.ok)
    fail(`signed manifest failed pinned-authority verification: ${verdict.reasons.join("; ")}`);

  const actualSha = sha256Hex(readFileSync(options.tarball));
  if (signed.sha256 !== actualSha) {
    fail(`signed sha256 ${signed.sha256} does not match the shipped tarball digest ${actualSha}`);
  }
  for (const field of ["version", "sha256", "minAppVersion", "archiveName", "buildSha"]) {
    if (signed[field] !== unsigned[field]) {
      fail(
        `signed manifest ${field} (${signed[field]}) does not match the built closure (${unsigned[field]})`,
      );
    }
  }
  console.log(
    `signed runtime manifest verified: v${signed.version} sha256=${signed.sha256} keyId=${signed.keyId}`,
  );
} catch (error) {
  fail(String(error));
}

function fail(message) {
  console.error(`::error::signed runtime manifest refused: ${message}`);
  process.exit(1);
}
