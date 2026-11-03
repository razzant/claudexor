import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonControlApiServer, type DaemonControlApiOptions } from "@claudexor/control-api";
import {
  bindCredentialMutationWindow,
  credentialMutationWindowOpen,
  defaultProcessGroupService,
  parseProcessGroupHandle,
} from "@claudexor/core";
import { createCursorAdapter } from "@claudexor/harness-cursor";
import type { ControlSetupJob, CredentialProfile } from "@claudexor/schema";
import { parseArgs } from "./args.js";
import { profilesCommandWithDeps } from "./credential-commands.js";
import { createAccountEvidence } from "@claudexor/daemon";
import { bustLoginCredentialState } from "./credential-status-invalidation.js";
import { controlApiFetch } from "./live.js";
import { registerConfigDirProfile } from "./profile-registration.js";
import { attachSetupJob } from "./setup-attach-command.js";
import { setupJobControlServices } from "./setup-job-control-services.js";
import { createSetupJobManager } from "./setup-jobs.js";
import { SqlSetupLifecycleSlot } from "./sql-setup-lifecycle.js";

// #363 consumer evidence over REAL processes, offline: `claudexor profiles
// login cursor <id>` creates a client_pty setup job on the real control route,
// attaches through the real setup-attach owner, the BUILT login runner
// (bootstrap + detached worker) runs a synthetic `cursor-agent` whose login
// the test scripts, and the real setup-job manager owns the credential-mutation
// window with real process-group evidence. The Cursor status coordinator
// probes the same synthetic store. No vendor, no account, no installed daemon.

// The daemon store graph's evidence the setup lifecycle invalidates.
const accounts = createAccountEvidence();
const { unusable: credentialUnusableLedger, substitutions: modelSubstitutionLedger } = accounts;
const preProgressRefusalLedger = accounts.refusals;

const vendor = vi.hoisted(() => {
  const dir = `${(process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "")}/claudexor-363-lifecycle-${process.pid}`;
  process.env.CLAUDEXOR_CURSOR_BIN = `${dir}/cursor-agent`;
  return { dir, bin: `${dir}/cursor-agent` };
});
const RUNNER = resolve(import.meta.dirname, "../dist/setup-login-runner.js");

