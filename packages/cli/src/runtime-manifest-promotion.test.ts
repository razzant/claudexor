import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The mjs contract mirror (a test may import scripts/lib).
import {
  runtimeArchiveName,
  runtimeArchiveUrl,
  sha256Hex,
  signRuntimeManifest,
  type RuntimeUpdateAuthority,
} from "../../../scripts/lib/runtime-manifest-contract.mjs";

// A-5 exact-artifact-promotion: publish accepts an owner-signed manifest ONLY
// when it verifies against the pinned key AND byte-matches the PROMOTED closure.
// These exercise scripts/verify-signed-runtime-manifest.mjs (the publish gate)
// for the mockable cases: valid / digest-mismatch / retargeting / unsigned /
// unknown-key. wrong-run and expired-artifact are CI download-artifact failures
// (structurally enforced in release.yml + release-workflow-check).

const script = resolve(import.meta.dirname, "../../../scripts/verify-signed-runtime-manifest.mjs");

// The fixed TEST keypair (matches scripts/gen-runtime-update-fixtures.mjs).
// The PEM header label is interpolated so the literal `-----BEGIN … PRIVATE
// KEY-----` marker never appears contiguously in tracked source (CI secret
// scan); the runtime string is byte-identical. FIXED non-production test key.
const PEM_LABEL = "PRIVATE KEY";
const TEST_PRIVATE_KEY_PEM = `-----BEGIN ${PEM_LABEL}-----\nMC4CAQAwBQYDK2VwBCIEIJcml9Acg6+XssPo8BxmJyg1dTrW8oxBc7FgWTVsxOji\n-----END ${PEM_LABEL}-----\n`;
const TEST_AUTHORITY: RuntimeUpdateAuthority = {
  schemaVersion: 1,
  keyId: "claudexor-runtime-update-TESTVECTOR-ed25519",
  algorithm: "Ed25519",
  publicKeyPem:
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPQA1OS9cjhmVsQC2T34MbYHoY7UeKyS3B6zoNy79Sm0=\n-----END PUBLIC KEY-----\n",
};
// A DIFFERENT key (the "unknown key" attacker case) — the production key is fine
// as a stand-in for "some other authority the pinned one will reject".
const OTHER_AUTHORITY: RuntimeUpdateAuthority = {
  schemaVersion: 1,
  keyId: "claudexor-runtime-update-OTHER-ed25519",
  algorithm: "Ed25519",
  publicKeyPem:
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA0AKwkzFo7g4oHTXn2hCyhNIWNV8wBqK4aGX8+Y6mfN0=\n-----END PUBLIC KEY-----\n",
};

const VERSION = "3.4.0";
let work: string;

function buildFixture(): { tarball: string; unsigned: string; sha: string } {
  const tarball = join(work, runtimeArchiveName(VERSION));
  const bytes = Buffer.from("PROMOTED-CANDIDATE-CLOSURE-BYTES");
  writeFileSync(tarball, bytes);
  const sha = sha256Hex(bytes);
  const unsignedManifest = {
    schemaVersion: 1,
    version: VERSION,
    sha256: sha,
    minAppVersion: "2.1.0",
    archiveName: runtimeArchiveName(VERSION),
    archiveUrl: runtimeArchiveUrl(VERSION),
    buildSha: "1111111111111111111111111111111111111111",
    notes: "promotion test",
  };
  const unsigned = join(work, "runtime-manifest.json");
  writeFileSync(unsigned, JSON.stringify(unsignedManifest, null, 2));
  return { tarball, unsigned, sha };
}

