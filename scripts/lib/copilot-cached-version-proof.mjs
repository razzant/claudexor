/** Observation and verdicts for the real Copilot installed-old/cached-new proof.
 *
 * Copilot's launcher runs the newest newer package in its per-user package cache
 * unless `--no-auto-update` is given; with it, the launcher runs (extracting on
 * first use) the package bundled in the binary. A newer release's own first
 * launch extracts its bundle into that shared cache. The proof seeds the cache
 * that way, asks the installed copy directly with and without the declared
 * switch, then reads the version through the engine's consumers. The cache
 * answer and the cold first question are separate verdicts; only an
 * established contrast with both passing is a pass. The direct asks use the
 * engine's 10 s limit, so a slower vendor leaves the contrast unestablished.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { performance } from "node:perf_hooks";
import {
  interpretedCommand,
  programUpdateAvailable,
  resolveSelectedProgram,
  resolveSelectedProgramAsync,
  selectProgramEntry,
} from "../../packages/core/dist/index.js";

/** Only `passed` exits 0; `not_run` keeps the acceptance open instead of green. */
export const PROOF_EXIT = { passed: 0, failed: 1, not_run: 3 };

export function removedVendorKey(key, overrideKeys) {
  return (
    /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) ||
    /^COPILOT_/i.test(key) ||
    /^(CODEX_HOME|CODEX_INSTALL_DIR|CLAUDE_CONFIG_DIR|CURSOR_CONFIG_DIR|XDG_.*_HOME)$/i.test(key) ||
    overrideKeys.includes(key)
  );
}

/** Runner environment without credentials, program overrides or vendor state
 * locations. POSIX gets the disposable HOME; Windows keeps its actual profile. */
export function proofEnvironment(source, { home, configDir, platform, overrideKeys }) {
  const env = { ...source };
  for (const key of Object.keys(env)) if (removedVendorKey(key, overrideKeys)) delete env[key];
  Object.assign(env, { HOME: home, CLAUDEXOR_CONFIG_DIR: configDir, CI: "true" });
  if (platform !== "win32")
    Object.assign(env, {
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
    });
  return env;
}

/** The launcher's package-cache search roots, in its order; the first one also
 * receives the bundled package's extraction. */
export function copilotCacheRoots(env, platform) {
  const get = (key) =>
    platform === "win32"
      ? Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1]
      : env[key];
  const home = get(platform === "win32" ? "USERPROFILE" : "HOME");
  const xdgCache = get("XDG_CACHE_HOME") || join(home, ".cache");
  const platformCache =
    platform === "darwin"
      ? join(home, "Library", "Caches", "copilot")
      : platform === "win32"
        ? join(get("LOCALAPPDATA") || join(home, ".cache"), "copilot")
        : join(xdgCache, "copilot");
  const roots = [
    get("COPILOT_PKG_CACHE_HOME") && join(get("COPILOT_PKG_CACHE_HOME"), "pkg"),
    get("COPILOT_CACHE_HOME") && join(get("COPILOT_CACHE_HOME"), "pkg"),
    join(platformCache, "pkg"),
    join(xdgCache, "copilot", "pkg"),
    get("COPILOT_HOME") && join(get("COPILOT_HOME"), "pkg"),
    join(home, ".copilot", "pkg"),
  ];
  return [...new Set(roots.filter(Boolean))];
}

/** Bounded listing of every package directory below the cache roots, kept as
 * diagnostics only: a directory it cannot list reads as empty and each listing
 * keeps its first `limit` names, so no verdict depends on it. */
export function inventoryCache(roots, limit = 64) {
  const list = (dir) => {
    try {
      return readdirSync(dir).sort().slice(0, limit);
    } catch {
      return [];
    }
  };
  const entries = {};
  for (const root of roots)
    for (const group of list(root))
      for (const name of list(join(root, group))) {
        const dir = join(root, group, name);
        entries[dir] = {
          complete: existsSync(join(dir, ".extraction-complete")),
          index: existsSync(join(dir, "index.js")),
        };
      }
  return entries;
}

/** One direct look at a path. It is absent only when the path or a parent is
 * missing; any other failure to look leaves it unknown. */
