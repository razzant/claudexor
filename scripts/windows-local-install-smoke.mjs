#!/usr/bin/env node
/** Disposable Windows runner proof of every adapter-declared installation route.
 * No login or model call. Versions come from the installed program's own answer.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessPrograms } from "../packages/cli/dist/harness-programs.js";
import { HarnessMaintenanceEvidence } from "../packages/schema/dist/index.js";

if (process.platform !== "win32")
  throw new Error("Windows vendor installation proof requires win32");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(
  join(realpathSync.native(process.env.RUNNER_TEMP ?? tmpdir()), "vendor-program-smoke-"),
);
const home = join(root, "home");
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  CLAUDEXOR_CONFIG_DIR: join(root, "config"),
  CODEX_HOME: join(home, ".codex"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  TEMP: join(root, "tmp"),
  TMP: join(root, "tmp"),
  CI: "true",
};
for (const path of [home, env.APPDATA, env.LOCALAPPDATA, env.CLAUDEXOR_CONFIG_DIR, env.TEMP])
  mkdirSync(path, { recursive: true });
const programs = harnessPrograms().filter((program) => program.platforms.win32?.install);
// Acceptance expectation, not a runtime capability list: adding or losing a route needs review.
const expected = ["agy", "claude", "codex", "copilot", "grok"];
if (JSON.stringify(programs.map((p) => p.id).sort()) !== JSON.stringify(expected))
  throw new Error("Windows route acceptance set changed");
for (const program of harnessPrograms()) delete env[program.overrideEnv];
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD/.test(key)) delete env[key];

function cli(args) {
  const result = spawnSync(
    process.execPath,
    [join(repo, "packages/cli/dist/cli.js"), ...args, "--json"],
    {
      env,
      cwd: root,
      encoding: "utf8",
      timeout: 20 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  // The receipt on stdout carries the vendor's own lines; print it with stderr.
  if (result.status !== 0)
    throw new Error(
      `${args.join(" ")} failed (exit ${result.status}${result.error ? `, ${result.error}` : ""})\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`,
    );
  return JSON.parse(result.stdout);
}

const verified = [];
const failed = [];
// Every route is attempted, so one run reports all of them.
for (const program of programs) {
  try {
    verifyRoute(program);
  } catch (error) {
    failed.push(program.id);
    console.log(`FAILED ${program.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function verifyRoute(program) {
  const { ok, harness, dryRun, ...body } = cli(["harness", "install", program.id, "--yes"]);
  const receipt = HarnessMaintenanceEvidence.parse(body);
  if (
    !ok ||
    dryRun ||
    harness !== program.id ||
    !receipt.after?.path ||
    !receipt.after.version ||
    receipt.commands.length === 0
  )
    throw new Error(
      `${program.id}: installation did not prove a runnable program: ${JSON.stringify(body)}`,
    );
  const row = cli(["harness", "inspect", program.id]).harnesses[0];
  if (row.selection.path !== receipt.after.path || row.selection.version !== receipt.after.version)
    throw new Error(`${program.id}: receipt and next selection disagree`);
  const again = cli(["harness", "install", program.id, "--yes"]);
  if (!again.ok || again.outcome !== "not_changed" || again.commands.length !== 0)
    throw new Error(`${program.id}: install of an existing program was not a no-op`);
  verified.push({
    harness: program.id,
    path: receipt.after.path,
    version: receipt.after.version,
    commands: receipt.commands,
  });
  console.log(JSON.stringify(verified.at(-1)));
}
if (failed.length) throw new Error(`Windows installation routes failed: ${failed.join(", ")}`);
console.log(
  JSON.stringify({
    passed: verified.length,
    root,
    limitations: ["No vendor login, model execution, or app-server compatibility claim."],
  }),
);
