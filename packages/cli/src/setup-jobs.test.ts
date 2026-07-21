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
} from "@claudexor/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  atomicPrivateJson,
  readLoginManifest,
  readRunnerResult,
  SETUP_LOGIN_PROTOCOL_VERSION,
} from "./setup-login-protocol.js";
import { registerConfigDirProfile } from "./profile-registration.js";
import { resolveSetupLoginRunnerPath } from "./setup-job-support.js";
import { createSetupJobManager } from "./setup-jobs.js";

let root: string;
let codexBinary: string;
let oldCodexBin: string | undefined;

const LOGIN_REQUEST = { harness: "codex", action: "login", authRequest: "subscription" } as const;

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
    errorCode?: "permit_timeout" | "spawn_failed";
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
  process.env.CLAUDEXOR_CODEX_BIN = codexBinary;
});

afterEach(() => {
  if (oldCodexBin === undefined) delete process.env.CLAUDEXOR_CODEX_BIN;
  else process.env.CLAUDEXOR_CODEX_BIN = oldCodexBin;
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

  it("fences late opener callbacks and journal writes once shutdown begins", async () => {
    const opener = fakeOpener();
    const manager = createSetupJobManager({
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

    manager._store.journal.close();
    const journalAtShutdown = readFileSync(manager._store.journal.path);
    expect(() => opener.emit("error", new Error("late LaunchServices failure"))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readFileSync(manager._store.journal.path)).toEqual(journalAtShutdown);
  });

  it("reaches a fully drained supervisor with an active login present (no termination on shutdown)", async () => {
    const opener = fakeOpener();
    const manager = createSetupJobManager({
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
    manager._store.journal.close();
    const journalAtShutdown = readFileSync(manager._store.journal.path);
    expect(() => opener.emit("error", new Error("late opener failure"))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readFileSync(manager._store.journal.path)).toEqual(journalAtShutdown);
  });

  it("moves a launched runner to awaiting_user and enforces the launcher watchdog", async () => {
    let ms = Date.now();
    const liveGroup = processGroupFixture({ leader: knownLeader(11), killOnTerm: true });
    const live = createSetupJobManager({
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
    expect(invalidatedHarnesses).toEqual(["codex"]);
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
      expect(invalidatedHarnesses).toEqual(["codex"]);
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
      expectedInvalidations: ["codex"],
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
    expect(firstInvalidations).toEqual(["codex"]);
    await first.shutdown();
    first._store.journal.close();

    const restartedInvalidations: string[] = [];
    const restarted = createSetupJobManager({
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
    first._store.journal.close();
    const journalAtShutdown = readFileSync(first._store.journal.path);
    releaseCapability();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readFileSync(first._store.journal.path)).toEqual(journalAtShutdown);

    const replacement = capabilityVerifier();
    const restarted = createSetupJobManager({
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
    first._store.journal.close();

    const replacement = capabilityVerifier();
    const restarted = createSetupJobManager({
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
    expect(calls).toBe(15);
    expect(capability.runs).toEqual([]);
    await manager.shutdown();
  });

  it("includes probe duration and bounded polls inside the hard verification ceiling", async () => {
    let ms = Date.now();
    let calls = 0;
    const group = processGroupFixture();
    const capability = capabilityVerifier(() => new Date(ms));
    const manager = createSetupJobManager({
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
    expect(ms - started).toBe(10_000);
    expect(calls).toBe(3);
    expect(capability.runs).toEqual([]);
    await manager.shutdown();
  });

  it("rejects readiness that arrives after the verification deadline", async () => {
    let ms = Date.now();
    const group = processGroupFixture();
    const capability = capabilityVerifier(() => new Date(ms));
    const manager = createSetupJobManager({
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
    expect(await waitForTerminal(manager, job.jobId)).toBe("failed");
    expect(manager.status({ jobId: job.jobId })).toMatchObject({
      state: "failed",
      outcome: { reason: "auth_not_ready", exitCode: 0, signal: null },
    });
    expect(capability.runs).toEqual([]);
    await manager.shutdown();
  });

  it("retries fresh verification after a transient probe failure", async () => {
    let ms = Date.now();
    let calls = 0;
    const group = processGroupFixture();
    const capability = capabilityVerifier(() => new Date(ms));
    const manager = createSetupJobManager({
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
    expect(invalidatedHarnesses).toEqual(["codex"]);
    expect(group.signals).toEqual([]);
    await manager.shutdown();
  });

  it("never signals a PID-reused process when kernel start identity differs", async () => {
    const leader = knownLeader(21, "darwin:1710000000:000021");
    const group = processGroupFixture({ leader });
    const manager = createSetupJobManager({
      rootDir: join(root, "pid-reuse"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
      processGroups: group.service,
      monitorPollMs: 1,
    });
    await manager.start();
    const job = manager.create(LOGIN_REQUEST);
    writeRunnerStateV2(manager, job.jobId, leader);
    await waitForPhase(manager, job.jobId, "awaiting_user");
    group.setObserved(knownLeader(21, "darwin:1710000001:000021"));
    const result = await manager.cancel({ jobId: job.jobId });
    expect(result.outcome?.reason).toBe("termination_unconfirmed");
    expect(group.signals).toEqual([]);
    expect(manager.create(LOGIN_REQUEST).jobId).toBe(job.jobId);
    expect(() => manager.reconcile({ jobId: job.jobId })).toThrow(/not proven empty/);
    group.setObserved({ status: "missing", pid: leader.pid, platform: "darwin" });
    group.setAlive(false);
    const reconciled = manager.reconcile({ jobId: job.jobId });
    expect(reconciled).toMatchObject({
      terminationReconciliation: { status: "empty" },
    });
    expect(manager.reconcile({ jobId: job.jobId })).toEqual(reconciled);
    expect(manager.create(LOGIN_REQUEST).jobId).not.toBe(job.jobId);
    await manager.shutdown();
  });

  it.each(["cancel", "timeout"] as const)(
    "uses TERM then KILL and proves exit for login %s",
    async (kind) => {
      let ms = Date.now();
      const group = processGroupFixture({ leader: knownLeader(31) });
      const manager = createSetupJobManager({
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
    const first = createSetupJobManager(opts);
    const job = first.create(LOGIN_REQUEST);
    writeRunnerStateV2(first, job.jobId, group.leader);
    // Deliberate crash fixture: no supervisor was started, so close the sole
    // journal writer without running graceful lifecycle reconciliation.
    first.beginDrain();
    first._store.journal.close();
    const restarted = createSetupJobManager(opts);
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

  it("marks a disappeared runner interrupted on restart and ignores a mismatched result", async () => {
    const first = createSetupJobManager({
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
    first._store.journal.close();
    const restarted = createSetupJobManager({
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
    const first = createSetupJobManager(opts);
    await first.start();
    const job = first.create(LOGIN_REQUEST);
    writeRunnerStateV2(first, job.jobId, group.leader);
    await waitForPhase(first, job.jobId, "awaiting_user");
    await first.shutdown();
    expect(group.signals).toEqual([]);
    first._store.journal.close();
    const restarted = createSetupJobManager(opts);
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
    firstManager = createSetupJobManager({ ...baseOpts, processGroups: group.service });
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
    firstManager._store.journal.close();
    armed = true;
    const restarted = createSetupJobManager({ ...baseOpts, processGroups: rigged });
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
    const first = createSetupJobManager(opts);
    const job = first.create(LOGIN_REQUEST);
    writeRunnerStateV2(first, job.jobId, group.leader);
    group.setAlive(false); // the runner died while no daemon was watching
    first.beginDrain();
    first._store.journal.close();
    const restarted = createSetupJobManager(opts);
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
      first._store.journal.close();
      const restarted = createSetupJobManager({
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

  it("a failed device-auth login message carries the toggle remedy", async () => {
    // The default codex login authorizes the --device-auth flow. A started
    // command that exits nonzero (e.g. the sign-in page rejected the one-time
    // code) must ALWAYS carry the deterministic toggle remedy, keyed on the
    // authorized flow — not classified from the vendor's rejection prose.
    const group = processGroupFixture();
    const capability = capabilityVerifier();
    const manager = createSetupJobManager({
      rootDir: join(root, "device-auth-remedy"),
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

  it("a browser-redirect create refuses (409) while a device-auth login is active", () => {
    const manager = createSetupJobManager({
      rootDir: join(root, "flow-conflict"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
    });
    // The default codex login seals the device-auth flow into its authorization
    // synchronously at create. A --browser-redirect request for the same target
    // must refuse loudly rather than be answered with the active device-auth job.
    manager.create(LOGIN_REQUEST);
    let thrown: (Error & { status?: number }) | undefined;
    try {
      manager.create({ ...LOGIN_REQUEST, loginFlow: "browser_redirect" });
    } catch (error) {
      thrown = error as Error & { status?: number };
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toMatch(/browser-redirect|device-auth/);
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
    const first = createSetupJobManager(opts);
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
    first._store.journal.close();

    const capability = capabilityVerifier();
    const restarted = createSetupJobManager({
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
    const first = createSetupJobManager(opts);
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
    first._store.journal.close();

    const restarted = createSetupJobManager(opts);
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

  it("default-store jobs seal NO profileConfigDir (pre-upgrade digest compatibility)", () => {
    const manager = createSetupJobManager({
      rootDir: join(root, "store"),
      platform: "darwin",
      runnerPath: "/tmp/setup-login-runner.js",
      openTerminal: fakeOpener,
    });
    const job = manager.create(LOGIN_REQUEST);
    expect(job.profileId).toBeNull();
    const manifest = readLoginManifest(manager._store.paths(job.jobId).manifest);
    expect(manifest.profileConfigDir).toBeUndefined();
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
    expect(invalidatedHarnesses).toEqual(["codex"]);
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
