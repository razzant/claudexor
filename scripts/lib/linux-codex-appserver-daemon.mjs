/** The daemon cell of the Linux Codex app-server probe. The REAL built Claudexor daemon and
 * orchestrator run ONE readonly ask on harness codex as processes of the cell's unit. The daemon
 * selects `codex` itself through its managed PATH, admits the lane through its own doctor (Codex
 * `login status`, then the isolated API-key smoke) and takes its own api_key route: a fresh
 * CODEX_HOME holding only an auth.json with the cell's labelled dummy key, provider variables
 * scrubbed. The one redirect is outside Claudexor: Codex's system config layer names the loopback
 * scripted provider (written by the orchestrator on a disposable runner, or by a local launcher
 * for a protocol smoke), and that provider also answers the doctor's `Reply exactly OK`. That is
 * admission through a fixture route, never account or auth readiness; nothing here writes a
 * login, a doctor verdict or a readiness record. Classification is pure and lives in
 * linux-codex-appserver-cell.mjs. */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { daemonAskRequest, modelExecCommand } from "./linux-codex-appserver-cell.mjs";
import { startScriptedProvider } from "./scripted-responses-provider.mjs";

/** Start, ask, stop and the exit wait together stay inside the unit's RuntimeMaxSec (600 s):
 * 120 + 240 + 120 + 30 s at worst. */
export const DAEMON_RUN_TIMEOUT_MS = 240_000;
const CLI_TIMEOUT_MS = 120_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tryValue(read) {
  try {
    return read();
  } catch {
    return null;
  }
}

/** The product CLI as a child process with the cell's environment, recorded completely. */
function runCli(spec, raw, name, args) {
  const argv = [process.execPath, join(spec.repo, "packages/cli/dist/cli.js"), ...args];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(argv[0], argv.slice(1), { cwd: spec.project, env: process.env });
    const out = [];
    const err = [];
    let error = null;
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    const timer = setTimeout(() => {
      error = "ETIMEDOUT";
      child.kill("SIGKILL");
    }, CLI_TIMEOUT_MS);
    child.once("error", (spawnError) => (error = String(spawnError?.code ?? spawnError)));
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const record = { argv, status, signal, error, ms: Date.now() - started };
      writeFileSync(join(raw, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
      writeFileSync(join(raw, `${name}.stdout`), stdout);
      writeFileSync(join(raw, `${name}.stderr`), Buffer.concat(err));
      resolve({ ...record, json: tryValue(() => JSON.parse(stdout)) });
    });
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function pidGone(pid, timeoutMs) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
  return true;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => (timer = setTimeout(() => resolve({ timedOut: true }), ms))),
  ]);
}

