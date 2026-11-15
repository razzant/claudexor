import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  composeBaseEnv,
  defineHarnessProgram,
  pickAllowlistedEnv,
  resolveSelectedProgramAsync,
} from "../../packages/core/dist/index.js";
import {
  PROOF_EXIT,
  annotation,
  chooseVersions,
  classifyCachedVersionProof,
  copilotCacheRoots,
  inspectThroughCli,
  observeCachedVersionContrast,
  pathState,
  processCensus,
  proofEnvironment,
  proofSummary,
} from "./copilot-cached-version-proof.mjs";
import { assertNativeRunSelection } from "./vendor-program-smoke.mjs";

const roots = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);
const scratch = (prefix) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};
const platformDir = `${process.platform}-${process.arch}`;
const program = defineHarnessProgram({
  id: "copilot",
  launchers: [{ name: "copilot" }],
  versionScheme: "semver",
  overrideEnv: "CLAUDEXOR_COPILOT_BIN",
  installationEnv: ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"],
  legacyNpmPackage: "@github/copilot",
  childUpdateArgs: ["--no-auto-update"],
  platforms: { [process.platform]: { launcherDirs: ["{home}/.local/bin"] } },
});

/** The launcher rules read from the vendor's 1.0.112 bundle, in small: an
 * unswitched --version answers the newest newer cached package; the switch
 * answers the bundled version, extracting it into the cache on first use. Each
 * call also writes more stderr than a record previews. */
function vendorSource(version, { refuseSwitch = false, replaces = null } = {}) {
  return `#!${process.execPath}
const { existsSync, mkdirSync, readdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2), switched = args.includes("--no-auto-update");
const home = process.env.HOME;
const root = process.platform === "darwin"
  ? join(home, "Library", "Caches", "copilot", "pkg")
  : join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "copilot", "pkg");
const dir = join(root, process.platform + "-" + process.arch);
const order = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
process.stderr.write("vendor note ".repeat(500));
if (switched && ${refuseSwitch}) { console.error("error: unknown option '--no-auto-update'"); process.exit(1); }
if (!switched && ${JSON.stringify(replaces)}) writeFileSync(${JSON.stringify(replaces)}, "replaced by an update");
let answer = switched ? undefined : (existsSync(dir) ? readdirSync(dir) : [])
  .filter((v) => existsSync(join(dir, v, "index.js")) && order(v, ${JSON.stringify(version)}) > 0).sort(order).at(-1);
if (!answer) {
  const own = join(dir, ${JSON.stringify(version)});
  if (!existsSync(join(own, ".extraction-complete"))) {
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "index.js"), "");
    writeFileSync(join(own, ".extraction-complete"), "");
  }
  answer = ${JSON.stringify(version)};
}
if (args.at(-1) !== "--version" || args.length > 2) { console.error("unexpected " + JSON.stringify(args)); process.exit(2); }
console.log("GitHub Copilot CLI " + answer + ".");
console.log("Run 'copilot update' to check for updates.");
`;
}

/** An npm-shaped global prefix whose launcher links to the vendor loader. */
function npmCopy(prefix, version, options) {
  const packageDir = join(prefix, "lib", "node_modules", "@github", "copilot");
  const platform = join(packageDir, "node_modules", "@github", `copilot-${platformDir}`);
  mkdirSync(join(prefix, "bin"), { recursive: true });
  mkdirSync(platform, { recursive: true });
  const binary = join(platform, "copilot");
  writeFileSync(join(platform, "package.json"), JSON.stringify({ exports: { ".": "./copilot" } }));
  writeFileSync(binary, `platform binary ${version}`);
  writeFileSync(
    join(packageDir, "npm-loader.js"),
    vendorSource(version, { ...options, replaces: options?.replace ? binary : null }),
    { mode: 0o755 },
  );
  symlinkSync(join(packageDir, "npm-loader.js"), join(prefix, "bin", "copilot"));
  return { packageDir, launcher: join(prefix, "bin", "copilot") };
}

/** `spawn` replaces the proof's child spawn; `prepare` receives the platform
 * directory of the first cache root before anything runs. */
