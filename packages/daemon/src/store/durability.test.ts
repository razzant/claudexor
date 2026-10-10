import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** The store runs only where `node:sqlite` exists; elsewhere these cases are skipped, not failed. */
const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;

/**
 * Durability class (SYNTHESIS_R5 §13.2): a child process drives the BUILT
 * store, prints one `ACK <n>` line per committed transaction, and is killed
 * with SIGKILL at a chosen moment. Every acknowledged commit must be present
 * after reopening; the database must pass integrity_check; a row that names
 * an external file must find that file (the file is written before the row).
 */
const distStore = resolve(import.meta.dirname, "../../dist/store");
const childSource = `
import { EngineStore } from ${JSON.stringify(pathToFileURL(join(distStore, "store.js")).href)};
import { BlobFiles } from ${JSON.stringify(pathToFileURL(join(distStore, "blob-files.js")).href)};
import { writeExternalFile } from ${JSON.stringify(pathToFileURL(join(distStore, "external-files.js")).href)};

const [daemonDir, mode] = process.argv.slice(2);
const store = await EngineStore.open({
  daemonDir,
  workerEntry: ${JSON.stringify(join(distStore, "flusher-worker.js"))},
  flusherHooks: mode === "slow-pass" ? { passDelayMs: 400 } : {},
});
const blobs = new BlobFiles(store);
store.onSynced((g, report) => { if (report.barrier) process.stdout.write("BARRIER " + g + "\\n"); });
const insert = store.prepare("INSERT INTO command(id, pid, operation, state, created_at, summary, params_sha, kind) VALUES(?, 1, 'run.create', 'succeeded', ?, x'00', ?, 'product')");
let n = 0;
const tick = () => {
  n += 1;
  const id = "cmd-" + String(n).padStart(6, "0");
  const body = Buffer.alloc(70_000, n & 0xff);
  const ref = blobs.prepareBody(body);
  writeExternalFile(store, { dir: daemonDir + "/final", name: id + ".yaml", bytes: Buffer.from("facts " + n) });
  store.transaction(() => {
    blobs.insertRow(ref);
    insert.run(id, new Date().toISOString(), ref.sha256);
  });
  process.stdout.write("ACK " + n + "\\n");
  setTimeout(tick, 2);
};
tick();
`;

let root: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-durability-")));
  if (!existsSync(join(distStore, "store.js")))
    throw new Error("run pnpm build before the durability tests");
});
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  rmSync(root, { recursive: true, force: true });
});

interface Driven {
  child: ChildProcess;
  acks: number[];
  barriers: number[];
  killed: Promise<void>;
}

function drive(daemonDir: string, mode: "normal" | "slow-pass"): Driven {
  const script = join(root, "child.mjs");
  writeFileSync(script, childSource);
  mkdirSync(daemonDir, { recursive: true });
  const child = spawn(process.execPath, [script, daemonDir, mode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const acks: number[] = [];
  const barriers: number[] = [];
  let buffered = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const [kind, value] = line.split(" ");
      if (kind === "ACK") acks.push(Number(value));
      if (kind === "BARRIER") barriers.push(Number(value));
    }
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const killed = new Promise<void>((resolve, reject) => {
    child.once("exit", (code, signal) => {
      if (signal === "SIGKILL") resolve();
      else reject(new Error(`child exited early (code ${code}, signal ${signal}): ${stderr}`));
    });
  });
  return { child, acks, barriers, killed };
}

async function until(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function verify(
  daemonDir: string,
  acked: number,
): Promise<{ rows: number; integrity: string }> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(daemonDir, "engine.sqlite"));
  try {
    const integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
      .integrity_check;
    const rows = db.prepare("SELECT id, params_sha FROM command ORDER BY id").all() as Array<{
      id: string;
      params_sha: string;
    }>;
    // Every ACKed commit is present, in order, and the prefix is dense.
    expect(rows.length).toBeGreaterThanOrEqual(acked);
    for (let i = 0; i < acked; i += 1) {
      expect(rows[i]!.id).toBe(`cmd-${String(i + 1).padStart(6, "0")}`);
    }
    // A row's body file and its terminal file exist: files precede rows.
    const blobs = new Set(readdirSync(join(daemonDir, "resource-store", "blobs")));
    const finals = new Set(readdirSync(join(daemonDir, "final")));
    for (const row of rows) {
      expect(blobs.has(row.params_sha), `blob for ${row.id}`).toBe(true);
      expect(finals.has(`${row.id}.yaml`), `final for ${row.id}`).toBe(true);
    }
    return { rows: rows.length, integrity };
  } finally {
    db.close();
  }
}

