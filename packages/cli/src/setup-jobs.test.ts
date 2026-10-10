import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  AuthCapabilityVerifier,
  bindCredentialMutationWindow,
  credentialMutationWindowOpen,
  ProcessGroupService,
  type HarnessAdapter,
  type KnownProcessIdentity,
  type ProcessIdentity,
  type ProcessIdentityReader,
} from "@claudexor/core";
import type {
  AuthSourceKind,
  AuthSourceReadiness,
  CredentialRoute,
  HarnessRunSpec,
  SetupNativeCommandErrorCode,
} from "@claudexor/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@claudexor/config";
import { defaultNativeClaudeConfigDir } from "@claudexor/harness-claude";
import { defaultNativeCodexHome } from "@claudexor/harness-codex";
import { noProjectRepoRoot } from "@claudexor/util";
import {
  atomicPrivateJson,
  readLoginManifest,
  readRunnerPermit,
  readRunnerResult,
  SETUP_LOGIN_PROTOCOL_VERSION,
} from "./setup-login-protocol.js";
import { registerConfigDirProfile } from "./profile-registration.js";
import {
  resolveLoginProfileBinding,
  resolveProfileBinding,
  resolveSetupLoginRunnerPath,
} from "./setup-job-support.js";
import { createSetupJobManager } from "./setup-jobs.js";
import { SetupJobStore } from "../../daemon/src/store/test-support/fixtures/legacy/cli/setup-job-store.js";
import { type SetupJobStorePort } from "./setup-job-projection.js";

/** These shutdown tests inspect the actual legacy backing file, not a store port. */
function legacyJournal(store: SetupJobStorePort) {
  if (!(store instanceof SetupJobStore)) throw new Error("fixture must own the legacy store");
  return store.journal;
}
import * as CredentialWindow from "./setup-credential-window.js";
import { SetupLifecycleBinding } from "./setup-lifecycle-binding.js";
import { DaemonRuntimeShutdown } from "./daemon-runtime-shutdown.js";

let root: string;
let codexBinary: string;
let oldCodexBin: string | undefined;
let oldConfigDir: string | undefined;

// The shared setup state machine is exercised over the Terminal (browser_redirect)
// flow; the D-17 device-code launch has its own focused suite below. Default
// codex (loginFlow absent) now takes the app-server device-code path.
const LOGIN_REQUEST = {
  harness: "codex",
  action: "login",
  authRequest: "subscription",
  loginFlow: "browser_redirect",
} as const;
const DEVICE_CODE_REQUEST = {
  harness: "codex",
  action: "login",
  authRequest: "subscription",
} as const;

function fakeOpener(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.unref = () => child;
  return child;
}

function nativeReadiness(ready: boolean): AuthSourceReadiness {
  return ready
    ? { source: "native_session", availability: "available", verification: "passed" }
    : { source: "native_session", availability: "unavailable", verification: "not_run" };
}

function capabilityVerifier(
  now: () => Date = () => new Date(),
  options: {
    route?: CredentialRoute | null;
    source?: AuthSourceKind | null;
    response?: string;
    hang?: boolean;
    gate?: Promise<void>;
  } = {},
): { verifier: AuthCapabilityVerifier; runs: HarnessRunSpec[]; lookups: string[] } {
  const runs: HarnessRunSpec[] = [];
  const lookups: string[] = [];
  const route = options.route === undefined ? "vendor_native" : options.route;
  const source = options.source === undefined ? "native_session" : options.source;
  const adapter: HarnessAdapter = {
    id: "codex",
    async discover() {
      throw new Error("capability setup smoke must not discover twice");
    },
    async doctor() {
      throw new Error("capability setup smoke must not run a second doctor");
    },
    async *run(spec) {
      runs.push(spec);
      if (options.hang) await new Promise<never>(() => {});
      if (options.gate) await options.gate;
      const expected = /^Return exactly (\S+) and no other text\./.exec(spec.prompt)?.[1];
      if (!expected) throw new Error("invalid capability challenge prompt");
      yield {
        type: "started",
        session_id: spec.session_id,
        ts: now().toISOString(),
        ...(route ? { credential_route: route } : {}),
        ...(source ? { credential_source: source } : {}),
      };
      yield {
        type: "message",
        session_id: spec.session_id,
        ts: now().toISOString(),
        text: options.response ?? expected,
      };
      yield { type: "completed", session_id: spec.session_id, ts: now().toISOString() };
    },
  };
  return {
    verifier: new AuthCapabilityVerifier(
      (id) => {
        lookups.push(id);
        return id === adapter.id ? adapter : undefined;
      },
      { now, scratchRoot: join(root, "auth-capability-smokes") },
    ),
    runs,
    lookups,
  };
}

type SetupManager = ReturnType<typeof createSetupJobManager>;

function knownLeader(pid = 41, startToken = "darwin:1710000000:000001"): KnownProcessIdentity {
  return {
    status: "known",
    pid,
    platform: "darwin",
    source: "proc_pidinfo",
    startToken,
    processGroupId: pid,
  };
}

function processGroupFixture(
  input: {
    leader?: KnownProcessIdentity;
    killOnTerm?: boolean;
    onSignal?: (signal: NodeJS.Signals) => void;
  } = {},
) {
  const leader = input.leader ?? knownLeader();
  let observed: ProcessIdentity = leader;
  let groupAlive = true;
  const signals: NodeJS.Signals[] = [];
  const identity: ProcessIdentityReader = {
    read: () => observed,
    self: () => observed,
  };
  const service = new ProcessGroupService({
    platform: "darwin",
    identity,
    probeProcessGroup: () => {
      if (!groupAlive) throw Object.assign(new Error("no such process group"), { code: "ESRCH" });
    },
    signalProcessGroup: (_negativePgid, signal) => {
      signals.push(signal);
      input.onSignal?.(signal);
      if (signal === "SIGKILL" || (signal === "SIGTERM" && input.killOnTerm)) groupAlive = false;
    },
  });
  return {
    leader,
    service,
    signals,
    setObserved(next: ProcessIdentity) {
      observed = next;
    },
    setAlive(next: boolean) {
      groupAlive = next;
    },
  };
}

function writeRunnerStateV2(
  manager: SetupManager,
  jobId: string,
  leader: KnownProcessIdentity,
  stage: "awaiting_permit" | "running" = "awaiting_permit",
  observedAt = new Date().toISOString(),
) {
  const manifest = readLoginManifest(manager._store.paths(jobId).manifest);
  atomicPrivateJson(manager._store.paths(jobId).runnerState, {
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId,
    executionId: manifest.executionId,
    processGroup: { schemaVersion: 1, pgid: leader.pid, leader },
    stage,
    observedAt,
    commandDigest: manifest.commandDigest,
    manifestDigest: manifest.manifestDigest,
  });
  return manifest;
}

function writeRunnerResultV2(
  manager: SetupManager,
  jobId: string,
  input: {
    commandStarted?: boolean;
    exitCode?: number | null;
    signal?: string | null;
    errorCode?: SetupNativeCommandErrorCode;
    permitIssuedAt?: string | null;
    executionId?: string;
  } = {},
): void {
  const manifest = readLoginManifest(manager._store.paths(jobId).manifest);
  const job = manager.status({ jobId });
  const commandStarted = input.commandStarted ?? true;
  atomicPrivateJson(manager._store.paths(jobId).runnerResult, {
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId,
    executionId: input.executionId ?? manifest.executionId,
    commandDigest: manifest.commandDigest,
    manifestDigest: manifest.manifestDigest,
    permitIssuedAt:
      input.permitIssuedAt === undefined
        ? commandStarted
          ? (job.execution?.permitIssuedAt ?? null)
          : null
        : input.permitIssuedAt,
    commandStarted,
    exitCode: input.exitCode === undefined ? 0 : input.exitCode,
    signal: input.signal === undefined ? null : input.signal,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    finishedAt: new Date().toISOString(),
  });
  if (!readRunnerResult(manager._store.paths(jobId).runnerResult)) {
    throw new Error("test wrote an invalid v2 runner result");
  }
}

async function permitAndFinishNativeCommand(
  manager: SetupManager,
  jobId: string,
  leader: KnownProcessIdentity,
  observedAt = new Date().toISOString(),
): Promise<void> {
  writeRunnerStateV2(manager, jobId, leader, "awaiting_permit", observedAt);
  await waitForPhase(manager, jobId, "awaiting_user");
  writeRunnerStateV2(manager, jobId, leader, "running", observedAt);
  writeRunnerResultV2(manager, jobId);
}

