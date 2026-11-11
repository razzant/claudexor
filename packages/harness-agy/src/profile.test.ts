import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessRunSpec, type CredentialProfile } from "@claudexor/schema";
import { claudexorOwnedRoot } from "@claudexor/util";
import { createAgyAdapter } from "./index.js";
import { AgyProfileKeychainError } from "./keychain.js";
import {
  agyProfileRunEnv,
  agyTokenPath,
  defaultAgyModelProbe,
  probeAgyCredentialProfile,
  resolveAgyProfileRoute,
} from "./profile.js";
import {
  agyPrintSpawnOptions,
  classifyAgyPrintResult,
  runAgyPrintCommand,
} from "./print-command.js";

function profile(home: string): CredentialProfile {
  return {
    profile_id: "work",
    harness_id: "agy",
    display_name: "Work",
    credential_kind: "config_dir_login",
    isolation_locator: home,
    secret_ref: null,
    enabled: true,
    created_at: null,
  };
}

describe("agy profile route and vendor probe", () => {
  const roots: string[] = [];
  const originalBin = process.env.CLAUDEXOR_AGY_BIN;

  afterEach(() => {
    if (originalBin === undefined) delete process.env.CLAUDEXOR_AGY_BIN;
    else process.env.CLAUDEXOR_AGY_BIN = originalBin;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  function fixture(script: string): { root: string; home: string; bin: string } {
    const fixtureRoot = join(claudexorOwnedRoot(), "profiles");
    mkdirSync(fixtureRoot, { recursive: true });
    const root = mkdtempSync(join(fixtureRoot, "agy-test-"));
    roots.push(root);
    const homePath = join(root, "profile-home");
    mkdirSync(homePath, { recursive: true });
    const home = realpathSync(homePath);
    const bin = join(root, "fake-agy");
    writeFileSync(bin, script);
    chmodSync(bin, 0o755);
    process.env.CLAUDEXOR_AGY_BIN = bin;
    return { root, home, bin };
  }

  it("names the profile HOME its child receives for applied attempt evidence", () => {
    const { home } = fixture("#!/bin/sh\nexit 0\n");
    const adapter = createAgyAdapter({ prepareProfileKeychain: () => undefined });
    const live = HarnessRunSpec.parse({
      session_id: "s",
      intent: "explain",
      cwd: home,
      prompt: "p",
      credential_profile: profile(home),
      env: { HOME: "/engine/lane/home" },
    });
    expect(adapter.childHome?.(live)).toBe(home);
    expect(adapter.childHome?.({ ...live, credential_profile: null })).toBeNull();
  });

  it("constructs the exact route without requiring a fallback token file", () => {
    const { home } = fixture("#!/bin/sh\nexit 0\n");
    const route = resolveAgyProfileRoute(profile(home), {
      GEMINI_API_KEY: "must-be-scrubbed",
      GOOGLE_API_KEY: "must-also-be-scrubbed",
    });
    expect(route).not.toHaveProperty("refusal");
    if ("refusal" in route) return;
    expect(route.home).toBe(home);
    expect(route.env).toMatchObject({
      HOME: home,
      USERPROFILE: home,
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      GEMINI_API_KEY: null,
      GOOGLE_API_KEY: null,
    });
  });

  it("accepts vendor SUCCESS without a token file and stamps vendor provenance", async () => {
    const { home } = fixture(
      '#!/bin/sh\nprintf \'%s\\n\' \'{"status":"SUCCESS","command":{"data":{"id":"gemini-3.7-flash-high"}}}\'\n',
    );
    const status = await probeAgyCredentialProfile(profile(home), {
      runModelProbe: defaultAgyModelProbe,
      prepareProfileKeychain: () => undefined,
    });
    expect(status).toMatchObject({
      availability: "available",
      verification: "passed",
      verification_source: "vendor",
    });
    expect(status.last_verified_at).toBeTruthy();
    expect(status.detail).toContain("not inferred");
  });

  it("lets explicit vendor auth rejection outrank a stale token file", async () => {
    const { home } = fixture(
      '#!/bin/sh\nprintf \'%s\\n\' \'{"status":"ERROR","error":"authentication required. Run agy to log in"}\'\n',
    );
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(agyTokenPath(home), "stale", { mode: 0o600 });
    const status = await probeAgyCredentialProfile(profile(home), {
      runModelProbe: defaultAgyModelProbe,
      prepareProfileKeychain: () => undefined,
    });
    expect(status).toMatchObject({
      availability: "unavailable",
      verification: "failed",
      verification_source: "vendor",
    });
  });

  it("keeps malformed/non-auth/exit failures unknown instead of declaring logout", async () => {
    const { home } = fixture("#!/bin/sh\nprintf 'not-json\\n'\nexit 7\n");
    const status = await probeAgyCredentialProfile(profile(home), {
      runModelProbe: defaultAgyModelProbe,
      prepareProfileKeychain: () => undefined,
    });
    expect(status).toMatchObject({ availability: "unknown", verification: "not_run" });
  });

  it("refuses a probe when the profile keychain path is unsafe", async () => {
    const { home } = fixture("#!/bin/sh\nexit 0\n");
    let probed = false;
    const status = await probeAgyCredentialProfile(profile(home), {
      prepareProfileKeychain: () => {
        throw new AgyProfileKeychainError("profile keychain is unsafe", { unsafe: true });
      },
      runModelProbe: async () => {
        probed = true;
        return { kind: "authenticated", modelId: "gemini-test" };
      },
    });
    expect(status).toMatchObject({ availability: "unavailable", verification: "not_run" });
    expect(probed).toBe(false);
  });

  it("keeps the vendor's ambiguous headless auth timeout unknown", async () => {
    const { home } = fixture(
      '#!/bin/sh\necho \'{"status":"ERROR","error":"authentication failed or timed out"}\'\nexit 1\n',
    );
    const status = await probeAgyCredentialProfile(profile(home), {
      runModelProbe: defaultAgyModelProbe,
    });
    expect(status).toMatchObject({
      availability: "unknown",
      verification: "not_run",
      detail: "authentication failed or timed out",
    });
  });

  it("keeps a recoverable keychain-tool miss on the vendor fallback path", async () => {
    const { home } = fixture("#!/bin/sh\nexit 0\n");
    let probed = false;
    const status = await probeAgyCredentialProfile(profile(home), {
      prepareProfileKeychain: () => {
        throw new AgyProfileKeychainError("security tool unavailable");
      },
      runModelProbe: async () => {
        probed = true;
        return { kind: "authenticated", modelId: "gemini-test" };
      },
    });
    expect(status).toMatchObject({ availability: "available", verification: "passed" });
    expect(status.detail).toContain("private profile keychain setup degraded");
    expect(probed).toBe(true);
  });

  it("runs the real adapter path without a token-file admission gate", async () => {
    const { home } = fixture(`#!/bin/sh
printf '%s\n' '{"event":"init","conversation_id":"c1","init":{"model":"gemini-3.7-flash-high","cwd":"/tmp","tools":[],"permission_mode":"plan"}}'
printf '%s\n' '{"event":"result","result":{"status":"SUCCESS","response":"ok","usage":{"input_tokens":1,"output_tokens":1,"cache_read_tokens":0}}}'
`);
    const events = [];
    for await (const event of createAgyAdapter({ prepareProfileKeychain: () => undefined }).run(
      HarnessRunSpec.parse({
        session_id: "ses",
        cwd: home,
        prompt: "hello",
        intent: "explain",
        access: "readonly",
        credential_profile: profile(home),
      }),
    )) {
      events.push(event);
    }
    expect(events.some((event) => event.type === "started")).toBe(true);
    expect(events.some((event) => event.type === "message" && event.final)).toBe(true);
  });

  it("refuses the run before the vendor when the private path is unsafe", async () => {
    const { root, home } = fixture('#!/bin/sh\ntouch "$RUN_SENTINEL"\nexit 0\n');
    const sentinel = join(root, "vendor-spawned");
    const events = [];
    for await (const event of createAgyAdapter({
      prepareProfileKeychain: () => {
        throw new AgyProfileKeychainError("unsafe", { unsafe: true });
      },
    }).run(
      HarnessRunSpec.parse({
        session_id: "ses-unsafe",
        cwd: home,
        prompt: "hello",
        intent: "explain",
        access: "readonly",
        env: { RUN_SENTINEL: sentinel },
        credential_profile: profile(home),
      }),
    )) {
      events.push(event);
    }
    expect(existsSync(sentinel)).toBe(false);
    expect(events.map((event) => event.type)).toEqual(["error", "completed"]);
  });

  it.each(["/model", "/quota"] as const)(
    "gives %s EOF without a character device or controlling tty",
    async (command) => {
      const { root, home, bin } = fixture(`#!/usr/bin/env node
const fs = require("node:fs");
const characterDevice = fs.fstatSync(0).isCharacterDevice();
let interactive = characterDevice;
try { const fd = fs.openSync("/dev/tty", "r"); fs.closeSync(fd); interactive = true; } catch {}
if (interactive) fs.writeFileSync(process.env.BROWSER_SENTINEL, "opened");
const eof = fs.readSync(0, Buffer.alloc(1), 0, 1, null) === 0;
console.log(JSON.stringify({characterDevice, interactive, eof}));
`);
      const sentinel = join(root, "browser-spawned");
      const control = spawnSync(bin, [], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, BROWSER_SENTINEL: join(root, "control-browser") },
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(control.status).toBe(0);
      expect(JSON.parse(control.stdout)).toEqual({
        characterDevice: true,
        interactive: true,
        eof: true,
      });
      const result = await runAgyPrintCommand(
        bin,
        command,
        agyProfileRunEnv(home, { BROWSER_SENTINEL: sentinel }),
      );
      expect(result).toMatchObject({ kind: "completed", code: 0 });
      expect(JSON.parse(result.stdout)).toEqual({
        characterDevice: false,
        interactive: false,
        eof: true,
      });
      expect(existsSync(sentinel)).toBe(false);
    },
  );

  it("uses the exact console-free Windows spawn shape", () => {
    expect(agyPrintSpawnOptions("win32", {})).toMatchObject({
      detached: true,
      windowsHide: true,
      shell: false,
    });
    expect(agyPrintSpawnOptions("linux", {})).toMatchObject({
      detached: true,
      windowsHide: false,
      shell: false,
    });
  });

  it("bounds timeout and output overflow", async () => {
    const slow = fixture("#!/bin/sh\nsleep 30\n");
    const timed = await runAgyPrintCommand(slow.bin, "/model", agyProfileRunEnv(slow.home), {
      timeoutMs: 25,
    });
    expect(timed).toMatchObject({ kind: "failed", reason: "timed_out" });

    const noisy = fixture("#!/bin/sh\nyes x\n");
    const overflow = await runAgyPrintCommand(noisy.bin, "/quota", agyProfileRunEnv(noisy.home), {
      maxStdoutBytes: 512,
    });
    expect(overflow).toMatchObject({ kind: "failed", reason: "output_overflow" });
  });

  it("treats bytes after an exactly-full cap (and a zero cap) as overflow", async () => {
    for (const cap of [4, 0]) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        pid: undefined,
        stdin: new PassThrough(),
        stdout,
        stderr,
        kill: () => {
          queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
          return true;
        },
      });
      const run = runAgyPrintCommand(
        "agy",
        "/quota",
        {},
        {
          maxStdoutBytes: cap,
          cancelDeadlineMs: 50,
          drainMs: 1,
          resolveBinary: () => "/fake/agy",
          spawnProcess: (() => child) as never,
        },
      );
      queueMicrotask(() => {
        if (cap > 0) stdout.write(Buffer.alloc(cap, "x"));
        stdout.write("y");
      });
      await expect(run).resolves.toMatchObject({ kind: "failed", reason: "output_overflow" });
    }
  });

  it("settles from an abort-relative deadline when neither child nor reaper settles", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let kills = 0;
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: new PassThrough(),
      stdout,
      stderr,
      kill: () => {
        kills += 1;
        return true;
      },
    });
    const controller = new AbortController();
    const started = Date.now();
    const run = runAgyPrintCommand(
      "agy",
      "/model",
      {},
      {
        timeoutMs: 30_000,
        cancelDeadlineMs: 25,
        drainMs: 1,
        abortSignal: controller.signal,
        resolveBinary: () => "/fake/agy",
        spawnProcess: (() => child) as never,
      },
    );
    controller.abort();
    await expect(run).resolves.toMatchObject({
      kind: "failed",
      reason: "termination_unconfirmed",
    });
    expect(kills).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("observes an abort that races inside synchronous spawn", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const controller = new AbortController();
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: new PassThrough(),
      stdout,
      stderr,
      kill: () => {
        queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
        return true;
      },
    });
    const run = runAgyPrintCommand(
      "agy",
      "/model",
      {},
      {
        timeoutMs: 30_000,
        cancelDeadlineMs: 25,
        drainMs: 1,
        abortSignal: controller.signal,
        resolveBinary: () => "/fake/agy",
        spawnProcess: (() => {
          controller.abort();
          return child;
        }) as never,
      },
    );
    await expect(run).resolves.toMatchObject({ kind: "failed", reason: "aborted" });
  });

  it("keeps an unconfirmed live child in the passive process registry", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 42_424,
      stdin: new PassThrough(),
      stdout,
      stderr,
      kill: () => true,
    });
    const registered: number[] = [];
    const unregistered: number[] = [];
    const controller = new AbortController();
    const run = runAgyPrintCommand(
      "agy",
      "/model",
      {},
      {
        platform: "win32",
        timeoutMs: 30_000,
        cancelDeadlineMs: 10,
        drainMs: 1,
        abortSignal: controller.signal,
        resolveBinary: () => "/fake/agy.exe",
        spawnProcess: (() => child) as never,
        reap: (() => new Promise(() => {})) as never,
        processRegistry: {
          register: (pid) => registered.push(pid),
          unregister: (pid) => unregistered.push(pid),
        },
      },
    );
    controller.abort();
    await expect(run).resolves.toMatchObject({
      kind: "failed",
      reason: "termination_unconfirmed",
    });
    expect(registered).toEqual([42_424]);
    expect(unregistered).toEqual([]);

    child.emit("exit", null, "SIGKILL");
    expect(unregistered).toEqual([42_424]);
  });

  it("normalizes a synchronous spawn throw to spawn_failed", async () => {
    await expect(
      runAgyPrintCommand(
        "agy",
        "/model",
        {},
        {
          resolveBinary: () => "/fake/agy",
          spawnProcess: (() => {
            throw new Error("synthetic spawn throw");
          }) as never,
        },
      ),
    ).resolves.toMatchObject({ kind: "failed", reason: "spawn_failed" });
  });
});

describe("shared agy print classifier", () => {
  const completed = (stdout: string, code = 0, stderr = "") =>
    classifyAgyPrintResult({ kind: "completed", code, signal: null, stdout, stderr });

  it("accepts only supported SUCCESS + exit 0", () => {
    expect(completed('{"status":"SUCCESS","command":{"data":{}}}').kind).toBe("success");
    expect(completed('{"status":"SUCCESS","command":{"data":{}}}', 1).kind).toBe("probe_failed");
  });

  it("recognizes bounded vendor auth rejections without a broad auth substring", () => {
    expect(
      completed('{"status":"ERROR","error":"authentication required. Run agy to log in"}').kind,
    ).toBe("unauthenticated");
    expect(
      completed('{"status":"ERROR","error":"authentication service network unavailable"}').kind,
    ).toBe("probe_failed");
    expect(
      completed('{"status":"ERROR","error":"authentication failed or timed out"}', 1).kind,
    ).toBe("probe_failed");
  });

  it.each(["", "not json", "{}", '{"status":"ERROR","error":"network down"}'])(
    "keeps malformed/empty/unexpected output as probe_failed: %s",
    (raw) => expect(completed(raw).kind).toBe("probe_failed"),
  );
});
