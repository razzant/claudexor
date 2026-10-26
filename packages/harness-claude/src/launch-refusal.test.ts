/**
 * Claude consumers of a refused Windows launch. Version, help, doctor,
 * discovery and auth-status run the production resolve-and-spawn chain against
 * a standard npm install whose declared `claude.exe` is a placeholder script.
 * The observer records every spawn and lets none start, so a run against code
 * without the refusal never executes the placeholder bytes either. A relative
 * PATH entry must give the help memo and a run the same binary.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const observer = vi.hoisted(() => ({ attempts: [] as string[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = (file: string): never => {
    observer.attempts.push(file);
    throw Object.assign(new Error(`spawn observer blocked ${file}`), { code: "EOBSERVED" });
  };
  return { ...actual, spawn };
});

// The real npm cmd-shim bytes for a native and a Node bin, retargeted at Claude's package.
const nativeShim = fileURLToPath(
  new URL("../../core/src/fixtures/npm-launch/native.cmd", import.meta.url),
);
const nodeShim = fileURLToPath(
  new URL("../../core/src/fixtures/npm-launch/node.cmd", import.meta.url),
);
const PLACEHOLDER = 'echo "Error: claude native binary not installed." >&2\r\nexit 1\r\n';

function image(): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ", 0, "latin1");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "latin1");
  bytes.writeUInt16LE(0x8664, 0x84);
  return bytes;
}

let root: string;
let prefix: string;
let target: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "claude launch refusal ")));
  prefix = join(root, "npm");
  const packageRoot = join(prefix, "node_modules", "@anthropic-ai", "claude-code");
  target = join(packageRoot, "bin", "claude.exe");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, PLACEHOLDER);
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: "bin/claude.exe" } }),
  );
  writeFileSync(
    join(prefix, "claude.cmd"),
    readFileSync(nativeShim, "utf8")
      .replace("@fixture\\tool\\bin\\tool.exe", "@anthropic-ai\\claude-code\\bin\\claude.exe")
      .replace(/\r?\n/g, "\r\n"),
  );
  observer.attempts.length = 0;
  // BIN and the probe memos are module state: load them fresh for each case.
  vi.resetModules();
  vi.stubEnv("CLAUDEXOR_CLAUDE_BIN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** The resolver and spawn layer read `process.platform`; report win32 during `run`. */
async function onWindows<T>(run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: "win32" });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

