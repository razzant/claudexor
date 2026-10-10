import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import {
  dispatchClaudexordEntry,
  isBeltServeInvocation,
  runIfDirectEntry,
} from "./claudexord-entry.js";

const reapDirs: string[] = [];
afterAll(() => {
  for (const dir of reapDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("claudexord belt self-entry", () => {
  it("dispatches only the exact mcp serve-belt invocation", () => {
    expect(isBeltServeInvocation(["mcp", "serve-belt"])).toBe(true);
    expect(isBeltServeInvocation([])).toBe(false);
    expect(isBeltServeInvocation(["mcp", "serve"])).toBe(false);
    expect(isBeltServeInvocation(["--probe", "mcp", "serve-belt"])).toBe(false);
  });

  it("reserves every setup shape for the shared attach owner and never starts the daemon", async () => {
    const previousExitCode = process.exitCode;
    const seen: string[][] = [];
    let daemonStarts = 0;
    let beltStarts = 0;
    try {
      process.exitCode = undefined;
      await dispatchClaudexordEntry(
        async () => {
          daemonStarts += 1;
        },
        ["setup", "invalid"],
        {
          setupAttach: async (argv) => {
            seen.push([...argv]);
            return 2;
          },
          beltServe: async () => {
            beltStarts += 1;
            return false;
          },
        },
      );
      expect(seen).toEqual([["setup", "invalid"]]);
      expect(process.exitCode).toBe(2);
      expect(daemonStarts).toBe(0);
      expect(beltStarts).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("consumes malformed first-token probe input as usage without starting the daemon", async () => {
    const previousExitCode = process.exitCode;
    const stderr: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((value: unknown) => {
      stderr.push(String(value));
      return true;
    });
    let daemonStarts = 0;
    let setupStarts = 0;
    let beltStarts = 0;
    try {
      process.exitCode = undefined;
      await dispatchClaudexordEntry(
        async () => {
          daemonStarts += 1;
        },
        ["--probe", "setup"],
        {
          setupAttach: async () => {
            setupStarts += 1;
            return 0;
          },
          beltServe: async () => {
            beltStarts += 1;
            return false;
          },
        },
      );
      expect(process.exitCode).toBe(2);
      expect(stderr.join("")).toContain("usage: claudexord --probe");
      expect(daemonStarts).toBe(0);
      expect(setupStarts).toBe(0);
      expect(beltStarts).toBe(0);
    } finally {
      write.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  it("dispatches through a filesystem alias to the same packaged entry", () => {
    const root = mkdtempSync(join(realpathSync("/tmp"), "cx-entry-alias-"));
    reapDirs.push(root);
    const realDir = join(root, "real");
    const aliasDir = join(root, "alias");
    mkdirSync(realDir);
    symlinkSync(realDir, aliasDir);
    const entryPath = join(realDir, "claudexord.bundle.cjs");
    writeFileSync(entryPath, "// entry\n");
    let calls = 0;
    runIfDirectEntry(
      pathToFileURL(entryPath).href,
      () => {
        calls += 1;
      },
      [process.execPath, join(aliasDir, "claudexord.bundle.cjs")],
    );
    expect(calls).toBe(1);

    const foreignDir = join(root, "foreign");
    mkdirSync(foreignDir);
    const foreignPath = join(foreignDir, "claudexord.bundle.cjs");
    writeFileSync(foreignPath, "// foreign\n");
    runIfDirectEntry(
      pathToFileURL(entryPath).href,
      () => {
        calls += 1;
      },
      [process.execPath, foreignPath],
    );
    runIfDirectEntry(
      pathToFileURL(entryPath).href,
      () => {
        calls += 1;
      },
      [process.execPath, join(aliasDir, "missing.cjs")],
    );
    expect(calls).toBe(1);
  });

  it("never treats a worker thread as the direct entry, whatever argv says", () => {
    const root = mkdtempSync(join(realpathSync("/tmp"), "cx-entry-worker-"));
    reapDirs.push(root);
    const entryPath = join(root, "claudexord.bundle.cjs");
    writeFileSync(entryPath, "// entry\n");
    let calls = 0;
    runIfDirectEntry(
      pathToFileURL(entryPath).href,
      () => void (calls += 1),
      [process.execPath, entryPath],
      false,
    );
    expect(calls).toBe(0);
    runIfDirectEntry(
      pathToFileURL(entryPath).href,
      () => void (calls += 1),
      [process.execPath, entryPath],
      true,
    );
    expect(calls).toBe(1);
  });

  it("serves from the built entry and roundtrips its packaged parent daemon", () => {
    const daemonEntry = resolve(import.meta.dirname, "../dist/claudexord.js");
    expect(
      existsSync(daemonEntry),
      `built daemon entry missing at ${daemonEntry}; run pnpm build before this test`,
    ).toBe(true);

    const home = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "cx-belt-")));
    reapDirs.push(home);
    const configRoot = join(home, "config");
    const smoke = resolve(import.meta.dirname, "../../../scripts/smoke-delegation-belt-entry.mjs");
    const output = execFileSync(
      process.execPath,
      [smoke, "--node", process.execPath, "--entry", daemonEntry, "--config-root", configRoot],
      {
        encoding: "utf8",
        timeout: 20_000,
        env: {
          HOME: home,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CLAUDEXOR_PLUGIN_VERSION: CLAUDEXOR_VERSION,
          CLAUDEXOR_ROOT_MODE: "explicit",
        },
      },
    );
    expect(output.trim()).toBe("delegation belt protocol smoke passed");
    expect(existsSync(configRoot)).toBe(false);
  });
});
