import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  realpathSync, rmSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const [mode, qaDir, tree, reports] = process.argv.slice(2);
assert(['baseline', 'candidate'].includes(mode) && qaDir && /^[a-f0-9]{40}$/.test(tree),
  'usage: paired-log.mjs baseline|candidate EMPTY_QA_DIR SOURCE_TREE_SHA [REPORT_DIR]');
assert.equal(process.platform, 'linux', 'this fixture is for the Ubuntu qualification runner');
const candidate = mode === 'candidate';
const qa = realpathSync(qaDir);
assert.equal(realpathSync(process.env.TMPDIR), qa);
assert.equal(realpathSync(process.env.HOME), qa);
assert.equal(readdirSync(qa).length, 0, 'QA directory must be empty');
const cwd = process.cwd();
const home = mkdtempSync(join(qa, 'writer-'));
const env = {
  HOME: home, TMPDIR: qa, CLAUDEXOR_CONFIG_DIR: join(home, 'cfg'),
  CLAUDEXOR_DISABLE_STORED_SECRETS: '1', LANG: 'C', PATH: process.env.PATH,
};
Object.assign(process.env, env); // The workflow starts Node with env -i.
const dist = (pkg, entry) => join(cwd, 'packages', pkg, 'dist', entry);
const load = (pkg, entry) => import(pathToFileURL(dist(pkg, entry)).href);
const ms = n => Math.round(n * 1000) / 1000;
const result = { mode, tree };

// Only our own bounded measurements and failure locations enter the public copies.
// The runner captures the complete stdout/stderr, including dependency output, privately.
function report(stream, text) {
  process[stream].write(text);
  if (reports) appendFileSync(join(reports, `${mode}.${stream}`), text);
}

async function quietApiControl() {
  const support = pathToFileURL(join(cwd, 'packages/canary/src/support.ts'));
  const { CLI, cli, makeSandbox } = await import(support.href);
  assert.equal(realpathSync(CLI), realpathSync(dist('cli', 'cli.js')));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const sb = makeSandbox();
  const run = (...args) => {
    const reply = cli(sb, [...args, '--json']);
    assert.equal(reply.code, 0, 'canary CLI command must succeed');
    return reply.json();
  };
  const healthzMs = [], handshakeMs = [];
  try {
    // The canary supplies version-only binaries and fresh stores. Register two
    // local rows without any login material; the daemon polls its own empty stores.
    for (const key of ['CLAUDEXOR_CURSOR_BIN', 'CLAUDEXOR_GROK_BIN', 'CLAUDEXOR_COPILOT_BIN'])
      sb.env[key] = sb.env.CLAUDEXOR_CODEX_BIN;
    for (const id of ['qa-a', 'qa-b'])
      assert.equal(run('profiles', 'add', 'claude', id).registered.profileId, id);
    const ready = run('daemon', 'start');
    assert(ready.ready && ready.servingMode === 'normal' && !ready.alreadyRunning && ready.pid > 0);
    const dir = join(sb.configDir, 'daemon');
    const { host, port, tokenPath } = JSON.parse(readFileSync(join(dir, 'control-api.json'), 'utf8'));
    assert(host === '127.0.0.1' && Number.isInteger(port) && port > 0 && port <= 65535);
    assert.equal(tokenPath, join(dir, 'token'));
    const token = readFileSync(tokenPath, 'utf8').trim();
    const base = `http://127.0.0.1:${port}`;
    const entry = realpathSync(dist('cli', 'claudexord.js'));
    for (let i = 0; i < 3; i++) {
      let start = performance.now();
      const health = await fetch(base + '/healthz', { redirect: 'error', signal: AbortSignal.timeout(5000) });
      const ok = (await health.json()).ok;
      healthzMs.push(ms(performance.now() - start));
      assert(health.status === 200 && ok === true);
      start = performance.now();
      const hello = await fetch(base + '/v2/handshake', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ protocolMajor: 3, client: 'paired-log-canary' }),
      });
      const body = await hello.json();
      handshakeMs.push(ms(performance.now() - start));
      assert(hello.status === 200 && body.compatible === true && body.protocolMajor === 3);
      assert(body.servingMode === 'normal' && body.engine.sha === commit);
      assert.equal(realpathSync(body.engine.entry), entry);
    }
    const stopped = run('daemon', 'stop');
    assert(stopped.stopped === true && stopped.outcome === 'exited', 'expected an ordinary Stop');
  } finally {
    sb.dispose(); // Checks its writer lease, stops it if needed, and removes only its own fixture.
  }
  assert(!existsSync(sb.home), 'canary fixture should be gone after disposal');
  result.quietApiControl = { interval: 'quiet control, separate from the writer and timer fixture',
    healthzMs, handshakeMs };
}

