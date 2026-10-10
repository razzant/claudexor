import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import { daemonHeapLaunch, engineBuildIdentity } from "@claudexor/util";
import { setupAttachCommand } from "./setup-attach-command.js";

/**
 * Side-effect-free dispatch for the daemon executable's alternate belt role.
 * Kept outside claudexord.ts so the daemon owner remains below its readability
 * ratchet and the entry decision can be tested without daemon initialization.
 */
/** Handle `claudexord --probe`: print the engine build identity as ONE JSON line
 * ({version, buildSha, roles, launch}) and exit WITHOUT any durable startup — no writer lease,
 * no socket bind, no journal open, no runtime root. This is the pre-swap
 * handshake the macOS installer's RuntimeInstallCoordinator.probeVersion runs
 * against a freshly-unpacked closure with the app-bundled Node (D-2). Returns
 * true when the probe handled the invocation. */
export function runProbeIfRequested(argv: readonly string[]): boolean {
  if (argv.length !== 1 || argv[0] !== "--probe") return false;
  const id = engineBuildIdentity();
  process.stdout.write(
    `${JSON.stringify({ version: id.version, buildSha: id.sha, roles: ["setup_attach"], launch: daemonHeapLaunch() })}\n`,
  );
  return true;
}

export function isBeltServeInvocation(argv: readonly string[]): boolean {
  return argv.length === 2 && argv[0] === "mcp" && argv[1] === "serve-belt";
}

export async function runBeltServeIfRequested(argv: readonly string[]): Promise<boolean> {
  if (!isBeltServeInvocation(argv)) return false;
  const { serveBeltBridge } = await import("./belt-bridge.js");
  process.exitCode = await serveBeltBridge();
  return true;
}

interface ClaudexordEntryDeps {
  setupAttach(argv: readonly string[], json: boolean): Promise<number>;
  beltServe(argv: readonly string[]): Promise<boolean>;
}

const productionClaudexordEntryDeps: ClaudexordEntryDeps = {
  setupAttach: setupAttachCommand,
  beltServe: runBeltServeIfRequested,
};

export async function dispatchClaudexordEntry(
  daemonMain: () => Promise<void>,
  argv: readonly string[] = process.argv.slice(2),
  deps: ClaudexordEntryDeps = productionClaudexordEntryDeps,
): Promise<void> {
  try {
    // Probe is also a reserved alternate role. Only the exact one-token form
    // succeeds; extra arguments are usage errors and must not fall through to
    // durable daemon startup.
    if (argv[0] === "--probe") {
      if (!runProbeIfRequested(argv)) {
        process.stderr.write("usage: claudexord --probe\n");
        process.exitCode = 2;
      }
      return;
    }
    // `setup` is a reserved alternate entry role. Consume every shape here so
    // malformed invocations print setup usage/exit 2 and can never fall
    // through into durable daemon startup.
    if (argv[0] === "setup") {
      process.exitCode = await deps.setupAttach(argv, false);
      return;
    }
    if (await deps.beltServe(argv)) return;
    await daemonMain();
  } catch (error: unknown) {
    process.stderr.write(`claudexord: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Preserve import-side-effect freedom while supporting direct `node dist/claudexord.js`.
 * A worker thread inherits the parent's `process.argv`, so the single-file
 * daemon bundle loaded as a store worker entry would otherwise match itself
 * and start a second daemon inside the thread; a worker is never the direct entry.
 */
export function runIfDirectEntry(
  moduleUrl: string,
  entry: () => void,
  argv: readonly string[] = process.argv,
  mainThread: boolean = isMainThread,
): void {
  try {
    if (
      mainThread &&
      typeof argv[1] === "string" &&
      realpathSync.native(resolve(argv[1])) === realpathSync.native(fileURLToPath(moduleUrl))
    ) {
      entry();
    }
  } catch {
    // A malformed executable path is not direct-entry proof.
  }
}