/** Event types the run journal recorded, counted, from `<runDir>/events.jsonl`. */
function eventTypes(runDir) {
  const counts = {};
  const text = tryValue(() => readFileSync(join(runDir, "events.jsonl"), "utf8")) ?? "";
  for (const line of text.split("\n").filter(Boolean)) {
    const type = tryValue(() => JSON.parse(line).type) ?? "unparseable";
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

/** One readonly ask through the running daemon, with its run detail and run directory kept.
 * A typed product refusal (an error carrying a `code`) is a known outcome, kept as
 * `obs.refusal`; anything else that leaves the run unknown goes to `capture`. */
async function askDaemon(spec, { raw, capture, obs }) {
  const load = (path) => import(pathToFileURL(join(spec.repo, path)).href);
  const [run, live] = await Promise.all([
    load("packages/cli/dist/daemon-run.js"),
    load("packages/cli/dist/live.js"),
  ]);
  const { client, addr, engine } = await run.ensureDaemon();
  obs.engine = engine;
  const get = async (name, path) => {
    const response = await live.controlApiFetch(addr, path);
    const text = await response.text();
    writeFileSync(join(raw, `${name}.json`), text);
    return { status: response.status, body: tryValue(() => JSON.parse(text)) };
  };
  obs.harnesses = (await get("harnesses", "/v2/harnesses")).body;
  const request = daemonAskRequest(spec);
  writeFileSync(join(raw, "run-request.json"), `${JSON.stringify(request, null, 2)}\n`);
  const outcome = await withTimeout(
    run.enqueueAndAwait(client, addr, request, { waitForTerminal: true }),
    DAEMON_RUN_TIMEOUT_MS,
  ).catch((error) => {
    if (typeof error?.code !== "string") throw error;
    return { refusal: { code: error.code, message: String(error.message ?? error) } };
  });
  writeFileSync(join(raw, "run-outcome.json"), `${JSON.stringify(outcome, null, 2)}\n`);
  if (outcome.refusal) {
    obs.refusal = outcome.refusal;
    return;
  }
  if (outcome.timedOut) capture.push("the daemon run did not end in time");
  obs.outcome = {
    runId: outcome.runId ?? null,
    status: outcome.status ?? null,
    errorCode: outcome.errorCode ?? null,
    error: outcome.error ?? null,
  };
  if (outcome.runId) {
    const detail = await get("run-detail", `/runs/${encodeURIComponent(outcome.runId)}`);
    obs.detail = detail.body;
    if (detail.status !== 200) capture.push(`GET /runs/<id> answered ${detail.status}`);
  }
  if (outcome.runDir && existsSync(outcome.runDir)) {
    cpSync(outcome.runDir, join(raw, "run-dir"), { recursive: true });
    obs.eventTypes = eventTypes(outcome.runDir);
  } else if (!outcome.timedOut) capture.push("the daemon bound no readable run directory");
}

/** Runs the cell's daemon route; every problem that leaves the result unknown goes to
 * `capture`. Returns the observations and the provider's request log. */
export async function runDaemonCell(spec, { raw, capture }) {
  const obs = { start: null, engine: null, outcome: null, stop: null };
  let provider;
  try {
    provider = await startScriptedProvider({
      logDir: join(raw, "provider"),
      port: spec.providerPort,
      script: {
        command: modelExecCommand(spec.nonceFile, spec.writeTargets.readonly, spec.marker),
        workdir: spec.project,
        imagePath: spec.imageFile,
      },
    });
  } catch (error) {
    capture.push(`the provider could not bind port ${spec.providerPort}: ${error?.code ?? error}`);
    return { obs, providerLog: [] };
  }
  obs.providerBaseUrl = provider.baseUrl;
  const start = await runCli(spec, raw, "daemon-start", ["daemon", "start", "--json"]);
  obs.start = {
    status: start.status,
    signal: start.signal,
    error: start.error,
    pid: start.json?.pid ?? null,
    ready: start.json?.ready === true,
    alreadyRunning: start.json?.alreadyRunning === true,
  };
  const fresh = start.status === 0 && obs.start.ready && !obs.start.alreadyRunning;
  if (!fresh || !Number.isSafeInteger(obs.start.pid))
    capture.push("the daemon did not report a fresh, ready start of its own");
  else
    await askDaemon(spec, { raw, capture, obs }).catch((error) => {
      capture.push(`the daemon route failed: ${String(error?.message ?? error).split("\n")[0]}`);
      writeFileSync(join(raw, "daemon-route-error.txt"), String(error?.stack ?? error));
    });
  const stop = await runCli(spec, raw, "daemon-stop", ["daemon", "stop", "--json"]);
  obs.stop = { status: stop.status, signal: stop.signal, error: stop.error };
  obs.daemonExited = await pidGone(obs.start.pid, 30_000);
  const daemonLog = join(process.env.CLAUDEXOR_CONFIG_DIR ?? "", "daemon", "claudexord.log");
  if (existsSync(daemonLog)) {
    mkdirSync(join(raw, "daemon"), { recursive: true });
    cpSync(daemonLog, join(raw, "daemon", "claudexord.log"));
  }
  await provider.close();
  return { obs, providerLog: provider.log };
}
