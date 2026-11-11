/**
 * #376: the temp-dir reapers (vitest.setup.ts and the per-file "W-h" hooks)
 * remove with a synchronous rmSync. Vitest cannot interrupt synchronous work:
 * a hook timeout only compares the elapsed time after the hook returned, so a
 * removal that was slow but succeeded failed its file and skipped every later
 * reaper. These reapers therefore register with timeout 0 (no elapsed-time
 * verdict). A nested Vitest runs the real vitest.setup.ts with every removal
 * under its TMPDIR made slower than the hook timeout:
 * - slow-success: the current reaper shape passes and both reapers ran;
 * - old-shape: a reaper with the default deadline still fails although its
 *   removal succeeded, and skips the setup reaper (the slow path is real);
 * - remove-error: a removal that really fails stays red with its error;
 * - split-*: the daemon/projects.test.ts shape, a deadline-bound async close
 *   hook registered after a timeout-0 removal hook. The removal runs only after
 *   the close settled; a close that rejects or hangs stays red and keeps the
 *   directory;
 * - each-*: slow-success, old-shape and remove-error for an afterEach hook;
 * - closed-*: the two-phase afterEach (afterEachClosed) beside the old single
 *   async hook: slow removal after a settled close, rejecting and hanging
 *   closes, a removal error, and a close that times out in test n and settles
 *   during test n1 (the old hook then removes n1's folder mid-test);
 * - closed-list-*: the same hook over a cleanup list: every removal follows all
 *   of the test's closes, one failed close keeps all of its folders, and a late
 *   close keeps its folder (the old list hook removes it when the close settles);
 * - closed-file-end-*: a removal that waits for file end, through the tail: a
 *   rejected or late close keeps that test's folder and the next test's goes.
 *   closed-old-counter (a counter the late close puts back) and closed-old-reaper
 *   (a file-end reaper beside the two-phase hook) lose the folder;
 * - next-drain-*: a later test's hook draining a shared removal list, after a
 *   close that failed in an inner hook, or a synchronous close that threw;
 * - second-list-*: a late close draining the next test's second list of closes;
 * - awaited-*: afterEachClosed with an awaited tail, over stops and fs/promises
 *   removals (the control-api delegated-run-apply and files-result shape). A late
 *   stop keeps its test's root and leaves the next test's alone, also after the
 *   test's own body timed out; a body timeout before a timely stop still stops and
 *   removes; a rejecting or hanging stop keeps the root, and promises-awaited-slow
 *   shows the tail's removal keeps a real deadline. Negative controls:
 *   signal-double-timeout (run 7's check of the test's signal, which the body's
 *   timeout already aborted, so the late stop still removes n's root during n1) and
 *   list-old-crossing (the same list without a check, after a single timeout);
 * - promises-deadline: an fs/promises removal is a different case: the hook is
 *   still waiting when Vitest's timer fires, so its real deadline stays and fails it.
 * The nested run inherits this process's environment through the engine's own
 * child-env helper, so the caller's custody markers still reach it, minus the
 * provider credentials and engine-state variables a nested run must not use.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { composeSpawnEnv, providerScrubEnv } from "../../packages/core/src/env-scope.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const HOOK_TIMEOUT_MS = 1_000;
const SLOW_RM_MS = 1_500;
/** A caller's custody marker (the shared `*_SCOPE_<32 hex>=1` grammar). */
const MARKER = `QA_REAP_SCOPE_${randomBytes(16).toString("hex")}`;

/** Preloaded into the nested Vitest: a synchronous, uninterruptible delay. */
const SLOW_RM = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const rmSync = fs.rmSync;
fs.rmSync = function (path, options) {
  if (String(path).startsWith(process.env.TMPDIR))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${SLOW_RM_MS});
  return rmSync.call(this, path, options);
};
const rm = fs.promises.rm;
fs.promises.rm = async function (path, options) {
  if (String(path).startsWith(process.env.TMPDIR) && /\\/promises-[^/]*$/.test(String(path)))
    await new Promise((resolve) => setTimeout(resolve, ${SLOW_RM_MS}));
  return rm.call(this, path, options);
};
syncBuiltinESMExports();
`;

const reap = "for (const dir of reap.splice(0)) rmSync(dir, { recursive: true, force: true });";
const reapAsync =
  "for (const dir of reap.splice(0)) await rm(dir, { recursive: true, force: true });";
/** daemon/projects.test.ts: removal hook first, then the close hook. */
const split = (close) => `let closed = false;
afterAll(() => {
  if (!closed) throw new Error("temp dirs retained: the stores did not close first");
  note("delete");
  ${reap}
}, 0);
afterAll(async () => {
  ${close}
  closed = true;
  note("closed");
});`;
const HOOKS = {
  "slow-success": `afterAll(() => { ${reap} }, 0);`,
  "old-shape": `afterAll(() => { ${reap} });`,
  "remove-error": `mkdirSync(join(local, "locked"));
