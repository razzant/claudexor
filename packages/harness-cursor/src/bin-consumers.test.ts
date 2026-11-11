import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { resolveHarnessBinary, type CliRunLoopOptions, type runCapture } from "@claudexor/core";
import { probeCursorNativeAuth } from "./auth.js";
import { createCursorAdapter } from "./index.js";
import { smokeIsolatedApiKey } from "./smoke.js";

/**
 * Every Cursor consumer spawns what `resolveCursorBin` decided, on the real
 * harness PATH, with hermetic executables: a fake Cursor install under a
 * temporary HOME and an unrelated `agent` that leaves a marker if it ever runs.
 * The host's own commands never answer: the suite stands down when the host
 * has either name outside HOME. It also stands down on Windows: the fixtures
 * are `#!/bin/sh` scripts behind the installer's symlinks, which a Windows
 * child cannot execute. The Windows install is covered by the resolution
 * refusal in `bin.test.ts`.
 */
const roots: string[] = [];
const saved = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  CLAUDEXOR_CURSOR_BIN: process.env.CLAUDEXOR_CURSOR_BIN,
};
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function script(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
function link(target: string, path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  return path;
}

interface Host {
  home: string;
  /** Absolute path a correct consumer spawns for Cursor, if any. */
  launcher: string;
  /** Written by the unrelated `agent` if anything ever executes it. */
  marker: string;
  /** The inherited PATH entry. */
  inherited: string;
}

/**
 * `cursorFirst`: the installer layout under HOME (`~/.local/bin/agent` into
 * `versions/<v>/cursor-agent`, plus a `cursor-agent` link an update left
 * dangling) and an unrelated `agent` on the inherited PATH.
 * `unrelatedFirst`: an unrelated `~/.local/bin/agent`, which the harness PATH
 * ranks ahead of an inherited-PATH `agent` that does resolve into Cursor.
 */
function stage(layout: "cursorFirst" | "unrelatedFirst"): Host {
  const home = mkdtempSync(join(tmpdir(), "cursor-consumers-"));
  roots.push(home);
  const marker = join(home, "unrelated-agent-ran");
  const inherited = join(home, "inherited", "bin");
  const install = join(home, ".local", "share", "cursor-agent", "versions");
  const cursor = script(
    join(install, "1.0", "cursor-agent"),
    [
      'if [ "$1" = "--disable-auto-update" ]; then shift; fi',
      'case "$1" in',
      '  --version) echo "fixture-cursor 1.0" ;;',
      '  --list-models) echo "fixture-model - Fixture Model" ;;',
      "esac",
      "exit 0",
    ].join("\n"),
  );
  const unrelated = (path: string) => script(path, `echo ran > "${marker}"\nexit 0`);
  let launcher: string;
  if (layout === "cursorFirst") {
    launcher = link(cursor, join(home, ".local", "bin", "agent"));
    link(join(install, "0.9", "cursor-agent"), join(home, ".local", "bin", "cursor-agent"));
    unrelated(join(inherited, "agent"));
  } else {
    unrelated(join(home, ".local", "bin", "agent"));
    launcher = link(cursor, join(inherited, "agent"));
  }
  process.env.HOME = home;
  process.env.PATH = inherited;
  delete process.env.CLAUDEXOR_CURSOR_BIN;
  return { home, launcher, marker, inherited };
}

const emptyHome = mkdtempSync(join(tmpdir(), "cursor-consumers-host-"));
const standDown =
  process.platform === "win32" ||
  ["cursor-agent", "agent"].some(
    (name) => resolveHarnessBinary(name, { HOME: emptyHome, PATH: "" }) !== null,
  );
rmSync(emptyHome, { recursive: true, force: true });

const noKey = { cursorApiKey: () => null };

describe.skipIf(standDown)("Cursor consumers resolve the CLI through one lookup", () => {
  it("discover and doctor execute the verified Cursor agent, never an unrelated one", async () => {
    const host = stage("cursorFirst");
    const adapter = createCursorAdapter(noKey);
    expect((await adapter.discover()).version).toBe("fixture-cursor 1.0");
    const report = await adapter.doctor({ cwd: host.home });
    expect(report.checks.find((check) => check.id === "installed")).toMatchObject({
      status: "pass",
      detail: "fixture-cursor 1.0",
    });
    expect(existsSync(host.marker)).toBe(false);
  });

  it("sees an install that appears after the adapter was created, without a restart", async () => {
    const empty = mkdtempSync(join(tmpdir(), "cursor-consumers-empty-"));
    roots.push(empty);
    process.env.HOME = empty;
    process.env.PATH = "";
    delete process.env.CLAUDEXOR_CURSOR_BIN;
    const adapter = createCursorAdapter(noKey);
    await expect(adapter.discover()).rejects.toThrow(/Cursor CLI not found/);
    const host = stage("cursorFirst");
    expect((await adapter.discover()).version).toBe("fixture-cursor 1.0");
    expect(existsSync(host.marker)).toBe(false);
  });

  it("refuses when the agent the child would run is not Cursor, and runs nothing", async () => {
    const host = stage("unrelatedFirst");
    const adapter = createCursorAdapter(noKey);
    await expect(adapter.discover()).rejects.toThrow(/Cursor CLI not found/);
    const report = await adapter.doctor({ cwd: host.home });
    expect(report.status).toBe("unavailable");
    expect(report.reasons.join("\n")).toContain("no `agent` inside a Cursor install");
    expect(existsSync(host.marker)).toBe(false);
  });

  it("the status probe and the API-key smoke spawn the verified launcher by absolute path", async () => {
    const host = stage("cursorFirst");
    const spawned: string[] = [];
    const capture: typeof runCapture = async (cmd) => {
      spawned.push(cmd);
      return { code: 0, signal: null, stdout: '{"authenticated":false}\n', stderr: "" };
    };
    await probeCursorNativeAuth({ AGENT_CLI_CREDENTIAL_STORE: "file" }, undefined, capture);
    await smokeIsolatedApiKey("fixture-key", { runCapture: capture });
    expect(spawned).toEqual([host.launcher, host.launcher]);
  });

  it("the model listing reads the verified launcher's inventory", async () => {
    // The only `cursor-agent` here is the dangling link, so a listing that
    // still spawned that name would come back empty.
    const host = stage("cursorFirst");
    const models = await createCursorAdapter(noKey).models?.();
    expect(models?.map((model) => model.id)).toEqual(["fixture-model"]);
    expect(existsSync(host.marker)).toBe(false);
  });

  it("a run spawns the verified launcher even when its env patch carries another PATH", async () => {
    // A bare `agent` would be re-resolved on the patch PATH, which leads to
    // the unrelated one; the absolute launcher cannot be.
    const host = stage("cursorFirst");
    let bin: string | undefined;
    const adapter = createCursorAdapter({
      ...noKey,
      nativeAuthOk: async () => ({ kind: "authenticated" }),
      listCursorModels: async () => [],
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        bin = opts.bin;
        yield { type: "completed", session_id: opts.spec.session_id, ts: "2026-01-01T00:00:00Z" };
      },
    });
    const spec = HarnessRunSpec.parse({
      session_id: "s-cursor-bin",
      intent: "review",
      prompt: "review this",
      cwd: host.home,
      env: { AGENT_CLI_CREDENTIAL_STORE: "file", PATH: host.inherited },
    });
    for await (const ev of adapter.run(spec)) void ev;
    expect(bin).toBe(host.launcher);
    expect(existsSync(host.marker)).toBe(false);
  });
});