async function observe({
  installed = "1.0.110",
  cached = "1.0.112",
  seed = true,
  spawn,
  prepare,
  ...vendor
} = {}) {
  const root = scratch("copilot-cached-proof-");
  const home = join(root, "home");
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir);
  const env = proofEnvironment(
    {
      PATH: "/usr/bin:/bin",
      GITHUB_TOKEN: "x",
      COPILOT_AUTO_UPDATE: "false",
      CLAUDEXOR_COPILOT_BIN: "/elsewhere",
    },
    {
      home,
      configDir: join(root, "config"),
      platform: process.platform,
      overrideKeys: [program.overrideEnv],
    },
  );
  const copy = npmCopy(join(home, ".claudexor", "node"), installed, vendor);
  const seedLauncher = seed
    ? npmCopy(join(root, "seed"), cached, {}).launcher
    : join(root, "missing");
  const runtime = {
    platform: process.platform,
    arch: process.arch,
    nodePath: process.execPath,
    sourceEnv: env,
    environment: {
      ...composeBaseEnv("clean", env, process.execPath, process.platform),
      ...pickAllowlistedEnv(env, program.installationEnv, process.platform),
      HOME: home,
    },
  };
  prepare?.(join(copilotCacheRoots(runtime.environment, process.platform)[0], platformDir));
  const evidence = await observeCachedVersionContrast({
    program,
    runFlags: ["--acp", "--stdio", "--no-auto-update"],
    runtime,
    cwd: root,
    evidenceDir,
    installed: { version: installed, packageDir: copy.packageDir },
    cached: { version: cached },
    seedLauncher,
    spawn,
    // Stands in for the built CLI entrypoint, which only the GitHub proof runs.
    inspect: async () => ({
      record: { durationMs: 0 },
      selection: await resolveSelectedProgramAsync(program, { ...runtime, cwd: root }),
    }),
    nativeSelection: (selected) => assertNativeRunSelection(program, selected, env, root),
  });
  return Object.assign(evidence, { evidenceDir });
}
const allReasons = (verdict) =>
  [verdict.precondition, verdict.cacheAnswer, verdict.coldStart]
    .flatMap((part) => part.reasons)
    .join("\n");
/** A fixed process listing longer than the census record keeps. */
const listing = Array.from(
  { length: 60 },
  (_, i) => `${i + 2} 1 ${i + 2} 00:01 /fixture/${i}\n`,
).join("");
/** Stops the chosen switched questions as spawnSync reports the engine's limit,
 * without waiting for it. The census gets the fixed listing, never the host's. */
const stopping = (stop) => {
  let asked = 0;
  return (binary, args, options) => {
    if (["ps", "powershell.exe"].includes(binary))
      return { output: [null, listing, ""], stdout: listing, stderr: "", status: 0, signal: null };
    if (!args.includes("--no-auto-update") || !stop(++asked))
      return spawnSync(binary, args, options);
    const error = Object.assign(new Error(`spawnSync ${binary} ETIMEDOUT`), { code: "ETIMEDOUT" });
    return {
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: null,
      signal: "SIGTERM",
      error,
    };
  };
};

