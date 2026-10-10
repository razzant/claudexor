import { SetupJobStore } from "../../daemon/src/store/test-support/fixtures/legacy/cli/setup-job-store.js";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthCapabilityVerifier,
  ProcessGroupService,
  type KnownProcessIdentity,
  type ProcessIdentity,
} from "@claudexor/core";
import type { ControlSetupJob } from "@claudexor/schema";
import * as NativeLogin from "./native-login.js";
import { registerConfigDirProfile } from "./profile-registration.js";
import { createSetupJobManager } from "./setup-jobs.js";
import { runSetupLoginWorker } from "./setup-login-runner.js";
import {
  atomicPrivateJson,
  readLoginManifest,
  readRunnerResult,
  SETUP_LOGIN_PROTOCOL_VERSION,
} from "./setup-login-protocol.js";

type Manager = ReturnType<typeof createSetupJobManager>;
let root: string;
let binary: string;
let oldConfig: string | undefined;
const managers: Manager[] = [];
const request = {
  harness: "cursor",
  action: "login",
  authRequest: "subscription",
  profileId: "recovery-fixture",
  transport: "client_pty",
} as const;
const leader: KnownProcessIdentity = {
  status: "known",
  pid: 41,
  platform: "darwin",
  source: "proc_pidinfo",
  startToken: "darwin:1710000000:000041",
  processGroupId: 41,
};

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "setup-recovery-")));
  oldConfig = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "config");
  registerConfigDirProfile({ harnessId: "cursor", profileId: request.profileId });
  binary = join(root, "fake-vendor.exe");
  writeFileSync(binary, "fixture executable before update", { mode: 0o700 });
  vi.spyOn(NativeLogin, "nativeLoginSpec").mockReturnValue({
    binary,
    args: ["login"],
    displayCommand: "fake-vendor login",
  });
});

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.shutdown();
    (manager._store as SetupJobStore).journal.close();
  }
  vi.restoreAllMocks();
  if (oldConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = oldConfig;
  rmSync(root, { recursive: true, force: true });
});

function fixture(input: { onOpen?: () => void; verify?: () => Promise<void> } = {}) {
  let observed: ProcessIdentity = leader;
  let group: "alive" | "empty" | "unknown" = "alive";
  let onProbe: (() => void) | undefined;
  const signals: NodeJS.Signals[] = [];
  const processGroups = new ProcessGroupService({
    platform: "darwin",
    identity: { read: () => observed, self: () => observed },
    probeProcessGroup: () => {
      onProbe?.();
      if (group !== "alive")
        throw Object.assign(new Error(group), {
          code: group === "empty" ? "ESRCH" : "EPERM",
        });
    },
    signalProcessGroup: (_pid, signal) => {
      signals.push(signal);
      group = "empty";
    },
  });
  const invalidations: string[] = [];
  const probe = vi.fn(async () => {
    await input.verify?.();
    return {
      profile_id: request.profileId,
      harness_id: "cursor",
      display_name: "fixture",
      credential_kind: "config_dir_login" as const,
      enabled: true,
      availability: "available" as const,
      verification: "passed" as const,
      verification_source: "vendor" as const,
      last_verified_at: new Date().toISOString(),
    };
  });
  const manager = createSetupJobManager({
    store: new SetupJobStore(join(root, `daemon-${managers.length}`)),
    rootDir: join(root, `daemon-${managers.length}`),
    platform: "darwin",
    runnerPath: join(root, "unused-runner.js"),
    processGroups,
    monitorPollMs: 2,
    authCapabilityVerifier: new AuthCapabilityVerifier(() => undefined),
    probeAuthSource: async () => {
      throw new Error("profile login must not probe default auth");
    },
    probeCredentialProfile: probe,
    onCredentialStateMayHaveChanged: (harness) => {
      invalidations.push(harness);
      if (invalidations.length === 1) input.onOpen?.();
    },
  });
  managers.push(manager);
  return {
    manager,
    processGroups,
    invalidations,
    probe,
    signals,
    setGroup: (value: typeof group) => {
      group = value;
    },
    setObserved: (value: ProcessIdentity) => {
      observed = value;
    },
    onGroupProbe: (callback: () => void) => {
      onProbe = callback;
    },
  };
}

