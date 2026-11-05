/**
 * Later settlement through the entrypoint that actually ships (#613, INV-144):
 * the built `claudexord` process, its own attach, store replacement and shutdown,
 * real SQL, HTTP and RPC, its real lifecycle tick and a real census and signal of
 * an owned child. Only the agent runner is synthetic: a resolve hook swaps that one
 * module, so no harness, credential, vendor request or serving daemon is involved.
 * Everything lives in a private root with a private HOME. The only thing inherited is
 * the enclosing host's scope markers, shed as the CLI launcher sheds them, so a child
 * that outlives this test stays inside the host's custody.
 *
 * Nothing here signals an owned child. Each one holds a connection to this process and
 * exits when it closes, which also ends it if the test dies. A saved pid is never
 * authority: only a birth measured at spawn says whether that child has ended.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  compareProcessBirth,
  defaultAsyncProcessIdentityReader,
  inheritedScopeMarkers,
  isRunScopeMarkerName,
  type AsyncProcessIdentityReader,
  type KnownProcessIdentity,
  type ProcessIdentity,
} from "@claudexor/core";
import { DaemonClient } from "@claudexor/daemon";
import type { ControlDaemonStatus, ControlJournalInspection } from "@claudexor/schema";
import { describe, expect, it, vi } from "vitest";
import { CLI_DAEMON_LAUNCH_SOURCES, daemonLaunchEnvironment } from "./daemon-launch.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const dist = resolve(import.meta.dirname, "../dist");
const daemonEntry = join(dist, "claudexord.js");
const moduleUrl = (path: string) => pathToFileURL(path).href;
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const LATER_RECORD = "final/process_scope_later.yaml";

/** Swaps exactly one module of the built graph; every other import stays the shipped one. */
const hookSource = (agent: string) => `
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url === ${JSON.stringify(moduleUrl(join(dist, "daemon-agent-runner.js")))}
      ? { ...resolved, url: ${JSON.stringify(moduleUrl(agent))} }
      : resolved;
  },
});
`;

/** An owned child: it lives on one connection to the fixture and reports its scope markers. */
const heldChildSource = `
const socket = require("node:net").connect(process.env.FIXTURE_HOLD, () => {
  const markers = Object.keys(process.env).filter((name) => /_SCOPE_[0-9a-f]{32}$/.test(name));
  socket.write(JSON.stringify({ label: process.env.FIXTURE_LABEL, markers }) + "\\n");
});
socket.resume();
socket.on("close", () => process.exit(0));
socket.on("error", () => process.exit(1));
`;

/**
 * The synthetic executor. It owns one real child per run under the run's real marker,
 * measures its birth, and waits for the test. Its terminal settlement is the real reap
 * given no budget, which leaves the scope unresolved exactly as an expired deadline
 * does on a loaded host.
 */
