import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trustConfigPath } from "@claudexor/config";
import { parseArgs } from "./args.js";
import { trustCommand } from "./trust-command.js";

describe("claudexor trust", () => {
  let configDir: string;
  let prevConfigDir: string | undefined;
  const out: string[] = [];
  let restoreStdout: (() => void) | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "claudexor-trust-test-"));
    prevConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    out.length = 0;
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    restoreStdout = () => {
      process.stdout.write = original;
    };
  });

  afterEach(() => {
    restoreStdout?.();
    if (prevConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prevConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  function jsonOut(): Record<string, unknown> {
    return JSON.parse(out.join("")) as Record<string, unknown>;
  }

  it("shows the resolved trust path and defaults before any write", async () => {
    const code = await trustCommand(parseArgs([]), true);
    expect(code).toBe(0);
    const res = jsonOut();
    expect(res["path"]).toBe(trustConfigPath(process.cwd()));
    expect((res["trust"] as Record<string, unknown>)["allow_full_access"]).toBe(false);
  });

  it("writes allow-full-access, persists it, and revoke flips it back", async () => {
    expect(await trustCommand(parseArgs(["--allow-full-access"]), true)).toBe(0);
    const written = readFileSync(trustConfigPath(process.cwd()), "utf8");
    expect(written).toContain("allow_full_access: true");
    out.length = 0;
    expect(await trustCommand(parseArgs(["--revoke-full-access"]), true)).toBe(0);
    expect((jsonOut()["trust"] as Record<string, unknown>)["allow_full_access"]).toBe(false);
  });

  it("accepts only readonly|workspace_write as access-default (full must stay per-run)", async () => {
    expect(await trustCommand(parseArgs(["--access-default", "readonly"]), true)).toBe(0);
    expect((jsonOut()["trust"] as Record<string, unknown>)["access_default"]).toBe("readonly");
    out.length = 0;
    expect(await trustCommand(parseArgs(["--access-default", "full"]), true)).toBe(1);
    expect(String(jsonOut()["error"])).toContain("readonly|workspace_write");
  });

  it("rejects allow+revoke together", async () => {
    expect(
      await trustCommand(parseArgs(["--allow-full-access", "--revoke-full-access"]), true),
    ).toBe(1);
    expect(String(jsonOut()["error"])).toContain("mutually exclusive");
  });
});