function writeState(manager: Manager, jobId: string, stage: "awaiting_permit" | "running") {
  const manifest = readLoginManifest(manager._store.paths(jobId).manifest);
  atomicPrivateJson(manifest.statePath, {
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId,
    executionId: manifest.executionId,
    processGroup: { schemaVersion: 1, pgid: leader.pid, leader },
    stage,
    observedAt: manager.status({ jobId }).execution?.observedAt ?? new Date().toISOString(),
    commandDigest: manifest.commandDigest,
    manifestDigest: manifest.manifestDigest,
  });
}

function writeResult(manager: Manager, jobId: string, commandStarted = true) {
  const manifest = readLoginManifest(manager._store.paths(jobId).manifest);
  atomicPrivateJson(manifest.resultPath, {
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId,
    executionId: manifest.executionId,
    commandDigest: manifest.commandDigest,
    manifestDigest: manifest.manifestDigest,
    permitIssuedAt: manager.status({ jobId }).execution!.permitIssuedAt,
    commandStarted,
    exitCode: commandStarted ? 0 : null,
    signal: null,
    ...(commandStarted ? {} : { errorCode: "spawn_failed" }),
    finishedAt: new Date().toISOString(),
  });
}

async function until(
  manager: Manager,
  jobId: string,
  predicate: (job: ControlSetupJob) => boolean,
) {
  await vi.waitFor(
    () => {
      expect(manager._supervisorHealth().failure).toBeNull();
      expect(predicate(manager.status({ jobId }))).toBe(true);
    },
    { timeout: 2000, interval: 5 },
  );
  return manager.status({ jobId });
}

async function permit(manager: Manager) {
  await manager.start();
  const job = manager.create(request);
  writeState(manager, job.jobId, "awaiting_permit");
  await until(manager, job.jobId, (current) => Boolean(current.execution?.permitIssuedAt));
  return job;
}

