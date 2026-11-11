#!/usr/bin/env node
/**
 * Real-harness synthetic battery for Claudexor.
 *
 * This is intentionally NOT a unit test. It runs real codex/claude/cursor
 * harnesses against disposable git repositories and asserts engine-owned
 * artifacts (decision/work_product/telemetry/review files), so it covers the
 * quality surfaces the deterministic fake smoke cannot.
 *
 * Safety:
 * - never targets the Claudexor repo as a mutation target;
 * - defaults to a temp CLAUDEXOR_CONFIG_DIR for daemon/settings state;
 * - may use the exact default config only through an explicit, guarded VM lane;
 * - keeps HOME native so real harness sessions/Keychain remain available;
 * - never prints secret values.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import zlib from "node:zlib";
import {
  assertExistingDefaultSecondStartupStable,
  assertNoPreexistingDaemon,
  automaticBatteryHarnesses,
  batteryReviewerPanelEntry,
  canonicalBatteryProfileState,
  describeFileSnapshot,
  durableAttemptRouteEvidence,
  evaluateReadonlyCapabilityAnswer,
  evaluateRequiredNativeRoutes,
  isBatteryRepoRoot,
  isCrossFamilyConvergenceRefusal,
  nativeBatteryRowReady,
  projectBatteryHarnessReadiness,
  projectBatteryDaemonLease,
  readonlyCapabilityFixture,
  readonlyCapabilityPrompt,
  readonlyCapabilityRequest,
  readonlyCapabilityRows,
  relevantRunAttemptKeys,
  resolveRealHarnessBatteryLayout,
  runtimeReplacementIdentityFromHandshake,
  sameDaemonLease,
  selectBatteryProfile,
  selectRealHarnessBatteryModel,
  snapshotRegularFile,
  validateExistingDefaultStartupTransition,
  validateBatteryRunArtifacts,
  validateBatteryTaskIdentity,
  withBatteryReviewerModels,
  withExplicitBatteryModels,
} from "./lib/real-harness-battery-state.mjs";
import {
  browserProbeInstruction,
  evaluateBrowserPageEvidence,
  readRunJournal,
  startBrowserProbePage,
} from "./lib/real-harness-browser-probe.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "cli", "dist", "cli.js");
const nodeBin = process.execPath;
const home = homedir();
delete process.env.CLAUDEXOR_BATTERY_BUILD_VERIFIED;
const forcedBuildStartedAt = new Date().toISOString();
const forcedBuildCommand = [join(root, "node_modules", ".bin", "turbo"), "run", "build", "--force"];
const forcedBuildResult = spawnSync(forcedBuildCommand[0], forcedBuildCommand.slice(1), {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
const forcedBuildReceipt = {
  command: "turbo run build --force",
  startedAt: forcedBuildStartedAt,
  finishedAt: new Date().toISOString(),
  exitCode: typeof forcedBuildResult.status === "number" ? forcedBuildResult.status : 1,
  candidateSha: null,
  candidateTree: null,
};
if (forcedBuildReceipt.exitCode !== 0) {
  throw new Error(
    `forced workspace build failed before the real-harness battery started (exit ${forcedBuildReceipt.exitCode}${forcedBuildResult.error ? `; ${forcedBuildResult.error.message}` : ""})`,
  );
}

// Import every compiled workspace dependency only AFTER the entrypoint-owned,
// uncached build completed. A stale dist module can therefore never enter this
// process before the build proof it is supposed to exercise.
const [artifactStoreModule, daemonModule, schemaModule, utilModule, runtimeStopModule] =
  await Promise.all([
    import("../packages/artifact-store/dist/index.js"),
    import("../packages/daemon/dist/index.js"),
    import("../packages/schema/dist/index.js"),
    import("../packages/util/dist/index.js"),
    import("../packages/cli/dist/runtime-replacement-stop.js"),
  ]);
const { ArtifactStore } = artifactStoreModule;
const {
  awaitDaemonTermination,
  DaemonClient,
  defaultSocketPath,
  inspectDaemonWriterLease,
  readToken,
  socketAlive,
} = daemonModule;
const {
  AccountsUnifiedMigrationFile,
  ControlRunDetail,
  FrozenTaskContractArtifact,
  GlobalConfig,
  HarnessEvent,
  RunDeliveryState,
  RunEvent,
  RunTelemetry,
  DELIBERATE_NO_OUTER_BOUNDARY_REASON,
} = schemaModule;
const { CLAUDEXOR_VERSION, redactSecrets } = utilModule;
const { admitAndAwaitRuntimeReplacementStop } = runtimeStopModule;

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const defaultRoot = join(home, ".claudexor", "dogfood", `battery-${runId}`);
const layout = resolveRealHarnessBatteryLayout({
  home,
  sourceRoot: root,
  defaultBatteryRoot: defaultRoot,
  batteryDir: process.env.CLAUDEXOR_BATTERY_DIR,
  requestedConfigDir: process.env.CLAUDEXOR_BATTERY_CONFIG_DIR,
  ambientConfigDir: process.env.CLAUDEXOR_CONFIG_DIR,
});
const { batteryRoot, configDir } = layout;
const resultsDir = join(batteryRoot, "results");
const reposDir = join(batteryRoot, "repos");
const logsDir = join(batteryRoot, "logs");
const maxUsd = process.env.CLAUDEXOR_BATTERY_MAX_USD ?? "1.50";
const requiredCodexProfileId = "mironov_codex2";
const timeoutMs = Number(process.env.CLAUDEXOR_BATTERY_TIMEOUT_MS ?? 20 * 60_000);
const requestedHarnesses = (process.env.CLAUDEXOR_BATTERY_HARNESSES ?? "codex,claude,cursor,agy")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const marker = process.env.CLAUDEXOR_BATTERY_IMAGE_MARKER ?? "CLAUDEXOR-7521";
// Optional phase filter (e.g. "10,11,12"): an operator iterating on one
// surface should not re-burn the whole battery. Default: every phase.
const phaseFilter = (process.env.CLAUDEXOR_BATTERY_PHASES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => `phase${s.replace(/^phase/, "")}`);
const phaseEnabled = (id) => phaseFilter.length === 0 || phaseFilter.includes(id);

if (layout.mode === "scratch") mkdirSync(configDir, { recursive: true, mode: 0o700 });
mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
mkdirSync(reposDir, { recursive: true, mode: 0o700 });
mkdirSync(logsDir, { recursive: true, mode: 0o700 });

const protectedConfigPath = join(configDir, "config.yaml");
const protectedMigrationPath = join(configDir, "migration", "accounts-unified.json");
const protectedConfigBefore =
  layout.mode === "existing_default" ? snapshotRegularFile(protectedConfigPath) : null;
const protectedMigrationBefore =
  layout.mode === "existing_default" ? snapshotRegularFile(protectedMigrationPath) : null;
const protectedStateReader = new ArtifactStore(root);
const protectedConfigBeforeValue =
  layout.mode === "existing_default" ? protectedStateReader.readYaml(protectedConfigPath) : null;

const env = {
  ...process.env,
  PATH: [
    join(home, ".claudexor", "node", "bin"),
    join(home, ".local", "bin"),
    process.env.PATH ?? "",
  ]
    .filter(Boolean)
    .join(":"),
  CLAUDEXOR_DAEMON_ENTRY: join(root, "packages", "cli", "dist", "claudexord.js"),
  CLAUDEXOR_DOCTOR_TTL_MS: "0",
};
if (layout.exportConfigDir) env.CLAUDEXOR_CONFIG_DIR = configDir;
else delete env.CLAUDEXOR_CONFIG_DIR;
if (existsSync(join(home, ".local", "bin", "cursor-agent"))) {
  env.CLAUDEXOR_CURSOR_BIN = join(home, ".local", "bin", "cursor-agent");
}
if (existsSync(join(home, ".claudexor", "node", "bin", "codex"))) {
  env.CLAUDEXOR_CODEX_BIN = join(home, ".claudexor", "node", "bin", "codex");
}
if (existsSync(join(home, ".claudexor", "node", "bin", "claude"))) {
  env.CLAUDEXOR_CLAUDE_BIN = join(home, ".claudexor", "node", "bin", "claude");
}
// The in-process Control API phase must resolve the same isolated daemon and
// harness binaries as child CLI invocations.
if (!layout.exportConfigDir) delete process.env.CLAUDEXOR_CONFIG_DIR;
Object.assign(process.env, env);

const results = [];
const evidence = {
  batteryRoot,
  configDir,
  configMode: layout.mode,
  configBefore: protectedConfigBefore ? describeFileSnapshot(protectedConfigBefore) : null,
  migrationBefore: protectedMigrationBefore ? describeFileSnapshot(protectedMigrationBefore) : null,
  configAfter: null,
  migrationAfter: null,
  configUnchanged: layout.mode === "scratch" ? null : false,
  startupState: {
    valid: layout.mode === "scratch" ? null : false,
    classification: null,
    validatedRows: [],
    first: null,
    second: null,
  },
  forcedBuildVerified: true,
  forcedBuild: forcedBuildReceipt,
  cli,
  node: nodeBin,
  version: null,
  candidate: { sha: null, tree: null },
  daemon: { start: null, starts: [], handshake: null, entrySha256: null, stop: null, stops: [] },
  requestedHarnesses,
  automaticRouteHarnesses: [],
  requiredRouteHarnesses: [],
  harnessReadiness: {},
  harnessReports: {},
};
const runtimeState = {
  daemonOwned: false,
  daemonClient: null,
  daemonIdentity: null,
  daemonLease: null,
  baselineJobIds: new Set(),
};

function rel(path) {
  return path.startsWith(root) ? path.slice(root.length + 1) : path;
}

function logPath(name) {
  return join(logsDir, `${name.replace(/[^a-z0-9_.-]+/gi, "_")}.log`);
}

function record(status, phase, name, detail = {}, extras = {}) {
  const item = { status, phase, name, detail: redactDetail(detail), ...redactDetail(extras) };
  results.push(item);
  const tag =
    status === "pass"
      ? "PASS"
      : status === "skip"
        ? "SKIP"
        : status === "env"
          ? "ENV"
          : status === "conditional"
            ? "OMIT"
            : "FAIL";
  const summary = typeof item.detail === "string" ? item.detail : JSON.stringify(item.detail);
  process.stdout.write(
    `${tag.padEnd(5)} ${phase.padEnd(10)} ${name.padEnd(44)} ${summary.slice(0, 180)}\n`,
  );
  return item;
}

function pass(phase, name, detail = {}, extras = {}) {
  return record("pass", phase, name, detail, extras);
}
function fail(phase, name, detail = {}, extras = {}) {
  return record("fail", phase, name, detail, extras);
}
function skip(phase, name, detail = {}, extras = {}) {
  return record("skip", phase, name, detail, extras);
}
function envfail(phase, name, detail = {}, extras = {}) {
  return record("env", phase, name, detail, extras);
}
function conditional(phase, name, detail = {}, extras = {}) {
  return record("conditional", phase, name, detail, extras);
}

function isTransientEnvOutput(out) {
  const text = [out.stdout, out.stderr, out.error, JSON.stringify(out.json ?? {})]
    .join("\n")
    .toLowerCase();
  return (
    text.includes("stream disconnected") ||
    text.includes("failed to lookup address information") ||
    text.includes("nodename nor servname") ||
    text.includes("enotfound") ||
    text.includes("eai_again") ||
    text.includes("econnreset") ||
    text.includes("etimedout")
  );
}

function redactDetail(value) {
  if (typeof value === "string") return redactSecrets(value);
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value)));
  } catch {
    return redactSecrets(String(value));
  }
}

function run(cmd, args, opts = {}) {
  const cwd = opts.cwd ?? root;
  const res = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: opts.timeoutMs ?? timeoutMs,
  });
  return {
    code: typeof res.status === "number" ? res.status : 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error ? String(res.error) : "",
  };
}

function runGit(args, cwd) {
  const res = run("git", args, { cwd, timeoutMs: 120_000 });
  if (res.code !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

function runCli(args, opts = {}) {
  const routedArgs = withExplicitBatteryModels(args, selectBatteryModel);
  const name = opts.name ?? routedArgs.join(" ");
  const cwd = opts.cwd ?? root;
  let out = run(nodeBin, [cli, ...routedArgs], { cwd, timeoutMs: opts.timeoutMs ?? timeoutMs });
  let retriedForEnv = false;
  if (out.code !== 0 && isTransientEnvOutput({ ...out, json: null }) && opts.envRetry !== false) {
    retriedForEnv = true;
    out = run(nodeBin, [cli, ...routedArgs], { cwd, timeoutMs: opts.timeoutMs ?? timeoutMs });
  }
  const lp = logPath(name);
  writeFileSync(
    lp,
    [
      `$ claudexor ${routedArgs.join(" ")}`,
      `cwd=${cwd}`,
      `exit=${out.code}`,
      "",
      redactSecrets(out.stdout),
      redactSecrets(out.stderr),
      redactSecrets(out.error),
    ].join("\n"),
  );
  let json = null;
  if (opts.json !== false && out.stdout.trim().startsWith("{")) {
    try {
      json = JSON.parse(out.stdout);
    } catch {
      /* recorded by caller if needed */
    }
  }
  return {
    ...out,
    json,
    log: lp,
    cwd,
    retriedForEnv,
    envFailure: out.code !== 0 && isTransientEnvOutput({ ...out, json }),
  };
}

function runCliJson(args, opts = {}) {
  return runCli([...args, "--json"], { ...opts, json: true });
}

function runCliText(args, opts = {}) {
  return runCli(args, { ...opts, json: false });
}

async function startBatteryDaemon(startup = "primary") {
  const socketPath = defaultSocketPath();
  const expectedEntry = join(root, "packages", "cli", "dist", "claudexord.js");
  evidence.daemon.entrySha256 = createHash("sha256")
    .update(readFileSync(expectedEntry))
    .digest("hex");
  const preflight = runCliJson(["daemon", "status"], {
    name: "daemon-preflight",
    envRetry: false,
  });
  const preflightLease = projectBatteryDaemonLease(inspectDaemonWriterLease(socketPath));
  const preflightSocketAlive = await socketAlive(socketPath);
  assertNoPreexistingDaemon({
    statusCode: preflight.code,
    socketIsAlive: preflightSocketAlive,
    lease: preflightLease,
  });

  const started = runCliJson(["daemon", "start"], {
    name: "daemon-start",
    envRetry: false,
  });
  const startedPid = started.json?.pid;
  const lease = projectBatteryDaemonLease(inspectDaemonWriterLease(socketPath));
  const capableOwner = lease.capableOwner;
  if (Number.isSafeInteger(startedPid) && startedPid > 0 && capableOwner?.pid === startedPid) {
    const token = readToken();
    if (token) {
      // Capture cleanup authority as soon as the detached child proves writer
      // ownership. A later readiness/handshake failure must not leak it.
      runtimeState.daemonOwned = true;
      runtimeState.daemonLease = capableOwner;
      runtimeState.daemonClient = new DaemonClient(socketPath, token);
      const startEvidence = {
        startup,
        pid: startedPid,
        ready: started.json?.ready === true,
        alreadyRunning: started.json?.alreadyRunning === true,
        processIdentity: capableOwner.identity?.status ?? null,
      };
      evidence.daemon.starts.push(startEvidence);
      if (startup === "primary") evidence.daemon.start = startEvidence;
    }
  }
  if (
    started.code !== 0 ||
    started.json?.ready !== true ||
    started.json?.alreadyRunning === true ||
    !Number.isSafeInteger(startedPid) ||
    startedPid <= 0
  ) {
    throw new Error(`battery could not prove a fresh daemon start; inspect ${started.log}`);
  }
  if (!runtimeState.daemonOwned || !capableOwner || capableOwner.pid !== startedPid) {
    throw new Error("fresh daemon pid does not own the writer lease; refusing cleanup authority");
  }

  const [{ ensureDaemon }, { controlApiFetch, CONTROL_PROTOCOL_MAJOR }] = await Promise.all([
    import("../packages/cli/dist/daemon-run.js"),
    import("../packages/cli/dist/live.js"),
  ]);
  const { addr } = await ensureDaemon();
  const response = await controlApiFetch(addr, "/v2/handshake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocolMajor: CONTROL_PROTOCOL_MAJOR, client: "battery" }),
  });
  if (!response.ok) throw new Error(`battery daemon handshake failed (HTTP ${response.status})`);
  const handshake = await response.json();
  // C7e: the battery drives real product routes — a recovery-only daemon
  // (absent servingMode = a pre-#165 daemon serving normally) is a hard stop.
  const servingMode = handshake?.servingMode ?? "normal";
  if (servingMode !== "normal") {
    throw new Error(
      `battery daemon is serving ${servingMode}; refusing to run the battery against a recovery plane`,
    );
  }
  // Capture the identity before candidate validation. A mismatching but valid
  // fresh daemon must still be stopped through the identity-bound RPC.
  runtimeState.daemonIdentity = runtimeReplacementIdentityFromHandshake(handshake);
  if (
    handshake?.engine?.version !== CLAUDEXOR_VERSION ||
    handshake?.engine?.sha !== evidence.candidate.sha ||
    resolve(handshake?.engine?.entry ?? "") !== expectedEntry
  ) {
    throw new Error("battery daemon handshake does not match the exact source candidate");
  }
  const handshakeEvidence = {
    startup,
    version: handshake.engine.version,
    sha: handshake.engine.sha,
    entry: handshake.engine.entry,
    entrySha256: evidence.daemon.entrySha256,
  };
  if (startup === "primary") evidence.daemon.handshake = handshakeEvidence;
  runtimeState.baselineJobIds = new Set((await allDaemonJobs()).map((job) => job.id));
  pass(
    startup === "primary" ? "phase0" : "state",
    startup === "primary"
      ? "fresh exact-candidate daemon"
      : "second exact-candidate daemon startup",
    handshakeEvidence,
  );
}