const agentSource = () => `
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultAsyncProcessIdentityReader } from ${JSON.stringify(moduleUrl(resolve(dist, "../../core/dist/index.js")))};
import { daemonRunScopeIndex } from ${JSON.stringify(moduleUrl(join(dist, "run-scope-index.js")))};
import { runScopeFacts } from ${JSON.stringify(moduleUrl(resolve(dist, "../../orchestrator/dist/index.js")))};
import {
  RunFacts,
  SCHEMA_VERSION,
  makeOutcomeFacts,
  needsOperatorAttention,
  requiredActionsFor,
} from ${JSON.stringify(moduleUrl(resolve(dist, "../../schema/dist/index.js")))};

const root = process.env.FIXTURE_ROOT;
const record = (name, value) => writeFileSync(join(root, name), JSON.stringify(value));

function terminal(deps, jobId, runId, taskId, lifecycle) {
  const facts = RunFacts.parse({
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    task_id: taskId,
    mode: "ask",
    outcome: {
      ...makeOutcomeFacts(lifecycle),
      review_requested: false,
      work_state: { state: "completed", source: "constrained" },
    },
    deliverable: { present: true, kind: "answer", path: "final/answer.md" },
    presentation: { state: "ready", primary: { kind: "answer", path: "final/answer.md" } },
    participants: { planners: 0, attempts: [] },
    gates: { configured: false, required: 0, total: 0, executed: false, state: "not_configured" },
    review: { state: "not_run", blockers: 0, blocker_ids: [] },
    apply: { eligibility: null },
    required_actions: [],
    generated_at: new Date().toISOString(),
  });
  facts.required_actions = requiredActionsFor(facts.outcome, facts.apply.operator_decision_present);
  deps.terminalPersistence(jobId)(
    {
      run_id: runId,
      task_id: taskId,
      seq: 1,
      ts: new Date().toISOString(),
      type: needsOperatorAttention(facts.outcome, false) ? "run.blocked" : "run.completed",
      payload: { run_facts: facts, facts: facts.outcome, lifecycle, reason: facts.outcome.reason },
    },
    null,
  );
  return deps.commands.getByRunId(runId).result;
}

export function createDaemonAgentRunner(deps) {
  return async (params, ctx) => {
    const runId = "run-" + ctx.jobId;
    const taskId = "task-" + ctx.jobId;
    const runDir = join(root, "runs", ctx.jobId);
    mkdirSync(join(runDir, "final"), { recursive: true });
    writeFileSync(join(runDir, "final/answer.md"), "answer\\n");
    ctx.onRunStart({ runId, taskId, runDir });
    const index = daemonRunScopeIndex();
    if (params.prompt === "successor") {
      record("successor.json", { jobId: ctx.jobId });
      return { lifecycle: "cancelled" };
    }
    if (params.prompt === "slow") {
      // Keeps the shutdown open past the moment a later attempt falls due.
      record("run-slow.json", { jobId: ctx.jobId });
      await new Promise((done) => ctx.signal.addEventListener("abort", done, { once: true }));
      await new Promise((done) => setTimeout(done, 8000));
      return { lifecycle: "cancelled" };
    }
    if (params.prompt === "corrupt") {
      // What a failed write reports: the store's own corruption path, never damaged bytes.
      deps.threads.store.options.onCorrupt(new Error("synthetic store corruption"));
      return { lifecycle: "cancelled" };
    }
    const { marker } = await index.open(runId);
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(heldChildSource)}], {
      env: { ...process.env, [marker]: "1", FIXTURE_LABEL: params.prompt },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    record("run-" + params.prompt + ".json", {
      label: params.prompt,
      jobId: ctx.jobId,
      runId,
      runDir,
      marker,
      identity: await defaultAsyncProcessIdentityReader.read(child.pid),
      subscribers: index.late.listeners.size,
    });
    const release = join(root, "release-" + params.prompt);
    while (!existsSync(release) && !ctx.signal.aborted)
      await new Promise((done) => setTimeout(done, 20));
    // Stopped while open: the scope stays open, for the open control's own test to read.
    if (ctx.signal.aborted) return { lifecycle: "cancelled" };
    const budget = index.deadlineMs;
    index.deadlineMs = 0;
    const outcome = await index.settle(runId, marker);
    index.deadlineMs = budget;
    writeFileSync(
      join(runDir, "final/process_scope.yaml"),
      JSON.stringify(runScopeFacts(marker, outcome)),
    );
    return terminal(deps, ctx.jobId, runId, taskId, "succeeded");
  };
}
`;

interface OwnedRun {
  label: string;
  jobId: string;
  runId: string;
  runDir: string;
  marker: string;
  identity: KnownProcessIdentity;
  subscribers: number;
}
interface Draft {
  draftId: string;
  state: string;
  hold?: { code: string } | null;
  resumed?: { reason: string; from: { code: string } } | null;
}

const fixtures: Fixture[] = [];
const live = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/** One owned child's lifetime, held from here: its connection closes only when it ends
 * or this fixture lets it go, so `alive` needs no pid and cannot meet a recycled one. */
class Held {
  private open = true;
  constructor(
    private readonly socket: Socket,
    readonly markers: string[],
  ) {
    socket.once("close", () => {
      this.open = false;
    });
    socket.resume();
  }
  get alive() {
    return this.open;
  }
  release() {
    this.socket.destroy();
  }
}

class Fixture {
  // A long TMPDIR would overflow the daemon's socket path, as in sql-daemon-startup.test.ts.
  readonly root = realpathSync(
    mkdtempSync(join(tmpdir().length < 40 ? tmpdir() : realpathSync("/tmp"), "cx-later-boot-")),
  );
  readonly config = join(this.root, "config");
  readonly daemon = join(this.config, "daemon");
  readonly index = join(this.daemon, "run-scopes.json");
  private readonly hook = join(this.root, "hook.mjs");
  private child: ChildProcess | null = null;
  private exited: Promise<void> = Promise.resolve();
  private stderr = "";
  private readonly holdPath = join(this.root, "hold.sock");
  private readonly holds = new Map<string, Held>();
  private readonly holdServer = createServer((socket) => this.accept(socket));
  /** Every child whose end must be confirmed before this root may go. */
  readonly owned: KnownProcessIdentity[] = [];
  private readonly identity: AsyncProcessIdentityReader;
  private readonly confirmMs: number;

