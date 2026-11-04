import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DaemonClient, inspectDaemonWriterLease } from "@claudexor/daemon";
import { describe, expect, it } from "vitest";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const sqlite = await import("node:sqlite").catch(() => null);
const daemonEntry = resolve(import.meta.dirname, "../dist/claudexord.js");

/** Preloaded into the REAL daemon: holds one startup step until SIGTERM. Its
 * listener is added after the daemon's own, so the daemon's shutdown has begun
 * when the step continues against whatever that shutdown left. The interval
 * stands in for the handle a real pending listen or dial keeps alive. */
const HOLD_STEP = String.raw`
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { isMainThread } from "node:worker_threads";
const step = process.env.CX_HOLD_STEP;
if (isMainThread && step) {
  // Observe the signal supplied by the actual daemon registration, without replacing
  // that argument or the effect. The graph tests exercise what the effect does.
  if (process.env.CX_WATCH_STARTUP_PURGE === "1") registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!url.endsWith("/thread-purge.js")) return loaded;
      const text = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
      const at = "export function startupPurgeEffect(noProjectRoot, laneStores, stop) {";
      if (text.split(at).length !== 2) throw new Error("startup purge observation point changed");
      const observe = "\nprocess.stderr.write('startup-purge-registered\\n');\n" +
        "stop.addEventListener('abort', () => process.stderr.write('startup-purge-aborted\\n'), { once: true });\n";
      return { ...loaded, source: text.replace(at, at + observe) };
    }
  });
  const net = createRequire(import.meta.url)("node:net");
  let armed = true;
  const hold = () => {
    armed = false;
    appendFileSync(process.env.CX_HOLD_MARK, "held\n");
    if (process.env.CX_HOLD_UNTIL !== "sigterm") return Promise.resolve();
    const alive = setInterval(() => {}, 1000);
    return new Promise((done) => process.once("SIGTERM", () => (clearInterval(alive), done())));
  };
  if (step === "retention-pass") {
    // The REAL scheduled pass is admitted at once and held at its first awaited
    // read; the real stop then waits for it through cancel and flight. A prompt
    // naming the preflight hold stays past the HTTP gate until it is released.
    const edit = (loaded, at, by) => {
      const text = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
      if (text.split(at).length !== 2) throw new Error("retention observation point changed: " + at);
      return { ...loaded, source: text.replace(at, by) };
    };
    const waitFor = async (name) => {
      appendFileSync(process.env.CX_HOLD_MARK, name + "-held\n");
      while (!existsSync(process.env.CX_HOLD_MARK + "." + name)) await new Promise((done) => setTimeout(done, 10));
    };
    globalThis.cxHold = waitFor;
    registerHooks({
      load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);
        const pass = process.env.CX_HOLD_PASS === "1";
        if (pass && url.endsWith("/retention-schedule.js"))
          return edit(loaded, "opts.delayMs ?? 60_000", "opts.delayMs ?? 1");
        if (pass && url.endsWith("/retention-service.js")) {
          const read = "const maintenanceThreads = await deps.threads.retentionThreads(signal);";
          return edit(loaded, read, "await globalThis.cxHold('retention');\n" + read);
        }
        if (url.endsWith("/run-start-preparation.js")) {
          const next = "await services.validateResources?.(request.attachments ?? []);";
          return edit(loaded, next, "if (request.prompt === 'cx603 held preflight') await globalThis.cxHold('preflight');\n" + next);
        }
        return loaded;
      },
    });
  } else if (step === "handshake") {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (!armed || !String(init?.body ?? "").includes('"client":"claudexord-startup"'))
        return realFetch(url, init);
      await hold();
      return realFetch(process.env.CX_HOLD_REDIRECT || url, init);
    };
  } else if (step === "socket-health") {
    const realConnect = net.connect;
    const listening = () => existsSync(process.env.CX_HOLD_LOG) &&
      readFileSync(process.env.CX_HOLD_LOG, "utf8").includes("claudexord listening on");
    net.connect = net.createConnection = function (...args) {
      if (!armed || args[0] !== process.env.CX_HOLD_SOCKET || !listening())
        return realConnect.apply(this, args);
      const socket = new net.Socket();
      void hold().then(() => socket.connect(args[0]));
      return socket;
    };
    syncBuiltinESMExports();
  } else if (step === "control-listen") {
    const realListen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...args) {
      if (!armed || typeof args[0] !== "number" || args[1] !== "127.0.0.1")
        return realListen.apply(this, args);
      void hold().then(() => realListen.apply(this, args));
      return this;
    };
  }
}
`;

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const live = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
const tail = (text: string) => text.slice(-16_384);

