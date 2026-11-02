import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  executeWin32ProcessTimes,
  ProcessIdentityService,
  type KnownProcessIdentity,
} from "@claudexor/core";
import {
  canonicalDefaultSocketPath,
  inspectDaemonWriterLease,
  isWindowsPipePath,
  readRootAuthority,
  ROOT_AUTHORITY_MARKER_FILE,
  writerLeaseAnchorPath,
  writerLeasePath,
  writerLeaseTombstonePath,
  type DaemonLeaseOwner,
} from "@claudexor/daemon";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { afterAll, expect, it } from "vitest";
import { CONTROL_PROTOCOL_MAJOR, controlApiAddress, controlApiFetch } from "./live.js";

const DAEMON = resolve(import.meta.dirname, "../dist/claudexord.js");
const CLI = resolve(import.meta.dirname, "../dist/cli.js");
const BUILD_SHA = "5".repeat(40);
const OS_FACTS = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT"];

const timings: Record<string, number> = {};
// Observations for the lane's log, never a gate: hosted load decides these numbers. Written
// directly so that no reporter's handling of passing tests' console output can drop them.
afterAll(() => {
  process.stdout.write(`writer-birth timings (ms): ${JSON.stringify(timings)}\n`);
});

interface Finished {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
}

interface Owned {
  child: ChildProcess;
  label: string;
  finished: Promise<Finished>;
  stderr(): string;
}

function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/** Private root, credential-free environment and exact custody of every child. */
function createFixture() {
  const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), "cxwb-")));
  const [home, config, temp] = ["home", "config", "tmp"].map((name) => join(root, name)) as [
    string,
    string,
    string,
  ];
  for (const dir of [home, config, temp]) mkdirSync(dir, { mode: 0o700 });
  // The test's own lease and Control reads address this root; vitest.setup restores it.
  process.env.CLAUDEXOR_CONFIG_DIR = config;
  const systemRoot = process.env.SystemRoot;
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      OS_FACTS.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
    ),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    PATH: [
      dirname(process.execPath),
      ...(systemRoot ? [join(systemRoot, "System32")] : ["/usr/bin", "/bin"]),
    ].join(delimiter),
    CLAUDEXOR_CONFIG_DIR: config,
    CLAUDEXOR_CONTROL_PORT: "0",
    CLAUDEXOR_BUILD_SHA: BUILD_SHA,
  };
  const owned: Owned[] = [];
  const launch = (label: string, args: readonly string[]): Owned => {
    const startedAt = performance.now();
    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (part) => (stdout = `${stdout}${String(part)}`.slice(-65_536)));
    child.stderr?.on("data", (part) => (stderr = `${stderr}${String(part)}`.slice(-16_384)));
    const finished = new Promise<Finished>((done) => {
      const settle = (code: number | null, signal: NodeJS.Signals | null) =>
        done({ code, signal, stdout, stderr, ms: Math.round(performance.now() - startedAt) });
      child.once("error", (error) => {
        stderr += `spawn failed: ${error.message}\n`;
        settle(null, null);
      });
      child.once("close", settle);
    });
    const entry = { child, label, finished, stderr: () => stderr };
    owned.push(entry);
    return entry;
  };
  const finish = (label: string, args: readonly string[]): Promise<Finished> =>
    within(launch(label, args).finished, 120_000, label);

  /** An unrelated process the test owns; its answer proves that it kept running. */
  const startWitness = () => {
    const child = spawn(
      process.execPath,
      ["-e", "process.on('message', (m) => process.send(m)); setInterval(() => {}, 1000);"],
      { cwd: root, env, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true },
    );
    const finished = new Promise<Finished>((done) => {
      const settle = (code: number | null, signal: NodeJS.Signals | null) =>
        done({ code, signal, stdout: "", stderr: "", ms: 0 });
      child.once("error", () => settle(null, null));
      child.once("close", settle);
    });
    owned.push({ child, label: "witness", finished, stderr: () => "" });
    const answers = () =>
      new Promise<void>((done, fail) => {
        const nonce = randomUUID();
        const settle = (error?: Error | null) => {
          clearTimeout(timer);
          child.off("message", onMessage);
          if (error) fail(error);
          else done();
        };
        const onMessage = (message: unknown) => {
          if (message === nonce) settle();
        };
        const timer = setTimeout(() => settle(new Error("the witness stopped answering")), 30_000);
        child.on("message", onMessage);
        child.send(nonce, (error) => {
          if (error) settle(error);
        });
      });
    return { pid: child.pid!, answers };
  };

  const diagnostics = () => {
    const log = join(config, "daemon", "claudexord.log");
    return [
      ...owned.map(({ label, child, stderr }) => `--- ${label} pid ${child.pid}\n${stderr()}`),
      `--- ${log}\n${existsSync(log) ? readFileSync(log, "utf8").slice(-16_384) : "(absent)"}`,
    ].join("\n");
  };

  /** Signals only these exact children; a root is removed only after each one closed. */
  const dispose = async (): Promise<string[]> => {
    const notes: string[] = [];
    for (const { child, label, finished } of owned) {
      const closed = (ms: number) =>
        Promise.race([finished.then(() => true), delay(ms, false, { ref: false })]);
      if (await closed(0)) continue;
      child.kill();
      if (await closed(10_000)) continue;
      child.kill("SIGKILL");
      if (!(await closed(10_000))) notes.push(`${label} pid ${child.pid} did not close`);
    }
    if (notes.length > 0) return [...notes, `kept ${root}`];
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    return notes;
  };

  return { launch, finish, startWitness, diagnostics, dispose };
}