export function pathState(path) {
  try {
    statSync(path);
    return { path, state: "present" };
  } catch (error) {
    const code = error?.code ?? String(error);
    return { path, state: ["ENOENT", "ENOTDIR"].includes(code) ? "absent" : "unknown", code };
  }
}

function inventoryChanges(before, after) {
  const changes = [];
  for (const [dir, entry] of Object.entries(after))
    if (!before[dir]) changes.push({ dir, change: "added", ...entry });
    else if (before[dir].complete !== entry.complete || before[dir].index !== entry.index)
      changes.push({ dir, change: "changed", ...entry });
  for (const dir of Object.keys(before)) if (!after[dir]) changes.push({ dir, change: "removed" });
  return changes;
}

/** The newest stable release and the one before it. */
export function chooseVersions(published) {
  const order = (version) => version.split(".").map(Number);
  const stable = [...new Set([published].flat())]
    .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
    .sort((a, b) => order(a).reduce((sum, part, i) => sum || part - order(b)[i], 0));
  return stable.length > 1 ? { installed: stable.at(-2), cached: stable.at(-1) } : null;
}

function fileIdentity(path) {
  if (!path) return null;
  try {
    const realPath = realpathSync(path);
    const sha256 = createHash("sha256").update(readFileSync(realPath)).digest("hex");
    return { path, realPath, size: statSync(realPath).size, sha256 };
  } catch (error) {
    return { path, error: error.code ?? String(error) };
  }
}

/** The binary the npm loader spawns, resolved from the loader as it resolves it. */
function npmPlatformBinary(loader, platform, arch) {
  const require = createRequire(loader);
  for (const name of platform === "linux" ? ["linux", "linuxmusl"] : [platform])
    try {
      return require.resolve(`@github/copilot-${name}-${arch}`);
    } catch {
      /* the loader tries the next platform package too */
    }
  return null;
}

/** First-line version, parsed as the engine's reader parses it. */
function answeredVersion(stdout) {
  const [line = ""] = String(stdout ?? "")
    .trim()
    .split(/\r?\n/);
  const version =
    /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$|[.,;:!?)](?![0-9A-Za-z]))/;
  return version.exec(line)?.[1] ?? null;
}

function envFacts(env = {}) {
  const pairs = Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  const pick = (key) => pairs.find(([name]) => name.toUpperCase() === key)?.[1] ?? null;
  const facts = ["HOME", "USERPROFILE", "LOCALAPPDATA", "XDG_CACHE_HOME", "CI", "PATH"];
  return {
    sha256: createHash("sha256").update(JSON.stringify(pairs)).digest("hex"),
    keys: pairs.length,
    ...Object.fromEntries(facts.map((key) => [key, pick(key)])),
  };
}

/** Run one child and keep its complete outcome. The full stdout and stderr go to
 * `<label>.stdout.txt` and `<label>.stderr.txt` first; the record carries their
 * names, a bounded preview, argv, cwd, limit, env digest, exit, signal, spawn
 * error and wall time. */
export function observedSpawn(spawn, binary, args, options, evidenceDir, label) {
  const started = performance.now();
  const result = spawn(binary, args, options);
  const durationMs = Math.round(performance.now() - started);
  const output = (stream) => {
    const text = String(result[stream] ?? "");
    const file = `${label}.${stream}.txt`;
    writeFileSync(join(evidenceDir, file), text, { flag: "wx" });
    const preview = text.length > 4096 ? `${text.slice(0, 4096)}[+${text.length - 4096}]` : text;
    return { file, length: text.length, preview };
  };
  const record = {
    label,
    argv: [binary, ...args],
    cwd: options.cwd ?? null,
    timeoutMs: options.timeout ?? null,
    env: envFacts(options.env),
    exit: result.status ?? null,
    signal: result.signal ?? null,
    error: result.error ? { code: result.error.code ?? null, message: result.error.message } : null,
    stdout: output("stdout"),
    stderr: output("stderr"),
    durationMs,
  };
  return { result, record };
}

