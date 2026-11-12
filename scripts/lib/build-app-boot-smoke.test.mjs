import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const helper = fileURLToPath(new URL("../../apps/macos/scripts/boot-smoke.sh", import.meta.url));
const builder = fileURLToPath(new URL("../../apps/macos/scripts/build-app.sh", import.meta.url));
const shellTest = existsSync("/bin/bash") ? test : test.skip;
const cleanups = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

// Stands in for the packaged daemon entry. It selects its root, socket and
// discovery exactly as the daemon does (userConfigDir, defaultSocketPath,
// CLAUDEXOR_NO_CONTROL_API), so an inherited override changes where it
// writes, and it records what it was started with.
function stubEntry(record, mode) {
  return `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const record = ${JSON.stringify(record)};
const mode = ${JSON.stringify(mode)};
const note = (event) => fs.appendFileSync(record, JSON.stringify(event) + "\\n");
const home = process.env.HOME;
const root = process.env.CLAUDEXOR_CONFIG_DIR || path.join(home, ".claudexor", "v3");
const daemonDir = path.join(root, "daemon");
note({
  event: "start",
  pid: process.pid,
  execPath: fs.realpathSync(process.execPath),
  args: process.argv.slice(1),
  env: { ...process.env },
  homeIsCanonical: fs.realpathSync(home) === home,
  root,
  socket: process.env.CLAUDEXOR_DAEMON_SOCK || path.join(daemonDir, "claudexord.sock"),
});
if (mode === "crash") {
  process.stderr.write("stub daemon: load-time crash\\n");
  process.exit(3);
}
fs.mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(daemonDir, "token"), "stub token\\n", { mode: 0o600 });
if (process.env.CLAUDEXOR_NO_CONTROL_API !== "1") {
  const discovery = { host: "127.0.0.1", port: 9, tokenPath: path.join(daemonDir, "token") };
  fs.writeFileSync(path.join(daemonDir, "control-api.json"), JSON.stringify(discovery) + "\\n");
}
if (mode === "exit-after-publish") process.exit(0);
if (mode === "late-write") {
  process.on("SIGTERM", () => {
    setTimeout(() => {
      // A daemon that is still stopping can still write into its HOME.
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, "late-write"), "written after SIGTERM\\n");
      note({ event: "late-write" });
      process.exit(0);
    }, 1500);
  });
}
if (mode === "ignore-term") process.on("SIGTERM", () => note({ event: "ignored-term" }));
// Like a daemon whose startup proof the stop interrupted.
if (mode === "term-exit-1") process.on("SIGTERM", () => process.exit(1));
setInterval(() => {}, 1000);
`;
}

function fixture(mode) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "boot-smoke-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const record = join(root, "record.jsonl");
  const entry = join(root, "claudexord.bundle.cjs");
  writeFileSync(entry, stubEntry(record, mode));
  const home = join(root, "home");
  mkdirSync(home);
  return { root, record, entry, home };
}

function events(f, name) {
  if (!existsSync(f.record)) return [];
  return readFileSync(f.record, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === name);
}

// Identity check before any signal: the pid must still run this fixture's stub.
function stubAlive(pid, entry) {
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return ps.status === 0 && ps.stdout.includes(entry);
}

