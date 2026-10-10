import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { DaemonClient } from "@claudexor/daemon";
import type {
  ControlDaemonStatus,
  ControlJournalInspection,
  ControlJournalQuarantineReceipt,
} from "@claudexor/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  DurableJournal,
  journalPartitionDirectory,
} from "../../daemon/src/store/test-support/fixtures/legacy/journal/index.js";

const sqlite = await import("node:sqlite").catch(() => null);
const daemonEntry = resolve(import.meta.dirname, "../dist/claudexord.js");
const evidenceRoot = process.env.CLAUDEXOR_SQL_STARTUP_EVIDENCE;
const fixtures: Fixture[] = [];
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const live = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/** A real built daemon with no inherited credentials, native login or vendor
 * request. One fixture process at a time; dispose joins its exact PID before
 * removing the root. Optional evidence is outside the source checkout. */
class Fixture {
  readonly root = realpathSync(
    mkdtempSync(
      join(process.platform === "win32" ? tmpdir() : realpathSync("/tmp"), "cx-sql-start-"),
    ),
  );
  readonly config = join(this.root, "config");
  readonly daemon = join(this.config, "daemon");
  readonly database = join(this.daemon, "engine.sqlite");
  readonly socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\claudexord-${createHash("sha256").update(resolve(this.daemon)).digest("hex").slice(0, 16)}`
      : join(this.daemon, "claudexord.sock");
  private child: ChildProcess | null = null;
  private exited: Promise<void> = Promise.resolve();
  private stdout = "";
  private stderr = "";
  private launch = 0;
  private readonly observations: unknown[] = [];
  private readonly settings: string;

  constructor(readonly label: string) {
    for (const dir of [this.config, this.daemon, join(this.root, "home"), join(this.root, "tmp")])
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.settings = JSON.stringify({
      version: 1,
      credential_profiles: [],
      harnesses: Object.fromEntries(
        ["claude", "codex", "cursor", "agy", "copilot", "opencode", "raw-api", "openrouter"].map(
          (id) => [id, { enabled: false, native_credentials_enabled: false }],
        ),
      ),
    });
    writeFileSync(join(this.config, "config.yaml"), this.settings, { mode: 0o600 });
    fixtures.push(this);
  }

  start(extra: Record<string, string> = {}): void {
    expect(
      this.child === null || !live(this.child),
      "previous fixture process must have exited",
    ).toBe(true);
    expect(existsSync(daemonEntry), "build the daemon before this process qualification").toBe(
      true,
    );
    rmSync(join(this.daemon, "control-api.json"), { force: true });
    this.stdout = this.stderr = "";
    this.launch += 1;
    const home = join(this.root, "home"),
      temporary = join(this.root, "tmp");
    const child = spawn(process.execPath, [daemonEntry], {
      cwd: this.root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: home,
        USERPROFILE: home,
        USER: "fixture",
        LOGNAME: "fixture",
        XDG_CONFIG_HOME: join(home, ".config"),
        APPDATA: join(home, "AppData"),
        LOCALAPPDATA: join(home, "LocalAppData"),
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary,
        PATH: [
          dirname(process.execPath),
          ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"]),
        ].join(delimiter),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        CLAUDEXOR_CONFIG_DIR: this.config,
        CLAUDEXOR_CONTROL_PORT: "0",
        ...extra,
      },
    });
    this.child = child;
    child.stdout!.on("data", (part) => {
      this.stdout += String(part);
    });
    child.stderr!.on("data", (part) => {
      this.stderr += String(part);
    });
    this.exited = new Promise<void>((done, reject) => {
      child.once("error", reject);
      child.once("exit", () => done());
    });
    this.observations.push({
      launch: this.launch,
      pid: child.pid,
      home,
      config: this.config,
      extra,
    });
  }

  get pid() {
    return this.child?.pid;
  }
  get log() {
    const file = join(this.daemon, "claudexord.log");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }
  rpc() {
    return new DaemonClient(this.socket, readFileSync(join(this.daemon, "token"), "utf8").trim());
  }
  private address() {
    const pointer = JSON.parse(readFileSync(join(this.daemon, "control-api.json"), "utf8")) as {
      host: string;
      port: number;
      tokenPath: string;
    };
    expect(pointer.tokenPath).toBe(join(this.daemon, "token"));
    expect(pointer.host).toBe("127.0.0.1");
    return {
      base: `http://${pointer.host}:${pointer.port}`,
      token: readFileSync(pointer.tokenPath, "utf8").trim(),
    };
  }
  async wait<T>(
    probe: () => Promise<T | null> | T | null,
    what: string,
    timeout = 25_000,
  ): Promise<T> {
    const deadline = Date.now() + timeout;
    let last: unknown;
    while (Date.now() < deadline) {
      if (!this.child || !live(this.child))
        throw new Error(`${what}: daemon exited; ${this.stderr}\n${this.log}`);
      try {
        const value = await probe();
        if (value !== null) return value;
      } catch (error) {
        last = error;
      }
      await pause(25);
    }
    throw new Error(`${what}: ${String(last)}\n${this.stderr}\n${this.log}`);
  }
  async httpReady() {
    await this.wait(async () => {
      this.address();
      return (await this.request<{ ok: boolean }>("/healthz")).ok ? true : null;
    }, "fixture recovery HTTP listener");
  }
  async mode(expected: string) {
    return this.wait(async () => {
      const health = (await this.rpc().health()) as ControlDaemonStatus;
      return health.servingMode === expected ? health : null;
    }, `RPC serving mode ${expected}`);
  }
  async request<T = Record<string, unknown>>(
    path: string,
    method = "GET",
    body?: unknown,
    status = 200,
    key = randomUUID(),
  ): Promise<T> {
    const { base, token } = this.address();
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "x-claudexor-protocol-major": "3",
        "content-type": "application/json",
        "idempotency-key": key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const value: unknown = await response.json();
    this.observations.push({ launch: this.launch, path, method, status: response.status, value });
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value as T;
  }
  async hello() {
    return this.request<{ servingMode: string }>("/v2/handshake", "POST", {
      protocolMajor: 3,
      client: "sql-startup-fixture",
    });
  }
  async quarantine(name: string, inspection: ControlJournalInspection, key = randomUUID()) {
    return this.request<ControlJournalQuarantineReceipt>(
      `/v2/recovery/partitions/${encodeURIComponent(name)}/quarantine`,
      "POST",
      {
        expectedFingerprint: inspection.fingerprint,
        confirmation: "quarantine_and_start_fresh",
      },
      200,
      key,
    );
  }
  async stop() {
    const child = this.child;
    if (!child) return;
    let forced = false;
    let shutdownProblem: unknown;
    if (live(child)) {
      // The ordinary shutdown RPC is reachable during recovery/import too,
      // and exercises graceful shutdown on Windows where SIGTERM is a kill.
      try {
        await this.rpc().shutdown();
      } catch (error) {
        shutdownProblem = error;
        child.kill("SIGTERM");
      }
      for (let count = 0; live(child) && count < 400; count += 1) await pause(25);
      if (live(child)) {
        forced = true;
        child.kill("SIGKILL");
      }
    }
    await this.exited;
    this.observations.push({
      launch: this.launch,
      exit: child.exitCode,
      signal: child.signalCode,
      forced,
      shutdownProblem: shutdownProblem === undefined ? null : String(shutdownProblem),
    });
    if (evidenceRoot) {
      mkdirSync(evidenceRoot, { recursive: true });
      const prefix = join(
        evidenceRoot,
        `${this.label}-${this.root.split(/[\\/]/).at(-1)}-${this.launch}`,
      );
      writeFileSync(`${prefix}.stdout.log`, this.stdout);
      writeFileSync(`${prefix}.stderr.log`, this.stderr);
      writeFileSync(`${prefix}.daemon.log`, this.log);
      writeFileSync(`${prefix}.json`, JSON.stringify(this.observations, null, 2));
    }
    expect(forced, `fixture PID ${child.pid} required forced cleanup`).toBe(false);
    expect(
      shutdownProblem,
      "ordinary shutdown RPC must acknowledge before process exit",
    ).toBeUndefined();
    expect(child.exitCode, this.stderr).toBe(0);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  }
  async dispose() {
    try {
      await this.stop();
      expect(readFileSync(join(this.config, "config.yaml"), "utf8")).toBe(this.settings);
      expect(existsSync(join(this.config, "migration", "accounts-unified.json"))).toBe(false);
    } finally {
      if (this.child && live(this.child)) throw new Error("refusing to remove a live fixture root");
      rmSync(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.dispose();
}, 30_000);

function seedCopiedJournal(f: Fixture, count = 1, promptBytes = 16) {
  const source = join(f.root, `legacy-source-${randomUUID()}`);
  const journal = new DurableJournal({
    rootDir: source,
    partition: "global",
    deferCompaction: true,
  });
  try {
    journal.appendBatch(
      Array.from({ length: count }, (_, index) => ({
        type: "command.accepted",
        payload: {
          record: {
            id: `legacy-${index}`,
            state: "queued",
            params: { mode: "agent", prompt: `kept-${index}-${"x".repeat(promptBytes)}` },
            createdAt: new Date().toISOString(),
          },
          keyDigest: `key-${index}`,
          requestDigest: `request-${index}`,
        },
      })),
    );
  } finally {
    journal.close();
  }
  const journalRoot = join(f.daemon, "journal");
  cpSync(source, journalRoot, { recursive: true });
  // cpSync creates destination directories with the process umask (0755 on
  // macOS), which correctly makes the copied journal require recovery. Keep
  // this healthy-copy fixture's original 0700 directory modes, as the legacy
  // startup recovery fixture does; do not weaken the production inspection.
  chmodSync(journalRoot, statSync(source).mode & 0o777);
  chmodSync(
    journalPartitionDirectory(journalRoot, "global"),
    statSync(journalPartitionDirectory(source, "global")).mode & 0o777,
  );
  return {
    source: join(journalPartitionDirectory(source, "global"), "journal.bin"),
    archived: join(
      journalPartitionDirectory(join(f.daemon, "journal-legacy"), "global"),
      "journal.bin",
    ),
  };
}

function readSql<T>(
  f: Fixture,
  fn: (db: InstanceType<NonNullable<typeof sqlite>["DatabaseSync"]>) => T,
): T {
  const db = new sqlite!.DatabaseSync(f.database);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe.skipIf(!sqlite)("production SQL daemon startup process qualification", () => {
  it("starts a fresh root, serves real health and global/project threads, then closes SQL", async () => {
    const f = new Fixture("fresh");
    f.start();
    await f.httpReady();
    expect(["recovery_only", "normal"]).toContain((await f.hello()).servingMode);
    await f.mode("normal");
    expect((await f.hello()).servingMode).toBe("normal");
    const status = await f.request<ControlDaemonStatus>("/v2/daemon/status");
    expect(status.store).toMatchObject({ obligations_open: 0, migration: null });
    const global = await f.request<{ id: string }>("/v2/threads", "POST", {
      title: "global SQL",
      workspace: "in_place",
    });
    const projectRoot = join(f.root, "project");
    mkdirSync(projectRoot);
    const project = await f.request<{ id: string }>("/v2/projects", "POST", { root: projectRoot });
    const scoped = await f.request<{ id: string }>("/v2/threads", "POST", {
      title: "project SQL",
      scope: { kind: "project", root: projectRoot },
      workspace: "in_place",
    });
    const listed = await f.request<{ threads: Array<{ id: string }> }>("/v2/threads");
    expect(listed.threads.map((row) => row.id)).toEqual(
      expect.arrayContaining([global.id, scoped.id]),
    );
    expect(
      (await f.request<{ projects: Array<{ id: string }> }>("/v2/projects")).projects.map(
        (row) => row.id,
      ),
    ).toContain(project.id);
    expect((await f.request<{ runs: unknown[] }>("/v2/runs")).runs).toEqual([]);
    await f.stop();
    expect(existsSync(join(f.daemon, "journal"))).toBe(false);
    readSql(f, (db) => {
      expect(db.prepare("SELECT count(*) AS n FROM thread").get()).toEqual({ n: 2 });
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    });
  }, 45_000);

  it("imports a copied tiny journal, retains commands, and restarts with SQL priority over legacy bytes", async () => {
    const f = new Fixture("legacy");
    const legacy = seedCopiedJournal(f, 2),
      original = hash(legacy.source);
    f.start();
    await f.httpReady();
    await f.mode("normal");
    const imported = await f.rpc().status("legacy-0");
    expect(imported).toMatchObject({ id: "legacy-0", state: "interrupted" });
    expect((await f.request<{ runs: unknown[] }>("/v2/runs")).runs).toHaveLength(2);
    expect(hash(legacy.source)).toBe(original);
    expect(hash(legacy.archived)).toBe(original);
    await f.stop();
    const canaryDir = journalPartitionDirectory(join(f.daemon, "journal"), "global");
    mkdirSync(canaryDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(canaryDir, "journal.bin"), "must not replay this old source", {
      mode: 0o600,
    });
    const priorImport = readSql(f, (db) =>
      db.prepare("SELECT * FROM import_partition ORDER BY name").all(),
    );
    const logOffset = f.log.length;
    f.start();
    await f.httpReady();
    await f.mode("normal");
    expect(await f.rpc().status("legacy-0")).toEqual(imported);
    expect(f.log.slice(logOffset)).not.toContain("legacy import published");
    expect(hash(legacy.archived)).toBe(original);
    await f.stop();
    expect(
      readSql(f, (db) => db.prepare("SELECT * FROM import_partition ORDER BY name").all()),
    ).toEqual(priorImport);
    expect(existsSync(join(f.daemon, "engine.sqlite.import"))).toBe(false);
  }, 60_000);

  it("keeps recovery HTTP alive for damaged SQL with control disabled, then replaces it in the same process", async () => {
    const f = new Fixture("physical");
    const damaged = Buffer.from("NOT A SQLITE DATABASE: retained original evidence");
    writeFileSync(f.database, damaged, { mode: 0o600 });
    f.start({ CLAUDEXOR_NO_CONTROL_API: "1" });
    await f.httpReady();
    await f.mode("recovery_only");
    expect((await f.hello()).servingMode).toBe("recovery_only");
    expect(await f.request("/v2/threads", "GET", undefined, 503)).toMatchObject({
      code: "daemon_recovery_only",
    });
    expect((await f.request<ControlDaemonStatus>("/v2/daemon/status")).store).toMatchObject({
      integrity: "failed",
      obligations_open: null,
    });
    const inspected = await f.request<ControlJournalInspection>(
      "/v2/recovery/partitions/engine-state",
    );
    expect(inspected.status).toBe("recovery_required");
    const pid = f.pid,
      key = randomUUID();
    const receipt = await f.quarantine("engine-state", inspected, key);
    await f.mode("normal");
    expect(f.pid).toBe(pid);
    expect(readFileSync(join(receipt.quarantinePath, "engine.sqlite"))).toEqual(damaged);
    expect(await f.quarantine("engine-state", inspected, key)).toEqual(receipt);
    expect(
      (
        await f.request<{ id: string }>("/v2/threads", "POST", {
          title: "after physical replacement",
        })
      ).id,
    ).toBeTruthy();
    await f.stop();
    readSql(f, (db) =>
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" }),
    );
  }, 60_000);

  it("rebinds a quarantined global generation and keeps old SQL rows as evidence", async () => {
    const f = new Fixture("logical");
    seedCopiedJournal(f);
    f.start();
    await f.httpReady();
    await f.mode("normal");
    const projectRoot = join(f.root, "project");
    mkdirSync(projectRoot);
    await f.request("/v2/projects", "POST", { root: projectRoot });
    const old = await f.request<{ id: string }>("/v2/threads", "POST", { title: "old global" });
    await f.stop();
    readSql(f, (db) =>
      db.exec(
        "UPDATE partition SET status='recovery_required' WHERE id=(SELECT CAST(value AS INTEGER) FROM meta WHERE key='global_pid'); UPDATE command SET live=0",
      ),
    );
    f.start();
    await f.httpReady();
    await f.mode("recovery_only");
    // Recovery transport precedes SQL attachment. Its initial 503 is expected;
    // wait for the public storage facts before exercising logical recovery.
    await f.wait(async () => {
      const status = await f.request<ControlDaemonStatus>("/v2/daemon/status");
      return status.store?.flusher ? status : null;
    }, "SQL attachment before logical recovery");
    const inspected = await f.request<ControlJournalInspection>("/v2/recovery/partitions/global");
    expect(inspected.status).toBe("recovery_required");
    const pid = f.pid,
      key = randomUUID();
    const receipt = await f.quarantine("global", inspected, key);
    await f.mode("normal");
    expect(f.pid).toBe(pid);
    expect(await f.quarantine("global", inspected, key)).toEqual(receipt);
    expect((await f.request<{ projects: unknown[] }>("/v2/projects")).projects).toEqual([]);
    expect(
      (await f.request<{ threads: Array<{ id: string }> }>("/v2/threads")).threads.map(
        (row) => row.id,
      ),
    ).not.toContain(old.id);
    expect((await f.request<{ runs: unknown[] }>("/v2/runs")).runs).toEqual([]);
    await f.request("/v2/threads", "POST", { title: "new global" });
    await f.stop();
    readSql(f, (db) => {
      expect(db.prepare("SELECT id FROM thread WHERE id=?").get(old.id)).toEqual({ id: old.id });
      expect(db.prepare("SELECT live FROM command WHERE id='legacy-0'").get()).toEqual({ live: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM partition WHERE name='global'").get()).toEqual({
        n: 2,
      });
    });
  }, 60_000);

  it("honors disabled HTTP control for a healthy SQL root while real RPC remains available", async () => {
    const f = new Fixture("no-control");
    f.start({ CLAUDEXOR_NO_CONTROL_API: "1" });
    await f.mode("normal");
    expect(existsSync(join(f.daemon, "control-api.json"))).toBe(false);
    expect(await f.rpc().list({ page: { limit: 10, cursor: null, state: null } })).toEqual([]);
    await f.stop();
  }, 45_000);

  it("shuts down during a real import and retains its source for the next startup", async () => {
    const f = new Fixture("import-stop");
    const legacy = seedCopiedJournal(f, 5000, 4096),
      original = hash(legacy.source);
    f.start();
    await f.httpReady();
    const status = await f.wait(async () => {
      const value = await f.request<ControlDaemonStatus>("/v2/daemon/status");
      return value.store?.migration &&
        ["reading", "importing", "verifying"].includes(value.store.migration.phase) &&
        value.servingMode === "recovery_only" &&
        !existsSync(f.database)
        ? value
        : null;
    }, "actual import progress before shutdown");
    expect(status.store?.migration).not.toBeNull();
    await f.stop();
    expect(hash(legacy.source)).toBe(original);
    expect(existsSync(join(f.daemon, "journal"))).toBe(true);
    expect(existsSync(f.database)).toBe(false);
  }, 60_000);
});
