import { harnessBinaryIdentityOnPath } from "@claudexor/core";
/**
 * The client version Claudexor's OWN Codex HTTP transport declares when it reads
 * an account's model catalog (`GET /backend-api/codex/models?client_version=…`).
 *
 * The Codex backend varies that catalog by the declared client version;
 * `minimal_client_version` alone does not explain which rows it returns.
 * Discovery and generation are distinct: a valid catalog miss is advisory,
 * while acquisition failures retain their own typed outcome. The URL once carried the
 * managed-installer pin (`CODEX_VENDOR_CLI_VERSION`), so a release that only
 * moved the installer decided which models an account could see through this
 * transport (issue #339). The two meanings are separate now:
 *
 * - `CODEX_HTTP_CLIENT_VERSION` is the Codex client version this release's
 *   catalog parser (`parseCodexModelCatalog`) and Responses projection were
 *   verified against. Bump it together with a recorded catalog fixture pair
 *   (see `fixtures/models-http-*.json`), never with the installer pin.
 * - The installed Codex CLI, when it is NEWER than that constant, is the
 *   vendor's own runtime on this host and raises the declared version (owner
 *   decision 2026-09-24, Q2=A): updating Codex is then the one action that
 *   advances both the native agent path and this transport. The declared
 *   version never drops below the constant, and a version string this module
 *   cannot parse falls back to the constant, because `client_version` is a
 *   REQUIRED query parameter (omitting or garbling it is an HTTP 400 that would
 *   take every model operation down).
 *
 * The resolved value is memoised per binary identity (realpath + inode + size
 * + mtime) so an in-place upgrade of the CLI is seen on the next catalog read
 * without a daemon restart, while the hot path pays one `stat`, never a spawn.
 */

import type { ControlModelCatalogResponse } from "@claudexor/schema";
import type { VendorCliVersionStamp } from "@claudexor/util";
import { resolveCodexBin, detectVersion, probeEnv } from "./missing-cli.js";

export const CODEX_HTTP_CLIENT_VERSION: VendorCliVersionStamp = "0.156.1";

export type CodexCatalogClientVersion = {
  version: string;
  source: NonNullable<ControlModelCatalogResponse["clientVersionSource"]>;
};

export interface CodexClientVersionDeps {
  /** Binary the transport spawns for token refresh; the version it reports is the one raised. */
  bin?: string;
  env?: NodeJS.ProcessEnv;
  /** `codex --version` capture for that env; null on any failure. */
  detectVersion?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  nowMs?: () => number;
}

type VersionTriple = readonly [number, number, number];

/** First strict `major.minor.patch` token of a `codex --version` line; a
 * pre-release suffix is dropped exactly as the vendor's own client does
 * (`client_version_to_whole`). Anything else is not a version. */
export function codexVersionTriple(text: string | null | undefined): VersionTriple | null {
  const match = /(?:^|[^\d.])(\d+)\.(\d+)\.(\d+)(?![\d.])/.exec(text ?? "");
  if (!match) return null;
  const triple = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return triple.every((part) => Number.isSafeInteger(part)) ? triple : null;
}

function compareTriples(a: VersionTriple, b: VersionTriple): number {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

const VERIFIED: CodexCatalogClientVersion = {
  version: CODEX_HTTP_CLIENT_VERSION,
  source: "verified_transport",
};
const DETECTION_FAILURE_MEMO_MS = 60_000;

interface ClientVersionMemoEntry {
  value: CodexCatalogClientVersion;
  /** Present only for a failed detection, which is retried after this time. */
  expiresAtMs?: number;
}
const memo = new Map<string, ClientVersionMemoEntry>();

/** Drop the memo (tests). */
export function clearCodexClientVersionMemo(): void {
  memo.clear();
}

/** The bytes the transport would spawn: realpath + inode + size + mtime. A
 * reinstall or a re-pointed symlink changes at least one part. */
function binaryIdentityKey(bin: string, env: NodeJS.ProcessEnv): string | null {
  const identity = harnessBinaryIdentityOnPath(bin, env.PATH ?? "");
  return identity ? JSON.stringify(identity) : null;
}

/** The version the catalog read declares: the verified transport level, raised
 * to the installed CLI's version when that is newer. Never below the constant,
 * never an unparseable string. */
export async function codexCatalogClientVersion(
  deps: CodexClientVersionDeps = {},
): Promise<CodexCatalogClientVersion> {
  const env = deps.env ?? probeEnv();
  const nowMs = deps.nowMs ?? Date.now;
  const key = binaryIdentityKey(deps.bin ?? resolveCodexBin(), env);
  // No runnable CLI on this PATH: the transport still works (the token refresh
  // fails on its own terms later); declare the verified level.
  if (key === null) return VERIFIED;
  const cached = memo.get(key);
  if (cached && (cached.expiresAtMs === undefined || cached.expiresAtMs > nowMs())) {
    return cached.value;
  }
  const detect =
    deps.detectVersion ?? ((probe: NodeJS.ProcessEnv) => detectVersion(undefined, probe));
  const installed = codexVersionTriple(await detect(env));
  if (installed === null) {
    memo.set(key, { value: VERIFIED, expiresAtMs: nowMs() + DETECTION_FAILURE_MEMO_MS });
    return VERIFIED;
  }
  const verified = codexVersionTriple(CODEX_HTTP_CLIENT_VERSION)!;
  const value: CodexCatalogClientVersion =
    compareTriples(installed, verified) > 0
      ? { version: installed.join("."), source: "installed_cli" }
      : VERIFIED;
  memo.set(key, { value });
  return value;
}

/** One phrasing of the declared client version for refusals and diagnostics,
 * shared by every gate that judges a model against this catalog. */
export function describeCodexClientVersion(
  catalog: Pick<ControlModelCatalogResponse, "clientVersion" | "clientVersionSource">,
): string {
  if (!catalog.clientVersion) return "an undeclared client_version (catalog from an older engine)";
  const origin =
    catalog.clientVersionSource === "installed_cli"
      ? "the installed Codex CLI"
      : "the version this Claudexor release verified its Codex HTTP transport against";
  return `client_version ${catalog.clientVersion} (${origin})`;
}
