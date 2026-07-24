import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_UPDATE_AUTHORITY,
  canonicalJson,
  isMonotonicRuntimeUpgrade,
  runtimeArchiveName,
  runtimeManifestSigningBytes,
  verifyRuntimeManifest,
  type SignedRuntimeManifest,
} from "./runtime-manifest.js";
// The release-tooling mirror. A test may import scripts/lib (excluded from the
// production build); production src never does.
import {
  runtimeManifestSigningBytes as mjsSigningBytes,
  signRuntimeManifest as mjsSign,
  verifyRuntimeManifest as mjsVerify,
} from "../../../scripts/lib/runtime-manifest-contract.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixtureDir = resolve(
  repoRoot,
  "apps/macos/ClaudexorKit/Tests/ClaudexorKitTests/Fixtures/runtime-update",
);
const TEST_AUTHORITY = JSON.parse(readFileSync(resolve(fixtureDir, "authority.json"), "utf8"));
const VALID: SignedRuntimeManifest = JSON.parse(
  readFileSync(resolve(fixtureDir, "valid-manifest.json"), "utf8"),
);

describe("runtime-update authority pin integrity", () => {
  it("embeds exactly the pinned release/runtime-update-authority.json key", () => {
    const file = JSON.parse(
      readFileSync(resolve(repoRoot, "release/runtime-update-authority.json"), "utf8"),
    );
    expect(RUNTIME_UPDATE_AUTHORITY.keyId).toBe(file.keyId);
    expect(RUNTIME_UPDATE_AUTHORITY.algorithm).toBe(file.algorithm);
    expect(RUNTIME_UPDATE_AUTHORITY.publicKeyPem).toBe(file.publicKeyPem);
  });

  it("is a SEPARATE key from the review-attestation authority (never crosses)", () => {
    const review = JSON.parse(
      readFileSync(resolve(repoRoot, "release/review-attestation-authority.json"), "utf8"),
    );
    expect(RUNTIME_UPDATE_AUTHORITY.keyId).not.toBe(review.keyId);
    expect(RUNTIME_UPDATE_AUTHORITY.publicKeyPem).not.toBe(review.publicKeyPem);
  });
});

describe("runtime-update manifest verify (fail-closed)", () => {
  it("accepts the valid signed test vector under its authority", () => {
    expect(verifyRuntimeManifest(VALID, TEST_AUTHORITY).ok).toBe(true);
  });

  it("refuses a tampered field (signature no longer matches)", () => {
    const bad = { ...VALID, sha256: "b".repeat(64) };
    const v = verifyRuntimeManifest(bad, TEST_AUTHORITY);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toContain("signature is invalid");
  });

  it("refuses an unknown signing key (keyId mismatch)", () => {
    const v = verifyRuntimeManifest(VALID, RUNTIME_UPDATE_AUTHORITY);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toContain("pinned runtime-update authority");
  });

  it("refuses a retargeted archiveName", () => {
    const bad = { ...VALID, archiveName: "claudexor-runtime-9.9.9.tar.gz" };
    expect(verifyRuntimeManifest(bad, TEST_AUTHORITY).ok).toBe(false);
  });

  it("refuses a redirected archiveUrl (D-2 URL binding)", () => {
    const bad = { ...VALID, archiveUrl: "https://evil.example/x.tar.gz" };
    const v = verifyRuntimeManifest(bad, TEST_AUTHORITY);
    expect(v.ok).toBe(false);
    // Either the URL-binding shape check OR the broken signature refuses it.
    expect(v.reasons.length).toBeGreaterThan(0);
  });

  it("refuses a wrong schemaVersion / bad buildSha / missing signature", () => {
    expect(verifyRuntimeManifest({ ...VALID, schemaVersion: 2 }, TEST_AUTHORITY).ok).toBe(false);
    expect(verifyRuntimeManifest({ ...VALID, buildSha: "unknown" }, TEST_AUTHORITY).ok).toBe(false);
    expect(verifyRuntimeManifest({ ...VALID, signature: "" }, TEST_AUTHORITY).ok).toBe(false);
    expect(verifyRuntimeManifest(null, TEST_AUTHORITY).ok).toBe(false);
  });
});

describe("monotonic anti-replay", () => {
  it("accepts a strictly-newer target and refuses a downgrade/equal", () => {
    expect(isMonotonicRuntimeUpgrade("3.4.0", ["3.0.0", "3.1.0"])).toBe(true);
    expect(isMonotonicRuntimeUpgrade("3.4.0", ["3.4.0"])).toBe(false);
    expect(isMonotonicRuntimeUpgrade("3.4.0", ["3.9.0"])).toBe(false);
  });
});

describe("TS ↔ release-tooling (mjs) parity", () => {
  it("produces byte-identical canonical signing bytes", () => {
    expect(runtimeManifestSigningBytes(VALID).toString("hex")).toBe(
      mjsSigningBytes(VALID).toString("hex"),
    );
  });

  it("cross-verifies: a manifest signed by the mjs signer verifies under the TS verifier", () => {
    const signed = mjsSign(
      {
        version: "3.5.0",
        sha256: "c".repeat(64),
        minAppVersion: "2.1.0",
        archiveName: runtimeArchiveName("3.5.0"),
        buildSha: "1111111111111111111111111111111111111111",
        notes: "parity vector",
      },
      // sign with the fixed test private key (public in the fixtures generator)
      TEST_PRIVATE_KEY_PEM,
      TEST_AUTHORITY,
    );
    expect(verifyRuntimeManifest(signed, TEST_AUTHORITY).ok).toBe(true);
    expect(mjsVerify(signed, TEST_AUTHORITY).ok).toBe(true);
  });

  it("canonicalJson matches across a nested value", () => {
    const v = { b: 1, a: [3, { z: 1, y: 2 }], c: null };
    expect(canonicalJson(v)).toBe('{"a":[3,{"y":2,"z":1}],"b":1,"c":null}');
  });
});

const TEST_PRIVATE_KEY_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJcml9Acg6+XssPo8BxmJyg1dTrW8oxBc7FgWTVsxOji\n-----END PRIVATE KEY-----\n";
