/**
 * The signed release a controller-side install offers: the remote runtime
 * manifest of THIS CLI's exact version, verified against the pinned
 * runtime-update authority, and its archive, hashed while it is downloaded.
 * The shipped command has no way to name another manifest, key or archive.
 * `release_unavailable` means nothing whole was received (no answer, an HTTP
 * error, a body that broke off); `release_unverified` means a received
 * document or archive failed its checks.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDEXOR_VERSION,
  compareRuntimeSemver,
  type RuntimeUpdateAuthority,
} from "@claudexor/util";
import { CliError } from "./cli-error.js";
import { errorText, remoteHostFailure } from "./remote-host-facts.js";
import {
  type RemoteRuntimeAsset,
  type RemoteRuntimeManifest,
  type RemoteRuntimeTarget,
  remoteRuntimeManifestUrl,
  verifyRemoteRuntimeManifest,
} from "./remote-host-manifest.js";

/** TEST-ONLY seams: production passes none of them, so the manifest is the
 * published one for CLAUDEXOR_VERSION and the key is the pinned authority. */
export interface ReleaseSource {
  fetchImpl?: typeof fetch;
  authority?: RuntimeUpdateAuthority;
  version?: string;
  /** Not a test seam: the operation's lifetime; aborting it ends a fetch. */
  signal?: AbortSignal;
}

function fetchSignal(source: ReleaseSource, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return source.signal ? AbortSignal.any([source.signal, timeout]) : timeout;
}

export interface SignedRelease {
  manifest: RemoteRuntimeManifest;
  asset: RemoteRuntimeAsset;
}

export type ReleaseRead =
  | { ok: true; release: SignedRelease }
  | { ok: false; code: "release_unavailable" | "release_unverified"; message: string };

const MANIFEST_TIMEOUT_MS = 30_000;
const ARCHIVE_TIMEOUT_MS = 60 * 60_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

/** The whole body, counted in bytes while it streams, or null as soon as it
 * passes `maxBytes`, before anything larger is buffered. A stream that breaks
 * off (the connection, a timeout, a cancellation) throws: then no document
 * was received at all. */
async function boundedBody(response: Response, maxBytes: number): Promise<Buffer | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxBytes) return null;
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

export async function readSignedRelease(
  target: RemoteRuntimeTarget,
  source: ReleaseSource,
): Promise<ReleaseRead> {
  const version = source.version ?? CLAUDEXOR_VERSION;
  const url = remoteRuntimeManifestUrl(version);
  const unavailable = (message: string): ReleaseRead => ({
    ok: false,
    code: "release_unavailable",
    message,
  });
  const unverified = (message: string): ReleaseRead => ({
    ok: false,
    code: "release_unverified",
    message,
  });
  let response: Response;
  try {
    response = await (source.fetchImpl ?? fetch)(url, {
      signal: fetchSignal(source, MANIFEST_TIMEOUT_MS),
    });
  } catch (error) {
    return unavailable(`${url} could not be read: ${errorText(error)}`);
  }
  if (response.status === 404) {
    return unavailable(`Claudexor ${version} has no published signed remote runtime (${url})`);
  }
  if (!response.ok) return unavailable(`${url} answered HTTP ${response.status}`);
  // A body that broke off is no document: unavailable, never a refuted one.
  let body: Buffer | null;
  try {
    body = await boundedBody(response, MAX_MANIFEST_BYTES);
  } catch (error) {
    return unavailable(`${url} could not be read to its end: ${errorText(error)}`);
  }
  if (body === null) return unverified(`${url} is larger than ${MAX_MANIFEST_BYTES} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    return unverified(`${url} is not a manifest: ${errorText(error)}`);
  }
  const verdict = verifyRemoteRuntimeManifest(value, source.authority, {
    expectVersion: version,
  });
  if (!verdict.ok) return unverified(`${url} failed verification: ${verdict.reasons.join("; ")}`);
  if (compareRuntimeSemver(verdict.manifest.minAppVersion, version) > 0) {
    return unverified(`${url} requires Claudexor ${verdict.manifest.minAppVersion}`);
  }
  // The verifier requires all four ordered targets, so the asset exists.
  const asset = verdict.manifest.assets.find((candidate) => candidate.target === target)!;
  return { ok: true, release: { manifest: verdict.manifest, asset } };
}

/** Download the asset into a new private temporary directory while hashing the
 * same bytes; refuse anything but the signed digest. The caller removes `dir`.
 * A chunk this computer cannot write throws its own Node error (see the
 * install's notActivated), never `release_unavailable`. */
export async function downloadVerifiedArchive(
  asset: RemoteRuntimeAsset,
  source: ReleaseSource,
): Promise<{ dir: string; file: string }> {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-remote-runtime-"));
  const file = join(dir, asset.archiveName);
  const hash = createHash("sha256");
  let size = 0;
  try {
    let response: Response;
    try {
      response = await (source.fetchImpl ?? fetch)(asset.archiveUrl, {
        signal: fetchSignal(source, ARCHIVE_TIMEOUT_MS),
      });
    } catch (error) {
      throw remoteHostFailure(
        "release_unavailable",
        `${asset.archiveUrl} could not be downloaded: ${errorText(error)}`,
        { retryable: true },
      );
    }
    if (!response.ok || !response.body) {
      throw remoteHostFailure(
        "release_unavailable",
        `${asset.archiveUrl} answered HTTP ${response.status}`,
        { retryable: true },
      );
    }
    const out = await open(file, "wx", 0o600);
    let writing = false;
    try {
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > MAX_ARCHIVE_BYTES) {
          throw remoteHostFailure(
            "release_unverified",
            `${asset.archiveName} is larger than any runtime archive`,
          );
        }
        hash.update(chunk);
        writing = true;
        await out.writeFile(chunk);
        writing = false;
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      // A local write fault is this computer's, never the release's: its Node
      // error keeps its code and call, which notActivated reports without the path.
      if (writing) throw error;
      throw remoteHostFailure(
        "release_unavailable",
        `${asset.archiveUrl} download failed: ${errorText(error)}`,
        { retryable: true },
      );
    } finally {
      await out.close();
    }
    const digest = hash.digest("hex");
    if (digest !== asset.sha256) {
      throw remoteHostFailure(
        "release_unverified",
        `${asset.archiveName} has digest ${digest}, not the signed ${asset.sha256}`,
      );
    }
    return { dir, file };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
