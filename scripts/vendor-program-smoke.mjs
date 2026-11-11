#!/usr/bin/env node
/** Disposable-runner proof of every adapter-declared vendor route on this platform:
 * installation, the program's own update, and replacement of a product-made npm
 * copy. Real vendor installers and updaters run. No login or model call. Versions
 * come from the installed program's own answer. Every route is attempted, so one
 * run reports all of them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessPrograms } from "../packages/cli/dist/harness-programs.js";
import { programUpdateAvailable } from "../packages/core/dist/index.js";
import { HarnessMaintenanceEvidence } from "../packages/schema/dist/index.js";
import { runProofNpm } from "./lib/vendor-program-smoke.mjs";

const platform = process.platform;
const win = platform === "win32";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(
  join(realpathSync.native(process.env.RUNNER_TEMP ?? tmpdir()), "vendor-program-smoke-"),
);
const failed = [];
const verified = [],
  refused = [],
  preserved = [];
// Windows installers (notably winget/MSI) operate on the actual Windows user.
// A throwaway HOME is not isolation. This destructive qualification belongs on
// an ephemeral CI machine; all Windows phases deliberately share its real user.
if (process.env.GITHUB_ACTIONS !== "true")
  throw new Error("Real vendor proof requires an ephemeral GitHub Actions runner.");
const machineHome = win ? process.env.USERPROFILE : null;
if (win && !machineHome) throw new Error("Windows runner has no USERPROFILE");
const installed = new Set();

/** POSIX uses a disposable HOME; Windows keeps the real runner's OS folders. */
function environment(home) {
  const env = {
    ...process.env,
    HOME: home,
    CLAUDEXOR_CONFIG_DIR: join(root, "config"),
    CI: "true",
  };
  for (const program of harnessPrograms()) delete env[program.overrideEnv];
  for (const key of Object.keys(env))
    if (
      /API_KEY|TOKEN|SECRET|PASSWORD/.test(key) ||
      /^(CODEX_HOME|CODEX_INSTALL_DIR|CLAUDE_CONFIG_DIR|CURSOR_CONFIG_DIR|COPILOT_HOME|COPILOT_CACHE_HOME|XDG_.*_HOME)$/.test(
        key,
      )
    )
      delete env[key];
  if (!win)
    Object.assign(env, {
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local/state"),
    });
  for (const path of [home, env.CLAUDEXOR_CONFIG_DIR]) mkdirSync(path, { recursive: true });
  return env;
}
const present = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

function cli(env, args, { refusal = false } = {}) {
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
  // A refused operation still prints its receipt; the caller may read it.
  if (refusal && result.status !== 0) {
    try {
      return JSON.parse(result.stdout);
    } catch {
      /* fall through to the full report */
    }
  }
  // The receipt on stdout carries the vendor's own lines; print it with stderr.
  if (result.status !== 0)
    throw new Error(
      `${args.join(" ")} failed (exit ${result.status}${result.error ? `, ${result.error}` : ""})\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`,
    );
  return JSON.parse(result.stdout);
}

function npm(env, args) {
  return runProofNpm(env, args, { cwd: root });
}

