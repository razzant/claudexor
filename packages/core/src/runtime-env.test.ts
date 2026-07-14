import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizedHarnessPath, resolveHarnessBinary } from "./runtime-env.js";

describe("resolveHarnessBinary", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "runtime-env-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function fakeBin(dir: string, name: string): string {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
    return p;
  }

  it("resolves through the SAME normalized PATH the spawn layer composes (managed shim dir wins)", () => {
    // The live incident this guards: ~/.claudexor/node/bin/<bin> (first
    // preferred entry) shadowing a newer install later on PATH — doctor must
    // report the shim path that harness children will actually execute.
    const home = join(root, "home");
    const shimDir = join(home, ".claudexor", "node", "bin");
    const laterDir = join(root, "later");
    const shim = fakeBin(shimDir, "codex-x");
    fakeBin(laterDir, "codex-x");
    const env = { HOME: home, PATH: laterDir } as NodeJS.ProcessEnv;
    expect(normalizedHarnessPath(env).split(delimiter)[0]).toBe(shimDir);
    expect(resolveHarnessBinary("codex-x", env)).toBe(shim);
  });

  it("falls back to inherited PATH entries and returns null when absent", () => {
    const home = join(root, "home2");
    const onlyDir = join(root, "only");
    const bin = fakeBin(onlyDir, "claude-x");
    const env = { HOME: home, PATH: onlyDir } as NodeJS.ProcessEnv;
    expect(resolveHarnessBinary("claude-x", env)).toBe(bin);
    expect(resolveHarnessBinary("missing-bin", env)).toBeNull();
  });

  it("passes absolute paths through only when they exist", () => {
    const abs = fakeBin(join(root, "abs"), "tool");
    expect(resolveHarnessBinary(abs, { HOME: root, PATH: "" } as NodeJS.ProcessEnv)).toBe(abs);
    expect(
      resolveHarnessBinary(join(root, "abs", "nope"), {
        HOME: root,
        PATH: "",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("splits and joins PATH with the platform delimiter", () => {
    const home = join(root, "home3");
    const a = join(root, "a");
    const b = join(root, "b");
    const target = fakeBin(b, "tool-b");
    mkdirSync(a, { recursive: true });
    const env = { HOME: home, PATH: [a, b].join(delimiter) } as NodeJS.ProcessEnv;
    expect(resolveHarnessBinary("tool-b", env)).toBe(target);
  });

  it("skips non-executable files and directories shadowing the name (spawn-faithful)", () => {
    const home = join(root, "home4");
    const shadowDir = join(root, "shadow");
    const realDir = join(root, "real");
    // A directory named like the binary, then a chmod-x file — neither is spawnable.
    mkdirSync(join(shadowDir, "tool-c"), { recursive: true });
    mkdirSync(realDir, { recursive: true });
    const nonExec = join(realDir, "tool-d");
    writeFileSync(nonExec, "#!/bin/sh\nexit 0\n");
    chmodSync(nonExec, 0o644);
    const target = fakeBin(realDir, "tool-c");
    const env = { HOME: home, PATH: [shadowDir, realDir].join(delimiter) } as NodeJS.ProcessEnv;
    expect(resolveHarnessBinary("tool-c", env)).toBe(target);
    if (process.platform !== "win32") {
      expect(resolveHarnessBinary("tool-d", env)).toBeNull();
    }
  });
});
