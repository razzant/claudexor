#!/usr/bin/env node
/**
 * Cross-language runtime-update signing TEST VECTORS (D-2). TS signs the fixture
 * here; the Swift updater test verifies the exact bytes (same discipline as the
 * TS↔Swift wire fixtures). Deterministic: a FIXED test keypair is baked in and
 * Ed25519 signatures are deterministic, so `--check` regenerates byte-identical
 * output with NO secret — the production offline key never touches this path.
 *
 * The verify LOGIC is exercised against this TEST authority; a SEPARATE
 * pin-integrity test (TS + Swift) asserts the embedded PRODUCTION public key
 * equals release/runtime-update-authority.json.
 *
 *   pnpm fixtures:runtime-update          # regenerate
 *   pnpm fixtures:runtime-update --check  # freshness gate
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { signRuntimeManifest, runtimeArchiveName } from "./lib/runtime-manifest-contract.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(
  repoRoot,
  "apps/macos/ClaudexorKit/Tests/ClaudexorKitTests/Fixtures/runtime-update",
);

// A FIXED, non-production test keypair. Publishing the private half is safe: it
// signs only public test vectors and is NEVER the pinned production authority.
const TEST_PRIVATE_KEY_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJcml9Acg6+XssPo8BxmJyg1dTrW8oxBc7FgWTVsxOji\n-----END PRIVATE KEY-----\n";
const TEST_AUTHORITY = {
  schemaVersion: 1,
  keyId: "claudexor-runtime-update-TESTVECTOR-ed25519",
  algorithm: "Ed25519",
  role: "runtime-update-test",
  publicKeyPem:
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPQA1OS9cjhmVsQC2T34MbYHoY7UeKyS3B6zoNy79Sm0=\n-----END PUBLIC KEY-----\n",
};

const version = "3.4.0";
const unsigned = {
  version,
  sha256: "a".repeat(64),
  minAppVersion: "2.1.0",
  archiveName: runtimeArchiveName(version),
  buildSha: "0123456789abcdef0123456789abcdef01234567",
  notes: "runtime-update signing test vector — never shipped",
};
const signed = signRuntimeManifest(unsigned, TEST_PRIVATE_KEY_PEM, TEST_AUTHORITY);

const files = {
  "authority.json": `${JSON.stringify(TEST_AUTHORITY, null, 2)}\n`,
  "valid-manifest.json": `${JSON.stringify(signed, null, 2)}\n`,
};

const check = process.argv.includes("--check");
let drift = 0;
mkdirSync(outDir, { recursive: true });
for (const [name, body] of Object.entries(files)) {
  const file = join(outDir, name);
  if (check) {
    const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (existing !== body) {
      console.error(
        `runtime-update fixture drift: ${name} (regenerate: pnpm fixtures:runtime-update)`,
      );
      drift += 1;
    }
  } else {
    writeFileSync(file, body);
  }
}
if (check) {
  if (drift > 0) process.exit(1);
  console.log(`runtime-update fixtures fresh (${Object.keys(files).length})`);
} else {
  console.log(`wrote ${Object.keys(files).length} runtime-update fixtures to ${outDir}`);
}
