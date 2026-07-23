import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProcessGroupService,
  inspectExecutable,
  resolveHarnessBinary,
  type KnownProcessIdentity,
  type ProcessIdentityReader,
} from "@claudexor/core";
import { defaultNativeCodexHome } from "@claudexor/harness-codex";
import { runSetupLogin, runSetupLoginWorker } from "./setup-login-runner.js";
import {
  SETUP_LOGIN_PROTOCOL_VERSION,
  atomicPrivateJson,
  captureExecutableEvidence,
  commandDigest,
  readLoginManifest,
  readRunnerResult,
  readRunnerState,
  sealLoginManifest,
  type SetupLoginManifest,
} from "./setup-login-protocol.js";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "setup protocol with spaces ")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function knownLeader(pid: number): KnownProcessIdentity {
  return {
    status: "known",
    pid,
    platform: "darwin",
    source: "proc_pidinfo",
    startToken: "darwin:1710000000:000001",
    processGroupId: pid,
  };
}

function processGroups(pid = 4242): ProcessGroupService {
  const leader = knownLeader(pid);
  const identity: ProcessIdentityReader = {
    read: (requested) =>
      requested === pid ? leader : { status: "missing", pid: requested, platform: "darwin" },
    self: () => leader,
  };
  return new ProcessGroupService({
    platform: "darwin",
    identity,
    probeProcessGroup: () => undefined,
    signalProcessGroup: () => undefined,
  });
}

function prepare(
  script: string,
  overrides: Partial<
    Omit<SetupLoginManifest, "manifestDigest" | "executable" | "commandDigest">
  > = {},
  name = "setup-protocol",
) {
  const jobDir = join(root, name);
  mkdirSync(jobDir, { mode: 0o700 });
  const binary = join(jobDir, "codex");
  writeFileSync(binary, script, { mode: 0o700 });
  chmodSync(binary, 0o700);
  const executable = captureExecutableEvidence(binary);
  const args = overrides.args ?? ["login"];
  const spec = sealLoginManifest({
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: "setup-protocol",
    executionId: "execution-1",
    harness: "codex",
    jobDir,
    binary,
    args,
    cwd: jobDir,
    statePath: join(jobDir, "runner-state.json"),
    resultPath: join(jobDir, "runner-result.json"),
    permitPath: join(jobDir, "runner-permit.json"),
    permitDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
    executable,
    commandDigest: commandDigest(executable, args),
    ...overrides,
  });
  const manifestPath = join(jobDir, "runner-manifest.json");
  atomicPrivateJson(manifestPath, spec);
  return { jobDir, manifestPath, spec };
}

function issuePermit(spec: SetupLoginManifest, issuedAt = new Date().toISOString()): void {
  atomicPrivateJson(spec.permitPath, {
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: spec.jobId,
    executionId: spec.executionId,
    issuedAt,
    commandDigest: spec.commandDigest,
    manifestDigest: spec.manifestDigest,
  });
}