/** One exact child a test spawned, in the private root that only it uses. */
interface OwnedChild {
  label: string;
  root: string;
  child: ChildProcess;
  closed: Promise<boolean>;
  stderr: () => string;
  /** Files under the root that a failure report carries. */
  evidence: string[];
}
interface Bounds {
  termMs: number;
  killMs: number;
}
const owned: OwnedChild[] = [];
const servers: Server[] = [];

function own(label: string, root: string, child: ChildProcess, evidence: string[]): OwnedChild {
  let stderr = "";
  child.stderr?.on("data", (part) => (stderr = tail(stderr + String(part))));
  const closed = new Promise<boolean>((done) => child.once("close", () => done(true)));
  const entry = { label, root, child, closed, stderr: () => stderr, evidence };
  owned.push(entry);
  return entry;
}

/** The exit result once the child's output closed too, so its stderr is
 * complete; null when that takes longer than `ms`. */
function exitedAndClosed<T>(exited: Promise<T>, entry: OwnedChild, ms: number) {
  const settled = Promise.all([exited, entry.closed]).then(([result]) => result);
  return Promise.race([settled, pause(ms).then(() => null)]);
}

function diagnostics(entry: OwnedChild): string {
  const { pid, exitCode, signalCode } = entry.child;
  const files = entry.evidence.map(
    (path) => `--- ${path}\n${existsSync(path) ? tail(readFileSync(path, "utf8")) : "(absent)"}`,
  );
  const exit = exitCode ?? signalCode ?? "not observed";
  return [`=== ${entry.label}: pid ${pid ?? "unknown"}, exit ${exit}`, "--- stderr", entry.stderr()]
    .concat(files)
    .join("\n");
}

/** Joins exactly these test-owned children (SIGTERM, then SIGKILL, each
 * bounded; a child whose exit was observed is never signalled) and servers.
 * A failed test's diagnostics are read before anything is removed. The returned
 * tail removes roots only after this close phase finishes within its hook deadline.
 * An unclosed child keeps its root and a cleanup receipt; real cleanup errors stay red. */
async function prepareTeardown(
  children: OwnedChild[],
  ownServers: Server[],
  failed: boolean,
  bounds: Bounds = { termMs: 5_000, killMs: 5_000 },
): Promise<() => void> {
  const notes: string[] = [];
  const removable: string[] = [];
  let incomplete = false;
  for (const entry of children) {
    let closed = false;
    for (const [signal, ms] of [
      ["SIGTERM", bounds.termMs],
      ["SIGKILL", bounds.killMs],
    ] as const) {
      if (live(entry.child)) entry.child.kill(signal);
      closed = await Promise.race([entry.closed, pause(ms).then(() => false)]);
      if (closed) break;
    }
    if (failed || !closed) notes.push(diagnostics(entry));
    if (closed) {
      removable.push(entry.root);
      continue;
    }
    incomplete = true;
    const receipt = join(entry.root, "cleanup-incomplete.json");
    const record = { label: entry.label, pid: entry.child.pid ?? null, bounds };
    writeFileSync(receipt, `${JSON.stringify(record, null, 2)}\n`);
    notes.push(`kept ${entry.root}: pid ${record.pid ?? "unknown"} did not close; see ${receipt}`);
  }
  for (const server of ownServers) {
    server.closeAllConnections();
    const shut = new Promise<boolean>((done) => server.close(() => done(true)));
    if (!(await Promise.race([shut, pause(bounds.killMs).then(() => false)]))) {
      incomplete = true;
      notes.push("a test-owned server did not close");
    }
  }
  const head = failed ? "test failed; fixture diagnostics:" : "fixture cleanup incomplete:";
  if (incomplete) throw new Error([head, ...notes].join("\n"));
  return () => {
    for (const root of removable) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        notes.push(`kept ${root}: removal failed: ${String(error)}`);
      }
    }
    if (notes.length) throw new Error([head, ...notes].join("\n"));
  };
}