/** A direct vendor answer through the engine's own selected entry, interpreter
 * and environment, with the sync reader's spawn options; only argv varies. */
function askVendor(selected, args, envPatch, { cwd, spawn, evidenceDir, label, timeoutMs }) {
  const { command } = selected;
  const env = { ...selected.env, ...envPatch };
  const invocation = interpretedCommand(command.entrypoint, args, env, command.interpreter);
  const options = {
    env: invocation.env,
    cwd,
    encoding: "utf8",
    timeout: timeoutMs ?? 10_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  };
  const { result, record } = observedSpawn(
    spawn,
    invocation.binary,
    invocation.args,
    options,
    evidenceDir,
    label,
  );
  const answered = result.status === 0 && !result.error;
  return { ...record, version: answered ? answeredVersion(result.stdout) : null };
}

/** `harness inspect` through the built CLI entrypoint, as a user runs it. */
export function inspectThroughCli({ cliPath, env, cwd, evidenceDir, spawn = spawnSync }) {
  const args = [cliPath, "harness", "inspect", "copilot", "--json"];
  const options = { env, cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 8 << 20 };
  const { result, record } = observedSpawn(
    spawn,
    process.execPath,
    args,
    { ...options, windowsHide: true },
    evidenceDir,
    "cli-harness-inspect",
  );
  try {
    if (result.status === 0)
      return { record, selection: JSON.parse(result.stdout).harnesses[0].selection };
  } catch {
    /* unparseable output stays in its evidence file */
  }
  return { record, selection: null };
}

/** Processes still running files below `needle`, read after a stopped question.
 * The record lists at most 50 matching lines; a recording `spawn` keeps the rest. */
export function processCensus(needle, { platform = process.platform, spawn = spawnSync } = {}) {
  const [binary, ...args] =
    platform === "win32"
      ? [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | ForEach-Object { [string]::Join([char]9, @($_.ProcessId, $_.ParentProcessId, $_.CommandLine)) }",
        ]
      : ["ps", "axww", "-o", "pid=,ppid=,pgid=,etime=,command="];
  const result = spawn(binary, args, { encoding: "utf8", timeout: 30_000, windowsHide: true });
  const lines = String(result.stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.toLowerCase().includes(needle.toLowerCase()));
  return { command: [binary, ...args], exit: result.status ?? null, lines: lines.slice(0, 50) };
}

const within = (path, dir) => {
  try {
    const [inner, outer] = [path, dir].map((value) => realpathSync(value));
    const fold = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
    return fold(inner).startsWith(fold(outer) + sep);
  } catch {
    return false;
  }
};
const timed = async (read) => {
  const started = performance.now();
  const selection = await read();
  return { selection, durationMs: Math.round(performance.now() - started) };
};

/** Seed the cache with the newer release's own first launch, establish the
 * vendor contrast directly, then read through every engine consumer. Cache
 * checkpoints attribute each cache change to the step before it. */