function attempt(route, harness, run) {
  try {
    const evidence = run();
    const records = evidence.vendorRefused
      ? refused
      : evidence.preservedOlderVendor
        ? preserved
        : verified;
    records.push({ route, harness, ...evidence });
    console.log(JSON.stringify(records.at(-1)));
  } catch (error) {
    failed.push(`${route}:${harness}`);
    console.log(
      `FAILED ${route} ${harness}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Install with the vendor's installer, read it back, install again as a no-op. */
function installRoute(program, env) {
  const initial = cli(env, ["harness", "inspect", program.id]).harnesses[0];
  if (initial.selection.path)
    throw new Error(
      `Runner already selects ${initial.selection.path}; this would not prove installation.`,
    );
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
  installed.add(program.id);
  return { path: receipt.after.path, version: receipt.after.version, commands: receipt.commands };
}

/** The installed program's own update verb, under the engine's environment. */
function updateRoute(program, env) {
  if (!installed.has(program.id))
    throw new Error("Installation phase did not establish this program on the runner");
  const row = cli(env, ["harness", "inspect", program.id]).harnesses[0];
  if (!row.selection.path) throw new Error("no program is selected to update");
  if (!row.actions.update.available)
    throw new Error(`Installed route has no update action: ${row.actions.update.reason}`);
  const receipt = cli(env, ["harness", "update", program.id, "--yes"], { refusal: true });
  // A vendor's own refusal (an unauthenticated rate limit, for one) is a complete,
  // honest result when the program still answers; it is printed, not counted.
  if (!receipt.ok && receipt.problem?.code === "vendor_command_failed" && receipt.after?.version)
    return { vendorRefused: receipt.progress, exitCode: receipt.exitCode };
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
  const home = machineHome ?? join(root, `npm-${program.id}`);
  const env = environment(home);
  const prefix = join(home, ".claudexor", "node");
  if (win && !installed.has(program.id))
    throw new Error("Windows installation phase did not establish the existing vendor copy");
  if (win) {
    const vendor = cli(env, ["harness", "inspect", program.id]).harnesses[0].selection;
    if (!vendor.path || !vendor.version || vendor.path.startsWith(prefix + sep))
      throw new Error(
        "Windows conversion requires the healthy vendor copy established by the earlier phases",
      );
  }
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
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const names =
    typeof pkg.bin === "string" ? [pkg.name.split("/").at(-1)] : Object.keys(pkg.bin ?? {});
  const launchers = names.map((name) =>
    win ? join(prefix, `${name}.cmd`) : join(prefix, "bin", name),
  );
  if (!launchers.length || launchers.some((path) => !present(path)))
    throw new Error("Real npm did not create its declared launchers");
  const before = cli(env, ["harness", "inspect", program.id]).harnesses[0];
  if (!before.selection.realPath?.startsWith(packageRoot + sep))
    throw new Error(
      `the npm copy is not the selected program: ${JSON.stringify(before.selection)}`,
    );
  if (!before.actions.update.available)
    throw new Error(`Conversion unavailable: ${before.actions.update.reason}`);
  const receipt = cli(env, ["harness", "update", program.id, "--yes"], { refusal: true });
  const after = cli(env, ["harness", "inspect", program.id]).harnesses[0];
  // A published installer may lag npm. A proved downgrade refusal is a guarded
  // route, not a claimed conversion; the old program and launchers must survive.
  if (!receipt.ok && receipt.problem?.code === "conversion_older_program") {
    const replacement = receipt.elsewhere?.after;
    if (
      receipt.exitCode !== 0 ||
      !replacement?.version ||
      programUpdateAvailable(
        program.versionScheme,
        replacement.version,
        before.selection.version,
      ) !== "yes" ||
      after.selection.path !== before.selection.path ||
      after.selection.version !== before.selection.version ||
      !present(packageRoot) ||
      launchers.some((path) => !present(path))
    )
      throw new Error(`Unsafe downgrade refusal: ${JSON.stringify({ receipt, after })}`);
    return {
      preservedOlderVendor: true,
      before: before.selection.version,
      vendor: replacement.version,
      progress: receipt.progress,
    };
  }
  if (
    !receipt.ok ||
    !after.selection.path ||
    !after.selection.version ||
    after.selection.realPath?.startsWith(packageRoot + sep) ||
    existsSync(packageRoot) ||
    launchers.some(present)
  )
    throw new Error(
      `the npm copy was not replaced by a verified vendor copy: ${JSON.stringify({ receipt, after: after.selection, oldPackageExists: existsSync(packageRoot), oldLaunchersPresent: launchers.filter(present) })}`,
    );
  return {
    npm: `${program.legacyNpmPackage}@${old}`,
    before: { path: before.selection.path, version: before.selection.version },
    after: { path: after.selection.path, version: after.selection.version },
    outcome: receipt.outcome,
    limitations: receipt.limitations,
    exitCode: receipt.exitCode,
    progress: receipt.progress,
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

const user = environment(machineHome ?? join(root, "home"));
console.log(
  JSON.stringify({
    platform,
    installationHome: user.HOME,
    windowsFolders: win ? "actual ephemeral runner profile; all phases share it" : null,
  }),
);
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
    vendorRefused: refused,
    guardedRefusals: preserved,
    failed,
    root,
    limitations: ["No vendor login, model execution, or app-server compatibility claim."],
  }),
);
if (failed.length) throw new Error(`Vendor program routes failed: ${failed.join(", ")}`);
