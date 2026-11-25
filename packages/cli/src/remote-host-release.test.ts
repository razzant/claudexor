import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { CliError } from "./cli-error.js";
import { notActivated } from "./remote-host-install.js";
import { signRemoteRuntimeManifest } from "../../../scripts/lib/remote-runtime-manifest-contract.mjs";
import {
  REMOTE_RUNTIME_TARGETS,
  remoteRuntimeArchiveName,
  remoteRuntimeArchiveUrl,
} from "./remote-host-manifest.js";
import { downloadVerifiedArchive, readSignedRelease } from "./remote-host-release.js";

// Only the archive's chunk write fails, and only while a test asks; open and close stay real.
const fault = vi.hoisted(() => ({ write: null as Error | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const error = fault.write;
      if (!error) return handle;
      return {
        writeFile: async () => {
          throw error;
        },
        close: () => handle.close(),
      } as unknown as Awaited<ReturnType<typeof actual.open>>;
    },
  };
});

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

describe("downloading the signed archive", () => {
  async function signedAsset() {
    const { text, authority } = signedManifest();
    const fetchImpl = (async () => new Response(text)) as typeof fetch;
    const read = await readSignedRelease("linux-x64", { fetchImpl, authority, version: VERSION });
    if (!read.ok) throw new Error(read.message);
    return read.release.asset;
  }

  it("keeps a local write fault this computer's own typed cause, never a network break", async () => {
    const asset = await signedAsset();
    const diskFull = Object.assign(new Error("ENOSPC: no space left on device, write"), {
      code: "ENOSPC",
      syscall: "write",
    });
    const fetchImpl = (async () => new Response("runtime archive bytes")) as typeof fetch;
    fault.write = diskFull;
    try {
      await expect(downloadVerifiedArchive(asset, { fetchImpl })).rejects.toBe(diskFull);
    } finally {
      fault.write = null;
    }
    const reported = notActivated(diskFull) as CliError;
    expect(reported).toMatchObject({ code: "ENOSPC", context: { activated: false } });
    expect(reported.message).not.toContain(tmpdir());
  });

  it("still calls a stream that broke off unavailable and accepts no unconfirmed digest", async () => {
    const asset = await signedAsset();
    const broken = (async () => new Response(brokenBody("partial"))) as typeof fetch;
    await expect(downloadVerifiedArchive(asset, { fetchImpl: broken })).rejects.toMatchObject({
      code: "release_unavailable",
      retryable: true,
    });
    const whole = (async () => new Response("bytes the signature does not name")) as typeof fetch;
    await expect(downloadVerifiedArchive(asset, { fetchImpl: whole })).rejects.toMatchObject({
      code: "release_unverified",
    });
  });
});