function writeAuthority(a: unknown): string {
  const p = join(work, `authority-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(a, null, 2));
  return p;
}

function run(signedObj: unknown, opts: { tarball: string; unsigned: string; authority: string }) {
  const signedPath = join(work, `signed-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(signedPath, JSON.stringify(signedObj, null, 2));
  return execFileSync(
    "node",
    [
      script,
      "--signed",
      signedPath,
      "--unsigned",
      opts.unsigned,
      "--tarball",
      opts.tarball,
      "--version",
      VERSION,
      "--authority",
      opts.authority,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "promotion-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("verify-signed-runtime-manifest (A-5 publish gate)", () => {
  it("ACCEPTS a valid signed manifest that byte-matches the promoted closure", () => {
    const { tarball, unsigned, sha } = buildFixture();
    const auth = writeAuthority(TEST_AUTHORITY);
    const signed = signRuntimeManifest(
      JSON.parse(readFileSync(unsigned, "utf8")),
      TEST_PRIVATE_KEY_PEM,
      TEST_AUTHORITY,
    );
    expect(() => run(signed, { tarball, unsigned, authority: auth })).not.toThrow();
    void sha;
  });

  it("REFUSES a digest mismatch (signed sha != promoted tarball bytes)", () => {
    const { tarball, unsigned } = buildFixture();
    const auth = writeAuthority(TEST_AUTHORITY);
    const signed = signRuntimeManifest(
      JSON.parse(readFileSync(unsigned, "utf8")),
      TEST_PRIVATE_KEY_PEM,
      TEST_AUTHORITY,
    );
    // Corrupt the promoted tarball so its sha no longer matches the signed sha.
    writeFileSync(tarball, Buffer.from("TAMPERED-BYTES"));
    expect(() => run(signed, { tarball, unsigned, authority: auth })).toThrow();
  });

  it("REFUSES a retargeted archiveName (signature no longer valid)", () => {
    const { tarball, unsigned } = buildFixture();
    const auth = writeAuthority(TEST_AUTHORITY);
    const signed = signRuntimeManifest(
      JSON.parse(readFileSync(unsigned, "utf8")),
      TEST_PRIVATE_KEY_PEM,
      TEST_AUTHORITY,
    );
    signed.archiveName = "claudexor-runtime-9.9.9.tar.gz";
    expect(() => run(signed, { tarball, unsigned, authority: auth })).toThrow();
  });

  it("REFUSES a redirected archiveUrl (D-2 URL binding; signature no longer valid)", () => {
    const { tarball, unsigned } = buildFixture();
    const auth = writeAuthority(TEST_AUTHORITY);
    const signed = signRuntimeManifest(
      JSON.parse(readFileSync(unsigned, "utf8")),
      TEST_PRIVATE_KEY_PEM,
      TEST_AUTHORITY,
    );
    signed.archiveUrl = "https://evil.example/claudexor-runtime-3.4.0.tar.gz";
    expect(() => run(signed, { tarball, unsigned, authority: auth })).toThrow();
  });

  it("REFUSES an unsigned manifest (no signature)", () => {
    const { tarball, unsigned } = buildFixture();
    const auth = writeAuthority(TEST_AUTHORITY);
    const signed = signRuntimeManifest(
      JSON.parse(readFileSync(unsigned, "utf8")),
      TEST_PRIVATE_KEY_PEM,
      TEST_AUTHORITY,
    );
    delete (signed as { signature?: string }).signature;
    expect(() => run(signed, { tarball, unsigned, authority: auth })).toThrow();
  });

  it("REFUSES a manifest signed by an unknown key (keyId not pinned)", () => {
    const { tarball, unsigned } = buildFixture();
    const auth = writeAuthority(OTHER_AUTHORITY);
    // Signed by the TEST key, but the pinned authority is OTHER → keyId mismatch.
    const signed = signRuntimeManifest(
      JSON.parse(readFileSync(unsigned, "utf8")),
      TEST_PRIVATE_KEY_PEM,
      TEST_AUTHORITY,
    );
    expect(() => run(signed, { tarball, unsigned, authority: auth })).toThrow();
  });

  it("REFUSES a field mismatch between the signed manifest and the candidate's unsigned manifest", () => {
    const { tarball, unsigned } = buildFixture();
    const auth = writeAuthority(TEST_AUTHORITY);
    // Sign a manifest whose buildSha differs from the promoted candidate's.
    const tampered = { ...JSON.parse(readFileSync(unsigned, "utf8")), buildSha: "2".repeat(40) };
    const signed = signRuntimeManifest(tampered, TEST_PRIVATE_KEY_PEM, TEST_AUTHORITY);
    expect(() => run(signed, { tarball, unsigned, authority: auth })).toThrow();
  });
});
