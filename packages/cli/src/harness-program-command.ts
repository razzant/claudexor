import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareHarnessCommand, programPath } from "@claudexor/core";
import type { HarnessProgramCommand, HarnessMaintenanceCommand } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import type { InstallerRuntime } from "./harness-install-runtime.js";
import { readVendorBytes } from "./harness-newest.js";

/** Resolve display arguments without fetching scripts or executing anything. */
export function previewProgramCommand(
  command: HarnessProgramCommand,
  runtime: InstallerRuntime,
  selectedPath: string | null,
  version = "{version}",
): HarnessProgramCommand {
  const replace = (value: string) =>
    programPath(value, runtime.sourceEnv)
      .replaceAll("{program}", selectedPath ?? "{installedProgram}")
      .replaceAll("{version}", version)
      .replaceAll("{arch}", runtime.arch);
  return {
    ...command,
    ...(command.kind === "exec" ? { command: replace(command.command) } : {}),
    args: command.args.map(replace),
    ...(command.env
      ? { env: Object.fromEntries(Object.entries(command.env).map(([k, v]) => [k, replace(v)])) }
      : {}),
  };
}

export async function prepareProgramCommand(
  command: HarnessProgramCommand,
  runtime: InstallerRuntime,
  selectedPath: string | null,
  version: string | null,
  fetcher?: typeof fetch,
) {
  const replace = (value: string) =>
    programPath(value, runtime.sourceEnv)
      .replaceAll("{program}", selectedPath ?? "")
      .replaceAll("{version}", version ?? "")
      .replaceAll("{arch}", runtime.arch);
  if (command.kind === "exec" && command.command === "{program}" && !selectedPath)
    throw new Error("Install the program before requesting an exact version");
  const env = Object.fromEntries(
    Object.entries(command.env ?? {}).map(([key, value]) => [key, replace(value)]),
  );
  const folder = mkdtempSync(join(tmpdir(), "claudexor-vendor-"));
  try {
    let binary: string;
    let args: string[];
    let script: HarnessMaintenanceCommand["script"] = null;
    if (command.kind === "script") {
      const bytes = await readVendorBytes(command.url, fetcher);
      script = {
        url: command.url,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      const path = join(
        folder,
        command.interpreter === "powershell" ? "install.ps1" : "install.sh",
      );
      writeFileSync(path, bytes, { mode: 0o600 });
      binary = command.interpreter;
      args = [...command.interpreterArgs, path, ...command.args.map(replace)];
    } else {
      binary = replace(command.command);
      args = command.args.map(replace);
    }
    const environment = { ...runtime.environment, ...env };
    // An external Windows command may be an OS app execution alias rather than
    // a readable image. Let CreateProcess resolve it; selected vendor programs
    // still use the shared resolver/interpreter contract.
    const invocation =
      runtime.platform === "win32" && command.kind === "exec" && command.command !== "{program}"
        ? { binary, args, env: environment }
        : prepareHarnessCommand(binary, args, environment, runtime.platform, folder);
    const evidence: HarnessMaintenanceCommand = {
      binary: invocation.binary,
      args: invocation.args,
      env,
      script,
    };
    return {
      evidence,
      folder,
      run() {
        const result = runtime.spawn(invocation.binary, invocation.args, {
          cwd: folder,
          env: invocation.env,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
          windowsHide: true,
          timeout: 10 * 60_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
          throw Object.assign(
            new Error(
              `${binary} is not available on this machine; install it before running this vendor command.`,
            ),
            { code: "program_action_unavailable" },
          );
        const progress = redactSecrets(
          `${result.stdout ?? ""}\n${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`,
        )
          .split(/\r?\n/)
          .map((line) => line.trimEnd().slice(0, 400))
          .filter(Boolean)
          .slice(-40);
        return { exitCode: result.status ?? 1, progress };
      },
      dispose: () => rmSync(folder, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}
