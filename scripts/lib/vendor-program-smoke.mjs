import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import {
  prepareHarnessCommand,
  normalizedHarnessPath,
  selectProgramLauncher,
  prepareNativeProgram,
} from "../../packages/core/dist/index.js";
import { HarnessRunSpec } from "../../packages/schema/dist/index.js";

/** Match maintenance's second ask after a missing version; callers still
 * require exact agreement with the receipt's path and version. */
export function inspectProgramSelection(inspect) {
  const row = inspect();
  return row.selection.version === null ? inspect() : row;
}

/** Exercise the native run's selector without login, a session or a version child. */
export async function assertNativeRunSelection(program, selected, env, cwd) {
  const native = await prepareNativeProgram(
    program,
    selectProgramLauncher(program, env),
    HarnessRunSpec.parse({
      session_id: "vendor-proof",
      intent: "explain",
      prompt: "selection only",
      cwd,
    }),
    { ...env, PATH: normalizedHarnessPath(env) },
    true,
  );
  if (!selected.path || native.evidence().path !== selected.path || native.bin !== selected.path)
    throw new Error(
      `Native run selection differs from installed receipt: ${JSON.stringify({ selected, native: native.evidence(), bin: native.bin })}`,
    );
  return native.bin;
}

/** A healthy old program does not prove the engine's update environment worked.
 * Only a direct failure of the same command on the runner establishes a vendor refusal. */
export function verifyVendorUpdateRefusal(receipt, env, { cwd, spawn = spawnSync }) {
  const command = receipt.commands[0];
  if (receipt.commands.length !== 1 || !command || command.script)
    throw new Error("Update refusal has no single direct vendor command to verify");
  const result = spawn(command.binary, command.args, {
    cwd,
    env: { ...env, ...command.env },
    encoding: "utf8",
    timeout: 15 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  const progress = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (result.error || typeof result.status !== "number" || result.status === 0)
    throw new Error(
      `Engine update failed but direct vendor refusal was not confirmed (exit ${result.status}${result.error ? `, ${result.error}` : ""}): ${progress}`,
    );
  return { exitCode: result.status, progress };
}

/** CI's Windows Node distribution bundles npm beside node.exe. Run that JS
 * entry directly: CreateProcess cannot execute npm.cmd without a shell. */
export function runProofNpm(
  env,
  args,
  { cwd, platform = process.platform, execPath = process.execPath, spawn = spawnSync },
) {
  const invocation =
    platform === "win32"
      ? {
          binary: execPath,
          args: [join(dirname(execPath), "node_modules/npm/bin/npm-cli.js"), ...args],
          env,
        }
      : prepareHarnessCommand("npm", args, env, platform, cwd);
  const result = spawn(invocation.binary, invocation.args, {
    env: invocation.env,
    cwd,
    encoding: "utf8",
    timeout: 15 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `npm ${args.join(" ")} failed (exit ${result.status}${result.error ? `, ${result.error}` : ""})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  return result.stdout;
}