async function stopBatteryDaemon(startup = "primary") {
  if (!runtimeState.daemonOwned) return;
  const socketPath = defaultSocketPath();
  const expectedOwner = runtimeState.daemonLease;
  const client = runtimeState.daemonClient;
  const currentOwner = projectBatteryDaemonLease(inspectDaemonWriterLease(socketPath)).capableOwner;
  if (!client || !sameDaemonLease(expectedOwner, currentOwner)) {
    const stopEvidence = {
      startup,
      stopped: false,
      reason: "captured daemon owner is no longer current; successor left untouched",
    };
    evidence.daemon.stops.push(stopEvidence);
    evidence.daemon.stop = stopEvidence;
    fail("cleanup", "battery-owned daemon stopped", stopEvidence);
    return;
  }
  try {
    const target = {
      version: runtimeState.daemonIdentity?.version ?? CLAUDEXOR_VERSION,
      buildSha: runtimeState.daemonIdentity?.buildSha ?? evidence.candidate.sha,
      leaseOwner: { pid: expectedOwner.pid, token: expectedOwner.token },
    };
    const termination = await admitAndAwaitRuntimeReplacementStop(
      () => client.shutdownForRuntimeReplacement(target),
      (options) => awaitDaemonTermination(socketPath, options),
      expectedOwner,
    );
    const leaseReleased = projectBatteryDaemonLease(
      inspectDaemonWriterLease(socketPath),
    ).physicallyAbsent;
    const valid = termination.outcome !== "still_alive" && leaseReleased;
    const stopEvidence = {
      startup,
      stopped: valid,
      outcome: termination.outcome,
      detail: termination.detail,
      leaseReleased,
    };
    evidence.daemon.stops.push(stopEvidence);
    evidence.daemon.stop = stopEvidence;
    (valid ? pass : fail)("cleanup", "battery-owned daemon stopped", stopEvidence);
    if (valid) {
      runtimeState.daemonOwned = false;
      runtimeState.daemonClient = null;
      runtimeState.daemonIdentity = null;
      runtimeState.daemonLease = null;
    }
  } catch (error) {
    const stopEvidence = {
      startup,
      stopped: false,
      reason: error instanceof Error ? error.message : String(error),
    };
    evidence.daemon.stops.push(stopEvidence);
    evidence.daemon.stop = stopEvidence;
    fail("cleanup", "battery-owned daemon stopped", stopEvidence);
  }
}

function migrationBackupSnapshots(snapshot) {
  if (!snapshot?.exists || !snapshot.bytes) return {};
  let migration;
  try {
    migration = JSON.parse(snapshot.bytes.toString("utf8"));
  } catch {
    return {};
  }
  const migrationRoot = resolve(configDir, "migration");
  const snapshots = {};
  for (const record of Object.values(migration ?? {})) {
    const backupRef = record?.backup_ref;
    if (typeof backupRef !== "string" || !isAbsolute(backupRef)) continue;
    const absolute = resolve(backupRef);
    const relToMigration = relative(migrationRoot, absolute);
    if (relToMigration.startsWith("..") || isAbsolute(relToMigration)) continue;
    try {
      const configPath = join(absolute, "config.yaml");
      snapshots[backupRef] = {
        ...snapshotRegularFile(configPath),
        value: protectedStateReader.readYaml(configPath),
      };
    } catch {
      // The pure validator turns an unsafe/missing backup into the one typed
      // state-contract failure; do not read outside the migration namespace.
    }
  }
  return snapshots;
}

async function verifyProtectedStartupState() {
  if (!protectedConfigBefore || !protectedMigrationBefore) return;
  const firstConfig = snapshotRegularFile(protectedConfigPath);
  const firstMigration = snapshotRegularFile(protectedMigrationPath);
  evidence.startupState.first = {
    config: describeFileSnapshot(firstConfig),
    migration: describeFileSnapshot(firstMigration),
  };
  let transition;
  try {
    transition = validateExistingDefaultStartupTransition({
      configBefore: protectedConfigBefore,
      migrationBefore: protectedMigrationBefore,
      configAfter: firstConfig,
      migrationAfter: firstMigration,
      configBeforeValue: protectedConfigBeforeValue,
      configAfterValue: protectedStateReader.readYaml(protectedConfigPath),
      backupSnapshots: migrationBackupSnapshots(firstMigration),
      globalConfigSchema: GlobalConfig,
      migrationSchema: AccountsUnifiedMigrationFile,
    });
    evidence.startupState.classification = transition.classification;
    evidence.startupState.validatedRows = transition.validatedRows;
    pass("state", "first startup state transition", {
      classification: transition.classification,
      validatedRows: transition.validatedRows,
      ...evidence.startupState.first,
    });
  } catch (error) {
    evidence.configAfter = describeFileSnapshot(firstConfig);
    evidence.migrationAfter = describeFileSnapshot(firstMigration);
    evidence.configUnchanged = false;
    evidence.startupState.valid = false;
    fail("state", "first startup state transition", {
      error: error instanceof Error ? error.message : String(error),
      before: {
        config: evidence.configBefore,
        migration: evidence.migrationBefore,
      },
      after: evidence.startupState.first,
    });
    return;
  }

  try {
    await startBatteryDaemon("idempotency-restart");
  } catch (error) {
    fail("state", "second startup completed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (runtimeState.daemonOwned) await stopBatteryDaemon("idempotency-restart");
  }

  try {
    const secondConfig = snapshotRegularFile(protectedConfigPath);
    const secondMigration = snapshotRegularFile(protectedMigrationPath);
    evidence.startupState.second = assertExistingDefaultSecondStartupStable({
      configAfterFirst: firstConfig,
      migrationAfterFirst: firstMigration,
      configAfterSecond: secondConfig,
      migrationAfterSecond: secondMigration,
    });
    evidence.configAfter = describeFileSnapshot(secondConfig);
    evidence.migrationAfter = describeFileSnapshot(secondMigration);
    evidence.configUnchanged =
      protectedConfigBefore.exists === secondConfig.exists &&
      protectedConfigBefore.mode === secondConfig.mode &&
      (protectedConfigBefore.bytes === null
        ? secondConfig.bytes === null
        : protectedConfigBefore.bytes.equals(secondConfig.bytes));
    evidence.startupState.valid = true;
    pass("state", "second startup left migration state byte-identical", {
      classification: transition.classification,
      ...evidence.startupState.second,
    });
  } catch (error) {
    evidence.configAfter = (() => {
      try {
        return describeFileSnapshot(snapshotRegularFile(protectedConfigPath));
      } catch {
        return null;
      }
    })();
    evidence.migrationAfter = (() => {
      try {
        return describeFileSnapshot(snapshotRegularFile(protectedMigrationPath));
      } catch {
        return null;
      }
    })();
    evidence.configUnchanged = false;
    evidence.startupState.valid = false;
    fail("state", "second startup left migration state byte-identical", {
      error: error instanceof Error ? error.message : String(error),
      first: evidence.startupState.first,
      second: {
        config: evidence.configAfter,
        migration: evidence.migrationAfter,
      },
    });
  }
}

function inspectRun(runId, cwd) {
  const out = runCliJson(["inspect", runId], { cwd, name: `inspect ${runId}` });
  return out.json;
}

/** Every retained command, read in addressed keyset pages (INV-142: the daemon
 * refuses an un-addressed list). Pages hold compact summaries: id, runId, taskId,
 * runDir and state are all this battery reads from a collection. */
async function allDaemonJobs() {
  const jobs = [];
  let cursor = null;
  for (;;) {
    const page = await runtimeState.daemonClient.list({
      page: { limit: 1000, state: null, cursor },
    });
    jobs.push(...page.slice(0, 1000));
    if (page.length <= 1000) return jobs;
    const last = page[999];
    cursor = { createdAt: String(last.createdAt ?? ""), id: last.id };
  }
}

async function verifyNativeSessionRoutes() {
  if (layout.mode !== "existing_default") return;
  const requiredHarnesses = requestedHarnesses.filter((h) => h === "codex" || h === "claude");
  const observed = [];
  let jobs;
  try {
    jobs = await allDaemonJobs();
  } catch (error) {
    fail("acceptance", "complete battery run inventory", {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const postBaselineJobs = jobs.filter((job) => !runtimeState.baselineJobIds.has(job.id));
  const batteryJobs = [];
  const concurrentJobs = [];
  const inventoryErrors = [];
  const store = new ArtifactStore(root);
  for (const job of postBaselineJobs) {
    const rawTask =
      typeof job.runDir === "string"
        ? store.readYaml(join(job.runDir, "context", "task.yaml"))
        : null;
    const taskResult = validateBatteryTaskIdentity({
      job,
      task: rawTask,
      taskSchema: FrozenTaskContractArtifact,
    });
    if (!taskResult.valid) {
      inventoryErrors.push({
        jobId: job.id,
        runId: job.runId ?? null,
        reason: taskResult.reason,
      });
      continue;
    }
    if (isBatteryRepoRoot(reposDir, taskResult.task.repo.root)) {
      batteryJobs.push({ job, task: taskResult.task });
    } else
      concurrentJobs.push({
        jobId: job.id,
        runId: job.runId ?? null,
        state: job.state ?? null,
      });
  }
  const seenRunDirs = new Set();
  for (const { job, task } of batteryJobs) {
    if (typeof job.runDir !== "string") continue;
    if (seenRunDirs.has(job.runDir)) continue;
    seenRunDirs.add(job.runDir);
    const telemetryPath = join(job.runDir, "final", "telemetry.yaml");
    let eventText;
    try {
      eventText = readFileSync(join(job.runDir, "events.jsonl"), "utf8");
    } catch {
      inventoryErrors.push({
        jobId: job.id,
        runId: job.runId ?? null,
        reason: "run_events_missing_or_malformed",
      });
      continue;
    }
    const artifactResult = validateBatteryRunArtifacts({
      job,
      task,
      eventText,
      telemetry: store.readYaml(telemetryPath),
      telemetryPresent: existsSync(telemetryPath),
      runEventSchema: RunEvent,
      harnessEventSchema: HarnessEvent,
      telemetrySchema: RunTelemetry,
    });
    if (!artifactResult.valid) {
      inventoryErrors.push({
        jobId: job.id,
        runId: job.runId ?? null,
        reason: artifactResult.reason,
      });
      continue;
    }
    const runEvents = artifactResult.events;
    const telemetryAttempts = artifactResult.telemetry?.attempts ?? [];
    const attemptKeys = relevantRunAttemptKeys(runEvents, requiredHarnesses);
    for (const attempt of telemetryAttempts) {
      if (
        requiredHarnesses.includes(attempt.harness_id) &&
        !attemptKeys.some(
          (key) => key.harnessId === attempt.harness_id && key.attemptId === attempt.attempt_id,
        )
      ) {
        attemptKeys.push({ harnessId: attempt.harness_id, attemptId: attempt.attempt_id });
      }
    }
    // Expected preflight refusals have neither a started attempt nor telemetry.
    if (attemptKeys.length === 0) continue;
    for (const key of attemptKeys) {
      const base = {
        jobId: job.id,
        runId: job.runId ?? null,
        attemptId: key.attemptId,
        harnessId: key.harnessId,
      };
      if (
        typeof key.attemptId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key.attemptId)
      ) {
        observed.push({ ...base, kind: "invalid_attempt_id", authMode: null, authSource: null });
        continue;
      }
      const matchingTelemetry = telemetryAttempts.filter(
        (attempt) => attempt.harness_id === key.harnessId && attempt.attempt_id === key.attemptId,
      );
      if (matchingTelemetry.length !== 1) {
        inventoryErrors.push({
          ...base,
          reason:
            matchingTelemetry.length === 0
              ? "attempt_telemetry_missing"
              : "attempt_telemetry_duplicate",
        });
        continue;
      }
      const attempt = matchingTelemetry[0];
      const sourceAnchor = {
        authMode: attempt.auth_mode ?? null,
        authSource: attempt.auth_source ?? null,
      };
      observed.push({ ...base, kind: "telemetry", ...sourceAnchor });
      const events = runEvents
        .filter(
          (event) =>
            event?.type === "harness.event" &&
            event.payload?.harness_id === key.harnessId &&
            event.payload?.attempt_id === key.attemptId,
        )
        .map((event) => event.payload);
      const durable = durableAttemptRouteEvidence(events, sourceAnchor);
      for (const route of durable.observed) observed.push({ ...base, ...route });
      if (!durable.sawStarted) {
        observed.push({ ...base, kind: "started_route_missing", authMode: null, authSource: null });
      }
    }
  }
  const routeResult = evaluateRequiredNativeRoutes(requiredHarnesses, observed);
  const valid = routeResult.valid && inventoryErrors.length === 0;
  (valid ? pass : fail)("acceptance", "Codex and Claude routes stayed vendor-native", {
    batteryJobs: batteryJobs.length,
    observed,
    inventoryErrors,
    missing: routeResult.missing,
    nonNative: routeResult.nonNative,
  });
  (concurrentJobs.length === 0 ? pass : fail)(
    "acceptance",
    "battery submission window stayed exclusive",
    { concurrentJobs },
  );
}

async function controlRunDetail(runId) {
  try {
    const [{ ensureDaemon }, { controlApiFetch }] = await Promise.all([
      import("../packages/cli/dist/daemon-run.js"),
      import("../packages/cli/dist/live.js"),
    ]);
    const { addr } = await ensureDaemon();
    const response = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`);
    const body = JSON.parse(await response.text());
    if (!response.ok) throw new Error(`GET /runs/${runId} failed (HTTP ${response.status})`);
    return { detail: ControlRunDetail.parse(body), error: null };
  } catch (error) {
    return {
      detail: null,
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    };
  }
}

function artifactExists(runDir, relPath) {
  return existsSync(join(runDir, relPath));
}

function councilFlags(memberCount) {
  return ["--council", ...(memberCount === undefined ? [] : ["--n", String(memberCount)])];
}

function nonEmpty(path) {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

function cleanName(name) {
  return name
    .replace(/[^a-z0-9_.-]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function initRepo(repo) {
  mkdirSync(repo, { recursive: true });
  runGit(["init", "-b", "main"], repo);
  runGit(
    [
      "-c",
      "user.email=battery@claudexor.dev",
      "-c",
      "user.name=Claudexor Battery",
      "commit",
      "--allow-empty",
      "-m",
      "init",
    ],
    repo,
  );
}

function makeMathRepo(name, opts = {}) {
  const repo = join(reposDir, cleanName(name));
  rmSync(repo, { recursive: true, force: true });
  initRepo(repo);
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  const addBug = opts.addBug !== false;
  const multiplyBug = opts.multiplyBug === true;
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify(
      {
        name: `claudexor-battery-${cleanName(name)}`,
        version: "0.0.0",
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(repo, "src", "math.js"),
    [
      `export function add(a, b) { return a ${addBug ? "-" : "+"} b; }`,
      multiplyBug
        ? `export function multiply(a, b) { throw new Error("TODO multiply"); }`
        : `export function multiply(a, b) { return a * b; }`,
      "",
    ].join("\n"),
  );
  const tests = [
    `import test from "node:test";`,
    `import assert from "node:assert/strict";`,
    `import { add, multiply } from "../src/math.js";`,
    ``,
    `test("add adds", () => { assert.equal(add(2, 3), 5); });`,
  ];
  if (opts.testMultiply)
    tests.push(`test("multiply multiplies", () => { assert.equal(multiply(3, 4), 12); });`);
  writeFileSync(join(repo, "test", "math.test.js"), tests.join("\n") + "\n");
  writeFileSync(
    join(repo, "README.md"),
    `# Battery ${name}\n\nSynthetic dogfood repo for Claudexor.\n`,
  );
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "ARCHITECTURE.md"),
    "# Architecture\n\nSmall ESM math module.\n",
  );
  runGit(["add", "-A"], repo);
  runGit(
    [
      "-c",
      "user.email=battery@claudexor.dev",
      "-c",
      "user.name=Claudexor Battery",
      "commit",
      "-m",
      "fixture",
    ],
    repo,
  );
  return repo;
}

function makeEmptyCreateRepo(name) {
  const repo = join(reposDir, cleanName(name));
  rmSync(repo, { recursive: true, force: true });
  initRepo(repo);
  writeFileSync(join(repo, "README.md"), "# Empty create target\n");
  runGit(["add", "-A"], repo);
  runGit(
    [
      "-c",
      "user.email=battery@claudexor.dev",
      "-c",
      "user.name=Claudexor Battery",
      "commit",
      "-m",
      "empty target",
    ],
    repo,
  );
  return repo;
}

function makeProtectedRepo(name) {
  const repo = makeMathRepo(name, { addBug: false });
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(repo, ".github", "workflows", "release.yml"),
    "name: noop\non: workflow_dispatch\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n",
  );
  runGit(["add", "-A"], repo);
  runGit(
    [
      "-c",
      "user.email=battery@claudexor.dev",
      "-c",
      "user.name=Claudexor Battery",
      "commit",
      "-m",
      "protected fixture",
    ],
    repo,
  );
  return repo;
}