describe("setup-login sidecar protocol v2", () => {
  it("passes the disposable native-store selector from Terminal runner to its worker", async () => {
    const { manifestPath } = prepare("#!/bin/sh\nexit 0\n");
    const previous = process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    process.env.CLAUDEXOR_CODEX_NATIVE_HOME = join(root, "disposable-codex-home");
    let workerEnvironment: NodeJS.ProcessEnv | undefined;
    const child = new EventEmitter() as ChildProcess;
    try {
      const result = runSetupLogin(manifestPath, {
        spawnProcess: ((_command: string, _args: readonly string[], options: SpawnOptions) => {
          workerEnvironment = options.env;
          // waitForExit settles on `close` now (wave-1: `exit` can race the
          // final piped chunks) — a real child emits both, so the fake must too.
          queueMicrotask(() => {
            child.emit("exit", 0, null);
            child.emit("close", 0, null);
          });
          return child;
        }) as never,
      });
      await expect(result).resolves.toBe(0);
      expect(workerEnvironment?.CLAUDEXOR_CODEX_NATIVE_HOME).toBe(
        join(root, "disposable-codex-home"),
      );
    } finally {
      if (previous === undefined) delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
      else process.env.CLAUDEXOR_CODEX_NATIVE_HOME = previous;
    }
  });

  it("runs only after a matching permit and persists hash-bound state/result from a space-containing path", async () => {
    const { manifestPath, spec } = prepare("#!/bin/sh\nsleep 0.01\nexit 0\n");
    const issuedAt = new Date().toISOString();
    issuePermit(spec, issuedAt);

    expect(
      await runSetupLoginWorker(manifestPath, {
        processGroupService: processGroups(),
        selfPid: 4242,
      }),
    ).toBe(0);

    expect(readRunnerState(spec.statePath)).toMatchObject({
      version: 2,
      jobId: spec.jobId,
      executionId: spec.executionId,
      stage: "running",
      commandDigest: spec.commandDigest,
      manifestDigest: spec.manifestDigest,
    });
    expect(readRunnerResult(spec.resultPath)).toMatchObject({
      version: 2,
      commandStarted: true,
      permitIssuedAt: issuedAt,
      commandDigest: spec.commandDigest,
      manifestDigest: spec.manifestDigest,
      exitCode: 0,
      signal: null,
    });
  });

  it("spawns the exact absolute argv with provider credentials scrubbed", async () => {
    const script = [
      "#!/bin/sh",
      "printf '%s' \"$1\" > argv.txt",
      'printf \'%s|%s|%s|%s\' "$OPENAI_API_KEY" "$ANTHROPIC_API_KEY" "$OPENAI_BASE_URL" "$CODEX_HOME" > env.txt',
      "exit 0",
      "",
    ].join("\n");
    const { jobDir, manifestPath, spec } = prepare(script);
    issuePermit(spec);
    const old = [
      process.env.OPENAI_API_KEY,
      process.env.ANTHROPIC_API_KEY,
      process.env.OPENAI_BASE_URL,
    ];
    process.env.OPENAI_API_KEY = "secret-openai";
    process.env.ANTHROPIC_API_KEY = "secret-anthropic";
    process.env.OPENAI_BASE_URL = "https://override.invalid";
    try {
      expect(
        await runSetupLoginWorker(manifestPath, {
          processGroupService: processGroups(),
          selfPid: 4242,
        }),
      ).toBe(0);
      expect(readFileSync(join(jobDir, "argv.txt"), "utf8")).toBe("login");
      expect(readFileSync(join(jobDir, "env.txt"), "utf8")).toBe("|||" + defaultNativeCodexHome());
    } finally {
      ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL"].forEach((key, index) => {
        if (old[index] === undefined) delete process.env[key];
        else process.env[key] = old[index];
      });
    }
  });

  it.each([
    { script: "sleep 0.01\nexit 7", exitCode: 7, signal: null },
    { script: "sleep 0.01\nkill -TERM $$", exitCode: null, signal: "SIGTERM" },
  ])("persists non-success exit evidence %#", async ({ script, exitCode, signal }) => {
    const { manifestPath, spec } = prepare("#!/bin/sh\n" + script + "\n");
    issuePermit(spec);
    expect(
      await runSetupLoginWorker(manifestPath, {
        processGroupService: processGroups(),
        selfPid: 4242,
      }),
    ).toBe(1);
    expect(readRunnerResult(spec.resultPath)).toMatchObject({
      commandStarted: true,
      permitIssuedAt: expect.any(String),
      exitCode,
      signal,
    });
  });

  it("never spawns vendor code without a matching durable permit", async () => {
    let spawned = 0;
    const expired = new Date(Date.now() - 1).toISOString();
    const { manifestPath, spec } = prepare("#!/bin/sh\nexit 0\n", { permitDeadlineAt: expired });
    expect(
      await runSetupLoginWorker(manifestPath, {
        processGroupService: processGroups(),
        selfPid: 4242,
        now: () => new Date(Date.parse(expired) + 1),
        spawnProcess: (() => {
          spawned += 1;
          throw new Error("must not spawn");
        }) as never,
      }),
    ).toBe(1);
    expect(spawned).toBe(0);
    expect(readRunnerResult(spec.resultPath)).toMatchObject({
      commandStarted: false,
      permitIssuedAt: null,
      errorCode: "permit_timeout",
      exitCode: null,
      signal: null,
    });
  });

  it("refuses an executable changed after authorization even with a valid permit", async () => {
    let spawned = 0;
    const { manifestPath, spec } = prepare("#!/bin/sh\nexit 0\n");
    issuePermit(spec);
    writeFileSync(spec.binary, "#!/bin/sh\nexit 9\n", { mode: 0o700 });
    expect(
      await runSetupLoginWorker(manifestPath, {
        processGroupService: processGroups(),
        selfPid: 4242,
        spawnProcess: (() => {
          spawned += 1;
          throw new Error("must not spawn");
        }) as never,
      }),
    ).toBe(1);
    expect(spawned).toBe(0);
    expect(readRunnerResult(spec.resultPath)).toMatchObject({
      commandStarted: false,
      permitIssuedAt: expect.any(String),
      errorCode: "spawn_failed",
    });
  });

  it("rejects sidecar and cwd escapes after schema validation", () => {
    const outside = join(root, "outside");
    mkdirSync(outside, { mode: 0o700 });
    const escapedState = prepare(
      "#!/bin/sh\nexit 0\n",
      { statePath: join(outside, "state.json") },
      "escape-state",
    );
    expect(() => readLoginManifest(escapedState.manifestPath)).toThrow(/sidecar path escapes/);

    const escapedCwd = prepare("#!/bin/sh\nexit 0\n", { cwd: outside }, "escape-cwd");
    expect(() => readLoginManifest(escapedCwd.manifestPath)).toThrow(/cwd escapes/);
  });

  it("rejects malformed process identities and result shapes", () => {
    const statePath = join(root, "bad-state.json");
    const resultPath = join(root, "bad-result.json");
    atomicPrivateJson(statePath, {
      version: 2,
      jobId: "setup-protocol",
      executionId: "execution-1",
      processGroup: { schemaVersion: 1, pgid: 2, leader: { status: "known", pid: -1 } },
      stage: "running",
      observedAt: "now",
      commandDigest: "x",
      manifestDigest: "y",
    });
    atomicPrivateJson(resultPath, {
      version: 2,
      jobId: "setup-protocol",
      executionId: "execution-1",
      commandDigest: "x",
      manifestDigest: "y",
      permitIssuedAt: null,
      commandStarted: true,
      exitCode: -1,
      signal: null,
      finishedAt: "now",
    });
    expect(readRunnerState(statePath)).toBeNull();
    expect(readRunnerResult(resultPath)).toBeNull();
  });

  it("never follows manifest or runner-sidecar symlinks", () => {
    const { jobDir, spec } = prepare("#!/bin/sh\nexit 0\n");
    const outside = join(root, "outside");
    mkdirSync(outside, { mode: 0o700 });
    const externalManifest = join(outside, "manifest.json");
    atomicPrivateJson(externalManifest, spec);
    const linkedManifest = join(jobDir, "linked-manifest.json");
    symlinkSync(externalManifest, linkedManifest);
    expect(() => readLoginManifest(linkedManifest)).toThrow();

    const externalState = join(outside, "state.json");
    atomicPrivateJson(externalState, {
      version: 2,
      jobId: spec.jobId,
      executionId: spec.executionId,
      processGroup: { schemaVersion: 1, pgid: 2, leader: knownLeader(2) },
      stage: "running",
      observedAt: new Date().toISOString(),
      commandDigest: spec.commandDigest,
      manifestDigest: spec.manifestDigest,
    });
    symlinkSync(externalState, spec.statePath);
    expect(readRunnerState(spec.statePath)).toBeNull();
  });

  it("atomically replaces a hostile destination symlink without modifying its target", () => {
    const jobDir = join(root, "atomic-result");
    mkdirSync(jobDir, { mode: 0o700 });
    const outside = join(root, "outside.json");
    writeFileSync(outside, "do-not-touch\n", { mode: 0o600 });
    const destination = join(jobDir, "runner-result.json");
    symlinkSync(outside, destination);
    atomicPrivateJson(destination, {
      version: 2,
      jobId: "setup-protocol",
      executionId: "execution-1",
      commandDigest: "a".repeat(64),
      manifestDigest: "b".repeat(64),
      permitIssuedAt: new Date().toISOString(),
      commandStarted: true,
      exitCode: 0,
      signal: null,
      finishedAt: new Date().toISOString(),
    });
    expect(readFileSync(outside, "utf8")).toBe("do-not-touch\n");
    expect(readRunnerResult(destination)).toMatchObject({ exitCode: 0, commandStarted: true });
  });
});