describe("permitted Cursor login recovery", () => {
  it("closes exactly once for the runner's real pre-command executable refusal after permit", async () => {
    const f = fixture({ onOpen: () => writeFileSync(binary, "updated before vendor spawn") });
    await f.manager.start();
    const job = f.manager.create(request);
    const spawnProcess = vi.fn(() => {
      throw new Error("must never spawn vendor");
    });
    expect(
      await runSetupLoginWorker(f.manager._store.paths(job.jobId).manifest, {
        processGroupService: f.processGroups,
        selfPid: leader.pid,
        spawnProcess,
      }),
    ).toBe(1);
    const done = await until(f.manager, job.jobId, (current) => current.state === "failed");
    expect(done.outcome?.reason).toBe("launch_failed");
    expect(done.nativeCommand).toMatchObject({ commandStarted: false, errorCode: "spawn_failed" });
    expect(readRunnerResult(f.manager._store.paths(job.jobId).runnerResult)?.permitIssuedAt).toBe(
      done.execution?.permitIssuedAt,
    );
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.manager.credentialMutationOpen("cursor")).toBe(false);
    expect(f.invalidations).toEqual(["cursor", "cursor"]);
    await f.manager.shutdown();
    expect(f.invalidations).toEqual(["cursor", "cursor"]);
  });

  it("keeps a started result with no running-state evidence unconfirmed", async () => {
    const f = fixture();
    const job = await permit(f.manager);
    writeResult(f.manager, job.jobId);
    const done = await until(f.manager, job.jobId, (current) => current.state === "failed");
    expect(done.outcome?.reason).toBe("termination_unconfirmed");
    expect(done.nativeCommand).toBeUndefined();
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.manager.credentialMutationOpen("cursor")).toBe(true);
    expect(f.invalidations).toEqual(["cursor"]);
    expect(() => f.manager.reconcile({ jobId: job.jobId })).toThrow(/not proven empty/);
    f.setGroup("empty");
    f.manager.reconcile({ jobId: job.jobId });
    expect(f.invalidations).toEqual(["cursor", "cursor"]);
  });

  it("retains a permitted job when its runner sidecar disappears, then settles proven group death", async () => {
    const f = fixture();
    const job = await permit(f.manager);
    rmSync(f.manager._store.paths(job.jobId).runnerState);
    expect(f.manager.create(request).jobId).toBe(job.jobId);
    expect(f.manager.credentialMutationOpen("cursor")).toBe(true);
    expect(f.invalidations).toEqual(["cursor"]);
    f.setGroup("unknown");
    await new Promise((done) => setTimeout(done, 15));
    expect(f.manager.status({ jobId: job.jobId }).outcome).toBeUndefined();
    f.setGroup("empty");
    const done = await until(f.manager, job.jobId, (current) => current.state === "failed");
    expect(done.outcome?.reason).toBe("interrupted");
    expect(f.invalidations).toEqual(["cursor", "cursor"]);
    expect(f.signals).toEqual([]);
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.manager.create(request).jobId).not.toBe(job.jobId);
  });

  it("still replaces an unattached reservation that never had a durable permit", async () => {
    const f = fixture();
    await f.manager.start();
    const first = f.manager.create(request);
    const next = f.manager.create(request);
    expect(next.jobId).not.toBe(first.jobId);
    expect(f.manager.status({ jobId: first.jobId }).outcome?.reason).toBe("cancelled_by_user");
    expect(f.invalidations).toEqual([]);
  });

  it("allows executable self-update after permission and fresh profile verification while the window stays open", async () => {
    let release!: () => void;
    const verified = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture({ verify: () => verified });
    const job = await permit(f.manager);
    writeState(f.manager, job.jobId, "running");
    writeFileSync(binary, "updated by the running vendor");
    await new Promise((done) => setTimeout(done, 15));
    expect(f.manager.status({ jobId: job.jobId }).outcome).toBeUndefined();
    writeResult(f.manager, job.jobId);
    await until(f.manager, job.jobId, (current) => current.phase === "verifying");
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.manager.credentialMutationOpen("cursor")).toBe(true);
    expect(f.invalidations).toEqual(["cursor"]);
    release();
    const done = await until(f.manager, job.jobId, (current) => current.state === "succeeded");
    expect(done.nativeCommand?.commandStarted).toBe(true);
    expect(f.manager.credentialMutationOpen("cursor")).toBe(false);
    expect(f.invalidations).toEqual(["cursor", "cursor"]);
  });

  it("still refuses changed executable bytes before permission", async () => {
    const f = fixture();
    await f.manager.start();
    const job = f.manager.create(request);
    writeFileSync(binary, "replaced before authorization");
    writeState(f.manager, job.jobId, "awaiting_permit");
    const done = await until(f.manager, job.jobId, (current) => current.state === "failed");
    expect(done.outcome?.reason).toBe("launch_failed");
    expect(done.execution?.permitIssuedAt).toBeUndefined();
    expect(done.nativeCommand).toBeUndefined();
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.invalidations).toEqual([]);
    expect(f.manager.create(request).jobId).not.toBe(job.jobId);
  });

  it("consumes a result published during the empty-group proof instead of inventing an interruption", async () => {
    const f = fixture();
    const job = await permit(f.manager);
    writeState(f.manager, job.jobId, "running");
    f.onGroupProbe(() => writeResult(f.manager, job.jobId));
    f.setGroup("empty");
    await until(f.manager, job.jobId, (current) => current.state === "succeeded");
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.invalidations).toEqual(["cursor", "cursor"]);
  });

  it("requires the same durable process binding even for a pre-command receipt", async () => {
    const f = fixture();
    const job = await permit(f.manager);
    const path = f.manager._store.paths(job.jobId).runnerState;
    const state = JSON.parse(readFileSync(path, "utf8"));
    atomicPrivateJson(path, {
      ...state,
      processGroup: {
        ...state.processGroup,
        pgid: 42,
        leader: { ...leader, pid: 42, processGroupId: 42 },
      },
    });
    writeResult(f.manager, job.jobId, false);
    const done = await until(f.manager, job.jobId, (current) => current.state === "failed");
    expect(done.outcome?.reason).toBe("termination_unconfirmed");
    expect(f.manager.credentialMutationOpen("cursor")).toBe(true);
    expect(f.invalidations).toEqual(["cursor"]);
  });
});