const quotaPrefix = 'quota.observation ';
const phases = [['credential_read', 'started'], ['usage_http', 'succeeded'], ['poll', 'skipped']];
function records(count, batch, reason) {
  return Array.from({ length: count }, (_, i) => {
    const [stage, outcome] = phases[i % phases.length];
    return { operationId: `${batch}-${i}`, source: 'claude_oauth_usage', profileId: null,
      at: '2000-01-01T00:00:00.000Z', foreground: false, credentialEpoch: 1,
      current: true, stage, outcome, reason };
  });
}
const quotaPayloads = text => Array.from(text.matchAll(/^\[[^\n\]]+\] quota\.observation (.*)$/gm), m => m[1]);
const rows = (text, stage) => text.split('\n').filter(line => line.startsWith('{'))
  .map(line => JSON.parse(line)).filter(row => row.stage === stage);
const stallPrefix = 'loop window delayed ';

function checkWindow(text, held, expectedMs) {
  const matching = rows(text, 'loop_stall').filter(row => row.message.startsWith(stallPrefix))
    .map(row => JSON.parse(row.message.slice(stallPrefix.length)))
    .filter(row => row.windowEndedAt === held.windowEndedAt);
  assert.equal(matching.length, 1, 'expected this specific measured window');
  const { windowMs, lateMs, delay, utilization, gc } = matching[0];
  assert.equal(matching[0].expectedMs, expectedMs);
  assert.deepEqual({ windowMs, lateMs, delay, utilization, gc }, {
    windowMs: held.windowMs, lateMs: ms(held.windowMs - expectedMs),
    delay: held.delay, utilization: held.utilization, gc: held.gc,
  });
}