writeFileSync(join(local, "locked", "file"), "");
chmodSync(join(local, "locked"), 0o500);
afterAll(() => { ${reap} }, 0);`,
  "split-success": split("await new Promise((resolve) => setTimeout(resolve, 50));"),
  "split-close-reject": split('throw new Error("store close failed");'),
  "split-close-hang": split("await new Promise(() => {});"),
  // The same three cases for a per-test removal hook.
  "each-slow-success": `afterEach(() => { ${reap} }, 0);`,
  "each-old-shape": `afterEach(() => { ${reap} });`,
  "each-remove-error": `mkdirSync(join(local, "locked"));
writeFileSync(join(local, "locked", "file"), "");
chmodSync(join(local, "locked"), 0o500);
afterEach(() => { ${reap} }, 0);`,
  // An fs/promises removal: Vitest's real timer fires while it is still running.
  "promises-deadline": `afterEach(async () => { ${reapAsync} });`,
};

const FIXTURE_IMPORTS = `import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";`;
const fixture = (name, hook) => `${FIXTURE_IMPORTS}
const local = mkdtempSync(join(tmpdir(), "${name}-"));
const reap = [local];
const note = (event) => appendFileSync(join(process.env.REAP_OUT, "${name}.events"), event + "\\n");
writeFileSync(
  join(process.env.REAP_OUT, "${name}.json"),
  JSON.stringify({
    local,
    sandbox: process.env.CLAUDEXOR_CONFIG_DIR,
    marker: process.env.${MARKER} ?? null,
    providerKey: process.env.OPENAI_API_KEY ?? null,
  }),
);
${hook}
it("${name}", () => {});
`;

/** The two-phase afterEach (packages/cli/src/test-support/after-each-closed.ts),
 * shaped like the rewritten hooks, beside the old single async hook. */
const HELPER = join(repo, "packages", "cli", "src", "test-support", "after-each-closed.ts");
const twoPhase = (close) => `afterEachClosed(async (context) => {
  const ownedRoots = roots.splice(0);
  ${close}
  return () => {
    note("tail " + context.task.name);
    for (const root of ownedRoots) rmSync(root, { recursive: true, force: true });
  };
});`;
const oldShape = (close) => `afterEach(async (context) => {
  ${close}
  note("remove " + context.task.name);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});`;
const QUICK = "await sleep(20);";
const LATE =
  'if (context.task.name === "n") { await sleep(1500); note("late close n settled"); } else await sleep(20);';
const ONE = 'it("t", () => { make("t"); });';
// Test n's close outlives its deadline and settles while test n1 runs.
const CROSSING = `it("n", () => { make("n"); });
it("n1", async () => {
  const own = make("n1");
  await sleep(1200);
  expect(existsSync(own)).toBe(true);
});`;
/** A cleanup list as the rewritten hooks hold it: closes and removals apart. */
const LIST = `const closes = [];
const removals = [];
const fixture = (tag, close) => {
  const dir = make(tag);
  removals.push(() => {
    note("remove " + tag);
    rmSync(dir, { recursive: true, force: true });
  });
  closes.push(close);
  return dir;
};
afterEachClosed(async () => {
  const ownedRemovals = removals.splice(0).reverse();
  for (const close of closes.splice(0).reverse()) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});`;
/** The old list hook: a removal and a close in one entry, under one deadline. */
const OLD_LIST = `const entries = [];
const fixture = (tag, close) => {
  const dir = make(tag);
  entries.push(async () => {
    await close();
    note("remove " + tag);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
};
afterEach(async () => {
  for (const entry of entries.splice(0).reverse()) await entry();
});`;
const closing = (tag) => `async () => { await sleep(5); note("close ${tag}"); }`;
const LATE_N = 'async () => { await sleep(1500); note("late close n settled"); }';
/** Removal at file end, only for folders whose test closed in time (account-last-service). */
const fileEnd = (close) => `const closedRoots = [];
afterEachClosed(async (context) => {
  const ownedRoots = roots.splice(0);
  ${close}
  return () => {
    closedRoots.push(...ownedRoots);
  };
});
afterAll(() => {
  for (const root of closedRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);`;
