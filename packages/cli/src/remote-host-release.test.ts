import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signRemoteRuntimeManifest } from "../../../scripts/lib/remote-runtime-manifest-contract.mjs";
import {
  REMOTE_RUNTIME_TARGETS,
  remoteRuntimeArchiveName,
  remoteRuntimeArchiveUrl,
} from "./remote-host-manifest.js";
import { readSignedRelease } from "./remote-host-release.js";

const VERSION = "9.0.1";

/** A manifest signed by a throwaway key, injected through the test-only seam. */
function signedManifest() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const authority = {
    keyId: "claudexor-remote-release-test-only",
    algorithm: "Ed25519" as const,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const manifest = signRemoteRuntimeManifest(
    {
      version: VERSION,
      buildSha: "ab".repeat(20),
      protocolMajor: 3,
      minAppVersion: VERSION,
      notes: "",
      assets: REMOTE_RUNTIME_TARGETS.map((target) => ({
        target,
        platform: target.split("-")[0] as "linux" | "darwin",
        arch: target.split("-")[1] as "x64" | "arm64",
        nodeVersion: "24.22.3",
        archiveName: remoteRuntimeArchiveName(VERSION, target),
        archiveUrl: remoteRuntimeArchiveUrl(VERSION, target),
        sha256: "c".repeat(64),
      })),
    },
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    authority,
  );
  return { text: JSON.stringify(manifest), authority };
}

/** A body that delivers `head` and then breaks off, as a dropped connection does. */
function brokenBody(head: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(head));
      controller.error(new Error("the connection was reset"));
    },
  });
}

async function readWith(response: () => Response) {
  const { authority } = signedManifest();
  const fetchImpl = (async () => response()) as typeof fetch;
  return readSignedRelease("linux-x64", { fetchImpl, authority, version: VERSION });
}

describe("reading the signed release manifest", () => {
  it("accepts the whole signed manifest", async () => {
    const { text, authority } = signedManifest();
    const fetchImpl = (async () => new Response(text)) as typeof fetch;
    const read = await readSignedRelease("linux-x64", { fetchImpl, authority, version: VERSION });
    expect(read).toMatchObject({ ok: true, release: { asset: { target: "linux-x64" } } });
  });

  it("calls a manifest that never arrived whole unavailable, never unverified", async () => {
    const { text } = signedManifest();
    for (const response of [
      () => new Response(brokenBody(text.slice(0, 40))),
      () => new Response("not found", { status: 404 }),
      () => new Response("busy", { status: 503 }),
    ]) {
      expect(await readWith(response)).toMatchObject({ ok: false, code: "release_unavailable" });
    }
  });

  it("calls a document it received and cannot accept unverified", async () => {
    for (const response of [
      () => new Response("not a manifest"),
      () => new Response(JSON.stringify({ kind: "something else" })),
      () => new Response("x".repeat(1024 * 1024 + 1)),
    ]) {
      expect(await readWith(response)).toMatchObject({ ok: false, code: "release_unverified" });
    }
  });
});
