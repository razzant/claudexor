// Synthetic WinGet and Copilot programs, real CLI resolution/Update and NTFS.
// The same harness runs against two independent builds on one hosted runner.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { retainCliResult, waitForExit } from "./capture-qualification.mjs";
import {
  checkConversion,
  checkConversionBaseline,
  checkConversionEffects,
  checkSelection,
  requireFixture,
  SHORT_HOLD_MS,
} from "./conversion-verdict.mjs";

if (
  process.platform !== "win32" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted"
)
  throw new Error("Use a disposable GitHub-hosted Windows runner");

const repo = resolve(import.meta.dirname, "../..");
const temp = realpathSync.native(process.env.RUNNER_TEMP);
const scratch = mkdtempSync(join(temp, "c672-"));
const evidence = join(temp, "copilot-conversion-evidence");
mkdirSync(evidence);
const save = (dir, name, value) =>
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + "\n");
const fixture = join(scratch, "fixture.exe");
const versionArgs = ["--no-auto-update", "--version"];
const control = join(repo, "control");
const read = (dir, name) => readFileSync(join(dir, name), "utf8");
const invoke = (dir, id, binary, args, options) =>
  retainCliResult(
    dir,
    id,
    [binary, ...args],
    spawnSync(binary, args, { timeout: 90_000, windowsHide: true, ...options }),
  );

const revisions = {};
for (const [name, tree] of Object.entries({ control, candidate: repo })) {
  const git = invoke(evidence, name, "git", ["rev-parse", "HEAD"], { cwd: tree });
  assert.equal(git.status, 0);
  revisions[name] = git.stdout.trim();
}
save(evidence, "subjects.json", { ...revisions, node: process.version, arch: process.arch });
assert.equal(revisions.control, process.env.C672_BASE_SHA);
assert.equal(revisions.candidate, process.env.GITHUB_SHA);
const csc = join(process.env.SystemRoot, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
const compiled = invoke(
  evidence,
  "compile",
  csc,
  ["/nologo", "/target:exe", `/out:${fixture}`, join(import.meta.dirname, "conversion-fixture.cs")],
  { cwd: scratch },
);
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);

function makeCase(name, dir) {
  const home = join(scratch, name);
  const prefix = join(home, ".claudexor/node");
  const pkg = join(prefix, "node_modules/@github/copilot");
  const old = join(pkg, "bin/copilot.exe");
  const local = join(home, "AppData/Local");
  const vendor = join(local, "GitHubCopilotCLI/copilot.exe");
  const installer = join(prefix, "winget.exe");
  const shim = join(prefix, "copilot.cmd");
  const tmp = join(home, "temp");
  for (const path of [dirname(old), dirname(vendor), tmp]) mkdirSync(path, { recursive: true });
  for (const path of [old, vendor, installer]) copyFileSync(fixture, path);
  writeFileSync(old + ".version", "1.0.113");
  writeFileSync(vendor + ".version", "1.0.114");
  save(pkg, "package.json", {
    name: "@github/copilot",
    version: "1.0.113",
    bin: { copilot: "bin/copilot.exe" },
  });
  const template = read(repo, "packages/core/src/fixtures/npm-launch/native.cmd");
  const target = String.raw`@github\copilot\bin\copilot.exe`;
  writeFileSync(shim, template.replace(String.raw`@fixture\tool\bin\tool.exe`, target));
  // Only fixture folders are on inherited PATH; no real WinGet or account
  // home is supplied to the CLI. Its normal resolver adds the managed prefix.
  const env = {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: local,
    APPDATA: join(home, "AppData/Roaming"),
    PATH: prefix,
    PATHEXT: ".EXE;.CMD",
    SYSTEMROOT: process.env.SystemRoot,
    WINDIR: process.env.SystemRoot,
    COMSPEC: process.env.ComSpec,
    TEMP: tmp,
    TMP: tmp,
    COPILOT_HOME: dir,
    C672_PACKAGE: pkg,
  };
  return { home, pkg, old, shim, vendor, installer, env };
}

async function withHolder(paths, dir, mode, update) {
  if (mode === "healthy") return update();
  // The same no-delete handle and file as the qualified held-file control.
  const file = join(paths.pkg, "package.json");
  const trigger = mode === "release" ? "first-denial.json" : "update-finished";
  const output = openSync(join(dir, "holder.log"), "wx");
  let holder;
  try {
    holder = spawn(fixture, ["hold", file, trigger, String(SHORT_HOLD_MS)], {
      cwd: paths.home,
      env: paths.env,
      stdio: ["ignore", output, output],
      windowsHide: true,
    });
  } finally {
    closeSync(output);
  }
  let launchError;
  holder.on("error", (error) => {
    launchError = error;
  });
  try {
    const deadline = performance.now() + 30_000;
    while (!existsSync(join(dir, "holder-ready"))) {
      if (launchError) throw launchError;
      requireFixture(holder.exitCode === null && performance.now() < deadline, "holder not ready");
      await delay(10);
    }
    assert.equal(read(dir, "holder-ready"), holder.pid + "\t" + file);
    return update();
  } finally {
    writeFileSync(join(dir, "update-finished"), String(process.hrtime.bigint() / 1_000_000n));
    const exited = holder.pid ? await waitForExit(holder, 30_000) : false;
    save(dir, "holder-exit.json", { pid: holder.pid, exited, code: holder.exitCode, trigger });
  }
}