const oldCounter = (close) => `let closing = 0;
afterEach(async (context) => {
  closing += 1;
  ${close}
  closing -= 1;
});
afterAll(() => {
  if (closing) throw new Error("temp dirs retained");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);`;
const oldReaper = (close) => `${twoPhase(close)}
afterAll(() => {
  for (const root of Object.values(made)) rmSync(root, { recursive: true, force: true });
}, 0);`;
const REJECT_N =
  'if (context.task.name === "n") { await sleep(5); throw new Error("store close failed"); }';
const TWO = 'it("n", () => { make("n"); });\nit("n1", () => { make("n1"); });';
/** A later test's outer hook drains a shared list after an inner stop failed (daemon-startup). */
const nestedDrain = (hook) => `const cleanup = [];
const stops = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
}, 0);
const tempRoot = (tag) => {
  const dir = make(tag);
  cleanup.push(() => {
    note("remove " + tag);
    rmSync(dir, { recursive: true, force: true });
  });
};
describe("inner", () => {
  ${hook}
  it("n", () => {
    tempRoot("n");
    stops.push(async () => { throw new Error("stop failed"); });
  });
  it("n1", () => { tempRoot("n1"); });
});`;
/** A synchronous close throws before this hook's removal drain (command-store). */
const syncDrain = (hook) => `const closes = [];
afterEach(() => {
  ${hook}
}, 0);
it("n", () => {
  make("n");
  closes.push(() => { throw new Error("journal close failed"); });
});
it("n1", () => { make("n1"); });`;
/** A close phase with two lists: a late first close must not take the next test's second. */
const secondList = (take, drain) => `const servers = [];
const stores = [];
afterEachClosed(async () => {
  ${take}
  for (const stop of servers.splice(0)) await stop();
  for (const close of ${drain}) await close();
  return () => {};
});
it("n", () => {
  make("n");
  servers.push(async () => { await sleep(1500); note("late stop n settled"); });
  stores.push(async () => note("close store of n"));
});
it("n1", async () => {
  stores.push(async () => note("close store of n1"));
  await sleep(1200);
  note("n1 body ended");
});`;
const CLOSED = {
  "closed-slow-success": [twoPhase(QUICK), ONE],
  "closed-old-slow": [oldShape(QUICK), ONE],
  "closed-close-reject": [twoPhase('await sleep(5); throw new Error("store close failed");'), ONE],
  "closed-close-hang": [twoPhase("await new Promise(() => {});"), ONE],
  "closed-crossing": [twoPhase(LATE), CROSSING],
  "closed-old-crossing": [oldShape(LATE), CROSSING],
  "closed-tail-error": [
    twoPhase(QUICK),
    `it("t", () => {
  const dir = make("t");
  mkdirSync(join(dir, "locked"));
  writeFileSync(join(dir, "locked", "file"), "");
  chmodSync(join(dir, "locked"), 0o500);
});`,
  ],
  "closed-list-success": [
    LIST,
    `it("t", () => { fixture("a", ${closing("a")}); fixture("b", ${closing("b")}); });`,
  ],
  "closed-list-reject": [
    LIST,
    `it("t", () => {
  fixture("a", async () => { await sleep(5); throw new Error("store close failed"); });
  fixture("b", ${closing("b")});
});`,
  ],
  "closed-list-crossing": [
    LIST,
    `it("n", () => { fixture("n", ${LATE_N}); });
it("n1", async () => {
  const own = fixture("n1", ${closing("n1")});
  await sleep(1200);
  expect(existsSync(own)).toBe(true);
});`,
  ],
  "closed-file-end-reject": [fileEnd(`${REJECT_N} else await sleep(20);`), TWO],
  "closed-file-end-late": [fileEnd(LATE), CROSSING],
  "closed-old-counter": [oldCounter(LATE), CROSSING],
  "closed-old-reaper": [oldReaper(`${REJECT_N} else await sleep(20);`), TWO],
  "next-drain-inner": [
    nestedDrain(`afterEachClosed(async () => {
    const owned = cleanup.splice(0);
    for (const stop of stops.splice(0)) await stop();
    return () => {
      for (const dispose of owned) dispose();
    };
  });`),
    "",
  ],
  "next-drain-old-inner": [
    nestedDrain(`afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
  });`),
    "",
  ],
  "next-drain-sync": [
    syncDrain(`const owned = roots.splice(0);
  for (const close of closes.splice(0)) close();
  for (const root of owned) rmSync(root, { recursive: true, force: true });`),
    "",
  ],
  "next-drain-old-sync": [
    syncDrain(`for (const close of closes.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });`),
    "",
  ],
  "second-list": [secondList("const owned = stores.splice(0);", "owned"), ""],
  "second-list-old": [secondList("", "stores.splice(0)"), ""],
  "closed-old-list-crossing": [
    OLD_LIST,
    `it("n", () => { fixture("n", ${LATE_N}); });
it("n1", async () => {
  fixture("n1", ${closing("n1")});
  await sleep(1200);
});`,
  ],
};
/** A fixture's fs/promises removal, noted when it starts. */
const asyncRemoval = `async () => {
    note("remove " + tag);
    await rm(dir, { recursive: true, force: true });
  }`;
