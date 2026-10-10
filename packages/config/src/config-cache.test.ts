import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigParseError, loadConfig, loadConfigCached } from "./index.js";

let dir = "";
let repo = "";
let globalFile = "";
const saved: Record<string, string | undefined> = {};
const ENV = ["CLAUDEXOR_CONFIG_DIR", "CLAUDEXOR_MAX_CONCURRENT"] as const;

beforeEach(() => {
  for (const name of ENV) saved[name] = process.env[name];
  dir = mkdtempSync(join(tmpdir(), "claudexor-config-cache-"));
  repo = join(dir, "repo");
  mkdirSync(join(repo, ".claudexor"), { recursive: true });
  mkdirSync(join(dir, "home"));
  process.env.CLAUDEXOR_CONFIG_DIR = join(dir, "home");
  delete process.env.CLAUDEXOR_MAX_CONCURRENT;
  globalFile = join(dir, "home", "config.yaml");
});
afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Count real parses through the cache's loader seam. */
function counted() {
  const calls = { n: 0 };
  return {
    calls,
    load: (root: string) => {
      calls.n += 1;
      return loadConfig(root);
    },
  };
}

describe("loadConfigCached", () => {
  it("parses once while the sources are unchanged and hands every caller a private copy", () => {
    writeFileSync(globalFile, "routing:\n  primary_harness: codex\n");
    const { calls, load } = counted();
    const first = loadConfigCached(repo, load);
    const results = [1, 2, 3, 4].map(() => loadConfigCached(repo, load));
    expect(calls.n).toBe(1);
    for (const result of results) expect(result).toEqual(loadConfig(repo));
    // A caller mutating its copy cannot change what the next caller sees.
    first.global.routing.primary_harness = "claude";
    results[0]!.global.credential_profiles.push({} as never);
    expect(loadConfigCached(repo, load)).toEqual(loadConfig(repo));
    expect(calls.n).toBe(1);
  });

  it("parses again when a source file changes identity, appears, or the environment changes", () => {
    writeFileSync(globalFile, "routing:\n  primary_harness: codex\n");
    const { calls, load } = counted();
    loadConfigCached(repo, load);
    // An atomic replace (the settings writer's tmp + rename).
    writeFileSync(`${globalFile}.tmp`, "routing:\n  primary_harness: claude\n");
    renameSync(`${globalFile}.tmp`, globalFile);
    expect(loadConfigCached(repo, load).global.routing.primary_harness).toBe("claude");
    expect(calls.n).toBe(2);
    // A same-size in-place rewrite with a later modification time.
    writeFileSync(globalFile, "routing:\n  primary_harness: cursor\n");
    utimesSync(globalFile, new Date(), new Date(Date.now() + 60_000));
    expect(loadConfigCached(repo, load).global.routing.primary_harness).toBe("cursor");
    expect(calls.n).toBe(3);
    // A project file appearing, then an environment override.
    writeFileSync(join(repo, ".claudexor", "config.yaml"), "version: 1\n");
    loadConfigCached(repo, load);
    expect(calls.n).toBe(4);
    process.env.CLAUDEXOR_MAX_CONCURRENT = "3";
    expect(loadConfigCached(repo, load).global.runtime.max_concurrent).toBe(3);
    expect(calls.n).toBe(5);
    loadConfigCached(repo, load);
    expect(calls.n).toBe(5);
  });

  it("never caches an answer that lost an existing source to a read error", () => {
    writeFileSync(globalFile, "routing:\n  primary_harness: codex\n");
    const calls = { n: 0 };
    // The first load sees the file but cannot read it (EMFILE in production): loadConfig
    // then answers defaults without the source. The identity does not change afterwards.
    const load = (root: string) => {
      calls.n += 1;
      const config = loadConfig(root);
      if (calls.n > 1) return config;
      const routing = { ...config.global.routing, primary_harness: "claude" as const };
      return { ...config, global: { ...config.global, routing }, sources: [] };
    };
    expect(loadConfigCached(repo, load).global.routing.primary_harness).toBe("claude");
    expect(loadConfigCached(repo, load).global.routing.primary_harness).toBe("codex");
    expect(calls.n).toBe(2);
    // Once a load read every source, the answer is cached as before.
    expect(loadConfigCached(repo, load).global.routing.primary_harness).toBe("codex");
    expect(calls.n).toBe(2);
  });

  it("keeps caching a source that reads as no YAML value", () => {
    for (const body of ["\n", "   \n", "# only a comment\n", "null\n"]) {
      writeFileSync(globalFile, body);
      const { calls, load } = counted();
      loadConfigCached(repo, load);
      loadConfigCached(repo, load);
      expect(calls.n).toBe(1);
    }
  });

  it("never caches a failed parse", () => {
    writeFileSync(globalFile, "routing: [unterminated\n");
    const { calls, load } = counted();
    expect(() => loadConfigCached(repo, load)).toThrow(ConfigParseError);
    expect(() => loadConfigCached(repo, load)).toThrow(ConfigParseError);
    expect(calls.n).toBe(2);
  });
});