function runSmoke(f, env, timeout = 30_000) {
  const result = spawnSync("/bin/bash", [helper, process.execPath, f.entry], {
    cwd: f.root,
    env,
    encoding: "utf8",
    timeout,
  });
  // Whatever the assertions say, leave no stub process or scratch HOME behind.
  for (const started of events(f, "start")) {
    cleanups.push(() => {
      try {
        if (stubAlive(started.pid, f.entry)) process.kill(started.pid, "SIGKILL");
      } catch {
        // It exited between the identity check and the signal.
      }
      if (/^claudexor-smoke\.\w+$/.test(basename(started.env.HOME))) {
        rmSync(started.env.HOME, { recursive: true, force: true });
      }
    });
  }
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

function inventory(dir) {
  if (!existsSync(dir)) return null;
  const entries = [];
  const visit = (path) => {
    const stat = lstatSync(path);
    const entry = { path: relative(dir, path), mode: stat.mode, mtimeMs: stat.mtimeMs };
    if (stat.isFile()) entry.sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    entries.push(entry);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  visit(dir);
  return entries;
}

// What a builder shell may export: another root, socket and control settings,
// a host-managed owner, a Node preload, and provider keys.
function hostileEnvironment(f, seeded) {
  const ambientRoot = join(f.root, "ambient-root");
  if (seeded) {
    mkdirSync(join(ambientRoot, "daemon"), { recursive: true, mode: 0o700 });
    writeFileSync(join(ambientRoot, "config.yaml"), "routing: {}\n");
    writeFileSync(join(ambientRoot, "daemon", "token"), "ambient token\n", { mode: 0o600 });
  }
  const preloadMarker = join(f.root, "preload-ran");
  const preload = join(f.root, "preload.cjs");
  writeFileSync(
    preload,
    `require("node:fs").appendFileSync(${JSON.stringify(preloadMarker)}, "ran\\n");\n`,
  );
  const env = {
    HOME: f.home,
    PATH: "/usr/bin:/bin",
    LANG: "C",
    TMPDIR: f.root,
    CLAUDEXOR_CONFIG_DIR: ambientRoot,
    CLAUDEXOR_DAEMON_SOCK: join(ambientRoot, "ambient.sock"),
    CLAUDEXOR_NO_CONTROL_API: "1",
    CLAUDEXOR_CONTROL_PORT: "47999",
    CLAUDEXOR_DAEMON_OWNER: "external",
    CLAUDEXOR_ROOT_MODE: "explicit",
    NODE_OPTIONS: `--require ${preload}`,
    ANTHROPIC_API_KEY: "boot-smoke-fixture-value",
    OPENAI_API_KEY: "boot-smoke-fixture-value",
    CLAUDEXOR_RAWAPI_KEY: "boot-smoke-fixture-value",
  };
  return { env, ambientRoot, preloadMarker };
}

function expectScrubbedBoot(f, result) {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const started = events(f, "start");
  expect(started).toHaveLength(1);
  const [child] = started;
  expect(child.execPath).toBe(realpathSync(process.execPath));
  expect(child.args).toEqual([f.entry]);
  // CoreFoundation in a macOS Node sets __CF_USER_TEXT_ENCODING for itself at
  // startup, replacing any inherited value; every other key came from the parent.
  const received = Object.keys(child.env).filter((key) => key !== "__CF_USER_TEXT_ENCODING");
  expect(received.sort()).toEqual(["HOME", "PATH"]);
  expect(child.env.PATH).toBe("/usr/bin:/bin");
  expect(child.env.HOME).toMatch(/^(\/private)?\/tmp\/claudexor-smoke\.\w{6}$/);
  expect(child.homeIsCanonical).toBe(true);
  // The default root the observer derived from the same HOME.
  expect(child.root).toBe(join(child.env.HOME, ".claudexor", "v3"));
  // Darwin's sun_path holds 104 bytes.
  expect(Buffer.byteLength(child.socket)).toBeLessThan(100);
  expect(stubAlive(child.pid, f.entry)).toBe(false);
  expect(existsSync(child.env.HOME)).toBe(false);
  return child;
}

shellTest(
  "starts the exact entry with only a scratch HOME and PATH, then removes that root",
  () => {
    const f = fixture("serve");
    const homeBefore = inventory(f.home);
    const result = runSmoke(f, {
      HOME: f.home,
      PATH: "/usr/bin:/bin",
      LANG: "C",
      TMPDIR: f.root,
      USER: "builder",
      SHELL: "/bin/bash",
    });
    expectScrubbedBoot(f, result);
    expect(inventory(f.home)).toEqual(homeBefore);
  },
);

for (const seeded of [false, true]) {
  shellTest(
    `inherited overrides and keys never reach the child (${seeded ? "seeded" : "absent"} ambient root)`,
    () => {
      const f = fixture("serve");
      const { env, ambientRoot, preloadMarker } = hostileEnvironment(f, seeded);
      const ambientBefore = inventory(ambientRoot);
      const homeBefore = inventory(f.home);
      expect(ambientBefore === null).toBe(!seeded);
      const result = runSmoke(f, env);
      expectScrubbedBoot(f, result);
      expect(inventory(ambientRoot)).toEqual(ambientBefore);
      expect(inventory(f.home)).toEqual(homeBefore);
      expect(existsSync(preloadMarker)).toBe(false);
    },
  );
}

shellTest("waits for the daemon to exit before removing its root", () => {
  const f = fixture("late-write");
  const result = runSmoke(f, { HOME: f.home, PATH: "/usr/bin:/bin" });
  const child = expectScrubbedBoot(f, result);
  // The write landed before cleanup, so it could not recreate the deleted root.
  expect(events(f, "late-write")).toHaveLength(1);
  expect(existsSync(join(child.env.HOME, "late-write"))).toBe(false);
});

shellTest("does not judge the exit status the stop itself causes", () => {
  // SIGTERM can interrupt the daemon's own transport proof, which follows
  // discovery and then reports the unfinished startup as a failure.
  const f = fixture("term-exit-1");
  const result = runSmoke(f, { HOME: f.home, PATH: "/usr/bin:/bin" });
  expectScrubbedBoot(f, result);
});

shellTest("fails with the child's stderr when it exits before publishing", () => {
  const f = fixture("crash");
  const result = runSmoke(f, { HOME: f.home, PATH: "/usr/bin:/bin" });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("exited with status 3 before publishing control-api discovery");
  expect(result.stderr).toContain("stub daemon: load-time crash");
  const [child] = events(f, "start");
  expect(existsSync(child.env.HOME)).toBe(false);
});

shellTest("fails when the daemon exits on its own after publishing", () => {
  const f = fixture("exit-after-publish");
  const result = runSmoke(f, { HOME: f.home, PATH: "/usr/bin:/bin" });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("exited with status 0 after publishing discovery");
  const [child] = events(f, "start");
  expect(existsSync(child.env.HOME)).toBe(false);
});

shellTest(
  "kills and reaps a daemon that ignores SIGTERM, then fails",
  () => {
    const f = fixture("ignore-term");
    const result = runSmoke(f, { HOME: f.home, PATH: "/usr/bin:/bin" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("did not exit within 10 s of SIGTERM and was killed");
    expect(events(f, "ignored-term")).toHaveLength(1);
    const [child] = events(f, "start");
    expect(stubAlive(child.pid, f.entry)).toBe(false);
    expect(existsSync(child.env.HOME)).toBe(false);
  },
  45_000,
);

test("build-app.sh boots the packaged node and daemon entry only through this helper", () => {
  const source = readFileSync(builder, "utf8");
  const call = 'bash "$HERE/boot-smoke.sh" "$APP/Contents/Resources/node" "$ENGINE_JS"';
  expect(source.split(call)).toHaveLength(2);
  expect(source).not.toContain("control-api.json");
});