  constructor(options: { identity?: AsyncProcessIdentityReader; confirmMs?: number } = {}) {
    this.identity = options.identity ?? defaultAsyncProcessIdentityReader;
    this.confirmMs = options.confirmMs ?? 5_000;
    this.holdServer.listen(this.holdPath);
    const home = join(this.root, "home");
    for (const dir of [this.config, this.daemon, home, join(this.root, "tmp")])
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, "runs"), { mode: 0o700 });
    const agent = join(this.root, "agent.mjs");
    writeFileSync(agent, agentSource());
    writeFileSync(this.hook, hookSource(agent));
    writeFileSync(
      join(this.config, "config.yaml"),
      JSON.stringify({
        version: 1,
        credential_profiles: [],
        harnesses: Object.fromEntries(
          ["claude", "codex", "cursor", "agy", "opencode", "grok", "raw-api"].map((id) => [
            id,
            { enabled: false, native_credentials_enabled: false },
          ]),
        ),
      }),
      { mode: 0o600 },
    );
    fixtures.push(this);
  }

  boot(): void {
    expect(existsSync(daemonEntry), "build the daemon before this process test").toBe(true);
    rmSync(join(this.daemon, "control-api.json"), { force: true });
    const home = join(this.root, "home");
    const temporary = join(this.root, "tmp");
    const child = spawn(process.execPath, ["--import", moduleUrl(this.hook), daemonEntry], {
      cwd: this.root,
      stdio: ["ignore", "ignore", "pipe"],
      env: daemonLaunchEnvironment(
        {
          ...inheritedScopeMarkers(process.env),
          HOME: home,
          USERPROFILE: home,
          USER: "fixture",
          LOGNAME: "fixture",
          XDG_CONFIG_HOME: join(home, ".config"),
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
          PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
          CLAUDEXOR_CONFIG_DIR: this.config,
          CLAUDEXOR_CONTROL_PORT: "0",
          FIXTURE_ROOT: this.root,
          FIXTURE_HOLD: this.holdPath,
        },
        CLI_DAEMON_LAUNCH_SOURCES.ensureDaemon,
      ),
    });
    this.child = child;
    child.stderr!.on("data", (part) => {
      this.stderr += String(part);
    });
    this.exited = new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", () => done());
    });
  }

  private accept(socket: Socket): void {
    let hello = "";
    const read = (part: Buffer) => {
      hello += String(part);
      if (!hello.endsWith("\n")) return;
      socket.off("data", read);
      const { label, markers } = JSON.parse(hello) as { label: string; markers: string[] };
      this.holds.set(label, new Held(socket, markers));
    };
    socket.on("data", read);
    // A child that dies mid-write is an end, which `close` reports.
    socket.on("error", () => {});
  }
  held(label: string): Held {
    const held = this.holds.get(label);
    if (!held) throw new Error(`no child of ${label} connected`);
    return held;
  }
  /** The measured verdict on one child; "same" is the only proof it is still that child. */
  async birth(expected: KnownProcessIdentity) {
    return compareProcessBirth(expected, await this.identity.read(expected.pid));
  }

  get log() {
    const file = join(this.daemon, "claudexord.log");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }
  private rpc() {
    return new DaemonClient(
      join(this.daemon, "claudexord.sock"),
      readFileSync(join(this.daemon, "token"), "utf8").trim(),
    );
  }
  async wait<T>(probe: () => Promise<T | null> | T | null, what: string, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    let last: unknown;
    while (Date.now() < deadline) {
      if (!this.child || !live(this.child))
        throw new Error(`${what}: daemon exited\n${this.stderr}\n${this.log}`);
      try {
        const value = await probe();
        if (value !== null) return value;
      } catch (error) {
        last = error;
      }
      await pause(50);
    }
    throw new Error(`${what}: ${String(last)}\n${this.stderr}\n${this.log}`);
  }
  mode(expected: string) {
    return this.wait(async () => {
      const health = (await this.rpc().health()) as ControlDaemonStatus;
      return health.servingMode === expected ? health : null;
    }, `serving mode ${expected}`);
  }
  async request<T>(path: string, method = "GET", body?: unknown, key = randomUUID()): Promise<T> {
    const pointer = JSON.parse(readFileSync(join(this.daemon, "control-api.json"), "utf8")) as {
      host: string;
      port: number;
      tokenPath: string;
    };
    const response = await fetch(`http://${pointer.host}:${pointer.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${readFileSync(pointer.tokenPath, "utf8").trim()}`,
        "x-claudexor-protocol-major": "3",
        "x-claudexor-store-identity": "1",
        "content-type": "application/json",
        "idempotency-key": key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const value: unknown = await response.json();
    if (!response.ok) throw new Error(`${method} ${path} ${response.status}: ${String(value)}`);
    return value as T;
  }
  /** A run with one live owned child, connected and measured. */
  async opened(prompt: string): Promise<OwnedRun> {
    await this.request("/v2/runs", "POST", { mode: "ask", prompt, scope: { kind: "none" } });
    const run = await this.wait(() => {
      const file = join(this.root, `run-${prompt}.json`);
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as OwnedRun) : null;
    }, `run ${prompt} started`);
    expect(run.identity.status).toBe("known");
    this.owned.push(run.identity);
    await this.wait(() => this.holds.get(prompt) ?? null, `the child of ${prompt} to connect`);
    return run;
  }
  /** That run, with a next message reserved on it. */
  async started(prompt: string): Promise<{ run: OwnedRun; draft: string }> {
    const run = await this.opened(prompt);
    const { draft } = await this.request<{ draft: Draft }>("/v2/runs/next-message", "POST", {
      action: "create",
      predecessorId: run.jobId,
      prompt: "successor",
      attachments: [],
    });
    expect(draft.state).toBe("waiting");
    return { run, draft: draft.draftId };
  }
  /** The run ends with its child alive: a real reap out of budget, held for that custody. */
  async finishUnresolved(prompt: string, draft: string): Promise<void> {
    writeFileSync(join(this.root, `release-${prompt}`), "");
    await this.wait(async () => {
      const read = await this.draft(draft);
      return read.state === "held" ? read : null;
    }, `draft of ${prompt} held`);
    expect((await this.draft(draft)).hold?.code).toBe("settlement_unknown");
  }
  draft(id: string): Promise<Draft> {
    return this.request<Draft>(`/v2/runs/next-message/${id}`);
  }
  entries() {
    return (
      JSON.parse(readFileSync(this.index, "utf8")) as {
        entries: Array<{ marker: string; state: string }>;
      }
    ).entries;
  }
  /** The real later attempt ran: only the daemon could have ended this held child. */
  async laterAttemptRan(run: OwnedRun): Promise<void> {
    await this.wait(
      () =>
        !this.held(run.label).alive && !this.entries().some((row) => row.marker === run.marker)
          ? true
          : null,
      "the later attempt to end the child and retire the row",
    );
    expect(await this.birth(run.identity)).not.toBe("same");
  }
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (live(child)) {
      await this.rpc().shutdown();
      for (let count = 0; live(child) && count < 800; count += 1) await pause(25);
      expect(live(child), "the daemon must stop by itself").toBe(false);
    }
    await this.exited;
    expect(child.exitCode, this.stderr).toBe(0);
    this.child = null;
  }
  /** Null once the child is proved ended; another birth at its pid is a stranger, left alone. */
  private async unconfirmedEnd(expected: KnownProcessIdentity): Promise<string | null> {
    const deadline = Date.now() + this.confirmMs;
    for (;;) {
      const verdict = await this.birth(expected);
      if (verdict === "different" || verdict === "missing") return null;
      if (Date.now() >= deadline) return `child ${expected.pid} not proved ended (${verdict})`;
      await pause(25);
    }
  }
  /** Hands back the removal only once the daemon's exit and every child's end are proved.
   * Anything less rejects naming the root, which stays as the evidence. Signals no pid:
   * the daemon's handle cannot reach a recycled one, and a released child ends itself. */
  async dispose(): Promise<() => void> {
    const at = fixtures.indexOf(this);
    if (at >= 0) fixtures.splice(at, 1);
    const faults: string[] = [];
    await this.stop().catch((error: unknown) => faults.push(String(error)));
    if (this.child && live(this.child)) this.child.kill("SIGKILL");
    const exited = await Promise.race([
      this.exited.then(() => true),
      pause(this.confirmMs).then(() => false),
    ]);
    if (!exited) faults.push("the daemon's exit was not observed");
    for (const held of this.holds.values()) held.release();
    this.holdServer.close();
    for (const identity of this.owned) {
      const fault = await this.unconfirmedEnd(identity);
      if (fault) faults.push(fault);
    }
    if (faults.length) throw new Error(`kept ${this.root}: ${faults.join("; ")}`);
    return () =>
      rmSync(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

afterEachClosed(async (context) => {
  vi.unstubAllEnvs();
  // A failed test keeps its logs, index and run trees, as an unconfirmed stop does.
  const failed = context.task.result?.state === "fail";
  const removals: Array<() => void> = [];
  for (const fixture of fixtures.slice().reverse()) {
    const remove = await fixture.dispose();
    if (failed) console.warn(`fault evidence kept at ${fixture.root}`);
    else removals.push(remove);
  }
  return () => {
    for (const remove of removals) remove();
  };
}, 30_000);

describe("the fixture's own ending", () => {
  it("signals no pid, leaves a recycled one alone and keeps its root while an end is unproved", async () => {
    const kill = vi.spyOn(process, "kill");
    const self = await defaultAsyncProcessIdentityReader.read(process.pid);
    if (self.status !== "known") throw new Error(`no measured identity here: ${self.status}`);
    // This live pid under another birth is what a recycled pid looks like: not the child.
    const recycled = new Fixture();
    recycled.owned.push({ ...self, startToken: `${self.startToken}-recycled` });
    (await recycled.dispose())();
    expect(existsSync(recycled.root)).toBe(false);

    const unread: ProcessIdentity = {
      status: "unknown",
      pid: self.pid,
      platform: self.platform,
      reason: "io_error",
    };
    for (const observed of [unread, self]) {
      const unproved = new Fixture({ identity: { read: async () => observed }, confirmMs: 20 });
      unproved.owned.push(self);
      await expect(unproved.dispose()).rejects.toThrow(`kept ${unproved.root}`);
      expect(existsSync(join(unproved.config, "config.yaml"))).toBe(true);
      rmSync(unproved.root, { recursive: true, force: true });
    }
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  });
});

describe.skipIf(process.platform === "win32")("claudexord's later settlement", () => {
  it("records a later settlement and returns the held draft in the real daemon", async () => {
    const hostScopes = [`OURO_TASK_SCOPE_${"a".repeat(32)}`, `OURO_LAUNCH_SCOPE_${"b".repeat(32)}`];
    for (const name of hostScopes) vi.stubEnv(name, "1");
    vi.stubEnv(`CLAUDEXOR_RUN_SCOPE_${"c".repeat(32)}`, "1");
    const f = new Fixture();
    f.boot();
    await f.mode("normal");
    const control = await f.opened("open-control");
    const { run, draft } = await f.started("first");
    // The detached child stays in the host's custody and sheds any enclosing run, as a launch does.
    expect(f.held("first").markers).toEqual(expect.arrayContaining(hostScopes));
    expect(f.held("first").markers.filter(isRunScopeMarkerName)).toEqual([run.marker]);
    await f.finishUnresolved("first", draft);
    expect(existsSync(join(run.runDir, LATER_RECORD))).toBe(false);

    await f.laterAttemptRan(run);

    expect(
      existsSync(join(run.runDir, LATER_RECORD)),
      `no later record, so no subscriber took the settlement:\n${f.log}`,
    ).toBe(true);
    const later = JSON.parse(readFileSync(join(run.runDir, LATER_RECORD), "utf8"));
    expect(later).toMatchObject({ attempt: 1, outcome: { settled: true } });
    // The daemon's reap ended that exact process, by the birth measured at its spawn.
    expect(later.outcome.ended).toEqual([
      { pid: run.identity.pid, start_token: run.identity.startToken },
    ]);
    // The open run's scope is another marker's: the same reaper left it entirely alone.
    expect(f.held("open-control").alive).toBe(true);
    expect(await f.birth(control.identity)).toBe("same");
    expect(f.entries()).toContainEqual(
      expect.objectContaining({ marker: control.marker, state: "open" }),
    );
    const resumed = await f.wait(async () => {
      const read = await f.draft(draft);
      return read.resumed ? read : null;
    }, "the held draft to return");
    expect(resumed.resumed).toMatchObject({
      from: { code: "settlement_unknown" },
      reason: "process_scope_settled",
    });
    expect(run.subscribers).toBe(1);
    expect(f.log).not.toContain("is owed");
  }, 90_000);

  it("repeats a failed index write on its own tick, with no second reap or report", async () => {
    const f = new Fixture();
    f.boot();
    await f.mode("normal");
    const { run, draft } = await f.started("first");
    await f.finishUnresolved("first", draft);

    // A real outage of the real writer: a directory where its temporary file goes.
    mkdirSync(`${f.index}.tmp`);
    await f.wait(() => (f.held("first").alive ? null : true), "the later attempt to end the child");
    await f.wait(
      () => (existsSync(join(run.runDir, LATER_RECORD)) ? true : null),
      "the later record",
    );
    await f.wait(async () => ((await f.draft(draft)).resumed ? true : null), "the draft to return");
    await f.wait(
      () => (f.log.includes("could not be persisted") ? true : null),
      "the failed write to be disclosed",
    );
    // Reported and retired by the daemon; its file still holds the row it could not rewrite.
    expect(f.entries()).toEqual([expect.objectContaining({ marker: run.marker })]);
    const reported = readFileSync(join(run.runDir, LATER_RECORD), "utf8");

    rmdirSync(`${f.index}.tmp`);
    await f.wait(() => (f.entries().length === 0 ? true : null), "the repeated write to land");
    await pause(2_500);
    expect(readFileSync(join(run.runDir, LATER_RECORD), "utf8")).toBe(reported);
    expect(JSON.parse(reported)).toMatchObject({ attempt: 1, outcome: { settled: true } });
    expect(f.log.match(/later attempt \d+/g)).toEqual(["later attempt 1"]);
    expect(f.log).not.toContain("is owed");
    expect(f.log.match(/changes stay unpublished/g)).toHaveLength(1);
    expect(f.log.match(/have now landed/g)).toHaveLength(1);
  }, 90_000);

  it("ends the binding with a replaced store and binds the new one exactly once", async () => {
    const f = new Fixture();
    f.boot();
    await f.mode("normal");
    const { run: before, draft } = await f.started("before");
    await f.finishUnresolved("before", draft);

    // A store failure in the live daemon, then the operator's physical replacement.
    await f
      .request("/v2/runs", "POST", { mode: "ask", prompt: "corrupt", scope: { kind: "none" } })
      .catch(() => null);
    await f.mode("recovery_only");
    const inspected = await f.request<ControlJournalInspection>(
      "/v2/recovery/partitions/engine-state",
    );
    expect(inspected.status).toBe("recovery_required");
    await f.request("/v2/recovery/partitions/engine-state/quarantine", "POST", {
      expectedFingerprint: inspected.fingerprint,
      confirmation: "quarantine_and_start_fresh",
    });
    await f.mode("normal");

    // The same process, a new graph: one subscriber, not one per generation.
    const { run: after, draft: next } = await f.started("after");
    expect(after.subscribers).toBe(1);
    await f.finishUnresolved("after", next);
    await f.laterAttemptRan(after);
    await f.laterAttemptRan(before);
    expect(JSON.parse(readFileSync(join(after.runDir, LATER_RECORD), "utf8"))).toMatchObject({
      outcome: { settled: true },
    });
    await f.wait(async () => ((await f.draft(next)).resumed ? true : null), "the new draft");
    // No listener of the closed store was left to fail, or to be owed, on either report.
    expect(f.log).not.toContain("is owed");
    expect(f.log).not.toContain("a later settlement attempt failed");
  }, 120_000);

  it("reports nothing after shutdown: the next start settles the scope, the draft stays held", async () => {
    const f = new Fixture();
    f.boot();
    await f.mode("normal");
    const { run, draft } = await f.started("stopped");
    await f.request("/v2/runs", "POST", { mode: "ask", prompt: "slow", scope: { kind: "none" } });
    await f.wait(() => (existsSync(join(f.root, "run-slow.json")) ? true : null), "the slow run");
    await f.finishUnresolved("stopped", draft);

    // The later attempt falls due while this stop drains: the tick still fires, unbound.
    await f.stop();
    expect(f.held("stopped").alive).toBe(true);
    expect(await f.birth(run.identity)).toBe("same");
    expect(f.entries()).toEqual([expect.objectContaining({ marker: run.marker })]);
    expect(existsSync(join(run.runDir, LATER_RECORD))).toBe(false);

    f.boot();
    await f.mode("normal");
    await f.wait(() => (f.held("stopped").alive ? null : true), "the next start to end the child");
    expect(f.entries()).toEqual([]);
    expect(existsSync(join(run.runDir, LATER_RECORD))).toBe(false);
    expect(await f.draft(draft)).toMatchObject({
      state: "held",
      hold: { code: "settlement_unknown" },
    });
    expect((await f.draft(draft)).resumed).toBeUndefined();
  }, 120_000);
});
