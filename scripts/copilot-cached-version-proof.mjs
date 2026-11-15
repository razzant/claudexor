#!/usr/bin/env node
/** Disposable-runner proof that the engine's version readers report an installed
 * older Copilot while the vendor's own package cache holds a newer release, and
 * a separate observation of the engine's first (cold) switched question.
 * Real npm copies: the older one where earlier engines installed it, the newer
 * one in a separate prefix outside selection, whose own first launch fills the
 * shared cache. No installer script, Update, login or model call. Evidence goes
 * to $RUNNER_TEMP/copilot-cached-version-evidence: the complete output of the
 * npm commands, the seed, the direct asks, the engine's sync questions, the CLI
 * process and any process census. The async reader and the program inside
 * `harness inspect` are kept as their answers. See
 * scripts/lib/copilot-cached-version-proof.mjs for the verdicts.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessPrograms } from "../packages/cli/dist/harness-programs.js";
import { installerRuntime } from "../packages/cli/dist/harness-install-runtime.js";
import { managedNodeRoot, npmGlobalPackagesDir } from "../packages/core/dist/index.js";
import { copilot } from "../packages/harness-acp/dist/index.js";
import { assertNativeRunSelection, runProofNpm } from "./lib/vendor-program-smoke.mjs";
import {
  PROOF_EXIT,
  annotation,
  chooseVersions,
  classifyCachedVersionProof,
  copilotCacheRoots,
  inspectThroughCli,
  inventoryCache,
  observeCachedVersionContrast,
  observedSpawn,
  proofEnvironment,
  proofSummary,
  removedVendorKey,
} from "./lib/copilot-cached-version-proof.mjs";

if (process.env.GITHUB_ACTIONS !== "true")
  throw new Error("Real vendor proof requires an ephemeral GitHub Actions runner.");
const platform = process.platform;
const win = platform === "win32";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const temp = realpathSync.native(process.env.RUNNER_TEMP ?? tmpdir());
const root = mkdtempSync(join(temp, "copilot-cached-version-"));
const evidenceDir = join(temp, "copilot-cached-version-evidence");
mkdirSync(evidenceDir, { recursive: true });
const save = (name, text) => writeFileSync(join(evidenceDir, name), text, { flag: "wx" });
// The vendor cache follows the OS profile; Windows keeps the actual runner's.
const home = win ? process.env.USERPROFILE : join(root, "home");
if (!home) throw new Error("Windows runner has no USERPROFILE");
const programs = harnessPrograms();
const program = programs.find((entry) => entry.id === "copilot");
const overrideKeys = programs.map((entry) => entry.overrideEnv);
const env = proofEnvironment(process.env, {
  home,
  configDir: join(root, "config"),
  platform,
  overrideKeys,
});
for (const key of Object.keys(process.env))
  if (removedVendorKey(key, overrideKeys)) delete process.env[key];
for (const path of [home, env.CLAUDEXOR_CONFIG_DIR]) mkdirSync(path, { recursive: true });
const runtime = installerRuntime(program, { sourceEnv: env });
const evidence = {
  schema: "copilot-cached-version-proof/3",
  platform,
  arch: process.arch,
  node: process.version,
  root,
  evidenceDir,
  home,
  profile: win ? "actual ephemeral Windows runner profile" : "disposable HOME",
  npm: [],
};
// Each npm command keeps both streams, whether it succeeds or not.
const npm = (name, args) =>
  runProofNpm(env, args, {
    cwd: root,
    spawn: (...call) => {
      const observed = observedSpawn(spawnSync, ...call, evidenceDir, name);
      evidence.npm.push(observed.record);
      return observed.result;
    },
  });
try {
  const published = JSON.parse(
    npm("npm-view-versions", ["view", program.legacyNpmPackage, "versions", "--json"]),
  );
  const chosen = chooseVersions(published);
  if (!chosen) throw new Error("fewer than two stable releases are published");
  const preSetupCache = inventoryCache(copilotCacheRoots(runtime.environment, platform));
  const prefix = managedNodeRoot(home);
  const seedPrefix = join(root, "seed-npm");
  for (const [name, target, version] of [
    ["npm-install-installed", prefix, chosen.installed],
    ["npm-install-seed", seedPrefix, chosen.cached],
  ])
    npm(name, [
      "install",
      "--global",
      "--prefix",
      target,
      "--no-audit",
      "--no-fund",
      `${program.legacyNpmPackage}@${version}`,
    ]);
  const packageDir = join(
    npmGlobalPackagesDir(prefix, platform),
    ...program.legacyNpmPackage.split("/"),
  );
  Object.assign(
    evidence,
    await observeCachedVersionContrast({
      program,
      runFlags: JSON.stringify(copilot.program) === JSON.stringify(program) ? copilot.flags : [],
      runtime,
      cwd: root,
      evidenceDir,
      installed: { version: chosen.installed, packageDir },
      cached: { version: chosen.cached },
      seedLauncher: win ? join(seedPrefix, "copilot.cmd") : join(seedPrefix, "bin", "copilot"),
      preSetupCache,
      inspect: () =>
        inspectThroughCli({
          cliPath: join(repo, "packages/cli/dist/cli.js"),
          env,
          cwd: root,
          evidenceDir,
        }),
      nativeSelection: (selected) => assertNativeRunSelection(program, selected, env, root),
    }),
  );
} catch (error) {
  evidence.setupError = error instanceof Error ? error.message : String(error);
  save("setup-error.txt", error instanceof Error ? (error.stack ?? error.message) : String(error));
}
const verdict = classifyCachedVersionProof(evidence);
const report = JSON.stringify({ ...evidence, verdict }, null, 2);
save("copilot-cached-version-proof.json", report);
console.log(report);
const summary = proofSummary(evidence, verdict);
save("summary.md", summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
// One annotation per distinct finding; a part repeating earlier reasons adds none.
const shown = new Set();
for (const [name, part] of [
  ["precondition", verdict.precondition],
  ["cache answer", verdict.cacheAnswer],
  ["cold start", verdict.coldStart],
]) {
  const message = part.reasons.join("\n");
  if (part.status === "passed" || part.status === "established" || shown.has(message)) continue;
  shown.add(message);
  console.log(annotation("error", `Copilot ${name} ${part.status}`, message));
}
for (const line of verdict.limitations)
  console.log(annotation("warning", "Copilot cached-version proof", line));
process.exitCode = PROOF_EXIT[verdict.status];