/** `status` answers the store's current state; `login` follows `login-mode`. */
function writeVendor(): void {
  mkdirSync(vendor.dir, { recursive: true });
  const d = vendor.dir;
  writeFileSync(
    vendor.bin,
    [
      "#!/bin/sh",
      `D="${d}"`,
      'if [ "$1" = status ]; then',
      '  echo status >> "$D/status-calls"',
      '  read -r state < "$D/state"',
      '  if [ "$state" = out ]; then echo \'{"authenticated":false}\';',
      '  else printf \'{"authenticated":true,"email":"%s"}\\n\' "$state"; fi',
      "  exit 0",
      "fi",
      '[ "$1" = login ] || exit 2',
      'echo $$ > "$D/login-pid.tmp"; mv "$D/login-pid.tmp" "$D/login-pid"',
      'read -r mode < "$D/login-mode"',
      'case "$mode" in',
      '  complete) cp "$D/login-next" "$D/state"; exit 0 ;;',
      "  during)",
      '    echo mid@example.com > "$D/state"; touch "$D/login-mid"',
      '    while [ ! -f "$D/release" ]; do /bin/sleep 0.05; done',
      '    cp "$D/login-next" "$D/state"; exit 0 ;;',
      "  hang) trap 'exit 143' TERM; while :; do /bin/sleep 0.05; done ;;",
      "  stubborn) trap '' TERM INT; exec /bin/sleep 30 ;;",
      "esac",
      "exit 3",
      "",
    ].join("\n"),
  );
  chmodSync(vendor.bin, 0o755);
}
const vendorFile = (name: string) => join(vendor.dir, name);
function scriptVendor(state: string, mode: string, next = "new@example.com"): void {
  for (const name of ["status-calls", "login-pid", "login-mid", "release"]) {
    rmSync(vendorFile(name), { force: true });
  }
  writeFileSync(vendorFile("state"), `${state}\n`);
  writeFileSync(vendorFile("login-mode"), `${mode}\n`);
  writeFileSync(vendorFile("login-next"), `${next}\n`);
}
const statusCalls = (): number =>
  existsSync(vendorFile("status-calls"))
    ? readFileSync(vendorFile("status-calls"), "utf8").split("\n").filter(Boolean).length
    : 0;
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(label: string, predicate: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const TERMINAL = ["succeeded", "failed", "cancelled", "timed_out", "interrupted_unknown"];
type Manager = ReturnType<typeof createSetupJobManager>;

/** Teardown only: end the runner groups this fixture's own jobs recorded that
 * are still running, e.g. after a restart failed part-way and no manager knows
 * them. Uses the measured process-identity service, which signals only while the
 * recorded leader identity still owns the group. Returns every outcome that is
 * not proven ended; an unknown state is reported, never treated as success. */
async function endRecordedRunnerGroups(root: string): Promise<string[]> {
  const unproven: string[] = [];
  const artifacts = join(root, "setup-artifacts");
  if (!existsSync(artifacts)) return unproven;
  for (const job of readdirSync(artifacts)) {
    const statePath = join(artifacts, job, "runner-state.json");
    if (!existsSync(statePath)) continue; // this job never recorded a runner group
    let handle: ReturnType<typeof parseProcessGroupHandle>;
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8")) as { processGroup: unknown };
      handle = parseProcessGroupHandle(state.processGroup);
    } catch (error) {
      unproven.push(`${job}: runner state unreadable (${String(error)})`);
      continue;
    }
    const probe = defaultProcessGroupService.probeEmpty(handle);
    if (probe.status === "empty") continue;
    if (probe.status !== "nonempty") {
      unproven.push(`${job}: group ${handle.pgid} ${probe.status} (${probe.reason})`);
      continue;
    }
    const signal = defaultProcessGroupService.signal(handle, "SIGKILL");
    if (signal.status === "empty") continue;
    if (signal.status !== "sent") {
      unproven.push(`${job}: group ${handle.pgid} not signalled (${signal.reason})`);
      continue;
    }
    try {
      await until(`runner group ${handle.pgid} to end`, () => {
        return defaultProcessGroupService.probeEmpty(handle).status === "empty";
      });
    } catch (error) {
      unproven.push(`${job}: group ${handle.pgid} after SIGKILL: ${String(error)}`);
    }
  }
  return unproven;
}

interface Daemon {
  root: string;
  manager: Manager;
  addr: { baseUrl: string; token: string };
  /** Harnesses the lifecycle invalidated, in order (window entry / close). */
  bumps: string[];
  job: () => ControlSetupJob;
  artifact: (name: string) => string;
  /** The runner worker (process-group leader) the job's permit was issued to. */
  workerGroup: () => number;
  restart: (options?: { beforeStart?: () => void | Promise<void> }) => Promise<void>;
}