describe.skipIf(process.platform === "win32")(
  "real engine readers against the launcher rules",
  () => {
    let passing;
    beforeAll(async () => {
      passing = await observe();
    });

    test("passes only when the cache answer and the cold first question both read the installed copy", () => {
      const verdict = classifyCachedVersionProof(passing);
      expect(verdict).toEqual({
        status: "passed",
        precondition: { status: "established", reasons: [] },
        cacheAnswer: { status: "passed", reasons: [] },
        coldStart: {
          status: "passed",
          reasons: [],
          expected: "1.0.110",
          firstAnswer: "1.0.110",
          outcome: "answered_installed",
          durationMs: expect.any(Number),
        },
        limitations: [],
      });
      expect(PROOF_EXIT[verdict.status]).toBe(0);
      expect(passing.precondition.unswitched.version).toBe("1.0.112");
      expect(passing.precondition.switched.version).toBe("1.0.110");
      const { cold, reread, control } = passing.consumers.moduleSync;
      expect([cold, reread].map((read) => read.selection.version)).toEqual(["1.0.110", "1.0.110"]);
      expect(cold.child.argv.slice(-2)).toEqual(["--no-auto-update", "--version"]);
      expect(control.child.argv.slice(-1)).toEqual(["--version"]);
      expect(control.selection.version).toBe("1.0.112");
      // Each cache change is attributed to the step that made it.
      const changes = Object.fromEntries(
        passing.cache.map((point) => [
          point.label,
          point.changes.map((change) => basename(change.dir)),
        ]),
      );
      expect(changes).toMatchObject({
        "after setup: the newer release's own first launch": ["1.0.112"],
        "after the installed copy's unswitched answer": [],
        "after the engine's first switched question": ["1.0.110"],
        final: [],
      });
    });

    test("keeps the full output of the seed, the direct asks and each sync question in named files", () => {
      const labels = [
        "seed",
        "direct-unswitched",
        "engine-sync-1-first-switched",
        "engine-sync-2-same-switched-reread",
        "direct-switched",
        "engine-sync-3-control-without-switch",
      ];
      expect(readdirSync(passing.evidenceDir).sort()).toEqual(
        labels.flatMap((label) => [`${label}.stderr.txt`, `${label}.stdout.txt`]).sort(),
      );
      const { stderr, stdout } = passing.consumers.moduleSync.cold.child;
      expect(stderr.length).toBe("vendor note ".length * 500);
      expect(stderr.preview.length).toBeLessThan(stderr.length);
      expect(readFileSync(join(passing.evidenceDir, stderr.file), "utf8")).toHaveLength(
        stderr.length,
      );
      expect(readFileSync(join(passing.evidenceDir, stdout.file), "utf8")).toBe(
        "GitHub Copilot CLI 1.0.110.\nRun 'copilot update' to check for updates.\n",
      );
    });

    test.each([
      ["an unseeded cache", { seed: false }, /seeding the cache.*not newer than 1\.0\.110/s],
      ["a binary replaced during the proof", { replace: true }, /platformBinary changed/],
    ])("%s leaves the acceptance not run, never passed", async (_name, options, reason) => {
      const evidence = await observe(options);
      const verdict = classifyCachedVersionProof(evidence);
      expect(verdict.status).toBe("not_run");
      expect(verdict.precondition.status).toBe("not_established");
      expect(verdict.coldStart.status).toBe("not_run");
      expect(allReasons(verdict)).toMatch(reason);
      expect(PROOF_EXIT.not_run).not.toBe(0);
      expect(evidence.consumers.moduleSync.cold.child).not.toBeNull();
    });

    test.each([
      {
        name: "a refused switch",
        options: { refuseSwitch: true },
        precondition: "not_established",
        outcome: "unanswered",
        reason: /switched answer was exit 1/,
      },
      {
        name: "a first question stopped at the limit once",
        options: { spawn: stopping((asked) => asked === 1) },
        precondition: "established",
        outcome: "unanswered_timeout",
        reason: /first switched question gave unanswered_timeout/,
      },
      {
        name: "every switched question stopped at the limit",
        options: { spawn: stopping(() => true) },
        precondition: "not_established",
        outcome: "unanswered_timeout",
        reason: /switched answer was ETIMEDOUT/,
      },
    ])("$name fails the cold question it observed", async ({ options, ...expected }) => {
      const evidence = await observe(options);
      const verdict = classifyCachedVersionProof(evidence);
      expect(verdict.status).toBe("failed");
      expect(PROOF_EXIT[verdict.status]).toBe(1);
      expect(verdict.precondition.status).toBe(expected.precondition);
      // Without the contrast the cache answer is not run; the cold verdict stays.
      expect(verdict.cacheAnswer.status).toBe(
        expected.precondition === "established" ? "passed" : "not_run",
      );
      expect(verdict.coldStart).toMatchObject({ status: "failed", outcome: expected.outcome });
      expect(allReasons(verdict)).toMatch(expected.reason);
      expect(proofSummary(evidence, verdict)).toContain(`(${expected.outcome})`);
      const { census } = evidence.unwarmed;
      if (expected.outcome === "unanswered_timeout") {
        // The census keeps its complete listing beside the matching lines.
        expect(readFileSync(join(evidence.evidenceDir, census.output.stdout.file), "utf8")).toBe(
          listing,
        );
        expect(census.lines).toEqual([]);
      } else expect(census).toBeUndefined();
    });

    test("a package extracted before the first question is warm even when a listing misses it", async () => {
      const evidence = await observe({
        prepare: (dir) => {
          // More earlier names than a listing keeps, then the installed package.
          for (let i = 0; i < 64; i++) mkdirSync(join(dir, `0.0.${i}`), { recursive: true });
          mkdirSync(join(dir, "1.0.110"));
          writeFileSync(join(dir, "1.0.110", "index.js"), "");
          writeFileSync(join(dir, "1.0.110", ".extraction-complete"), "");
        },
      });
      const verdict = classifyCachedVersionProof(evidence);
      const listed = evidence.cache.find(
        (point) => point.label === "after the installed copy's unswitched answer",
      ).entries;
      expect(listed[evidence.unwarmed.bundledDir]).toBeUndefined();
      expect(evidence.unwarmed.marker.state).toBe("present");
      expect(verdict.precondition.status).toBe("established");
      expect(verdict.coldStart).toMatchObject({ status: "not_run", outcome: "answered_installed" });
      expect(allReasons(verdict)).toMatch(/existed before the first switched question/);
      expect(verdict.status).toBe("not_run");
    });

    const timedOut = (read) => {
      read.selection.version = null;
      read.child.error = { code: "ETIMEDOUT", message: "spawnSync ETIMEDOUT" };
    };
    test.each([
      {
        name: "a consumer that reports the cached release",
        status: "failed",
        part: ["cacheAnswer", "failed"],
        mutate: (e) => (e.consumers.moduleAsync.selection.version = "1.0.112"),
        reason: /async reader reported the cached 1\.0\.112/,
      },
      {
        name: "a CLI inspect that reports the cached release",
        status: "failed",
        part: ["cacheAnswer", "failed"],
        mutate: (e) => (e.consumers.cliInspect.selection.version = "1.0.112"),
        reason: /CLI harness inspect reported the cached 1\.0\.112/,
      },
      {
        name: "an unanswered re-read",
        status: "failed",
        part: ["cacheAnswer", "failed"],
        mutate: (e) => (e.consumers.moduleSync.reread.selection.version = null),
        reason: /re-read reported no version/,
      },
      {
        name: "a stopped cold question despite an answered re-read",
        status: "failed",
        part: ["coldStart", "failed"],
        mutate: (e) => timedOut(e.consumers.moduleSync.cold),
        reason: /first switched question gave unanswered_timeout/,
      },
      {
        name: "a stopped cold question without an unswitched version",
        status: "failed",
        part: ["coldStart", "failed"],
        mutate: (e) => {
          e.precondition.unswitched.version = null;
          timedOut(e.consumers.moduleSync.cold);
        },
        reason: /gave unanswered_timeout/,
      },
      {
        name: "a cold question answered by the cached release",
        status: "failed",
        part: ["coldStart", "failed"],
        mutate: (e) => (e.consumers.moduleSync.cold.selection.version = "1.0.112"),
        reason: /first switched question gave 1\.0\.112/,
      },
      {
        name: "an installed package extracted before the first question",
        status: "not_run",
        part: ["coldStart", "not_run"],
        mutate: (e) => (e.unwarmed.marker.state = "present"),
        reason: /existed before the first switched question/,
      },
      {
        name: "an extraction marker that could not be read",
        status: "not_run",
        part: ["coldStart", "not_run"],
        mutate: (e) => Object.assign(e.unwarmed.marker, { state: "unknown", code: "EACCES" }),
        reason: /could not be read before the first switched question \(EACCES\)/,
      },
      {
        name: "a question without the switch",
        status: "failed",
        part: ["cacheAnswer", "failed"],
        mutate: (e) => e.consumers.moduleSync.reread.child.argv.splice(-2, 1),
        reason: /declared switch and --version/,
      },
      {
        name: "run flags without the switch",
        status: "failed",
        part: ["cacheAnswer", "failed"],
        mutate: (e) => (e.declared.runFlagsCarrySwitch = false),
        reason: /run flags lack/,
      },
      {
        name: "another native selection",
        status: "failed",
        part: ["cacheAnswer", "failed"],
        mutate: (e) => (e.consumers.nativeRunSelection = { error: "differs" }),
        reason: /native run selection/,
      },
      {
        name: "a control without the contrast",
        status: "not_run",
        part: ["precondition", "not_established"],
        mutate: (e) => (e.consumers.moduleSync.control.selection.version = "1.0.110"),
        reason: /without the declared switch answered 1\.0\.110/,
      },
      {
        name: "another selected program",
        status: "not_run",
        part: ["precondition", "not_established"],
        mutate: (e) => (e.selection.installedCopy = false),
        reason: /not the npm copy/,
      },
      {
        name: "an incomplete setup",
        status: "not_run",
        part: ["precondition", "not_established"],
        mutate: (e) => (e.setupError = "npm install failed (exit 1)"),
        reason: /setup did not complete/,
      },
      {
        name: "an interrupted observation",
        status: "not_run",
        part: ["precondition", "not_established"],
        mutate: (e) => (e.observationError = "boom"),
        reason: /observation did not complete/,
      },
    ])("$name is $status", ({ status, part: [part, partStatus], mutate, reason }) => {
      const evidence = structuredClone(passing);
      mutate(evidence);
      const verdict = classifyCachedVersionProof(evidence);
      expect(verdict.status).toBe(status);
      expect(verdict[part].status).toBe(partStatus);
      expect(allReasons(verdict)).toMatch(reason);
      expect(PROOF_EXIT[status] === 0).toBe(status === "passed");
      expect(proofSummary(evidence, verdict)).toContain(status.toUpperCase());
    });
  },
);