export async function observeCachedVersionContrast(input) {
  const { program, runtime, cwd, installed, seedLauncher, evidenceDir } = input;
  const spawn = input.spawn ?? spawnSync;
  const roots = copilotCacheRoots(runtime.environment, runtime.platform);
  const question = {
    args: [...(program.childUpdateArgs ?? []), "--version"],
    env: { ...program.childUpdateEnv },
  };
  const loader = join(installed.packageDir, "npm-loader.js");
  const files = () => ({
    launcherLoader: fileIdentity(loader),
    platformBinary: fileIdentity(npmPlatformBinary(loader, runtime.platform, runtime.arch)),
    seedLauncher: fileIdentity(seedLauncher),
  });
  const evidence = {
    versions: { installed: installed.version, cached: input.cached.version },
    declared: {
      versionQuestion: question,
      runFlags: input.runFlags,
      runFlagsCarrySwitch: (program.childUpdateArgs ?? []).every((arg) =>
        input.runFlags.includes(arg),
      ),
    },
    cacheRoots: roots,
    cache: [],
    identityBefore: files(),
  };
  const checkpoint = (label, entries = inventoryCache(roots)) => {
    const prior = evidence.cache.at(-1)?.entries;
    evidence.cache.push({ label, entries, changes: prior ? inventoryChanges(prior, entries) : [] });
    return entries;
  };
  const ask = (selected, args, envPatch, label, timeoutMs) =>
    askVendor(selected, args, envPatch, { cwd, spawn, evidenceDir, label, timeoutMs });
  try {
    if (input.preSetupCache) checkpoint("before npm installs", input.preSetupCache);
    checkpoint("after npm installs");
    const seed = selectProgramEntry(program, {
      ...runtime,
      sourceEnv: { ...runtime.sourceEnv, [program.overrideEnv]: seedLauncher },
    });
    evidence.seed = seed.command ? ask(seed, ["--version"], {}, "seed", 180_000) : null;
    checkpoint("after setup: the newer release's own first launch");
    const selected = selectProgramEntry(program, runtime);
    evidence.selection = {
      ...selected.observed,
      entrypoint: selected.command?.entrypoint ?? null,
      interpreter: selected.command?.interpreter?.binary ?? null,
      installedCopy: Boolean(
        selected.observed.realPath && within(selected.observed.realPath, installed.packageDir),
      ),
    };
    if (!selected.command) throw new Error("the engine selected no Copilot entry");
    evidence.precondition = { unswitched: ask(selected, ["--version"], {}, "direct-unswitched") };
    checkpoint("after the installed copy's unswitched answer");
    // Coldness rests on one direct look at the bundled package's marker.
    const bundledDir = join(roots[0], `${runtime.platform}-${runtime.arch}`, installed.version);
    evidence.unwarmed = { bundledDir, marker: pathState(join(bundledDir, ".extraction-complete")) };
    const syncRead = async (label, declaration = program) => {
      let child = null;
      const recorder = (binary, args, options) => {
        const observed = observedSpawn(spawn, binary, args, options, evidenceDir, label);
        child = observed.record;
        return observed.result;
      };
      const read = await timed(() =>
        resolveSelectedProgram(declaration, { ...runtime, cwd, spawn: recorder }),
      );
      return { ...read, child };
    };
    const cold = await syncRead("engine-sync-1-first-switched");
    checkpoint("after the engine's first switched question");
    if (cold.child?.error?.code === "ETIMEDOUT") {
      let output = null;
      const census = (input.census ?? processCensus)(installed.packageDir, {
        platform: runtime.platform,
        spawn: (...call) => {
          const observed = observedSpawn(spawn, ...call, evidenceDir, "census");
          output = observed.record;
          return observed.result;
        },
      });
      evidence.unwarmed.census = { ...census, output };
    }
    const reread = await syncRead("engine-sync-2-same-switched-reread");
    evidence.precondition.switched = ask(selected, question.args, question.env, "direct-switched");
    const moduleAsync = await timed(() =>
      resolveSelectedProgramAsync(program, { ...runtime, cwd }),
    );
    const cliInspect = await input.inspect();
    let nativeRunSelection;
    try {
      nativeRunSelection = { path: await input.nativeSelection(reread.selection) };
    } catch (error) {
      nativeRunSelection = { error: error instanceof Error ? error.message : String(error) };
    }
    const control = await syncRead("engine-sync-3-control-without-switch", {
      ...program,
      childUpdateArgs: undefined,
      childUpdateEnv: undefined,
    });
    evidence.consumers = {
      moduleSync: { cold, reread, control },
      moduleAsync,
      cliInspect,
      nativeRunSelection,
    };
    checkpoint("final");
  } catch (error) {
    evidence.observationError = error instanceof Error ? error.message : String(error);
  }
  evidence.identityAfter = files();
  return evidence;
}

const describe = (record) =>
  !record
    ? "missing"
    : record.error
      ? (record.error.code ?? "spawn error")
      : record.exit !== 0
        ? `exit ${record.exit ?? record.signal}`
        : (record.version ?? "an unparsed answer");
const changed = (before, after) =>
  ["sha256", "error", "realPath"].some((key) => before?.[key] !== after?.[key]);
const endsWith = (argv, tail) =>
  Array.isArray(argv) && JSON.stringify(argv.slice(-tail.length)) === JSON.stringify(tail);