/** The refusal leads with the refused file and the verdict. */
function refusalOf(file: string, via?: string): string {
  return `Cannot launch ${file}: it is not a Windows executable image${via ? ` (run by ${via})` : ""}`;
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("Claude consumers of a placeholder claude.exe", () => {
  it("version and help probes refuse before spawning, then recover once the file is replaced", async () => {
    const { detectClaudeVersion, probeClaudeHelp } = await import("./effort-probe.js");
    await onWindows(async () => {
      expect(await detectClaudeVersion(undefined, prefix)).toBeNull();
      expect(await probeClaudeHelp(undefined, prefix)).toMatchObject({
        ok: false,
        error: expect.stringContaining(refusalOf(target, join(prefix, "claude.cmd"))),
      });
    });
    expect(observer.attempts).toEqual([]);
    writeFileSync(target, image());
    await onWindows(() => detectClaudeVersion(undefined, prefix));
    expect(observer.attempts).toEqual([target]);
  });

  it("probes a healthy later install instead of an earlier placeholder", async () => {
    writeFileSync(target, image());
    const local = join(root, "local", "claude.exe");
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, PLACEHOLDER);
    const { detectClaudeVersion } = await import("./effort-probe.js");
    await onWindows(() => detectClaudeVersion(undefined, [dirname(local), prefix].join(delimiter)));
    expect(observer.attempts).toEqual([target]);
  });

  it("doctor names the unlaunchable file instead of reporting claude as not found", async () => {
    const { createClaudeAdapter } = await import("./index.js");
    const report = await onWindows(() =>
      createClaudeAdapter().doctor({ cwd: root, env: { PATH: prefix } }),
    );
    expect(report.status).toBe("unavailable");
    const installed = report.checks.find((check) => check.id === "installed");
    expect(installed).toMatchObject({
      status: "fail",
      detail: expect.stringContaining(refusalOf(target, join(prefix, "claude.cmd"))),
    });
    expect(installed?.detail).not.toContain("not found");
    expect(report.reasons).toEqual([
      expect.stringContaining(refusalOf(target, join(prefix, "claude.cmd"))),
    ]);
    expect(observer.attempts).toEqual([]);
  });

  it("discovery reports an explicit override's refusal without choosing another install", async () => {
    const chosen = join(root, "chosen", "claude.exe");
    mkdirSync(dirname(chosen), { recursive: true });
    writeFileSync(chosen, PLACEHOLDER);
    vi.stubEnv("CLAUDEXOR_CLAUDE_BIN", chosen);
    const { createClaudeAdapter } = await import("./index.js");
    const error = await onWindows(() =>
      createClaudeAdapter()
        .discover()
        .then(
          () => null,
          (failure: unknown) => failure,
        ),
    );
    expect(error).toMatchObject({
      message: expect.stringContaining(refusalOf(chosen)),
    });
    expect((error as Error).message).not.toContain("not found");
    expect(observer.attempts).toEqual([]);
  });

  it("auth-status neither retries nor serves last-known-good for the refusal", async () => {
    const { probeAuthStatus } = await import("./index.js");
    const { runCapture } = await import("@claudexor/core");
    let calls = 0;
    const counted: typeof runCapture = async (...args) => {
      calls += 1;
      return calls === 1
        ? {
            code: 0,
            signal: null,
            stdout: '{"loggedIn":true,"authMethod":"claude.ai"}',
            stderr: "",
          }
        : runCapture(...args);
    };
    const options = {
      env: { PATH: prefix },
      configDir: join(root, "profile"),
      runCapture: counted,
    };
    await onWindows(async () => {
      expect(await probeAuthStatus("claude", options)).toMatchObject({ authed: true });
      const refused = await probeAuthStatus("claude", options);
      expect(refused.stale).toBeUndefined();
      // Thrown auth details keep their existing 300-character bound; the refused file leads.
      expect(refused).toMatchObject({
        authed: false,
        probeError: expect.stringMatching(new RegExp(`^${escaped(refusalOf(target))}`)),
      });
      expect(refused.probeError?.length).toBeLessThanOrEqual(300);
    });
    expect(calls).toBe(2);
    expect(observer.attempts).toEqual([]);
  });

  it("auth names a broken interpreter inside its 300-character bound on long Windows paths", async () => {
    // The hosted runner's temp root and an npm prefix with a space, as on Windows.
    const deep = join(root, "Users", "RUNNER~1", "AppData", "Local", "Temp");
    const npm = join(deep, "cx-win-qualification-e6Aa86", "bad-interpreter", "npm prefix");
    const script = join(npm, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, "#!/usr/bin/env node\n");
    writeFileSync(
      join(dirname(script), "package.json"),
      JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: "cli.js" } }),
    );
    writeFileSync(
      join(npm, "claude.cmd"),
      readFileSync(nodeShim, "utf8")
        .replace("@fixture\\tool\\bin\\tool.cjs", "@anthropic-ai\\claude-code\\cli.js")
        .replace(/\r?\n/g, "\r\n"),
    );
    const node = join(npm, "node.exe");
    writeFileSync(node, PLACEHOLDER);
    const { probeAuthStatus } = await import("./index.js");
    const probe = await onWindows(() =>
      probeAuthStatus("claude", { env: { PATH: npm }, configDir: join(root, "profile") }),
    );
    expect(probe.probeError?.length).toBeLessThanOrEqual(300);
    expect(probe.probeError).toContain(refusalOf(node));
    expect(observer.attempts).toEqual([]);
  });
});

describe("a relative PATH entry", () => {
  it("resolves to the same binary for the help memo and for a run in a project cwd", async () => {
    const name = process.platform === "win32" ? "claude.exe" : "claude";
    const bytes = process.platform === "win32" ? image() : "#!/bin/sh\nexit 0\n";
    const daemon = join(root, "daemon");
    const work = join(root, "work");
    const fallback = join(root, "fallback", name);
    // An older project-local CLI the probes never read, and the install they do.
    for (const path of [join(work, "bin", name), fallback]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes, { mode: 0o755 });
    }
    mkdirSync(daemon);
    vi.spyOn(process, "cwd").mockReturnValue(daemon);
    const path = ["bin", dirname(fallback)].join(delimiter);
    const { probeClaudeHelp } = await import("./effort-probe.js");
    const { runCapture } = await import("@claudexor/core");
    await probeClaudeHelp(undefined, path);
    await runCapture("claude", ["--help"], { env: { PATH: path }, cwd: work }).catch(() => null);
    expect(observer.attempts).toEqual([fallback, fallback]);
  });
});