function testCmd() {
  return JSON.stringify(["node", "--test"]);
}

function baseRunArgs(prompt, harnesses, extra = []) {
  return [
    "agent",
    prompt,
    "--harness",
    Array.isArray(harnesses) ? harnesses.join(",") : harnesses,
    "--effort",
    "low",
    "--max-usd",
    maxUsd,
    ...extra,
  ];
}

function assertRunStatus(phase, name, out, wanted = ["succeeded"]) {
  if (out.envFailure)
    return envfail(phase, name, {
      reason: "transient network/environment failure after retry",
      exit: out.code,
      log: rel(out.log),
      error: out.json?.error ?? out.json?.summary ?? "",
    });
  if (!out.json)
    return fail(phase, name, { error: "non-json output", exit: out.code, log: rel(out.log) });
  const status = out.json.status;
  if (!wanted.includes(status))
    return fail(phase, name, {
      status,
      exit: out.code,
      error: out.json.error ?? out.json.summary ?? "",
      log: rel(out.log),
      runId: out.json.runId,
    });
  return pass(phase, name, {
    status,
    runId: out.json.runId,
    runDir: out.json.runDir ?? out.json.runDir,
  });
}

function assertPrimaryOutput(phase, name, out, kind) {
  const r = assertRunStatus(phase, name, out, ["succeeded"]);
  if (r.status === "fail" || !out.json?.runId) return out.json;
  const detail = inspectRun(out.json.runId, out.cwd ?? root);
  const primary = detail?.primaryOutput;
  const expectedKind = kind.replace(/\.md$/, "");
  const runDir = detail?.runDir;
  const artifactPath =
    typeof runDir === "string" && typeof primary?.path === "string"
      ? join(runDir, primary.path)
      : null;
  const evidence = {
    runId: out.json.runId,
    lifecycle: detail?.lifecycle ?? null,
    outputReadyState: detail?.outputReadyState ?? null,
    expectedKind,
    actualKind: primary?.kind ?? null,
    path: primary?.path ?? null,
    artifactNonEmpty: artifactPath !== null && nonEmpty(artifactPath),
  };
  const valid =
    evidence.lifecycle === "succeeded" &&
    evidence.outputReadyState === "ready" &&
    evidence.actualKind === expectedKind &&
    evidence.artifactNonEmpty;
  (valid ? pass : fail)(phase, `${name} primary output`, evidence);
  return detail;
}

function assertCouncilArtifacts(phase, name, council, runDir) {
  const members = Array.isArray(council?.members) ? council.members : [];
  const draftedMembers = members.filter(
    (member) => member?.status === "drafted" || member?.status === "merged",
  );
  const draftFiles = draftedMembers.map((member) =>
    runDir ? artifactExists(runDir, `council/draft-${member.harnessId}.md`) : false,
  );
  const evidence = {
    requested: council?.requested,
    drafted: council?.drafted,
    mergedBy: council?.mergedBy,
    members: members.map((member) => ({
      harnessId: member?.harnessId,
      status: member?.status,
      error: member?.error ?? null,
    })),
    membership: Boolean(runDir && artifactExists(runDir, "council/membership.yaml")),
    draftFiles,
  };
  const valid =
    council?.requested === 2 &&
    council?.drafted === 2 &&
    council?.degraded === false &&
    members.length === 2 &&
    new Set(members.map((member) => member?.harnessId)).size === 2 &&
    draftedMembers.length === 2 &&
    typeof council?.mergedBy === "string" &&
    council.mergedBy.length > 0 &&
    members.some(
      (member) => member?.harnessId === council.mergedBy && member?.status === "merged",
    ) &&
    evidence.membership &&
    draftFiles.every(Boolean);
  return valid ? pass(phase, name, evidence) : fail(phase, name, evidence);
}

function recordRunEvidence(phase, name, out, cwd) {
  if (out.envFailure) {
    envfail(phase, name, {
      reason: "transient network/environment failure after retry",
      exit: out.code,
      log: rel(out.log),
      error: out.json?.error ?? out.json?.summary ?? "",
    });
    return null;
  }
  if (!out.json?.runId) return null;
  const detail = inspectRun(out.json.runId, cwd);
  const wp = detail?.work_product ?? detail?.workProduct ?? null;
  const decision = detail?.decision ?? null;
  const telemetry = detail?.telemetry ?? null;
  const patchPath = detail?.runDir ? join(detail.runDir, "final", "patch.diff") : "";
  return {
    detail,
    wp,
    decision,
    telemetry,
    patchPath,
    patchNonEmpty: patchPath ? nonEmpty(patchPath) : false,
  };
}

function gatePassed(detail) {
  return detail?.runFacts?.gates?.state === "passed";
}

function runApplyable(ev) {
  return (
    ev?.detail?.runFacts?.apply?.eligibility?.eligible === true &&
    ev?.decision?.apply_recommendation === "apply"
  );
}

function runAdoptedAndVerified(ev) {
  const outcome = ev?.detail?.runFacts?.outcome;
  return (
    outcome?.lifecycle === "succeeded" &&
    outcome?.checks === "passed" &&
    outcome?.review === "approved" &&
    ev?.wp?.meta?.adopted === true &&
    ev?.wp?.meta?.apply_state === "applied"
  );
}

function runNeedsDecision(ev) {
  const outcome = ev?.detail?.runFacts?.outcome;
  return (
    outcome?.lifecycle === "succeeded" &&
    (outcome.review === "blocked" || outcome.checks === "failed")
  );
}

function patchLooksReal(ev) {
  const diffstat = ev?.wp?.meta?.diffstat;
  return ev?.patchNonEmpty && (diffstat?.files ?? 0) > 0;
}