test.skipIf(process.platform === "win32")(
  "a direct look is absent only for a missing path; an unreadable parent stays unknown",
  () => {
    const root = scratch("copilot-path-state-");
    const locked = join(root, "locked");
    writeFileSync(join(root, "file"), "");
    mkdirSync(locked);
    writeFileSync(join(locked, "marker"), "");
    expect(pathState(join(root, "file")).state).toBe("present");
    expect(pathState(join(root, "missing", "marker"))).toMatchObject({ state: "absent" });
    expect(pathState(join(root, "file", "marker"))).toMatchObject({ state: "absent" });
    chmodSync(locked, 0o600);
    try {
      // The superuser looks through any mode; everyone else cannot search the folder.
      expect(pathState(join(locked, "marker"))).toMatchObject(
        process.getuid?.() === 0 ? { state: "present" } : { state: "unknown", code: "EACCES" },
      );
    } finally {
      chmodSync(locked, 0o755);
    }
  },
);

test("chooses the newest stable release and the one before it", () => {
  const published = ["1.0.9", "1.0.10", "1.0.11-0", "1.0.11", "1.0.12", "1.0.13-1.unstable"];
  expect(chooseVersions(published)).toEqual({ installed: "1.0.11", cached: "1.0.12" });
  expect(chooseVersions(["1.0.12", "1.0.13-0"])).toBeNull();
});