async function waitForTerminal(
  manager: ReturnType<typeof createSetupJobManager>,
  jobId: string,
): Promise<string> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const job = manager.status({ jobId });
    if (
      [
        "succeeded",
        "failed",
        "cancelled",
        "timed_out",
        "interrupted_unknown",
        "not_supported",
      ].includes(job.state)
    )
      return job.state;
    if (Date.now() > deadline) {
      const supervisor = manager._supervisorHealth().failure;
      throw new Error(
        `job stuck in ${job.state}/${job.phase}${supervisor ? `; supervisor: ${supervisor.message}` : ""}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForPhase(
  manager: ReturnType<typeof createSetupJobManager>,
  jobId: string,
  phase: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (manager.status({ jobId }).phase !== phase) {
    if (Date.now() > deadline) {
      const supervisor = manager._supervisorHealth().failure;
      throw new Error(
        `job never reached phase ${phase}${supervisor ? `; supervisor: ${supervisor.message}` : ""}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function waitForAuthState(
  manager: ReturnType<typeof createSetupJobManager>,
  jobId: string,
  state: "disclosed" | "running" | "completed" | "interrupted_unknown",
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (manager.status({ jobId }).authCapability?.state !== state) {
    if (Date.now() > deadline) throw new Error(`job never reached auth capability state ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor setup tests ")));
  codexBinary = join(root, "fake-codex");
  writeFileSync(codexBinary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(codexBinary, 0o700);
  oldCodexBin = process.env.CLAUDEXOR_CODEX_BIN;
  oldConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CODEX_BIN = codexBinary;
});

afterEach(() => {
  if (oldCodexBin === undefined) delete process.env.CLAUDEXOR_CODEX_BIN;
  else process.env.CLAUDEXOR_CODEX_BIN = oldCodexBin;
  if (oldConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = oldConfigDir;
  rmSync(root, { recursive: true, force: true });
});

describe("setup jobs", () => {
  it("prefers an adjacent CommonJS app bundle and falls back to published ESM output", () => {
    const moduleUrl = "file:///tmp/Claudexor.app/Contents/Resources/claudexord.bundle.cjs";
    expect(resolveSetupLoginRunnerPath(moduleUrl, (path) => path.endsWith(".cjs"))).toBe(
      "/tmp/Claudexor.app/Contents/Resources/setup-login-runner.cjs",
    );
    expect(resolveSetupLoginRunnerPath(moduleUrl, () => false)).toBe(
      "/tmp/Claudexor.app/Contents/Resources/setup-login-runner.js",
    );
  });

  it("returns the existing active login and opens only one Terminal", () => {
    let opened = 0;
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "store")),
      rootDir: join(root, "store"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: () => {
        opened += 1;
        return fakeOpener();
      },
    });
    const first = manager.create(LOGIN_REQUEST);
    const duplicate = manager.create(LOGIN_REQUEST);
    expect(duplicate.jobId).toBe(first.jobId);
    expect(opened).toBe(1);
  });

  it("does not let an immutable legacy login suppress a new v2 login", () => {
    const storeRoot = join(root, "store");
    mkdirSync(storeRoot, { recursive: true });
    writeFileSync(
      join(storeRoot, "jobs.json"),
      JSON.stringify([
        {
          jobId: "setup-legacy",
          harness: "codex",
          action: "login",
          state: "waiting_for_input",
          command: "codex login (isolated Claudexor profile)",
          guideUrl: null,
          logPath: null,
          message: "legacy",
          riskFlags: [],
          requiresConfirmation: false,
          createdAt: new Date().toISOString(),
          startedAt: null,
          firstOutputAt: null,
          lastOutputAt: null,
          finishedAt: null,
          retryCount: 0,
        },
      ]),
    );
    let opened = 0;
    const manager = createSetupJobManager({
      store: new SetupJobStore(storeRoot),
      rootDir: storeRoot,
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: () => {
        opened += 1;
        return fakeOpener();
      },
    });
    const created = manager.create(LOGIN_REQUEST);
    expect(created.jobId).not.toBe("setup-legacy");
    expect(opened).toBe(1);
  });

  it("terminalizes synchronous opener throws and asynchronous opener failures", () => {
    const throwing = createSetupJobManager({
      store: new SetupJobStore(join(root, "throwing")),
      rootDir: join(root, "throwing"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: () => {
        throw new Error("LaunchServices unavailable");
      },
    });
    expect(throwing.create(LOGIN_REQUEST).outcome?.reason).toBe("launch_failed");

    for (const failure of ["error", "exit"] as const) {
      const opener = fakeOpener();
      const manager = createSetupJobManager({
        store: new SetupJobStore(join(root, failure)),
        rootDir: join(root, failure),
        platform: "darwin",
        runnerPath: "/tmp/setup-login-runner.js",
        openTerminal: () => opener,
      });
      const job = manager.create(LOGIN_REQUEST);
      if (failure === "error") opener.emit("error", new Error("open failed"));
      else opener.emit("exit", 1, null);
      expect(manager.status({ jobId: job.jobId }).outcome?.reason).toBe("launch_failed");
    }
  });

  it("keeps the manual command selectable on a pre-launch failure (W2)", () => {
    // Non-darwin bails before any Terminal, the same shape as any pre-manifest
    // failure: the operator must still see the exact command to run by hand
    // (DESIGN_SYSTEM setup contract, INV-093) — never a null command.
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "prelaunch-command")),
      rootDir: join(root, "prelaunch-command"),
      platform: "linux",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: () => fakeOpener(),
    });
    const job = manager.create(LOGIN_REQUEST);
    expect(job.outcome?.reason).toBe("launch_failed");
    expect(job.command).toBeTruthy();
    expect(job.command).toContain("codex");
  });

  it("a new create supersedes a client_pty orphan no client ever attached", async () => {
    // Hit live 2026-08-04: the UI lost the attach command to a daemon
    // ReadTimeout and the orphaned client_pty job then conflict-refused every
    // retry until the 15-minute login deadline. An unattached orphan (no
    // runner state on disk) has no living login to protect: a new create
    // cancels it and proceeds instead of refusing.
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "client-pty-supersede")),
      rootDir: join(root, "client-pty-supersede"),
      platform: "linux",
      runnerPath: resolveSetupLoginRunnerPath(),
      launcherTimeoutMs: 10_000,
      loginTimeoutMs: 15 * 60_000,
      monitorPollMs: 2,
    });
    await manager.start();
    const orphan = manager.create({ ...LOGIN_REQUEST, transport: "client_pty" });
    expect(orphan.state).toBe("waiting_for_input");
    const successor = manager.create({ ...LOGIN_REQUEST, transport: "client_pty" });
    expect(successor.jobId).not.toBe(orphan.jobId);
    expect(manager.status({ jobId: orphan.jobId })).toMatchObject({
      state: "cancelled",
      outcome: { reason: "cancelled_by_user" },
    });
    expect(manager.status({ jobId: successor.jobId }).state).toBe("waiting_for_input");
    await manager.shutdown();
  });

  it("keeps an unattached client_pty job alive past the runner launcher timeout", async () => {
    let nowMs = Date.parse("2026-07-25T00:00:00.000Z");
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "client-pty-awaiting-attach"), {
        now: () => new Date(nowMs),
      }),
      rootDir: join(root, "client-pty-awaiting-attach"),
      platform: "linux",
      runnerPath: resolveSetupLoginRunnerPath(),
      now: () => new Date(nowMs),
      launcherTimeoutMs: 10_000,
      loginTimeoutMs: 15 * 60_000,
      monitorPollMs: 2,
    });
    await manager.start();
    const job = manager.create({ ...LOGIN_REQUEST, transport: "client_pty" });
    expect(job).toMatchObject({
      transport: "client_pty",
      state: "waiting_for_input",
      phase: "launching",
    });
    const manifest = readLoginManifest(manager._store.paths(job.jobId).manifest);
    expect(manifest.permitDeadlineAt).toBe(job.deadlineAt);
    expect(manifest.permitWaitMs).toBe(10_000);

    nowMs += 11_000;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(manager.status({ jobId: job.jobId })).toMatchObject({
      state: "waiting_for_input",
      phase: "launching",
    });
    expect(Date.parse(manifest.permitDeadlineAt)).toBeGreaterThan(nowMs);

    nowMs = Date.parse(job.deadlineAt!) + 1;
    expect(await waitForTerminal(manager, job.jobId)).toBe("timed_out");
    await manager.shutdown();
  });

  it.each(["agy", "claude", "cursor"])(
    "seals %s client_pty as external attach before any daemon runner/probe",
    async (harness) => {
      process.env.CLAUDEXOR_CONFIG_DIR = join(root, "client-pty-config");
      const binary = join(root, `fake-${harness}`);
      writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      chmodSync(binary, 0o700);
      const envKey = `CLAUDEXOR_${harness.toUpperCase()}_BIN`;
      const oldBinary = process.env[envKey];
      process.env[envKey] = binary;
      const profile = registerConfigDirProfile({ harnessId: harness, profileId: "work" }).profile;
      const spawnProcess = vi.fn();
      let terminalOpens = 0;
      const manager = createSetupJobManager({
        store: new SetupJobStore(join(root, `client-pty-${harness}`)),
        rootDir: join(root, `client-pty-${harness}`),
        platform: "linux",
        runnerPath: resolveSetupLoginRunnerPath(),
        spawn: spawnProcess as never,
        openTerminal: () => {
          terminalOpens += 1;
          return fakeOpener();
        },
      });
      try {
        await manager.start();
        const job = manager.create({
          harness,
          action: "login",
          authRequest: "subscription",
          profileId: profile.profile_id,
          transport: "client_pty",
        });
        expect(job).toMatchObject({ state: "waiting_for_input", transport: "client_pty" });
        const manifest = readLoginManifest(manager._store.paths(job.jobId).manifest);
        expect(manifest.binary).toBe(realpathSync(binary));
        expect(manifest.profileConfigDir).toBe(profile.isolation_locator);
        expect(manifest).not.toHaveProperty("deviceCodePath");
        expect(manifest).not.toHaveProperty("loginMode");
        expect(manifest).not.toHaveProperty("inputPath");
        expect(manifest).not.toHaveProperty("ptyStdin");
        expect(spawnProcess).not.toHaveBeenCalled();
        expect(terminalOpens).toBe(0);
      } finally {
        await manager.shutdown();
        if (oldBinary === undefined) delete process.env[envKey];
        else process.env[envKey] = oldBinary;
      }
    },
  );

  it("permits a client_pty attach after its journaled deadline was extended", async () => {
    let nowMs = Date.parse("2026-07-25T00:00:00.000Z");
    const group = processGroupFixture({ leader: knownLeader(12) });
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "client-pty-extended-attach"), {
        now: () => new Date(nowMs),
      }),
      rootDir: join(root, "client-pty-extended-attach"),
      platform: "linux",
      runnerPath: resolveSetupLoginRunnerPath(),
      now: () => new Date(nowMs),
      launcherTimeoutMs: 10_000,
      loginTimeoutMs: 15 * 60_000,
      monitorPollMs: 2,
      processGroups: group.service,
    });
    await manager.start();
    const original = manager.create({ ...LOGIN_REQUEST, transport: "client_pty" });
    const manifestPath = manager._store.paths(original.jobId).manifest;
    const manifest = readLoginManifest(manifestPath);
    const extended = manager.extend({ jobId: original.jobId });

    expect(Date.parse(extended.deadlineAt!)).toBe(Date.parse(original.deadlineAt!) + 15 * 60_000);
    expect(readLoginManifest(manifestPath)).toEqual(manifest);
    expect(manifest.permitWaitMs).toBe(10_000);

    // The immutable manifest's legacy absolute deadline is now in the past,
    // while the journaled job remains active because Extend moved its owner.
    nowMs = Date.parse(original.deadlineAt!) + 1;
    writeRunnerStateV2(
      manager,
      original.jobId,
      group.leader,
      "awaiting_permit",
      new Date(nowMs).toISOString(),
    );
    await waitForPhase(manager, original.jobId, "awaiting_user");

    expect(readRunnerPermit(manager._store.paths(original.jobId).runnerPermit)).toMatchObject({
      jobId: original.jobId,
      executionId: manifest.executionId,
      manifestDigest: manifest.manifestDigest,
    });
    expect(manager.status({ jobId: original.jobId }).state).toBe("waiting_for_input");
    await manager.shutdown();
  });

  it("does not permit a deferred runner after the journaled job deadline", async () => {
    let nowMs = Date.parse("2026-07-25T00:00:00.000Z");
    const group = processGroupFixture({ leader: knownLeader(13) });
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "client-pty-expired-attach"), {
        now: () => new Date(nowMs),
      }),
      rootDir: join(root, "client-pty-expired-attach"),
      platform: "linux",
      runnerPath: resolveSetupLoginRunnerPath(),
      now: () => new Date(nowMs),
      launcherTimeoutMs: 10_000,
      loginTimeoutMs: 15 * 60_000,
      monitorPollMs: 2,
      processGroups: group.service,
    });
    await manager.start();
    const job = manager.create({ ...LOGIN_REQUEST, transport: "client_pty" });

    nowMs = Date.parse(job.deadlineAt!) + 1;
    writeRunnerStateV2(
      manager,
      job.jobId,
      group.leader,
      "awaiting_permit",
      new Date(nowMs).toISOString(),
    );

    expect(await waitForTerminal(manager, job.jobId)).toBe("timed_out");
    expect(readRunnerPermit(manager._store.paths(job.jobId).runnerPermit)).toBeNull();
    await manager.shutdown();
  });

  it("fences late opener callbacks and journal writes once shutdown begins", async () => {
    const opener = fakeOpener();
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "late-opener")),
      rootDir: join(root, "late-opener"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: () => opener,
    });
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);

    manager.beginDrain();
    expect(() => manager.create(LOGIN_REQUEST)).toThrow(/setup supervisor is unavailable/);
    await manager.shutdown();
    // v3.0.3 S5: ordinary shutdown leaves the interactive login untouched —
    // the detached runner keeps waiting and the successor daemon adopts it.
    expect(manager.status({ jobId: job.jobId }).state).toBe("waiting_for_input");

    legacyJournal(manager._store).close();
    const journalAtShutdown = readFileSync(legacyJournal(manager._store).path);
    expect(() => opener.emit("error", new Error("late LaunchServices failure"))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readFileSync(legacyJournal(manager._store).path)).toEqual(journalAtShutdown);
  });

  it("reaches a fully drained supervisor with an active login present (no termination on shutdown)", async () => {
    const opener = fakeOpener();
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "shutdown-persistence-failure")),
      rootDir: join(root, "shutdown-persistence-failure"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: () => opener,
    });
    await manager.start();
    manager.create(LOGIN_REQUEST);
    // v3.0.3 S5: shutdown no longer routes through terminateLogin (no
    // "cancelling" persistence step); it must resolve cleanly and drain.
    await manager.shutdown();
    expect(manager._supervisorHealth()).toMatchObject({ state: "stopped", activeTasks: 0 });
    legacyJournal(manager._store).close();
    const journalAtShutdown = readFileSync(legacyJournal(manager._store).path);
    expect(() => opener.emit("error", new Error("late opener failure"))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readFileSync(legacyJournal(manager._store).path)).toEqual(journalAtShutdown);
  });

  it("moves a launched runner to awaiting_user and enforces the launcher watchdog", async () => {
    let ms = Date.now();
    const liveGroup = processGroupFixture({ leader: knownLeader(11), killOnTerm: true });
    const live = createSetupJobManager({
      store: new SetupJobStore(join(root, "live"), { now: () => new Date(ms) }),
      rootDir: join(root, "live"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      now: () => new Date(ms),
      monitorPollMs: 1,
      processGroups: liveGroup.service,
    });
    await live.start();
    const launched = live.create(LOGIN_REQUEST);
    writeRunnerStateV2(
      live,
      launched.jobId,
      liveGroup.leader,
      "awaiting_permit",
      new Date(ms).toISOString(),
    );
    await waitForPhase(live, launched.jobId, "awaiting_user");
    expect(live.status({ jobId: launched.jobId }).execution?.permitIssuedAt).toBeDefined();
    await live.shutdown();

    const stalled = createSetupJobManager({
      store: new SetupJobStore(join(root, "stalled"), { now: () => new Date(ms) }),
      rootDir: join(root, "stalled"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      now: () => new Date(ms),
      monitorPollMs: 1,
      launcherTimeoutMs: 10_000,
    });
    await stalled.start();
    const waiting = stalled.create(LOGIN_REQUEST);
    ms += 10_001;
    expect(await waitForTerminal(stalled, waiting.jobId)).toBe("failed");
    expect(stalled.status({ jobId: waiting.jobId }).outcome?.reason).toBe("launch_failed");
    await stalled.shutdown();
  });

  it("keeps the Terminal script open after a nonzero runner exit", () => {
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "script")),
      rootDir: join(root, "script"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
    });
    const job = manager.create(LOGIN_REQUEST);
    const script = readFileSync(manager._store.paths(job.jobId).command, "utf8");
    expect(script).toContain("set +e");
    expect(script.indexOf("IFS= read -r _")).toBeLessThan(script.indexOf('exit "$status"'));
  });

  it("carries the daemon's disposable native store into the Terminal handoff", () => {
    const previousHome = process.env.HOME;
    const previousNativeHome = process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.HOME = join(root, "disposable home");
    process.env.CLAUDEXOR_CODEX_NATIVE_HOME = join(root, "disposable codex");
    process.env.OPENAI_API_KEY = "must-not-enter-terminal-script";
    try {
      const manager = createSetupJobManager({
        store: new SetupJobStore(join(root, "environment-handoff")),
        rootDir: join(root, "environment-handoff"),
        platform: "darwin",
        runnerPath: "/tmp/setup-login-runner.js",
        openTerminal: fakeOpener,
      });
      const job = manager.create(LOGIN_REQUEST);
      const script = readFileSync(manager._store.paths(job.jobId).command, "utf8");
      expect(script).toContain(`export HOME='${join(root, "disposable home")}'`);
      expect(script).toContain(
        `export CLAUDEXOR_CODEX_NATIVE_HOME='${join(root, "disposable codex")}'`,
      );
      expect(script).not.toContain("must-not-enter-terminal-script");
      expect(script).not.toContain("OPENAI_API_KEY");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousNativeHome === undefined) delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
      else process.env.CLAUDEXOR_CODEX_NATIVE_HOME = previousNativeHome;
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }
  });

  it("requires fresh subscription-native readiness after a zero exit", async () => {
    let ms = Date.now();
    const probes: unknown[] = [];
    const invalidatedHarnesses: string[] = [];
    const group = processGroupFixture();
    const capability = capabilityVerifier(() => new Date(ms));
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "store"), { now: () => new Date(ms) }),
      rootDir: join(root, "store"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      now: () => new Date(ms),
      verifyTimeoutMs: 5,
      verifyPollMs: 2,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      onCredentialStateMayHaveChanged: (harness) => invalidatedHarnesses.push(harness),
      sleep: async (delay) => {
        ms += delay;
      },
      probeAuthSource: async (harness, source, input) => {
        probes.push({
          harness,
          source,
          input: {
            fresh: input.fresh,
            authPreference: input.authPreference,
            aborted: input.abortSignal.aborted,
          },
        });
        return nativeReadiness(true);
      },
    });
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);
    await permitAndFinishNativeCommand(
      manager,
      job.jobId,
      group.leader,
      new Date(ms).toISOString(),
    );
    expect(await waitForTerminal(manager, job.jobId)).toBe("succeeded");
    expect(probes).toEqual([
      {
        harness: "codex",
        source: "native_session",
        input: { fresh: true, authPreference: "subscription", aborted: false },
      },
    ]);
    // #363: the window opened at the execution permit and closed at the proven end.
    expect(invalidatedHarnesses).toEqual(["codex", "codex"]);
    expect(capability.lookups).toEqual(["codex"]);
    expect(capability.runs).toHaveLength(1);
    expect(capability.runs[0]).toMatchObject({
      auth_preference: "subscription",
      access: "readonly",
      evidence_policy: "stream_only",
    });
    expect(manager.status({ jobId: job.jobId })).toMatchObject({
      outcome: { reason: "completed", exitCode: 0, signal: null },
      nativeCommand: { commandStarted: true, exitCode: 0, signal: null },
      authCapability: {
        state: "completed",
        receipt: {
          verification: "passed",
          effective: "vendor_native",
          effectiveSource: "native_session",
          billingKnowledge: "unknown",
          costKnowledge: "unknown",
        },
      },
    });
    await manager.shutdown();
  });

  it("keeps a permitted job live while the worker publishes its zero-exit result", async () => {
    const leader = knownLeader(62);
    const group = processGroupFixture({ leader });
    const capability = capabilityVerifier();
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "result-publication-race")),
      rootDir: join(root, "result-publication-race"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      probeAuthSource: async () => nativeReadiness(true),
    });
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);
    const observedAt = new Date().toISOString();
    writeRunnerStateV2(manager, job.jobId, leader, "awaiting_permit", observedAt);
    await waitForPhase(manager, job.jobId, "awaiting_user");
    writeRunnerStateV2(manager, job.jobId, leader, "running", observedAt);
    group.setObserved({ status: "missing", pid: leader.pid, platform: "darwin" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manager.status({ jobId: job.jobId })).toMatchObject({
      state: "waiting_for_input",
      phase: "awaiting_user",
    });
    writeRunnerResultV2(manager, job.jobId);
    expect(await waitForTerminal(manager, job.jobId)).toBe("succeeded");
    expect(capability.runs).toHaveLength(1);
    await manager.shutdown();
  });

  it("refuses a command result that arrives before a journaled execution permit", async () => {
    let probeCalls = 0;
    const capability = capabilityVerifier();
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "early-result")),
      rootDir: join(root, "early-result"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      monitorPollMs: 1,
      authCapabilityVerifier: capability.verifier,
      probeAuthSource: async () => {
        probeCalls += 1;
        return nativeReadiness(true);
      },
    });
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);
    writeRunnerResultV2(manager, job.jobId, { permitIssuedAt: new Date().toISOString() });
    expect(await waitForTerminal(manager, job.jobId)).toBe("failed");
    expect(manager.status({ jobId: job.jobId }).outcome?.reason).toBe("termination_unconfirmed");
    expect(probeCalls).toBe(0);
    expect(capability.runs).toEqual([]);
    await manager.shutdown();
  });

  it.each([
    {
      label: "paid-key route substitution",
      capability: { route: "managed_api_key" as const, source: "api_key_env" as const },
      reason: "credential_route_mismatch",
    },
    {
      label: "wrong challenge response",
      capability: { response: "wrong-response" },
      reason: "capability_verification_failed",
    },
  ])(
    "fails setup when the same-harness smoke has $label",
    async ({ capability: options, reason }) => {
      const group = processGroupFixture();
      const capability = capabilityVerifier(() => new Date(), options);
      const invalidatedHarnesses: string[] = [];
      const probedHarnesses: string[] = [];
      let jobId = "";
      let callbackSawDurableReceipt = false;
      let manager!: SetupManager;
      manager = createSetupJobManager({
        store: new SetupJobStore(join(root, `capability-${reason}`)),
        rootDir: join(root, `capability-${reason}`),
        platform: "darwin",
        runnerPath: "/tmp/setup-login-runner.js",
        openTerminal: fakeOpener,
        monitorPollMs: 1,
        processGroups: group.service,
        authCapabilityVerifier: capability.verifier,
        probeAuthSource: async (harness) => {
          probedHarnesses.push(harness);
          return nativeReadiness(true);
        },
        onCredentialStateMayHaveChanged: (harness) => {
          invalidatedHarnesses.push(harness);
          callbackSawDurableReceipt =
            manager.status({ jobId }).nativeCommand?.commandStarted === true;
        },
      });
      await manager.start();
      const job = manager.create(LOGIN_REQUEST);
      jobId = job.jobId;
      await permitAndFinishNativeCommand(manager, job.jobId, group.leader);
      expect(await waitForTerminal(manager, job.jobId)).toBe("failed");
      expect(manager.status({ jobId: job.jobId })).toMatchObject({
        outcome: { reason },
        authCapability: { state: "completed", receipt: { verification: "failed" } },
      });
      expect(capability.lookups).toEqual(["codex"]);
      expect(capability.runs).toHaveLength(1);
      expect(invalidatedHarnesses).toEqual(["codex", "codex"]); // window entry + close
      expect(probedHarnesses).toEqual(["codex"]);
      expect(callbackSawDurableReceipt).toBe(true);
      await manager.shutdown();
    },
  );

  it.each([
    {
      label: "started command with a nonzero exit",
      commandStarted: true,
      exitCode: 17,
      errorCode: undefined,
      expectedReason: "command_failed",
      expectedInvalidations: ["codex", "codex"], // window entry + close (#363)
    },
    {
      label: "command that never started",
      commandStarted: false,
      exitCode: null,
      errorCode: "spawn_failed" as const,
      expectedReason: "launch_failed",
      expectedInvalidations: [],
    },
  ])(
    "invalidates only when a native credential command may have mutated state: $label",
    async ({ commandStarted, exitCode, errorCode, expectedReason, expectedInvalidations }) => {
      const group = processGroupFixture();
      const capability = capabilityVerifier();
      const invalidatedHarnesses: string[] = [];
      let probeCalls = 0;
      const manager = createSetupJobManager({
        store: new SetupJobStore(
          join(root, `credential-change-${commandStarted ? "started" : "not-started"}`),
        ),
        rootDir: join(root, `credential-change-${commandStarted ? "started" : "not-started"}`),
        platform: "darwin",
        runnerPath: "/tmp/setup-login-runner.js",
        openTerminal: fakeOpener,
        monitorPollMs: 1,
        processGroups: group.service,
        authCapabilityVerifier: capability.verifier,
        probeAuthSource: async () => {
          probeCalls += 1;
          return nativeReadiness(true);
        },
        onCredentialStateMayHaveChanged: (harness) => invalidatedHarnesses.push(harness),
      });
      await manager.start();
      const job = manager.create(LOGIN_REQUEST);
      if (commandStarted) {
        const observedAt = new Date().toISOString();
        writeRunnerStateV2(manager, job.jobId, group.leader, "awaiting_permit", observedAt);
        await waitForPhase(manager, job.jobId, "awaiting_user");
        writeRunnerStateV2(manager, job.jobId, group.leader, "running", observedAt);
      }
      writeRunnerResultV2(manager, job.jobId, {
        commandStarted,
        exitCode,
        ...(errorCode ? { errorCode } : {}),
      });

      expect(await waitForTerminal(manager, job.jobId)).toBe("failed");
      expect(manager.status({ jobId: job.jobId })).toMatchObject({
        outcome: commandStarted
          ? { reason: expectedReason, exitCode, signal: null }
          : { reason: expectedReason },
        nativeCommand: { commandStarted, exitCode, signal: null },
      });
      expect(invalidatedHarnesses).toEqual(expectedInvalidations);
      expect(probeCalls).toBe(0);
      expect(capability.runs).toEqual([]);
      await manager.shutdown();
    },
  );

  it("does not replay a credential-state invalidation for an already durable outcome after restart", async () => {
    const storeRoot = join(root, "credential-change-restart");
    const group = processGroupFixture();
    const capability = capabilityVerifier();
    const firstInvalidations: string[] = [];
    const baseOptions = {
      rootDir: storeRoot,
      platform: "darwin" as const,
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      probeAuthSource: async () => nativeReadiness(true),
    };
    const first = createSetupJobManager({
      store: new SetupJobStore(storeRoot),
      ...baseOptions,
      onCredentialStateMayHaveChanged: (harness) => firstInvalidations.push(harness),
    });
    await first.start();
    const job = first.create(LOGIN_REQUEST);
    const observedAt = new Date().toISOString();
    writeRunnerStateV2(first, job.jobId, group.leader, "awaiting_permit", observedAt);
    await waitForPhase(first, job.jobId, "awaiting_user");
    writeRunnerStateV2(first, job.jobId, group.leader, "running", observedAt);
    writeRunnerResultV2(first, job.jobId, { exitCode: 9 });
    expect(await waitForTerminal(first, job.jobId)).toBe("failed");
    expect(firstInvalidations).toEqual(["codex", "codex"]); // window entry + close
    await first.shutdown();
    legacyJournal(first._store).close();

    const restartedInvalidations: string[] = [];
    const restarted = createSetupJobManager({
      store: new SetupJobStore(storeRoot),
      ...baseOptions,
      onCredentialStateMayHaveChanged: (harness) => restartedInvalidations.push(harness),
    });
    await restarted.start();
    expect(restarted.status({ jobId: job.jobId })).toMatchObject({
      state: "failed",
      outcome: { reason: "command_failed", exitCode: 9, signal: null },
      nativeCommand: { commandStarted: true, exitCode: 9, signal: null },
    });
    expect(restartedInvalidations).toEqual([]);
    await restarted.shutdown();
  });

  it("bounds an abort-ignoring capability smoke and retains its scratch as unknown evidence", async () => {
    const group = processGroupFixture();
    const capability = capabilityVerifier(() => new Date(), { hang: true });
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "hung-capability")),
      rootDir: join(root, "hung-capability"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      monitorPollMs: 1,
      capabilityTimeoutMs: 10,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      probeAuthSource: async () => nativeReadiness(true),
    });
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);
    await permitAndFinishNativeCommand(manager, job.jobId, group.leader);
    expect(await waitForTerminal(manager, job.jobId)).toBe("interrupted_unknown");
    const terminal = manager.status({ jobId: job.jobId });
    expect(terminal).toMatchObject({
      outcome: { reason: "interrupted_unknown", exitCode: 0, signal: null },
      authCapability: { state: "interrupted_unknown" },
    });
    expect(capability.runs).toHaveLength(1);
    expect(
      existsSync(join(root, "auth-capability-smokes", terminal.authCapability!.attemptId)),
    ).toBe(true);
    await manager.shutdown();
  });

  it("turns an in-flight capability smoke into interrupted_unknown during shutdown without late journal writes or replay", async () => {
    const group = processGroupFixture();
    let releaseCapability!: () => void;
    const capabilityGate = new Promise<void>((resolve) => {
      releaseCapability = resolve;
    });
    const hanging = capabilityVerifier(() => new Date(), { gate: capabilityGate });
    const storeRoot = join(root, "restart-running-capability");
    const first = createSetupJobManager({
      store: new SetupJobStore(storeRoot),
      rootDir: storeRoot,
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      monitorPollMs: 1,
      capabilityTimeoutMs: 60_000,
      processGroups: group.service,
      authCapabilityVerifier: hanging.verifier,
      probeAuthSource: async () => nativeReadiness(true),
    });
    await first.start();
    const job = first.create(LOGIN_REQUEST);
    await permitAndFinishNativeCommand(first, job.jobId, group.leader);
    await waitForAuthState(first, job.jobId, "running");
    await first.shutdown();
    expect(first.status({ jobId: job.jobId })).toMatchObject({
      state: "interrupted_unknown",
      outcome: { reason: "interrupted_unknown", exitCode: 0, signal: null },
      authCapability: { state: "interrupted_unknown" },
    });
    legacyJournal(first._store).close();
    const journalAtShutdown = readFileSync(legacyJournal(first._store).path);
    releaseCapability();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readFileSync(legacyJournal(first._store).path)).toEqual(journalAtShutdown);

    const replacement = capabilityVerifier();
    const restarted = createSetupJobManager({
      store: new SetupJobStore(storeRoot),
      rootDir: storeRoot,
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      processGroups: group.service,
      authCapabilityVerifier: replacement.verifier,
      probeAuthSource: async () => nativeReadiness(true),
    });
    await restarted.start();
    expect(restarted.status({ jobId: job.jobId })).toMatchObject({
      state: "interrupted_unknown",
      outcome: { reason: "interrupted_unknown", exitCode: 0, signal: null },
      authCapability: { state: "interrupted_unknown" },
    });
    expect(replacement.runs).toEqual([]);
    await restarted.shutdown();
  });

  it("finalizes a durable completed receipt during drain and restart without rerunning the model", async () => {
    const group = processGroupFixture();
    const firstCapability = capabilityVerifier();
    const storeRoot = join(root, "restart-completed-capability");
    const first = createSetupJobManager({
      store: new SetupJobStore(storeRoot),
      rootDir: storeRoot,
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: firstCapability.verifier,
      probeAuthSource: async () => nativeReadiness(true),
    });
    const originalUpdate = first._store.update.bind(first._store);
    let injected = false;
    first._store.update = ((jobId, patch) => {
      if (patch.state === "succeeded" && !injected) {
        injected = true;
        throw new Error("fault injection after durable capability receipt");
      }
      return originalUpdate(jobId, patch);
    }) as typeof first._store.update;
    await first.start();
    const job = first.create(LOGIN_REQUEST);
    await permitAndFinishNativeCommand(first, job.jobId, group.leader);
    await waitForAuthState(first, job.jobId, "completed");
    expect(first._supervisorHealth().failure?.message).toContain("fault injection");
    expect(() => first.create(LOGIN_REQUEST)).toThrow(/setup supervisor is unavailable/);
    await first.shutdown();
    expect(first.status({ jobId: job.jobId }).state).toBe("succeeded");
    legacyJournal(first._store).close();

    const replacement = capabilityVerifier();
    const restarted = createSetupJobManager({
      store: new SetupJobStore(storeRoot),
      rootDir: storeRoot,
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      processGroups: group.service,
      authCapabilityVerifier: replacement.verifier,
      probeAuthSource: async () => nativeReadiness(true),
    });
    await restarted.start();
    expect(restarted.status({ jobId: job.jobId })).toMatchObject({
      state: "succeeded",
      outcome: { reason: "completed", exitCode: 0, signal: null },
      nativeCommand: { commandStarted: true, exitCode: 0, signal: null },
      authCapability: { state: "completed", receipt: { verification: "passed" } },
    });
    expect(replacement.runs).toEqual([]);
    await restarted.shutdown();
  });

  it("records awaiting_user before immediate result verification and cancels verifying without signalling", async () => {
    let release: (() => void) | undefined;
    const doctor = new Promise<AuthSourceReadiness>((resolve) => {
      release = () => resolve(nativeReadiness(true));
    });
    let probeSignal: AbortSignal | undefined;
    const group = processGroupFixture({ leader: knownLeader(61) });
    const capability = capabilityVerifier();
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "fast-result")),
      rootDir: join(root, "fast-result"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      probeAuthSource: async (_harness, _source, input) => {
        probeSignal = input.abortSignal;
        return doctor;
      },
    });
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);
    await permitAndFinishNativeCommand(manager, job.jobId, group.leader);
    await waitForPhase(manager, job.jobId, "verifying");
    expect(() => manager.extend({ jobId: job.jobId })).toThrow(/cannot be extended/);
    const cancelled = await manager.cancel({ jobId: job.jobId });
    expect(cancelled).toMatchObject({
      state: "cancelled",
      outcome: { reason: "cancelled_by_user", exitCode: 0, signal: null },
    });
    expect(probeSignal?.aborted).toBe(true);
    expect(group.signals).toEqual([]);
    expect(capability.runs).toEqual([]);
    const phases = manager._store.events(job.jobId).map((event) => event.job?.phase);
    expect(phases.indexOf("awaiting_user")).toBeGreaterThanOrEqual(0);
    expect(phases.indexOf("awaiting_user")).toBeLessThan(phases.indexOf("verifying"));
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manager.status({ jobId: job.jobId }).outcome?.reason).toBe("cancelled_by_user");
    await manager.shutdown();
  });

  it("does not accept an unavailable native_session", async () => {
    let ms = Date.now();
    const group = processGroupFixture();
    const capability = capabilityVerifier(() => new Date(ms));
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "store"), { now: () => new Date(ms) }),
      rootDir: join(root, "store"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      now: () => new Date(ms),
      verifyTimeoutMs: 3,
      verifyPollMs: 2,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      sleep: async (delay) => {
        ms += delay;
      },
      probeAuthSource: async () => nativeReadiness(false),
    });
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);
    await permitAndFinishNativeCommand(
      manager,
      job.jobId,
      group.leader,
      new Date(ms).toISOString(),
    );
    expect(await waitForTerminal(manager, job.jobId)).toBe("failed");
    expect(manager.status({ jobId: job.jobId }).outcome?.reason).toBe("auth_not_ready");
    expect(capability.runs).toEqual([]);
    await manager.shutdown();
  });

  it("polls fresh verification for the full 30-second window", async () => {
    let ms = Date.now();
    let calls = 0;
    const group = processGroupFixture();
    const capability = capabilityVerifier(() => new Date(ms));
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "verify-window"), { now: () => new Date(ms) }),
      rootDir: join(root, "verify-window"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      now: () => new Date(ms),
      verifyTimeoutMs: 30_000,
      verifyPollMs: 2_000,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      sleep: async (delay) => {
        ms += delay;
      },
      probeAuthSource: async () => {
        calls += 1;
        return nativeReadiness(false);
      },
    });
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);
    const created = ms;
    await permitAndFinishNativeCommand(
      manager,
      job.jobId,
      group.leader,
      new Date(ms).toISOString(),
    );
    expect(await waitForTerminal(manager, job.jobId)).toBe("failed");
    expect(ms - created).toBe(30_000);
    // 15 in-window polls + the one bounded post-deadline grace re-probe
    // (owner live E2E 2026-08-04: a vendor credential flush can land moments
    // after the deadline while the login itself succeeded).
    expect(calls).toBe(16);
    expect(capability.runs).toEqual([]);
    await manager.shutdown();
  });

  it("includes probe duration and bounded polls inside the hard verification ceiling", async () => {
    let ms = Date.now();
    let calls = 0;
    const group = processGroupFixture();
    const capability = capabilityVerifier(() => new Date(ms));
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "hard-verify-ceiling"), { now: () => new Date(ms) }),
      rootDir: join(root, "hard-verify-ceiling"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      now: () => new Date(ms),
      verifyTimeoutMs: 10_000,
      verifyPollMs: 2_000,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      sleep: async (delay) => {
        ms += delay;
      },
      probeAuthSource: async () => {
        calls += 1;
        ms += 1_900;
        return nativeReadiness(false);
      },
    });
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);
    const started = ms;
    await permitAndFinishNativeCommand(
      manager,
      job.jobId,
      group.leader,
      new Date(ms).toISOString(),
    );
    expect(await waitForTerminal(manager, job.jobId)).toBe("failed");
    expect(manager.status({ jobId: job.jobId }).outcome?.reason).toBe("auth_not_ready");
    // The in-window ceiling holds at 10s; the single bounded grace re-probe
    // adds at most one probe duration beyond it, never an open-ended wait.
    expect(ms - started).toBe(11_900);
    expect(calls).toBe(4);
    expect(capability.runs).toEqual([]);
    await manager.shutdown();
  });

  it("accepts readiness that lands moments after the deadline via the grace re-probe", async () => {
    let ms = Date.now();
    const group = processGroupFixture();
    const capability = capabilityVerifier(() => new Date(ms));
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "late-ready"), { now: () => new Date(ms) }),
      rootDir: join(root, "late-ready"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      now: () => new Date(ms),
      verifyTimeoutMs: 30_000,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      probeAuthSource: async () => {
        ms += 30_001;
        return nativeReadiness(true);
      },
    });
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);
    await permitAndFinishNativeCommand(
      manager,
      job.jobId,
      group.leader,
      new Date(ms).toISOString(),
    );
    // Owner live E2E 2026-08-04: the codex auth.json flush landed after the
    // 30s deadline while `codex login status` already said Logged in — the
    // job read "Login failed" against a succeeded login. The bounded grace
    // re-probe turns exactly this race into the pass it really is.
    expect(await waitForTerminal(manager, job.jobId)).toBe("succeeded");
    expect(capability.runs).toHaveLength(1);
    await manager.shutdown();
  });

  it("retries fresh verification after a transient probe failure", async () => {
    let ms = Date.now();
    let calls = 0;
    const group = processGroupFixture();
    const capability = capabilityVerifier(() => new Date(ms));
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "retry"), { now: () => new Date(ms) }),
      rootDir: join(root, "retry"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      now: () => new Date(ms),
      verifyTimeoutMs: 30_000,
      verifyPollMs: 2_000,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      sleep: async (delay) => {
        ms += delay;
      },
      probeAuthSource: async () => {
        calls += 1;
        if (calls === 1) throw new Error("temporary native-source failure");
        return nativeReadiness(true);
      },
    });
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);
    await permitAndFinishNativeCommand(
      manager,
      job.jobId,
      group.leader,
      new Date(ms).toISOString(),
    );
    expect(await waitForTerminal(manager, job.jobId)).toBe("succeeded");
    expect(calls).toBe(2);
    expect(capability.runs).toHaveLength(1);
    expect(ms - Date.parse(job.createdAt)).toBe(2_000);
    await manager.shutdown();
  });

  it("bounds a native source probe even when the injected implementation ignores abort", async () => {
    let probeSignal: AbortSignal | undefined;
    const group = processGroupFixture();
    const capability = capabilityVerifier();
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "hung-native-probe")),
      rootDir: join(root, "hung-native-probe"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      verifyTimeoutMs: 10,
      verifyPollMs: 2,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      probeAuthSource: async (_harness, _source, input) => {
        probeSignal = input.abortSignal;
        return new Promise<AuthSourceReadiness | null>(() => {});
      },
    });
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);
    await permitAndFinishNativeCommand(manager, job.jobId, group.leader);
    expect(await waitForTerminal(manager, job.jobId)).toBe("failed");
    expect(manager.status({ jobId: job.jobId }).outcome?.reason).toBe("auth_not_ready");
    expect(probeSignal?.aborted).toBe(true);
    expect(capability.runs).toEqual([]);
    await manager.shutdown();
  });

  it("cancels safely before execution authorization without guessing a PID", async () => {
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "store")),
      rootDir: join(root, "store"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
    });
    const job = manager.create(LOGIN_REQUEST);
    const stopped = await manager.cancel({ jobId: job.jobId });
    expect(stopped.state).toBe("cancelled");
    expect(stopped.outcome?.reason).toBe("cancelled_by_user");
    expect(stopped.execution).toBeUndefined();
  });

  it("persists a completed native command before cancellation terminalizes its result", async () => {
    const invalidatedHarnesses: string[] = [];
    const group = processGroupFixture();
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "cancel-after-result")),
      rootDir: join(root, "cancel-after-result"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      processGroups: group.service,
      onCredentialStateMayHaveChanged: (harness) => invalidatedHarnesses.push(harness),
    });
    const job = manager.create(LOGIN_REQUEST);
    const manifest = readLoginManifest(manager._store.paths(job.jobId).manifest);
    const observedAt = new Date().toISOString();
    const permitIssuedAt = new Date().toISOString();
    manager._store.update(job.jobId, {
      execution: {
        executionId: manifest.executionId,
        commandDigest: manifest.commandDigest,
        manifestDigest: manifest.manifestDigest,
        processGroup: { schemaVersion: 1, pgid: group.leader.pid, leader: group.leader },
        observedAt,
      },
    });
    manager._store.update(job.jobId, {
      execution: { ...manager.status({ jobId: job.jobId }).execution!, permitIssuedAt },
    });
    manager._store.update(job.jobId, {
      state: "waiting_for_input",
      phase: "awaiting_user",
    });
    writeRunnerStateV2(manager, job.jobId, group.leader, "running", observedAt);
    writeRunnerResultV2(manager, job.jobId, { permitIssuedAt });

    const stopped = await manager.cancel({ jobId: job.jobId });

    expect(stopped).toMatchObject({
      state: "cancelled",
      outcome: { reason: "cancelled_by_user", exitCode: 0, signal: null },
      nativeCommand: { commandStarted: true, exitCode: 0, signal: null },
    });
    // The permit was written straight into the store (no manager transition),
    // so only the receipt-proven close invalidates (#363).
    expect(invalidatedHarnesses).toEqual(["codex"]);
    expect(group.signals).toEqual([]);
    await manager.shutdown();
  });

  it("never signals a PID-reused process when kernel start identity differs", async () => {
    const leader = knownLeader(21, "darwin:1710000000:000021");
    const group = processGroupFixture({ leader });
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "pid-reuse")),
      rootDir: join(root, "pid-reuse"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      processGroups: group.service,
      monitorPollMs: 1,
    });
    const binding = new SetupLifecycleBinding(
      { current: () => manager._store, generation: () => 1 },
      () => manager,
    );
    await binding.start();
    const stopped: string[] = [];
    const runtime = new DaemonRuntimeShutdown({
      setup: binding,
      daemon: { stop: async () => void stopped.push("daemon") },
      control: () => ({ stop: async () => void stopped.push("control") }),
      journal: { close: () => legacyJournal(manager._store).close() },
      forceExit: () => undefined,
    });
    const expectReplacementBusy = () => {
      expect(() => runtime.beginRuntimeReplacement()).toThrowError(
        expect.objectContaining({ code: "runtime_replacement_busy" }),
      );
      expect(runtime.requested()).toBe(false);
      expect(stopped).toEqual([]);
      expect(manager._supervisorHealth().state).toBe("healthy");
    };
    const job = manager.create(LOGIN_REQUEST);
    expectReplacementBusy();
    writeRunnerStateV2(manager, job.jobId, leader);
    await waitForPhase(manager, job.jobId, "awaiting_user");
    group.setObserved(knownLeader(21, "darwin:1710000001:000021"));
    const result = await manager.cancel({ jobId: job.jobId });
    expect(result.outcome?.reason).toBe("termination_unconfirmed");
    expect(group.signals).toEqual([]);
    expectReplacementBusy();
    expect(manager.create(LOGIN_REQUEST).jobId).toBe(job.jobId);
    expect(() => manager.reconcile({ jobId: job.jobId })).toThrow(/not proven empty/);
    group.setObserved({ status: "missing", pid: leader.pid, platform: "darwin" });
    group.setAlive(false);
    const reconciled = manager.reconcile({ jobId: job.jobId });
    expect(reconciled).toMatchObject({
      terminationReconciliation: { status: "empty" },
    });
    expect(manager.reconcile({ jobId: job.jobId })).toEqual(reconciled);
    expect(binding.hasActiveWork()).toBe(false);
    const next = manager.create(LOGIN_REQUEST);
    expect(next.jobId).not.toBe(job.jobId);
    expectReplacementBusy();
    await manager.cancel({ jobId: next.jobId });
    expect(binding.hasActiveWork()).toBe(false);
    const stopping = runtime.beginRuntimeReplacement();
    expect(runtime.requested()).toBe(true);
    expect(stopped).toEqual(["control", "daemon"]);
    await stopping;
  });

  it.each(["cancel", "timeout"] as const)(
    "uses TERM then KILL and proves exit for login %s",
    async (kind) => {
      let ms = Date.now();
      const group = processGroupFixture({ leader: knownLeader(31) });
      const manager = createSetupJobManager({
        store: new SetupJobStore(join(root, kind), { now: () => new Date(ms) }),
        rootDir: join(root, kind),
        platform: "darwin",
        runnerPath: "/tmp/setup-login-runner.js",
        openTerminal: fakeOpener,
        now: () => new Date(ms),
        monitorPollMs: 1,
        terminationGraceMs: 2,
        sleep: async (delay) => {
          ms += delay;
        },
        processGroups: group.service,
      });
      await manager.start();
      const job = manager.create(LOGIN_REQUEST);
      writeRunnerStateV2(
        manager,
        job.jobId,
        group.leader,
        "awaiting_permit",
        new Date(ms).toISOString(),
      );
      await waitForPhase(manager, job.jobId, "awaiting_user");
      const done =
        kind === "cancel"
          ? await manager.cancel({ jobId: job.jobId })
          : ((ms = Date.parse(job.deadlineAt!)),
            await waitForTerminal(manager, job.jobId),
            manager.status({ jobId: job.jobId }));
      expect(group.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(done.outcome?.reason).toBe(kind === "cancel" ? "cancelled_by_user" : "timed_out");
      await manager.shutdown();
    },
  );

  it.each([
    ["cancel", false],
    ["timeout", false],
    ["cancel", true],
    ["timeout", true],
  ] as const)(
    "keeps the existing %s grace while group probes are unknown (persistent=%s)",
    async (kind, persistent) => {
      let ms = Date.now();
      let killedAt: number | undefined;
      let recover = false;
      let probesAfterKill = 0;
      const group = processGroupFixture({
        leader: knownLeader(32),
        onSignal: (signal) => {
          if (signal === "SIGKILL") killedAt = ms;
        },
      });
      const probe = group.service.probeEmpty.bind(group.service);
      vi.spyOn(group.service, "probeEmpty").mockImplementation((handle) => {
        if (killedAt !== undefined) {
          probesAfterKill += 1;
          if (!recover && (persistent || ms - killedAt < 100)) {
            return { status: "unknown", pgid: handle.pgid, reason: "permission_denied" };
          }
        }
        return probe(handle);
      });
      const bumps: string[] = [];
      const manager = createSetupJobManager({
        store: new SetupJobStore(join(root, `probe-grace-${kind}-${persistent}`), {
          now: () => new Date(ms),
        }),
        rootDir: join(root, `probe-grace-${kind}-${persistent}`),
        platform: "darwin",
        runnerPath: "/tmp/setup-login-runner.js",
        openTerminal: fakeOpener,
        now: () => new Date(ms),
        monitorPollMs: 1,
        terminationGraceMs: 200,
        sleep: async (delay) => {
          expect(manager.credentialMutationOpen("codex")).toBe(true);
          ms += delay;
        },
        processGroups: group.service,
        onCredentialStateMayHaveChanged: (harness) => bumps.push(harness),
      });
      await manager.start();
      try {
        const job = manager.create(LOGIN_REQUEST);
        writeRunnerStateV2(
          manager,
          job.jobId,
          group.leader,
          "awaiting_permit",
          new Date(ms).toISOString(),
        );
        await waitForPhase(manager, job.jobId, "awaiting_user");
        expect(bumps).toEqual(["codex"]);
        const done =
          kind === "cancel"
            ? await manager.cancel({ jobId: job.jobId })
            : ((ms = Date.parse(job.deadlineAt!)),
              await waitForTerminal(manager, job.jobId),
              manager.status({ jobId: job.jobId }));
        expect(group.signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(probesAfterKill).toBeGreaterThanOrEqual(2);
        if (persistent) {
          expect(ms - killedAt!).toBe(200);
          expect(done.outcome?.reason).toBe("termination_unconfirmed");
          expect(manager.credentialMutationOpen("codex")).toBe(true);
          expect(bumps).toEqual(["codex"]);
          recover = true;
          manager.reconcile({ jobId: job.jobId });
        } else {
          expect(ms - killedAt!).toBe(100);
          expect(done.outcome?.reason).toBe(kind === "cancel" ? "cancelled_by_user" : "timed_out");
        }
        expect(manager.credentialMutationOpen("codex")).toBe(false);
        expect(bumps).toEqual(["codex", "codex"]);
      } finally {
        await manager.shutdown();
      }
    },
  );

  it("shares one login termination and preserves the timeout reason against concurrent cancel", async () => {
    let ms = Date.now();
    let concurrentCancel: Promise<unknown> | undefined;
    let jobId = "";
    let manager: ReturnType<typeof createSetupJobManager>;
    const group = processGroupFixture({
      leader: knownLeader(41),
      onSignal: (signal) => {
        if (signal === "SIGTERM") concurrentCancel = manager.cancel({ jobId });
      },
    });
    manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "login-race"), { now: () => new Date(ms) }),
      rootDir: join(root, "login-race"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      now: () => new Date(ms),
      monitorPollMs: 1,
      terminationGraceMs: 1,
      sleep: async () => {},
      processGroups: group.service,
    });
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);
    jobId = job.jobId;
    writeRunnerStateV2(manager, jobId, group.leader, "awaiting_permit", new Date(ms).toISOString());
    await waitForPhase(manager, jobId, "awaiting_user");
    ms = Date.parse(job.deadlineAt!);
    expect(await waitForTerminal(manager, jobId)).toBe("timed_out");
    await concurrentCancel;
    expect(group.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(manager.status({ jobId }).outcome?.reason).toBe("timed_out");
    await manager.shutdown();
  });

  it("reconciles and reissues the exact durable permit after restart without reopening Terminal", async () => {
    const group = processGroupFixture({ leader: knownLeader(101) });
    let opened = 0;
    const opts = {
      rootDir: join(root, "store"),
      platform: "darwin" as const,
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: () => {
        opened += 1;
        return fakeOpener();
      },
      processGroups: group.service,
      sleep: async () => {},
    };
    const first = createSetupJobManager({ ...opts, store: new SetupJobStore(join(root, "store")) });
    const job = first.create(LOGIN_REQUEST);
    writeRunnerStateV2(first, job.jobId, group.leader);
    // Deliberate crash fixture: no supervisor was started, so close the sole
    // journal writer without running graceful lifecycle reconciliation.
    first.beginDrain();
    legacyJournal(first._store).close();
    const restarted = createSetupJobManager({
      ...opts,
      store: new SetupJobStore(join(root, "store")),
    });
    await restarted.start();
    expect(restarted.status({ jobId: job.jobId })).toMatchObject({
      state: "waiting_for_input",
      phase: "awaiting_user",
      execution: { permitIssuedAt: expect.any(String) },
    });
    expect(opened).toBe(1);
    expect(group.signals).toEqual([]);
    await restarted.shutdown();
  });

  it("does not redeliver a durable client_pty permit after its deadline on restart", async () => {
    let nowMs = Date.parse("2026-07-25T00:00:00.000Z");
    const group = processGroupFixture({ leader: knownLeader(102) });
    const opts = {
      rootDir: join(root, "expired-client-pty-restart"),
      platform: "linux" as const,
      runnerPath: resolveSetupLoginRunnerPath(),
      now: () => new Date(nowMs),
      processGroups: group.service,
      terminationGraceMs: 1,
      sleep: async (delay: number) => {
        nowMs += delay;
      },
    };
    const first = createSetupJobManager({
      ...opts,
      store: new SetupJobStore(join(root, "expired-client-pty-restart"), {
        now: () => new Date(nowMs),
      }),
    });
    const job = first.create({ ...LOGIN_REQUEST, transport: "client_pty" });
    const manifest = writeRunnerStateV2(
      first,
      job.jobId,
      group.leader,
      "awaiting_permit",
      new Date(nowMs).toISOString(),
    );
    first._store.update(job.jobId, {
      execution: {
        executionId: manifest.executionId,
        commandDigest: manifest.commandDigest,
        manifestDigest: manifest.manifestDigest,
        processGroup: { schemaVersion: 1, pgid: group.leader.pid, leader: group.leader },
        observedAt: new Date(nowMs).toISOString(),
      },
    });
    first._store.update(job.jobId, {
      execution: {
        ...first.status({ jobId: job.jobId }).execution!,
        permitIssuedAt: new Date(nowMs).toISOString(),
      },
    });
    // Crash after the journal transition but before its one-use sidecar was
    // delivered. The successor must honor the expired journal deadline rather
    // than replaying that authorization into the relative runner window.
    first.beginDrain();
    legacyJournal(first._store).close();
    nowMs = Date.parse(job.deadlineAt!) + 1;

    const restarted = createSetupJobManager({
      ...opts,
      store: new SetupJobStore(join(root, "expired-client-pty-restart"), {
        now: () => new Date(nowMs),
      }),
    });
    await restarted.start();
    expect(restarted.status({ jobId: job.jobId })).toMatchObject({
      state: "timed_out",
      outcome: { reason: "timed_out" },
    });
    expect(readRunnerPermit(restarted._store.paths(job.jobId).runnerPermit)).toBeNull();
    expect(group.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await restarted.shutdown();
  });

  it("D-17 restart adoption: a successor daemon re-arms the disclosure watcher for an already-awaiting_user device-code job", async () => {
    const group = processGroupFixture({ leader: knownLeader(151) });
    const capability = capabilityVerifier();
    const opts = {
      rootDir: join(root, "device-code-restart-watcher"),
      platform: "darwin" as const,
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      spawn: (() => fakeOpener()) as unknown as typeof import("node:child_process").spawn,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      probeAuthSource: async () => nativeReadiness(true),
    };
    const first = createSetupJobManager({
      ...opts,
      store: new SetupJobStore(join(root, "device-code-restart-watcher")),
    });
    await first.start();
    const job = first.create(DEVICE_CODE_REQUEST);
    const observedAt = new Date().toISOString();
    writeRunnerStateV2(first, job.jobId, group.leader, "awaiting_permit", observedAt);
    await waitForPhase(first, job.jobId, "awaiting_user");
    // Crash BEFORE the sidecar exists; the durable journal already says awaiting_user.
    first.beginDrain();
    legacyJournal(first._store).close();
    const restarted = createSetupJobManager({
      ...opts,
      store: new SetupJobStore(join(root, "device-code-restart-watcher")),
    });
    await restarted.start();
    expect(restarted.status({ jobId: job.jobId }).phase).toBe("awaiting_user");
    // The sidecar lands under the SUCCESSOR daemon.
    const auth = restarted.status({ jobId: job.jobId }).authorization!;
    atomicPrivateJson(restarted._store.paths(job.jobId).runnerDeviceCode, {
      version: 2,
      jobId: job.jobId,
      executionId: auth.executionId,
      flow: "chatgptDeviceCode",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "WXYZ-1234",
      disclosedAt: new Date().toISOString(),
    });
    await vi.waitFor(() => {
      const snap = restarted.snapshot({ jobId: job.jobId }) as {
        deviceCode?: { userCode?: string };
        job: { message: string };
      };
      expect(snap.deviceCode?.userCode).toBe("WXYZ-1234");
      expect(snap.job.message).toContain("One-time code ready");
    });
    await restarted.shutdown();
  });

  it("marks a disappeared runner interrupted on restart and ignores a mismatched result", async () => {
    const first = createSetupJobManager({
      store: new SetupJobStore(join(root, "interrupted")),
      rootDir: join(root, "interrupted"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
    });
    const job = first.create(LOGIN_REQUEST);
    const manifest = readLoginManifest(first._store.paths(job.jobId).manifest);
    writeRunnerResultV2(first, job.jobId, {
      executionId: "wrong-execution",
      commandStarted: false,
      errorCode: "permit_timeout",
      exitCode: null,
    });
    first.beginDrain();
    legacyJournal(first._store).close();
    const restarted = createSetupJobManager({
      store: new SetupJobStore(join(root, "interrupted")),
      rootDir: join(root, "interrupted"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
    });
    await restarted.start();
    expect(restarted.status({ jobId: job.jobId }).outcome?.reason).toBe("cancelled_on_restart");
    expect(manifest.executionId).not.toBe("wrong-execution");
    await restarted.shutdown();
  });

  it("ordinary graceful shutdown leaves the login runner unsignalled and the successor adopts it", async () => {
    const group = processGroupFixture({ leader: knownLeader(103) });
    let opened = 0;
    const opts = {
      rootDir: join(root, "graceful-adopt"),
      platform: "darwin" as const,
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: () => {
        opened += 1;
        return fakeOpener();
      },
      processGroups: group.service,
      sleep: async () => {},
    };
    const first = createSetupJobManager({
      ...opts,
      store: new SetupJobStore(join(root, "graceful-adopt")),
    });
    await first.start();
    const job = first.create(LOGIN_REQUEST);
    writeRunnerStateV2(first, job.jobId, group.leader);
    await waitForPhase(first, job.jobId, "awaiting_user");
    await first.shutdown();
    expect(group.signals).toEqual([]);
    legacyJournal(first._store).close();
    const restarted = createSetupJobManager({
      ...opts,
      store: new SetupJobStore(join(root, "graceful-adopt")),
    });
    await restarted.start();
    expect(restarted.status({ jobId: job.jobId })).toMatchObject({
      state: "waiting_for_input",
      phase: "awaiting_user",
      execution: { permitIssuedAt: expect.any(String) },
    });
    expect(group.signals).toEqual([]);
    expect(opened).toBe(1);
    await restarted.shutdown();
  });

  it("consumes a result that lands BETWEEN the result read and the empty probe (true TOCTOU)", async () => {
    const group = processGroupFixture({ leader: knownLeader(105) });
    let firstManager: ReturnType<typeof createSetupJobManager>;
    let jobId = "";
    let armed = false;
    let planted = false;
    let plantResult: () => void = () => undefined;
    // Wrap the service so the empty-group probe ITSELF plants the durable
    // result, exercising the wave-1 late-result re-check rather than the
    // pre-existing result-first branch. Armed only for the successor daemon.
    // Explicit delegation (not Object.create): class-private state must keep
    // its real `this`.
    const rigged = {
      captureLeader: (pid: number) => group.service.captureLeader(pid),
      compareLeader: (handle: Parameters<typeof group.service.compareLeader>[0]) =>
        group.service.compareLeader(handle),
      signal: (
        handle: Parameters<typeof group.service.signal>[0],
        sig: Parameters<typeof group.service.signal>[1],
      ) => group.service.signal(handle, sig),
      probeEmpty: (handle: Parameters<typeof group.service.probeEmpty>[0]) => {
        if (armed && !planted) {
          planted = true;
          // Direct file write with values captured BEFORE the crash — the
          // first manager's journal is closed by now.
          plantResult();
        }
        return group.service.probeEmpty(handle);
      },
    } as unknown as typeof group.service;
    const baseOpts = {
      rootDir: join(root, "toctou-probe-hook"),
      platform: "darwin" as const,
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      sleep: async () => {},
    };
    firstManager = createSetupJobManager({
      store: new SetupJobStore(join(root, "toctou-probe-hook")),
      ...baseOpts,
      processGroups: group.service,
    });
    await firstManager.start();
    const job = firstManager.create(LOGIN_REQUEST);
    jobId = job.jobId;
    writeRunnerStateV2(firstManager, jobId, group.leader);
    await waitForPhase(firstManager, jobId, "awaiting_user");
    // Capture everything the planted result needs while the journal is open.
    const paths = firstManager._store.paths(jobId);
    const manifest = readLoginManifest(paths.manifest);
    const permitIssuedAt = firstManager.status({ jobId }).execution?.permitIssuedAt ?? null;
    plantResult = () =>
      atomicPrivateJson(paths.runnerResult, {
        version: SETUP_LOGIN_PROTOCOL_VERSION,
        jobId,
        executionId: manifest.executionId,
        commandDigest: manifest.commandDigest,
        manifestDigest: manifest.manifestDigest,
        permitIssuedAt,
        commandStarted: true,
        exitCode: 0,
        signal: null,
        finishedAt: new Date().toISOString(),
      });
    group.setAlive(false); // group empty by the time the successor probes
    firstManager.beginDrain();
    legacyJournal(firstManager._store).close();
    armed = true;
    const restarted = createSetupJobManager({
      store: new SetupJobStore(join(root, "toctou-probe-hook")),
      ...baseOpts,
      processGroups: rigged,
    });
    await restarted.start();
    const after = restarted.status({ jobId });
    expect(after.outcome?.reason).not.toBe("cancelled_on_restart");
    expect(group.signals).toEqual([]);
    await restarted.shutdown();
  });

  it("classifies a proven-dead login runner as cancelled_on_restart at successor start", async () => {
    const group = processGroupFixture({ leader: knownLeader(104) });
    const opts = {
      rootDir: join(root, "dead-runner-restart"),
      platform: "darwin" as const,
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      processGroups: group.service,
      sleep: async () => {},
    };
    const first = createSetupJobManager({
      ...opts,
      store: new SetupJobStore(join(root, "dead-runner-restart")),
    });
    const job = first.create(LOGIN_REQUEST);
    writeRunnerStateV2(first, job.jobId, group.leader);
    group.setAlive(false); // the runner died while no daemon was watching
    first.beginDrain();
    legacyJournal(first._store).close();
    const restarted = createSetupJobManager({
      ...opts,
      store: new SetupJobStore(join(root, "dead-runner-restart")),
    });
    await restarted.start();
    expect(restarted.status({ jobId: job.jobId })).toMatchObject({
      state: "cancelled",
      outcome: { reason: "cancelled_on_restart" },
    });
    expect(group.signals).toEqual([]);
    await restarted.shutdown();
  });

  it.each(["different", "missing", "unknown"] as const)(
    "fails closed when restart identity is %s",
    async (observed) => {
      const storeRoot = join(root, `restart-${observed}`);
      const leader = knownLeader(51);
      const group = processGroupFixture({ leader });
      const first = createSetupJobManager({
        store: new SetupJobStore(storeRoot),
        rootDir: storeRoot,
        platform: "darwin",
        runnerPath: "/tmp/setup-login-runner.js",
        openTerminal: fakeOpener,
        processGroups: group.service,
      });
      const job = first.create(LOGIN_REQUEST);
      writeRunnerStateV2(first, job.jobId, leader);
      group.setObserved(
        observed === "different"
          ? knownLeader(51, "darwin:1710000001:000051")
          : observed === "missing"
            ? { status: "missing", pid: 51, platform: "darwin" }
            : { status: "unknown", pid: 51, platform: "darwin", reason: "permission_denied" },
      );
      first.beginDrain();
      legacyJournal(first._store).close();
      const restarted = createSetupJobManager({
        store: new SetupJobStore(storeRoot),
        rootDir: storeRoot,
        platform: "darwin",
        runnerPath: "/tmp/setup-login-runner.js",
        openTerminal: fakeOpener,
        processGroups: group.service,
      });
      await restarted.start();
      expect(restarted.status({ jobId: job.jobId }).outcome?.reason).toBe(
        "termination_unconfirmed",
      );
      expect(group.signals).toEqual([]);
      await restarted.shutdown();
    },
  );

  it("a device_auth_unsupported runner result terminates the awaiting-user job as not_supported (old codex CLI)", async () => {
    const group = processGroupFixture({ leader: knownLeader(106) });
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "device-auth-unsupported")),
      rootDir: join(root, "device-auth-unsupported"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      processGroups: group.service,
      sleep: async () => {},
    });
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);
    const observedAt = new Date().toISOString();
    writeRunnerStateV2(manager, job.jobId, group.leader, "awaiting_permit", observedAt);
    await waitForPhase(manager, job.jobId, "awaiting_user");
    // The real runner rewrites the state sidecar to stage=running with the
    // SAME observedAt before executing, and the probe refusal happens AFTER
    // the permit — replicate both so the result binds to the durable permit.
    writeRunnerStateV2(manager, job.jobId, group.leader, "running", observedAt);
    const permitIssuedAt = manager.status({ jobId: job.jobId }).execution?.permitIssuedAt ?? null;
    writeRunnerResultV2(manager, job.jobId, {
      commandStarted: false,
      errorCode: "device_auth_unsupported",
      exitCode: null,
      permitIssuedAt,
    });
    await waitForTerminal(manager, job.jobId);
    const done = manager.status({ jobId: job.jobId });
    expect(done.state).toBe("not_supported");
    expect(done.outcome?.reason).toBe("not_supported");
    expect(done.message).toContain("--browser-redirect");
    await manager.shutdown();
  });

  it.each([
    ["terminal_transport_unavailable", "not_supported", "not_supported"],
    ["terminal_transport_unsupported", "not_supported", "not_supported"],
    ["terminal_transport_probe_failed", "failed", "launch_failed"],
    ["terminal_transport_failed", "failed", "launch_failed"],
  ] as const)(
    "maps a pre-vendor %s receipt to its exact durable outcome",
    async (errorCode, expectedState, expectedReason) => {
      const group = processGroupFixture({ leader: knownLeader(160) });
      const manager = createSetupJobManager({
        store: new SetupJobStore(join(root, `terminal-receipt-${errorCode}`)),
        rootDir: join(root, `terminal-receipt-${errorCode}`),
        platform: "darwin",
        runnerPath: "/tmp/setup-login-runner.js",
        openTerminal: fakeOpener,
        monitorPollMs: 1,
        processGroups: group.service,
      });
      await manager.start();
      const job = manager.create(LOGIN_REQUEST);
      const observedAt = new Date().toISOString();
      writeRunnerStateV2(manager, job.jobId, group.leader, "awaiting_permit", observedAt);
      await waitForPhase(manager, job.jobId, "awaiting_user");
      writeRunnerStateV2(manager, job.jobId, group.leader, "running", observedAt);
      const permitIssuedAt = manager.status({ jobId: job.jobId }).execution?.permitIssuedAt ?? null;
      writeRunnerResultV2(manager, job.jobId, {
        commandStarted: false,
        errorCode,
        exitCode: null,
        permitIssuedAt,
      });
      expect(await waitForTerminal(manager, job.jobId)).toBe(expectedState);
      expect(manager.status({ jobId: job.jobId })).toMatchObject({
        state: expectedState,
        outcome: { reason: expectedReason },
        nativeCommand: { commandStarted: false, errorCode },
      });
      await manager.shutdown();
    },
  );

  it("keeps a post-start terminal transport break distinct from vendor spawn", async () => {
    const group = processGroupFixture({ leader: knownLeader(161) });
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "terminal-receipt-post-start")),
      rootDir: join(root, "terminal-receipt-post-start"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      monitorPollMs: 1,
      processGroups: group.service,
    });
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);
    const observedAt = new Date().toISOString();
    writeRunnerStateV2(manager, job.jobId, group.leader, "awaiting_permit", observedAt);
    await waitForPhase(manager, job.jobId, "awaiting_user");
    writeRunnerStateV2(manager, job.jobId, group.leader, "running", observedAt);
    writeRunnerResultV2(manager, job.jobId, {
      commandStarted: true,
      errorCode: "terminal_transport_failed",
      exitCode: null,
    });
    expect(await waitForTerminal(manager, job.jobId)).toBe("failed");
    expect(manager.status({ jobId: job.jobId })).toMatchObject({
      outcome: { reason: "command_failed" },
      nativeCommand: { commandStarted: true, errorCode: "terminal_transport_failed" },
    });
    expect(manager.status({ jobId: job.jobId }).message).toContain(
      "terminal transport failed after the vendor command started",
    );
    await manager.shutdown();
  });

  it("never offers the macOS-only Terminal handoff off macOS", async () => {
    // The remedy names `--browser-redirect`, which startObservableLogin refuses
    // unless the daemon runs on macOS. Windows reaches this message now that
    // the daemon-hosted login works there, so it must not be advertised.
    const group = processGroupFixture({ leader: knownLeader(107) });
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "device-auth-unsupported-linux")),
      rootDir: join(root, "device-auth-unsupported-linux"),
      platform: "linux",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      // The device-code flow launches the runner via spawn (no Terminal); the
      // fake stays alive so the state machine is driven by the sidecars below.
      spawn: (() => fakeOpener()) as unknown as typeof import("node:child_process").spawn,
      monitorPollMs: 1,
      processGroups: group.service,
      sleep: async () => {},
    });
    await manager.start();
    // The device-code flow is the daemon-hosted one that works off macOS.
    const job = manager.create(DEVICE_CODE_REQUEST);
    const observedAt = new Date().toISOString();
    writeRunnerStateV2(manager, job.jobId, group.leader, "awaiting_permit", observedAt);
    await waitForPhase(manager, job.jobId, "awaiting_user");
    writeRunnerStateV2(manager, job.jobId, group.leader, "running", observedAt);
    const permitIssuedAt = manager.status({ jobId: job.jobId }).execution?.permitIssuedAt ?? null;
    writeRunnerResultV2(manager, job.jobId, {
      commandStarted: false,
      errorCode: "device_auth_unsupported",
      exitCode: null,
      permitIssuedAt,
    });
    await waitForTerminal(manager, job.jobId);
    const done = manager.status({ jobId: job.jobId });
    expect(done.state).toBe("not_supported");
    expect(done.message).toContain("upgrade the codex CLI");
    expect(done.message).not.toContain("--browser-redirect");
    await manager.shutdown();
  });

  it("seals the daemon-resolved default native store into a default-lane login manifest", async () => {
    // Hit live 2026-08-04: the detached login worker re-derived the codex home
    // from its own bootstrap env, which drops CLAUDEXOR_CONFIG_DIR — so
    // credentials landed in the GLOBAL default store while verification polled
    // the daemon's, and a successful login reported "not ready". The manifest
    // is now the single carrier of the target store for DEFAULT jobs too,
    // resolved by the daemon whose config root is authoritative.
    process.env.CLAUDEXOR_CONFIG_DIR = join(root, "daemon-owned-config");
    const group = processGroupFixture();
    const capability = capabilityVerifier();
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "default-store-manifest")),
      rootDir: join(root, "default-store-manifest"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      spawn: (() => fakeOpener()) as unknown as typeof import("node:child_process").spawn,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      probeAuthSource: async () => nativeReadiness(true),
    });
    await manager.start();
    const job = manager.create(DEVICE_CODE_REQUEST);
    const manifest = readLoginManifest(manager._store.paths(job.jobId).manifest);
    expect(manifest.profileConfigDir).toBe(join(root, "daemon-owned-config", "native", "codex"));
    await manager.shutdown();
  });

  it("a failed device-auth login message carries the toggle remedy", async () => {
    // The default codex login authorizes the --device-auth flow. A started
    // command that exits nonzero (e.g. the sign-in page rejected the one-time
    // code) must ALWAYS carry the deterministic toggle remedy, keyed on the
    // authorized flow — not classified from the vendor's rejection prose.
    const group = processGroupFixture();
    const capability = capabilityVerifier();
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "device-auth-remedy")),
      rootDir: join(root, "device-auth-remedy"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      // The device-code flow launches the runner via spawn (no Terminal); the
      // fake stays alive so the state machine is driven by the sidecars below.
      spawn: (() => fakeOpener()) as unknown as typeof import("node:child_process").spawn,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      probeAuthSource: async () => nativeReadiness(true),
    });
    await manager.start();
    const job = manager.create(DEVICE_CODE_REQUEST);
    const observedAt = new Date().toISOString();
    writeRunnerStateV2(manager, job.jobId, group.leader, "awaiting_permit", observedAt);
    await waitForPhase(manager, job.jobId, "awaiting_user");
    writeRunnerStateV2(manager, job.jobId, group.leader, "running", observedAt);
    writeRunnerResultV2(manager, job.jobId, { commandStarted: true, exitCode: 1 });
    expect(await waitForTerminal(manager, job.jobId)).toBe("failed");
    const done = manager.status({ jobId: job.jobId });
    expect(done.outcome?.reason).toBe("command_failed");
    expect(done.message).toContain("Allow device code login");
    expect(done.message).toContain("--browser-redirect");
    // A nonzero exit never runs the same-harness smoke.
    expect(capability.runs).toEqual([]);
    await manager.shutdown();
  });

  it("D-17 disclosure race: the sidecar landing AFTER awaiting_user emits a follow-up event so SSE clients learn the code exists", async () => {
    const group = processGroupFixture();
    const capability = capabilityVerifier();
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "device-code-disclosure-race")),
      rootDir: join(root, "device-code-disclosure-race"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      spawn: (() => fakeOpener()) as unknown as typeof import("node:child_process").spawn,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      probeAuthSource: async () => nativeReadiness(true),
    });
    await manager.start();
    const job = manager.create(DEVICE_CODE_REQUEST);
    const observedAt = new Date().toISOString();
    writeRunnerStateV2(manager, job.jobId, group.leader, "awaiting_permit", observedAt);
    await waitForPhase(manager, job.jobId, "awaiting_user");
    // At the flip the sidecar does not exist yet — the projection is empty.
    expect(
      (manager.snapshot({ jobId: job.jobId }) as { deviceCode?: unknown }).deviceCode,
    ).toBeUndefined();
    // The runner writes the disclosure a beat later.
    const store = (
      manager as unknown as { _store: { paths(id: string): { runnerDeviceCode: string } } }
    )._store;
    const auth = manager.status({ jobId: job.jobId }).authorization!;
    atomicPrivateJson(store.paths(job.jobId).runnerDeviceCode, {
      version: 2,
      jobId: job.jobId,
      executionId: auth.executionId,
      flow: "chatgptDeviceCode",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      disclosedAt: new Date().toISOString(),
    });
    // The watcher notices and bumps a message EVENT; the projection now carries the code.
    await vi.waitFor(() => {
      const snap = manager.snapshot({ jobId: job.jobId }) as {
        deviceCode?: { userCode?: string };
        job: { message: string };
      };
      expect(snap.deviceCode?.userCode).toBe("ABCD-EFGH");
      expect(snap.job.message).toContain("One-time code ready");
    });
    await manager.shutdown();
  });

  it("keeps watching for a device code through an extended journal deadline", async () => {
    let nowMs = Date.parse("2026-07-29T00:00:00.000Z");
    const group = processGroupFixture();
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "device-code-extended-disclosure"), {
        now: () => new Date(nowMs),
      }),
      rootDir: join(root, "device-code-extended-disclosure"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      spawn: (() => fakeOpener()) as unknown as typeof import("node:child_process").spawn,
      now: () => new Date(nowMs),
      loginTimeoutMs: 1_000,
      monitorPollMs: 1,
      processGroups: group.service,
    });
    await manager.start();
    const job = manager.create(DEVICE_CODE_REQUEST);
    writeRunnerStateV2(
      manager,
      job.jobId,
      group.leader,
      "awaiting_permit",
      new Date(nowMs).toISOString(),
    );
    await waitForPhase(manager, job.jobId, "awaiting_user");
    const originalDeadline = Date.parse(manager.status({ jobId: job.jobId }).deadlineAt!);
    const extended = manager.extend({ jobId: job.jobId });

    nowMs = originalDeadline + 1;
    expect(Date.parse(extended.deadlineAt!)).toBeGreaterThan(nowMs);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const manifest = readLoginManifest(manager._store.paths(job.jobId).manifest);
    atomicPrivateJson(manager._store.paths(job.jobId).runnerDeviceCode, {
      version: SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: job.jobId,
      executionId: manifest.executionId,
      flow: "chatgptDeviceCode",
      verificationUrl: "https://chatgpt.com/device",
      userCode: "EXTD-CODE",
      disclosedAt: new Date(nowMs).toISOString(),
    });

    await vi.waitFor(() => {
      expect(manager.status({ jobId: job.jobId }).message).toContain("One-time code ready");
    });
    await manager.shutdown();
  });

  it("a browser-redirect create refuses (409) while a device-code login is active", () => {
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "flow-conflict")),
      rootDir: join(root, "flow-conflict"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      spawn: (() => fakeOpener()) as unknown as typeof import("node:child_process").spawn,
    });
    // The default codex login seals the device-code (app-server) flow into its
    // authorization synchronously at create. A --browser-redirect request for the
    // same target must refuse loudly rather than be answered with the active job.
    manager.create(DEVICE_CODE_REQUEST);
    let thrown: (Error & { status?: number }) | undefined;
    try {
      manager.create({ ...DEVICE_CODE_REQUEST, loginFlow: "browser_redirect" });
    } catch (error) {
      thrown = error as Error & { status?: number };
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toMatch(/browser-redirect|device-code/);
    expect(thrown?.status).toBe(409);
  });

  it("restart consumes a result that appeared after the group emptied (TOCTOU)", async () => {
    const group = processGroupFixture({ leader: knownLeader(108) });
    const opts = {
      rootDir: join(root, "toctou-late-result"),
      platform: "darwin" as const,
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      processGroups: group.service,
      monitorPollMs: 1,
      sleep: async () => {},
    };
    const first = createSetupJobManager({
      ...opts,
      store: new SetupJobStore(join(root, "toctou-late-result")),
    });
    await first.start();
    const job = first.create(LOGIN_REQUEST);
    const observedAt = new Date().toISOString();
    writeRunnerStateV2(first, job.jobId, group.leader, "awaiting_permit", observedAt);
    await waitForPhase(first, job.jobId, "awaiting_user"); // durable permit issued
    // The worker persists a successful result bound to the issued permit, then
    // the group empties — all before the first daemon consumes it, then a crash.
    writeRunnerStateV2(first, job.jobId, group.leader, "running", observedAt);
    group.setAlive(false);
    writeRunnerResultV2(first, job.jobId);
    first.beginDrain();
    legacyJournal(first._store).close();

    const capability = capabilityVerifier();
    const restarted = createSetupJobManager({
      store: new SetupJobStore(join(root, "toctou-late-result")),
      ...opts,
      authCapabilityVerifier: capability.verifier,
      probeAuthSource: async () => nativeReadiness(true),
    });
    await restarted.start();
    // The durable receipt is consumed, NOT discarded as cancelled_on_restart.
    expect(await waitForTerminal(restarted, job.jobId)).toBe("succeeded");
    const done = restarted.status({ jobId: job.jobId });
    expect(done.outcome?.reason).not.toBe("cancelled_on_restart");
    expect(done.outcome?.reason).toBe("completed");
    await restarted.shutdown();
  });

  it("a cancelling-phase job is completed by the successor daemon", async () => {
    const group = processGroupFixture({ leader: knownLeader(109) });
    const opts = {
      rootDir: join(root, "cancelling-successor"),
      platform: "darwin" as const,
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      processGroups: group.service,
      monitorPollMs: 1,
      terminationGraceMs: 1,
      sleep: async () => {},
    };
    const first = createSetupJobManager({
      ...opts,
      store: new SetupJobStore(join(root, "cancelling-successor")),
    });
    await first.start();
    const job = first.create(LOGIN_REQUEST);
    writeRunnerStateV2(first, job.jobId, group.leader, "awaiting_permit");
    await waitForPhase(first, job.jobId, "awaiting_user");
    // A cancel began — the phase is persisted "cancelling" — but termination
    // never completed before the daemon crashed.
    first._store.update(job.jobId, {
      phase: "cancelling",
      message: "Stopping codex login (cancelled_by_user).",
    });
    first.beginDrain();
    legacyJournal(first._store).close();

    const restarted = createSetupJobManager({
      ...opts,
      store: new SetupJobStore(join(root, "cancelling-successor")),
    });
    await restarted.start();
    // The successor finishes the interrupted cancellation instead of adopting a
    // zombie: the job reaches a terminal cancelled state (not stuck active).
    expect(await waitForTerminal(restarted, job.jobId)).toBe("cancelled");
    expect(restarted.status({ jobId: job.jobId }).outcome?.reason).toBe("cancelled_by_user");
    expect(group.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await restarted.shutdown();
  });

  it("extends the deadline by exactly fifteen minutes on every call", () => {
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "store")),
      rootDir: join(root, "store"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
    });
    const job = manager.create(LOGIN_REQUEST);
    const first = manager.extend({ jobId: job.jobId });
    const second = manager.extend({ jobId: job.jobId });
    expect(Date.parse(first.deadlineAt!) - Date.parse(job.deadlineAt!)).toBe(15 * 60_000);
    expect(Date.parse(second.deadlineAt!) - Date.parse(job.deadlineAt!)).toBe(30 * 60_000);
  });
});

describe("setup jobs for credential profiles (INV-135)", () => {
  it("refuses unknown profiles at create and seals the scoped home into the manifest; dedupe is per-target", () => {
    process.env.CLAUDEXOR_CONFIG_DIR = join(root, "cfg");
    const { profile } = registerConfigDirProfile({ harnessId: "codex", profileId: "work" });
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "store")),
      rootDir: join(root, "store"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
    });
    // Typed 400s BEFORE any Terminal opens: never a login into the wrong store.
    expect(() => manager.create({ ...LOGIN_REQUEST, profileId: "ghost" })).toThrow(
      /no credential profile "ghost"/,
    );
    const job = manager.create({ ...LOGIN_REQUEST, profileId: "work" });
    expect(job.profileId).toBe("work");
    const manifest = readLoginManifest(manager._store.paths(job.jobId).manifest);
    expect(manifest.profileConfigDir).toBe(realpathSync(profile.isolation_locator!));
    // Same target → idempotent reuse; a DIFFERENT target refuses loudly
    // instead of returning a job that logs into another store.
    expect(manager.create({ ...LOGIN_REQUEST, profileId: "work" }).jobId).toBe(job.jobId);
    expect(() => manager.create(LOGIN_REQUEST)).toThrow(/another codex login job is active/);
  });

  it("refuses a default Antigravity login and never offers to extend its own window", async () => {
    process.env.CLAUDEXOR_CONFIG_DIR = join(root, "cfg-agy");
    // Hermetic like the claude/cursor fakes above: without this the test only
    // passes on a host that happens to have a real `agy` on PATH.
    const oldAgyBin = process.env.CLAUDEXOR_AGY_BIN;
    const fakeAgy = join(root, "fake-agy");
    writeFileSync(fakeAgy, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(fakeAgy, 0o700);
    process.env.CLAUDEXOR_AGY_BIN = fakeAgy;
    registerConfigDirProfile({ harnessId: "agy", profileId: "work" });
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "store-agy")),
      rootDir: join(root, "store-agy"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
    });
    const AGY_LOGIN = { harness: "agy", action: "login", authRequest: "subscription" } as const;
    // agy has NO default binding store, so a profile-less login is refused at
    // create time rather than targeting vendor state at the daemon's HOME.
    expect(() => manager.create(AGY_LOGIN)).toThrow(/no default credential store/);

    const job = manager.create({ ...AGY_LOGIN, profileId: "work" });
    // The deadline is the VENDOR's 60s window, published as fixed so no
    // surface offers to extend a window the vendor will not honor.
    expect(job.deadlineFixed).toBe(true);
    const window = Date.parse(job.deadlineAt!) - Date.parse(job.createdAt);
    expect(window).toBeGreaterThan(0);
    expect(window).toBeLessThanOrEqual(61_000);
    expect(() => manager.extend({ jobId: job.jobId })).toThrow(/cannot be extended/);
    await manager.shutdown();
    if (oldAgyBin === undefined) delete process.env.CLAUDEXOR_AGY_BIN;
    else process.env.CLAUDEXOR_AGY_BIN = oldAgyBin;
  });

  it("resolveLoginProfileBinding (K.4): claude/codex profile-less logins stay unbound with a best-effort bootstrap row, cursor binds to cursor-default, explicit ids pass through", () => {
    process.env.CLAUDEXOR_CONFIG_DIR = join(root, "cfg-login-binding");
    const registry = () => loadConfig(noProjectRepoRoot()).global.credential_profiles;

    // (a) codex profile-less login: null binding (the default-store job runs
    // as before) plus a best-effort cold bootstrap row at the exact native
    // dir the job targets.
    expect(resolveLoginProfileBinding("codex", "login", undefined)).toBeNull();
    expect(registry()).toContainEqual(
      expect.objectContaining({
        profile_id: "codex-default",
        harness_id: "codex",
        isolation_locator: defaultNativeCodexHome(),
      }),
    );

    // A bootstrap-registration failure never blocks the login: a plain FILE
    // squatting the claude native dir makes ensureBootstrapProfile's mkdir
    // throw, yet the binding is still the ordinary null default-store branch
    // and no half-registered row appears.
    const claudeDir = defaultNativeClaudeConfigDir();
    mkdirSync(join(claudeDir, ".."), { recursive: true });
    writeFileSync(claudeDir, "not a directory");
    expect(resolveLoginProfileBinding("claude", "login", undefined)).toBeNull();
    expect(registry().some((p) => p.harness_id === "claude")).toBe(false);

    // (b) cursor has no default store (D-U3): the profile-less login
    // auto-binds to the isolated cursor-default bootstrap row.
    const cursorBinding = resolveLoginProfileBinding("cursor", "login", undefined);
    expect(cursorBinding?.profileId).toBe("cursor-default");
    const cursorRow = registry().find((p) => p.harness_id === "cursor");
    expect(cursorBinding?.configDir).toBe(realpathSync(cursorRow!.isolation_locator!));

    // (c) an explicit profile id resolves exactly as before — no bootstrap
    // sugar, the binding is the registered profile's own scoped home.
    const { profile } = registerConfigDirProfile({ harnessId: "codex", profileId: "work" });
    expect(resolveLoginProfileBinding("codex", "login", "work")).toEqual({
      profileId: "work",
      configDir: realpathSync(profile.isolation_locator!),
      credentialPolicy: {
        identity_scope: "profile",
        max_enabled_profiles: null,
        cleanup_owner: "claudexor",
      },
    });
  });

  it("binds a cursor profile login to its canonical Claudexor-owned HOME (valentine)", () => {
    process.env.CLAUDEXOR_CONFIG_DIR = join(root, "cfg");
    const { profile } = registerConfigDirProfile({ harnessId: "cursor", profileId: "valentine" });
    const binding = resolveProfileBinding("cursor", "valentine");
    expect(binding?.profileId).toBe("valentine");
    expect(binding?.configDir).toBe(realpathSync(profile.isolation_locator!));
  });

  it("default-store jobs seal the daemon-resolved default store (field stays optional for pre-upgrade digests)", () => {
    // Hit live 2026-08-04: leaving the default lane's target store implicit
    // let the detached worker re-derive it from an env without the daemon's
    // CLAUDEXOR_CONFIG_DIR, splitting the login and verification stores. The
    // schema field remains OPTIONAL, so pre-upgrade sealed manifests (absent
    // field) keep their digests valid — only newly sealed manifests carry it.
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "store")),
      rootDir: join(root, "store"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
    });
    const job = manager.create(LOGIN_REQUEST);
    expect(job.profileId).toBeNull();
    const manifest = readLoginManifest(manager._store.paths(job.jobId).manifest);
    expect(manifest.profileConfigDir).toBe(defaultNativeCodexHome());
  });

  it("verifies a profile job via ITS doctor probe and honestly skips the default-route capability smoke", async () => {
    process.env.CLAUDEXOR_CONFIG_DIR = join(root, "cfg");
    registerConfigDirProfile({ harnessId: "codex", profileId: "work" });
    let ms = Date.now();
    const profileProbes: Array<[string, string]> = [];
    const invalidatedHarnesses: string[] = [];
    const group = processGroupFixture();
    const capability = capabilityVerifier(() => new Date(ms));
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "store"), { now: () => new Date(ms) }),
      rootDir: join(root, "store"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      now: () => new Date(ms),
      verifyTimeoutMs: 5,
      verifyPollMs: 2,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      onCredentialStateMayHaveChanged: (harness) => invalidatedHarnesses.push(harness),
      sleep: async (delay) => {
        ms += delay;
      },
      probeAuthSource: async () => {
        throw new Error("a profile job must NEVER probe the default native session");
      },
      probeCredentialProfile: async (harness, profileId) => {
        profileProbes.push([harness, profileId]);
        return {
          profile_id: profileId,
          harness_id: harness,
          availability: "available",
          verification: "passed",
          verification_source: "local_store",
          detail: "chatgpt login in scoped home",
          last_verified_at: new Date(ms).toISOString(),
        };
      },
    });
    await manager.start();
    const job = manager.create({ ...LOGIN_REQUEST, profileId: "work" });
    await permitAndFinishNativeCommand(
      manager,
      job.jobId,
      group.leader,
      new Date(ms).toISOString(),
    );
    expect(await waitForTerminal(manager, job.jobId)).toBe("succeeded");
    expect(profileProbes).toEqual([["codex", "work"]]);
    expect(invalidatedHarnesses).toEqual(["codex", "codex"]); // window entry + close
    // The smoke attests the DEFAULT route only — a scoped profile job must
    // not spend quota on it, and the lifecycle honestly stays disclosed.
    expect(capability.runs).toHaveLength(0);
    const done = manager.status({ jobId: job.jobId });
    expect(done).toMatchObject({
      profileId: "work",
      outcome: { reason: "completed", exitCode: 0, signal: null },
      authCapability: { state: "disclosed" },
    });
    expect(done.message).toContain('profile "work"');
    expect(done.message).toContain("smoke");
    await manager.shutdown();
  });

  it("fails honestly when the profile probe never verifies", async () => {
    process.env.CLAUDEXOR_CONFIG_DIR = join(root, "cfg");
    registerConfigDirProfile({ harnessId: "codex", profileId: "work" });
    let ms = Date.now();
    const group = processGroupFixture();
    const capability = capabilityVerifier(() => new Date(ms));
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "store"), { now: () => new Date(ms) }),
      rootDir: join(root, "store"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      now: () => new Date(ms),
      verifyTimeoutMs: 5,
      verifyPollMs: 2,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      sleep: async (delay) => {
        ms += delay;
      },
      probeAuthSource: async () => {
        throw new Error("a profile job must NEVER probe the default native session");
      },
      probeCredentialProfile: async (harness, profileId) => ({
        profile_id: profileId,
        harness_id: harness,
        availability: "unavailable",
        verification: "not_run",
        verification_source: "local_store",
        detail: "logged out",
        last_verified_at: null,
      }),
    });
    await manager.start();
    const job = manager.create({ ...LOGIN_REQUEST, profileId: "work" });
    await permitAndFinishNativeCommand(
      manager,
      job.jobId,
      group.leader,
      new Date(ms).toISOString(),
    );
    expect(await waitForTerminal(manager, job.jobId)).toBe("failed");
    const done = manager.status({ jobId: job.jobId });
    expect(done.outcome?.reason).toBe("auth_not_ready");
    expect(done.message).toContain('profile "work"');
    expect(capability.runs).toHaveLength(0);
    await manager.shutdown();
  });
});

describe("D-17 codex device-code login", () => {
  function writeDeviceCodeSidecar(
    manager: SetupManager,
    jobId: string,
    disclosure: {
      flow?: "chatgptDeviceCode" | "chatgpt";
      verificationUrl?: string;
      userCode?: string;
    } = {},
  ): void {
    const manifest = readLoginManifest(manager._store.paths(jobId).manifest);
    atomicPrivateJson(manager._store.paths(jobId).runnerDeviceCode, {
      version: SETUP_LOGIN_PROTOCOL_VERSION,
      jobId,
      executionId: manifest.executionId,
      flow: disclosure.flow ?? "chatgptDeviceCode",
      verificationUrl: disclosure.verificationUrl ?? "https://chatgpt.com/device",
      userCode: disclosure.userCode ?? "WXYZ-7788",
      disclosedAt: new Date().toISOString(),
    });
  }

  it("launches the runner detached (never Terminal) and seals the device-code flow", async () => {
    const group = processGroupFixture();
    let terminalOpened = 0;
    let runnerSpawned = 0;
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "device-launch")),
      rootDir: join(root, "device-launch"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: () => {
        terminalOpened += 1;
        return fakeOpener();
      },
      spawn: ((..._args: unknown[]) => {
        runnerSpawned += 1;
        return fakeOpener();
      }) as unknown as typeof import("node:child_process").spawn,
      monitorPollMs: 1,
      processGroups: group.service,
    });
    await manager.start();
    const job = manager.create(DEVICE_CODE_REQUEST);
    // The app-server flow is sealed into the authorization argv, and the runner
    // is launched with spawn — never the Terminal opener.
    expect(job.authorization?.args).toContain("app-server");
    expect(terminalOpened).toBe(0);
    expect(runnerSpawned).toBe(1);
    writeRunnerStateV2(manager, job.jobId, group.leader, "awaiting_permit");
    await waitForPhase(manager, job.jobId, "awaiting_user");
    const awaiting = manager.status({ jobId: job.jobId });
    expect(awaiting.message).toMatch(/one-time code/);
    expect(awaiting.message).not.toMatch(/Terminal/);
    await manager.shutdown();
  });

  it("projects the transient code on the snapshot but never in the journaled job", async () => {
    const group = processGroupFixture();
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "device-projection")),
      rootDir: join(root, "device-projection"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      spawn: (() => fakeOpener()) as unknown as typeof import("node:child_process").spawn,
      monitorPollMs: 1,
      processGroups: group.service,
    });
    await manager.start();
    const job = manager.create(DEVICE_CODE_REQUEST);
    writeRunnerStateV2(manager, job.jobId, group.leader, "awaiting_permit");
    await waitForPhase(manager, job.jobId, "awaiting_user");
    writeDeviceCodeSidecar(manager, job.jobId, { userCode: "SECRET-CODE-42" });

    const snapshot = manager.snapshot({ jobId: job.jobId });
    expect(snapshot.deviceCode).toEqual({
      flow: "chatgptDeviceCode",
      verificationUrl: "https://chatgpt.com/device",
      userCode: "SECRET-CODE-42",
    });
    // The journaled job carries NO device-code field.
    expect((snapshot.job as unknown as Record<string, unknown>).deviceCode).toBeUndefined();
    expect(JSON.stringify(snapshot.job)).not.toContain("SECRET-CODE-42");

    // The one-time code must never appear anywhere in the durable journal.
    const journalDump = [...legacyJournal(manager._store).records()]
      .map((record) => JSON.stringify(record))
      .join("\n");
    expect(journalDump).not.toContain("SECRET-CODE-42");
    await manager.shutdown();
  });

  it("stops projecting the code once the login is terminal (sidecar removed)", async () => {
    const group = processGroupFixture();
    const capability = capabilityVerifier();
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "device-terminal")),
      rootDir: join(root, "device-terminal"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      spawn: (() => fakeOpener()) as unknown as typeof import("node:child_process").spawn,
      monitorPollMs: 1,
      processGroups: group.service,
      authCapabilityVerifier: capability.verifier,
      probeAuthSource: async () => nativeReadiness(true),
    });
    await manager.start();
    const job = manager.create(DEVICE_CODE_REQUEST);
    const observedAt = new Date().toISOString();
    writeRunnerStateV2(manager, job.jobId, group.leader, "awaiting_permit", observedAt);
    await waitForPhase(manager, job.jobId, "awaiting_user");
    writeDeviceCodeSidecar(manager, job.jobId);
    expect(manager.snapshot({ jobId: job.jobId }).deviceCode).toBeDefined();
    writeRunnerStateV2(manager, job.jobId, group.leader, "running", observedAt);
    writeRunnerResultV2(manager, job.jobId, { commandStarted: true, exitCode: 0 });
    expect(await waitForTerminal(manager, job.jobId)).toBe("succeeded");
    // The transient sidecar was removed on terminalization → no projection.
    expect(manager.snapshot({ jobId: job.jobId }).deviceCode).toBeUndefined();
    await manager.shutdown();
  });

  it("a capability-probe miss finishes not_supported (typed Terminal fallback)", async () => {
    const group = processGroupFixture();
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "device-unsupported")),
      rootDir: join(root, "device-unsupported"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      spawn: (() => fakeOpener()) as unknown as typeof import("node:child_process").spawn,
      monitorPollMs: 1,
      processGroups: group.service,
    });
    await manager.start();
    const job = manager.create(DEVICE_CODE_REQUEST);
    const observedAt = new Date().toISOString();
    writeRunnerStateV2(manager, job.jobId, group.leader, "awaiting_permit", observedAt);
    await waitForPhase(manager, job.jobId, "awaiting_user");
    writeRunnerStateV2(manager, job.jobId, group.leader, "running", observedAt);
    // The runner reports the app-server lacked the auth methods. Like the real
    // runner, it carries the durable permit timestamp it ran under.
    writeRunnerResultV2(manager, job.jobId, {
      commandStarted: false,
      exitCode: null,
      errorCode: "device_auth_unsupported",
      permitIssuedAt: manager.status({ jobId: job.jobId }).execution?.permitIssuedAt ?? null,
    });
    expect(await waitForTerminal(manager, job.jobId)).toBe("not_supported");
    const done = manager.status({ jobId: job.jobId });
    expect(done.outcome?.reason).toBe("not_supported");
    expect(done.message).toMatch(/browser-redirect/);
    // Audit point 8: the specific typed code rides the native-command receipt
    // consistently (runner result → journaled receipt → control DTO → Swift/CLI
    // read it), while the coarse outcome stays not_supported.
    expect(done.nativeCommand?.errorCode).toBe("device_auth_unsupported");
    expect(done.nativeCommand?.commandStarted).toBe(false);
    await manager.shutdown();
  });
});

describe("one-shot sign-in input (url_disclosure_with_input, owner directive 2026-08-04)", () => {
  const CLAUDE_LOGIN = { harness: "claude", action: "login", authRequest: "subscription" } as const;
  const CURSOR_LOGIN = { harness: "cursor", action: "login", authRequest: "subscription" } as const;

  // Hermetic like the file-level fake codex: without these, create() resolves
  // the real host `claude`/`cursor-agent`, and on a host without them the job
  // finishes not_supported before input() — the state guard then fires instead
  // of the flow-type guard (exactly the GitHub-runner failure of run
  // 31090176293). The tests here assert guard semantics, not host installs.
  let oldClaudeBin: string | undefined;
  let oldCursorBin: string | undefined;

  beforeEach(() => {
    oldClaudeBin = process.env.CLAUDEXOR_CLAUDE_BIN;
    oldCursorBin = process.env.CLAUDEXOR_CURSOR_BIN;
    for (const [envKey, name] of [
      ["CLAUDEXOR_CLAUDE_BIN", "fake-claude"],
      ["CLAUDEXOR_CURSOR_BIN", "fake-cursor-agent"],
    ] as const) {
      const binary = join(root, name);
      writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      chmodSync(binary, 0o700);
      process.env[envKey] = binary;
    }
  });

  afterEach(() => {
    if (oldClaudeBin === undefined) delete process.env.CLAUDEXOR_CLAUDE_BIN;
    else process.env.CLAUDEXOR_CLAUDE_BIN = oldClaudeBin;
    if (oldCursorBin === undefined) delete process.env.CLAUDEXOR_CURSOR_BIN;
    else process.env.CLAUDEXOR_CURSOR_BIN = oldCursorBin;
  });

  it("writes the transient input sidecar exactly once and never journals the value", async () => {
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "input-happy")),
      rootDir: join(root, "input-happy"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
    });
    await manager.start();
    const job = manager.create(CLAUDE_LOGIN);
    const updated = manager.input({ jobId: job.jobId, value: "pasted-code-7" });
    expect(updated.message).toContain("sign-in input received");
    const sidecar = readFileSync(manager._store.paths(job.jobId).runnerInput, "utf8");
    expect(JSON.parse(sidecar)).toMatchObject({
      jobId: job.jobId,
      value: "pasted-code-7",
    });
    // One-shot: the second submission conflicts instead of replacing.
    expect(() => manager.input({ jobId: job.jobId, value: "other" })).toThrowError(
      /already submitted/,
    );
    // The value exists ONLY in the 0600 sidecar: never in the journaled job.
    const journalled = JSON.stringify(manager.status({ jobId: job.jobId }));
    expect(journalled).not.toContain("pasted-code-7");
    await manager.shutdown();
  });

  it("gives the token exchange its own window, so the clock cannot kill a delivered code", async () => {
    // The vendor's window bounds how long the USER had to paste; the exchange
    // that follows is a different thing. Without this the deadline monitor
    // SIGKILLs the vendor mid-exchange — and against a sixty-second window the
    // user is racing that clock, so a successful paste being cancelled is the
    // COMMON case, not an edge one.
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "input-grace")),
      rootDir: join(root, "input-grace"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      loginTimeoutMs: 60_000,
    });
    await manager.start();
    const job = manager.create(CLAUDE_LOGIN);
    const before = Date.parse(job.deadlineAt!);
    expect(before - Date.parse(job.createdAt)).toBeLessThanOrEqual(61_000);
    const updated = manager.input({ jobId: job.jobId, value: "pasted-code-9" });
    expect(Date.parse(updated.deadlineAt!)).toBeGreaterThan(before);
    // And the extended deadline is no longer the vendor's own, so a surface
    // may offer to extend it again rather than refusing.
    expect(updated.deadlineFixed).toBe(false);
    await manager.shutdown();
  });

  it("rejects input for flows that do not take it (cursor url_disclosure, codex device-code)", async () => {
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "input-wrong-mode")),
      rootDir: join(root, "input-wrong-mode"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
    });
    await manager.start();
    const cursorJob = manager.create(CURSOR_LOGIN);
    expect(() => manager.input({ jobId: cursorJob.jobId, value: "x" })).toThrowError(
      /does not accept sign-in input/,
    );
    const codexJob = manager.create(DEVICE_CODE_REQUEST);
    expect(() => manager.input({ jobId: codexJob.jobId, value: "x" })).toThrowError(
      /does not accept sign-in input/,
    );
    await manager.shutdown();
  });

  it("rejects malformed values before touching the job", async () => {
    const manager = createSetupJobManager({
      store: new SetupJobStore(join(root, "input-malformed")),
      rootDir: join(root, "input-malformed"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
    });
    await manager.start();
    const job = manager.create(CLAUDE_LOGIN);
    expect(() => manager.input({ jobId: job.jobId, value: "" })).toThrow();
    expect(() => manager.input({ jobId: job.jobId, value: "y".repeat(2000) })).toThrow();
    expect(existsSync(manager._store.paths(job.jobId).runnerInput)).toBe(false);
    await manager.shutdown();
  });
});

describe("setup credential-mutation window (#363)", () => {
  const permitted = { permitIssuedAt: "2026-09-30T00:00:01.000Z" } as never;
  it.each([
    ["an active job before its permit", { state: "waiting_for_input" }, false],
    ["an active job holding a permit", { state: "running", execution: permitted }, true],
    ["a job that ended with proof", { state: "succeeded", execution: permitted }, false],
    [
      "an unconfirmed termination after a permit",
      {
        state: "failed",
        execution: permitted,
        outcome: { reason: "termination_unconfirmed" },
      },
      true,
    ],
    [
      "an unconfirmed termination later proven empty",
      {
        state: "failed",
        execution: permitted,
        outcome: { reason: "termination_unconfirmed" },
        terminationReconciliation: { status: "empty", observedAt: "2026-09-30T00:00:02.000Z" },
      },
      false,
    ],
    [
      "an unconfirmed termination before any permit",
      { state: "failed", outcome: { reason: "termination_unconfirmed" } },
      false,
    ],
  ])("%s → open=%s", (_label, job, open) => {
    expect(CredentialWindow.credentialMutationWindowOpenFor(job as never)).toBe(open);
  });

  function windowedManager(
    rootDir: string,
    group: ReturnType<typeof processGroupFixture>,
    extra = {},
  ) {
    const bumps: string[] = [];
    const manager = createSetupJobManager({
      store: new SetupJobStore(rootDir),
      rootDir,
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      monitorPollMs: 1,
      terminationGraceMs: 5,
      processGroups: group.service,
      onCredentialStateMayHaveChanged: (harness) => bumps.push(harness),
      ...extra,
    });
    return { manager, bumps };
  }

  it("an unknown surviving vendor keeps the window open until a reconciliation proves it empty", async () => {
    const leader = knownLeader(71);
    const group = processGroupFixture({ leader });
    const { manager, bumps } = windowedManager(join(root, "window-unconfirmed"), group);
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);
    expect(manager.credentialMutationOpen("codex")).toBe(false);
    writeRunnerStateV2(manager, job.jobId, leader);
    await waitForPhase(manager, job.jobId, "awaiting_user");
    expect(manager.credentialMutationOpen("codex")).toBe(true);
    expect(manager.credentialMutationOpen("cursor")).toBe(false);
    expect(bumps).toEqual(["codex"]);
    // The leader's identity can no longer be proven: nothing may be signalled
    // and the group is not proven empty — the vendor may survive.
    group.setObserved(knownLeader(71, "darwin:1710000009:000071"));
    const stopped = await manager.cancel({ jobId: job.jobId });
    expect(stopped.outcome?.reason).toBe("termination_unconfirmed");
    expect(manager.credentialMutationOpen("codex")).toBe(true);
    expect(bumps).toEqual(["codex"]);
    expect(() => manager.reconcile({ jobId: job.jobId })).toThrow(/not proven empty/);
    expect(manager.credentialMutationOpen("codex")).toBe(true);
    group.setAlive(false);
    manager.reconcile({ jobId: job.jobId });
    expect(manager.credentialMutationOpen("codex")).toBe(false);
    expect(bumps).toEqual(["codex", "codex"]);
    await manager.shutdown();
  });

  it("a deadline never closes the window: an expired login whose termination is unproven stays open", async () => {
    let nowMs = Date.parse("2026-09-30T00:00:00.000Z");
    const leader = knownLeader(72);
    const group = processGroupFixture({ leader });
    const { manager, bumps } = windowedManager(join(root, "window-deadline"), group, {
      now: () => new Date(nowMs),
      loginTimeoutMs: 60_000,
    });
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);
    writeRunnerStateV2(
      manager,
      job.jobId,
      leader,
      "awaiting_permit",
      new Date(nowMs).toISOString(),
    );
    await waitForPhase(manager, job.jobId, "awaiting_user");
    group.setObserved({
      status: "unknown",
      pid: 72,
      platform: "darwin",
      reason: "permission_denied",
    });
    nowMs = Date.parse(job.deadlineAt!) + 1;
    expect(await waitForTerminal(manager, job.jobId)).toBe("failed");
    expect(manager.status({ jobId: job.jobId }).outcome?.reason).toBe("termination_unconfirmed");
    expect(manager.credentialMutationOpen("codex")).toBe(true);
    expect(bumps).toEqual(["codex"]);
    await manager.shutdown();
  });

  it("a restart that cannot re-prove the worker keeps the window open and invalidates nothing new", async () => {
    const storeRoot = join(root, "window-restart");
    const leader = knownLeader(73);
    const group = processGroupFixture({ leader });
    const first = windowedManager(storeRoot, group);
    await first.manager.start();
    const job = first.manager.create(LOGIN_REQUEST);
    writeRunnerStateV2(first.manager, job.jobId, leader);
    await waitForPhase(first.manager, job.jobId, "awaiting_user");
    expect(first.bumps).toEqual(["codex"]);
    group.setObserved({
      status: "unknown",
      pid: 73,
      platform: "darwin",
      reason: "permission_denied",
    });
    await first.manager.shutdown();
    legacyJournal(first.manager._store).close();
    const successor = windowedManager(storeRoot, group);
    await successor.manager.start();
    expect(successor.manager.status({ jobId: job.jobId }).outcome?.reason).toBe(
      "termination_unconfirmed",
    );
    expect(successor.manager.credentialMutationOpen("codex")).toBe(true);
    expect(successor.bumps).toEqual([]);
    await successor.manager.shutdown();
  });

  it("an unreadable setup journal proves nothing closed: every harness reads open", () => {
    const storeRoot = join(root, "window-corrupt");
    const store = new SetupJobStore(storeRoot);
    store.journal.append("setup.job.saved", { job: { jobId: "not-a-valid-setup-job" } });
    store.journal.close();
    const reopened = new SetupJobStore(storeRoot);
    expect(reopened.recoveryState().status).toBe("recovery_required");
    expect(() => CredentialWindow.open(reopened, "cursor")).toThrow(/requires recovery/);
    bindCredentialMutationWindow((harness) => CredentialWindow.open(reopened, harness));
    try {
      expect(credentialMutationWindowOpen("cursor")).toBe(true);
      expect(credentialMutationWindowOpen()).toBe(true);
    } finally {
      bindCredentialMutationWindow(null);
    }
    expect(credentialMutationWindowOpen("cursor")).toBe(false);
    reopened.journal.close();
  });
});