// Tiny PNG encoder with a 5x7 bitmap font for the marker image.
function crc32(buf) {
  const table = (crc32.table ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const FONT = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  X: ["10001", "01010", "00100", "00100", "00100", "01010", "10001"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  5: ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
};

function writeMarkerPng(path, text) {
  const scale = 8;
  const marginX = 28;
  const marginY = 58;
  const width = Math.max(520, marginX * 2 + text.length * 6 * scale);
  const height = Math.max(180, marginY * 2 + 7 * scale);
  const rgba = Buffer.alloc(width * height * 4, 255);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
  };
  for (let x = 0; x < width; x++) {
    set(x, 0, 220, 0, 0);
    set(x, height - 1, 220, 0, 0);
  }
  for (let y = 0; y < height; y++) {
    set(0, y, 220, 0, 0);
    set(width - 1, y, 220, 0, 0);
  }
  let ox = marginX;
  const oy = marginY;
  for (const ch of text) {
    const glyph = FONT[ch] ?? FONT["-"];
    for (let gy = 0; gy < glyph.length; gy++) {
      for (let gx = 0; gx < glyph[gy].length; gx++) {
        if (glyph[gy][gx] !== "1") continue;
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++)
            set(ox + gx * scale + sx, oy + gy * scale + sy, 0, 0, 0);
      }
    }
    ox += 6 * scale;
  }
  if (ox + marginX > width) throw new Error(`marker PNG too narrow for ${text}`);
  const rawRows = [];
  for (let y = 0; y < height; y++) {
    rawRows.push(Buffer.from([0]));
    rawRows.push(rgba.subarray(y * width * 4, (y + 1) * width * 4));
  }
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(Buffer.concat(rawRows))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function harnessAutomaticallyReady(h) {
  return (
    automaticBatteryHarnesses([h], evidence.harnessReadiness, evidence.harnessReports).length > 0
  );
}

function harnessIntent(h, intent) {
  const report = evidence.harnessReports[h] ?? {};
  return (report.enabledIntents ?? report.enabled_intents ?? []).includes(intent);
}

function automaticallyAvailable(list) {
  return automaticBatteryHarnesses(list, evidence.harnessReadiness, evidence.harnessReports);
}

async function runReadonlyPhase() {
  const phase = "phase1";
  for (const retired of ["audit", "explore"]) {
    const out = runCliJson([retired, "retired verb probe"], {
      cwd: repos.readonly,
      name: `${phase}-${retired}-retired`,
      envRetry: false,
    });
    if (out.code === 2 && /retired|deep-scan/i.test(out.stdout + out.stderr)) {
      pass(phase, `${retired} retired verb fails loud`, { exit: out.code });
    } else {
      fail(phase, `${retired} retired verb fails loud`, {
        exit: out.code,
        stdout: out.stdout.slice(0, 200),
        stderr: out.stderr.slice(0, 200),
      });
    }
  }
  for (const h of automaticallyAvailable(requestedHarnesses)) {
    assertPrimaryOutput(
      phase,
      `${h} ask 2+2`,
      runCliJson(
        ["ask", "Answer exactly: 4", "--harness", h, "--effort", "low", "--max-usd", maxUsd],
        { cwd: repos.readonly, name: `${phase}-${h}-ask` },
      ),
      "answer.md",
    );
    assertPrimaryOutput(
      phase,
      `${h} repository deep scan`,
      runCliJson(
        [
          "ask",
          "Briefly map this repository: files, tests, and the math bug. Do not edit files.",
          "--deep-scan",
          "--harness",
          h,
          "--effort",
          "low",
          "--max-usd",
          maxUsd,
        ],
        { cwd: repos.readonly, name: `${phase}-${h}-deep-scan-map` },
      ),
      "report.md",
    );
    assertPrimaryOutput(
      phase,
      `${h} plan`,
      runCliJson(
        [
          "plan",
          "Plan adding a multiply feature to this tiny repo. Keep it concise.",
          "--harness",
          h,
          "--effort",
          "low",
          "--max-usd",
          maxUsd,
        ],
        { cwd: repos.readonly, name: `${phase}-${h}-plan` },
      ),
      "plan.md",
    );
    assertPrimaryOutput(
      phase,
      `${h} focused deep scan`,
      runCliJson(
        [
          "ask",
          "Find where add is implemented and tested. Keep it concise.",
          "--deep-scan",
          "--harness",
          h,
          "--n",
          "1",
          "--effort",
          "low",
          "--max-usd",
          maxUsd,
        ],
        { cwd: repos.readonly, name: `${phase}-${h}-deep-scan-focused` },
      ),
      "report.md",
    );
  }
  const multi = automaticallyAvailable(requestedHarnesses);
  if (multi.length >= 2) {
    const plan = runCliJson(
      [
        "plan",
        "Plan adding multiply; reconcile disagreements between planners.",
        "--harness",
        multi.join(","),
        ...councilFlags(2),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repos.readonly, name: `${phase}-multi-plan` },
    );
    const detail = assertPrimaryOutput(phase, "multi plan", plan, "plan.md");
    if (detail?.runDir && plan.json?.runId) {
      const projected = await controlRunDetail(plan.json.runId);
      if (projected.detail)
        assertCouncilArtifacts(
          phase,
          "multi plan council artifacts",
          projected.detail.council,
          detail.runDir,
        );
      else
        fail(phase, "multi plan council artifacts", {
          runId: plan.json.runId,
          projectionError: projected.error,
        });
    }
    const exp = runCliJson(
      [
        "ask",
        "Find where add is implemented and tested; each explorer should take a distinct slice.",
        "--deep-scan",
        "--harness",
        multi.join(","),
        "--n",
        String(Math.min(3, multi.length)),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repos.readonly, name: `${phase}-multi-deep-scan` },
    );
    const ed = assertPrimaryOutput(phase, "multi deep scan", exp, "report.md");
    if (ed?.runDir) {
      pass(phase, "multi deep scan artifacts", {
        findings: existsSync(join(ed.runDir, "findings")),
        exploreFindings: artifactExists(ed.runDir, "final/explore-findings.yaml"),
        omissions: artifactExists(ed.runDir, "final/omissions.md"),
      });
    }
  } else skip(phase, "multi read-only", { reason: "need >=2 automatic-route harnesses" });
}

function runWritePhase() {
  const phase = "phase2";
  for (const h of automaticallyAvailable(requestedHarnesses)) {
    const repo = makeMathRepo(`${phase}-${h}`, { addBug: true });
    const out = runCliJson(
      baseRunArgs("Fix src/math.js add(a,b) so node --test passes. Do not change tests.", h, [
        "--test",
        testCmd(),
      ]),
      { cwd: repo, name: `${phase}-${h}-run` },
    );
    const ev = recordRunEvidence(phase, `${h} run evidence`, out, repo);
    if (!ev) continue;
    const succeededWithChecks =
      out.json?.status === "succeeded" &&
      ev.decision?.facts?.lifecycle === "succeeded" &&
      ev.decision?.facts?.checks === "passed";
    if (patchLooksReal(ev) && gatePassed(ev.detail) && succeededWithChecks)
      pass(phase, `${h} run patch+gate`, {
        runId: out.json.runId,
        status: out.json.status,
        review: ev.decision?.facts?.review ?? "unknown",
        basis: ev.decision?.verification_basis ?? "none",
      });
    else
      fail(phase, `${h} run patch+gate`, {
        runId: out.json?.runId,
        status: out.json?.status,
        patch: ev.patchNonEmpty,
        gatePassed: gatePassed(ev.detail),
        decision: ev.decision,
      });
    state.verifiedRuns.push({ harness: h, repo, out, ev });
  }
}

function runMultiWritePhase() {
  const phase = "phase3";
  const multi = automaticallyAvailable(requestedHarnesses);
  if (multi.length < 2) {
    skip(phase, "multi write features", { reason: "need >=2 automatic-route harnesses" });
    return;
  }
  {
    const repo = makeMathRepo(`${phase}-race`, { addBug: true });
    const out = runCliJson(
      [
        "best-of",
        "Fix add(a,b) in src/math.js so tests pass. Do not change tests.",
        "--harness",
        multi.join(","),
        "--n",
        String(Math.min(3, multi.length)),
        "--test",
        testCmd(),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repo, name: `${phase}-race` },
    );
    const ev = recordRunEvidence(phase, "multi race evidence", out, repo);
    if (out.envFailure) return;
    if (
      runApplyable(ev) &&
      ev.decision.verification_basis === "both" &&
      patchLooksReal(ev) &&
      gatePassed(ev.detail)
    )
      pass(phase, "multi race decision", {
        runId: out.json.runId,
        status: out.json.status,
        winner: ev.decision.winner,
        basis: ev.decision.verification_basis,
        facts: ev.decision.facts,
      });
    else
      fail(phase, "multi race decision", {
        status: out.json?.status,
        error: out.json?.error,
        log: rel(out.log),
      });
    state.multiRace = { repo, out, ev };
  }
  {
    const repo = makeMathRepo(`${phase}-synthesis`, { addBug: true });
    const out = runCliJson(
      [
        "best-of",
        "Fix add(a,b) in src/math.js so tests pass. Do not change tests.",
        "--harness",
        multi.join(","),
        "--n",
        "3",
        "--synthesis",
        "always",
        "--test",
        testCmd(),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repo, name: `${phase}-synthesis` },
    );
    const ev = recordRunEvidence(phase, "synthesis evidence", out, repo);
    if (out.envFailure) return;
    const synth = ev?.detail?.runDir
      ? artifactExists(ev.detail.runDir, "arbitration/synthesis.yaml")
      : false;
    if (
      synth &&
      runApplyable(ev) &&
      ev.decision.verification_basis === "both" &&
      patchLooksReal(ev) &&
      gatePassed(ev.detail)
    )
      pass(phase, "synthesis artifact", {
        runId: out.json?.runId,
        status: out.json?.status,
        basis: ev.decision.verification_basis,
      });
    else
      fail(phase, "synthesis artifact", {
        runId: out.json?.runId,
        status: out.json?.status,
        decision: ev?.decision,
        error: out.json?.error,
        log: rel(out.log),
      });
  }
  {
    const repo = makeMathRepo(`${phase}-convergence`, { addBug: true });
    const out = runCliJson(
      [
        "agent",
        "Fix add(a,b) in src/math.js so tests pass. Do not change tests.",
        "--harness",
        multi.join(","),
        "--until-clean",
        "--test",
        testCmd(),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repo, name: `${phase}-convergence`, timeoutMs: 30 * 60_000 },
    );
    const ev = recordRunEvidence(phase, "convergence evidence", out, repo);
    if (out.envFailure) return;
    if (
      ev?.wp?.meta?.lifecycle === "succeeded" &&
      ev.wp.meta.outcome_facts?.checks === "passed" &&
      ev.wp.meta.review_verified === true &&
      out.json?.status === "succeeded" &&
      runApplyable(ev) &&
      ev.decision?.verification_basis === "both" &&
      gatePassed(ev.detail)
    )
      pass(phase, "convergence work_product", {
        runId: out.json?.runId,
        status: ev.wp.meta.lifecycle,
        attempts: ev.detail?.telemetry?.attempts?.length ?? 0,
        reviewVerified: ev.wp.meta.review_verified,
      });
    else
      fail(phase, "convergence work_product", {
        status: out.json?.status,
        error: out.json?.error,
        log: rel(out.log),
      });
  }
  const singleFamilyReviewer = multi.find((h) => harnessIntent(h, "review"));
  if (singleFamilyReviewer) runDegradationControl(phase, singleFamilyReviewer);
  else
    fail(phase, "single-family degradation control", {
      reason: "no automatic-route reviewer",
    });
}

function runDegradationControl(phase, onlyHarness) {
  // An explicit same-family panel proves the degradation contract without
  // rewriting user-global harness settings. This keeps the existing-session
  // VM lane read-only with respect to config.yaml.
  const reviewerPanel = ["--reviewer-panel", batteryReviewerPanelEntry(onlyHarness)];
  const repo = makeMathRepo(`${phase}-single-family-control`, { addBug: true });
  const out = runCliJson(
    [
      "best-of",
      "Fix add(a,b) in src/math.js so tests pass. Do not change tests.",
      "--harness",
      onlyHarness,
      "--n",
      "1",
      ...reviewerPanel,
      "--test",
      testCmd(),
      "--effort",
      "low",
      "--max-usd",
      maxUsd,
    ],
    { cwd: repo, name: `${phase}-single-family-control` },
  );
  const ev = recordRunEvidence(phase, "single-family control", out, repo);
  if (ev?.decision) {
    const basis = ev.decision.verification_basis ?? "unknown";
    const rec = basis === "none" ? pass : fail;
    rec(phase, "single-family verification_basis=none", {
      runId: out.json?.runId,
      status: out.json?.status,
      facts: ev.decision.facts,
      basis,
    });
    const apply = runCliJson(["apply", out.json.runId, "--dry-run"], {
      cwd: repo,
      name: `${phase}-single-family-apply-refusal`,
    });
    if (
      ev.detail?.runFacts?.apply?.eligibility?.eligible === false &&
      ev.detail?.runFacts?.apply?.eligibility?.state === "not_verified" &&
      apply.code !== 0 &&
      apply.json?.runId === out.json.runId &&
      apply.json?.dryRun === true &&
      apply.json?.code === "invalid_request"
    )
      pass(phase, "single-family apply refused", { runId: out.json.runId });
    else
      fail(phase, "single-family apply refused", {
        exit: apply.code,
        stdout: apply.stdout,
        stderr: apply.stderr,
        log: rel(apply.log),
      });
  } else {
    fail(phase, "single-family control decision", {
      status: out.json?.status,
      error: out.json?.error,
      log: rel(out.log),
    });
  }
  const convRepo = makeMathRepo(`${phase}-single-family-convergence`, { addBug: true });
  const conv = runCliJson(
    [
      "agent",
      "Fix add(a,b) in src/math.js so tests pass. Do not change tests.",
      "--harness",
      onlyHarness,
      "--until-clean",
      ...reviewerPanel,
      "--test",
      testCmd(),
      "--effort",
      "low",
      "--max-usd",
      maxUsd,
    ],
    { cwd: convRepo, name: `${phase}-single-family-convergence` },
  );
  if (isCrossFamilyConvergenceRefusal(conv))
    pass(phase, "single-family convergence refused", {
      status: conv.json?.status,
      error: conv.json?.error ?? conv.json?.summary,
    });
  else
    fail(phase, "single-family convergence refused", {
      exit: conv.code,
      json: conv.json,
      log: rel(conv.log),
    });
}

function chooseVerifiedRun() {
  return (
    state.verifiedRuns.find((r) => r.out.json?.status === "succeeded" && runApplyable(r.ev)) ??
    (state.multiRace?.out?.json?.status === "succeeded" && runApplyable(state.multiRace?.ev)
      ? state.multiRace
      : null)
  );
}

function runLifecyclePhase() {
  const phase = "phase4";
  const multi = automaticallyAvailable(requestedHarnesses);
  if (multi.length < 2) {
    skip(phase, "apply/decision lifecycle", {
      reason: "need >=2 automatic-route harnesses",
    });
    return;
  }
  const verified = chooseVerifiedRun();
  if (verified?.out?.json?.runId) {
    const dry = runCliJson(["apply", verified.out.json.runId, "--dry-run"], {
      cwd: verified.repo,
      name: `${phase}-apply-dry-run`,
    });
    if (dry.code === 0) pass(phase, "apply --dry-run", { runId: verified.out.json.runId });
    else fail(phase, "apply --dry-run", { exit: dry.code, json: dry.json, log: rel(dry.log) });
  } else
    skip(phase, "apply --dry-run", { reason: "no verified applyable run from earlier phases" });

  for (const mode of ["branch", "commit"]) {
    const repo = makeMathRepo(`${phase}-apply-${mode}`, { addBug: true });
    const out = runCliJson(
      [
        "best-of",
        "Fix add(a,b) in src/math.js so tests pass. Do not change tests.",
        "--harness",
        multi.join(","),
        "--n",
        String(Math.min(3, multi.length)),
        "--test",
        testCmd(),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repo, name: `${phase}-${mode}-source` },
    );
    const ev = recordRunEvidence(phase, `apply ${mode} source`, out, repo);
    if (out.json?.status === "succeeded" && runApplyable(ev)) {
      const applied = runCliJson(["apply", out.json.runId, "--mode", mode], {
        cwd: repo,
        name: `${phase}-apply-${mode}`,
      });
      if (applied.code === 0 && applied.json?.applied)
        pass(phase, `apply --mode ${mode}`, applied.json);
      else
        fail(phase, `apply --mode ${mode}`, {
          exit: applied.code,
          json: applied.json,
          log: rel(applied.log),
        });
    } else
      skip(phase, `apply --mode ${mode}`, {
        reason: "source run not applyable",
        status: out.json?.status,
        decision: ev?.decision,
      });
  }

  runBlockedDecisionScenario(phase, multi);
  runRevertScenario(phase, multi);
}

function runBlockedDecisionScenario(phase, multi) {
  const repo = makeProtectedRepo(`${phase}-blocked-risk`);
  const prompt =
    "Make a harmless wording-only change to .github/workflows/release.yml by changing the echo text to 'battery ok'. Do not touch other files.";
  const out = runCliJson(
    [
      "agent",
      prompt,
      "--harness",
      multi.join(","),
      "--test",
      "true",
      "--effort",
      "low",
      "--max-usd",
      maxUsd,
    ],
    { cwd: repo, name: `${phase}-blocked-risk` },
  );
  const ev = recordRunEvidence(phase, "blocked risk evidence", out, repo);
  if (runNeedsDecision(ev) && ev?.patchNonEmpty) {
    pass(phase, "blocked high-risk run", {
      runId: out.json.runId,
      facts: ev.decision?.facts,
    });
    const dec = runCliJson(["decision", out.json.runId, "--accept-risk"], {
      cwd: repo,
      name: `${phase}-accept-risk`,
    });
    if (dec.code === 0 && dec.json?.accepted) pass(phase, "decision --accept-risk", dec.json);
    else
      fail(phase, "decision --accept-risk", { exit: dec.code, json: dec.json, log: rel(dec.log) });
    const op = ev.detail?.runDir
      ? existsSync(join(ev.detail.runDir, "arbitration", "operator_decision.yaml"))
      : false;
    if (op) pass(phase, "operator_decision.yaml", { runId: out.json.runId });
    else fail(phase, "operator_decision.yaml", { runId: out.json.runId });
  } else {
    skip(phase, "blocked high-risk decision", {
      reason: "scenario did not produce blocked patch",
      status: out.json?.status,
      decision: ev?.decision,
      log: rel(out.log),
    });
  }

  const rerunRepo = makeProtectedRepo(`${phase}-blocked-rerun`);
  const rerunSrc = runCliJson(
    [
      "agent",
      prompt,
      "--harness",
      multi.join(","),
      "--test",
      "true",
      "--effort",
      "low",
      "--max-usd",
      maxUsd,
    ],
    { cwd: rerunRepo, name: `${phase}-blocked-rerun-source` },
  );
  const rerunEv = recordRunEvidence(phase, "blocked rerun evidence", rerunSrc, rerunRepo);
  if (runNeedsDecision(rerunEv)) {
    const rerun = runCliJson(
      [
        "decision",
        rerunSrc.json.runId,
        "--rerun",
        "--feedback",
        "Use a smaller harmless wording change only.",
      ],
      { cwd: rerunRepo, name: `${phase}-rerun-feedback` },
    );
    if (rerun.code === 0 && rerun.json?.newRunId)
      pass(phase, "decision --rerun", { newRunId: rerun.json.newRunId });
    else
      fail(phase, "decision --rerun", { exit: rerun.code, json: rerun.json, log: rel(rerun.log) });
  } else
    skip(phase, "decision --rerun", {
      reason: "source did not block",
      status: rerunSrc.json?.status,
    });
}

function runRevertScenario(phase, multi) {
  const repo = makeMathRepo(`${phase}-revert`, { addBug: true });
  const mathPath = join(repo, "src", "math.js");
  const preTurnMath = readFileSync(mathPath, "utf8");
  const out = runCliJson(
    [
      "agent",
      "Fix add(a,b) in src/math.js so tests pass. Do not change tests.",
      "--harness",
      multi.join(","),
      "--in-place",
      "--test",
      testCmd(),
      "--effort",
      "low",
      "--max-usd",
      maxUsd,
    ],
    { cwd: repo, name: `${phase}-in-place-revert` },
  );
  if (out.json?.runId && out.json.status === "succeeded") {
    const rev = runCliJson(["decision", out.json.runId, "--revert"], {
      cwd: repo,
      name: `${phase}-revert`,
    });
    const deliveryState = RunDeliveryState.safeParse(
      new ArtifactStore(repo).readYaml(join(out.json.runDir, "final", "delivery_state.yaml")),
    );
    if (
      rev.code === 0 &&
      rev.json?.accepted === true &&
      readFileSync(mathPath, "utf8") === preTurnMath &&
      deliveryState.success &&
      deliveryState.data.applyState === "reverted"
    )
      pass(phase, "decision --revert", {
        runId: out.json.runId,
        applyState: deliveryState.data.applyState,
      });
    else
      fail(phase, "decision --revert", {
        exit: rev.code,
        json: rev.json,
        bytesRestored: readFileSync(mathPath, "utf8") === preTurnMath,
        deliveryState: deliveryState.success ? deliveryState.data : null,
        log: rel(rev.log),
      });
  } else
    skip(phase, "decision --revert", {
      reason: "in-place source not succeeded",
      status: out.json?.status,
      error: out.json?.error,
      log: rel(out.log),
    });

  const repo2 = makeMathRepo(`${phase}-revert-diverged`, { addBug: true });
  const out2 = runCliJson(
    [
      "agent",
      "Fix add(a,b) in src/math.js so tests pass. Do not change tests.",
      "--harness",
      multi.join(","),
      "--in-place",
      "--test",
      testCmd(),
      "--effort",
      "low",
      "--max-usd",
      maxUsd,
    ],
    { cwd: repo2, name: `${phase}-in-place-diverge-source` },
  );
  if (out2.json?.runId && out2.json.status === "succeeded") {
    const touchedPath = join(repo2, "src", "math.js");
    const postimage = readFileSync(touchedPath, "utf8");
    const userEdit = postimage.replace(
      "return a + b;",
      "return Number(a) + Number(b); // user edit after the run",
    );
    if (userEdit === postimage) {
      fail(phase, "revert divergence fixture", { reason: "run-owned postimage was absent" });
      return;
    }
    writeFileSync(touchedPath, userEdit);
    const rev = runCliJson(["decision", out2.json.runId, "--revert"], {
      cwd: repo2,
      name: `${phase}-revert-diverged`,
    });
    if (
      rev.code !== 0 &&
      rev.json?.code === "revert_refused" &&
      rev.json?.context?.reason === "postimage_diverged" &&
      readFileSync(touchedPath, "utf8") === userEdit
    )
      pass(phase, "revert divergence fence", { runId: out2.json.runId });
    else
      fail(phase, "revert divergence fence", { exit: rev.code, json: rev.json, log: rel(rev.log) });
  } else
    skip(phase, "revert divergence fence", {
      reason: "in-place source not succeeded",
      status: out2.json?.status,
    });
}

function runCreatePhase() {
  const phase = "phase5";
  const multi = automaticallyAvailable(requestedHarnesses);
  for (const h of automaticallyAvailable(requestedHarnesses)) {
    const repo = makeEmptyCreateRepo(`${phase}-${h}`);
    const out = runCliJson(
      [
        "create",
        "Create a tiny ESM Node project with src/hello.js exporting hello(name) and a node:test test in test/hello.test.js. Keep it minimal.",
        "--harness",
        h,
        "--test",
        testCmd(),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repo, name: `${phase}-${h}-create` },
    );
    const ev = recordRunEvidence(phase, `${h} create evidence`, out, repo);
    if (out.envFailure) continue;
    if (ev?.patchNonEmpty && ev?.wp?.kind === "new_repo")
      pass(phase, `${h} create patch`, {
        runId: out.json?.runId,
        status: out.json?.status,
        kind: ev.wp.kind,
      });
    else
      fail(phase, `${h} create patch`, {
        runId: out.json?.runId,
        status: out.json?.status,
        kind: ev?.wp?.kind,
        patch: ev?.patchNonEmpty,
        error: out.json?.error,
      });
  }
  if (multi.length >= 2) {
    const repo = makeEmptyCreateRepo(`${phase}-multi`);
    const out = runCliJson(
      [
        "create",
        "Create a tiny ESM Node project with src/hello.js exporting hello(name) and a node:test test in test/hello.test.js. Keep it minimal.",
        "--harness",
        multi.join(","),
        "--n",
        String(Math.min(3, multi.length)),
        "--test",
        testCmd(),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repo, name: `${phase}-multi-create` },
    );
    const ev = recordRunEvidence(phase, "multi create evidence", out, repo);
    if (out.envFailure) return;
    if (ev?.patchNonEmpty && ev?.wp?.kind === "new_repo")
      pass(phase, "multi create patch", {
        runId: out.json?.runId,
        status: out.json?.status,
        kind: ev.wp.kind,
        basis: ev.decision?.verification_basis,
      });
    else
      fail(phase, "multi create patch", {
        runId: out.json?.runId,
        status: out.json?.status,
        kind: ev?.wp?.kind,
        patch: ev?.patchNonEmpty,
        error: out.json?.error,
      });
  } else skip(phase, "multi create", { reason: "need >=2 automatic-route harnesses" });
}

function runVisionPhase() {
  const phase = "phase6";
  const png = join(batteryRoot, "marker.png");
  writeMarkerPng(png, marker);
  const visionHarnesses = automaticallyAvailable(["codex", "claude"]);
  for (const h of visionHarnesses) {
    const out = runCliJson(
      [
        "ask",
        `Read the image. What exact marker text is shown? Answer only the marker text.`,
        "--harness",
        h,
        "--image",
        png,
        ...(h === "claude" ? ["--model", "claude-sonnet-4-6"] : []),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repos.readonly, name: `${phase}-${h}-image` },
    );
    const detail = assertPrimaryOutput(phase, `${h} image`, out, "answer.md");
    const answer = detail?.primaryOutput?.text ?? "";
    if (answer.includes(marker))
      pass(phase, `${h} image marker`, { marker, runId: out.json?.runId });
    else
      fail(phase, `${h} image marker`, {
        marker,
        answer: answer.slice(0, 200),
        runId: out.json?.runId,
      });
  }
  if (visionHarnesses.length >= 2) {
    const out = runCliJson(
      [
        "ask",
        `Read the image. What exact marker text is shown? Answer only the marker text.`,
        "--harness",
        visionHarnesses.join(","),
        "--image",
        png,
        "--primary-harness",
        "claude",
        "--model",
        "claude-sonnet-4-6",
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repos.readonly, name: `${phase}-multi-image` },
    );
    const detail = assertPrimaryOutput(phase, "multi image", out, "answer.md");
    const answer = detail?.primaryOutput?.text ?? "";
    if (answer.includes(marker))
      pass(phase, "multi image marker", { marker, runId: out.json?.runId });
    else
      fail(phase, "multi image marker", {
        marker,
        answer: answer.slice(0, 200),
        runId: out.json?.runId,
      });
  } else skip(phase, "multi image", { reason: "need codex+claude automatic routes" });
  if (harnessAutomaticallyReady("cursor")) {
    const out = runCliJson(
      [
        "ask",
        "Read the image.",
        "--harness",
        "cursor",
        "--image",
        png,
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repos.readonly, name: `${phase}-cursor-image-negative` },
    );
    if (out.code !== 0 && out.json?.code === "attachment_pool_unsupported")
      pass(phase, "cursor image typed refusal", {
        status: out.json?.status,
        code: out.json.code,
      });
    else
      fail(phase, "cursor image typed refusal", {
        exit: out.code,
        json: out.json,
        log: rel(out.log),
      });
  } else skip(phase, "cursor image negative", { reason: "cursor has no automatic route" });
}

function runWebPhase() {
  const phase = "phase7";
  const prompt =
    "Use live web/search evidence to fetch https://example.com and answer with the page heading/domain in one sentence.";
  const validatedJournal = (runDir, expectedRunId) => {
    if (typeof runDir !== "string" || typeof expectedRunId !== "string") {
      return { valid: false, reason: "run_events_missing_or_malformed", events: [] };
    }
    try {
      const task = FrozenTaskContractArtifact.safeParse(
        new ArtifactStore(root).readYaml(join(runDir, "context", "task.yaml")),
      );
      if (!task.success) {
        return { valid: false, reason: "task_contract_missing_or_malformed", events: [] };
      }
      return validateBatteryRunArtifacts({
        job: { runId: expectedRunId, taskId: task.data.task_id },
        task: task.data,
        eventText: readFileSync(join(runDir, "events.jsonl"), "utf8"),
        telemetry: null,
        telemetryPresent: false,
        runEventSchema: RunEvent,
        harnessEventSchema: HarnessEvent,
        telemetrySchema: RunTelemetry,
      });
    } catch {
      return { valid: false, reason: "run_events_missing_or_malformed", events: [] };
    }
  };
  const assertOptionalWebOutput = (name, out) => {
    if (out.envFailure) {
      assertRunStatus(phase, name, out, ["succeeded"]);
      return null;
    }
    const detail = assertPrimaryOutput(phase, name, out, "answer.md");
    if (detail?.lifecycle !== "succeeded" || detail?.outputReadyState !== "ready") return detail;
    const journal = validatedJournal(detail?.runDir ?? out.json?.runDir, out.json?.runId);
    const started =
      journal.valid && journal.events.some((event) => event?.type === "harness.started");
    const observation = {
      runId: out.json?.runId ?? null,
      started,
      journalValid: journal.valid,
      journalReason: journal.reason,
      webStatus: detail?.telemetry?.web?.status ?? null,
      webAttempted: detail?.telemetry?.web?.attempted ?? null,
      webSatisfied: detail?.telemetry?.web?.satisfied ?? null,
    };
    (started ? pass : fail)(phase, `${name} harness started`, observation);
    if (journal.valid) pass(phase, `${name} web observation`, observation);
    return detail;
  };
  const webHarnesses = automaticallyAvailable(["codex", "claude"]);
  for (const h of webHarnesses) {
    const out = runCliJson(
      ["ask", prompt, "--harness", h, "--web", "live", "--effort", "low", "--max-usd", maxUsd],
      { cwd: repos.readonly, name: `${phase}-${h}-web` },
    );
    assertOptionalWebOutput(`${h} live-policy answer`, out);
  }
  if (webHarnesses.length >= 2) {
    const out = runCliJson(
      [
        "ask",
        prompt,
        "--harness",
        webHarnesses.join(","),
        "--web",
        "live",
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repos.readonly, name: `${phase}-multi-web` },
    );
    assertOptionalWebOutput("multi live-policy answer", out);
  } else skip(phase, "multi web", { reason: "need codex+claude automatic routes" });
  if (harnessAutomaticallyReady("cursor")) {
    const live = runCliJson(
      [
        "ask",
        prompt,
        "--harness",
        "cursor",
        "--web",
        "live",
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repos.readonly, name: `${phase}-cursor-web` },
    );
    assertOptionalWebOutput("cursor live-policy answer", live);

    const off = runCliJson(
      [
        "ask",
        "Answer exactly: 4",
        "--harness",
        "cursor",
        "--web",
        "off",
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repos.readonly, name: `${phase}-cursor-web-off` },
    );
    const offRunDir = off.json?.runDir;
    const failure =
      typeof offRunDir === "string"
        ? new ArtifactStore(root).readYaml(join(offRunDir, "final", "failure.yaml"))
        : null;
    const expectedMessage =
      "cursor cannot guarantee web is disabled (manifest web_policy=uncontrolled); rerun with --web auto, --web cached, or --web live, or select a harness that can enforce --web off";
    const offJournal = validatedJournal(offRunDir, off.json?.runId);
    const offEvidence = {
      runId: off.json?.runId ?? null,
      exit: off.code,
      category: failure?.category ?? null,
      safeMessage: failure?.safeMessage ?? null,
      journalValid: offJournal.valid,
      journalReason: offJournal.reason,
      harnessStarted: offJournal.valid
        ? offJournal.events.some((event) => event?.type === "harness.started")
        : null,
    };
    if (
      off.code !== 0 &&
      offEvidence.category === "harness_unavailable" &&
      offEvidence.safeMessage === expectedMessage &&
      offEvidence.journalValid === true &&
      offEvidence.harnessStarted === false
    ) {
      pass(phase, "cursor off typed refusal", offEvidence);
    } else {
      fail(phase, "cursor off typed refusal", { ...offEvidence, log: rel(off.log) });
    }
  } else skip(phase, "cursor web", { reason: "cursor has no automatic route" });
}

async function runPlanPhase() {
  const phase = "phase8";
  const multi = automaticallyAvailable(requestedHarnesses);
  if (multi.length < 2) {
    skip(phase, "plan lifecycle", { reason: "need >=2 automatic-route harnesses" });
    return;
  }
  const repo = makeMathRepo(`${phase}-plan`, {
    addBug: true,
    multiplyBug: true,
    testMultiply: true,
  });
  const prompt =
    "Add a multiply feature and fix math so all node:test tests pass. Use the existing tiny public API. There are no product choices to ask the owner; record an empty Open Questions set.";
  try {
    const [{ ensureDaemon, enqueueAndAwait }, { controlApiFetch }] = await Promise.all([
      import("../packages/cli/dist/daemon-run.js"),
      import("../packages/cli/dist/live.js"),
    ]);
    const { client, addr } = await ensureDaemon();
    const requestJson = async (path, init = {}) => {
      const response = await controlApiFetch(addr, path, init);
      const text = await response.text();
      const body = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(
          `${init.method ?? "GET"} ${path} failed (HTTP ${response.status}): ${JSON.stringify(body)}`,
        );
      }
      return body;
    };
    const thread = await requestJson("/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Real-harness Plan to Implement proof",
        scope: { kind: "project", root: repo },
        mode: "plan",
        workspace: "in_place",
        authPreference: "auto",
        primaryHarness: multi[0],
        eligibleHarnesses: multi,
        access: "workspace_write",
      }),
    });
    const shared = {
      threadId: thread.id,
      scope: { kind: "project", root: repo },
      execution: { isolation: "live" },
      harnesses: multi,
      primaryHarness: multi[0],
      models: batteryRoutingModels(multi),
      effort: "low",
      paidBudget: { kind: "finite", maxUsd: Number(maxUsd) },
      maxSeconds: 30 * 60,
    };
    const planOutcome = await enqueueAndAwait(
      client,
      addr,
      {
        ...shared,
        prompt,
        mode: "plan",
        council: true,
        n: 2,
      },
      { waitForTerminal: true },
    );
    const planMd = join(planOutcome.runDir, "final", "plan.md");
    if (planOutcome.status !== "succeeded" || !nonEmpty(planMd)) {
      fail(phase, "plan produced", {
        threadId: thread.id,
        runId: planOutcome.runId,
        status: planOutcome.status,
        error: planOutcome.error,
        plan: nonEmpty(planMd),
      });
      return;
    }
    const frozenPlan = readFileSync(planMd);
    const planHash = createHash("sha256").update(frozenPlan).digest("hex");
    pass(phase, "plan produced", {
      threadId: thread.id,
      runId: planOutcome.runId,
      sha256: planHash,
    });
    const planDetail = ControlRunDetail.parse(
      await requestJson(`/runs/${encodeURIComponent(planOutcome.runId)}`),
    );
    assertCouncilArtifacts(phase, "plan council artifacts", planDetail.council, planOutcome.runDir);

    // This is the product's actual Implement action: a second turn in the SAME
    // thread names the exact plan run. The server freezes plan.md, mints
    // planRef, forces agent mode, and materializes context/PLAN.md.
    const implementOutcome = await enqueueAndAwait(
      client,
      addr,
      withBatteryReviewerModels({
        ...shared,
        prompt: "Implement this plan.",
        mode: "agent",
        planRunId: planOutcome.runId,
        n: Math.min(3, multi.length),
        tests: [{ program: "node", args: ["--test"] }],
      }),
      { waitForTerminal: true },
    );
    const runOut = {
      code: implementOutcome.status === "succeeded" ? 0 : 1,
      json: {
        runId: implementOutcome.runId,
        runDir: implementOutcome.runDir,
        status: implementOutcome.status,
        error: implementOutcome.error,
      },
      cwd: repo,
      envFailure: false,
      log: logPath(`${phase}-implement-control-api`),
    };
    writeFileSync(
      runOut.log,
      redactSecrets(
        JSON.stringify(
          {
            threadId: thread.id,
            planRunId: planOutcome.runId,
            implementRunId: implementOutcome.runId,
            status: implementOutcome.status,
            error: implementOutcome.error ?? null,
          },
          null,
          2,
        ),
      ),
    );
    const ev = recordRunEvidence(phase, "implement evidence", runOut, repo);
    if (
      implementOutcome.status === "succeeded" &&
      ev?.patchNonEmpty &&
      gatePassed(ev.detail) &&
      runAdoptedAndVerified(ev) &&
      ev.decision?.verification_basis === "both"
    ) {
      pass(phase, "implement patch+gate", {
        runId: implementOutcome.runId,
        status: implementOutcome.status,
        basis: ev.decision.verification_basis,
      });
    } else {
      fail(phase, "implement patch+gate", {
        runId: implementOutcome.runId,
        status: implementOutcome.status,
        patch: ev?.patchNonEmpty ?? false,
        gatePassed: gatePassed(ev?.detail),
        decision: ev?.decision ?? null,
        error: implementOutcome.error,
      });
    }

    const threadDetail = await requestJson(`/threads/${encodeURIComponent(thread.id)}`);
    const implementTurn = (threadDetail.turns ?? []).find(
      (turn) => turn.runId === implementOutcome.runId,
    );
    const materializedPath = join(implementOutcome.runDir, "context", "PLAN.md");
    const materialized = existsSync(materializedPath) ? readFileSync(materializedPath) : null;
    const eventsPath = join(implementOutcome.runDir, "events.jsonl");
    const planEvent = existsSync(eventsPath)
      ? readFileSync(eventsPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .find(
            (event) =>
              event?.type === "plan.brief.materialized" &&
              event?.payload?.plan_run_id === planOutcome.runId &&
              event?.payload?.sha256 === planHash &&
              event?.payload?.path === "context/PLAN.md",
          )
      : null;
    const lineage = threadDetail.thread?.runIds ?? [];
    const proof = {
      threadId: thread.id,
      planRunId: planOutcome.runId,
      implementRunId: implementOutcome.runId,
      bothRunsInThread:
        lineage.includes(planOutcome.runId) && lineage.includes(implementOutcome.runId),
      turnPlanRunId: implementTurn?.planRunId ?? null,
      turnPlanHash: implementTurn?.planHash ?? null,
      readinessOverridden: implementTurn?.planReadinessOverridden ?? null,
      planArtifactUnchanged: readFileSync(planMd).equals(frozenPlan),
      materializedByteExact: materialized?.equals(frozenPlan) ?? false,
      materializedEvent: Boolean(planEvent),
    };
    const proofValid =
      proof.bothRunsInThread &&
      proof.turnPlanRunId === planOutcome.runId &&
      proof.turnPlanHash === planHash &&
      proof.readinessOverridden === false &&
      proof.planArtifactUnchanged &&
      proof.materializedByteExact &&
      proof.materializedEvent;
    (proofValid ? pass : fail)(phase, "same-thread planRunId Implement freeze", proof);
  } catch (error) {
    fail(phase, "plan lifecycle control API", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runDelegationPhase() {
  // D32: `orchestrate` is gone; `agent --delegate` injects the scoped Claudexor
  // belt into a claude/codex sandbox so the harness can spawn bounded isolated
  // sub-runs. Positive: a delegate agent run on an mcp_injection harness still
  // produces a work product (the belt injection doesn't break the run).
  // A non-injecting Cursor lane continues as ordinary Agent, but records the
  // stable typed reason instead of silently pretending Delegate was effective.
  const phase = "phase9";
  const candidates = automaticallyAvailable(requestedHarnesses).filter(
    (h) => h === "claude" || h === "codex",
  );
  for (const h of candidates) {
    const repo = makeMathRepo(`${phase}-${h}-delegate`, { addBug: true });
    const accessArgs = [];
    let fullAccessGranted = false;
    try {
      if (h === "codex") {
        const trust = runCliJson(["trust", "--allow-full-access"], {
          cwd: repo,
          name: `${phase}-${h}-delegate-trust`,
        });
        if (trust.code !== 0) {
          fail(phase, `${h} Delegate disposable full-access grant`, {
            exit: trust.code,
            log: rel(trust.log),
          });
          continue;
        }
        fullAccessGranted = true;
        accessArgs.push("--access", "full");
      }
      const out = runCliJson(
        [
          "agent",
          "First use exactly one claudexor_ask belt tool to locate where add is defined in the original project. Do not ask the child to inspect your private candidate workspace or run tests. Then fix add locally; the configured gate will verify it.",
          "--delegate",
          "--harness",
          h,
          ...accessArgs,
          "--test",
          testCmd(),
          "--effort",
          "low",
          "--max-usd",
          maxUsd,
        ],
        { cwd: repo, name: `${phase}-${h}-delegate` },
      );
      const projected = out.json?.runId
        ? await controlRunDetail(out.json.runId)
        : { detail: null, error: "run id missing" };
      const delegation = projected.detail?.summary?.delegation;
      const children = projected.detail?.children ?? [];
      const child = children.find(
        (item) =>
          item.delegatedFromRunId === out.json?.runId &&
          item.mode === "ask" &&
          item.state === "succeeded",
      );
      if (
        out.code === 0 &&
        out.json?.status === "succeeded" &&
        delegation?.requested === true &&
        delegation?.effective === true &&
        delegation?.used === true &&
        projected.detail?.runFacts?.outcome?.checks === "passed" &&
        projected.detail?.summary?.result?.kind === "patch" &&
        children.length === 1 &&
        child
      )
        pass(phase, `${h} agent --delegate`, {
          runId: out.json.runId,
          childRunId: child.runId,
          delegation,
        });
      else
        fail(phase, `${h} agent --delegate`, {
          exit: out.code,
          status: out.json?.status,
          delegation,
          projectionError: projected.error,
          children: children.map((item) => ({
            runId: item.runId,
            state: item.state,
            mode: item.mode,
            delegatedFromRunId: item.delegatedFromRunId,
          })),
          log: rel(out.log),
        });
    } finally {
      if (fullAccessGranted) {
        const revoke = runCliJson(["trust", "--revoke-full-access"], {
          cwd: repo,
          name: `${phase}-${h}-delegate-trust-revoke`,
        });
        (revoke.code === 0 ? pass : fail)(phase, `${h} Delegate full-access grant revoked`, {
          exit: revoke.code,
          log: rel(revoke.log),
        });
      }
    }
  }
  if (candidates.length === 0)
    skip(phase, "agent --delegate", {
      reason: "need an automatic-route claude/codex harness",
    });
  if (harnessAutomaticallyReady("codex")) {
    const repo = makeMathRepo(`${phase}-codex-delegate-workspace`, { addBug: true });
    const out = runCliJson(
      [
        "agent",
        "Fix add() and verify with node --test in this repo.",
        "--delegate",
        "--harness",
        "codex",
        "--test",
        testCmd(),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repo, name: `${phase}-codex-delegate-workspace` },
    );
    const detail = out.json?.runId ? inspectRun(out.json.runId, repo) : null;
    const delegation = detail?.telemetry?.delegation;
    if (
      out.code === 0 &&
      out.json?.status === "succeeded" &&
      delegation?.requested === true &&
      delegation?.effective === false &&
      delegation?.reason === "access_profile_incompatible" &&
      detail?.runFacts?.outcome?.checks === "passed" &&
      detail?.work_product?.meta?.result_kind === "patch"
    )
      pass(phase, "codex workspace_write Delegate degrades to ordinary Agent", {
        runId: out.json.runId,
        delegation,
      });
    else
      fail(phase, "codex workspace_write Delegate degrades to ordinary Agent", {
        exit: out.code,
        status: out.json?.status,
        delegation,
        failure: out.json?.failure ?? null,
        log: rel(out.log),
      });
  }
  if (harnessAutomaticallyReady("cursor")) {
    const repo = makeMathRepo(`${phase}-cursor-delegate`, { addBug: true });
    const out = runCliJson(
      [
        "agent",
        "Fix add() and verify with node --test in this repo.",
        "--delegate",
        "--harness",
        "cursor",
        "--test",
        testCmd(),
        "--effort",
        "low",
        "--max-usd",
        maxUsd,
      ],
      { cwd: repo, name: `${phase}-cursor-delegate-negative` },
    );
    const detail = out.json?.runId ? inspectRun(out.json.runId, repo) : null;
    const delegation = detail?.telemetry?.delegation;
    if (
      out.json?.runId &&
      delegation?.requested === true &&
      delegation?.effective === false &&
      delegation?.reason === "manifest_unsupported"
    )
      pass(phase, "cursor --delegate typed degradation", {
        runId: out.json.runId,
        reason: delegation.reason,
      });
    else
      fail(phase, "cursor --delegate typed degradation", {
        exit: out.code,
        json: out.json,
        delegation,
        log: rel(out.log),
      });
    if (
      out.code === 0 &&
      out.json?.status === "succeeded" &&
      detail?.runFacts?.outcome?.checks === "passed" &&
      detail?.work_product?.meta?.result_kind === "patch"
    )
      pass(phase, "cursor ordinary Agent after Delegate degradation", {
        runId: out.json.runId,
      });
    else
      fail(phase, "cursor ordinary Agent after Delegate degradation", {
        exit: out.code,
        status: out.json?.status,
        failure: out.json?.failure ?? null,
        log: rel(out.log),
      });
  }
}

/** A private execution clone: stable project identity and mutable cwd must
 * never collapse back into one path in this external-orchestrator phase. */
function makeExecutionClone(stableProject, name) {
  const execution = join(reposDir, cleanName(`${name}-execution`));
  rmSync(execution, { recursive: true, force: true });
  runGit(["clone", "--no-hardlinks", stableProject, execution], reposDir);
  return execution;
}

function boundedNativeStateFiles(rootDir, limit = 8_000) {
  if (!rootDir || !existsSync(rootDir)) return [];
  const files = [];
  const pending = [rootDir];
  while (pending.length > 0 && files.length < limit) {
    const dir = pending.pop();
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) pending.push(path);
      else if (stat.isFile()) files.push(path);
      if (files.length >= limit) break;
    }
  }
  return files;
}

