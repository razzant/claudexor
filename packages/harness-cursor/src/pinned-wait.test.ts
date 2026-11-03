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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConformanceReport,
  HarnessRunSpec,
  type CredentialProfile,
  type HarnessEvent,
} from "@claudexor/schema";
import {
  mintRunScopeMarker,
  reapScopeMembers,
  runCapture,
  scopeMarkerEnv,
  stampCredentialProfileSelection,
  type CliRunLoopOptions,
  type HarnessAdapter,
} from "@claudexor/core";
import {
  CURSOR_STATUS_TIMEOUT_MS,
  probeCursorNativeAuth,
  type CursorStatusObservation,
} from "./auth.js";
import { createCursorAdapter } from "./index.js";
import { cursorProfileRunEnv } from "./profile.js";
import {
  CURSOR_PINNED_STATUS_WAIT_MS,
  CURSOR_STATUS_REUSE_MS,
  createCursorStatusCoordinator,
} from "./status-cache.js";

// #532: an explicit pin waits for its row store's status answer under the
// run's cancellation, up to CURSOR_PINNED_STATUS_WAIT_MS; unpinned callers and
// Accounts keep the ordinary CURSOR_STATUS_TIMEOUT_MS decision.

const roots: string[] = [];
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-cursor-pin-wait-")));
  roots.push(root);
  vi.stubEnv("CLAUDEXOR_CONFIG_DIR", root);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function row(id: string): CredentialProfile {
  const home = join(root, "profiles", `cursor-${id}`);
  mkdirSync(home, { recursive: true });
  return {
    profile_id: id,
    harness_id: "cursor",
    display_name: id,
    credential_kind: "config_dir_login",
    isolation_locator: home,
    secret_ref: null,
    enabled: true,
    created_at: null,
  };
}

/** A status child that answers only when told (or at once with `autoAnswer`),
 * and stops when its signal fires. */
function fakeChild() {
  const calls: Array<{ signal: AbortSignal | undefined; budgetMs: number }> = [];
  const answers: Array<(observation: CursorStatusObservation) => void> = [];
  const state: { autoAnswer: CursorStatusObservation | null } = { autoAnswer: null };
  return {
    calls,
    state,
    answer: (observation: CursorStatusObservation) => answers.at(-1)?.(observation),
    probe: (_env: unknown, signal: AbortSignal | undefined, budgetMs: number) => {
      calls.push({ signal, budgetMs });
      if (state.autoAnswer) return Promise.resolve(state.autoAnswer);
      return new Promise<CursorStatusObservation>((resolve) => {
        answers.push(resolve);
        signal?.addEventListener(
          "abort",
          () => resolve({ kind: "unknown", error: "cursor-agent status failed (SIGTERM)" }),
          { once: true },
        );
      });
    },
  };
}

function setup(clock = { now: 0 }) {
  const child = fakeChild();
  const coordinator = createCursorStatusCoordinator({
    probe: child.probe,
    monotonicMs: () => clock.now,
    wallMs: () => Date.parse("2026-10-29T08:00:00.000Z") + clock.now,
    mutating: () => false,
  });
  const launches: string[] = [];
  const asked: unknown[] = [];
  const adapter = createCursorAdapter({
    detectVersion: async () => "cursor-test",
    nativeAuthOk: (env, signal, options) => {
      asked.push(options);
      return coordinator.status(env, signal, options);
    },
    cursorApiKey: () => null,
    listCursorModels: async () => [],
    resolveProfileSecret: () => {
      throw new Error("a native row never reads a secret");
    },
    runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
      launches.push(opts.spec.credential_profile?.profile_id ?? "default");
      const ts = new Date().toISOString();
      yield { type: "started", session_id: opts.spec.session_id, ts };
      yield { type: "message", session_id: opts.spec.session_id, ts, text: "4", final: true };
      yield { type: "completed", session_id: opts.spec.session_id, ts, payload: { exit_code: 0 } };
    },
  });
  // Cursor has no default login (D-U3): only the rows can admit the lane.
  adapter.doctor = async () =>
    ConformanceReport.parse({ harness_id: "cursor", status: "unavailable", reasons: ["no login"] });
  return { child, coordinator, adapter, launches, asked, clock };
}

