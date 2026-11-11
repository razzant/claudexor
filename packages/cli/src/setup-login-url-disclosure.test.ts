import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlSetupJob } from "@claudexor/schema";
import { ProcessGroupService, type ProcessIdentityReader } from "@claudexor/core";
import {
  createOAuthUrlDetector,
  extractOAuthUrl,
  runSetupLoginWorker,
} from "./setup-login-runner.js";
import { resolvePtyWrappedCommand } from "./setup-login-pty.js";
import { createDeviceCodeDisclosureWatcher } from "./setup-device-code-disclosure.js";
import {
  SETUP_LOGIN_PROTOCOL_VERSION,
  atomicPrivateJson,
  captureExecutableEvidence,
  commandDigest,
  readRunnerDeviceCode,
  sealLoginManifest,
} from "./setup-login-protocol.js";
import { projectSetupDeviceCode } from "./setup-client-pty.js";
import { nativeLoginEnv } from "./native-login.js";

/**
 * Upstream half of "non-codex login without Terminal.app": a TERMINAL-mode
 * login job (claude/cursor) captures the vendor CLI's OAuth URL from its own
 * output and surfaces it as the SAME structured sidecar disclosure the codex
 * device-code flow uses — URL-only card, no terminal needed to read it.
 */

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "setup-oauth-url-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function processGroups(pid = 4242): ProcessGroupService {
  const leader = {
    status: "known" as const,
    pid,
    platform: "darwin" as const,
    source: "proc_pidinfo" as const,
    startToken: "darwin:1710000000:000001",
    processGroupId: pid,
  };
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

function prepareTerminalLogin(
  script: string,
  harness: "claude" | "cursor" | "agy" = "claude",
  loginMode?: "url_disclosure" | "url_disclosure_with_input",
  ptyStdin?: boolean,
  profileConfigDir?: string,
) {
  const jobDir = join(root, "job");
  mkdirSync(jobDir, { mode: 0o700 });
  const binary = join(jobDir, harness);
  writeFileSync(binary, script, { mode: 0o700 });
  chmodSync(binary, 0o700);
  const executable = captureExecutableEvidence(binary);
  const args = harness === "claude" ? ["auth", "login"] : harness === "agy" ? [] : ["login"];
  const spec = sealLoginManifest({
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: "setup-oauth",
    executionId: "execution-1",
    harness,
    jobDir,
    binary,
    args,
    cwd: jobDir,
    ...(loginMode ? { loginMode } : {}),
    ...(profileConfigDir ? { profileConfigDir } : {}),
    ...(loginMode === "url_disclosure_with_input"
      ? { inputPath: join(jobDir, "runner-input.json"), ...(ptyStdin ? { ptyStdin: true } : {}) }
      : {}),
    // Terminal-mode manifests now carry the disclosure sidecar path too.
    deviceCodePath: join(jobDir, "runner-devicecode.json"),
    statePath: join(jobDir, "runner-state.json"),
    resultPath: join(jobDir, "runner-result.json"),
    permitPath: join(jobDir, "runner-permit.json"),
    permitDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
    executable,
    commandDigest: commandDigest(executable, args),
  });
  atomicPrivateJson(join(jobDir, "runner-manifest.json"), spec);
  atomicPrivateJson(spec.permitPath, {
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: spec.jobId,
    executionId: spec.executionId,
    issuedAt: new Date().toISOString(),
    commandDigest: spec.commandDigest,
    manifestDigest: spec.manifestDigest,
  });
  return { jobDir, manifestPath: join(jobDir, "runner-manifest.json"), spec };
}