function runArtifactContains(runDir, needle) {
  if (!runDir || !existsSync(runDir)) return false;
  for (const path of boundedNativeStateFiles(runDir)) {
    try {
      if (statSync(path).size <= 5 * 1024 * 1024 && readFileSync(path).includes(needle))
        return true;
    } catch {
      /* binary/vanished artifacts are irrelevant to this bounded text search */
    }
  }
  return false;
}

const batteryModelCache = new Map();

function selectBatteryModel(harnessId) {
  const cached = batteryModelCache.get(harnessId);
  if (cached) return cached;
  const catalog = runCliJson(["models", "--harness", harnessId], {
    name: `battery-${harnessId}-models`,
    envRetry: false,
  });
  const models = catalog.json?.harnesses?.[0]?.models ?? [];
  const ids = models.map((model) => model.id).filter((id) => typeof id === "string");
  const selected = selectRealHarnessBatteryModel(harnessId, ids);
  batteryModelCache.set(harnessId, selected);
  return selected;
}

function batteryRoutingModels(harnesses) {
  const models = {};
  for (const harnessId of harnesses) {
    const selected = selectBatteryModel(harnessId);
    if (harnessId === "claude" && (!selected.id || !/haiku/i.test(selected.id))) {
      throw new Error(
        "real-harness battery requires an explicit catalog-backed Claude Haiku model",
      );
    }
    if (selected.id) models[harnessId] = selected.id;
  }
  return models;
}