/** Direct witness calls exercise the same close and removal phases as the hook. */
async function teardown(
  children: OwnedChild[],
  ownServers: Server[],
  failed: boolean,
  bounds?: Bounds,
): Promise<void> {
  (await prepareTeardown(children, ownServers, failed, bounds))();
}

afterEachClosed(
  (context) =>
    prepareTeardown(owned.splice(0), servers.splice(0), context.task.result?.state === "fail"),
  30_000,
);

/** Answers the startup handshake as ANOTHER runtime, or occupies a port. */
async function foreignRuntime(): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        engine: { version: "0.0.0-foreign", sha: "f".repeat(40) },
        servingMode: "recovery_only",
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as { port: number }).port;
}

/** A real built daemon in a private root, no credentials, with one step held. */
function startDaemon(hold: Record<string, string>, extra: Record<string, string> = {}) {
  expect(existsSync(daemonEntry), "build the daemon before this process qualification").toBe(true);
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "cx278-")));
  const [home, config, temporary] = ["home", "config", "tmp"].map((name) => join(root, name));
  const daemonDir = join(config, "daemon");
  for (const dir of [home, daemonDir, temporary]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const disabled = { enabled: false, native_credentials_enabled: false };
  const harnesses = ["claude", "codex", "cursor", "agy", "copilot", "opencode", "grok", "raw-api"];
  writeFileSync(
    join(config, "config.yaml"),
    JSON.stringify({
      version: 1,
      credential_profiles: [],
      harnesses: Object.fromEntries([...harnesses, "openrouter"].map((id) => [id, disabled])),
    }),
    { mode: 0o600 },
  );
  const preload = join(root, "hold-step.mjs");
  writeFileSync(preload, HOLD_STEP);
  const socket = join(daemonDir, "claudexord.sock");
  const mark = join(root, "hold.mark");
  const log = join(daemonDir, "claudexord.log");
  const env = {
    HOME: home,
    USER: "fixture",
    LOGNAME: "fixture",
    XDG_CONFIG_HOME: join(home, ".config"),
    TMPDIR: temporary,
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    CLAUDEXOR_CONFIG_DIR: config,
    CLAUDEXOR_CONTROL_PORT: "0",
    CX_HOLD_MARK: mark,
    CX_HOLD_SOCKET: socket,
    CX_HOLD_LOG: log,
    ...hold,
    ...extra,
  };
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, daemonEntry], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
    env,
  });
  const entry = own(`daemon holding ${hold.CX_HOLD_STEP ?? "nothing"}`, root, child, [log, mark]);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
  return {
    child,
    root,
    env,
    socket,
    database: join(daemonDir, "engine.sqlite"),
    log: () => read(log),
    stderr: entry.stderr,
    async held(name = "held") {
      for (let tries = 0; !read(mark).includes(name); tries += 1) {
        if (!live(child) || tries > 800) throw new Error(`step was never held: ${entry.stderr()}`);
        await pause(25);
      }
    },
    release(name: string) {
      writeFileSync(`${mark}.${name}`, "released\n");
    },
    token: () => readFileSync(join(daemonDir, "token"), "utf8").trim(),
    control() {
      return JSON.parse(readFileSync(join(daemonDir, "control-api.json"), "utf8")) as {
        host: string;
        port: number;
      };
    },
    async exit() {
      const result = await exitedAndClosed(exited, entry, 20_000);
      if (!result)
        throw new Error(`daemon did not exit and close: ${entry.stderr()}\n${read(log)}`);
      expect(inspectDaemonWriterLease(socket).status).toBe("absent");
      return result;
    },
  };
}

