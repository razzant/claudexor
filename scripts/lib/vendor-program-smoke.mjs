import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { prepareHarnessCommand } from "../../packages/core/dist/index.js";

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