function batteryScalarModel(harnessId) {
  const selected = selectBatteryModel(harnessId);
  if (harnessId === "claude" && (!selected.id || !/haiku/i.test(selected.id))) {
    throw new Error("real-harness battery requires an explicit catalog-backed Claude Haiku model");
  }
  return selected.id ? { model: selected.id } : {};
}

async function runNativeAccessSuccessRow(phase, row, profileEntry) {
  const stable = makeMathRepo(`${phase}-${row.id}-stable`, { addBug: true });
  const execution = makeExecutionClone(stable, `${phase}-${row.id}`);
  const stableTree = runGit(["rev-parse", "HEAD^{tree}"], stable);
  const stableMath = readFileSync(join(stable, "src", "math.js"));
  const model = selectBatteryModel(row.harness);
  const profileState = row.profileId
    ? canonicalBatteryProfileState(profileEntry, row.harness)
    : { valid: true, locator: null, files: [] };
  let trustGranted = false;
  let page = null;
  try {
    if (row.browser) page = await startBrowserProbePage();
    if (row.access === "full") {
      const trust = runCliJson(["trust", "--allow-full-access"], {
        cwd: stable,
        name: `${phase}-${row.id}-trust`,
        envRetry: false,
      });
      if (trust.code !== 0) {
        fail(phase, row.name, {
          reason: "full trust failed",
          exit: trust.code,
          log: rel(trust.log),
        });
        return;
      }
      trustGranted = true;
    }
    const { ensureDaemon, enqueueAndAwait } = await import("../packages/cli/dist/daemon-run.js");
    const { client, addr } = await ensureDaemon();
    const browserInstruction = page ? browserProbeInstruction(page.url) : "";
    const outcome = await enqueueAndAwait(
      client,
      addr,
      withBatteryReviewerModels({
        prompt: `Fix add() in src/math.js so node --test passes. Do not ask questions.${browserInstruction}`,
        mode: "agent",
        scope: { kind: "project", root: stable },
        execution: { isolation: "live", delegated: true, workspaceRoot: execution },
        harnesses: [row.harness],
        primaryHarness: row.harness,
        access: row.access,
        ...(row.profileId ? { credentialProfileId: row.profileId } : {}),
        ...(model.id ? { model: model.id } : {}),
        web: "auto",
        ...(row.browser ? { browser: true } : {}),
        effort: "low",
        paidBudget: { kind: "finite", maxUsd: Number(maxUsd) },
        maxSeconds: 15 * 60,
        tests: [{ program: "node", args: ["--test"] }],
      }),
      { waitForTerminal: true },
    );
    const projected = outcome.runId
      ? await controlRunDetail(outcome.runId)
      : { detail: null, error: "run id missing" };
    const detail = projected.detail;
    const candidates = detail?.candidates ?? [];
    const boundaryEvidence = candidates.map((candidate) => candidate.confinement).filter(Boolean);
    const absenceExact =
      boundaryEvidence.length > 0 &&
      boundaryEvidence.every(
        (item) =>
          item.proven === false &&
          item.mechanism === null &&
          item.verifiedDeniedPath === null &&
          item.unavailableReason === DELIBERATE_NO_OUTER_BOUNDARY_REASON,
      );
    const job = (await runtimeState.daemonClient.list({ id: outcome.runId })).find(
      (candidate) => candidate.runId === outcome.runId,
    );
    const params =
      job?.params && typeof job.params === "object" && !Array.isArray(job.params) ? job.params : {};
    const task = outcome.runDir
      ? protectedStateReader.readYaml(join(outcome.runDir, "context", "task.yaml"))
      : null;
    const stableUntouched =
      runGit(["rev-parse", "HEAD^{tree}"], stable) === stableTree &&
      readFileSync(join(stable, "src", "math.js")).equals(stableMath) &&
      run("git", ["status", "--porcelain"], { cwd: stable }).stdout.trim() === "";
    const executionMutated = !readFileSync(join(execution, "src", "math.js")).equals(stableMath);
    const gateGreen = run("node", ["--test"], { cwd: execution, timeoutMs: 120_000 }).code === 0;
    const route = detail?.summary?.route;
    const auth = detail?.summary?.authRoute;
    const namedProfileExact = row.profileId ? auth?.profileId === row.profileId : true;
    const nativeRoute = auth?.effective === "local_session" && auth?.source === "native_session";
    const browserReceipt = row.browser
      ? detail?.summary?.requestRequirements?.find(
          (receipt) => receipt.capability === "browser" && receipt.harness_id === row.harness,
        )
      : null;
    const browserEvidence = page
      ? evaluateBrowserPageEvidence(readRunJournal(outcome.runDir), page)
      : null;
    const rootPairExact =
      params?.scope?.root === stable && params?.execution?.workspaceRoot === execution;
    const taskStable = task?.repo?.root === stable;
    const noWrapper = !runArtifactContains(outcome.runDir, Buffer.from("sandbox-exec"));
    const valid =
      outcome.status === "succeeded" &&
      detail?.summary?.requestedAccess === row.access &&
      detail?.summary?.effectiveAccess === row.access &&
      detail?.runFacts?.outcome?.checks === "passed" &&
      stableUntouched &&
      executionMutated &&
      gateGreen &&
      rootPairExact &&
      taskStable &&
      absenceExact &&
      noWrapper &&
      namedProfileExact &&
      nativeRoute &&
      profileState.valid &&
      typeof route?.requestedModel === "string" &&
      route?.verified === true &&
      typeof route?.observedModel === "string" &&
      (!row.browser || (browserReceipt?.effective === true && browserEvidence?.proven === true));
    (valid ? pass : fail)(phase, row.name, {
      runId: outcome.runId ?? null,
      status: outcome.status,
      access: {
        requested: detail?.summary?.requestedAccess ?? null,
        effective: detail?.summary?.effectiveAccess ?? null,
      },
      model: {
        selected: model.id,
        selection: model.source,
        requested: route?.requestedModel ?? null,
        observed: route?.observedModel ?? null,
        verified: route?.verified ?? false,
      },
      profile: {
        requested: row.profileId ?? null,
        observed: auth?.profileId ?? null,
        nativeRoute,
        nativeState: profileState,
      },
      roots: { stable, execution, rootPairExact, taskStable },
      mutation: { stableUntouched, executionMutated, gateGreen },
      browser: page
        ? {
            receipt: browserReceipt ?? null,
            page: { url: page.url, requests: page.requests },
            evidence: browserEvidence,
          }
        : null,
      boundaryEvidence,
      noSandboxExec: noWrapper,
      fullResidual:
        row.access === "full"
          ? "Out-of-root host effects are possible and are not captured or rolled back by this run."
          : null,
      projectionError: projected.error ?? null,
      error: outcome.error ?? null,
    });
  } catch (error) {
    fail(phase, row.name, {
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    });
  } finally {
    await page?.close();
    if (trustGranted) {
      const revoke = runCliJson(["trust", "--revoke-full-access"], {
        cwd: stable,
        name: `${phase}-${row.id}-trust-revoke`,
        envRetry: false,
      });
      (revoke.code === 0 ? pass : fail)(phase, `${row.name} trust revoked`, {
        exit: revoke.code,
        log: rel(revoke.log),
      });
    }
  }
}

/** A digest of every file under `dir`, so a readonly row can prove it changed nothing there. */
function treeDigest(dir) {
  const hash = createHash("sha256");
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else hash.update(relative(dir, path)).update("\0").update(readFileSync(path));
    }
  };
  walk(dir);
  return hash.digest("hex");
}

async function runNativeReadonlyCapabilityRow(phase, row) {
  const stable = makeMathRepo(`${phase}-${row.id}-stable`, { addBug: true });
  const stableTree = runGit(["rev-parse", "HEAD^{tree}"], stable);
  const outside = join(batteryRoot, "outside", cleanName(`${phase}-${row.id}`));
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(join(outside, "listing"), { recursive: true });
  const fixture = readonlyCapabilityFixture();
  writeFileSync(join(outside, "secret.txt"), `The secret word is ${fixture.word}.\n`);
  for (const name of fixture.listing) writeFileSync(join(outside, "listing", name), `${name}\n`);
  const outsideBefore = treeDigest(outside);
  const model = selectBatteryModel(row.harness);
  try {
    const { ensureDaemon, enqueueAndAwait } = await import("../packages/cli/dist/daemon-run.js");
    const { client, addr } = await ensureDaemon();
    const outcome = await enqueueAndAwait(
      client,
      addr,
      readonlyCapabilityRequest({
        row,
        prompt: readonlyCapabilityPrompt({
          secretPath: join(outside, "secret.txt"),
          listingDir: join(outside, "listing"),
        }),
        projectRoot: stable,
        modelId: model.id,
        maxUsd,
      }),
      { waitForTerminal: true },
    );
    const projected = outcome.runId
      ? await controlRunDetail(outcome.runId)
      : { detail: null, error: "run id missing" };
    const detail = projected.detail;
    const answer = detail?.primaryOutput?.text ?? "";
    const { wordFound, filesMatch, firstMatch } = evaluateReadonlyCapabilityAnswer(answer, fixture);
    const stableUntouched =
      runGit(["rev-parse", "HEAD^{tree}"], stable) === stableTree &&
      run("git", ["status", "--porcelain"], { cwd: stable }).stdout.trim() === "";
    const outsideUntouched = treeDigest(outside) === outsideBefore;
    const valid =
      outcome.status === "succeeded" &&
      detail?.summary?.requestedAccess === "readonly" &&
      detail?.summary?.effectiveAccess === "readonly" &&
      wordFound &&
      filesMatch &&
      firstMatch &&
      stableUntouched &&
      outsideUntouched;
    (valid ? pass : fail)(phase, row.name, {
      runId: outcome.runId ?? null,
      status: outcome.status,
      access: {
        requested: detail?.summary?.requestedAccess ?? null,
        effective: detail?.summary?.effectiveAccess ?? null,
      },
      profile: { requested: row.profileId ?? null },
      model: model.id ?? null,
      reads: { wordFound, filesMatch, firstMatch, fileCount: fixture.fileCount },
      mutation: { stableUntouched, outsideUntouched },
      answer: answer.slice(0, 200),
      projectionError: projected.error ?? null,
      error: outcome.error ?? null,
    });
  } catch (error) {
    fail(phase, row.name, {
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    });
  }
}