/** Yield to real I/O until `cond` holds; fake timers never advance here. */
async function until(cond: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Await a run with fake time frozen: only already-due timers fire, so a
 * slow host cannot age another caller's wait. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.finally(() => (done = true));
  const deadline = Date.now() + 20_000;
  while (!done && Date.now() < deadline) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return promise;
}

async function gitRepo(): Promise<string> {
  const repo = join(root, "repo");
  mkdirSync(repo);
  await runCapture("git", ["-C", repo, "init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  await runCapture("git", ["-C", repo, "add", "-A"]);
  await runCapture("git", [
    "-C",
    repo,
    ...["-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-m", "init"],
  ]);
  return repo;
}

async function askOn(
  adapter: HarnessAdapter,
  rows: CredentialProfile[],
  options: { pin?: string; signal?: AbortSignal; repoRoot: string },
) {
  writeFileSync(join(root, "config.yaml"), JSON.stringify({ credential_profiles: rows }));
  const { Orchestrator } = await import("../../orchestrator/src/orchestrator.js");
  return new Orchestrator({ registry: new Map([["cursor", adapter]]), reviewers: [] }).run({
    repoRoot: options.repoRoot,
    prompt: "2+2?",
    mode: "ask",
    harnesses: ["cursor"],
    web: "auto",
    ...(options.pin ? { credentialProfileId: options.pin } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

describe("the pin fact reaches the Cursor status read (#532)", () => {
  it("only a pinned profile probe waits for the answer; Accounts and unpinned probes do not", async () => {
    const h = setup();
    const a = row("a");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pinned = h.adapter.probeCredentialProfile!(a, undefined, { pinned: true });
    const accounts = h.adapter.probeCredentialAccount!(a);
    const unpinned = h.adapter.probeCredentialProfile!(a);
    await vi.advanceTimersByTimeAsync(CURSOR_STATUS_TIMEOUT_MS);
    // The ordinary callers decide at the ordinary budget with plain unknown.
    for (const status of [(await accounts).status, await unpinned])
      expect(status).toMatchObject({
        availability: "unknown",
        verification: "not_run",
        detail: "cursor-agent status did not answer within 10s; login state unknown",
      });
    expect(h.asked).toEqual([{ pinned: true }, undefined, undefined]);
    expect(h.child.calls).toHaveLength(1);
    expect(h.child.calls[0]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(CURSOR_PINNED_STATUS_WAIT_MS - CURSOR_STATUS_TIMEOUT_MS);
    // The pin's own honest reason, with no stale basis a pin could consume.
    expect(await pinned).toEqual({
      profile_id: "a",
      harness_id: "cursor",
      availability: "unknown",
      verification: "not_run",
      verification_source: "local_store",
      detail:
        "Cursor did not confirm sign-in within 120s (cursor-agent status did not answer within 120s; login state unknown); a pinned account waits for that answer and never starts on an older one",
      last_verified_at: null,
    });
    expect(h.child.calls[0]?.signal?.aborted).toBe(true);
  });

  it("a pinned spawn waits for the same child past the ordinary budget, then launches", async () => {
    const h = setup();
    const spec = HarnessRunSpec.parse({
      session_id: "s-pin",
      intent: "explain",
      prompt: "2+2?",
      cwd: root,
      credential_profile: row("a"),
    });
    stampCredentialProfileSelection(spec, { pinned: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const events: HarnessEvent[] = [];
    const running = (async () => {
      for await (const event of h.adapter.run(spec)) events.push(event);
    })();
    await until(() => h.child.calls.length === 1, "the spawn-time status child");
    await vi.advanceTimersByTimeAsync(CURSOR_STATUS_TIMEOUT_MS + 1_000);
    expect(h.launches).toEqual([]);
    h.child.answer({ kind: "authenticated" });
    await settle(running);
    expect(h.launches).toEqual(["a"]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(h.child.calls).toHaveLength(1);
  });

  it("an unstamped side pass keeps the ordinary decision at spawn and never waits like a pin", async () => {
    const h = setup();
    const spec = HarnessRunSpec.parse({
      session_id: "s-side-pass",
      intent: "explain",
      prompt: "Summarize the earlier turns.",
      cwd: root,
      credential_profile: row("a"),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const events: HarnessEvent[] = [];
    const running = (async () => {
      for await (const event of h.adapter.run(spec)) events.push(event);
    })();
    await until(() => h.child.calls.length === 1, "the spawn-time status child");
    await vi.advanceTimersByTimeAsync(CURSOR_STATUS_TIMEOUT_MS);
    await settle(running);
    expect(h.asked).toEqual([undefined]);
    expect(events.map((event) => event.type)).toEqual(["error", "completed"]);
    expect((events[0] as { error?: string }).error).toContain("login state is unknown");
    expect(h.child.calls[0]?.signal?.aborted).toBe(true);
    expect(h.launches).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")(
  "pinned run admission through the engine (#532)",
  () => {
    it("a fresh answer after 11s launches exactly the pinned row, from the same status check", async () => {
      const h = setup();
      const repoRoot = await gitRepo();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const run = askOn(h.adapter, [row("a"), row("b")], { pin: "a", repoRoot });
      await until(() => h.child.calls.length === 1, "the admission status child");
      await vi.advanceTimersByTimeAsync(11_000);
      expect(h.child.calls[0]?.signal?.aborted).toBe(false);
      h.child.answer({ kind: "authenticated" });
      const result = await settle(run);
      expect(result.lifecycle, result.summary).toBe("succeeded");
      expect(h.launches).toEqual(["a"]);
      // Admission, inventory and spawn all read that one answer.
      expect(h.child.calls).toHaveLength(1);
      expect(h.asked[0]).toEqual({ pinned: true });
    });

    it("cancelling one pinned run ends its wait without dispatch; another run's wait is unaffected", async () => {
      const h = setup();
      const repoRoot = await gitRepo();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const cancel = new AbortController();
      const cancelled = askOn(h.adapter, [row("a")], { pin: "a", signal: cancel.signal, repoRoot });
      const patient = askOn(h.adapter, [row("a")], { pin: "a", repoRoot });
      await until(() => h.asked.length === 2, "both pinned admissions");
      await vi.advanceTimersByTimeAsync(20_000);
      cancel.abort();
      const stopped = await settle(cancelled);
      // The engine's terminal guard owns the cancellation statement.
      expect(stopped.lifecycle).toBe("cancelled");
      expect(stopped.summary).toBe("run cancelled");
      expect(h.launches).toEqual([]);
      // The other run still waits on the same child, which keeps running.
      expect(h.child.calls).toHaveLength(1);
      expect(h.child.calls[0]?.signal?.aborted).toBe(false);
      h.child.answer({ kind: "authenticated" });
      expect((await settle(patient)).lifecycle).toBe("succeeded");
      expect(h.launches).toEqual(["a"]);
    });

    it("the child stops once the only waiting run is cancelled", async () => {
      const h = setup();
      const repoRoot = await gitRepo();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const cancel = new AbortController();
      const run = askOn(h.adapter, [row("a")], { pin: "a", signal: cancel.signal, repoRoot });
      await until(() => h.child.calls.length === 1, "the admission status child");
      cancel.abort();
      expect((await settle(run)).lifecycle).toBe("cancelled");
      expect(h.child.calls[0]?.signal?.aborted).toBe(true);
      expect(h.launches).toEqual([]);
    });

    it("a credential mutation or a logged-out answer during the wait refuses the pin", async () => {
      const repoRoot = await gitRepo();
      const mutated = setup();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const first = askOn(mutated.adapter, [row("a")], { pin: "a", repoRoot });
      await until(() => mutated.child.calls.length === 1, "the admission status child");
      await vi.advanceTimersByTimeAsync(30_000);
      mutated.coordinator.clear();
      const afterClear = await settle(first);
      expect(afterClear.lifecycle).toBe("failed");
      expect(afterClear.summary).toContain("predates a credential change");
      expect(mutated.child.calls[0]?.signal?.aborted).toBe(true);
      expect(mutated.launches).toEqual([]);

      const loggedOut = setup();
      const second = askOn(loggedOut.adapter, [row("a")], { pin: "a", repoRoot });
      await until(() => loggedOut.child.calls.length === 1, "the second admission child");
      await vi.advanceTimersByTimeAsync(30_000);
      loggedOut.child.answer({ kind: "loggedOut" });
      const afterLogout = await settle(second);
      expect(afterLogout.lifecycle).toBe("failed");
      expect(afterLogout.summary).toContain("no Cursor login in the profile HOME");
      expect(loggedOut.launches).toEqual([]);
    });

    it("a status check that never answers refuses the pin at the bound, naming it", async () => {
      const h = setup();
      const repoRoot = await gitRepo();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const run = askOn(h.adapter, [row("a")], { pin: "a", repoRoot });
      await until(() => h.child.calls.length === 1, "the admission status child");
      await vi.advanceTimersByTimeAsync(CURSOR_PINNED_STATUS_WAIT_MS - 1);
      expect(h.child.calls[0]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await settle(run);
      expect(result.lifecycle).toBe("failed");
      expect(result.summary).toContain(
        "cursor credential profile is not ready: Cursor did not confirm sign-in within 120s",
      );
      expect(h.child.calls[0]?.signal?.aborted).toBe(true);
      expect(h.launches).toEqual([]);
    });

    it("an unpinned row keeps the ordinary decision: refused unanswered at 10s, admitted on its last positive", async () => {
      const repoRoot = await gitRepo();
      const bare = setup();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const refused = askOn(bare.adapter, [row("a")], { repoRoot });
      await until(() => bare.child.calls.length === 1, "the pool status child");
      await vi.advanceTimersByTimeAsync(CURSOR_STATUS_TIMEOUT_MS);
      const noLastPositive = await settle(refused);
      expect(noLastPositive.summary).toContain(
        "cursor has no ready account (a: cursor-agent status did not answer within 10s; login state unknown)",
      );
      expect(bare.child.calls[0]?.signal?.aborted).toBe(true);
      expect(bare.launches).toEqual([]);

      const seeded = setup();
      const a = row("a");
      const seeding = seeded.adapter.probeCredentialAccount!(a);
      seeded.child.answer({ kind: "authenticated" });
      expect((await seeding).status.verification).toBe("passed");
      seeded.clock.now = CURSOR_STATUS_REUSE_MS + 1_000;
      // Admission, pool selection and spawn each ask the store again; every
      // child now ends on its own ordinary budget, unanswered.
      seeded.child.state.autoAnswer = {
        kind: "unknown",
        error: "cursor-agent status did not answer within 10s (SIGTERM); login state unknown",
        timedOut: true,
      };
      const onLastPositive = await settle(askOn(seeded.adapter, [a], { repoRoot }));
      expect(onLastPositive.lifecycle, onLastPositive.summary).toBe("succeeded");
      expect(seeded.launches).toEqual(["a"]);
      expect(seeded.asked.every((options) => options === undefined)).toBe(true);
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "the shared status child is never orphaned (#532)",
  () => {
    it("cancelling the only pinned waiter kills the real cursor-agent status process", async () => {
      const a = row("a");
      const pidFile = join(root, "status.pid");
      const bin = join(root, "cursor-agent");
      writeFileSync(
        bin,
        `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
      );
      chmodSync(bin, 0o755);
      vi.stubEnv("CLAUDEXOR_CURSOR_BIN", bin);
      const coordinator = createCursorStatusCoordinator({
        probe: (env, signal, budgetMs) => probeCursorNativeAuth(env, signal, undefined, budgetMs),
        mutating: () => false,
      });
      const adapter = createCursorAdapter({ nativeAuthOk: coordinator.status });
      const cancel = new AbortController();
      const waiting = adapter.probeCredentialProfile!(a, cancel.signal, { pinned: true });
      await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0, "the pid");
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).not.toThrow();
      cancel.abort();
      expect(await waiting).toMatchObject({ availability: "unknown", verification: "not_run" });
      const deadline = Date.now() + 8_000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    });

    // Run custody is a per-run scope marker that the run's terminal reaps. The
    // tests mint their own synthetic scopes and reap only those: never a marker
    // this process inherited from its host or from the run executing it.
    /** A real status child that answers signed-in once `goFile` exists. */
    function answeringStatusBin() {
      const pidFile = join(root, "status.pid");
      const goFile = join(root, "answer.now");
      const bin = join(root, "cursor-agent");
      writeFileSync(
        bin,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
          "const timer = setInterval(() => {",
          `  if (!fs.existsSync(${JSON.stringify(goFile)})) return;`,
          "  clearInterval(timer);",
          '  process.stdout.write(JSON.stringify({ authenticated: true, email: "pin@example.invalid" }) + "\\n");',
          "}, 20);",
          "",
        ].join("\n"),
      );
      chmodSync(bin, 0o755);
      vi.stubEnv("CLAUDEXOR_CURSOR_BIN", bin);
      return { pidFile, goFile };
    }
    const isAlive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    async function gone(pid: number): Promise<boolean> {
      const deadline = Date.now() + 8_000;
      while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      return !isAlive(pid);
    }
    function realCoordinator() {
      return createCursorStatusCoordinator({
        probe: (env, signal, budgetMs) => probeCursorNativeAuth(env, signal, undefined, budgetMs),
        mutating: () => false,
      });
    }

    it("ending the scope of the run that started the shared child leaves it answering another run's pin", async () => {
      const { pidFile, goFile } = answeringStatusBin();
      const coordinator = realCoordinator();
      const store = cursorProfileRunEnv(row("a").isolation_locator!);
      const [firstScope, secondScope] = [mintRunScopeMarker(), mintRunScopeMarker()];
      const firstCancel = new AbortController();
      const first = coordinator.status(
        { ...store, ...scopeMarkerEnv(firstScope) },
        firstCancel.signal,
        {
          pinned: true,
        },
      );
      await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0, "the pid");
      const pid = Number(readFileSync(pidFile, "utf8"));
      const second = coordinator.status({ ...store, ...scopeMarkerEnv(secondScope) }, undefined, {
        pinned: true,
      });
      // The first run is cancelled and its terminal ends what its scope holds.
      firstCancel.abort();
      expect(await first).toMatchObject({ kind: "unknown" });
      await reapScopeMembers({ marker: firstScope, graceMs: 200 });
      expect(isAlive(pid)).toBe(true);
      writeFileSync(goFile, "");
      expect(await second).toMatchObject({ kind: "authenticated", email: "pin@example.invalid" });
      expect(await gone(pid)).toBe(true);
    });

    it("the last waiting run's cancellation still stops the shared child", async () => {
      const { pidFile } = answeringStatusBin();
      const coordinator = realCoordinator();
      const store = cursorProfileRunEnv(row("a").isolation_locator!);
      const cancels = [new AbortController(), new AbortController()];
      const waits = cancels.map((cancel) =>
        coordinator.status({ ...store, ...scopeMarkerEnv(mintRunScopeMarker()) }, cancel.signal, {
          pinned: true,
        }),
      );
      await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0, "the pid");
      const pid = Number(readFileSync(pidFile, "utf8"));
      cancels[0]!.abort();
      expect(await waits[0]).toMatchObject({ kind: "unknown" });
      expect(isAlive(pid)).toBe(true);
      cancels[1]!.abort();
      expect(await waits[1]).toMatchObject({ kind: "unknown" });
      // No scope was reaped: the coordinator itself stopped its child.
      expect(await gone(pid)).toBe(true);
    });
  },
);