test("removes credentials, Copilot variables and overrides; Windows keeps its real profile", () => {
  const source = {
    PATH: "/bin",
    GH_TOKEN: "t",
    NPM_CONFIG_PASSWORD: "p",
    COPILOT_HOME: "/c",
    copilot_cache_home: "/d",
    XDG_CACHE_HOME: "/x",
    CLAUDEXOR_COPILOT_BIN: "/o",
    LOCALAPPDATA: "C:\\L",
  };
  const options = { configDir: "/cfg", overrideKeys: ["CLAUDEXOR_COPILOT_BIN"] };
  expect(proofEnvironment(source, { ...options, home: "/h", platform: "linux" })).toEqual({
    PATH: "/bin",
    LOCALAPPDATA: "C:\\L",
    HOME: "/h",
    CLAUDEXOR_CONFIG_DIR: "/cfg",
    CI: "true",
    XDG_CONFIG_HOME: join("/h", ".config"),
    XDG_DATA_HOME: join("/h", ".local", "share"),
    XDG_CACHE_HOME: join("/h", ".cache"),
    XDG_STATE_HOME: join("/h", ".local", "state"),
  });
  expect(proofEnvironment(source, { ...options, home: "C:\\U", platform: "win32" })).toEqual({
    PATH: "/bin",
    LOCALAPPDATA: "C:\\L",
    HOME: "C:\\U",
    CLAUDEXOR_CONFIG_DIR: "/cfg",
    CI: "true",
  });
});

