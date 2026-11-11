/**
 * `claudexor scanner prepare`: the one explicit step that makes the pinned
 * publication scanner available to an install that does not bundle it (INV-146).
 * Local only: it writes under this machine's config root and never contacts a
 * daemon. A running engine with the same root finds the copy through its own
 * resolver at its next `pr`; delivery itself never downloads anything.
 */
import { dirname, resolve } from "node:path";
import {
  BETTERLEAKS_VERSION,
  SCANNER_PATH_ENV,
  ScannerProvisionError,
  locateScanner,
  provisionScanner,
  provisionedScannerPath,
  scannerArchiveUrl,
  scannerRelease,
  scannerReleaseKey,
  type ProvisionScannerInput,
  type ScannerArchiveSource,
  type ScannerLocation,
  type ScannerRelease,
} from "@claudexor/delivery";
import { claudexorOwnedRoot } from "@claudexor/util";
import { flagStr, type ParsedArgs } from "./args.js";
import { CliError, renderCliFailure } from "./cli-error.js";
import { print, printJson, printUsageError } from "./cli-io.js";

const USAGE = "usage: claudexor scanner prepare [--from-archive <file>]";
const INTERRUPTS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Test seams: the pin and environment this run acts on. */
export interface ScannerCommandOptions {
  release?: ScannerRelease | null;
  key?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: ProvisionScannerInput["fetchImpl"];
  tarCommand?: ProvisionScannerInput["tarCommand"];
}

function requiredActions(error: ScannerProvisionError, source: ScannerArchiveSource): string[] {
  switch (error.code) {
    case "scanner_download_failed":
      return [
        `Download ${source.kind === "download" ? source.url : "the official archive"} another way, then run \`claudexor scanner prepare --from-archive <file>\``,
      ];
    case "scanner_archive_mismatch":
      return [
        "Use the official archive this release pins for this platform, or run `claudexor scanner prepare` to download it",
      ];
    case "scanner_install_conflict":
      return [
        `Remove ${String(error.context["path"])} and run \`claudexor scanner prepare\` again`,
      ];
    default:
      return [];
  }
}

/** What `pr` in this environment would run now: the lookup order may put an
 * explicit path or a bundled copy ahead of the copy just prepared. */
function resolutionLine(location: ScannerLocation, binary: string, env: NodeJS.ProcessEnv): string {
  if (!location.ok) return `warning: \`pr\` in this environment still refuses: ${location.reason}`;
  if (location.path === binary)
    return "`pr` from an engine using this config root runs this copy from its next publication; no restart is needed.";
  return `\`pr\` in this environment runs ${location.path} instead (${
    env[SCANNER_PATH_ENV]?.trim() ? SCANNER_PATH_ENV : "the copy bundled with this distribution"
  } comes first).`;
}

export async function scannerCommand(
  args: ParsedArgs,
  json: boolean,
  options: ScannerCommandOptions = {},
): Promise<number> {
  if (args._[1] !== "prepare") return printUsageError(json, USAGE);
  const env = options.env ?? process.env;
  const key = options.key ?? scannerReleaseKey();
  const release = options.release === undefined ? scannerRelease() : options.release;
  if (!release)
    return renderCliFailure(
      json,
      new CliError(
        "operational",
        `no pinned Betterleaks ${BETTERLEAKS_VERSION} build exists for ${key}, so it cannot be prepared here`,
        { code: "scanner_platform_unsupported" },
      ),
    );
  const configRoot = claudexorOwnedRoot();
  const binary = provisionedScannerPath(configRoot, release) as string;
  const archive = flagStr(args, "from-archive");
  const source: ScannerArchiveSource = archive
    ? { kind: "file", path: resolve(archive) }
    : { kind: "download", url: scannerArchiveUrl(release) };
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  for (const signal of INTERRUPTS) process.on(signal, interrupt);
  const progress = (line: string) => {
    if (!json) process.stderr.write(`${line}\n`);
  };
  try {
    const result = await provisionScanner({
      key,
      release,
      version: BETTERLEAKS_VERSION,
      source,
      dir: dirname(binary),
      signal: controller.signal,
      onStage: (stage) => {
        if (stage === "acquire")
          progress(
            source.kind === "download" ? `Downloading ${source.url}` : `Reading ${source.path}`,
          );
        if (stage === "extract") progress(`Verified ${release.asset}; extracting`);
      },
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.tarCommand ? { tarCommand: options.tarCommand } : {}),
    });
    const location = locateScanner({ env, configDir: configRoot, release });
    const receipt = {
      ok: true,
      status: result.outcome === "prepared" ? "prepared" : "already_prepared",
      concurrent: result.concurrent,
      version: BETTERLEAKS_VERSION,
      platform: key,
      configRoot,
      path: result.binary,
      license: result.license,
      source,
      binarySha256: release.binarySha256,
      archiveSha256: result.archiveSha256,
      resolution: location.ok
        ? { ok: true, path: location.path, usesThisCopy: location.path === result.binary }
        : { ok: false, reason: location.reason, usesThisCopy: false },
      stagingLeft: result.stagingLeft,
    };
    if (json) {
      printJson(receipt);
      return 0;
    }
    print(
      result.outcome === "prepared"
        ? `Prepared Betterleaks ${BETTERLEAKS_VERSION} (${key}) at ${result.binary}`
        : `Betterleaks ${BETTERLEAKS_VERSION} (${key}) is already prepared at ${result.binary}; nothing was changed${result.concurrent ? " (a preparation running at the same time finished first)" : ""}`,
    );
    print(`sha256 ${release.binarySha256}, license ${result.license}`);
    print(resolutionLine(location, result.binary, env));
    if (result.stagingLeft) print(`warning: could not remove ${result.stagingLeft}; delete it.`);
    return 0;
  } catch (error) {
    return renderCliFailure(
      json,
      error instanceof ScannerProvisionError
        ? new CliError("operational", error.message, {
            code: error.code,
            context: error.context,
            requiredActions: requiredActions(error, source),
          })
        : error,
    );
  } finally {
    for (const signal of INTERRUPTS) process.off(signal, interrupt);
  }
}
