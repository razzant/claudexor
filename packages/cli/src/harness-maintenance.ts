import { programPlatform, resolveSelectedProgram } from "@claudexor/core";
import {
  ControlProblem,
  HarnessVendorVersion,
  type HarnessMaintenanceEntry,
  type HarnessMaintenanceEvidence,
  type HarnessProgram,
  type SelectedHarnessProgram,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import {
  acquireHarnessInstallLease,
  HARNESS_INSTALL_LOCK_TIMEOUT_MS,
} from "./harness-install-lease.js";
import { installerRuntime, type InstallerRuntimeOptions } from "./harness-install-runtime.js";
import { harnessProgram } from "./harness-programs.js";
import { newestSource, observeNewest, pickNewest } from "./harness-newest.js";
import { productNpmCopy, retireProductNpmCopy } from "./harness-npm-conversion.js";
import { prepareProgramCommand } from "./harness-program-command.js";

export type HarnessInspection = Omit<HarnessMaintenanceEntry, "operation">;
export interface MaintenanceOptions extends InstallerRuntimeOptions {
  program?: HarnessProgram;
  fetch?: typeof fetch;
  now?: () => Date;
  lock?: boolean;
  /** Durable service acknowledges this evidence before any vendor mutation. */
  beforeMutation?: (evidence: HarnessMaintenanceEvidence) => Promise<void>;
  requester?: HarnessMaintenanceEvidence["requester"];
  activeRunsAtStart?: number | null;
  installOnly?: boolean;
  dryRun?: boolean;
}
const action = (available: boolean, reason: string) => ({
  available,
  reason: available ? null : reason,
});
export async function inspectHarness(
  harness: string,
  options: MaintenanceOptions & { latest?: boolean } = {},
): Promise<HarnessInspection> {
  const program = options.program ?? harnessProgram(harness);
  const runtime = installerRuntime(program, options);
  const data = programPlatform(program, runtime.platform);
  const selection = resolveSelectedProgram(program, runtime);
  const converting = productNpmCopy(program, selection, runtime) !== null;
  const update = converting ? data?.install : data?.update;
  const now = (options.now ?? (() => new Date()))();
  return {
    harness,
    selection,
    observedAt: now.toISOString(),
    newest: options.latest
      ? await observeNewest(program, runtime.platform, runtime.arch, options.fetch, now)
      : {
          status: "not_read",
          source: newestSource(program, runtime.platform, runtime.arch)?.url ?? null,
        },
    actions: {
      install: action(
        !selection.path && !!data?.install,
        selection.path
          ? "A program is already selected; use Update."
          : (data?.reasons?.install ?? `${harness} has no installer for ${runtime.platform}.`),
      ),
      update: action(
        !!selection.path && !!update,
        !selection.path
          ? "No program is selected; use Install."
          : ((converting ? data?.reasons?.install : data?.reasons?.update) ??
              `${harness} has no update command for ${runtime.platform}.`),
      ),
      exactVersion: action(
        !!data?.exactVersion &&
          (data.exactVersion.kind !== "exec" ||
            data.exactVersion.command !== "{program}" ||
            !!selection.path),
        data?.reasons?.exactVersion ??
          (selection.path
            ? `${harness} has no exact-version command for ${runtime.platform}.`
            : "Install the program before requesting an exact version."),
      ),
    },
  };
}

export interface HarnessUpdateReceipt extends HarnessMaintenanceEvidence {
  ok: boolean;
  harness: string;
  dryRun: boolean;
}
function changed(before: SelectedHarnessProgram, after: SelectedHarnessProgram): boolean {
  return (
    before.path !== after.path ||
    before.realPath !== after.realPath ||
    before.version !== after.version
  );
}
export function emptyMaintenanceEvidence(
  target: HarnessMaintenanceEvidence["target"],
  requester = { source: "cli", requestId: null as string | null },
): HarnessMaintenanceEvidence {
  return {
    phase: "accepted",
    target,
    requester,
    installationHome: null,
    commands: [],
    before: null,
    after: null,
    elsewhere: null,
    activeRunsAtStart: null,
    exitCode: null,
    outcome: "unknown",
    mutation: "none",
    termination: "not_applicable",
    limitations: [],
    progress: [],
    problem: null,
  };
}

/** One vendor operation under the installation HOME. Newest lookup is never
 * an update prerequisite. Package metadata is consulted only for conversion. */
export async function runHarnessUpdate(
  harness: string,
  requested?: string,
  options: MaintenanceOptions = {},
): Promise<HarnessUpdateReceipt> {
  const version = requested === "latest" || requested === undefined ? null : requested;
  const evidence = emptyMaintenanceEvidence(
    version ? { kind: "version", version } : { kind: "latest", version: null },
    options.requester,
  );
  const receipt: HarnessUpdateReceipt = {
    ...evidence,
    ok: false,
    harness,
    dryRun: options.dryRun === true,
  };
  let lease: ReturnType<typeof acquireHarnessInstallLease> | undefined;
  let prepared: Awaited<ReturnType<typeof prepareProgramCommand>> | undefined;
  let started = false;
  let program: HarnessProgram | undefined;
  let runtime: ReturnType<typeof installerRuntime> | undefined;
  let otherBefore: SelectedHarnessProgram | undefined;
  const other = () => {
    const sourceEnv = { ...runtime!.sourceEnv };
    delete sourceEnv[program!.overrideEnv];
    return resolveSelectedProgram(program!, {
      ...runtime!,
      sourceEnv,
      maskedPaths: receipt.before?.path
        ? [receipt.before.path, receipt.before.realPath!].filter(Boolean)
        : [],
    });
  };
  try {
    if (version && !HarnessVendorVersion.safeParse(version).success)
      throw Object.assign(
        new Error(
          "Use --vendor-version with one exact version; previous and baseline are retired.",
        ),
        { code: "invalid_vendor_version" },
      );
    program = options.program ?? harnessProgram(harness);
    runtime = installerRuntime(program, options);
    receipt.installationHome = runtime.home;
    receipt.activeRunsAtStart = options.activeRunsAtStart ?? null;
    if (options.lock !== false && !options.dryRun)
      lease = acquireHarnessInstallLease(runtime.home, HARNESS_INSTALL_LOCK_TIMEOUT_MS);
    receipt.phase = "preparing";
    const before = resolveSelectedProgram(program, runtime);
    receipt.before = before;
    otherBefore = other();
    const data = programPlatform(program, runtime.platform);
    const copy = productNpmCopy(program, before, runtime);
    if (version && program.majorVersion && Number(version.split(".")[0]) !== program.majorVersion)
      throw new Error(`${harness} supports only ${program.majorVersion}.x (#668).`);
    if (options.installOnly && before.path && !version) {
      receipt.ok = true;
      receipt.after = before;
      receipt.outcome = "not_changed";
      receipt.exitCode = 0;
      return receipt;
    }
    const command = copy
      ? data?.install
      : version
        ? data?.exactVersion
        : before.path
          ? data?.update
          : data?.install;
    if (!command)
      throw Object.assign(
        new Error(
          (copy || !before.path
            ? data?.reasons?.install
            : version
              ? data?.reasons?.exactVersion
              : data?.reasons?.update) ??
            `${harness} has no requested vendor command for ${runtime.platform}.`,
        ),
        { code: "program_action_unavailable" },
      );
    // A conversion's installer must honor an explicitly requested version too.
    const selectedCommand = copy && version ? data?.exactVersion : command;
    if (
      !selectedCommand ||
      (copy &&
        selectedCommand.kind === "exec" &&
        selectedCommand.command === "{program}" &&
        version)
    )
      throw new Error("Convert this npm copy with Update before requesting an exact version.");
    if (version && version === before.version && !copy) {
      receipt.ok = true;
      receipt.after = before;
      receipt.outcome = "not_changed";
      receipt.exitCode = 0;
      return receipt;
    }
    prepared = await prepareProgramCommand(
      selectedCommand,
      runtime,
      before.path,
      version,
      options.fetch,
    );
    receipt.commands = [prepared.evidence];
    // An installer used as an updater must identify its own target from the
    // same downloaded bytes. No stale observation can authorize rerunning it.
    if (!copy && before.path && !version && selectedCommand.kind === "script") {
      const source = newestSource(program, runtime.platform, runtime.arch);
      if (!source || source.url !== selectedCommand.url || !prepared.scriptText)
        throw new Error("The update installer does not declare its own target version.");
      if (pickNewest(source, prepared.scriptText) === before.version) {
        receipt.ok = true;
        receipt.after = before;
        receipt.outcome = "not_changed";
        receipt.exitCode = 0;
        return receipt;
      }
    }
    if (options.dryRun) {
      receipt.ok = true;
      return receipt;
    }
    receipt.phase = "installing";
    receipt.mutation = "unknown";
    await options.beforeMutation?.(receipt);
    started = true;
    const result = prepared.run();
    receipt.exitCode = result.exitCode;
    receipt.progress = result.progress;
    if (result.exitCode !== 0)
      throw Object.assign(
        new Error(result.progress.at(-1) ?? `Vendor command exited ${result.exitCode}`),
        { code: "vendor_command_failed" },
      );
    if (copy) {
      const converted = retireProductNpmCopy(program, copy, runtime);
      receipt.limitations.push(...converted.limitations);
    }
    receipt.after = resolveSelectedProgram(program, runtime);
    if (!receipt.after.path || !receipt.after.version)
      throw Object.assign(
        new Error("The selected program did not answer --version after the vendor command."),
        { code: "program_verification_failed" },
      );
    receipt.ok = true;
  } catch (error) {
    receipt.problem = ControlProblem.parse({
      code: (error as { code?: string }).code ?? "maintenance_failed",
      message: redactSecrets(error instanceof Error ? error.message : String(error)),
      retryable: true,
    });
  } finally {
    if (runtime && program && receipt.before) {
      receipt.after = resolveSelectedProgram(program, runtime);
      const otherAfter = other();
      if (otherBefore) receipt.elsewhere = { before: otherBefore, after: otherAfter };
      const selectedChanged = changed(receipt.before, receipt.after);
      const elsewhereChanged = !!otherBefore && changed(otherBefore, otherAfter);
      receipt.outcome = selectedChanged
        ? "changed"
        : elsewhereChanged
          ? "changed_elsewhere"
          : receipt.after.version
            ? "not_changed"
            : "unknown";
      receipt.mutation =
        selectedChanged || elsewhereChanged
          ? "applied"
          : started && !receipt.ok
            ? "unknown"
            : "none";
    }
    receipt.phase = "settled";
    try {
      prepared?.dispose();
    } finally {
      lease?.release();
    }
  }
  return receipt;
}