test.each([
  ["linux", { HOME: "/h" }, ["/h/.cache/copilot/pkg", "/h/.copilot/pkg"]],
  [
    "darwin",
    { HOME: "/h", XDG_CACHE_HOME: "/x" },
    ["/h/Library/Caches/copilot/pkg", "/x/copilot/pkg", "/h/.copilot/pkg"],
  ],
  [
    "win32",
    { userprofile: "/u", LocalAppData: "/l" },
    ["/l/copilot/pkg", "/u/.cache/copilot/pkg", "/u/.copilot/pkg"],
  ],
  [
    "linux",
    { HOME: "/h", COPILOT_CACHE_HOME: "/c", COPILOT_HOME: "/k" },
    ["/c/pkg", "/h/.cache/copilot/pkg", "/k/pkg", "/h/.copilot/pkg"],
  ],
])("lists the %s package-cache roots in the launcher's order", (platform, env, expected) => {
  expect(copilotCacheRoots(env, platform).map((path) => path.replaceAll("\\", "/"))).toEqual(
    expected,
  );
});

test.skipIf(process.platform === "win32")(
  "reads CLI inspect only from a successful JSON answer and keeps its output",
  () => {
    const root = scratch("copilot-cli-stub-");
    const cli = (name, body) => {
      const evidenceDir = join(root, `evidence-${name}`);
      mkdirSync(evidenceDir);
      writeFileSync(join(root, name), body);
      const env = { PATH: "/usr/bin:/bin" };
      return {
        evidenceDir,
        ...inspectThroughCli({ cliPath: join(root, name), env, cwd: root, evidenceDir }),
      };
    };
    const row = { harnesses: [{ selection: { path: "/p/copilot", version: "1.0.110" } }] };
    const ok = cli("ok.mjs", `process.stdout.write(${JSON.stringify(JSON.stringify(row))});`);
    expect(ok.selection).toEqual(row.harnesses[0].selection);
    expect(ok.record.argv.slice(-4)).toEqual(["harness", "inspect", "copilot", "--json"]);
    expect(readFileSync(join(ok.evidenceDir, ok.record.stdout.file), "utf8")).toBe(
      JSON.stringify(row),
    );
    const refused = cli(
      "no.mjs",
      `process.stdout.write(${JSON.stringify(JSON.stringify(row))}); process.exit(1);`,
    );
    expect([refused.selection, refused.record.exit]).toEqual([null, 1]);
    expect(cli("bad.mjs", "process.stdout.write('not json')").selection).toBeNull();
  },
);

test.each([
  ["linux", "ps"],
  ["win32", "powershell.exe"],
])("a %s census keeps only processes below the installed package", (platform, binary) => {
  const spawn = vi.fn(() => ({
    status: 0,
    stdout: "1 0 /PKG/copilot --version\n2 0 /other/node\n",
  }));
  const census = processCensus("/pkg", { platform, spawn });
  expect(spawn.mock.calls[0][0]).toBe(binary);
  expect(census.lines).toEqual(["1 0 /PKG/copilot --version"]);
});

test("escapes workflow annotation titles and messages", () => {
  expect(annotation("error", "a: b, c", "50%\nnext")).toBe(
    "::error title=a%3A b%2C c::50%25%0Anext",
  );
});