interface Served {
  version: string;
  sha: string;
  storeId: string | undefined;
  ms: number;
}

/** The real authenticated handshake over the descriptor the daemon published. */
async function awaitServing(daemon: Owned): Promise<Served> {
  const startedAt = performance.now();
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
      throw new Error(`${daemon.label} exited before serving:\n${daemon.stderr()}`);
    }
    try {
      const response = await controlApiFetch(controlApiAddress(), "/v2/handshake", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Claudexor-Store-Identity": "1" },
        body: JSON.stringify({
          protocolMajor: CONTROL_PROTOCOL_MAJOR,
          client: "writer-birth-qualification",
        }),
        signal: AbortSignal.timeout(5_000),
      });
      const answer = (await response.json()) as {
        servingMode?: string;
        engine?: { version: string; sha: string };
        storeId?: string;
      };
      if (response.ok && answer.servingMode === "normal" && answer.engine) {
        return {
          version: answer.engine.version,
          sha: answer.engine.sha,
          storeId: answer.storeId,
          ms: Math.round(performance.now() - startedAt),
        };
      }
    } catch {
      /* descriptor or listener not ready yet; the bounded loop owns the verdict */
    }
    if (Date.now() >= deadline) {
      throw new Error(`${daemon.label} never reached normal admission:\n${daemon.stderr()}`);
    }
    await delay(100);
  }
}

