import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RUNTIME_UPDATE_AUTHORITY } from "@claudexor/util";
import {
  REMOTE_RUNTIME_TARGETS as MJS_TARGETS,
  remoteRuntimeManifestSigningBytes as mjsSigningBytes,
  signRemoteRuntimeManifest,
} from "../../../scripts/lib/remote-runtime-manifest-contract.mjs";
import {
  REMOTE_RUNTIME_TARGETS,
  remoteRuntimeArchiveName,
  remoteRuntimeArchiveUrl,
  remoteRuntimeManifestSigningBytes,
  remoteRuntimeManifestUrl,
  verifyRemoteRuntimeManifest,
} from "./remote-host-manifest.js";

/** A throwaway signing key per run: the test-only authority is injected
 * through the verifier's parameter, never through the shipped command. */
function testAuthority() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    authority: {
      keyId: "claudexor-remote-install-test-only",
      algorithm: "Ed25519" as const,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  };
}

function signed(version = "9.0.1") {
  const { privateKeyPem, authority } = testAuthority();
  const manifest = signRemoteRuntimeManifest(
    {
      version,
      buildSha: "ab".repeat(20),
      protocolMajor: 3,
      minAppVersion: version,
      notes: "",
      assets: REMOTE_RUNTIME_TARGETS.map((target) => ({
        target,
        platform: target.split("-")[0] as "linux" | "darwin",
        arch: target.split("-")[1] as "x64" | "arm64",
        nodeVersion: "24.22.3",
        archiveName: remoteRuntimeArchiveName(version, target),
        archiveUrl: remoteRuntimeArchiveUrl(version, target),
        sha256: "c".repeat(64),
      })),
    },
    privateKeyPem,
    authority,
  );
  return { typed: manifest, manifest: manifest as unknown as Record<string, unknown>, authority };
}

describe("remote runtime manifest in the npm CLI", () => {
  it("signs the same bytes as the release tooling and verifies its signature", () => {
    const { typed, manifest, authority } = signed();
    expect(REMOTE_RUNTIME_TARGETS).toEqual(MJS_TARGETS);
    expect(remoteRuntimeManifestSigningBytes(manifest).equals(mjsSigningBytes(typed))).toBe(true);
    const verdict = verifyRemoteRuntimeManifest(manifest, authority, { expectVersion: "9.0.1" });
    expect(verdict.ok).toBe(true);
    expect(remoteRuntimeManifestUrl("9.0.1")).toBe(
      "https://github.com/razzant/claudexor/releases/download/v9.0.1/remote-runtime-manifest.json",
    );
  });

  it("refuses a foreign key, a changed field, an extra field and another version", () => {
    const { manifest, authority } = signed();
    const pinned = verifyRemoteRuntimeManifest(manifest);
    expect(pinned.ok).toBe(false);
    expect(RUNTIME_UPDATE_AUTHORITY.keyId).not.toBe(authority.keyId);
    const assets = manifest["assets"] as Record<string, unknown>[];
    const tampered = {
      ...manifest,
      assets: assets.map((asset, index) =>
        index === 0 ? { ...asset, sha256: "d".repeat(64) } : asset,
      ),
    };
    expect(verifyRemoteRuntimeManifest(tampered, authority)).toEqual({
      ok: false,
      reasons: ["signature is invalid for the pinned key"],
    });
    const extra = verifyRemoteRuntimeManifest({ ...manifest, mirror: "https://x" }, authority);
    expect(extra.ok).toBe(false);
    const extraAsset = verifyRemoteRuntimeManifest(
      { ...manifest, assets: assets.map((asset) => ({ ...asset, size: 1 })) },
      authority,
    );
    expect(extraAsset.ok).toBe(false);
    const otherVersion = verifyRemoteRuntimeManifest(manifest, authority, {
      expectVersion: "9.0.2",
    });
    expect(otherVersion.ok).toBe(false);
    expect(verifyRemoteRuntimeManifest("not a manifest", authority).ok).toBe(false);
  });
});