async function runWorker(manifestPath: string, nativeDir: string): Promise<number> {
  // The claude native-store override must live INSIDE the Claudexor config
  // root, so the hermetic test roots BOTH in the temp dir.
  const saved: Record<string, string | undefined> = {
    CLAUDEXOR_CONFIG_DIR: process.env.CLAUDEXOR_CONFIG_DIR,
    CLAUDEXOR_CLAUDE_NATIVE_DIR: process.env.CLAUDEXOR_CLAUDE_NATIVE_DIR,
  };
  process.env.CLAUDEXOR_CONFIG_DIR = root;
  process.env.CLAUDEXOR_CLAUDE_NATIVE_DIR = nativeDir;
  try {
    return await runSetupLoginWorker(manifestPath, {
      processGroupService: processGroups(),
      selfPid: 4242,
      prepareAgyProfileKeychain: () => undefined,
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("external client_pty attach runner", () => {
  it.each([
    ["agy", ["-p", "/model", "--output-format", "json"]],
    ["claude", ["auth", "login"]],
    ["cursor", ["login"]],
  ] as const)(
    "runs %s once on inherited stdio without a terminal helper",
    async (harness, args) => {
      const jobDir = join(root, `external-${harness}`);
      mkdirSync(jobDir, { mode: 0o700 });
      const binary = join(jobDir, harness);
      writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      chmodSync(binary, 0o700);
      const profileConfigDir = join(root, `profile-${harness}`);
      const executable = captureExecutableEvidence(binary);
      const spec = sealLoginManifest({
        version: SETUP_LOGIN_PROTOCOL_VERSION,
        jobId: `setup-external-${harness}`,
        executionId: "execution-1",
        harness,
        jobDir,
        binary,
        args: [...args],
        cwd: jobDir,
        profileConfigDir,
        statePath: join(jobDir, "runner-state.json"),
        resultPath: join(jobDir, "runner-result.json"),
        permitPath: join(jobDir, "runner-permit.json"),
        permitDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
        executable,
        commandDigest: commandDigest(executable, args),
      });
      const manifestPath = join(jobDir, "runner-manifest.json");
      atomicPrivateJson(manifestPath, spec);
      atomicPrivateJson(spec.permitPath, {
        version: SETUP_LOGIN_PROTOCOL_VERSION,
        jobId: spec.jobId,
        executionId: spec.executionId,
        issuedAt: new Date().toISOString(),
        commandDigest: spec.commandDigest,
        manifestDigest: spec.manifestDigest,
      });
      const calls: Array<{
        binary: string;
        args: readonly string[];
        options: Record<string, unknown>;
      }> = [];
      const spawnProcess = vi.fn((spawnBinary, spawnArgs, options) => {
        calls.push({ binary: String(spawnBinary), args: spawnArgs as string[], options });
        const child = new EventEmitter() as ChildProcess;
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      });
      const terminalResolver = vi.fn();
      const prior = process.env.CLAUDEXOR_CONFIG_DIR;
      process.env.CLAUDEXOR_CONFIG_DIR = root;
      let expectedEnv: NodeJS.ProcessEnv = {};
      try {
        expectedEnv = nativeLoginEnv(harness, process.env, profileConfigDir);
        expect(
          await runSetupLoginWorker(manifestPath, {
            processGroupService: processGroups(),
            selfPid: 4242,
            spawnProcess: spawnProcess as never,
            resolvePtyCommand: terminalResolver,
            prepareAgyProfileKeychain: () => undefined,
          }),
        ).toBe(0);
      } finally {
        if (prior === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
        else process.env.CLAUDEXOR_CONFIG_DIR = prior;
      }
      expect(spawnProcess).toHaveBeenCalledOnce();
      expect(terminalResolver).not.toHaveBeenCalled();
      expect(calls[0]).toMatchObject({ binary: realpathSync(binary), args: [...args] });
      expect(calls[0]?.options).toMatchObject({
        cwd: jobDir,
        stdio: "inherit",
        env: expectedEnv,
      });
    },
  );
});

describe("extractOAuthUrl", () => {
  it("finds a sign-in URL through ANSI color noise and trims trailing punctuation", () => {
    const text =
      "\u001b[1mBrowser did not open?\u001b[0m Visit:\n" +
      "\u001b[4mhttps://claude.ai/oauth/authorize?client=cli&state=abc123\u001b[0m.\n";
    expect(extractOAuthUrl(text)).toBe("https://claude.ai/oauth/authorize?client=cli&state=abc123");
  });

  it("ignores URLs with no sign-in signature (a docs banner is not the login link)", () => {
    expect(extractOAuthUrl("see https://docs.example.com/guide for help")).toBeNull();
    expect(extractOAuthUrl("no urls at all")).toBeNull();
  });

  it("returns the FIRST qualifying URL when several are printed", () => {
    const text =
      "https://docs.example.com/guide then https://cursor.com/loginDeepControl?token=t1 " +
      "and later https://cursor.com/loginDeepControl?token=t2";
    expect(extractOAuthUrl(text)).toBe("https://cursor.com/loginDeepControl?token=t1");
  });

  it("a buffer-end URL is provisional: published, then superseded by the full capture (FF-2)", () => {
    const detector = createOAuthUrlDetector();
    // The chunk boundary cuts the URL right after a signature-bearing prefix.
    expect(detector.push(Buffer.from("Visit https://claude.ai/oauth"))).toBe(
      "https://claude.ai/oauth",
    );
    // The rest of the URL arrives: the longer capture supersedes the prefix.
    expect(detector.push(Buffer.from("/authorize?client=cli&state=s1"))).toBe(
      "https://claude.ai/oauth/authorize?client=cli&state=s1",
    );
    // Output continuing past the URL finalizes it without re-publishing.
    expect(detector.push(Buffer.from(" — press enter\n"))).toBeNull();
    expect(
      detector.push(Buffer.from("again https://claude.ai/oauth/authorize?state=s2")),
    ).toBeNull();
  });

  it("detector catches a URL split across chunks and reports exactly once", () => {
    const detector = createOAuthUrlDetector();
    expect(detector.push(Buffer.from("Visit https://auth.openai.com/oa"))).toBeNull();
    expect(detector.push(Buffer.from("uth/authorize?x=1 to continue\n"))).toBe(
      "https://auth.openai.com/oauth/authorize?x=1",
    );
    // Re-prints must not re-disclose.
    expect(detector.push(Buffer.from("again https://auth.openai.com/oauth/authorize?x=2"))).toBe(
      null,
    );
  });
});

describe("terminal-mode login worker OAuth URL disclosure", () => {
  it("captures the vendor login URL into the structured oauth_url sidecar, keeps output flowing", async () => {
    const script = [
      "#!/bin/sh",
      "printf 'Opening browser...\\n'",
      "printf '\\033[1mIf it does not open, visit:\\033[0m\\n'",
      "printf 'https://claude.ai/oauth/authorize?code=true&state=abc123\\n'",
      "sleep 0.01",
      "exit 0",
      "",
    ].join("\n");
    const { jobDir, manifestPath, spec } = prepareTerminalLogin(script);
    expect(await runWorker(manifestPath, join(root, "native-claude"))).toBe(0);

    // Structured disclosure — the codex device-code sidecar shape, URL-only.
    const sidecar = readRunnerDeviceCode(spec.deviceCodePath as string);
    expect(sidecar).toMatchObject({
      jobId: spec.jobId,
      executionId: spec.executionId,
      flow: "oauth_url",
      verificationUrl: "https://claude.ai/oauth/authorize?code=true&state=abc123",
      userCode: "",
    });

    // Secret discipline: the URL rides ONLY the transient sidecar, never the
    // durable result receipt (same rule as the device-code userCode).
    const receipt = readFileSync(join(jobDir, "runner-result.json"), "utf8");
    expect(receipt).not.toContain("claude.ai/oauth");
  });

  it("writes no sidecar when the vendor login never prints a sign-in URL", async () => {
    const script = "#!/bin/sh\nprintf 'already authenticated\\n'\nexit 0\n";
    const { manifestPath, spec } = prepareTerminalLogin(script);
    expect(await runWorker(manifestPath, join(root, "native-claude"))).toBe(0);
    expect(existsSync(spec.deviceCodePath as string)).toBe(false);
  });

  it("a pre-upgrade manifest without deviceCodePath still runs and discloses nothing", async () => {
    const jobDir = join(root, "job-legacy");
    mkdirSync(jobDir, { mode: 0o700 });
    const binary = join(jobDir, "claude");
    writeFileSync(
      binary,
      "#!/bin/sh\nprintf 'https://claude.ai/oauth/authorize?s=1\\n'\nexit 0\n",
      {
        mode: 0o700,
      },
    );
    chmodSync(binary, 0o700);
    const executable = captureExecutableEvidence(binary);
    const args = ["auth", "login"];
    const spec = sealLoginManifest({
      version: SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: "setup-legacy",
      executionId: "execution-1",
      harness: "claude",
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
    });
    const manifestPath = join(jobDir, "runner-manifest.json");
    atomicPrivateJson(manifestPath, spec);
    atomicPrivateJson(spec.permitPath, {
      version: SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: spec.jobId,
      executionId: spec.executionId,
      issuedAt: new Date().toISOString(),
      commandDigest: spec.commandDigest,
      manifestDigest: spec.manifestDigest,
    });
    expect(await runWorker(manifestPath, join(root, "native-claude"))).toBe(0);
    expect(existsSync(join(jobDir, "runner-devicecode.json"))).toBe(false);
  });
});

describe("projectSetupDeviceCode surfaces terminal-login oauth_url sidecars", () => {
  function terminalClaudeJob(): ControlSetupJob {
    return ControlSetupJob.parse({
      jobId: "setup-oauth",
      harness: "claude",
      action: "login",
      state: "waiting_for_input",
      phase: "awaiting_user",
      command: "claude auth login",
      guideUrl: null,
      message: "Complete claude native login.",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      authCapability: {
        attemptId: "attempt-oauth",
        challengeDigest: "d".repeat(64),
        requestDigest: "e".repeat(64),
        disclosure: {
          schemaVersion: 1,
          protocolVersion: 1,
          harness: "claude",
          requested: "subscription",
          requiredRoute: "vendor_native",
          requiredSource: "native_session",
          networkScope: "selected_harness_only",
          billingKnowledge: "unknown",
          incrementalCostKnowledge: "unknown",
          mayConsumeQuota: true,
          generatedAt: new Date().toISOString(),
        },
        state: "disclosed",
      },
      authorization: {
        executionId: "execution-1",
        executable: {
          realpath: "/usr/local/bin/claude",
          sha256: "a".repeat(64),
          size: 10,
          mode: 0o755,
          device: "1",
          inode: "2",
        },
        // No "app-server" here — this is exactly the terminal job shape the
        // old isDeviceCodeSetupJob gate used to exclude.
        args: ["auth", "login"],
        commandDigest: "b".repeat(64),
        manifestDigest: "c".repeat(64),
      },
    });
  }

  it("overlays the oauth_url disclosure for an awaiting-user terminal login", () => {
    const sidecarPath = join(root, "runner-devicecode.json");
    atomicPrivateJson(sidecarPath, {
      version: SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: "setup-oauth",
      executionId: "execution-1",
      flow: "oauth_url",
      verificationUrl: "https://claude.ai/oauth/authorize?state=abc",
      userCode: "",
      disclosedAt: new Date().toISOString(),
    });
    expect(projectSetupDeviceCode(terminalClaudeJob(), sidecarPath)).toEqual({
      flow: "oauth_url",
      verificationUrl: "https://claude.ai/oauth/authorize?state=abc",
      userCode: "",
    });
  });

  it("still refuses a sidecar bound to another execution", () => {
    const sidecarPath = join(root, "runner-devicecode.json");
    atomicPrivateJson(sidecarPath, {
      version: SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: "setup-oauth",
      executionId: "execution-OTHER",
      flow: "oauth_url",
      verificationUrl: "https://claude.ai/oauth/authorize?state=abc",
      userCode: "",
      disclosedAt: new Date().toISOString(),
    });
    expect(projectSetupDeviceCode(terminalClaudeJob(), sidecarPath)).toBeUndefined();
  });
});

describe("disclosure watcher supersession (wave FIX_FIRST: SSE clients must see the corrected URL)", () => {
  it("journals a fresh update when a provisional sidecar URL is superseded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-disclosure-"));
    const sidecar = join(dir, "device-code.json");
    const updates: string[] = [];
    const job = {
      jobId: "setup-x",
      harness: "claude",
      state: "waiting_for_input",
      phase: "awaiting_user",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    } as unknown as ControlSetupJob;
    const arm = createDeviceCodeDisclosureWatcher({
      status: () => job,
      update: (_id, patch) => updates.push(String(patch.message)),
      disclosurePath: () => sidecar,
      now: () => new Date(),
    });
    const write = (verificationUrl: string) =>
      writeFileSync(
        sidecar,
        JSON.stringify({
          version: 2,
          jobId: "setup-x",
          executionId: "e-1",
          flow: "oauth_url",
          verificationUrl,
          userCode: "",
          disclosedAt: new Date().toISOString(),
        }),
      );
    arm("setup-x");
    // Provisional prefix lands first (chunk-boundary truncation).
    write("https://claude.ai/oauth");
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(updates.length).toBe(1);
    // The full capture supersedes the sidecar: the watcher must journal AGAIN
    // so an event-stream client re-reads the corrected overlay.
    write("https://claude.ai/oauth/authorize?client=cli&state=s1");
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(updates.length).toBe(2);
    // Identical content never re-journals per tick.
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(updates.length).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("daemon-hosted no-Terminal login modes (owner directive 2026-08-04)", () => {
  it("cursor url_disclosure: NO_OPEN_BROWSER reaches the vendor and the URL is disclosed", async () => {
    const script = [
      "#!/bin/bash",
      'printf "%s" "${NO_OPEN_BROWSER:-}" > "$(dirname "$0")/no-open-browser.txt"',
      'echo "Sign in: https://cursor.com/loginDeepControl?challenge=c1&uuid=u1&mode=login"',
      "exit 0",
      "",
    ].join("\n");
    // D-U3: a cursor login manifest must target an account row's file-store
    // HOME — cursor has no default credential store any more.
    const profileHome = join(root, "cursor-default-home");
    mkdirSync(profileHome, { recursive: true });
    const { jobDir, manifestPath } = prepareTerminalLogin(
      script,
      "cursor",
      "url_disclosure",
      undefined,
      profileHome,
    );
    const code = await runWorker(manifestPath, join(root, "native"));
    expect(code).toBe(0);
    expect(readFileSync(join(jobDir, "no-open-browser.txt"), "utf8")).toBe("1");
    const disclosure = readRunnerDeviceCode(join(jobDir, "runner-devicecode.json"));
    expect(disclosure).toMatchObject({
      flow: "oauth_url",
      verificationUrl: "https://cursor.com/loginDeepControl?challenge=c1&uuid=u1&mode=login",
      userCode: "",
    });
  });

  it("claude url_disclosure_with_input: the input sidecar reaches the vendor's stdin exactly once", async () => {
    const script = [
      "#!/bin/bash",
      'echo "Visit https://platform.claude.com/oauth/authorize?state=s1 then paste the code"',
      "IFS= read -r -t 8 line || exit 3",
      'printf "%s" "$line" > "$(dirname "$0")/received.txt"',
      "exit 0",
      "",
    ].join("\n");
    const { jobDir, manifestPath, spec } = prepareTerminalLogin(
      script,
      "claude",
      "url_disclosure_with_input",
    );
    const workerDone = runWorker(manifestPath, join(root, "native"));
    // Wait for the URL disclosure (the card is now showing the link + field),
    // then deliver the one-shot input the way the daemon route does.
    const deadline = Date.now() + 6_000;
    for (;;) {
      const disclosure = readRunnerDeviceCode(join(jobDir, "runner-devicecode.json"));
      if (disclosure) {
        expect(disclosure.flow).toBe("oauth_url_input");
        break;
      }
      if (Date.now() > deadline) throw new Error("disclosure sidecar never appeared");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    atomicPrivateJson(join(jobDir, "runner-input.json"), {
      version: SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: spec.jobId,
      executionId: spec.executionId,
      value: "pasted-oauth-code-42",
      submittedAt: new Date().toISOString(),
    });
    expect(await workerDone).toBe(0);
    expect(readFileSync(join(jobDir, "received.txt"), "utf8")).toBe("pasted-oauth-code-42");
    // The transient value never lands in the durable result receipt.
    const result = readFileSync(join(jobDir, "runner-result.json"), "utf8");
    expect(result).not.toContain("pasted-oauth-code-42");
    // And it does not survive in its OWN sidecar either: after delivery the
    // file is a non-secret consumed marker (still present, so a second
    // submission still conflicts), and the code itself stops existing on disk.
    const sidecar = readFileSync(join(jobDir, "runner-input.json"), "utf8");
    expect(sidecar).not.toContain("pasted-oauth-code-42");
    expect(sidecar).toContain("consumed");
  });

  it("an input sidecar bound to a different execution is never delivered", async () => {
    const script = [
      "#!/bin/bash",
      'echo "Visit https://platform.claude.com/oauth/authorize?state=s2 then paste the code"',
      "IFS= read -r -t 2 line && exit 9",
      "exit 3",
      "",
    ].join("\n");
    const { jobDir, manifestPath, spec } = prepareTerminalLogin(
      script,
      "claude",
      "url_disclosure_with_input",
    );
    atomicPrivateJson(join(jobDir, "runner-input.json"), {
      version: SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: spec.jobId,
      executionId: "execution-FOREIGN",
      value: "stolen-code",
      submittedAt: new Date().toISOString(),
    });
    // The vendor's bounded read must time out (exit 3): a foreign-execution
    // sidecar reads as absent, never as input.
    expect(await runWorker(manifestPath, join(root, "native"))).toBe(1);
  });
});

/**
 * agy's own login transport. The vendor answers a PIPED stdin with
 * "authentication required" and never prints its URL — it reads the pasted
 * code only from a terminal — so the runner interposes a terminal helper.
 * The fake below refuses exactly the way the vendor does, so the test fails if
 * the tty ever stops being allocated.
 */
describe("pty-stdin login transport (agy)", () => {
  it("prefers the tool that actually works, quotes for Tcl, and types unavailable hosts", async () => {
    const inspectExpect = async (path: string) =>
      path === "/usr/bin/expect" ? ("regular_executable" as const) : ("missing" as const);
    // expect present (every macOS, and a Linux box that installed it).
    const wrapped = await resolvePtyWrappedCommand("/bin/a gy", [], {
      platform: "darwin",
      inspectExecutable: inspectExpect,
    });
    expect(wrapped).toMatchObject({
      status: "ready",
      backend: "expect",
      command: { binary: "/usr/bin/expect" },
      helperControlStderr: false,
    });
    if (wrapped.status !== "ready") throw new Error("expect transport did not resolve");
    const script = wrapped.command.args[1]!;
    expect(script).toContain("spawn -noecho {/bin/a gy}");
    // `interact` returns EXPECT's status, not the vendor's, so the script must
    // wait on the child and exit with what it exited with — otherwise a login
    // the vendor REJECTED is recorded as a successful one.
    expect(script).toContain("catch {wait} r");
    expect(script).toContain("exit [lindex $r 3]");
    // A word Tcl braces cannot carry is REFUSED, never escaped into a
    // different command than the manifest digest sealed.
    expect(
      await resolvePtyWrappedCommand("/bin/a{gy", [], {
        platform: "darwin",
        inspectExecutable: inspectExpect,
      }),
    ).toMatchObject({
      status: "unsupported",
      errorCode: "terminal_transport_unsupported",
    });
    // No tty helper at all: a typed refusal, never a login that cannot finish.
    expect(
      await resolvePtyWrappedCommand("/bin/agy", [], {
        platform: "darwin",
        inspectExecutable: async () => "missing",
      }),
    ).toMatchObject({
      status: "unavailable",
      errorCode: "terminal_transport_unavailable",
    });
  });

  it("propagates the vendor's own exit status through the terminal helper", async () => {
    // The defect this closes: every failed agy sign-in was recorded as a
    // success because `interact` reports the wrapper's status.
    const probe = join(root, "exitprobe.sh");
    mkdirSync(root, { recursive: true });
    writeFileSync(probe, "#!/bin/bash\n[ -t 0 ] || exit 3\nexit ${1:-0}\n", { mode: 0o700 });
    const run = async (code: string): Promise<number | null> => {
      const wrapped = await resolvePtyWrappedCommand(probe, [code]);
      if (wrapped.status !== "ready") throw new Error("host expect transport unavailable");
      const child = spawn(wrapped.command.binary, wrapped.command.args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout.resume();
      child.stderr.resume();
      return new Promise((resolve) => child.once("exit", resolve));
    };
    expect(await run("0")).toBe(0);
    expect(await run("42")).toBe(42);
  }, 20_000);

  it("gives the vendor a real tty so its URL is disclosed and the pasted code lands", async () => {
    const script = [
      "#!/bin/bash",
      // The vendor's own refusal: no tty on stdin, no URL, nonzero exit.
      'if [ ! -t 0 ]; then echo "authentication required. Run to log in"; exit 7; fi',
      'echo "Sign in at https://accounts.google.com/o/oauth2/auth?state=agy1"',
      "IFS= read -r -t 8 line || exit 3",
      'printf "%s" "$line" > "$(dirname "$0")/received.txt"',
      "exit 0",
      "",
    ].join("\n");
    // agy has NO default credential store, so its login MUST target a named
    // profile HOME — the same refusal the CLI route enforces.
    const profileHome = join(root, "profiles", "agy-work");
    mkdirSync(profileHome, { recursive: true, mode: 0o700 });
    const { jobDir, manifestPath, spec } = prepareTerminalLogin(
      script,
      "agy",
      "url_disclosure_with_input",
      true,
      profileHome,
    );
    const workerDone = runWorker(manifestPath, join(root, "native"));
    const deadline = Date.now() + 8_000;
    for (;;) {
      const disclosure = readRunnerDeviceCode(join(jobDir, "runner-devicecode.json"));
      if (disclosure) {
        expect(disclosure.flow).toBe("oauth_url_input");
        expect(disclosure.verificationUrl).toContain("accounts.google.com");
        break;
      }
      if (Date.now() > deadline) throw new Error("disclosure sidecar never appeared");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    atomicPrivateJson(join(jobDir, "runner-input.json"), {
      version: SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: spec.jobId,
      executionId: spec.executionId,
      value: "agy-oauth-code-9",
      submittedAt: new Date().toISOString(),
    });
    expect(await workerDone).toBe(0);
    expect(readFileSync(join(jobDir, "received.txt"), "utf8").trim()).toBe("agy-oauth-code-9");
    // The terminal ECHOES what we write, so the code comes back on the tee'd
    // output — it must never survive into the durable receipt.
    expect(readFileSync(join(jobDir, "runner-result.json"), "utf8")).not.toContain(
      "agy-oauth-code-9",
    );
  }, 20_000);
});