// W2: the official vendor installer (e.g. @anthropic-ai/claude-code) hard-links
// its platform binary into the launcher, so a legitimate CLI has nlink >= 2.
// Setup-login must accept it (dev+inode+sha256 identify the exact bytes) and
// must agree with the PATH resolver — the parity break that shipped in v2.0.0.
describe("setup-login executable evidence — hard-link tolerance (W2)", () => {
  function writeExecutable(dir: string, name: string): string {
    mkdirSync(dir, { mode: 0o700, recursive: true });
    const p = join(dir, name);
    writeFileSync(p, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(p, 0o755);
    return p;
  }

  it("accepts a hard-linked (nlink=2) vendor binary and pins its exact bytes", () => {
    const primary = writeExecutable(join(root, "vendor"), "claude-code");
    const launcher = join(root, "vendor", "claude.exe");
    linkSync(primary, launcher); // second hard link → both inodes are nlink=2

    const facts = inspectExecutable(launcher);
    expect(facts.nlink).toBe(2); // captured as a FACT, not a rejection
    expect(facts.isRegularFile).toBe(true);
    expect(facts.identityStable).toBe(true);

    const evidence = captureExecutableEvidence(launcher);
    const primaryEvidence = captureExecutableEvidence(primary);
    // Same inode/device/bytes: the two links are the same file.
    expect(evidence.inode).toBe(primaryEvidence.inode);
    expect(evidence.device).toBe(primaryEvidence.device);
    expect(evidence.sha256).toBe(primaryEvidence.sha256);
  });

  it("resolveHarnessBinary and evidence agree on the same hard-linked binary (parity)", () => {
    const dir = join(root, "path-vendor");
    const primary = writeExecutable(dir, "claude-code");
    const onPath = join(dir, "claude");
    linkSync(primary, onPath);

    // Fully hermetic env: HOME points at the empty temp root (so the
    // home-derived preferred dirs resolve to nothing) and `execPath` at a
    // non-existent path (so `managedRunnerNodeDir` anchors NO ambient
    // Node-runtime dir first). Without the injected execPath the resolver
    // prepends the REAL running Node's dir — on the operator's Mac that is
    // `~/.claudexor/node/bin`, whose own `claude` permanently shadowed this
    // fixture and reddened the battery on this machine alone.
    const hermeticExecPath = join(root, "no-such-node", "node");

    // Resolver (cheap launchable probe) accepts it...
    const resolvedAbsolute = resolveHarnessBinary(
      onPath,
      { HOME: root, PATH: "" },
      hermeticExecPath,
    );
    expect(resolvedAbsolute).toBe(onPath);
    const resolvedByName = resolveHarnessBinary(
      "claude",
      { HOME: root, PATH: dir },
      hermeticExecPath,
    );
    expect(resolvedByName).toBe(onPath);
    // ...and the evidence gate accepts the very same file (no nlink rejection).
    expect(() => captureExecutableEvidence(onPath)).not.toThrow();
  });

  it("realpath-resolves a symlinked launcher before capturing evidence", () => {
    const primary = writeExecutable(join(root, "sym-vendor"), "claude-code");
    const link = join(root, "sym-vendor", "claude");
    symlinkSync(primary, link);
    const evidence = captureExecutableEvidence(link);
    expect(evidence.realpath).toBe(realpathSync(primary));
    expect(evidence.sha256).toBe(captureExecutableEvidence(primary).sha256);
  });
});

describe("device-auth capability probe + output tee (v3.0.3 S6)", () => {
  const helpWithout =
    'if [ "$1" = "login" ] && [ "$2" = "--help" ]; then echo "Usage: codex login"; echo "  --with-api-key"; exit 0; fi';
  const helpWith =
    'if [ "$1" = "login" ] && [ "$2" = "--help" ]; then echo "Usage: codex login"; echo "  --device-auth"; exit 0; fi';

  it("refuses an old CLI with device_auth_unsupported WITHOUT running the vendor command", async () => {
    const { manifestPath, spec, jobDir } = prepare(
      `#!/bin/sh\n${helpWithout}\ntouch real-run.txt\nexit 0\n`,
      { args: ["login", "--device-auth"] },
      "probe-unsupported",
    );
    issuePermit(spec);
    expect(
      await runSetupLoginWorker(manifestPath, {
        processGroupService: processGroups(),
        selfPid: 4242,
      }),
    ).toBe(1);
    const result = readRunnerResult(spec.resultPath);
    expect(result).toMatchObject({
      commandStarted: false,
      errorCode: "device_auth_unsupported",
      exitCode: null,
    });
    expect((result as { outputTail?: string }).outputTail).toContain("--with-api-key");
    expect(existsSync(join(jobDir, "real-run.txt"))).toBe(false);
  });

  it("runs the vendor command when the help advertises --device-auth", async () => {
    const { manifestPath, spec, jobDir } = prepare(
      `#!/bin/sh\n${helpWith}\ntouch real-run.txt\nexit 0\n`,
      { args: ["login", "--device-auth"] },
      "probe-supported",
    );
    issuePermit(spec);
    expect(
      await runSetupLoginWorker(manifestPath, {
        processGroupService: processGroups(),
        selfPid: 4242,
      }),
    ).toBe(0);
    expect(readRunnerResult(spec.resultPath)).toMatchObject({ commandStarted: true, exitCode: 0 });
    expect(existsSync(join(jobDir, "real-run.txt"))).toBe(true);
  });

  it("fails OPEN when the probe produces no output (broken probe falls through to the real spawn)", async () => {
    const { manifestPath, spec, jobDir } = prepare(
      `#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "--help" ]; then exit 7; fi\ntouch real-run.txt\nexit 0\n`,
      { args: ["login", "--device-auth"] },
      "probe-broken",
    );
    issuePermit(spec);
    expect(
      await runSetupLoginWorker(manifestPath, {
        processGroupService: processGroups(),
        selfPid: 4242,
      }),
    ).toBe(0);
    expect(existsSync(join(jobDir, "real-run.txt"))).toBe(true);
  });

  it("persists a bounded ANSI-stripped output tail on failure only", async () => {
    const { manifestPath, spec } = prepare(
      `#!/bin/sh\nprintf '\\033[94mdevice code rejected\\033[0m by server\\n' >&2\nexit 3\n`,
      { args: ["login"] },
      "tee-tail",
    );
    issuePermit(spec);
    expect(
      await runSetupLoginWorker(manifestPath, {
        processGroupService: processGroups(),
        selfPid: 4242,
      }),
    ).toBe(1);
    const result = readRunnerResult(spec.resultPath) as { outputTail?: string; exitCode?: number };
    expect(result.exitCode).toBe(3);
    expect(result.outputTail).toContain("device code rejected");
    expect(result.outputTail).not.toContain("[94m");
    expect((result.outputTail ?? "").length).toBeLessThanOrEqual(4000);
  });

  it("the tail keeps the final bytes intact across a split multibyte UTF-8 boundary", async () => {
    // A script that prints a multibyte string (cyrillic) then fails: the
    // persisted tail must decode cleanly (no U+FFFD) and stay within the cap.
    const { manifestPath, spec } = prepare(
      `#!/bin/sh\nprintf 'начало ЛОГ вывод конец'\nexit 4\n`,
      { args: ["login"] },
      "tail-multibyte",
    );
    issuePermit(spec);
    expect(
      await runSetupLoginWorker(manifestPath, {
        processGroupService: processGroups(),
        selfPid: 4242,
      }),
    ).toBe(1);
    const tail = (readRunnerResult(spec.resultPath) as { outputTail?: string }).outputTail ?? "";
    expect(tail).toContain("конец");
    expect(tail).not.toContain("�");
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("omits the output tail on success", async () => {
    const { manifestPath, spec } = prepare(
      `#!/bin/sh\necho "Successfully logged in"\nexit 0\n`,
      { args: ["login"] },
      "tee-success",
    );
    issuePermit(spec);
    expect(
      await runSetupLoginWorker(manifestPath, {
        processGroupService: processGroups(),
        selfPid: 4242,
      }),
    ).toBe(0);
    expect(
      (readRunnerResult(spec.resultPath) as { outputTail?: string }).outputTail,
    ).toBeUndefined();
  });

  it("an errored-but-chatty probe falls through to the real spawn (fail-open)", async () => {
    // An old CLI whose `login --help` prints an error to stderr AND exits
    // nonzero must NOT be classified as device_auth_unsupported: the probe
    // settles on `close` with code===0, so a chatty-but-errored probe fails
    // OPEN to the real spawn (whose own failure would carry the diagnostics).
    const { manifestPath, spec, jobDir } = prepare(
      `#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "--help" ]; then echo "error: unrecognized subcommand 'login'" >&2; exit 2; fi\ntouch real-run.txt\nexit 0\n`,
      { args: ["login", "--device-auth"] },
      "probe-chatty-error",
    );
    issuePermit(spec);
    expect(
      await runSetupLoginWorker(manifestPath, {
        processGroupService: processGroups(),
        selfPid: 4242,
      }),
    ).toBe(0);
    expect(existsSync(join(jobDir, "real-run.txt"))).toBe(true);
    const result = readRunnerResult(spec.resultPath) as {
      errorCode?: string;
      commandStarted?: boolean;
      exitCode?: number;
    };
    expect(result.errorCode).not.toBe("device_auth_unsupported");
    expect(result).toMatchObject({ commandStarted: true, exitCode: 0 });
  });

  it("the persisted tail carries no ESC bytes and redacts secret-like tokens", async () => {
    // Assembled at runtime so no token-like literal lands in the source tree
    // (secret-scan CI, INV-062). This matches the redactor's `sk-…` rule.
    const token = ["sk", "or", "FAKE".repeat(4) + "1234"].join("-");
    // The script emits, to stderr: an OSC-8 hyperlink (ESC ] 8 ; ; URI ESC \),
    // readable words, a bare ESC, and the secret — then fails (exit 3).
    const script =
      "#!/bin/sh\n" +
      "printf 'plain readable words here\\n' >&2\n" +
      "printf '\\033]8;;https://example\\033\\\\hyperlinked words\\n' >&2\n" +
      "printf 'a bare \\033 escape then secret " +
      token +
      " tail end\\n' >&2\n" +
      "exit 3\n";
    const { manifestPath, spec } = prepare(script, { args: ["login"] }, "tee-redact");
    issuePermit(spec);
    expect(
      await runSetupLoginWorker(manifestPath, {
        processGroupService: processGroups(),
        selfPid: 4242,
      }),
    ).toBe(1);
    const result = readRunnerResult(spec.resultPath) as { outputTail?: string; exitCode?: number };
    expect(result.exitCode).toBe(3);
    const tail = result.outputTail ?? "";
    // The readable prose survives the escape-stripping.
    expect(tail).toContain("plain readable words here");
    expect(tail).toContain("hyperlinked words");
    expect(tail).toContain("a bare");
    expect(tail).toContain("tail end");
    // No terminal escape byte anywhere — OSC hyperlink and bare ESC are gone.
    expect(/\u001b/.test(tail)).toBe(false);
    // The secret is redacted, not passed through.
    expect(tail).not.toContain(token);
    expect(tail).toContain("[redacted]");
  });
});