describeStore("durability class (SYNTHESIS_R5 §13.2)", () => {
  it("kill -9 after ACK: every acknowledged commit survives, the database is intact", async () => {
    const daemonDir = join(root, "after-ack");
    const driven = drive(daemonDir, "normal");
    await until(() => driven.acks.length >= 40, "40 acks");
    driven.child.kill("SIGKILL");
    await driven.killed;
    const acked = driven.acks.length;
    expect(acked).toBeGreaterThanOrEqual(40);
    const result = await verify(daemonDir, acked);
    expect(result.integrity).toBe("ok");
    expect(result.rows).toBeGreaterThanOrEqual(acked);
  });

  it("kill -9 during a flusher pass: the barrier in flight loses nothing already acknowledged", async () => {
    const daemonDir = join(root, "mid-pass");
    const driven = drive(daemonDir, "slow-pass");
    // A pass takes >= 400 ms here; kill ~100 ms after a barrier report, i.e. inside the next pass.
    await until(
      () => driven.barriers.length >= 1 && driven.acks.length >= 20,
      "a barrier and 20 acks",
    );
    await new Promise((r) => setTimeout(r, 300));
    driven.child.kill("SIGKILL");
    await driven.killed;
    const acked = driven.acks.length;
    const result = await verify(daemonDir, acked);
    expect(result.integrity).toBe("ok");
    expect(result.rows).toBeGreaterThanOrEqual(acked);
  });

  it("power-loss snapshot: a copy of engine.sqlite, its WAL and the external files is a consistent prefix", async () => {
    const daemonDir = join(root, "snapshot");
    const driven = drive(daemonDir, "normal");
    await until(() => driven.acks.length >= 30, "30 acks");
    // Snapshot at one instant T: freeze the writer (and its flusher thread),
    // drain the ACKs already written, copy database, WAL and files, resume.
    driven.child.kill("SIGSTOP");
    await new Promise((r) => setTimeout(r, 100));
    const ackedAtSnapshot = driven.acks.length;
    const snapshot = join(root, "snapshot-copy");
    mkdirSync(join(snapshot, "resource-store", "blobs"), { recursive: true });
    mkdirSync(join(snapshot, "final"), { recursive: true });
    copyFileSync(join(daemonDir, "engine.sqlite"), join(snapshot, "engine.sqlite"));
    if (existsSync(join(daemonDir, "engine.sqlite-wal")))
      copyFileSync(join(daemonDir, "engine.sqlite-wal"), join(snapshot, "engine.sqlite-wal"));
    const copyPublished = (dir: string): void => {
      for (const name of readdirSync(join(daemonDir, dir))) {
        if (name.endsWith(".tmp")) continue;
        copyFileSync(join(daemonDir, dir, name), join(snapshot, dir, name));
      }
    };
    copyPublished(join("resource-store", "blobs"));
    copyPublished("final");
    driven.child.kill("SIGCONT");
    driven.child.kill("SIGKILL");
    await driven.killed;
    // The copy opened on its own is a consistent prefix of the history: every
    // commit acknowledged before the freeze, at most one commit whose ACK had
    // not reached the pipe yet, never a torn row.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(snapshot, "engine.sqlite"));
    let rows: Array<{ id: string; params_sha: string }>;
    try {
      expect(
        (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
      ).toBe("ok");
      rows = db.prepare("SELECT id, params_sha FROM command ORDER BY id").all() as never;
    } finally {
      db.close();
    }
    expect(rows.length).toBeGreaterThanOrEqual(ackedAtSnapshot);
    expect(rows.length).toBeLessThanOrEqual(ackedAtSnapshot + 1);
    rows.forEach((row, index) => expect(row.id).toBe(`cmd-${String(index + 1).padStart(6, "0")}`));
    const blobs = new Set(readdirSync(join(snapshot, "resource-store", "blobs")));
    const finals = new Set(readdirSync(join(snapshot, "final")));
    for (const row of rows) {
      expect(blobs.has(row.params_sha)).toBe(true);
      expect(finals.has(`${row.id}.yaml`)).toBe(true);
    }
  });
});
