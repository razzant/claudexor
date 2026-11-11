import { CODEX_PROGRAM } from "./program.js";
import type { HarnessProgramIdentity } from "@claudexor/schema";
import { observeHarnessProgram, harnessBinaryIdentityOnPath } from "@claudexor/core";
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
 * Reads use the shared file-identity observation. Inventory, fresh reads and
 * native startup frames refresh a version changed behind an unchanged wrapper.
 */

import type { ControlModelCatalogResponse } from "@claudexor/schema";
import type { VendorCliVersionStamp } from "@claudexor/util";
import { resolveCodexBin, probeEnv } from "./missing-cli.js";

export const CODEX_HTTP_CLIENT_VERSION: VendorCliVersionStamp = "0.156.1";

export type CodexCatalogClientVersion = {
  version: string;
  program?: HarnessProgramIdentity | null;
  source: NonNullable<ControlModelCatalogResponse["clientVersionSource"]>;
};

export interface CodexClientVersionDeps {
  /** Binary the transport spawns for token refresh; the version it reports is the one raised. */
  bin?: string;
  env?: NodeJS.ProcessEnv;
  /** `codex --version` capture for that env; null on any failure. */
  detectVersion?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
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
/** The version the catalog read declares: the verified transport level, raised
 * to the installed CLI's version when that is newer. Never below the constant,
 * never an unparseable string. */
export async function codexCatalogClientVersion(
  deps: CodexClientVersionDeps = {},
): Promise<CodexCatalogClientVersion> {
  const env = deps.env ?? probeEnv();
  const bin = deps.bin ?? resolveCodexBin();
  // Injection is used only by tests; production always uses the shared resolver.
  const identity = deps.detectVersion ? harnessBinaryIdentityOnPath(bin, env.PATH ?? "") : null;
  const observation = deps.detectVersion
    ? {
        program: identity
          ? { path: identity.launcher ?? identity.path, version: await deps.detectVersion(env) }
          : null,
      }
    : await observeHarnessProgram(CODEX_PROGRAM, env, bin);
  const program = observation.program;
  const installed = codexVersionTriple(program?.version);
  if (installed === null) return { ...VERIFIED, program };
  const verified = codexVersionTriple(CODEX_HTTP_CLIENT_VERSION)!;
  const value: CodexCatalogClientVersion =
    compareTriples(installed, verified) > 0
      ? { version: installed.join("."), source: "installed_cli" }
      : VERIFIED;
  return { ...value, program };
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