async function measureLogs() {
  const { daemonDir, logPath, loopFacts, LOOP_FACTS_WINDOW_MS: W } = await load('daemon', 'index.js');
  const { openStartupDiagnostics } = await load('cli', 'daemon-admission-runtime.js');
  const { armDaemonLifecycle } = await load('cli', 'daemon-lifecycle.js');
  const { DaemonRuntimeShutdown } = await load('cli', 'daemon-runtime-shutdown.js');
  const dir = join(env.CLAUDEXOR_CONFIG_DIR, 'daemon');
  const main = join(dir, 'claudexord.log');
  assert.equal(daemonDir(), dir);
  assert.equal(logPath(), main);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const open = () => openStartupDiagnostics({ version: '0.0.0', sha: 'fixture', entry: 'paired-log.mjs' });
  const emit = (handle, record) => candidate ? handle.logQuotaObservation(record)
    : handle.log('sql_runtime', quotaPrefix + JSON.stringify(record));
  async function nextWindow(previous) {
    const deadline = performance.now() + 2 * W;
    do {
      const fact = loopFacts();
      if (fact && fact !== previous) return fact;
      await sleep(25);
    } while (performance.now() < deadline);
    throw new Error('fixture inconclusive: no completed loop window');
  }
  const sender = { name: 'fixture-cli', version: '0.0.0', pid: 4242, ppid: 3133 };
  const stop = 'shutdown requested (socket-rpc stop)';
  const stopWithSender = `${stop} (client-reported: fixture-cli version=0.0.0 pid=4242 ppid=3133)`;
  let held;
  const first = open();
  try {
    assert(first.diagnostics, 'ordinary writer failed to open');
    assert.equal(typeof first.logQuotaObservation, candidate ? 'function' : 'undefined', 'wrong build');
    const sample = records(24, 'sample', 'offline fixture');
    const before = readFileSync(main);
    const t = performance.now();
    for (const record of sample) emit(first, record);
    const writeMs = ms(performance.now() - t);
    const after = readFileSync(main);
    assert(after.subarray(0, before.length).equals(before), 'sample must not rotate');
    const added = after.subarray(before.length);
    const plain = quotaPayloads(added.toString()).map(line => JSON.parse(line));
    const structured = rows(added.toString(), 'sql_runtime').filter(row => row.message.startsWith(quotaPrefix))
      .map(row => JSON.parse(row.message.slice(quotaPrefix.length)));
    assert.deepEqual(plain, sample);
    assert.deepEqual(structured, candidate ? [] : sample);
    assert.equal(first.diagnostics.lastFailure(), null);
    result.quota = { inputs: sample.length, plain: plain.length, structured: structured.length,
      bytes: added.length, writeMs };

    const noop = async () => {};
    const shutdown = new DaemonRuntimeShutdown({
      daemon: { stop: noop }, setup: { hasActiveWork: () => false, beginDrain() {}, shutdown: noop },
      control: () => null, journal: { close() {} }, forceExit() {}, drainGraceMs: 60_000,
      log: message => first.log(candidate ? 'shutdown' : 'sql_runtime', message),
    });
    const life = armDaemonLifecycle({ daemonDir: dir, logPath: main, signals: new EventEmitter(),
      diagnostics: candidate ? first.port : first.diagnostics, beginShutdown: reason => shutdown.beginShutdown(reason) });
    try {
      const idle = await nextWindow(null);
      await sleep(W - 1000);
      assert.equal(loopFacts(), idle, 'fixture inconclusive: window closed before the pause');
      // Only this probe's JS thread pauses. The HTTP canary has its own process and interval.
      assert.equal(Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500), 'timed-out');
      held = await nextWindow(idle);
      assert(held.windowMs - W >= 1000, 'fixture inconclusive: window did not close late');
      result.loopControl = { idleMs: idle.windowMs, expectedMs: W, windowEndedAt: held.windowEndedAt,
        windowMs: held.windowMs, lateMs: ms(held.windowMs - W), delayMaxMs: held.delay?.maxMs ?? null };
      if (candidate) await shutdown.beginShutdown('socket-rpc stop', sender);
      else await shutdown.beginShutdown('socket-rpc stop');
    } finally {
      await life.finalize();
    }
    const preRotation = readFileSync(main, 'utf8');
    assert(preRotation.includes(stop));
    if (candidate) checkWindow(preRotation, held, W);
  } finally {
    first.close();
  }

  const flood = records(72, 'flood', 'offline fixture '.repeat(512));
  const expectedLast = { ...flood.at(-1) };
  assert.equal(expectedLast.operationId, 'flood-71');
  const size = path => existsSync(path) ? statSync(path).size : 0;
  const mainOld = main + '.1';
  let ino = statSync(main).ino, rotations = 0, maxOrdinaryBytes = 0;
  const next = open();
  try {
    for (const record of flood) {
      emit(next, record);
      const current = statSync(main);
      if (current.ino !== ino) {
        assert.equal(statSync(mainOld).ino, ino, 'rotation must move current to .1');
        rotations++;
        ino = current.ino;
      }
      maxOrdinaryBytes = Math.max(maxOrdinaryBytes, current.size, size(mainOld));
    }
    assert.equal(next.diagnostics.lastFailure(), null);
    assert(rotations >= 2, 'insufficient ordinary log rotation');
    for (const path of [main, mainOld]) {
      const text = readFileSync(path, 'utf8');
      assert(!text.includes(stop) && !text.includes(stallPrefix), 'ordinary generations still hold the event');
    }
  } finally {
    next.close();
  }
  // Reopen before the CLI read, including the legacy oversized-generation decision.
  const reopened = open();
  try {
    assert(reopened.diagnostics, 'ordinary writer did not reopen');
    assert.equal(reopened.diagnostics.lastFailure(), null);
  } finally {
    reopened.close();
  }
  const rare = join(dir, 'claudexord.rare.log');
  const generationBytes = [main, mainOld, rare, rare + '.1'].map(size);
  result.flood = { inputs: flood.length, rotations, maxOrdinaryBytes, generationBytes };
  if (candidate) {
    const cap = 256 * 1024;
    assert(maxOrdinaryBytes <= cap && generationBytes.every(n => n <= cap));
  }
  const cli = spawnSync(process.execPath, [dist('cli', 'cli.js'), 'daemon', 'logs', '--json'], {
    cwd, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (cli.error) throw cli.error;
  assert.equal(cli.status, 0, 'built daemon logs must exit successfully');
  const reply = JSON.parse(cli.stdout);
  assert(reply.ok && typeof reply.log_tail === 'string');
  const latest = quotaPayloads(reply.log_tail).at(-1);
  let lastQuota;
  if (candidate) {
    assert(latest, 'expected the last plain quota in the built CLI tail');
    assert.deepEqual(JSON.parse(latest), expectedLast, 'full flood-71 including its long reason');
    lastQuota = 'full-flood-71';
  } else if (latest === undefined) {
    lastQuota = 'no-plain-quota-in-legacy-tail';
  } else if (/… \(truncated \d+ chars\)$/.test(latest)) {
    assert(latest.startsWith('{"operationId":"flood-71",'), 'unexpected legacy quota prefix');
    lastQuota = 'legacy-plain-line-truncated';
  } else {
    assert.equal(JSON.parse(latest).operationId, expectedLast.operationId);
    lastQuota = 'complete-legacy-json';
  }
  const rareTail = Object.hasOwn(reply, 'rare_tail');
  assert.equal(rareTail, candidate);
  const stopSender = rareTail && rows(reply.rare_tail, 'shutdown').some(row => row.message.startsWith(stopWithSender));
  if (rareTail) {
    assert(!reply.rare_tail.includes(quotaPrefix), 'quota traffic in rare tail');
    checkWindow(reply.rare_tail, held, W);
    assert(stopSender, 'CLI did not recover the fixture Stop sender');
  }
  result.cli = { lastQuota, fullLastQuotaRequired: candidate, rareTail, measuredWindowRecovered: rareTail, stopSender };
}

try {
  for (const check of [quietApiControl, measureLogs]) {
    try {
      await check();
    } catch (error) {
      // A CLI/disposal exception may contain a descriptor or child output. Only
      // the named check and its source location belong in the public failure report.
      const line = error.stack?.match(/paired-log\.mjs:(\d+):\d+/)?.[1];
      report('stderr', `${check.name} failed${line ? ' at paired-log.mjs:' + line : ''}\n`);
      process.exitCode = 1;
    }
  }
  report('stdout', JSON.stringify(result) + '\n');
} finally {
  rmSync(home, { recursive: true }); // The writer's own home, a sibling of every canary sandbox.
}