describe.skipIf(process.platform === "win32" || !sqlite)(
  "a Stop during startup transport bind or self-proof (issue #278)",
  () => {
    it.each([
      ["the self-proof's Control handshake", "handshake"],
      ["the self-proof's socket health dial", "socket-health"],
      ["the Control API listen", "control-listen"],
    ])(
      "stops cleanly when SIGTERM arrives during %s",
      async (_label, step) => {
        const daemon = startDaemon({
          CX_HOLD_STEP: step,
          CX_HOLD_UNTIL: "sigterm",
          CX_WATCH_STARTUP_PURGE: "1",
        });
        await daemon.held();
        expect(daemon.stderr()).toContain("startup-purge-registered");
        daemon.child.kill("SIGTERM");
        expect(await daemon.exit(), daemon.stderr()).toEqual({ code: 0, signal: null });
        expect(daemon.stderr()).toContain("startup-purge-aborted");
        expect(daemon.log()).toContain("shutdown requested (SIGTERM)");
        expect(daemon.log()).toContain("claudexord shut down");
        expect(daemon.log()).not.toContain("daemon lifecycle FAILED");
      },
      60_000,
    );

    it("still fails startup when the self-proof reaches another runtime", async () => {
      const port = await foreignRuntime();
      const daemon = startDaemon({
        CX_HOLD_STEP: "handshake",
        CX_HOLD_REDIRECT: `http://127.0.0.1:${port}/v2/handshake`,
      });
      expect((await daemon.exit()).code).toBe(1);
      expect(daemon.stderr()).toContain("did not prove this exact recovery-only runtime");
    }, 60_000);

    it("still fails startup when the Control API port is taken while a Stop is under way", async () => {
      const port = await foreignRuntime();
      const daemon = startDaemon(
        { CX_HOLD_STEP: "control-listen", CX_HOLD_UNTIL: "sigterm" },
        { CLAUDEXOR_CONTROL_PORT: String(port) },
      );
      await daemon.held();
      daemon.child.kill("SIGTERM");
      expect((await daemon.exit()).code).toBe(1);
      expect(daemon.log()).toContain("shutdown requested (SIGTERM)");
      expect(daemon.stderr()).toContain("EADDRINUSE");
    }, 60_000);
  },
);

type RetentionDaemon = ReturnType<typeof startDaemon>;
const evidenceRoot = process.env.CLAUDEXOR_REPLACEMENT_FENCE_EVIDENCE;
const askRequest = (prompt: string) => ({ mode: "ask", prompt });

/** A real built daemon at normal admission, with the listed holds available. */
async function normalDaemon(
  pass: "held" | "none",
): Promise<RetentionDaemon & { rpc: DaemonClient }> {
  const daemon = startDaemon({
    CX_HOLD_STEP: "retention-pass",
    CX_HOLD_PASS: pass === "held" ? "1" : "0",
  });
  for (let tries = 0; ; tries += 1) {
    const mode = await Promise.resolve()
      .then(() => new DaemonClient(daemon.socket, daemon.token()).health())
      .then((health) => (health as { servingMode?: string }).servingMode)
      .catch(() => null);
    if (mode === "normal") break;
    if (!live(daemon.child) || tries > 800)
      throw new Error(`no normal admission: ${daemon.stderr()}\n${daemon.log()}`);
    await pause(25);
  }
  if (pass === "held") await daemon.held("retention-held");
  return Object.assign(daemon, { rpc: new DaemonClient(daemon.socket, daemon.token()) });
}

function http(daemon: RetentionDaemon, path: string, body: unknown, key: string) {
  const { host, port } = daemon.control();
  return fetch(`http://${host}:${port}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.token()}`,
      "x-claudexor-protocol-major": "3",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
}

async function replacementTarget(daemon: RetentionDaemon) {
  const hello = (await (
    await http(daemon, "/v2/handshake", { protocolMajor: 3, client: "cx603-fixture" }, "hello")
  ).json()) as { engine: { version: string; sha: string } };
  const lease = inspectDaemonWriterLease(daemon.socket);
  if (lease.status !== "owned") throw new Error(`no writer lease: ${JSON.stringify(lease)}`);
  return {
    version: hello.engine.version,
    buildSha: hello.engine.sha,
    leaseOwner: { pid: lease.owner.pid, token: lease.owner.token },
  };
}

async function settled(rpc: DaemonClient, id: string): Promise<void> {
  for (let tries = 0; ; tries += 1) {
    const { state } = await rpc.status(id);
    if (state !== "queued" && state !== "running") return;
    if (tries > 800) throw new Error(`job ${id} stayed ${state}`);
    await pause(25);
  }
}

/** What actually reached the engine store, read after the owner process exited. */
function acceptedPrompts(database: string): string[] {
  const db = new sqlite!.DatabaseSync(database, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT json_extract(CAST(summary AS TEXT),'$.promptPreview') AS prompt FROM command ORDER BY rowid",
      )
      .all() as Array<{ prompt: string | null }>;
    return rows.map((row) => String(row.prompt));
  } finally {
    db.close();
  }
}

/** The observed outcome of one attempt, kept whole for the assertion message. */
const outcome = (attempt: Promise<unknown>) =>
  attempt.then(
    (value) => ({ answered: value }),
    (error: { code?: unknown; message?: unknown }) => ({
      refused: error?.code ?? String(error?.message),
    }),
  );

