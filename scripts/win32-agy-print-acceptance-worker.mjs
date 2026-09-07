#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EVIDENCE_FILE = ".claudexor-agy-fake-evidence.tsv";
const BROWSER_SENTINEL = ".claudexor-agy-fake-browser-sentinel";
const HANG_MARKER = ".claudexor-agy-fake-hang";
const PROVIDER_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "CLAUDE_API_KEY",
];

const input = parseArgs(process.argv.slice(2));
const repoRoot = resolve(required(input, "repo-root"));
const fixture = resolve(required(input, "fixture"));
const root = resolve(required(input, "root"));
const resultPath = resolve(required(input, "result"));

mkdirSync(root, { recursive: true });
process.env.CLAUDEXOR_CONFIG_DIR = root;
process.env.CLAUDEXOR_AGY_BIN = fixture;
for (const key of PROVIDER_KEYS) process.env[key] = "must-be-scrubbed";

const observedPids = new Set([process.pid]);
let stage = "starting";
let inAppDiagnostics;
let summary = { ok: false, stage, workerPid: process.pid, observedPids: [...observedPids] };
const checkpoint = (next) => {
  stage = next;
  writeFileSync(
    `${resultPath}.tmp`,
    `${JSON.stringify({ ok: false, stage, workerPid: process.pid, observedPids: [...observedPids], inAppDiagnostics })}\n`,
    "utf8",
  );
  renameSync(`${resultPath}.tmp`, resultPath);
};
checkpoint(stage);
try {
  if (process.platform !== "win32") throw new Error("Windows acceptance worker requires win32");
  const importFromRepo = (relative) => import(pathToFileURL(join(repoRoot, relative)).href);
  const [
    core,
    { updateGlobalConfig },
    profile,
    printCommand,
    quota,
    protocol,
    setupAttachCommand,
    setupJobSupport,
  ] = await Promise.all([
    importFromRepo("packages/core/dist/index.js"),
    importFromRepo("packages/config/dist/index.js"),
    importFromRepo("packages/harness-agy/dist/profile.js"),
    importFromRepo("packages/harness-agy/dist/print-command.js"),
    importFromRepo("packages/cli/dist/agy-quota-source.js"),
    importFromRepo("packages/cli/dist/setup-login-protocol.js"),
    importFromRepo("packages/cli/dist/setup-attach-command.js"),
    importFromRepo("packages/cli/dist/setup-job-support.js"),
  ]);
  checkpoint("imports_loaded");

  const homeA = join(root, "profiles", "agy-win-a");
  const homeB = join(root, "profiles", "agy-win-b");
  const controlHome = join(root, "control-home");
  for (const dir of [homeA, homeB, controlHome]) mkdirSync(dir, { recursive: true });

  const profileA = credentialProfile("agy-win-a", "Windows A", homeA, true);
  const profileB = credentialProfile("agy-win-b", "Windows B", homeB, false);
  const configured = updateGlobalConfig((current) => ({
    ...current,
    credential_profiles: [profileA, profileB],
  }));
  assert(configured.path === join(root, "config.yaml"), "config root did not own config.yaml");

  const controlEnv = { ...process.env };
  for (const key of PROVIDER_KEYS) delete controlEnv[key];
  Object.assign(controlEnv, {
    HOME: controlHome,
    USERPROFILE: controlHome,
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  });
  const control = spawnSync(fixture, ["-p", "/model", "--output-format", "json"], {
    cwd: root,
    env: controlEnv,
    shell: false,
    detached: false,
    windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  assert(control.error === undefined, "console control fake failed to spawn");
  if (Number.isSafeInteger(control.pid) && control.pid > 0) observedPids.add(control.pid);
  assert(control.status === 0, `console control fake exited ${String(control.status)}`);
  assert(control.signal === null, "console control fake exited by signal");
  assert(
    existsSync(join(controlHome, BROWSER_SENTINEL)),
    "console control did not enter the interactive/browser branch",
  );
  checkpoint("console_control_complete");

  const route = profile.resolveAgyProfileRoute(profileA);
  assert(!("refusal" in route), "enabled profile route was refused");
  assert(route.home === realpathSync(homeA), "enabled profile route selected the wrong HOME");
  const model = await profile.defaultAgyModelProbe(route.env);
  assert(model.kind === "authenticated", `model probe returned ${model.kind}`);
  assert(model.modelId === "gemini-3.7-flash-high", "model probe parsed the wrong model");
  checkpoint("model_probe_complete");

  const quotaResult = await quota.refreshAgyQuota({ bin: fixture, platform: "win32" });
  assert(quotaResult.snapshots.length === 1, "quota did not select exactly one enabled profile");
  assert(quotaResult.absences.length === 0, "quota returned an unexpected absence");
  checkpoint("quota_probe_complete");

  const hangMarker = join(homeA, HANG_MARKER);
  writeFileSync(hangMarker, "hang\n", "utf8");
  let timeoutResult;
  try {
    timeoutResult = await printCommand.runAgyPrintCommand(fixture, "/model", route.env, {
      timeoutMs: 250,
      cancelDeadlineMs: 3_000,
      drainMs: 100,
    });
  } finally {
    if (existsSync(hangMarker)) unlinkSync(hangMarker);
  }
  assert(timeoutResult.kind === "failed", "hanging print probe unexpectedly completed");
  assert(
    timeoutResult.reason === "termination_unconfirmed",
    `hanging print probe returned ${timeoutResult.reason}`,
  );
  const timeoutPids = parsePidLine(timeoutResult.stdout);
  observedPids.add(timeoutPids.vendor);
  observedPids.add(timeoutPids.descendant);
  await expectPidsGone(timeoutPids, 5_000);
  checkpoint("timeout_cleanup_complete");

  const browserSentinel = join(homeA, BROWSER_SENTINEL);
  const browserSentinelBeforeClientPty = existsSync(browserSentinel);
  assert(!browserSentinelBeforeClientPty, "print probes entered the browser branch");

  const jobDir = join(root, "client-pty-job");
  mkdirSync(jobDir, { recursive: true });
  const args = ["-p", "/model", "--output-format", "json"];
  const executable = protocol.captureExecutableEvidence(fixture);
  const manifestPath = join(jobDir, "runner-manifest.json");
  const manifest = protocol.sealLoginManifest({
    version: protocol.SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: "setup-win32-agy-client-pty",
    executionId: "win32-agy-client-pty-execution-1",
    harness: "agy",
    jobDir,
    binary: fixture,
    args,
    cwd: jobDir,
    profileConfigDir: homeA,
    statePath: join(jobDir, "runner-state.json"),
    resultPath: join(jobDir, "runner-result.json"),
    permitPath: join(jobDir, "runner-permit.json"),
    permitDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
    permitWaitMs: 5_000,
    executable,
    commandDigest: protocol.commandDigest(executable, args),
  });
  protocol.atomicPrivateJson(manifestPath, manifest);
  const runnerPath = setupJobSupport.resolveSetupLoginRunnerPath();
  const invocation = setupAttachCommand.setupAttachRunnerInvocation({
    platform: process.platform,
    nodePath: process.execPath,
    runnerPath,
    manifestPath,
    cwd: jobDir,
    env: process.env,
  });
  const loginRunner = spawn(invocation.command, invocation.args, invocation.options);
  if (!loginRunner.pid) throw new Error("client_pty runner PID was not assigned");
  const loginRunnerPid = loginRunner.pid;
  observedPids.add(loginRunnerPid);
  const loginFinished = waitForChild(loginRunner);
  await Promise.race([
    waitFor(
      () => readJsonIfPresent(manifest.statePath)?.stage === "awaiting_permit",
      3_000,
      "client_pty runner permit state",
    ),
    loginFinished.then(({ code, signal }) => {
      throw new Error(
        `client_pty runner exited before permit (code ${String(code)}; signal ${String(signal)})`,
      );
    }),
  ]);
  protocol.atomicPrivateJson(manifest.permitPath, {
    version: protocol.SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: manifest.jobId,
    executionId: manifest.executionId,
    issuedAt: new Date().toISOString(),
    commandDigest: manifest.commandDigest,
    manifestDigest: manifest.manifestDigest,
  });
  const loginProcess = await loginFinished;
  const loginReceipt = protocol.readRunnerResult(manifest.resultPath);
  assert(
    loginProcess.code === 0,
    `client_pty worker exited ${String(loginProcess.code)}; receipt=${JSON.stringify({
      present: loginReceipt !== null,
      commandStarted: loginReceipt?.commandStarted ?? null,
      exitCode: loginReceipt?.exitCode ?? null,
      signal: loginReceipt?.signal ?? null,
      errorCode: loginReceipt?.errorCode ?? null,
      stage: protocol.readRunnerState(manifest.statePath)?.stage ?? null,
    })}`,
  );
  assert(loginProcess.signal === null, "client_pty worker exited by signal");
  assert(loginReceipt?.commandStarted === true, "client_pty receipt did not start the command");
  assert(loginReceipt?.exitCode === 0, "client_pty receipt did not record exit 0");
  assert(loginReceipt?.signal === null, "client_pty receipt recorded a signal");
  assert(loginReceipt?.errorCode === undefined, "client_pty receipt recorded a transport error");
  const browserSentinelAfterClientPty = existsSync(browserSentinel);
  assert(browserSentinelAfterClientPty, "direct client_pty path did not expose CONIN$");
  checkpoint("client_pty_complete");

  const interactiveArgs = ["--interactive"];
  const expectedHelper = realpathSync(
    join(repoRoot, "packages", "core", "dist", "native", "claudexor-conpty-helper.exe"),
  );

  const inAppJobDir = join(root, "in-app-job");
  mkdirSync(inAppJobDir, { recursive: true });
  const inAppExecutable = protocol.captureExecutableEvidence(fixture);
  const inAppManifestPath = join(inAppJobDir, "runner-manifest.json");
  const inAppManifest = protocol.sealLoginManifest({
    version: protocol.SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: "setup-win32-agy-in-app",
    executionId: "win32-agy-in-app-execution-1",
    harness: "agy",
    jobDir: inAppJobDir,
    binary: fixture,
    args: interactiveArgs,
    cwd: inAppJobDir,
    profileConfigDir: homeA,
    loginMode: "url_disclosure_with_input",
    ptyStdin: true,
    deviceCodePath: join(inAppJobDir, "runner-devicecode.json"),
    inputPath: join(inAppJobDir, "runner-input.json"),
    statePath: join(inAppJobDir, "runner-state.json"),
    resultPath: join(inAppJobDir, "runner-result.json"),
    permitPath: join(inAppJobDir, "runner-permit.json"),
    permitDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
    executable: inAppExecutable,
    commandDigest: protocol.commandDigest(inAppExecutable, interactiveArgs),
  });
  protocol.atomicPrivateJson(inAppManifestPath, inAppManifest);

  const inAppPids = new Set();
  try {
    const inAppRunner = spawn(process.execPath, [runnerPath, inAppManifestPath], {
      cwd: inAppJobDir,
      env: process.env,
      shell: false,
      // Production also launches this outer runner detached. Pipes are the one
      // acceptance-only override: they let the test observe vendor output that
      // the daemon intentionally ignores without replacing the production
      // runner, worker, resolver, or helper; the observable sink differs.
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!inAppRunner.pid) throw new Error("in-app runner PID was not assigned");
    const inAppRunnerPid = inAppRunner.pid;
    inAppDiagnostics = {
      runnerPid: inAppRunnerPid,
      runnerClosed: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      codeEchoObserved: false,
    };
    inAppPids.add(inAppRunnerPid);
    observedPids.add(inAppRunnerPid);
    checkpoint("in_app_runner_started");
    const inAppFinished = collectChild(inAppRunner, (observation) => {
      Object.assign(inAppDiagnostics, observation);
      try {
        checkpoint(stage);
      } catch {
        // Diagnostic I/O must not interrupt child output or lifecycle events.
      }
    });
    let awaitingPermit;
    await Promise.race([
      waitFor(
        () => {
          const state = protocol.readRunnerState(inAppManifest.statePath);
          if (state?.stage !== "awaiting_permit") return false;
          awaitingPermit = state;
          return true;
        },
        10_000,
        "in-app worker permit state",
      ),
      inAppFinished.then(({ code, signal }) => {
        throw new Error(
          `in-app runner exited before permit (code ${String(code)}; signal ${String(signal)})`,
        );
      }),
    ]);
    const inAppWorkerPid = awaitingPermit?.processGroup?.pgid ?? 0;
    inAppDiagnostics.workerPid = inAppWorkerPid;
    assert(inAppWorkerPid > 0, "in-app worker state omitted its exact PID");
    assert(
      awaitingPermit?.processGroup?.leader?.pid === inAppWorkerPid,
      "in-app worker state contradicted its custody leader",
    );
    inAppPids.add(inAppWorkerPid);
    observedPids.add(inAppWorkerPid);
    checkpoint("in_app_awaiting_permit");

    protocol.atomicPrivateJson(inAppManifest.permitPath, {
      version: protocol.SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: inAppManifest.jobId,
      executionId: inAppManifest.executionId,
      issuedAt: new Date().toISOString(),
      commandDigest: inAppManifest.commandDigest,
      manifestDigest: inAppManifest.manifestDigest,
    });

    const expectedVerificationUrl =
      "https://accounts.google.com/o/oauth2/auth?state=claudexor-conpty-fixture";
    let disclosure;
    await Promise.race([
      waitFor(
        () => {
          const candidate = protocol.readRunnerDeviceCode(inAppManifest.deviceCodePath);
          if (
            candidate?.flow !== "oauth_url_input" ||
            candidate.verificationUrl !== expectedVerificationUrl ||
            candidate.userCode !== ""
          ) {
            return false;
          }
          disclosure = candidate;
          return true;
        },
        15_000,
        "in-app OAuth URL disclosure",
      ),
      inAppFinished.then(({ code, signal }) => {
        throw new Error(
          `in-app runner exited before URL disclosure (code ${String(code)}; signal ${String(signal)})`,
        );
      }),
    ]);
    assert(disclosure?.flow === "oauth_url_input", "in-app disclosure used the wrong flow");
    assert(
      disclosure?.verificationUrl === expectedVerificationUrl,
      "in-app disclosure did not reconstruct the fragmented OAuth URL",
    );
    assert(disclosure?.userCode === "", "in-app URL disclosure persisted an unexpected user code");
    checkpoint("in_app_url_disclosed");

    const processSnapshot = readWindowsProcessSnapshot(inAppWorkerPid);
    if (processSnapshot.observerPid > 0) {
      observedPids.add(processSnapshot.observerPid);
    }
    const helperProcess = exactChildProcess(
      processSnapshot.rows,
      inAppWorkerPid,
      expectedHelper,
      "ConPTY helper",
    );
    const vendorProcess = exactChildProcess(
      processSnapshot.rows,
      helperProcess.pid,
      fixture,
      "native vendor",
    );
    const inAppHelperPid = helperProcess.pid;
    const inAppVendorPid = vendorProcess.pid;
    Object.assign(inAppDiagnostics, { helperPid: inAppHelperPid, vendorPid: inAppVendorPid });
    for (const processRow of descendantProcesses(processSnapshot.rows, inAppWorkerPid)) {
      inAppPids.add(processRow.pid);
      observedPids.add(processRow.pid);
    }

    const oneShotInput = "one-shot-win32-code-77";
    protocol.atomicPrivateJson(inAppManifest.inputPath, {
      version: protocol.SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: inAppManifest.jobId,
      executionId: inAppManifest.executionId,
      value: oneShotInput,
      submittedAt: new Date().toISOString(),
    });
    checkpoint("in_app_input_submitted");
    const inAppProcess = await inAppFinished;
    checkpoint("in_app_runner_exited");
    const inAppReceipt = protocol.readRunnerResult(inAppManifest.resultPath);
    assert(inAppProcess.code === 0, `in-app runner exited ${String(inAppProcess.code)}`);
    assert(inAppProcess.signal === null, "in-app runner exited by signal");
    assert(inAppReceipt?.commandStarted === true, "in-app receipt did not validate helper start");
    assert(inAppReceipt?.exitCode === 0, "in-app receipt did not preserve native exit 0");
    assert(inAppReceipt?.signal === null, "in-app receipt recorded a signal");
    assert(inAppReceipt?.errorCode === undefined, "in-app receipt recorded a transport error");
    assert(inAppReceipt?.outputTail === undefined, "successful in-app receipt retained output");

    // The production runner intentionally treats stdout as an ignored sink;
    // this acceptance-only outer pipe proves URL capture and receipt custody,
    // not scheduler-dependent propagation of the final inherited write.
    assert(
      inAppProcess.stderr === "",
      "helper control frames or diagnostics escaped the production parser",
    );
    const durableReceipt = readFileSync(inAppManifest.resultPath, "utf8");
    assert(!durableReceipt.includes(oneShotInput), "in-app receipt persisted one-shot input");
    assert(!durableReceipt.includes("accounts.google.com"), "in-app receipt persisted OAuth URL");
    const consumedInput = readJsonIfPresent(inAppManifest.inputPath);
    assert(consumedInput?.consumed === true, "in-app input sidecar was not consumed");
    assert(
      !Object.hasOwn(consumedInput ?? {}, "value"),
      "consumed input sidecar retained the secret",
    );

    await expectExactPidsGone([...inAppPids], 5_000, "in-app ConPTY tree cleanup");

    summary.inAppLogin = {
      exit: inAppProcess.code,
      signal: inAppProcess.signal,
      runnerPid: inAppRunnerPid,
      workerPid: inAppWorkerPid,
      helperPid: inAppHelperPid,
      vendorPid: inAppVendorPid,
      helperPath: expectedHelper,
      receipt: inAppReceipt,
      disclosureFlow: disclosure.flow,
    };
  } finally {
    const finalState = protocol.readRunnerState(inAppManifest.statePath);
    const finalWorkerPid = finalState?.processGroup?.pgid ?? 0;
    if (finalWorkerPid > 0) {
      inAppPids.add(finalWorkerPid);
      observedPids.add(finalWorkerPid);
    }
    for (const pid of [...inAppPids]) {
      if (pid > 0 && pidAlive(pid)) core.killWindowsProcessTree(pid);
    }
    unlinkIfPresent(inAppManifest.deviceCodePath);
    unlinkIfPresent(inAppManifest.inputPath);
  }
  checkpoint("in_app_cleanup_complete");

  const controlEvidence = readEvidence(controlHome);
  const profileEvidence = readEvidence(homeA);
  for (const row of [...controlEvidence, ...profileEvidence]) observedPids.add(row.pid);
  assert(
    controlEvidence.some((row) => row.mode === "interactive"),
    "control evidence is absent",
  );
  assert(
    profileEvidence.some((row) => row.mode === "interactive"),
    "client_pty evidence is absent",
  );
  assert(!existsSync(join(homeB, EVIDENCE_FILE)), "disabled profile B was probed");

  summary = {
    ok: true,
    stage: "complete",
    workerPid: process.pid,
    observedPids: [...observedPids],
    paths: {
      config: configured.path,
      homeA,
      homeB,
      controlHome,
      evidenceA: join(homeA, EVIDENCE_FILE),
      evidenceB: join(homeB, EVIDENCE_FILE),
      controlEvidence: join(controlHome, EVIDENCE_FILE),
      browserSentinel,
    },
    control: {
      status: control.status,
      stdout: control.stdout,
      evidence: controlEvidence,
    },
    model,
    quota: quotaResult,
    timeout: { result: timeoutResult, pids: timeoutPids },
    browserSentinelBeforeClientPty,
    browserSentinelAfterClientPty,
    login: {
      exit: loginProcess.code,
      signal: loginProcess.signal,
      runnerPid: loginRunnerPid,
      receipt: loginReceipt,
    },
    inAppLogin: summary.inAppLogin,
    evidence: profileEvidence,
  };
} catch (error) {
  summary = {
    ok: false,
    stage,
    workerPid: process.pid,
    observedPids: [...observedPids],
    error: error instanceof Error ? error.message : String(error),
    inAppDiagnostics,
  };
  process.exitCode = 1;
} finally {
  writeFileSync(resultPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function credentialProfile(profileId, displayName, isolationLocator, enabled) {
  return {
    profile_id: profileId,
    harness_id: "agy",
    display_name: displayName,
    credential_kind: "config_dir_login",
    isolation_locator: isolationLocator,
    secret_ref: null,
    enabled,
    created_at: null,
  };
}

function parseArgs(args) {
  const parsed = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: win32-agy-print-acceptance-worker --repo-root DIR --fixture EXE --root DIR --result FILE",
      );
    }
    parsed.set(name.slice(2), value);
  }
  return parsed;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJsonIfPresent(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function unlinkIfPresent(path) {
  if (existsSync(path)) unlinkSync(path);
}

function readEvidence(home) {
  const path = join(home, EVIDENCE_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      if (fields.length !== 11 || fields[0] !== "FAKE") {
        throw new Error("fake agy wrote malformed evidence");
      }
      return {
        mode: fields[1],
        command: fields[2],
        pid: Number(fields[3]),
        consoleCodePage: Number(fields[4]),
        windowPresent: fields[5] === "1",
        coninAvailable: fields[6] === "1",
        stdinEof: fields[7] === "1",
        homeMatchesUserProfile: fields[8] === "1",
        autoUpdateDisabled: fields[9] === "1",
        providerKeysAbsent: fields[10] === "1",
      };
    });
}

function parsePidLine(output) {
  const match = /PIDS\|([1-9][0-9]*)\|([1-9][0-9]*)\|END/.exec(output);
  if (!match) throw new Error("hanging fake agy did not disclose exact PIDs");
  return { vendor: Number(match[1]), descendant: Number(match[2]) };
}

async function expectPidsGone(pids, timeoutMs) {
  await waitFor(
    () => !pidAlive(pids.vendor) && !pidAlive(pids.descendant),
    timeoutMs,
    "fake agy timeout tree cleanup",
  );
}

async function expectExactPidsGone(pids, timeoutMs, label) {
  const unique = [...new Set(pids.filter((pid) => pid > 0))];
  await waitFor(() => unique.every((pid) => !pidAlive(pid)), timeoutMs, label);
}

function readWindowsProcessSnapshot(rootPid) {
  assert(Number.isSafeInteger(rootPid) && rootPid > 0, "process snapshot root PID was invalid");
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$parents = @(${rootPid})`,
    "$rows = @()",
    "for ($depth = 0; $depth -lt 2; $depth += 1) {",
    "  $next = @()",
    "  foreach ($parent in $parents) {",
    '    $children = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId = {0}" -f $parent))',
    "    $rows += @($children | ForEach-Object {",
    "  [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; executablePath = [string]$_.ExecutablePath }",
    "    })",
    "    $next += @($children | ForEach-Object { [int]$_.ProcessId })",
    "  }",
    "  $parents = $next",
    "}",
    "[Console]::Out.Write((ConvertTo-Json -InputObject $rows -Compress))",
  ].join("; ");
  const result = spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", script],
    {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert(result.error === undefined, "Win32 process snapshot failed to spawn");
  assert(result.status === 0, "Win32 process snapshot failed");
  assert(result.signal === null, "Win32 process snapshot exited by signal");
  const parsed = JSON.parse(result.stdout);
  const rows = (Array.isArray(parsed) ? parsed : [parsed])
    .map((row) => ({
      pid: Number(row.pid),
      ppid: Number(row.ppid),
      executablePath: typeof row.executablePath === "string" ? row.executablePath : "",
    }))
    .filter((row) => row.pid > 0); // Win32_Process includes the idle pseudo-process at PID 0.
  assert(
    rows.every(
      (row) =>
        Number.isSafeInteger(row.pid) &&
        row.pid > 0 &&
        Number.isSafeInteger(row.ppid) &&
        row.ppid >= 0,
    ),
    "Win32 process snapshot was malformed",
  );
  return { rows, observerPid: Number.isSafeInteger(result.pid) ? result.pid : 0 };
}

function exactChildProcess(rows, parentPid, expectedPath, label) {
  const matches = rows.filter(
    (row) => row.ppid === parentPid && sameWindowsPath(row.executablePath, expectedPath),
  );
  assert(matches.length === 1, `${label} process chain was not exact`);
  return matches[0];
}

function descendantProcesses(rows, rootPid) {
  const found = [];
  const parents = new Set([rootPid]);
  for (;;) {
    const generation = rows.filter((row) => parents.has(row.ppid) && !parents.has(row.pid));
    if (generation.length === 0) return found;
    parents.clear();
    for (const row of generation) {
      found.push(row);
      parents.add(row.pid);
    }
  }
}

function sameWindowsPath(actual, expected) {
  return resolve(actual).toLowerCase() === resolve(expected).toLowerCase();
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} timed out`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function waitForChild(child) {
  return new Promise((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("close", (code, signal) => resolveChild({ code, signal }));
  });
}

function collectChild(child, observe) {
  if (!child.stdout || !child.stderr) throw new Error("child output pipes were not created");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    observe({ stdoutBytes: Buffer.byteLength(stdout), codeEchoObserved: stdout.includes("CODE:") });
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    observe({ stderrBytes: Buffer.byteLength(stderr) });
  });
  return new Promise((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("exit", (code, signal) => observe({ runnerExit: { code, signal } }));
    child.once("close", (code, signal) => {
      observe({ runnerClosed: true });
      resolveChild({ code, signal, stdout, stderr });
    });
  });
}