/** Separate verdicts: the precondition, the cache answer of every engine
 * consumer, and the cold first switched question. Overall `passed` needs all.
 * A failed setup leaves every part not run; a missing vendor contrast leaves
 * the cache answer not run while the asked cold question keeps its verdict. */
export function classifyCachedVersionProof(e) {
  const limitations = [];
  const notRun = (reasons) => ({ status: "not_run", reasons });
  const overall = (precondition, cacheAnswer, coldStart) => {
    const parts = [cacheAnswer, coldStart];
    const status = parts.some((part) => part.status === "failed")
      ? "failed"
      : precondition.status !== "established" || parts.some((part) => part.status !== "passed")
        ? "not_run"
        : "passed";
    return { status, precondition, cacheAnswer, coldStart, limitations };
  };
  const unknown = (reason) =>
    overall({ status: "not_established", reasons: [reason] }, notRun([reason]), notRun([reason]));
  if (e.setupError) return unknown(`setup did not complete: ${e.setupError}`);
  if (e.observationError) return unknown(`observation did not complete: ${e.observationError}`);
  const { installed, cached } = e.versions;
  const { unswitched, switched } = e.precondition;
  const newer = unswitched.version;
  const { cold, reread, control } = e.consumers.moduleSync;
  // Setup: the newer release seeded the cache and the engine asks the unchanged npm copy.
  const setup = [];
  // A cache that already holds an even newer package answers that one instead.
  if (programUpdateAvailable("semver", e.seed?.version ?? null, cached) !== "no")
    setup.push(`the newer release ${cached} answered ${describe(e.seed)} when seeding the cache`);
  if (!e.selection.installedCopy)
    setup.push(`the engine selected ${e.selection.realPath ?? "nothing"}, not the npm copy`);
  for (const file of ["launcherLoader", "platformBinary"])
    if (changed(e.identityBefore[file], e.identityAfter[file]))
      setup.push(`${file} changed during the proof`);
  // The vendor contrast: only the unswitched installed copy answers the newer release.
  const contrast = [];
  if (programUpdateAvailable("semver", installed, newer) !== "yes")
    contrast.push(`the unswitched answer was ${describe(unswitched)}, not newer than ${installed}`);
  if (switched.version !== installed)
    contrast.push(`the switched answer was ${describe(switched)}, not ${installed}`);
  if (newer && control.selection.version !== newer)
    contrast.push(
      `the reader without the declared switch answered ${control.selection.version}, not ${newer}`,
    );
  const missing = [...setup, ...contrast].map((reason) => `precondition: ${reason}`);
  if (!setup.length && !e.identityBefore.platformBinary)
    limitations.push("The npm platform binary was not located; only answers show a replacement.");

  // The first switched question is the only cold observation; a later answer
  // of the same question never stands in for it. It is cold only when its
  // marker was directly seen absent just before it.
  const firstAnswer = cold.selection.version;
  const outcome = !firstAnswer
    ? cold.child?.error?.code === "ETIMEDOUT"
      ? "unanswered_timeout"
      : "unanswered"
    : firstAnswer === installed
      ? "answered_installed"
      : firstAnswer === newer
        ? "answered_cached"
        : "answered_other";
  const coldFacts = { expected: installed, firstAnswer, outcome, durationMs: cold.durationMs };
  const { marker } = e.unwarmed;
  const warm =
    marker.state === "present"
      ? `${marker.path} existed before the first switched question`
      : `${marker.path} could not be read before the first switched question (${marker.code})`;
  const coldStart = setup.length
    ? { ...notRun(missing), ...coldFacts }
    : marker.state !== "absent"
      ? { ...notRun([warm]), ...coldFacts }
      : outcome === "answered_installed"
        ? { status: "passed", reasons: [], ...coldFacts }
        : {
            status: "failed",
            reasons: [
              `the first switched question gave ${firstAnswer ?? outcome}, not ${installed}`,
            ],
            ...coldFacts,
          };
  if (missing.length)
    return overall({ status: "not_established", reasons: missing }, notRun(missing), coldStart);

  const failures = [];
  const judge = (name, version) => {
    if (version === newer)
      failures.push(`${name} reported the cached ${newer} for the installed ${installed}`);
    else if (version !== installed)
      failures.push(`${name} reported ${version ?? "no version"}, not ${installed}`);
  };
  judge("the same switched sync re-read", reread.selection.version);
  judge("the async reader", e.consumers.moduleAsync.selection.version);
  judge("CLI harness inspect", e.consumers.cliInspect.selection?.version ?? null);
  const { nativeRunSelection } = e.consumers;
  for (const [name, path] of [
    ["the async reader", e.consumers.moduleAsync.selection.path],
    ["CLI harness inspect", e.consumers.cliInspect.selection?.path ?? null],
    ["native run selection", nativeRunSelection.path ?? null],
  ])
    if (path !== reread.selection.path) failures.push(`${name} selected ${path ?? "nothing"}`);
  if (nativeRunSelection.error) failures.push(`native run selection: ${nativeRunSelection.error}`);
  if (![cold, reread].every((read) => endsWith(read.child?.argv, e.declared.versionQuestion.args)))
    failures.push("a sync version question did not end with the declared switch and --version");
  if (cold.child?.argv[0] !== switched.argv[0] || cold.child?.cwd !== switched.cwd)
    failures.push(
      `the sync question ran ${cold.child?.argv[0]} in ${cold.child?.cwd}, the direct ask ${switched.argv[0]} in ${switched.cwd}`,
    );
  if (!e.declared.runFlagsCarrySwitch) failures.push("ordinary run flags lack the declared switch");
  const cacheAnswer = failures.length
    ? { status: "failed", reasons: failures }
    : { status: "passed", reasons: [] };
  return overall({ status: "established", reasons: [] }, cacheAnswer, coldStart);
}