function record(name: string, value: unknown): void {
  if (!evidenceRoot) return;
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(join(evidenceRoot, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

function runStop(daemon: RetentionDaemon, target: { version: string; buildSha: string }) {
  const child = spawn(process.execPath, [daemonEntry, "--stop", target.version, target.buildSha], {
    cwd: daemon.root,
    stdio: ["ignore", "pipe", "pipe"],
    env: daemon.env,
  });
  let stdout = "";
  child.stdout!.on("data", (part) => (stdout += String(part)));
  const entry = own("claudexord --stop", mkdtempSync(join(daemon.env.TMPDIR, "stop-")), child, []);
  const done = new Promise<number | null>((finish) => child.once("exit", finish));
  return {
    async result() {
      const code = await exitedAndClosed(done, entry, 25_000);
      return { code, answer: JSON.parse(stdout) as Record<string, unknown> };
    },
  };
}

describe.skipIf(process.platform === "win32" || !sqlite)(
  "the production stop while a real retention pass drains (issue #603)",
  () => {
    it("fences socket, in-process and preaccepted HTTP admission before the held pass ends", async () => {
      const daemon = await normalDaemon("held");
      const { rpc } = daemon;

      // Positive controls: while the pass is held the engine serves normally.
      const socketRun = await rpc.enqueue(askRequest("socket before"), {
        idempotencyKey: "socket-before",
      });
      expect(socketRun.reused).toBe(false);
      await expect(
        rpc.enqueue(askRequest("socket before"), { idempotencyKey: "socket-before" }),
      ).resolves.toMatchObject({ id: socketRun.id, reused: true });
      await settled(rpc, socketRun.id);
      const httpRun = await http(daemon, "/v2/runs", askRequest("http before"), "http-before");
      expect(httpRun.status, await httpRun.clone().text()).toBeLessThan(300);
      await settled(rpc, ((await httpRun.json()) as { jobId: string }).jobId);

      // An inexact instance is refused and leaves every ingress open.
      const target = await replacementTarget(daemon);
      for (const wrong of [
        { ...target, buildSha: "b".repeat(40) },
        { ...target, version: `${target.version}-other` },
        { ...target, leaseOwner: { pid: target.leaseOwner.pid, token: "prior-process" } },
      ])
        await expect(rpc.shutdownForRuntimeReplacement(wrong)).rejects.toMatchObject({
          code: "runtime_activity_unknown",
        });
      const stillOpen = await rpc.enqueue(askRequest("after refusal"), {
        idempotencyKey: "after-refusal",
      });
      await settled(rpc, stillOpen.id);

      // One start is past the HTTP gate, one socket connection is already open.
      const held = http(daemon, "/v2/runs", askRequest("cx603 held preflight"), "held-preflight");
      await daemon.held("preflight-held");
      const open = connect(daemon.socket);
      await new Promise<void>((done) => open.once("connect", () => done()));
      let openAnswer = "";
      const openClosed = new Promise<void>((done) => {
        open.on("data", (part) => (openAnswer += String(part)));
        open.on("close", () => done());
        open.on("error", () => done());
      });

      const ack = await outcome(rpc.shutdownForRuntimeReplacement(target));

      const line = {
        id: 1,
        method: "claudexor.enqueue",
        token: daemon.token(),
        params: { request: askRequest("late open socket"), idempotencyKey: "late-open" },
      };
      if (!open.destroyed) open.write(`${JSON.stringify(line)}\n`);
      const fresh = await outcome(
        rpc.enqueue(askRequest("late fresh socket"), { idempotencyKey: "late-fresh" }),
      );
      const freshHttp = await outcome(
        http(daemon, "/v2/runs", askRequest("late fresh http"), "late-http").then((r) => r.json()),
      );
      await Promise.race([openClosed, pause(500)]);
      daemon.release("preflight");
      const heldAnswer = await outcome(held.then(async (r) => [r.status, await r.json()]));
      const second = await runStop(daemon, target).result();
      const beforeRelease = {
        daemonAlive: live(daemon.child),
        socketPresent: existsSync(daemon.socket),
        lease: inspectDaemonWriterLease(daemon.socket).status,
        shutDown: daemon.log().includes("claudexord shut down"),
      };
      record("held-fence", {
        ack,
        fresh,
        freshHttp,
        openAnswer,
        heldAnswer,
        second,
        beforeRelease,
      });

      // The receipt is delivered or lost; only its exact form grants signals.
      if ("answered" in ack)
        expect(ack.answered).toEqual({ ok: true, fenced: true, targetBound: true });
      else expect(ack.refused).toBe("daemon_unavailable");
      expect.soft(fresh).not.toHaveProperty("answered");
      expect.soft(freshHttp).not.toHaveProperty("answered.jobId");
      expect.soft(openAnswer).not.toContain('"result"');
      expect.soft(heldAnswer).toMatchObject({
        answered: [503, expect.objectContaining({ code: "daemon_stopping" })],
      });
      // A live lease without a socket is no restart permission and no second stop.
      expect.soft(beforeRelease).toEqual({
        daemonAlive: true,
        socketPresent: false,
        lease: "owned",
        shutDown: false,
      });
      expect.soft(second.code).toBe(1);
      expect.soft(second.answer).toMatchObject({
        stopped: false,
        code: "runtime_activity_unknown",
      });

      daemon.release("retention");
      expect(await daemon.exit(), daemon.log()).toEqual({ code: 0, signal: null });
      expect(daemon.log()).toContain("shutdown requested (runtime replacement stop)");
      expect(daemon.log()).toContain("claudexord shut down");
      expect(acceptedPrompts(daemon.database)).toEqual([
        "socket before",
        "http before",
        "after refusal",
      ]);
    }, 120_000);

    it("the real --stop reports the exact daemon's exit once the held pass drains", async () => {
      const daemon = await normalDaemon("held");
      const target = await replacementTarget(daemon);
      const stop = runStop(daemon, target);
      for (let tries = 0; existsSync(daemon.socket); tries += 1) {
        if (tries > 400) throw new Error(`the fence never closed the socket: ${daemon.log()}`);
        await pause(25);
      }
      expect(live(daemon.child)).toBe(true);
      daemon.release("retention");
      const stopped = await stop.result();
      record("real-stop", stopped);
      expect(stopped.code).toBe(0);
      expect(stopped.answer).toMatchObject({ stopped: true, outcome: "exited" });
      expect(await daemon.exit()).toEqual({ code: 0, signal: null });
    }, 120_000);

    it("records the replacement receipt with no pass in flight, and the daemon still exits", async () => {
      const daemon = await normalDaemon("none");
      const ack = await outcome(
        daemon.rpc.shutdownForRuntimeReplacement(await replacementTarget(daemon)),
      );
      record("idle-ack", ack);
      if ("answered" in ack)
        expect(ack.answered).toEqual({ ok: true, fenced: true, targetBound: true });
      else expect(ack.refused).toBe("daemon_unavailable");
      expect(await daemon.exit(), daemon.log()).toEqual({ code: 0, signal: null });
      expect(acceptedPrompts(daemon.database)).toEqual([]);
    }, 120_000);

    it.each([
      ["SIGTERM", (daemon: RetentionDaemon) => void daemon.child.kill("SIGTERM"), "SIGTERM"],
      [
        "the ordinary shutdown RPC",
        (daemon: RetentionDaemon) =>
          void new DaemonClient(daemon.socket, daemon.token()).shutdown(),
        "socket-rpc stop",
      ],
    ])(
      "%s closes the socket during the held pass and exits cleanly",
      async (_label, trigger, reason) => {
        const daemon = await normalDaemon("held");
        trigger(daemon);
        for (let tries = 0; existsSync(daemon.socket); tries += 1) {
          if (tries > 400) throw new Error(`stop never closed the socket: ${daemon.log()}`);
          await pause(25);
        }
        expect(live(daemon.child)).toBe(true);
        await expect(
          daemon.rpc.enqueue(askRequest("late"), { idempotencyKey: "late" }),
        ).rejects.toMatchObject({ code: "daemon_unavailable" });
        daemon.release("retention");
        expect(await daemon.exit(), daemon.log()).toEqual({ code: 0, signal: null });
        expect(daemon.log()).toContain(`shutdown requested (${reason})`);
        expect(acceptedPrompts(daemon.database)).toEqual([]);
      },
      120_000,
    );
  },
);

describe.skipIf(process.platform === "win32")("this file's fixture teardown (witness)", () => {
  /** A plain child in its own root: on SIGTERM it waits, records OUTSIDE the
   * root whether the root still exists, appends a last log line, then exits. */
  const WITNESS = String.raw`
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [root, marker] = process.argv.slice(1);
process.on("SIGTERM", () => setTimeout(() => {
  const present = existsSync(root);
  writeFileSync(marker, present ? "root present at exit" : "root removed before exit");
  if (present) appendFileSync(join(root, "witness.log"), "witness exit line\n");
  process.exit(0);
}, 250));
appendFileSync(join(root, "witness.log"), "witness log line\n");
process.stderr.write("witness ready\n");
setInterval(() => {}, 1000);
`;
  const scratch = (prefix: string) =>
    realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));

  async function witnessChild() {
    const root = scratch("cx278-w-");
    const outside = scratch("cx278-wm-");
    const marker = join(outside, "marker");
    const child = spawn(process.execPath, ["-e", WITNESS, root, marker], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const entry = own("witness child", root, child, [join(root, "witness.log")]);
    for (let tries = 0; !entry.stderr().includes("witness ready"); tries += 1) {
      if (!live(child) || tries > 400) throw new Error(`witness not ready: ${entry.stderr()}`);
      await pause(25);
    }
    return { entry, root, outside, marker };
  }

  it("joins the child and its server before the root is removed", async () => {
    const witness = await witnessChild();
    const port = await foreignRuntime();
    try {
      await teardown(owned.splice(0), servers.splice(0), false);
      expect(readFileSync(witness.marker, "utf8")).toBe("root present at exit");
      expect(witness.entry.child.exitCode).toBe(0);
      expect(existsSync(witness.root)).toBe(false);
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    } finally {
      rmSync(witness.outside, { recursive: true, force: true });
    }
  });

  it("reports a failed test's diagnostics, read after exit and before removal", async () => {
    const witness = await witnessChild();
    try {
      await expect(teardown(owned.splice(0), [], true)).rejects.toThrow(
        /test failed[\s\S]*witness ready[\s\S]*witness log line\nwitness exit line/,
      );
      expect(existsSync(witness.root)).toBe(false);
    } finally {
      rmSync(witness.outside, { recursive: true, force: true });
    }
  });

  it("keeps a root whose child did not close, with a receipt", async () => {
    const root = scratch("cx278-w-");
    const signals: string[] = [];
    // A stand-in that never closes; its kill() reaches no process at all.
    const stub = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      stderr: null,
      kill: (signal: string) => signals.push(signal) > 0,
    });
    own("stand-in child", root, stub as unknown as ChildProcess, []);
    try {
      await expect(
        teardown(owned.splice(0), [], false, { termMs: 20, killMs: 20 }),
      ).rejects.toThrow(/cleanup incomplete[\s\S]*kept .*did not close/);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(existsSync(root)).toBe(true);
      expect(JSON.parse(readFileSync(join(root, "cleanup-incomplete.json"), "utf8"))).toMatchObject(
        { label: "stand-in child", pid: null },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a child exit only once its output closed", async () => {
    const root = scratch("cx278-w-");
    const release = join(root, "release");
    // The child exits at once; a grandchild holding its stderr writes one last
    // line only after `release` exists (or after 30 s), then closes it.
    const lateWriter = String.raw`
const { existsSync } = require("node:fs");
const deadline = Date.now() + 30000;
const timer = setInterval(() => {
  if (!existsSync(process.argv[1]) && Date.now() < deadline) return;
  clearInterval(timer);
  process.stderr.write("late stderr line\n");
}, 20);
`;
    const exitsEarly = String.raw`
require("node:child_process").spawn(process.execPath, ["-e", process.argv[1], process.argv[2]], {
  stdio: ["ignore", "ignore", "inherit"],
});
process.exit(3);
`;
    const child = spawn(process.execPath, ["-e", exitsEarly, lateWriter, release], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const entry = own("delayed-close child", root, child, []);
    const exited = new Promise<{ code: number | null }>((done) =>
      child.once("exit", (code) => done({ code })),
    );
    expect(await exited).toEqual({ code: 3 });
    // The exit arrived while its output was still open: stderr is not complete.
    expect(entry.stderr()).not.toContain("late stderr line");
    writeFileSync(release, "");
    expect(await exitedAndClosed(exited, entry, 20_000)).toEqual({ code: 3 });
    expect(entry.stderr()).toContain("late stderr line");
  });
});