async function qualify(tree, subject, mode, dir) {
  const paths = makeCase(`${subject}-${mode}`, dir);
  const options = { env: paths.env, cwd: paths.home };
  const run = (id, binary, args) => invoke(dir, id, binary, args, options);
  const cli = join(tree, "packages/cli/dist/cli.js");
  const inspect = (id) =>
    run(id, process.execPath, [cli, "harness", "inspect", "copilot", "--json"]);
  const before = inspect("before");
  assert.equal(before.status, 0, before.stderr);
  checkSelection(before.receipt.harnesses[0].selection, paths.old, "1.0.113");
  const seed = run("coexisting-vendor", paths.vendor, versionArgs);
  assert.equal(seed.status, 0, seed.stderr);
  assert.equal(seed.stdout.trim(), "1.0.114");

  const priorCalls = read(dir, "programs.tsv").length;
  const update = await withHolder(paths, dir, mode, () =>
    run("update", process.execPath, [
      "--require",
      join(import.meta.dirname, "conversion-watch.cjs"),
      cli,
      "harness",
      "update",
      "copilot",
      "--yes",
      "--json",
    ]),
  );
  const calls = read(dir, "programs.tsv").slice(priorCalls);
  writeFileSync(join(dir, "update-programs.tsv"), calls);
  const present = (path) => !!lstatSync(path, { throwIfNoEntry: false });
  const disk = {
    pkg: present(paths.pkg),
    shim: present(paths.shim),
    sibling: present(paths.pkg + ".claudexor-converted"),
  };
  save(dir, "retirement.json", disk);
  const after = inspect("after");
  const direct = run("vendor-after", paths.vendor, versionArgs);
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stdout.trim(), "1.0.114");

  // Normalize only the private home in actual executable calls. Preserve the
  // program identity, order and all arguments when comparing both revisions.
  const transcript = calls
    .trimEnd()
    .split("\n")
    .map((line) => {
      const [image, ...args] = line.split("\t");
      return [relative(paths.home, image).toLowerCase(), ...args];
    });
  checkConversionEffects(paths, update, after, disk, transcript, versionArgs);
  const trace = JSON.parse(read(dir, "renames.json"));
  assert.equal(existsSync(join(dir, "first-denial.json")), mode !== "healthy");
  if (mode !== "healthy") {
    const first = JSON.parse(read(dir, "first-denial.json"));
    assert.equal(first.deniedMs, trace[0].deniedMs);
    assert.deepEqual(first.error, trace[0].error);
  }

  let release;
  if (mode !== "healthy") {
    const holder = JSON.parse(read(dir, "holder-exit.json"));
    if (!holder.exited || holder.code !== 0) {
      release = { gap: "holder cleanup incomplete; see holder.log" };
    } else if (!existsSync(join(dir, "holder-released"))) {
      release = { gap: "holder exited without a release acknowledgment" };
    } else {
      const [pid, signal, seen, closing, closed] = read(dir, "holder-released").split("\t");
      release =
        Number(pid) === holder.pid
          ? {
              signal,
              seenMs: Number(seen),
              closingMs: Number(closing),
              closedMs: Number(closed),
              finishedMs: Number(read(dir, "update-finished")),
            }
          : { gap: "release acknowledgment belongs to a different PID" };
    }
    save(dir, "holder-timing.json", release);
  }
  const promoted = mode === "healthy" || (subject === "candidate" && mode === "release");
  checkConversion(subject, mode, promoted, update, trace, release);
  return transcript;
}

const baseline = {};
for (const [subject, tree, modes] of [
  ["control", control, ["healthy", "release"]],
  ["candidate", repo, ["healthy", "release", "persistent"]],
]) {
  for (const mode of modes) {
    const dir = join(evidence, subject + "-" + mode);
    mkdirSync(dir);
    try {
      const calls = await qualify(tree, subject, mode, dir);
      if (subject === "control") baseline[mode] = calls;
      else checkConversionBaseline(mode, calls, baseline);
      save(dir, "verdict.json", { passed: true });
      console.log(`${subject} ${mode} passed`);
    } catch (error) {
      const status = error.code === "fixture_gap" ? "gap" : "failed";
      save(dir, "verdict.json", { passed: false, status, error: error.stack });
      console.error(`${subject} ${mode}: ${error.stack}`);
      process.exitCode = 1;
    }
  }
}
