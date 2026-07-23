import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureToken } from "@claudexor/daemon";
import { parseArgs } from "./args.js";
import { daemonCommand } from "./ops-commands.js";

/** Capture the single JSON object printed on stdout across an async command. */
async function captureJson(fn: () => Promise<number>): Promise<{
  code: number;
  env: Record<string, unknown>;
}> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  let code = -1;
  try {
    code = await fn();
  } finally {
    spy.mockRestore();
  }
  expect(chunks).toHaveLength(1);
  return { code, env: JSON.parse(chunks[0] as string) as Record<string, unknown> };
}

describe("ops-commands: ad-hoc failure envelopes route through the ONE projector (Ф2)", () => {
  let configDir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    // Hermetic: an empty config dir means no daemon token on disk.
    configDir = realpathSync(mkdtempSync(join(tmpdir(), "clawdexor-ops-")));
    prevConfigDir = process.env["CLAUDEXOR_CONFIG_DIR"];
    process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
    else process.env["CLAUDEXOR_CONFIG_DIR"] = prevConfigDir;
    rmSync(configDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("`daemon status` with no token yields the canonical {ok,exitCode,message,error} envelope", async () => {
    const { code, env } = await captureJson(() =>
      daemonCommand(parseArgs(["daemon", "status"]), true),
    );
    expect(code).toBe(1);
    // Previously this was a message-less {ok:false,error} straggler; the projector
    // now guarantees the full canonical shape.
    expect(env["ok"]).toBe(false);
    expect(env["exitCode"]).toBe(1);
    expect(env["message"]).toContain("daemon not initialized");
    // Legacy alias preserved for existing consumers.
    expect(env["error"]).toBe(env["message"]);
  });

  it("`daemon bogus` (unknown subcommand) is a usage failure, exit 2, via the projector", async () => {
    // Seed a token so the switch reaches the usage default rather than the
    // no-token branch (a constructed DaemonClient makes no network call here).
    ensureToken();
    const { code, env } = await captureJson(() =>
      daemonCommand(parseArgs(["daemon", "bogus"]), true),
    );
    expect(code).toBe(2);
    expect(env["ok"]).toBe(false);
    expect(env["exitCode"]).toBe(2);
    expect(String(env["message"])).toContain("usage: claudexor daemon");
    expect(env["error"]).toBe(env["message"]);
  });
});
