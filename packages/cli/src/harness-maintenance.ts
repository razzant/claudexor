import { loadConfig } from "@claudexor/config";
import { noProjectRepoRoot } from "@claudexor/util";
import type { HarnessAdapter } from "@claudexor/core";
import type { CredentialProfile } from "@claudexor/schema";
import {
  programUpdateAvailable,
  programObservationPublisher,
  invalidateProgramObservations,
  resolveHarnessCommandOnPath,
  programPlatform,
  resolveSelectedProgramAsync,
  resolveSelectedProgram,
} from "@claudexor/core";
import {
  ControlProblem,
  HarnessVendorVersion,
  type HarnessMaintenanceEntry,
  type HarnessMaintenanceEvidence,
  type HarnessProgram,
  type HarnessProgramCommand,
  type SelectedHarnessProgram,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import {
  acquireHarnessInstallLease,
  HARNESS_INSTALL_LOCK_TIMEOUT_MS,
} from "./harness-install-lease.js";
import { installerRuntime, type InstallerRuntimeOptions } from "./harness-install-runtime.js";
import { harnessProgram, harnessProgramAdapter } from "./harness-programs.js";
import { newestSource, observeNewest } from "./harness-newest.js";
import {
  productNpmCopy,
  replacementProgram,
  retireProductNpmCopy,
} from "./harness-npm-conversion.js";
import { prepareProgramCommand, previewProgramCommand } from "./harness-program-command.js";

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
  planProfileProgramCleanup?: HarnessAdapter["planProfileProgramCleanup"];
  credentialProfiles?: readonly CredentialProfile[];
}
const action = (available: boolean, reason: string, commands: HarnessProgramCommand[]) => ({
  available,
  reason: available ? null : reason,
  commands: available ? commands : [],
});
function programActions(
  program: HarnessProgram,
  selection: SelectedHarnessProgram,
  runtime: ReturnType<typeof installerRuntime>,
): HarnessInspection["actions"] {
  const harness = program.id;
  const data = programPlatform(program, runtime.platform);
  const converting = productNpmCopy(program, selection, runtime) !== null;
  const pinnedCopy = converting && selection.overrideValue !== null;
  const pinnedReason =
    "An override pins the program to the old product-made npm copy; clearing the override lets Update replace it.";
  const update = converting ? data?.install : data?.update;
  const preview = (command: HarnessProgramCommand | undefined, path = selection.path) =>
    command ? [previewProgramCommand(command, runtime, path)] : [];
  const exactCommands =
    converting && data?.exactVersion?.kind === "exec" && data.exactVersion.command === "{program}"
      ? [...preview(data.install), ...preview(data.exactVersion, null)]
      : preview(data?.exactVersion);
  const actions = {
    install: action(
      !selection.path && !!data?.install,
      selection.path
        ? selection.version
          ? "A program is already selected; use Update."
          : "The selected program cannot answer --version; repair it or use Update before installing."
        : (data?.reasons?.install ?? `${harness} has no installer for ${runtime.platform}.`),
      preview(data?.install),
    ),
    update: action(
      !!selection.path && !!update && !pinnedCopy,
      pinnedCopy
        ? pinnedReason
        : !selection.path
          ? "No program is selected; use Install."
          : ((converting ? data?.reasons?.install : data?.reasons?.update) ??
            `${harness} has no update command for ${runtime.platform}.`),
      preview(update),
    ),
    exactVersion: action(
      !pinnedCopy &&
        !!data?.exactVersion &&
        (!converting || !!data.install) &&
        (data.exactVersion.kind !== "exec" ||
          data.exactVersion.command !== "{program}" ||
          !!selection.path),
      pinnedCopy
        ? pinnedReason
        : converting && !data?.install
          ? (data?.reasons?.install ??
            `${harness} has no vendor installer for this conversion on ${runtime.platform}.`)
          : (data?.reasons?.exactVersion ??
            (selection.path
              ? `${harness} has no exact-version command for ${runtime.platform}.`
              : "Install the program before requesting an exact version.")),
      exactCommands,
    ),
  };
  // Windows can launch app execution aliases that are not readable executable
  // images. Only the OS launch can establish that an installer command is absent.
  if (runtime.platform === "win32") return actions;
  for (const offered of Object.values(actions)) {
    if (!offered.available) continue;
    for (const command of offered.commands) {
      if (command.kind !== "exec" || command.command.startsWith("{")) continue;
      if (
        !resolveHarnessCommandOnPath(
          command.command,
          runtime.environment.PATH ?? "",
          runtime.platform,
          runtime.environment,
        ).command
      ) {
        offered.available = false;
        offered.reason = `${command.command} is not available on this machine; install it before running this vendor command.`;
        offered.commands = [];
        break;
      }
    }
  }
  return actions;
}
export async function inspectHarness(
  harness: string,
  options: MaintenanceOptions & { latest?: boolean } = {},
): Promise<HarnessInspection> {
  const program = options.program ?? harnessProgram(harness);
  const runtime = installerRuntime(program, options);
  const publish = programObservationPublisher(program, runtime);
  const selection = options.spawn
    ? resolveSelectedProgram(program, runtime)
    : await resolveSelectedProgramAsync(program, runtime);
  publish(selection);
  const now = (options.now ?? (() => new Date()))();
  const newest = options.latest
    ? await observeNewest(program, runtime.platform, runtime.arch, options.fetch, now)
    : {
        status: "not_read" as const,
        source: newestSource(program, runtime.platform, runtime.arch)?.url ?? null,
      };
  return {
    harness,
    selection,
    observedAt: now.toISOString(),
    newest,
    updateAvailable: programUpdateAvailable(
      program.versionScheme,
      selection.version,
      newest.status === "available" ? newest.version : null,
    ),
    releaseNotesUrl: program.releaseNotesUrl ?? null,
    actions: programActions(program, selection, runtime),
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
  const preparedCommands: Array<Awaited<ReturnType<typeof prepareProgramCommand>>> = [];
  let started = false;
  let cleaned = false;
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
    let before = resolveSelectedProgram(program, runtime);
    receipt.before = before;
    otherBefore = other();
    const cleanup =
      options.planProfileProgramCleanup ??
      (!options.program ? harnessProgramAdapter(harness)?.planProfileProgramCleanup : undefined);
    const cleanupProfiles = async (recoverOnly: boolean) => {
      if (!cleanup || options.dryRun) return;
      try {
        const profiles =
          options.credentialProfiles ?? loadConfig(noProjectRepoRoot()).global.credential_profiles;
        const plan = cleanup(profiles, resolveSelectedProgram(program!, runtime!), { recoverOnly });
        receipt.limitations.push(...plan.limitations.map(redactSecrets));
        if (!plan.paths.length) return;
        receipt.profileCleanup ??= { plannedPaths: [], removedPaths: [] };
        receipt.profileCleanup.plannedPaths.push(...plan.paths);
        await options.beforeMutation?.(receipt);
        const result = plan.execute(() => resolveSelectedProgram(program!, runtime!));
        receipt.profileCleanup.removedPaths.push(...result.removed);
        receipt.limitations.push(...result.limitations.map(redactSecrets));
        cleaned ||= result.removed.length > 0;
      } catch (error) {
        receipt.limitations.push(
          `Profile program cleanup did not finish: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        );
      }
    };
    // Unavailable actions cannot mutate even profile copies. Healthy repeated
    // Install is an idempotent read; broken Install still gets recovery first.
    if (!(options.installOnly && before.path && !version)) {
      const initial = programActions(program, before, runtime)[
        version ? "exactVersion" : before.path ? "update" : "install"
      ];
      if (!initial.available)
        throw Object.assign(new Error(initial.reason!), { code: "program_action_unavailable" });
    }
    await cleanupProfiles(true);
    if (cleanup) before = resolveSelectedProgram(program, runtime);
    const data = programPlatform(program, runtime.platform);
    const copy = productNpmCopy(program, before, runtime);
    if (version && program.majorVersion && Number(version.split(".")[0]) !== program.majorVersion)
      throw new Error(`${harness} supports only ${program.majorVersion}.x (#668).`);
    if (options.installOnly && before.path && !version) {
      if (!before.version)
        throw Object.assign(new Error(programActions(program, before, runtime).install.reason!), {
          code: "program_verification_failed",
        });
      receipt.ok = true;
      receipt.after = before;
      receipt.outcome = "not_changed";
      return receipt;
    }
    const available = programActions(program, before, runtime)[
      version ? "exactVersion" : before.path ? "update" : "install"
    ];
    if (!available.available)
      throw Object.assign(new Error(available.reason!), { code: "program_action_unavailable" });
    const command = copy
      ? data!.install!
      : version
        ? data!.exactVersion!
        : before.path
          ? data!.update!
          : data!.install!;
    const exact = version ? data?.exactVersion : undefined;
    // An exact verb on a product npm copy first needs a native vendor program.
    // Keep the old package selected until both planned commands have succeeded.
    const exactAfterInstall =
      !!copy && !!exact && exact.kind === "exec" && exact.command === "{program}";
    const selectedCommand = copy && exact && !exactAfterInstall ? exact : command;
    if (version && version === before.version && !copy) {
      receipt.ok = true;
      receipt.after = before;
      receipt.outcome = "not_changed";
      return receipt;
    }
    prepared = await prepareProgramCommand(
      selectedCommand,
      runtime,
      before.path,
      version,
      options.fetch,
    );
    preparedCommands.push(prepared);
    receipt.commands = [prepared.evidence];
    if (options.dryRun) {
      if (exactAfterInstall)
        receipt.limitations.push(
          "The exact version will be requested from the new vendor program before retiring the old npm copy.",
        );
      receipt.ok = true;
      return receipt;
    }
    const execute = async (
      invocation: Awaited<ReturnType<typeof prepareProgramCommand>>,
      allowFailure = false,
    ) => {
      receipt.phase = "installing";
      receipt.mutation = "unknown";
      await options.beforeMutation?.(receipt);
      const result = invocation.run();
      started = true;
      receipt.exitCode = result.exitCode;
      receipt.progress = [...receipt.progress, ...result.progress].slice(-40);
      if (result.exitCode !== 0) {
        const failure = Object.assign(
          new Error(result.progress.at(-1) ?? `Vendor command exited ${result.exitCode}`),
          { code: "vendor_command_failed" },
        );
        if (!allowFailure) throw failure;
        return failure;
      }
      return null;
    };
    const installerFailure = await execute(prepared, !!copy);
    const installerExit = receipt.exitCode;
    try {
      if (copy && exactAfterInstall) {
        const native = replacementProgram(program, copy, runtime);
        if (!native.path || !native.version)
          throw Object.assign(
            new Error(
              "The vendor installer did not produce a versioned replacement; the old npm copy is unchanged.",
            ),
            { code: "conversion_verification_failed" },
          );
        if (native.version !== version) {
          const requested = await prepareProgramCommand(
            exact!,
            runtime,
            native.path,
            version,
            options.fetch,
          );
          preparedCommands.push(requested);
          receipt.commands.push(requested.evidence);
          receipt.limitations.push(`Vendor installer exit status: ${installerExit}.`);
          await execute(requested);
        }
        if (replacementProgram(program, copy, runtime).version !== version)
          throw Object.assign(
            new Error(
              "The new vendor program did not report the requested exact version; the old npm copy is unchanged.",
            ),
            { code: "conversion_verification_failed" },
          );
      }
      if (copy) {
        const converted = retireProductNpmCopy(program, copy, runtime, before);
        receipt.limitations.push(...converted.limitations);
        if (installerFailure)
          receipt.limitations.push(
            `The installer exited ${installerExit}, but conversion completed because the selected replacement answers its version and is not known to be older.`,
          );
      }
    } catch (error) {
      throw installerFailure ?? error;
    }
    receipt.after = resolveSelectedProgram(program, runtime);
    if (!receipt.after.path || !receipt.after.version)
      throw Object.assign(
        new Error("The selected program did not answer --version after the vendor command."),
        { code: "program_verification_failed" },
      );
    receipt.ok = true;
    await cleanupProfiles(false);
  } catch (error) {
    receipt.problem = ControlProblem.parse({
      code: (error as { code?: string }).code ?? "maintenance_failed",
      message: redactSecrets(error instanceof Error ? error.message : String(error)),
      retryable: true,
    });
  } finally {
    if (runtime && program && receipt.before) {
      receipt.after = resolveSelectedProgram(program, runtime);
      if (receipt.ok && !receipt.dryRun && (!receipt.after.path || !receipt.after.version)) {
        receipt.ok = false;
        receipt.problem = ControlProblem.parse({
          code: "program_verification_failed",
          message:
            "The selected program did not answer --version after maintenance and profile cleanup.",
          retryable: true,
        });
      }
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
        selectedChanged || elsewhereChanged || cleaned
          ? "applied"
          : started && !receipt.ok
            ? "unknown"
            : "none";
    }
    receipt.phase = "settled";
    if (program) invalidateProgramObservations(program.id);
    try {
      for (const command of preparedCommands) command.dispose();
    } finally {
      lease?.release();
    }
  }
  return receipt;
}
