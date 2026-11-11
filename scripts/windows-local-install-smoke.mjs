#!/usr/bin/env node
/** Disposable-runner proof of every adapter-declared vendor route on this platform:
 * installation, the program's own update, and replacement of a product-made npm
 * copy. Real vendor installers and updaters run. No login or model call. Versions
 * come from the installed program's own answer. Every route is attempted, so one
 * run reports all of them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessPrograms } from "../packages/cli/dist/harness-programs.js";
import { HarnessMaintenanceEvidence } from "../packages/schema/dist/index.js";

const platform = process.platform;
const win = platform === "win32";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(
  join(realpathSync.native(process.env.RUNNER_TEMP ?? tmpdir()), "vendor-program-smoke-"),
);
const failed = [];
const verified = [];

/** One disposable user: HOME and, on Windows, the profile folders derived from it. */
function environment(home) {
  const env = {
    ...process.env,
    HOME: home,
    CLAUDEXOR_CONFIG_DIR: join(home, "claudexor-config"),
    CI: "true",
  };
  const folders = [home, env.CLAUDEXOR_CONFIG_DIR];
  if (win) {
    Object.assign(env, {
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      CODEX_HOME: join(home, ".codex"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      TEMP: join(home, "tmp"),
      TMP: join(home, "tmp"),
    });
    folders.push(env.APPDATA, env.LOCALAPPDATA, env.TEMP);
  }
  for (const path of folders) mkdirSync(path, { recursive: true });
  for (const program of harnessPrograms()) delete env[program.overrideEnv];
  for (const key of Object.keys(env))
    if (/API_KEY|TOKEN|SECRET|PASSWORD/.test(key)) delete env[key];
  return env;
}

function cli(env, args) {
  const result = spawnSync(
    process.execPath,
    [join(repo, "packages/cli/dist/cli.js"), ...args, "--json"],
    {
      env,
      cwd: root,
      encoding: "utf8",
      timeout: 15 * 60_000,
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

function npm(env, args) {
  const result = spawnSync(win ? `npm ${args.join(" ")}` : "npm", win ? [] : args, {
    env,
    cwd: root,
    shell: win,
    encoding: "utf8",
    timeout: 15 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `npm ${args.join(" ")} failed (exit ${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}

function attempt(route, harness, run) {
  try {
    const evidence = run();
    verified.push({ route, harness, ...evidence });
    console.log(JSON.stringify(verified.at(-1)));
  } catch (error) {
    failed.push(`${route}:${harness}`);
    console.log(
      `FAILED ${route} ${harness}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Install with the vendor's installer, read it back, install again as a no-op. */
function installRoute(program, env) {
  const { ok, harness, dryRun, ...body } = cli(env, ["harness", "install", program.id, "--yes"]);
  const receipt = HarnessMaintenanceEvidence.parse(body);
  if (
    !ok ||
    dryRun ||
    harness !== program.id ||
    !receipt.after?.path ||
    !receipt.after.version ||
    receipt.commands.length === 0
  )
    throw new Error(`installation did not prove a runnable program: ${JSON.stringify(body)}`);
  const row = cli(env, ["harness", "inspect", program.id]).harnesses[0];
  if (row.selection.path !== receipt.after.path || row.selection.version !== receipt.after.version)
    throw new Error(`receipt and next selection disagree: ${JSON.stringify(row.selection)}`);
  const again = cli(env, ["harness", "install", program.id, "--yes"]);
  if (!again.ok || again.outcome !== "not_changed" || again.commands.length !== 0)
    throw new Error(`install of an existing program was not a no-op: ${JSON.stringify(again)}`);
  return { path: receipt.after.path, version: receipt.after.version, commands: receipt.commands };
}

/** The installed program's own update verb, under the engine's environment. */
function updateRoute(program, env) {
  const row = cli(env, ["harness", "inspect", program.id]).harnesses[0];
  if (!row.selection.path) throw new Error("no program is selected to update");
  if (!row.actions.update.available) return { unavailable: row.actions.update.reason };
  const receipt = cli(env, ["harness", "update", program.id, "--yes"]);
  if (
    !receipt.ok ||
    !["changed", "not_changed"].includes(receipt.outcome) ||
    !receipt.after?.path ||
    !receipt.after.version
  )
    throw new Error(`update did not end in a verified program: ${JSON.stringify(receipt)}`);
  return {
    outcome: receipt.outcome,
    before: receipt.before?.version ?? null,
    after: receipt.after.version,
    commands: receipt.commands,
  };
}

/** A copy made by real npm in the product's prefix is replaced by the vendor's
 * copy at Update, and the old package and launcher are gone afterwards. */
function conversionRoute(program) {
  const home = join(root, `npm-${program.id}`);
  const env = environment(home);
  const prefix = join(home, ".claudexor", "node");
  const versions = JSON.parse(npm(env, ["view", program.legacyNpmPackage, "versions", "--json"]));
  const released = [versions].flat().filter((version) => /^\d+\.\d+\.\d+$/.test(version));
  const old = released.at(-2) ?? released.at(-1);
  if (!old) throw new Error(`no released npm version of ${program.legacyNpmPackage}`);
  npm(env, [
    "install",
    "--global",
    "--prefix",
    prefix,
    "--no-audit",
    "--no-fund",
    `${program.legacyNpmPackage}@${old}`,
  ]);
  const packageRoot = realpathSync(
    join(prefix, win ? "node_modules" : join("lib", "node_modules"), program.legacyNpmPackage),
  );
  const before = cli(env, ["harness", "inspect", program.id]).harnesses[0];
  if (!before.selection.realPath?.startsWith(packageRoot + sep))
    throw new Error(
      `the npm copy is not the selected program: ${JSON.stringify(before.selection)}`,
    );
  if (!before.actions.update.available) return { unavailable: before.actions.update.reason };
  const receipt = cli(env, ["harness", "update", program.id, "--yes"]);
  const after = cli(env, ["harness", "inspect", program.id]).harnesses[0];
  if (
    !receipt.ok ||
    !after.selection.path ||
    !after.selection.version ||
    after.selection.realPath?.startsWith(packageRoot + sep) ||
    existsSync(packageRoot) ||
    existsSync(before.selection.path)
  )
    throw new Error(
      `the npm copy was not replaced by a verified vendor copy: ${JSON.stringify({ receipt, after: after.selection, oldPackageExists: existsSync(packageRoot), oldLauncherExists: existsSync(before.selection.path) })}`,
    );
  return {
    npm: `${program.legacyNpmPackage}@${old}`,
    before: { path: before.selection.path, version: before.selection.version },
    after: { path: after.selection.path, version: after.selection.version },
    outcome: receipt.outcome,
    limitations: receipt.limitations,
  };
}

const programs = harnessPrograms().filter((program) => program.platforms[platform]?.install);
// Acceptance expectation, not a runtime capability list: adding or losing a route needs review.
const expected = win
  ? ["agy", "claude", "codex", "copilot", "grok"]
  : ["agy", "claude", "codex", "copilot", "cursor", "grok", "opencode"];
const declared = programs.map((program) => program.id).sort();
if (JSON.stringify(declared) !== JSON.stringify(expected)) {
  failed.push("acceptance-set");
  console.log(`FAILED acceptance set on ${platform}: declared ${declared.join(", ")}`);
}

const user = environment(join(root, "home"));
for (const program of programs) {
  attempt("install", program.id, () => installRoute(program, user));
  attempt("update", program.id, () => updateRoute(program, user));
}
for (const program of programs)
  if (program.legacyNpmPackage) attempt("conversion", program.id, () => conversionRoute(program));

console.log(
  JSON.stringify({
    platform,
    passed: verified.length,
    failed,
    root,
    limitations: ["No vendor login, model execution, or app-server compatibility claim."],
  }),
);
if (failed.length) throw new Error(`Vendor program routes failed: ${failed.join(", ")}`);