/** A short Markdown summary for the job page; the JSON and output files stay
 * the evidence. Each verdict is shown on its own line. */
export function proofSummary(e, verdict) {
  const row = (label, version, durationMs, child) =>
    `| ${label} | ${version ?? (child ? describe(child) : "no version")} | ${durationMs ?? "-"} |`;
  const direct = (label, record) =>
    row(label, record?.version ?? describe(record), record?.durationMs);
  const read = (label, entry) =>
    row(label, entry.selection?.version, entry.durationMs, entry.child ?? entry.record);
  const c = e.consumers;
  const part = (name, value) =>
    `- ${name}: **${value.status}**${value.reasons.length ? ` (${value.reasons.join("; ")})` : ""}`;
  return [
    `### Copilot installed ${e.versions?.installed ?? "?"} with cached ${e.versions?.cached ?? "?"}: ${verdict.status.toUpperCase()}`,
    "",
    part("Precondition", verdict.precondition),
    part("Cache answer", verdict.cacheAnswer),
    `${part("Cold start", verdict.coldStart)}${verdict.coldStart.outcome ? `, first answer ${verdict.coldStart.firstAnswer ?? "none"} (${verdict.coldStart.outcome}) in ${verdict.coldStart.durationMs} ms` : ""}`,
    ...verdict.limitations.map((line) => `- ${line}`),
    "",
    "| Observation | Answer | ms |",
    "| --- | --- | --- |",
    direct("Seed: the newer release's own first launch", e.seed),
    direct("Installed copy, unswitched", e.precondition?.unswitched),
    ...(c
      ? [
          read("Engine sync, first switched question (cold)", c.moduleSync.cold),
          read("Engine sync, same switched re-read", c.moduleSync.reread),
          direct("Installed copy, switched", e.precondition.switched),
          read("Engine async", c.moduleAsync),
          row(
            "CLI harness inspect",
            c.cliInspect.selection?.version,
            c.cliInspect.record.durationMs,
          ),
          read("Engine sync without the declared switch (control)", c.moduleSync.control),
        ]
      : []),
    "",
  ].join("\n");
}

/** A GitHub workflow annotation with its message and title escaped. */
export function annotation(kind, title, message) {
  const data = (value) => value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return `::${kind} title=${data(title).replace(/:/g, "%3A").replace(/,/g, "%2C")}::${data(message)}`;
}