async function runNativeAccessRefusalRow(phase, row, wantedCode) {
  const stable = makeMathRepo(`${phase}-${row.id}-stable`, { addBug: true });
  const execution = makeExecutionClone(stable, `${phase}-${row.id}`);
  const beforeJobs = new Set((await allDaemonJobs()).map((job) => job.id));
  let problem = null;
  let outcome = null;
  try {
    const { ensureDaemon, enqueueAndAwait } = await import("../packages/cli/dist/daemon-run.js");
    const { client, addr } = await ensureDaemon();
    outcome = await enqueueAndAwait(
      client,
      addr,
      withBatteryReviewerModels({
        prompt: "Fix add() in src/math.js so node --test passes.",
        mode: "agent",
        scope: { kind: "project", root: stable },
        execution: { isolation: "live", delegated: true, workspaceRoot: execution },
        harnesses: [row.harness],
        primaryHarness: row.harness,
        access: "workspace_write",
        ...(row.profileId ? { credentialProfileId: row.profileId } : {}),
        ...(row.browser ? { browser: true, web: "auto" } : { web: "off" }),
        effort: "low",
        paidBudget: { kind: "finite", maxUsd: Number(maxUsd) },
        maxSeconds: 5 * 60,
        tests: [{ program: "node", args: ["--test"] }],
      }),
      { waitForTerminal: true },
    );
    problem = { code: outcome.errorCode, message: outcome.error };
  } catch (error) {
    problem = {
      code: error && typeof error === "object" ? error.code : null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const afterJobs = await allDaemonJobs();
  const newJobs = afterJobs.filter((job) => !beforeJobs.has(job.id));
  const spawned = newJobs.some((job) => {
    if (!job.runDir || !existsSync(join(job.runDir, "events.jsonl"))) return false;
    return readFileSync(join(job.runDir, "events.jsonl"), "utf8").includes('"harness.started"');
  });
  const executionUnchanged =
    run("git", ["status", "--porcelain"], { cwd: execution }).stdout.trim() === "";
  const valid = problem?.code === wantedCode && !spawned && executionUnchanged;
  (valid ? pass : fail)(phase, row.name, {
    wantedCode,
    problem,
    newJobs: newJobs.map((job) => ({ id: job.id, runId: job.runId ?? null, state: job.state })),
    harnessStarted: spawned,
    executionUnchanged,
    runId: outcome?.runId ?? null,
  });
}

/** OpenCode scoped-write incompatibility is adapter-static and must remain
 * provable when no optional OpenCode binary/auth route exists. Exercise the
 * public adapter in a fresh process whose configured binary is a trap: the
 * exact typed error must arrive before an event and the trap must stay untouched. */
async function runOpenCodeOfflineAccessRefusalRow(phase) {
  const name = "OpenCode workspace_write typed pre-spawn refusal";
  const stable = makeMathRepo(`${phase}-opencode-workspace-refusal-stable`, { addBug: true });
  const execution = makeExecutionClone(stable, `${phase}-opencode-workspace-refusal`);
  const trapBin = join(logsDir, `${phase}-opencode-spawn-trap.sh`);
  const trapMarker = join(logsDir, `${phase}-opencode-spawned`);
  rmSync(trapBin, { force: true });
  rmSync(trapMarker, { force: true });
  writeFileSync(trapBin, '#!/bin/sh\n: > "$CLAUDEXOR_OPENCODE_TRAP_MARKER"\nexit 91\n', {
    mode: 0o700,
  });

  const spec = {
    session_id: `${phase}-opencode-offline`,
    task_id: `${phase}-opencode-offline`,
    attempt_id: `${phase}-opencode-offline`,
    cwd: execution,
    prompt: "This process must refuse before the configured binary starts.",
    instructions: "",
    intent: "implement",
    access: "workspace_write",
    env: { CLAUDEXOR_OPENCODE_TRAP_MARKER: trapMarker },
  };
  const adapterUrl = pathToFileURL(
    join(root, "packages", "harness-opencode", "dist", "index.js"),
  ).href;
  const helperUrl = pathToFileURL(
    join(root, "scripts", "lib", "real-harness-battery-state.mjs"),
  ).href;
  const probeSource = [
    `import { createOpenCodeAdapter } from ${JSON.stringify(adapterUrl)};`,
    `import { probeHarnessAccessRefusal } from ${JSON.stringify(helperUrl)};`,
    `const result = await probeHarnessAccessRefusal({ adapter: createOpenCodeAdapter(), spec: ${JSON.stringify(spec)}, wantedCode: "access_profile_incompatible" });`,
    "process.stdout.write(JSON.stringify(result));",
    "if (!result.valid) process.exitCode = 2;",
  ].join("\n");
  const probe = spawnSync(nodeBin, ["--input-type=module", "-e", probeSource], {
    cwd: root,
    env: {
      ...env,
      CLAUDEXOR_OPENCODE_BIN: trapBin,
      CLAUDEXOR_OPENCODE_TRAP_MARKER: trapMarker,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  let result = null;
  try {
    const lastLine = String(probe.stdout ?? "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .at(-1);
    result = lastLine ? JSON.parse(lastLine) : null;
  } catch {
    result = null;
  }
  const trapInvoked = existsSync(trapMarker);
  const stableUnchanged =
    run("git", ["status", "--porcelain"], { cwd: stable }).stdout.trim() === "";
  const executionUnchanged =
    run("git", ["status", "--porcelain"], { cwd: execution }).stdout.trim() === "";
  const valid =
    probe.status === 0 &&
    result?.valid === true &&
    result?.code === "access_profile_incompatible" &&
    result?.eventsEmitted === 0 &&
    !trapInvoked &&
    stableUnchanged &&
    executionUnchanged;
  (valid ? pass : fail)(phase, name, {
    exit: probe.status,
    signal: probe.signal ?? null,
    result,
    trapInvoked,
    stableUnchanged,
    executionUnchanged,
    stderr: redactSecrets(String(probe.stderr ?? "").trim()),
  });
}

/** Positive native access, not containment: every required success mutates
 * only the disposable execution clone, completes a real gate, proves its
 * selected native account/model, and records the deliberate absence of an
 * additional outer OS boundary. */
async function runNativeAccessPhase() {
  const phase = "phase13";
  const profiles = runCliJson(["profiles", "list"], {
    name: `${phase}-profiles`,
    envRetry: false,
  });
  if (profiles.code !== 0 || !profiles.json?.profiles) {
    fail(phase, "credential profile inventory", {
      exit: profiles.code,
      log: rel(profiles.log),
    });
  } else {
    pass(phase, "credential profile inventory", { profiles: profiles.json.profiles.length });
  }
  const entries = profiles.json?.profiles ?? [];
  const named = {
    codex: selectBatteryProfile(entries, "codex", requiredCodexProfileId),
    claude: selectBatteryProfile(entries, "claude", "proton2"),
    cursor: selectBatteryProfile(entries, "cursor", "sol-validator"),
    agy: selectBatteryProfile(entries, "agy", "anton-razzhigaev"),
  };
  const rows = [
    {
      id: "codex-default-ws",
      name: "Codex default native workspace_write",
      harness: "codex",
      access: "workspace_write",
    },
    {
      id: "codex-mironov-codex2-ws",
      name: "Codex mironov_codex2 native workspace_write",
      harness: "codex",
      access: "workspace_write",
      profileId: named.codex?.profile?.profile_id,
      requiresProfile: true,
    },
    {
      id: "claude-default-ws",
      name: "Claude default native workspace_write",
      harness: "claude",
      access: "workspace_write",
    },
    {
      id: "claude-proton2-browser-ws",
      name: "Claude proton2 workspace_write Browser",
      harness: "claude",
      access: "workspace_write",
      profileId: named.claude?.profile?.profile_id,
      requiresProfile: true,
      browser: true,
    },
    {
      id: "cursor-default-ws",
      name: "Cursor default native workspace_write",
      harness: "cursor",
      access: "workspace_write",
    },
    {
      id: "cursor-sol-validator-ws",
      name: "Cursor sol-validator native workspace_write",
      harness: "cursor",
      access: "workspace_write",
      profileId: named.cursor?.profile?.profile_id,
      requiresProfile: true,
    },
    {
      id: "cursor-sol-validator-full",
      name: "Cursor sol-validator trusted full",
      harness: "cursor",
      access: "full",
      profileId: named.cursor?.profile?.profile_id,
      requiresProfile: true,
    },
    {
      id: "agy-named-ws",
      name: "Agy named native workspace_write",
      harness: "agy",
      access: "workspace_write",
      profileId: named.agy?.profile?.profile_id,
      requiresProfile: true,
    },
  ];
  for (const row of rows) {
    if (!requestedHarnesses.includes(row.harness)) {
      skip(phase, row.name, { reason: `${row.harness} not requested` });
      continue;
    }
    const entry = row.requiresProfile ? named[row.harness] : null;
    if (row.requiresProfile && !row.profileId) {
      skip(phase, row.name, { reason: "required named profile is absent or not ready" });
      continue;
    }
    if (
      !nativeBatteryRowReady({
        defaultHarnessReady: harnessAutomaticallyReady(row.harness),
        requiresProfile: row.requiresProfile === true,
        profileEntry: entry,
      })
    ) {
      skip(phase, row.name, {
        reason: row.requiresProfile
          ? "required named profile is not ready"
          : `${row.harness} has no automatic route`,
        readiness: evidence.harnessReadiness[row.harness] ?? null,
      });
      continue;
    }
    await runNativeAccessSuccessRow(phase, row, entry);
  }

  for (const row of readonlyCapabilityRows(named)) {
    if (!requestedHarnesses.includes(row.harness)) {
      skip(phase, row.name, { reason: `${row.harness} not requested` });
      continue;
    }
    if (row.requiresProfile && !row.profileId) {
      skip(phase, row.name, { reason: "required named profile is absent or not ready" });
      continue;
    }
    if (
      !nativeBatteryRowReady({
        defaultHarnessReady: harnessAutomaticallyReady(row.harness),
        requiresProfile: row.requiresProfile === true,
        profileEntry: row.requiresProfile ? named[row.harness] : null,
      })
    ) {
      skip(phase, row.name, {
        reason: row.requiresProfile
          ? "required named profile is not ready"
          : `${row.harness} has no automatic route`,
        readiness: evidence.harnessReadiness[row.harness] ?? null,
      });
      continue;
    }
    await runNativeReadonlyCapabilityRow(phase, row);
  }

  const codexProfileId = named.codex?.profile?.profile_id;
  if (requestedHarnesses.includes("codex") && codexProfileId) {
    await runNativeAccessRefusalRow(
      phase,
      {
        id: "codex-mironov-codex2-browser-ws-refusal",
        name: "Codex workspace_write Browser requires explicit Full",
        harness: "codex",
        profileId: codexProfileId,
        browser: true,
      },
      "browser_unavailable",
    );
    await runNativeAccessSuccessRow(
      phase,
      {
        id: "codex-mironov-codex2-browser-full",
        name: "Codex mironov_codex2 trusted Full Browser",
        harness: "codex",
        access: "full",
        profileId: codexProfileId,
        browser: true,
      },
      named.codex,
    );
  } else {
    skip(phase, "Codex Browser access matrix", {
      reason: "required Codex profile is not ready",
    });
  }

  await runOpenCodeOfflineAccessRefusalRow(phase);
  if (harnessAutomaticallyReady("opencode")) {
    await runNativeAccessSuccessRow(
      phase,
      {
        id: "opencode-full",
        name: "OpenCode conditional trusted Full smoke",
        harness: "opencode",
        access: "full",
      },
      null,
    );
  } else {
    conditional(phase, "OpenCode trusted Full smoke", {
      reason: "OpenCode binary/route unavailable",
      readiness: evidence.harnessReports.opencode ?? null,
    });
  }
}

/** Drive a stdio JSON-RPC server (mcp/acp serve) for one battery phase. */
function stdioServer(args, cwd) {
  const child = spawn(nodeBin, [cli, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += String(c);
  });
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (l) => {
    if (l.trim()) {
      try {
        messages.push(JSON.parse(l));
      } catch {
        /* non-JSON noise is a finding surfaced by timeouts */
      }
    }
  });
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const waitFor = async (pred, timeout) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const hit = messages.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const close = async () => {
    child.stdin.end();
    await new Promise((r) => setTimeout(r, 200));
    child.kill();
  };
  return { send, waitFor, messages, close, stderrText: () => stderr };
}

/** MCP serve smoke against a real automatic-route harness. */
async function runMcpServePhase() {
  const phase = "phase10";
  const [h] = automaticallyAvailable(requestedHarnesses);
  if (!h) {
    skip(phase, "mcp serve smoke", { reason: "no automatic-route harness" });
    return;
  }
  const repo = makeMathRepo(`${phase}-mcp`, { addBug: true });
  const srv = stdioServer(["mcp", "serve"], repo);
  try {
    srv.send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "battery", version: "1.0" },
      },
    });
    const init = await srv.waitFor((m) => m.id === 0, 20_000);
    if (init?.result?.protocolVersion === "2025-06-18")
      pass(phase, "mcp initialize", { serverVersion: init.result?.serverInfo?.version });
    else {
      fail(phase, "mcp initialize", { init, stderr: srv.stderrText().slice(-300) });
      return;
    }
    srv.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    srv.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = await srv.waitFor((m) => m.id === 1, 15_000);
    const names = (tools?.result?.tools ?? []).map((t) => t.name);
    const requiredNames = ["claudexor_ask", "claudexor_best_of"];
    const missingNames = requiredNames.filter((name) => !names.includes(name));
    if (missingNames.length === 0) pass(phase, "mcp tools/list", { count: names.length });
    else {
      fail(phase, "mcp tools/list", { names, missingNames });
      return;
    }
    srv.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "claudexor_ask",
        arguments: {
          prompt: "Answer exactly: 4. What is 2+2?",
          repoPath: repo,
          harness: h,
          ...batteryScalarModel(h),
          effort: "low",
          paidBudget: { kind: "finite", maxUsd: Number(maxUsd) },
        },
      },
    });
    // Host-timeout canary: ping must answer while the ask runs.
    srv.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    const ping = await srv.waitFor((m) => m.id === 3, 15_000);
    if (ping) pass(phase, "mcp ping during call", {});
    else fail(phase, "mcp ping during call", { stderr: srv.stderrText().slice(-300) });
    const startedAt = Date.now();
    const call = await srv.waitFor((m) => m.id === 2, timeoutMs);
    const structured = call?.result?.structuredContent;
    const durableHandle =
      call &&
      !call.result?.isError &&
      typeof structured?.runId === "string" &&
      structured.runId.length > 0 &&
      ["queued", "running", "succeeded"].includes(structured.status);
    let terminal = structured?.status === "succeeded" ? structured : null;
    for (let poll = 0; durableHandle && !terminal && Date.now() - startedAt < timeoutMs; poll++) {
      const id = 100 + poll;
      srv.send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "claudexor_run_result", arguments: { runId: structured.runId } },
      });
      const result = await srv.waitFor((message) => message.id === id, 15_000);
      const candidate = result?.result?.structuredContent;
      if (["succeeded", "failed", "cancelled", "interrupted"].includes(candidate?.status)) {
        terminal = candidate;
        break;
      }
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 500));
    }
    let cleanup = null;
    if (durableHandle && !terminal) {
      srv.send({
        jsonrpc: "2.0",
        id: 9_000,
        method: "tools/call",
        params: { name: "claudexor_run_cancel", arguments: { runId: structured.runId } },
      });
      cleanup = await srv.waitFor((message) => message.id === 9_000, 15_000);
    }
    if (durableHandle && terminal?.status === "succeeded") {
      pass(phase, "mcp ask result", {
        harness: h,
        ms: Date.now() - startedAt,
        runId: structured.runId,
        initialStatus: structured.status,
        terminalStatus: terminal.status,
      });
      // issue #85: the terminal MCP structured receipt must equal the
      // control-detail receipt for the same run, structurally, and be non-null.
      const projected = await controlRunDetail(structured.runId);
      const controlFacts = projected.detail?.runFacts ?? null;
      const mcpFacts = terminal.runFacts ?? null;
      if (mcpFacts !== null && controlFacts !== null && isDeepStrictEqual(mcpFacts, controlFacts))
        pass(phase, "mcp runFacts parity", { harness: h, runId: structured.runId });
      else
        fail(phase, "mcp runFacts parity", {
          runId: structured.runId,
          mcpReceiptPresent: mcpFacts !== null,
          controlReceiptPresent: controlFacts !== null,
          projectionError: projected.error,
        });
    } else {
      const text = String(call?.result?.content?.[0]?.text ?? "");
      fail(phase, "mcp ask result", {
        isError: call?.result?.isError,
        structured,
        terminal,
        cleanup: cleanup?.result?.structuredContent ?? null,
        head: text.slice(0, 200),
        stderr: srv.stderrText().slice(-300),
      });
    }
  } finally {
    await srv.close();
  }
}