it("runs the built daemon's writer lease through its default endpoint and stop paths", async () => {
  for (const entry of [DAEMON, CLI]) {
    expect(existsSync(entry), `build the CLI before this qualification: ${entry}`).toBe(true);
  }
  const fixture = createFixture();
  let failed = true;
  try {
    const socket = canonicalDefaultSocketPath();
    if (process.platform === "win32") expect(isWindowsPipePath(socket)).toBe(true);
    const anchor = writerLeaseAnchorPath(socket);
    const reader = new ProcessIdentityService({ runWin32Reader: executeWin32ProcessTimes });

    const first = fixture.launch("first daemon", [DAEMON]);
    const served = await awaitServing(first);
    timings.start_to_normal = served.ms;
    expect(served).toMatchObject({ version: CLAUDEXOR_VERSION, sha: BUILD_SHA });
    expect(served.storeId).toBeTruthy();
    const health = await fixture.finish("status", [CLI, "daemon", "status", "--json"]);
    expect(health.code, health.stderr).toBe(0);
    expect(JSON.parse(health.stdout)).toMatchObject({ ok: true, servingMode: "normal" });

    const active = writerLeasePath(socket);
    expect(basename(active)).toBe("active.writer");
    const ownerPath = join(active, "owner.json");
    const ownerBytes = readFileSync(ownerPath, "utf8");
    const owner = JSON.parse(ownerBytes) as DaemonLeaseOwner;
    expect(owner.pid).toBe(first.child.pid);
    // The changed behavior. Soft, so the unchanged lifecycle below still runs when it is red.
    expect
      .soft(owner.identity)
      .toMatchObject(
        process.platform === "win32"
          ? { platform: "win32", source: "win32_process_times", pid: owner.pid }
          : { status: "known", pid: owner.pid },
      );
    expect.soft(inspectDaemonWriterLease(socket)).toMatchObject({
      status: "owned",
      capability: { status: "capable", reason: "identity_match" },
    });

    const markerPath = join(anchor, ROOT_AUTHORITY_MARKER_FILE);
    const marker = readFileSync(markerPath, "utf8");
    expect(readRootAuthority(anchor)).toMatchObject({
      status: "valid",
      record: { state: "served", floor: CLAUDEXOR_VERSION },
    });
    const expectAuthorityUnchanged = () => expect(readFileSync(markerPath, "utf8")).toBe(marker);

    const second = await fixture.finish("second daemon", [DAEMON]);
    timings.second_start_refused = second.ms;
    expect(second.code).toBe(1);
    expect(second.stderr).toContain(`another claudexor daemon owns ${active}`);
    expect(readFileSync(ownerPath, "utf8")).toBe(ownerBytes);
    expectAuthorityUnchanged();
    await awaitServing(first);

    // Exact replacement stop, retrying only refusals the daemon itself calls retryable.
    const stopDeadline = Date.now() + 30_000;
    for (;;) {
      const stop = await fixture.finish("replacement stop", [
        DAEMON,
        "--stop",
        served.version,
        served.sha,
      ]);
      const answer = JSON.parse(stop.stdout) as {
        stopped?: boolean;
        retryable?: boolean;
        outcome?: string;
      };
      timings.replacement_stop = stop.ms;
      if (stop.code === 0 && answer.stopped) {
        expect(answer.outcome).toBe("exited");
        break;
      }
      if (!answer.retryable || Date.now() >= stopDeadline) {
        throw new Error(`replacement stop failed: ${stop.stdout}\n${stop.stderr}`);
      }
      await delay(500);
    }
    expect(await within(first.finished, 30_000, "first daemon exit")).toMatchObject({
      code: 0,
      signal: null,
    });
    expect(inspectDaemonWriterLease(socket)).toMatchObject({ status: "absent" });
    expectAuthorityUnchanged();

    const witness = fixture.startWitness();
    await witness.answers();
    const readStartedAt = performance.now();
    const birth = reader.read(witness.pid);
    timings.birth_read = Math.round(performance.now() - readStartedAt);
    if (birth.status !== "known") throw new Error(`no witness birth: ${JSON.stringify(birth)}`);
    const expectWitnessUntouched = async (known: KnownProcessIdentity) => {
      await witness.answers();
      expect(reader.read(witness.pid)).toEqual(known);
    };
    const seed = (seeded: DaemonLeaseOwner): string => {
      const bytes = `${JSON.stringify(seeded)}\n`;
      mkdirSync(active, { mode: 0o700 });
      writeFileSync(ownerPath, bytes, { mode: 0o600, flag: "wx" });
      return bytes;
    };
    const stopOperator = async (daemon: Owned, label: string) => {
      const stop = await fixture.finish(label, [CLI, "daemon", "stop", "--json"]);
      timings[label] = stop.ms;
      expect(stop.code, stop.stderr).toBe(0);
      expect(JSON.parse(stop.stdout)).toMatchObject({ stopped: true, outcome: "exited" });
      expect(await within(daemon.finished, 30_000, `${daemon.label} exit`)).toMatchObject({
        code: 0,
        signal: null,
      });
      expect(inspectDaemonWriterLease(socket)).toMatchObject({ status: "absent" });
      expectAuthorityUnchanged();
    };

    // A PID-only record of a live process holds, and a failed stop neither proves nor moves it.
    const legacy: DaemonLeaseOwner = { pid: witness.pid, token: "synthetic-pid-only" };
    const legacyBytes = seed(legacy);
    const anchorEntries = readdirSync(anchor).sort();
    const held = await fixture.finish("daemon over PID-only record", [DAEMON]);
    timings.pid_only_refused = held.ms;
    expect(held.code).toBe(1);
    expect(held.stderr).toContain(`another claudexor daemon owns ${active}`);
    const failedStop = await fixture.finish("stop with no daemon", [
      CLI,
      "daemon",
      "stop",
      "--json",
    ]);
    expect(failedStop.code).not.toBe(0);
    expect(readFileSync(ownerPath, "utf8")).toBe(legacyBytes);
    expect(readdirSync(anchor).sort()).toEqual(anchorEntries);
    expectAuthorityUnchanged();
    await expectWitnessUntouched(birth);

    // The documented manual step: after outside proof, one reversible rename of this generation.
    const backup = `${active}.operator-backup-qualification`;
    renameSync(active, backup);
    const recovered = fixture.launch("daemon after manual rename", [DAEMON]);
    const recoveredServed = await awaitServing(recovered);
    timings.start_after_manual_rename = recoveredServed.ms;
    expect(recoveredServed.storeId).toBe(served.storeId);
    expect(readFileSync(join(backup, "owner.json"), "utf8")).toBe(legacyBytes);
    expectAuthorityUnchanged();
    await expectWitnessUntouched(birth);
    await stopOperator(recovered, "operator_stop");
    expect(readFileSync(join(backup, "owner.json"), "utf8")).toBe(legacyBytes);

    // SYNTHETIC mismatch: a seeded digit on a process that really lives, not a recycled PID.
    const mismatched: DaemonLeaseOwner = {
      pid: witness.pid,
      token: "synthetic-mismatch",
      identity: {
        ...birth,
        startToken: birth.startToken.replace(/\d$/, (d) => String((Number(d) + 1) % 10)),
      },
    };
    const mismatchedBytes = seed(mismatched);
    const replacement = fixture.launch("daemon over mismatched birth", [DAEMON]);
    const replacementServed = await awaitServing(replacement);
    timings.start_over_mismatch = replacementServed.ms;
    expect(replacementServed.storeId).toBe(served.storeId);
    expect(
      readFileSync(join(writerLeaseTombstonePath(active, mismatched), "owner.json"), "utf8"),
    ).toBe(mismatchedBytes);
    const replaced = JSON.parse(readFileSync(ownerPath, "utf8")) as DaemonLeaseOwner;
    expect(replaced.pid).toBe(replacement.child.pid);
    expectAuthorityUnchanged();
    await expectWitnessUntouched(birth);
    await stopOperator(replacement, "operator_stop_after_replacement");
    await expectWitnessUntouched(birth);
    failed = false;
  } finally {
    if (failed) console.error(fixture.diagnostics());
    const notes = await fixture.dispose();
    if (notes.length > 0) {
      if (failed) console.error(notes.join("\n"));
      else throw new Error(`fixture cleanup incomplete:\n${notes.join("\n")}`);
    }
  }
}, 300_000);