async function withDaemon<T>(
  options: { loginTimeoutMs?: number; terminationGraceMs?: number; now?: () => Date },
  fn: (daemon: Daemon) => Promise<T>,
): Promise<T> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx363-daemon-")));
  const bumps: string[] = [];
  const quota = { noteCredentialChange: () => {} };
  // The daemon's SQL setup store over the engine store this fixture opens and closes.
  let sql = await sqlFixture(root);
  const build = () =>
    createSetupJobManager({
      store: new SqlSetupLifecycleSlot(root, sql.graph).current(),
      rootDir: root,
      runnerPath: RUNNER,
      monitorPollMs: 20,
      verifyPollMs: 50,
      terminationGraceMs: options.terminationGraceMs ?? 300,
      ...(options.now ? { now: options.now } : {}),
      ...(options.loginTimeoutMs ? { loginTimeoutMs: options.loginTimeoutMs } : {}),
      onCredentialStateMayHaveChanged: (harness) => {
        bumps.push(harness);
        bustLoginCredentialState(() => quota as never, accounts, { invalidate() {} }, harness);
      },
    });
  let manager = build();
  await manager.start();
  // claudexord's binding: observers read the window from the live generation.
  let bound: Manager | null = manager;
  bindCredentialMutationWindow((harness) => {
    if (!bound) throw new Error("setup lifecycle generation is unavailable");
    return bound.credentialMutationOpen(harness);
  });
  const token = "cx363-lifecycle";
  const server = new DaemonControlApiServer({
    token,
    daemon: {
      enqueue: async () => ({ id: "unused", state: "queued" }),
      status: async (id: string) => ({ id, state: "failed" }),
      list: async () => [],
      cancel: async () => ({ cancelled: true }),
    } as never,
    services: setupJobControlServices(() => manager) as NonNullable<
      DaemonControlApiOptions["services"]
    >,
  });
  const { host, port } = await server.start();
  const artifact = (name: string) => {
    const [only] = manager.list({ harness: "cursor" }).slice(-1);
    return join(root, "setup-artifacts", only!.jobId, name);
  };
  const daemon: Daemon = {
    root,
    get manager() {
      return manager;
    },
    addr: { baseUrl: `http://${host}:${port}`, token },
    bumps,
    job: () => manager.list({ harness: "cursor" }).slice(-1)[0]!,
    artifact,
    workerGroup: () =>
      (
        JSON.parse(readFileSync(artifact("runner-state.json"), "utf8")) as {
          processGroup: { pgid: number };
        }
      ).processGroup.pgid,
    restart: async ({ beforeStart } = {}) => {
      // Logins survive an ordinary daemon stop (v3.0.3 S5).
      bound = null;
      await manager.shutdown();
      const previous = sql.store;
      await sql.close();
      await beforeStart?.();
      // A real restart: a new engine store over the same database, never the live one.
      sql = await sqlFixture(root);
      // A boolean on purpose: Vitest formats a failed toBe's operands after the
      // teardown closed the store, and that formatting would replace this failure.
      expect(sql.store === previous, "the restart reused the live engine store").toBe(false);
      expect(sql.store.storeId).toBe(previous.storeId);
      manager = build();
      await manager.start();
      bound = manager;
    },
  };
  try {
    return await fn(daemon);
  } finally {
    // Every teardown step runs. A step's failure is reported beside the test's
    // own result (soft), never instead of it, and fails an otherwise green test.
    const teardown: string[] = [];
    const attempt = async (step: string, action: () => unknown) => {
      try {
        await action();
      } catch (error) {
        teardown.push(`${step}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    bindCredentialMutationWindow(null);
    // A restart that failed part-way leaves `bound` unset and its manager
    // stopped; its jobs end through their recorded runner groups below.
    if (bound)
      await attempt("cancel active jobs", async () => {
        for (const job of manager.list({ active: true }))
          await manager.cancel({ jobId: job.jobId });
      });
    await attempt("manager shutdown", () => manager.shutdown());
    await attempt("store close", () => sql.close());
    await attempt("control API stop", () => server.stop());
    teardown.push(...(await endRecordedRunnerGroups(root)));
    expect.soft(teardown, "teardown not proven complete").toEqual([]);
  }
}

let profile: CredentialProfile;
let prevConfig: string | undefined;
let configDir: string;
let interrupt: (() => void) | null;
const cursor = createCursorAdapter();

/** The real `claudexor profiles login cursor a`, attached through the real
 * setup-attach owner to the built runner. */
function cliLogin(daemon: Daemon, afterAttach?: () => Promise<void>): Promise<number> {
  let gets = 0;
  return profilesCommandWithDeps(parseArgs(["profiles", "login", "cursor", "a"]), false, {
    daemonGet: async () => {
      gets += 1;
      const status =
        gets === 1
          ? {
              profile_id: "a",
              harness_id: "cursor",
              availability: "unknown",
              verification: "not_run",
            }
          : await cursor.probeCredentialProfile!(profile);
      return {
        profiles: [{ profile, status, identity: null }],
        harnessAccounts: [],
        accountPools: [],
      };
    },
    ensureDaemon: async () => ({ addr: daemon.addr }),
    attach: async (addr, jobId) => {
      const code = await attachSetupJob(addr, jobId, {
        runnerPath: RUNNER,
        artifactRoot: join(daemon.root, "setup-artifacts"),
      });
      await afterAttach?.();
      return code;
    },
    receiptExists: (jobId) =>
      existsSync(join(daemon.root, "setup-artifacts", jobId, "runner-result.json")),
    onInterrupt: (handler) => {
      interrupt = handler;
      return () => {
        interrupt = null;
      };
    },
    pollMs: 20,
  });
}

const permitted = (daemon: Daemon) => () => {
  const pidFile = vendorFile("login-pid");
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
  return Boolean(daemon.job()?.execution?.permitIssuedAt) && Number.isSafeInteger(pid) && pid > 1;
};

function seedObservations(): number {
  preProgressRefusalLedger.noteCredentialChange();
  preProgressRefusalLedger.record({ harness_id: "cursor", profile_id: "a", requested_model: "m" });
  credentialUnusableLedger.record({
    harness_id: "cursor",
    profile_id: "a",
    model: null,
    code: "auth_revoked",
    source: "attempt_stream",
    detail: null,
    observed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  modelSubstitutionLedger.record({ harness_id: "cursor", profile_id: "a", requested_model: "m" });
  return preProgressRefusalLedger.generation("cursor", "a");
}
const observationsVoid = () => {
  expect(preProgressRefusalLedger.live()).toEqual([]);
  expect(credentialUnusableLedger.live()).toEqual([]);
  expect(modelSubstitutionLedger.live()).toEqual([]);
};

describe("profiles login as a daemon setup job: credential-mutation window over real processes (#363)", () => {
  beforeAll(() => {
    if (!existsSync(RUNNER)) throw new Error(`build @claudexor/cli first: ${RUNNER} is missing`);
    writeVendor();
  });
  afterAll(() => rmSync(vendor.dir, { recursive: true, force: true }), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
  beforeEach(() => {
    prevConfig = process.env.CLAUDEXOR_CONFIG_DIR;
    configDir = realpathSync(mkdtempSync(join(tmpdir(), "cx363-config-")));
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    profile = registerConfigDirProfile({ harnessId: "cursor", profileId: "a" }).profile;
    interrupt = null;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    if (prevConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prevConfig;
    vi.restoreAllMocks();
    rmSync(configDir, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  it("a completed login voids everything observed before it and is verified by the daemon", async () => {
    await withDaemon({}, async (daemon) => {
      scriptVendor("old@example.com", "complete");
      // A positive answer from BEFORE the login is live and reused.
      expect(await cursor.probeCredentialProfile!(profile)).toMatchObject({
        verification: "passed",
      });
      await cursor.probeCredentialProfile!(profile);
      expect(statusCalls()).toBe(1);
      const boundBefore = seedObservations();

      expect(await cliLogin(daemon)).toBe(0);
      expect(daemon.job()).toMatchObject({
        state: "succeeded",
        transport: "client_pty",
        profileId: "a",
        nativeCommand: { commandStarted: true, exitCode: 0, signal: null },
      });
      // Window entry at the permit, close at the receipt-proven end.
      expect(daemon.bumps).toEqual(["cursor", "cursor"]);
      expect(credentialMutationWindowOpen("cursor")).toBe(false);
      observationsVoid();
      expect(preProgressRefusalLedger.generation("cursor", "a")).toBeGreaterThan(boundBefore);
      // After the window: the new store is read and reused as usual.
      const calls = statusCalls();
      expect(await cursor.probeCredentialProfile!(profile)).toMatchObject({
        verification: "passed",
      });
      expect(statusCalls()).toBe(calls); // the post-login re-read already asked it
    });
  });

  it("observations made DURING the login are answered live and kept by nothing", async () => {
    await withDaemon({}, async (daemon) => {
      scriptVendor("old@example.com", "during");
      await cursor.probeCredentialProfile!(profile);
      const login = cliLogin(daemon);
      await until("the vendor to be mid-login", () => existsSync(vendorFile("login-mid")));
      expect(daemon.bumps).toEqual(["cursor"]);
      expect(credentialMutationWindowOpen("cursor")).toBe(true);
      // Live answers, no reuse: each ask spawns the vendor's status.
      const before = statusCalls();
      const mid = await cursor.probeCredentialProfile!(profile);
      await cursor.probeCredentialProfile!(profile);
      expect(mid).toMatchObject({ availability: "available" });
      expect(statusCalls()).toBe(before + 2);
      // No ledger accepts an observation about the credential in flux.
      expect(Number.isNaN(preProgressRefusalLedger.generation("cursor", "a"))).toBe(true);
      seedObservations();
      observationsVoid();

      writeFileSync(vendorFile("release"), "");
      expect(await login).toBe(0);
      expect(daemon.bumps).toEqual(["cursor", "cursor"]);
      expect(credentialMutationWindowOpen("cursor")).toBe(false);
      expect(Number.isNaN(preProgressRefusalLedger.generation("cursor", "a"))).toBe(false);
    });
  });

  it("Ctrl-C cancels through the daemon, which proves the vendor's group empty before closing (SIGINT)", async () => {
    await withDaemon({}, async (daemon) => {
      scriptVendor("old@example.com", "hang");
      const login = cliLogin(daemon);
      await until("the vendor login to run", permitted(daemon));
      const vendorPid = Number(readFileSync(vendorFile("login-pid"), "utf8"));
      const bootstrap = Number(
        execFileSync("ps", ["-o", "ppid=", "-p", String(daemon.workerGroup())])
          .toString()
          .trim(),
      );
      // The terminal's SIGINT reaches its foreground group: this client and the
      // attached bootstrap runner. The detached worker and vendor never see it.
      process.kill(bootstrap, "SIGINT");
      interrupt!();
      expect(await login).toBe(130);
      expect(daemon.job()).toMatchObject({
        state: "cancelled",
        outcome: { reason: "cancelled_by_user" },
      });
      expect(alive(vendorPid)).toBe(false);
      expect(daemon.bumps).toEqual(["cursor", "cursor"]);
      expect(credentialMutationWindowOpen("cursor")).toBe(false);
    });
  });

  it("the monitor settles a SIGKILLed runner group before the client resumes", async () => {
    await withDaemon({}, async (daemon) => {
      scriptVendor("old@example.com", "hang");
      const login = cliLogin(daemon, () =>
        until(
          "the monitor to prove group death",
          () => daemon.job()?.outcome?.reason === "interrupted",
        ),
      );
      await until("the vendor login to run", permitted(daemon));
      const vendorPid = Number(readFileSync(vendorFile("login-pid"), "utf8"));
      process.kill(-daemon.workerGroup(), "SIGKILL");
      expect(await login).toBe(1);
      const job = daemon.job();
      expect(job).toMatchObject({ state: "failed", outcome: { reason: "interrupted" } });
      expect(job.nativeCommand).toBeUndefined();
      expect(alive(vendorPid)).toBe(false);
      expect(daemon.bumps).toEqual(["cursor", "cursor"]);
      expect(credentialMutationWindowOpen("cursor")).toBe(false);
    });
  });

  it("the client's death closes nothing: the daemon holds the window until the vendor's receipt", async () => {
    await withDaemon({}, async (daemon) => {
      scriptVendor("old@example.com", "during");
      const create = await controlApiFetch(daemon.addr, "/setup/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          harness: "cursor",
          action: "login",
          authRequest: "subscription",
          profileId: "a",
          transport: "client_pty",
        }),
      });
      expect(create.ok).toBe(true);
      const { jobId } = (await create.json()) as { jobId: string };
      // A client attaches exactly as `setup attach` does, then is SIGKILLed.
      const client = spawn(
        process.execPath,
        [RUNNER, join(daemon.root, "setup-artifacts", jobId, "runner-manifest.json")],
        {
          stdio: "ignore",
        },
      );
      await until("the vendor to be mid-login", () => existsSync(vendorFile("login-mid")));
      client.kill("SIGKILL");
      await new Promise((r) => client.once("exit", r));
      await new Promise((r) => setTimeout(r, 200)); // several monitor ticks
      expect(daemon.job()).toMatchObject({ state: "waiting_for_input", phase: "awaiting_user" });
      expect(credentialMutationWindowOpen("cursor")).toBe(true);
      expect(daemon.bumps).toEqual(["cursor"]);
      // The vendor itself finishes: its receipt, not the client, ends the window.
      writeFileSync(vendorFile("release"), "");
      await until("the job to finish", () => TERMINAL.includes(daemon.job().state));
      expect(daemon.job().state).toBe("succeeded");
      expect(daemon.bumps).toEqual(["cursor", "cursor"]);
      expect(credentialMutationWindowOpen("cursor")).toBe(false);
    });
  });

  it("a restart never proves completion: a live login stays open, a dead one closes on proof", async () => {
    await withDaemon({}, async (daemon) => {
      scriptVendor("old@example.com", "hang");
      // Reconciliation owns this scenario; hold the client's automatic cancel
      // until the restarted manager has recorded its terminal evidence.
      const login = cliLogin(daemon, () =>
        until("restart disposition before client cleanup", () =>
          TERMINAL.includes(daemon.job().state),
        ),
      );
      await until("the vendor login to run", permitted(daemon));
      const vendorPid = Number(readFileSync(vendorFile("login-pid"), "utf8"));
      // Between generations the lifecycle is unbound: observers read it open.
      await daemon.restart({
        beforeStart: () => expect(credentialMutationWindowOpen("cursor")).toBe(true),
      });
      // The successor re-proved the live worker and adopted it: still open,
      // and the restart itself invalidated nothing.
      expect(daemon.job()).toMatchObject({ state: "waiting_for_input" });
      expect(credentialMutationWindowOpen("cursor")).toBe(true);
      expect(daemon.bumps).toEqual(["cursor"]);
      // The runner group dies while the daemon is down: the next successor
      // finds it empty with no receipt and closes the window on that proof.
      const handle = parseProcessGroupHandle(daemon.job().execution!.processGroup);
      await daemon.restart({
        beforeStart: async () => {
          process.kill(-handle.pgid, "SIGKILL");
          await until(
            "runner group dead while daemon is down",
            () => defaultProcessGroupService.probeEmpty(handle).status === "empty",
          );
        },
      });
      await until("the successor to settle", () => TERMINAL.includes(daemon.job().state));
      expect(daemon.job()).toMatchObject({
        state: "cancelled",
        outcome: { reason: "cancelled_on_restart" },
      });
      expect(alive(vendorPid)).toBe(false);
      expect(daemon.bumps).toEqual(["cursor", "cursor"]);
      expect(credentialMutationWindowOpen("cursor")).toBe(false);
      expect(await login).toBe(1);
    });
  });

  it("a deadline alone never closes the window: only the proven death of a stubborn vendor does", async () => {
    let nowMs: number | undefined;
    await withDaemon(
      {
        loginTimeoutMs: 30_000,
        terminationGraceMs: 2_000,
        now: () => new Date(nowMs ?? Date.now()),
      },
      async (daemon) => {
        scriptVendor("old@example.com", "stubborn");
        const login = cliLogin(daemon);
        await until("the vendor login to run", permitted(daemon));
        const vendorPid = Number(readFileSync(vendorFile("login-pid"), "utf8"));
        // The deadline tests termination, not how quickly a loaded host starts Node.
        nowMs = Date.parse(daemon.job().deadlineAt!);
        // Past the deadline the daemon is TERMinating a vendor that ignores it.
        await until("termination to begin", () => daemon.job().phase === "cancelling");
        expect(nowMs).toBeGreaterThanOrEqual(Date.parse(daemon.job().deadlineAt!));
        expect(credentialMutationWindowOpen("cursor")).toBe(true);
        expect(daemon.bumps).toEqual(["cursor"]);
        expect(await login).toBe(1);
        expect(daemon.job()).toMatchObject({
          state: "timed_out",
          outcome: { reason: "timed_out" },
        });
        expect(alive(vendorPid)).toBe(false);
        expect(daemon.bumps).toEqual(["cursor", "cursor"]);
        expect(credentialMutationWindowOpen("cursor")).toBe(false);
      },
    );
  }, 20_000);
});