/** ACP serve smoke against a real automatic-route harness. */
async function runAcpServePhase() {
  const phase = "phase11";
  const [h] = automaticallyAvailable(requestedHarnesses);
  if (!h) {
    skip(phase, "acp serve smoke", { reason: "no automatic-route harness" });
    return;
  }
  const repo = makeMathRepo(`${phase}-acp`, { addBug: true });
  const srv = stdioServer(["acp", "serve"], repo);
  try {
    srv.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    const init = await srv.waitFor((m) => m.id === 1, 20_000);
    if (init?.result?.protocolVersion === 1 && Array.isArray(init.result?.authMethods))
      pass(phase, "acp initialize", { authMethods: init.result.authMethods.length });
    else {
      fail(phase, "acp initialize", { init });
      return;
    }
    srv.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: repo, mcpServers: [] },
    });
    const sess = await srv.waitFor((m) => m.id === 2, 15_000);
    if (!sess?.result?.sessionId) {
      fail(phase, "acp session/new", { sess });
      return;
    }
    pass(phase, "acp session/new", {});
    srv.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: sess.result.sessionId,
        prompt: [{ type: "text", text: "Answer exactly: 4. What is 2+2?" }],
        _meta: {
          claudexor: {
            mode: "ask",
            harness: h,
            ...batteryScalarModel(h),
            effort: "low",
            paidBudget: { kind: "finite", maxUsd: Number(maxUsd) },
          },
        },
      },
    });
    const done = await srv.waitFor((m) => m.id === 3, timeoutMs);
    const chunk = srv.messages.find(
      (m) =>
        m.method === "session/update" &&
        m.params?.update?.sessionUpdate === "agent_message_chunk" &&
        typeof m.params?.update?.content?.text === "string" &&
        m.params.update.content.text.trim().length > 0,
    );
    const receipt = done?.result?._meta?.claudexor;
    const projected =
      typeof receipt?.runId === "string" && receipt.runId.length > 0
        ? await controlRunDetail(receipt.runId)
        : { detail: null, error: "run id missing" };
    const controlsApplied =
      projected.detail?.summary?.mode === "ask" &&
      JSON.stringify(projected.detail?.summary?.harnesses) === JSON.stringify([h]) &&
      JSON.stringify(projected.detail?.summary?.paidBudget) ===
        JSON.stringify({ kind: "finite", maxUsd: Number(maxUsd) });
    if (
      done?.result?.stopReason === "end_turn" &&
      chunk &&
      typeof receipt?.runId === "string" &&
      receipt.runId.length > 0 &&
      receipt.status === "succeeded" &&
      controlsApplied
    ) {
      pass(phase, "acp prompt round-trip", { harness: h, runId: receipt.runId });
      // issue #85: the ACP terminal _meta receipt must equal the control-detail
      // receipt for the same run, structurally, and be non-null.
      const acpFacts = receipt.runFacts ?? null;
      const controlFacts = projected.detail?.runFacts ?? null;
      if (acpFacts !== null && controlFacts !== null && isDeepStrictEqual(acpFacts, controlFacts))
        pass(phase, "acp runFacts parity", { harness: h, runId: receipt.runId });
      else
        fail(phase, "acp runFacts parity", {
          runId: receipt.runId,
          acpReceiptPresent: acpFacts !== null,
          controlReceiptPresent: controlFacts !== null,
          projectionError: projected.error,
        });
    } else
      fail(phase, "acp prompt round-trip", {
        stopReason: done?.result?.stopReason,
        sawChunk: Boolean(chunk),
        receipt,
        controlsApplied,
        projectionError: projected.error,
        error: done?.error ?? null,
      });
  } finally {
    await srv.close();
  }
}

/** plugin lifecycle in a SCRATCH HOME (never the real one). */
function runPluginLifecyclePhase() {
  const phase = "phase12";
  const scratchHome = join(batteryRoot, "plugin-home");
  mkdirSync(scratchHome, { recursive: true });
  const scratchEnv = { ...env, HOME: scratchHome };
  const runPlugin = (args, name) => {
    const out = spawnSync(nodeBin, [cli, "plugin", ...args, "--json"], {
      env: scratchEnv,
      cwd: batteryRoot,
      encoding: "utf8",
      timeout: 120_000,
    });
    const stdout = out.stdout ?? "";
    let json = null;
    try {
      json = JSON.parse(stdout.slice(stdout.indexOf("{")));
    } catch {
      /* non-JSON output is the failure the caller reports */
    }
    writeFileSync(logPath(`${phase}-${name}`), redactSecrets(stdout + (out.stderr ?? "")));
    return { code: out.status, json };
  };
  const install = runPlugin(["install", "all"], "install");
  if (install.code === 0 && install.json?.ok)
    pass(phase, "plugin install all (scratch HOME)", {
      hosts: (install.json.results ?? []).map((r) => `${r.host}:${r.state}`),
    });
  else {
    fail(phase, "plugin install all (scratch HOME)", { exit: install.code, ok: install.json?.ok });
    return;
  }
  const doctor = runPlugin(["doctor", "all"], "doctor");
  if (doctor.code === 0 && doctor.json?.ok) pass(phase, "plugin doctor all", {});
  else fail(phase, "plugin doctor all", { exit: doctor.code, ok: doctor.json?.ok });
  const uninstall = runPlugin(["uninstall", "all"], "uninstall");
  if (uninstall.code === 0 && uninstall.json?.ok) pass(phase, "plugin uninstall all", {});
  else fail(phase, "plugin uninstall all", { exit: uninstall.code, ok: uninstall.json?.ok });
  const cursorManifest = join(
    scratchHome,
    ".cursor",
    "plugins",
    "local",
    "claudexor",
    ".cursor-plugin",
    "plugin.json",
  );
  if (!existsSync(cursorManifest)) pass(phase, "owned artifacts removed", {});
  else fail(phase, "owned artifacts removed", { survivor: cursorManifest });
}

function phase0(harnessPhasesRequested = true) {
  const phase = "phase0";
  const version = runCliText(["--version"], { name: "version" });
  evidence.version = version.stdout.trim();
  if (version.code === 0 && evidence.version === CLAUDEXOR_VERSION) {
    pass(phase, "cli version", { version: evidence.version });
  } else {
    fail(phase, "cli version", {
      exit: version.code,
      expected: CLAUDEXOR_VERSION,
      observed: evidence.version,
      log: rel(version.log),
    });
  }
  const doctor = runCliJson(["doctor", "--all"], { name: "doctor-all" });
  let doctorHarnesses = [];
  if (doctor.code !== 0 || !doctor.json?.harnesses) {
    fail(phase, "doctor", {
      exit: doctor.code,
      stdout: doctor.stdout,
      stderr: doctor.stderr,
      log: rel(doctor.log),
    });
  } else {
    doctorHarnesses = doctor.json.harnesses;
  }

  const profiles = runCliJson(["profiles", "list"], {
    name: "phase0-profiles",
    envRetry: false,
  });
  let profileEntries = [];
  let accountPools = [];
  if (profiles.code !== 0 || !Array.isArray(profiles.json?.profiles)) {
    fail(phase, "credential profile and pool inventory", {
      exit: profiles.code,
      log: rel(profiles.log),
    });
  } else {
    profileEntries = profiles.json.profiles;
    accountPools = Array.isArray(profiles.json.accountPools) ? profiles.json.accountPools : [];
    pass(phase, "credential profile and pool inventory", {
      profiles: profileEntries.length,
      accountPools: accountPools.length,
    });
  }
  const byId = new Map(doctorHarnesses.map((h) => [h.id, h]));
  for (const status of doctorHarnesses) evidence.harnessReports[status.id] = status;
  const named = {
    codex: selectBatteryProfile(profileEntries, "codex", requiredCodexProfileId),
    claude: selectBatteryProfile(profileEntries, "claude", "proton2"),
    cursor: selectBatteryProfile(profileEntries, "cursor", "sol-validator"),
    agy: selectBatteryProfile(profileEntries, "agy", "anton-razzhigaev"),
  };
  for (const h of requestedHarnesses) {
    const doctorReport = byId.get(h) ?? null;
    const readiness = projectBatteryHarnessReadiness({
      harnessId: h,
      doctorReport,
      accountPools,
      profileEntries,
      requiredProfileEntry: named[h] ?? null,
    });
    evidence.harnessReadiness[h] = readiness;
    if (readiness.automaticRouteReady) evidence.automaticRouteHarnesses.push(h);
    if (readiness.requiredRouteReady) evidence.requiredRouteHarnesses.push(h);
    const detail = {
      automaticRouteReady: readiness.automaticRouteReady,
      requiredRouteReady: readiness.requiredRouteReady,
      automaticSource: readiness.automaticSource,
      requiredSource: readiness.requiredSource,
      doctorStatus: doctorReport?.status ?? "missing",
      poolNextUp: readiness.poolNextUp,
      requiredProfileId: named[h]?.profile?.profile_id ?? null,
      intents: doctorReport?.enabledIntents ?? doctorReport?.enabled_intents ?? [],
    };
    if (readiness.requiredRouteReady) {
      pass(phase, `${h} route readiness`, detail);
    } else if (harnessPhasesRequested) {
      fail(phase, `${h} route readiness`, {
        ...detail,
        reasons: doctorReport?.reasons ?? [],
      });
    } else {
      // Only harness-INDEPENDENT phases were requested (e.g. PHASES=12):
      // a missing real harness is context, not a battery failure.
      skip(phase, `${h} route readiness`, detail);
    }
  }
  evidence.automaticRouteHarnesses = [...new Set(evidence.automaticRouteHarnesses)];
  evidence.requiredRouteHarnesses = [...new Set(evidence.requiredRouteHarnesses)];
  const auth = runCliJson(["auth", "status"], { name: "auth-status" });
  if (auth.code === 0)
    pass(phase, "auth status", { harnesses: (auth.json?.harnesses ?? []).length });
  else fail(phase, "auth status", { exit: auth.code, log: rel(auth.log) });
  if (harnessPhasesRequested) {
    const models = runCliJson(["models", "--harness", requestedHarnesses.join(",")], {
      name: "models",
    });
    if (models.code === 0)
      pass(phase, "models", {
        harnesses: (models.json?.harnesses ?? []).map((h) => `${h.harnessId}:${h.source}`),
      });
    else fail(phase, "models", { exit: models.code, log: rel(models.log) });
  }
  return evidence.requiredRouteHarnesses.length > 0;
}

const repos = {
  readonly: makeMathRepo("readonly", { addBug: true, multiplyBug: true, testMultiply: false }),
  // A writable clone for agent (write) phases, e.g. the delegation phase.
  write: makeMathRepo("write", { addBug: true, multiplyBug: true, testMultiply: false }),
};
const state = { verifiedRuns: [], multiRace: null };

async function main() {
  evidence.candidate.sha = runGit(["rev-parse", "HEAD"], root);
  evidence.candidate.tree = runGit(["rev-parse", "HEAD^{tree}"], root);
  evidence.forcedBuild.candidateSha = evidence.candidate.sha;
  evidence.forcedBuild.candidateTree = evidence.candidate.tree;
  process.stdout.write(
    `Claudexor real-harness battery\nroot=${batteryRoot}\nconfig=${configDir}\nconfigMode=${layout.mode}\ncandidate=${evidence.candidate.sha}\nharnesses=${requestedHarnesses.join(",")}\nmaxUsd=${maxUsd}\n\n`,
  );
  // Phase 12 (plugin lifecycle in a scratch HOME) needs NO real harness —
  // the readiness gate applies only to harness-dependent phases.
  const harnessPhasesRequested =
    phaseFilter.length === 0 || phaseFilter.some((p) => p !== "phase12");
  try {
    if (layout.mode === "existing_default" && phaseFilter.length > 0) {
      throw new Error("an existing-default acceptance run cannot use CLAUDEXOR_BATTERY_PHASES");
    }
    if (
      layout.mode === "existing_default" &&
      ["codex", "claude", "cursor", "agy"].some((harness) => !requestedHarnesses.includes(harness))
    ) {
      throw new Error(
        "existing-default acceptance requires codex, claude, cursor, and agy in CLAUDEXOR_BATTERY_HARNESSES",
      );
    }
    if (
      layout.mode === "existing_default" &&
      runGit(["status", "--porcelain=v1", "--untracked-files=all"], root) !== ""
    ) {
      throw new Error("existing-default acceptance requires a clean exact-candidate checkout");
    }
    await startBatteryDaemon();
    const ready = phase0(harnessPhasesRequested);
    if (!ready && harnessPhasesRequested) {
      fail("phase0", "readiness gate", {
        reason: "no requested harness has an automatic or required named route",
      });
    }
    if (ready) {
      if (phaseEnabled("phase1")) await runReadonlyPhase();
      if (phaseEnabled("phase2")) runWritePhase();
      if (phaseEnabled("phase3")) runMultiWritePhase();
      if (phaseEnabled("phase4")) runLifecyclePhase();
      if (phaseEnabled("phase5")) runCreatePhase();
      if (phaseEnabled("phase6")) runVisionPhase();
      if (phaseEnabled("phase7")) runWebPhase();
      if (phaseEnabled("phase8")) await runPlanPhase();
      if (phaseEnabled("phase9")) await runDelegationPhase();
      if (phaseEnabled("phase13")) await runNativeAccessPhase();
      if (phaseEnabled("phase10")) await runMcpServePhase();
      if (phaseEnabled("phase11")) await runAcpServePhase();
    }
    if (phaseEnabled("phase12")) runPluginLifecyclePhase();
  } catch (error) {
    fail("fatal", "unhandled error", {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  } finally {
    try {
      if (runtimeState.daemonOwned) await verifyNativeSessionRoutes();
    } catch (error) {
      fail("acceptance", "native-route verification completed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await stopBatteryDaemon();
    } catch (error) {
      fail("cleanup", "battery-owned daemon cleanup completed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await verifyProtectedStartupState();
    } catch (error) {
      fail("state", "existing-default startup state verification completed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    evidence,
    counts: {
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      env: results.filter((r) => r.status === "env").length,
      skip: results.filter((r) => r.status === "skip").length,
      conditional: results.filter((r) => r.status === "conditional").length,
    },
    results,
  };
  const jsonPath = join(resultsDir, "real-harness-battery.json");
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + "\n");
  const md = [
    `# Real-Harness Battery ${runId}`,
    "",
    `- root: \`${batteryRoot}\``,
    `- cli: \`${cli}\``,
    `- version: \`${evidence.version ?? "unknown"}\``,
    `- candidate: \`${evidence.candidate.sha ?? "unknown"}\``,
    `- config mode: \`${layout.mode}\``,
    `- requested harnesses: ${requestedHarnesses.join(", ")}`,
    `- automatic-route harnesses: ${evidence.automaticRouteHarnesses.join(", ") || "(none)"}`,
    `- required-route harnesses: ${evidence.requiredRouteHarnesses.join(", ") || "(none)"}`,
    `- counts: PASS=${summary.counts.pass} FAIL=${summary.counts.fail} ENV=${summary.counts.env} SKIP=${summary.counts.skip} CONDITIONAL=${summary.counts.conditional}`,
    "",
    "| status | phase | name | detail |",
    "|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.status} | ${r.phase} | ${r.name} | \`${JSON.stringify(r.detail).replaceAll("|", "\\|").slice(0, 500)}\` |`,
    ),
    "",
  ].join("\n");
  const mdPath = join(resultsDir, "real-harness-battery.md");
  writeFileSync(mdPath, md);
  process.stdout.write(
    `\nRESULT PASS=${summary.counts.pass} FAIL=${summary.counts.fail} ENV=${summary.counts.env} SKIP=${summary.counts.skip} CONDITIONAL=${summary.counts.conditional}\nreport=${jsonPath}\nsummary=${mdPath}\n`,
  );
  const strictFailure =
    layout.mode === "existing_default" &&
    (summary.counts.env > 0 || summary.counts.skip > 0 || evidence.startupState.valid !== true);
  process.exitCode = summary.counts.fail > 0 || strictFailure ? 1 : 0;
}

main().catch((err) => {
  process.stderr.write(
    `${redactSecrets(err instanceof Error ? (err.stack ?? err.message) : String(err))}\n`,
  );
  process.exitCode = 1;
});
