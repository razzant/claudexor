import { readSync } from "node:fs";
import { createInterface } from "node:readline";
import { HarnessVendorVersion, type HarnessMaintenanceEvidence } from "@claudexor/schema";
import { flagBool, flagStr, type ParsedArgs } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { runHarnessUpdate, type MaintenanceOptions } from "./harness-maintenance.js";

/** A controlling terminal or an explicitly authorized --yes owns consent. */
export function confirmOnTty(question: string): boolean {
  process.stdout.write(question);
  const buffer = Buffer.alloc(1024);
  try {
    return /^y(es)?$/i.test(
      buffer.toString("utf8", 0, readSync(0, buffer, 0, buffer.length, null)).trim(),
    );
  } catch {
    return false;
  }
}

export const MAINTENANCE_EVIDENCE_PREFIX = "CLAUDEXOR_MAINTENANCE_EVIDENCE ";
function evidenceAcknowledgments() {
  const lines = createInterface({ input: process.stdin });
  const replies = lines[Symbol.asyncIterator]();
  return {
    async acknowledge(value: HarnessMaintenanceEvidence) {
      const {
        ok: _ok,
        harness: _harness,
        dryRun: _dryRun,
        ...evidence
      } = value as HarnessMaintenanceEvidence & {
        ok?: boolean;
        harness?: string;
        dryRun?: boolean;
      };
      const reply = replies.next();
      process.stderr.write(`${MAINTENANCE_EVIDENCE_PREFIX}${JSON.stringify(evidence)}\n`);
      const received = await reply;
      if (received.done || received.value !== "ack")
        throw new Error("Maintenance owner did not acknowledge this command before mutation");
    },
    close: () => lines.close(),
  };
}

export function retiredInstallFlags(args: ParsedArgs): string | null {
  if (Object.hasOwn(args.flags, "target"))
    return "--target was retired for harness installation; use claudexor harness install <id> --yes on the installation host.";
  if (Object.hasOwn(args.flags, "release-tested"))
    return "--release-tested was retired; use claudexor harness install <id> --yes for the vendor's current version, or --vendor-version <exact>.";
  return null;
}

export async function harnessInstallCommand(
  args: ParsedArgs,
  json: boolean,
  options: MaintenanceOptions = {},
): Promise<number> {
  return harnessMutationCommand(args, json, { ...options, installOnly: true });
}
export async function harnessMutationCommand(
  args: ParsedArgs,
  json: boolean,
  options: MaintenanceOptions = {},
): Promise<number> {
  const retired = retiredInstallFlags(args);
  if (retired) return printUsageError(json, retired);
  const harness = args._[2];
  if (!harness || args._.length !== 3)
    return printUsageError(
      json,
      "usage: claudexor harness install|update <id> [--vendor-version <exact>] [--yes]",
    );
  const requested = flagStr(args, "vendor-version");
  if (
    Object.hasOwn(args.flags, "vendor-version") &&
    !HarnessVendorVersion.safeParse(requested).success
  )
    return printUsageError(
      json,
      "Use --vendor-version <exact> for an explicit version; omit it to run the vendor's current Update. previous, baseline and --vendor-version latest are not targets.",
    );
  const dryRun = flagBool(args, "dry-run");
  const confirm = !dryRun && !flagBool(args, "yes");
  if (confirm && (json || !process.stdin.isTTY))
    return printUsageError(
      json,
      "Pass --yes to authorize this vendor operation, or run on a terminal.",
    );
  const acknowledgments =
    process.env.CLAUDEXOR_MAINTENANCE_PROTOCOL === "1" ? evidenceAcknowledgments() : null;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  try {
    const receipt = await runHarnessUpdate(harness, requested, {
      ...options,
      dryRun,
      beforeMutation: async (evidence) => {
        if (cancelled) throw new Error("Maintenance cancelled before mutation");
        if (confirm) {
          printJson(evidence);
          if (!confirmOnTty(`Run this vendor operation for ${harness}? [y/N] `))
            throw new Error("Vendor operation declined before mutation");
        }
        await options.beforeMutation?.(evidence);
        await acknowledgments?.acknowledge(evidence);
        if (cancelled) throw new Error("Maintenance cancelled before mutation");
      },
    });
    if (json) printJson(receipt);
    else {
      for (const command of receipt.commands)
        print(
          `${command.binary} ${command.args.join(" ")}${command.script ? ` (script ${command.script.url}, ${command.script.size} bytes, sha256 ${command.script.sha256})` : ""}`,
        );
      for (const line of receipt.progress) print(line);
      for (const line of receipt.limitations) print(line);
      print(
        receipt.problem?.message ??
          `${harness}: ${receipt.outcome} (${receipt.before?.version ?? "missing"} → ${receipt.after?.version ?? "unknown"})`,
      );
    }
    if (!receipt.ok && json)
      process.stderr.write(`${receipt.problem?.message ?? "Vendor operation failed"}\n`);
    return receipt.ok ? 0 : receipt.exitCode || 1;
  } finally {
    acknowledgments?.close();
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
  }
}