/** Stops and fs/promises removals in one list under one async hook (the control-api
 * delegated-run-apply and files-result shape), with or without run 7's signal check. */
const signalList = (check) => `const cleanup = [];
afterEach(async (context) => {
  const abortedBefore = context.signal.aborted;
  for (const dispose of cleanup.splice(0).reverse()) {
    ${check ? "if (context.signal.aborted && !abortedBefore) return;" : ""}
    await dispose();
  }
});
const fixture = (tag, stop) => {
  const dir = make(tag);
  cleanup.push(${asyncRemoval});
  cleanup.push(stop);
  return dir;
};`;
/** The same fixture through afterEachClosed with an awaited tail: this test's stops, then its
 * removals under the configured hook deadline. */
const AWAITED = `const stops = [];
const removals = [];
afterEachClosed(
  async () => {
    const ownedRemovals = removals.splice(0).reverse();
    for (const stop of stops.splice(0).reverse()) await stop();
    return async () => {
      for (const remove of ownedRemovals) await remove();
    };
  },
  undefined,
  "awaited",
);
const fixture = (tag, stop) => {
  const dir = make(tag);
  removals.push(${asyncRemoval});
  stops.push(stop);
  return dir;
};`;
const stopping = (tag) => `async () => { await sleep(5); note("stop ${tag}"); }`;
const LATE_STOP_N = 'async () => { await sleep(1500); note("late stop n settled"); }';
/** Test n1 runs while n's late stop settles, and checks its own folder survives it. */
const N1 = `it("n1", async () => {
  const own = fixture("n1", ${stopping("n1")});
  await sleep(1200);
  expect(existsSync(own)).toBe(true);
});`;
/** A test body that outlives its own 200 ms timeout: Vitest aborts its signal before the hooks. */
const bodyTimeout = (tag, stop) => `it("${tag}", { timeout: 200 }, async () => {
  fixture("${tag}", ${stop});
  await new Promise(() => {});
});`;
CLOSED["awaited-crossing"] = [AWAITED, `it("n", () => { fixture("n", ${LATE_STOP_N}); });\n${N1}`];
CLOSED["awaited-body-timeout"] = [AWAITED, bodyTimeout("t", stopping("t"))];
CLOSED["awaited-double-timeout"] = [AWAITED, `${bodyTimeout("n", LATE_STOP_N)}\n${N1}`];
CLOSED["awaited-stop-reject"] = [
  AWAITED,
  'it("t", () => { fixture("t", async () => { await sleep(5); throw new Error("server stop failed"); }); });',
];
CLOSED["awaited-stop-hang"] = [
  AWAITED,
  'it("t", () => { fixture("t", () => new Promise(() => {})); });',
];
// The preload slows an fs/promises removal of a "promises-" folder past the hook deadline.
CLOSED["promises-awaited-slow"] = [AWAITED, `it("t", () => { fixture("t", ${stopping("t")}); });`];
CLOSED["signal-double-timeout"] = [signalList(true), `${bodyTimeout("n", LATE_STOP_N)}\n${N1}`];
CLOSED["list-old-crossing"] = [
  signalList(false),
  `it("n", () => { fixture("n", ${LATE_STOP_N}); });\n${N1}`,
];
const closedFixture = (name, [hook, tests]) => `${FIXTURE_IMPORTS}
import { existsSync } from "node:fs";
import { afterEachClosed } from ${JSON.stringify(HELPER)};
const note = (event) => appendFileSync(join(process.env.REAP_OUT, "${name}.events"), event + "\\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const roots = [];
const made = {};
const make = (tag) => {
  const dir = mkdtempSync(join(tmpdir(), "${name}-" + tag + "-"));
  roots.push(dir);
  made[tag] = dir;
  writeFileSync(join(process.env.REAP_OUT, "${name}.json"), JSON.stringify(made));
  return dir;
};
${hook}
${tests}
`;

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a slow successful reap passes while removal errors and unsettled closes stay red (#376)",
  { timeout: 240_000 },
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "cx-reap-hooks-"));
    const out = join(scratch, "out");
    for (const dir of [out, join(scratch, "tmp"), join(scratch, "home")]) mkdirSync(dir);
    let childGone = false;
    try {
      writeFileSync(join(scratch, "slow-rm.mjs"), SLOW_RM);
      for (const [name, hook] of Object.entries(HOOKS))
        writeFileSync(join(scratch, `${name}.test.mjs`), fixture(name, hook));
      for (const [name, parts] of Object.entries(CLOSED))
        writeFileSync(join(scratch, `${name}.test.mjs`), closedFixture(name, parts));
      writeFileSync(
        join(scratch, "vitest.config.mjs"),
        `export default ${JSON.stringify({
          test: {
            include: ["*.test.mjs"],
            setupFiles: [join(repo, "vitest.setup.ts")],
            globals: true,
            hookTimeout: HOOK_TIMEOUT_MS,
            testTimeout: 20_000,
            maxWorkers: 2,
          },
        })};\n`,
      );
      vi.stubEnv(MARKER, "1");
      vi.stubEnv("OPENAI_API_KEY", "fixture-provider-key");
      const env = composeSpawnEnv("mirror_native", {
        ...providerScrubEnv(),
        // The nested vitest.setup.ts picks its own sandbox; these would point
        // the nested run at the caller's engine state (DEVELOPMENT.md).
        CLAUDEXOR_CONFIG_DIR: null,
        CLAUDEXOR_DAEMON_SOCK: null,
        CLAUDEXOR_NO_CONTROL_API: null,
        HOME: join(scratch, "home"),
        TMPDIR: join(scratch, "tmp"),
        TMP: join(scratch, "tmp"),
        TEMP: join(scratch, "tmp"),
        REAP_OUT: out,
        NODE_OPTIONS: `--import=${pathToFileURL(join(scratch, "slow-rm.mjs")).href}`,
      });
      vi.unstubAllEnvs();
      const run = spawnSync(
        process.execPath,
        [
          join(repo, "node_modules", "vitest", "vitest.mjs"),
          "run",
          "--config",
          join(scratch, "vitest.config.mjs"),
          "--root",
          scratch,
          "--reporter=json",
          `--outputFile=${join(scratch, "report.json")}`,
        ],
        { cwd: scratch, encoding: "utf8", timeout: 200_000, killSignal: "SIGKILL", env },
      );
      childGone = run.signal === null;
      expect(run.error, `${run.stdout}\n${run.stderr}`).toBeUndefined();
      const report = JSON.parse(readFileSync(join(scratch, "report.json"), "utf8"));
      const file = (name) =>
        report.testResults.find((r) => basename(r.name) === `${name}.test.mjs`);
      // A failing afterEach is reported on its test, an afterAll on its file.
      const failures = (result) =>
        [result.message, ...result.assertionResults.flatMap((a) => a.failureMessages)].join("\n");
      const dirs = (name) => JSON.parse(readFileSync(join(out, `${name}.json`), "utf8"));
      const events = (name) =>
        existsSync(join(out, `${name}.events`))
          ? readFileSync(join(out, `${name}.events`), "utf8")
              .trim()
              .split("\n")
          : [];

      for (const name of Object.keys(HOOKS)) {
        expect(dirs(name).marker, name).toBe("1");
        expect(dirs(name).providerKey, name).toBeNull();
      }

      const slow = file("slow-success");
      expect(slow.status, slow.message).toBe("passed");
      expect(existsSync(dirs("slow-success").local)).toBe(false);
      expect(existsSync(dirs("slow-success").sandbox)).toBe(false);

      const old = file("old-shape");
      expect(old.status).toBe("failed");
      expect(old.message).toContain(`Hook timed out in ${HOOK_TIMEOUT_MS}ms`);
      expect(existsSync(dirs("old-shape").local)).toBe(false);
      expect(existsSync(dirs("old-shape").sandbox)).toBe(true);

      const error = file("remove-error");
      expect(error.status).toBe("failed");
      expect(error.message).toMatch(/E(ACCES|NOTEMPTY|PERM)/);
      expect(error.message).not.toContain("timed out");
      expect(existsSync(join(dirs("remove-error").local, "locked", "file"))).toBe(true);

      const split = file("split-success");
      expect(split.status, split.message).toBe("passed");
      expect(events("split-success")).toEqual(["closed", "delete"]);
      expect(existsSync(dirs("split-success").local)).toBe(false);
      expect(existsSync(dirs("split-success").sandbox)).toBe(false);

      const rejected = file("split-close-reject");
      expect(rejected.status).toBe("failed");
      expect(rejected.message).toContain("store close failed");
      expect(events("split-close-reject")).toEqual([]);
      expect(existsSync(dirs("split-close-reject").local)).toBe(true);

      const hung = file("split-close-hang");
      expect(hung.status).toBe("failed");
      expect(hung.message).toContain(`Hook timed out in ${HOOK_TIMEOUT_MS}ms`);
      expect(events("split-close-hang")).toEqual([]);
      expect(existsSync(dirs("split-close-hang").local)).toBe(true);

      const eachSlow = file("each-slow-success");
      expect(eachSlow.status, failures(eachSlow)).toBe("passed");
      expect(existsSync(dirs("each-slow-success").local)).toBe(false);

      // The JSON reporter records a timed-out per-test hook by the stack of its
      // registration (Vitest's STACK_TRACE_ERROR); the removal itself succeeded.
      const eachOld = file("each-old-shape");
      expect(eachOld.status).toBe("failed");
      expect(failures(eachOld)).toMatch(
        /Hook timed out in 1000ms|STACK_TRACE_ERROR\n\s+at afterEach/,
      );
      expect(failures(eachOld)).not.toMatch(/E(ACCES|NOTEMPTY|PERM)/);
      expect(existsSync(dirs("each-old-shape").local)).toBe(false);

      const eachError = file("each-remove-error");
      expect(eachError.status).toBe("failed");
      expect(failures(eachError)).toMatch(/E(ACCES|NOTEMPTY|PERM)/);
      expect(failures(eachError)).not.toContain("timed out");
      expect(existsSync(join(dirs("each-remove-error").local, "locked", "file"))).toBe(true);

      const promisesDeadline = file("promises-deadline");
      expect(promisesDeadline.status).toBe("failed");
      expect(failures(promisesDeadline)).toMatch(
        /Hook timed out in 1000ms|STACK_TRACE_ERROR\n\s+at afterEach/,
      );

      // Two-phase afterEach: per-test results, its folders and the tail events.
      const test = (name, title) => file(name).assertionResults.find((a) => a.title === title);
      const made = (name) => JSON.parse(readFileSync(join(out, `${name}.json`), "utf8"));
      const timedOut = /Hook timed out in 1000ms|STACK_TRACE_ERROR\n\s+at afterEach/;

      expect(test("closed-slow-success", "t").status, failures(file("closed-slow-success"))).toBe(
        "passed",
      );
      expect(events("closed-slow-success")).toEqual(["tail t"]);
      expect(existsSync(made("closed-slow-success").t)).toBe(false);
      // The old single async hook fails the same slow, successful removal.
      expect(test("closed-old-slow", "t").status).toBe("failed");
      expect(failures(file("closed-old-slow"))).toMatch(timedOut);
      expect(existsSync(made("closed-old-slow").t)).toBe(false);

      expect(test("closed-close-reject", "t").status).toBe("failed");
      expect(failures(file("closed-close-reject"))).toContain("store close failed");
      expect(events("closed-close-reject")).toEqual([]);
      expect(existsSync(made("closed-close-reject").t)).toBe(true);

      expect(test("closed-close-hang", "t").status).toBe("failed");
      expect(failures(file("closed-close-hang"))).toMatch(timedOut);
      expect(events("closed-close-hang")).toEqual([]);
      expect(existsSync(made("closed-close-hang").t)).toBe(true);

      // Test n's close times out and settles during test n1: n keeps its folder,
      // n1 keeps its own until its own close settled, and only n1's tail runs.
      expect(test("closed-crossing", "n").status).toBe("failed");
      expect(test("closed-crossing", "n1").status, failures(file("closed-crossing"))).toBe(
        "passed",
      );
      expect(events("closed-crossing")).toEqual(["late close n settled", "tail n1"]);
      expect(existsSync(made("closed-crossing").n)).toBe(true);
      expect(existsSync(made("closed-crossing").n1)).toBe(false);
      // The old single async hook: n's late continuation removes n1's folder mid-test.
      expect(test("closed-old-crossing", "n").status).toBe("failed");
      expect(test("closed-old-crossing", "n1").failureMessages.join("\n")).toContain(
        "expected false to be true",
      );
      expect(events("closed-old-crossing")).toEqual([
        "late close n settled",
        "remove n",
        "remove n1",
      ]);
      expect(existsSync(made("closed-old-crossing").n1)).toBe(false);

      // A cleanup list: all closes, then all removals, slow ones included.
      expect(test("closed-list-success", "t").status, failures(file("closed-list-success"))).toBe(
        "passed",
      );
      expect(events("closed-list-success")).toEqual(["close b", "close a", "remove b", "remove a"]);
      expect(existsSync(made("closed-list-success").a)).toBe(false);
      expect(existsSync(made("closed-list-success").b)).toBe(false);
      // One failed close keeps all of this test's folders.
      expect(test("closed-list-reject", "t").status).toBe("failed");
      expect(failures(file("closed-list-reject"))).toContain("store close failed");
      expect(events("closed-list-reject")).toEqual(["close b"]);
      expect(existsSync(made("closed-list-reject").a)).toBe(true);
      expect(existsSync(made("closed-list-reject").b)).toBe(true);
      // A late close keeps its folder and leaves the next test's list alone.
      expect(test("closed-list-crossing", "n").status).toBe("failed");
      expect(
        test("closed-list-crossing", "n1").status,
        failures(file("closed-list-crossing")),
      ).toBe("passed");
      expect(events("closed-list-crossing")).toEqual([
        "late close n settled",
        "close n1",
        "remove n1",
      ]);
      expect(existsSync(made("closed-list-crossing").n)).toBe(true);
      expect(existsSync(made("closed-list-crossing").n1)).toBe(false);
      // The old list entry removes the timed-out test's folder when its close settles.
      expect(test("closed-old-list-crossing", "n").status).toBe("failed");
      expect(events("closed-old-list-crossing")).toContain("remove n");
      expect(existsSync(made("closed-old-list-crossing").n)).toBe(false);

      // A removal that waits for file end: n's rejected or late close keeps its folder.
      for (const name of ["closed-file-end-reject", "closed-file-end-late"]) {
        expect(test(name, "n").status, name).toBe("failed");
        expect(test(name, "n1").status, failures(file(name))).toBe("passed");
        expect(existsSync(made(name).n), name).toBe(true);
        expect(existsSync(made(name).n1), name).toBe(false);
      }
      expect(events("closed-file-end-late")).toContain("late close n settled");
      // The old counter is back at zero by file end; the old reaper ignores the failed close.
      expect(test("closed-old-counter", "n").status).toBe("failed");
      expect(events("closed-old-counter")).toContain("late close n settled");
      expect(existsSync(made("closed-old-counter").n)).toBe(false);
      expect(test("closed-old-reaper", "n").status).toBe("failed");
      expect(existsSync(made("closed-old-reaper").n)).toBe(false);

      // A later test's drain: n's failed close keeps its folder, unlike the old shapes.
      for (const name of ["next-drain-inner", "next-drain-sync"]) {
        expect(test(name, "n").status, name).toBe("failed");
        expect(test(name, "n1").status, failures(file(name))).toBe("passed");
        expect(existsSync(made(name).n), name).toBe(true);
        expect(existsSync(made(name).n1), name).toBe(false);
      }
      for (const name of ["next-drain-old-inner", "next-drain-old-sync"]) {
        expect(test(name, "n").status, name).toBe("failed");
        expect(existsSync(made(name).n), name).toBe(false);
      }
      expect(events("next-drain-inner")).toEqual(["remove n1"]);
      expect(events("next-drain-old-inner")).toEqual(["remove n", "remove n1"]);

      // A late close takes only its own test's second list.
      expect(test("second-list", "n").status).toBe("failed");
      expect(test("second-list", "n1").status).toBe("passed");
      const late = events("second-list");
      expect(late.indexOf("close store of n1")).toBeGreaterThan(late.indexOf("n1 body ended"));
      expect(late.indexOf("close store of n")).toBeGreaterThan(late.indexOf("late stop n settled"));
      const stolen = events("second-list-old");
      expect(stolen.indexOf("close store of n1")).toBeLessThan(stolen.indexOf("n1 body ended"));

      // An awaited tail over stops and fs/promises removals: n's late stop keeps n's root and
      // leaves n1 alone, also when n's own body had timed out first.
      for (const name of ["awaited-crossing", "awaited-double-timeout"]) {
        expect(test(name, "n").status, name).toBe("failed");
        expect(test(name, "n1").status, failures(file(name))).toBe("passed");
        expect(events(name), name).toEqual(["late stop n settled", "stop n1", "remove n1"]);
        expect(existsSync(made(name).n), name).toBe(true);
        expect(existsSync(made(name).n1), name).toBe(false);
      }
      // A body that timed out before a timely stop: the stop and the removal still run, and the
      // body's timeout is the only failure.
      const bodyOnly = test("awaited-body-timeout", "t");
      expect(bodyOnly.status).toBe("failed");
      expect(bodyOnly.failureMessages, failures(file("awaited-body-timeout"))).toHaveLength(1);
      expect(bodyOnly.failureMessages[0]).not.toMatch(timedOut);
      expect(events("awaited-body-timeout")).toEqual(["stop t", "remove t"]);
      expect(existsSync(made("awaited-body-timeout").t)).toBe(false);
      // A stop that rejects or hangs keeps the root.
      expect(test("awaited-stop-reject", "t").status).toBe("failed");
      expect(failures(file("awaited-stop-reject"))).toContain("server stop failed");
      expect(events("awaited-stop-reject")).toEqual([]);
      expect(existsSync(made("awaited-stop-reject").t)).toBe(true);
      expect(test("awaited-stop-hang", "t").status).toBe("failed");
      expect(failures(file("awaited-stop-hang"))).toMatch(timedOut);
      expect(events("awaited-stop-hang")).toEqual([]);
      expect(existsSync(made("awaited-stop-hang").t)).toBe(true);
      // The awaited removal keeps a real deadline: one slower than it fails the test.
      expect(test("promises-awaited-slow", "t").status).toBe("failed");
      expect(failures(file("promises-awaited-slow"))).toMatch(timedOut);
      expect(events("promises-awaited-slow")).toEqual(["stop t", "remove t"]);
      // Run 7's signal check: once the body's timeout aborted the signal, the hook's own timeout
      // is invisible to it, and n's late stop goes on to remove n's root during n1.
      expect(test("signal-double-timeout", "n").status).toBe("failed");
      expect(test("signal-double-timeout", "n1").status).toBe("passed");
      expect(events("signal-double-timeout")).toContain("remove n");
      expect(existsSync(made("signal-double-timeout").n)).toBe(false);
      // The same list without a check removes it after a single timeout.
      expect(test("list-old-crossing", "n").status).toBe("failed");
      expect(events("list-old-crossing")).toContain("remove n");
      expect(existsSync(made("list-old-crossing").n)).toBe(false);

      expect(test("closed-tail-error", "t").status).toBe("failed");
      expect(failures(file("closed-tail-error"))).toMatch(/E(ACCES|NOTEMPTY|PERM)/);
      expect(failures(file("closed-tail-error"))).not.toMatch(timedOut);
      expect(existsSync(join(made("closed-tail-error").t, "locked", "file"))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      for (const name of ["remove-error", "each-remove-error"]) {
        const locked = join(out, `${name}.json`);
        if (!existsSync(locked)) continue;
        const dir = join(JSON.parse(readFileSync(locked, "utf8")).local, "locked");
        if (existsSync(dir)) chmodSync(dir, 0o700);
      }
      const lockedTail = join(out, "closed-tail-error.json");
      if (existsSync(lockedTail)) {
        const dir = join(JSON.parse(readFileSync(lockedTail, "utf8")).t, "locked");
        if (existsSync(dir)) chmodSync(dir, 0o700);
      }
      // A nested run killed on timeout may leave workers behind: keep its root.
      if (childGone) rmSync(scratch, { recursive: true, force: true });
    }
  },
);
