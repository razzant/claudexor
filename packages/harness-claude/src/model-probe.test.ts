/**
 * The prompt-free initialize model probe: what it spawns, how it reads the
 * answer, what every consumer gets, and how the (scope, binary identity) cache
 * behaves. Every guard is asserted in BOTH directions and the on-disk cases
 * drive the real spawn against a stub `claude`, because the identity hazard
 * lives between the cache and the file system, not in either alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_SECRET_ENV, type SpawnOptions } from "@claudexor/core";
import type { CredentialProfile } from "@claudexor/schema";
import { nativeHarnessStateRoot } from "@claudexor/util";
import { CLAUDE_KNOWN_MODELS } from "./capability-profile.js";
import { CLAUDE_INIT_REQUEST_ID } from "./interactive.js";
import {
  CLAUDE_MODEL_PROBE_ARGS,
  CLAUDE_MODEL_PROBE_TIMEOUT_MS,
  claudeInitializeFrame,
  claudeModelProbeScope,
  claudeModelRows,
  clearClaudeModelProbeCache,
  parseClaudeInitialize,
  probeClaudeModels,
} from "./model-probe.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/protocol", import.meta.url));

/** The 2.1.280 binary-only capture: ONE raw stdout line. */
const PICKER_2_1_280 = readFileSync(join(FIXTURES, "initialize-picker-2.1.280.jsonl"), "utf8");
/** The API-key handshake recording (2.1.281 since the pin catch-up; see
 * fixtures/manifest.yaml): line 3 is the initialize answer, wrapped as a
 * directional wire frame with a sanitized request id. */
const HANDSHAKE_API_KEY = readFileSync(join(FIXTURES, "control-handshake.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean);
const PICKER_API_KEY_FRAME = (JSON.parse(HANDSHAKE_API_KEY[2] ?? "{}") as { frame: unknown }).frame;
const PICKER_API_KEY = JSON.stringify(PICKER_API_KEY_FRAME) + "\n";
const PICKER_API_KEY_REQUEST_ID = "fixture-id-1";

const HINT_IDS = [...CLAUDE_KNOWN_MODELS];

function capture(
  stdout: string,
  over: Partial<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> = {},
) {
  return { code: 0, signal: null, stdout, stderr: "", ...over };
}

const identity = () => ({ path: "/stub/claude", ino: 7, size: 42, mtimeMs: 1_000 });

/** A fake capture that records every spawn and answers with `stdout`. */
function fakeCapture(stdout: string | (() => Promise<string>)) {
  const calls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }> = [];
  const runCapture = async (cmd: string, args: string[], opts: SpawnOptions = {}) => {
    calls.push({ cmd, args, opts });
    return capture(typeof stdout === "string" ? stdout : await stdout());
  };
  return { calls, runCapture };
}

const ownedTmp = join(process.env.CLAUDEXOR_CONFIG_DIR as string, "model-probe-test");
mkdirSync(ownedTmp, { recursive: true });

function profile(over: Partial<CredentialProfile> = {}): CredentialProfile {
  return {
    profile_id: "work",
    harness_id: "claude",
    display_name: "Work",
    credential_kind: "config_dir_login",
    isolation_locator: join(ownedTmp, "profiles", "work"),
    secret_ref: null,
    enabled: true,
    created_at: null,
    ...over,
  } as CredentialProfile;
}

beforeEach(() => {
  clearClaudeModelProbeCache();
  mkdirSync(join(ownedTmp, "profiles", "work"), { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  clearClaudeModelProbeCache();
});

describe("the probe argv", () => {
  it("never carries --model and always suppresses settings sources and project MCP", () => {
    // The picker echoes `--model X` as a fabricated row and default setting
    // sources fire the user's SessionStart hooks (both live-measured).
    expect(CLAUDE_MODEL_PROBE_ARGS).not.toContain("--model");
    expect(CLAUDE_MODEL_PROBE_ARGS.slice(-3)).toEqual([
      "--setting-sources",
      "",
      "--strict-mcp-config",
    ]);
    expect(CLAUDE_MODEL_PROBE_ARGS.slice(0, 6)).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  it("spawns exactly that argv with the initialize frame on stdin and a 10 s bound", async () => {
    const { calls, runCapture } = fakeCapture(PICKER_2_1_280);
    await probeClaudeModels({ cwd: "/repo" }, { runCapture, binaryIdentity: identity });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("/stub/claude");
    expect(calls[0]?.args).toEqual([...CLAUDE_MODEL_PROBE_ARGS]);
    expect(calls[0]?.args).not.toContain("--model");
    expect(calls[0]?.opts.input).toBe(claudeInitializeFrame());
    expect(JSON.parse(claudeInitializeFrame())).toEqual({
      type: "control_request",
      request_id: CLAUDE_INIT_REQUEST_ID,
      request: { subtype: "initialize" },
    });
    expect(calls[0]?.opts.timeoutMs).toBe(CLAUDE_MODEL_PROBE_TIMEOUT_MS);
    expect(calls[0]?.opts.cancelSignal).toBe("SIGTERM");
    // The capture owns its bound; no caller signal is threaded into the spawn.
    expect(calls[0]?.opts.abortSignal).toBeUndefined();
  });
});

describe("parseClaudeInitialize", () => {
  const hookFrames = [
    JSON.stringify({ type: "system", subtype: "hook_started", hook_name: "SessionStart" }),
    JSON.stringify({ type: "system", subtype: "hook_response", hook_name: "SessionStart" }),
  ];

  it("selects the answer by request id even when hook frames precede it", () => {
    const stdout = [...hookFrames, PICKER_2_1_280.trim()].join("\n") + "\n";
    const answer = parseClaudeInitialize(stdout, CLAUDE_INIT_REQUEST_ID);
    expect(answer?.models.map((m) => m.value)).toEqual([
      "default",
      "opus[1m]",
      "claude-fable-5-1",
      "sonnet",
      "haiku",
    ]);
    // A different request id is not our answer, whatever position it sits at.
    expect(parseClaudeInitialize(stdout, "req_someone_else")).toBeNull();
  });

  it("skips a foreign control_response and still finds ours by id", () => {
    const foreign = JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: "req_other", response: { models: [] } },
    });
    const stdout = `${foreign}\n${PICKER_2_1_280}`;
    expect(parseClaudeInitialize(stdout, CLAUDE_INIT_REQUEST_ID)?.models).toHaveLength(5);
  });

  it("returns null for an error subtype, a missing picker, or no JSON at all", () => {
    const error = JSON.stringify({
      type: "control_response",
      response: { subtype: "error", request_id: CLAUDE_INIT_REQUEST_ID, error: "boom" },
    });
    expect(parseClaudeInitialize(`${error}\n`, CLAUDE_INIT_REQUEST_ID)).toBeNull();
    const noPicker = JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: CLAUDE_INIT_REQUEST_ID, response: {} },
    });
    expect(parseClaudeInitialize(`${noPicker}\n`, CLAUDE_INIT_REQUEST_ID)).toBeNull();
    expect(parseClaudeInitialize("not json at all\n", CLAUDE_INIT_REQUEST_ID)).toBeNull();
    expect(parseClaudeInitialize("", CLAUDE_INIT_REQUEST_ID)).toBeNull();
  });

  it("keeps only rows with a non-blank string value and reads nothing else", () => {
    const frame = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: CLAUDE_INIT_REQUEST_ID,
        response: {
          models: [
            { value: "  ", displayName: "blank" },
            { displayName: "no value" },
            "not a row",
            { value: "sonnet", displayName: 7, resolvedModel: "", description: "Custom model" },
          ],
        },
      },
    });
    expect(parseClaudeInitialize(`${frame}\n`, CLAUDE_INIT_REQUEST_ID)).toEqual({
      models: [{ value: "sonnet", displayName: null, resolvedModel: null }],
    });
  });
});

describe("claudeModelRows", () => {
  it("maps the 2.1.280 binary-only picker to picker rows, resolved rows, then hints", () => {
    const rows = claudeModelRows(parseClaudeInitialize(PICKER_2_1_280, CLAUDE_INIT_REQUEST_ID));
    const live = rows.filter((r) => r.origin === "live");
    expect(live.map((r) => [r.id, r.resolved_model])).toEqual([
      ["default", "claude-opus-5-5[1m]"],
      ["opus[1m]", "claude-opus-5-5[1m]"],
      ["claude-fable-5-1", "claude-fable-5-1"],
      ["sonnet", "claude-sonnet-5"],
      ["haiku", "claude-haiku-4-5-20251001"],
      // Resolutions become pinnable rows of their own (Q7): exact ids, no
      // resolution of their own. `claude-fable-5-1` already IS a picker row.
      ["claude-opus-5-5[1m]", null],
      ["claude-sonnet-5", null],
      ["claude-haiku-4-5-20251001", null],
    ]);
    expect(live.map((r) => r.label)).toEqual([
      "Default (recommended)",
      "Opus (1M context)",
      "Fable",
      "Sonnet",
      "Haiku",
      null,
      null,
      null,
    ]);
    const hints = rows.filter((r) => r.origin === "hint");
    expect(hints.map((r) => r.id)).toEqual([
      "opus",
      "fable",
      "best",
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ]);
    expect(hints.every((r) => r.label === null && r.resolved_model === null)).toBe(true);
    expect(rows.every((r) => r.context_window === null && r.routes === null)).toBe(true);
    // Exact-string dedupe: the union never lists an id twice.
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows).toHaveLength(5 + 3 + 12);
  });

  it("maps the API-key handshake recording (2.1.281: 6 rows incl. sonnet[1m]; haiku without effort fields)", () => {
    const rows = claudeModelRows(parseClaudeInitialize(PICKER_API_KEY, PICKER_API_KEY_REQUEST_ID));
    const live = rows.filter((r) => r.origin === "live");
    expect(live.map((r) => [r.id, r.resolved_model])).toEqual([
      ["default", "claude-opus-5-5[1m]"],
      ["opus[1m]", "claude-opus-5-5[1m]"],
      ["claude-fable-5-1", "claude-fable-5-1"],
      ["sonnet", "claude-sonnet-5"],
      ["sonnet[1m]", "claude-sonnet-5[1m]"],
      ["haiku", "claude-haiku-4-5-20251001"],
      ["claude-opus-5-5[1m]", null],
      ["claude-sonnet-5", null],
      ["claude-sonnet-5[1m]", null],
      ["claude-haiku-4-5-20251001", null],
    ]);
    expect(rows.filter((r) => r.origin === "hint").map((r) => r.id)).toEqual([
      "opus",
      "fable",
      "best",
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ]);
    expect(rows).toHaveLength(6 + 4 + 12);
  });

  it("with no answer yields exactly the frozen hint list, all origin hint, never empty", () => {
    const rows = claudeModelRows(null);
    expect(rows.map((r) => r.id)).toEqual(HINT_IDS);
    expect(rows.every((r) => r.origin === "hint" && r.resolved_model === null)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("probeClaudeModels failure paths answer the hint rows only", () => {
  const hintsOnly = claudeModelRows(null);

  it("ENOENT / spawn error", async () => {
    const runCapture = async () => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    };
    await expect(
      probeClaudeModels({ cwd: "/repo" }, { runCapture, binaryIdentity: identity }),
    ).resolves.toEqual(hintsOnly);
  });

  it("binary not resolvable at all (no spawn attempted)", async () => {
    const { calls, runCapture } = fakeCapture(PICKER_2_1_280);
    await expect(
      probeClaudeModels({ cwd: "/repo" }, { runCapture, binaryIdentity: () => null }),
    ).resolves.toEqual(hintsOnly);
    expect(calls).toHaveLength(0);
  });

  it("a signaled child is not a fresh answer even when its stdout parses", async () => {
    const killed = async () => capture(PICKER_2_1_280, { code: null, signal: "SIGKILL" });
    await expect(
      probeClaudeModels({ cwd: "/repo" }, { runCapture: killed, binaryIdentity: identity }),
    ).resolves.toEqual(hintsOnly);
    // The other direction: the SAME bytes with a clean exit are the live rows.
    clearClaudeModelProbeCache();
    const clean = async () => capture(PICKER_2_1_280);
    const rows = await probeClaudeModels(
      { cwd: "/repo" },
      { runCapture: clean, binaryIdentity: identity },
    );
    expect(rows.filter((r) => r.origin === "live")).toHaveLength(8);
  });

  it("non-JSON stdout, an error subtype, and a foreign request id", async () => {
    for (const stdout of [
      "Welcome to Claude Code!\n",
      JSON.stringify({
        type: "control_response",
        response: { subtype: "error", request_id: CLAUDE_INIT_REQUEST_ID, error: "no" },
      }) + "\n",
      PICKER_API_KEY, // request_id fixture-id-1, not ours
    ]) {
      clearClaudeModelProbeCache();
      const { runCapture } = fakeCapture(stdout);
      await expect(
        probeClaudeModels({ cwd: "/repo" }, { runCapture, binaryIdentity: identity }),
      ).resolves.toEqual(hintsOnly);
    }
  });

  it("an env derivation error (profile locator outside the owned root)", async () => {
    const { calls, runCapture } = fakeCapture(PICKER_2_1_280);
    const outside = profile({ isolation_locator: join(tmpdir(), "not-owned", "x") });
    await expect(
      probeClaudeModels(
        { cwd: "/repo", credentialProfile: outside },
        { runCapture, binaryIdentity: identity },
      ),
    ).resolves.toEqual(hintsOnly);
    expect(calls).toHaveLength(0);
  });
});

describe("scope", () => {
  it("keys a config_dir_login profile by its config dir, a credential profile by its id, and no profile as the binary", () => {
    // The scope canonicalises the profile dir (realpath), so the expectation
    // does too: macOS tmp dirs live behind a /private symlink.
    const dir = realpathSync(join(ownedTmp, "profiles", "work"));
    expect(claudeModelProbeScope({ cwd: "/repo", credentialProfile: profile() })).toEqual({
      kind: "profile",
      key: `config:${dir}`,
      configDir: dir,
    });
    expect(claudeModelProbeScope({ cwd: "/repo" })).toEqual({ kind: "binary", key: "binary" });
    expect(claudeModelProbeScope({ cwd: "/repo", authPreference: "subscription" })).toEqual({
      kind: "binary",
      key: "binary",
    });
    // A credential profile is probed AS that account: its own env var, its
    // id as the cache key (never the secret), no config dir of its own.
    expect(
      claudeModelProbeScope({
        cwd: "/repo",
        credentialProfile: profile({ credential_kind: "api_key", secret_ref: "anthropic:work" }),
      }),
    ).toEqual({
      kind: "credential",
      key: "credential:work",
      envKey: "ANTHROPIC_API_KEY",
      secretRef: "anthropic:work",
    });
    expect(
      claudeModelProbeScope({
        cwd: "/repo",
        credentialProfile: profile({
          profile_id: "sub",
          credential_kind: "oauth_token",
          secret_ref: "claude_oauth:sub",
        }),
      }),
    ).toEqual({
      kind: "credential",
      key: "credential:sub",
      envKey: "CLAUDE_CODE_OAUTH_TOKEN",
      secretRef: "claude_oauth:sub",
    });
  });

  it("profile-bound and binary probes never share a cache entry", async () => {
    const { calls, runCapture } = fakeCapture(PICKER_2_1_280);
    const deps = { runCapture, binaryIdentity: identity };
    await probeClaudeModels({ cwd: "/repo", credentialProfile: profile() }, deps);
    await probeClaudeModels({ cwd: "/repo" }, deps);
    expect(calls).toHaveLength(2);
    // Same scope again: served from the cache.
    await probeClaudeModels({ cwd: "/repo", credentialProfile: profile() }, deps);
    await probeClaudeModels({ cwd: "/repo" }, deps);
    expect(calls).toHaveLength(2);
  });

  it("profile-bound env: the profile's CLAUDE_CONFIG_DIR, every provider secret scrubbed, bootstrap allowed", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "placeholder-key-must-not-reach-the-probe");
    vi.stubEnv("ANTHROPIC_MODEL", "bogus-env-model");
    vi.stubEnv("ANTHROPIC_DEFAULT_OPUS_MODEL", "claude-opus-9-9");
    const { calls, runCapture } = fakeCapture(PICKER_2_1_280);
    await probeClaudeModels(
      { cwd: "/repo", credentialProfile: profile() },
      { runCapture, binaryIdentity: identity },
    );
    const env = calls[0]?.opts.env ?? {};
    expect(env["CLAUDE_CONFIG_DIR"]).toBe(realpathSync(join(ownedTmp, "profiles", "work")));
    for (const key of PROVIDER_SECRET_ENV) expect(env[key], key).toBeNull();
    expect(env["ANTHROPIC_MODEL"]).toBeNull();
    expect(env["ANTHROPIC_DEFAULT_OPUS_MODEL"]).toBeNull();
    // Bootstrap is what makes the account's own rows appear: not switched off.
    expect(env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]).toBeUndefined();
    // Neutral cwd (never a repository), disposed once the capture is over.
    expect(calls[0]?.opts.cwd).not.toBe("/repo");
    expect(existsSync(calls[0]?.opts.cwd ?? "/nonexistent")).toBe(false);
  });

  it("credential env: the profile's own variable under a scratch config, bootstrap allowed, every other secret scrubbed", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "placeholder-host-key-must-not-reach-the-probe");
    vi.stubEnv("ANTHROPIC_MODEL", "bogus-env-model");
    const { calls, runCapture } = fakeCapture(PICKER_2_1_280);
    const resolveProfileSecret = (ref: string) =>
      ref === "anthropic:work" ? "placeholder-profile-key" : null;
    await probeClaudeModels(
      {
        cwd: "/repo",
        credentialProfile: profile({ credential_kind: "api_key", secret_ref: "anthropic:work" }),
      },
      { runCapture, binaryIdentity: identity, resolveProfileSecret },
    );
    expect(calls).toHaveLength(1);
    const env = calls[0]?.opts.env ?? {};
    const root = join(nativeHarnessStateRoot(), "claude", "model-probe");
    expect(env["ANTHROPIC_API_KEY"]).toBe("placeholder-profile-key");
    for (const key of PROVIDER_SECRET_ENV)
      if (key !== "ANTHROPIC_API_KEY") expect(env[key], key).toBeNull();
    // The account's rows come from the bootstrap: not switched off.
    expect(env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]).toBeUndefined();
    expect(String(env["CLAUDE_CONFIG_DIR"]).startsWith(root)).toBe(true);
    expect(env["HOME"]).toBe(env["CLAUDE_CONFIG_DIR"]);
    expect(env["ANTHROPIC_MODEL"]).toBeNull();
    expect(existsSync(String(env["CLAUDE_CONFIG_DIR"]))).toBe(false);

    // An OAuth profile carries its token in the variable its runs use.
    clearClaudeModelProbeCache();
    await probeClaudeModels(
      {
        cwd: "/repo",
        credentialProfile: profile({
          profile_id: "sub",
          credential_kind: "oauth_token",
          secret_ref: "claude_oauth:sub",
        }),
      },
      {
        runCapture,
        binaryIdentity: identity,
        resolveProfileSecret: (ref) => (ref === "claude_oauth:sub" ? "placeholder-token" : null),
      },
    );
    const oauthEnv = calls[1]?.opts.env ?? {};
    expect(oauthEnv["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("placeholder-token");
    expect(oauthEnv["ANTHROPIC_API_KEY"]).toBeNull();
  });

  it("a credential profile whose secret is not stored answers the hints without a spawn; two profiles never share an entry", async () => {
    const { calls, runCapture } = fakeCapture(PICKER_2_1_280);
    const missing = profile({ credential_kind: "api_key", secret_ref: "anthropic:gone" });
    await expect(
      probeClaudeModels(
        { cwd: "/repo", credentialProfile: missing },
        { runCapture, binaryIdentity: identity, resolveProfileSecret: () => null },
      ),
    ).resolves.toEqual(claudeModelRows(null));
    expect(calls).toHaveLength(0);
    // Two credential profiles and the binary scope are three cache entries.
    const deps = {
      runCapture,
      binaryIdentity: identity,
      resolveProfileSecret: () => "placeholder-key",
    };
    await probeClaudeModels(
      { cwd: "/repo", credentialProfile: profile({ credential_kind: "api_key", secret_ref: "a" }) },
      deps,
    );
    await probeClaudeModels(
      {
        cwd: "/repo",
        credentialProfile: profile({
          profile_id: "two",
          credential_kind: "api_key",
          secret_ref: "b",
        }),
      },
      deps,
    );
    await probeClaudeModels({ cwd: "/repo" }, deps);
    expect(calls).toHaveLength(3);
    await probeClaudeModels(
      { cwd: "/repo", credentialProfile: profile({ credential_kind: "api_key", secret_ref: "a" }) },
      deps,
    );
    expect(calls).toHaveLength(3);
  });

  it("binary-only env: scratch HOME + config under the owned state root, nonessential traffic off, model overrides gone", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", "bogus-env-model");
    vi.stubEnv("ANTHROPIC_DEFAULT_SONNET_MODEL", "claude-sonnet-9-9");
    const { calls, runCapture } = fakeCapture(PICKER_2_1_280);
    let scratchSeenDuringCapture = false;
    const observing = async (cmd: string, args: string[], opts: SpawnOptions = {}) => {
      scratchSeenDuringCapture = existsSync(opts.cwd ?? "/nonexistent");
      return runCapture(cmd, args, opts);
    };
    await probeClaudeModels({ cwd: "/repo" }, { runCapture: observing, binaryIdentity: identity });
    const env = calls[0]?.opts.env ?? {};
    const root = join(nativeHarnessStateRoot(), "claude", "model-probe");
    expect(env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]).toBe("1");
    expect(env["CLAUDE_CONFIG_DIR"]).toBeDefined();
    expect(String(env["CLAUDE_CONFIG_DIR"]).startsWith(root)).toBe(true);
    expect(env["HOME"]).toBe(env["CLAUDE_CONFIG_DIR"]);
    expect(env["USERPROFILE"]).toBe(env["CLAUDE_CONFIG_DIR"]);
    expect(calls[0]?.opts.cwd).toBe(env["CLAUDE_CONFIG_DIR"]);
    expect(env["ANTHROPIC_MODEL"]).toBeNull();
    expect(env["ANTHROPIC_DEFAULT_SONNET_MODEL"]).toBeNull();
    for (const key of PROVIDER_SECRET_ENV) expect(env[key], key).toBeNull();
    // The scratch dir exists for the child and is gone afterwards.
    expect(scratchSeenDuringCapture).toBe(true);
    expect(existsSync(String(env["CLAUDE_CONFIG_DIR"]))).toBe(false);
  });
});

describe("cache", () => {
  it("a hit does not respawn; fresh and clear do", async () => {
    const { calls, runCapture } = fakeCapture(PICKER_2_1_280);
    const deps = { runCapture, binaryIdentity: identity };
    const first = await probeClaudeModels({ cwd: "/repo" }, deps);
    expect(first.filter((r) => r.origin === "live")).toHaveLength(8);
    await probeClaudeModels({ cwd: "/repo" }, deps);
    expect(calls).toHaveLength(1);
    await probeClaudeModels({ cwd: "/repo", fresh: true }, deps);
    expect(calls).toHaveLength(2);
    clearClaudeModelProbeCache();
    await probeClaudeModels({ cwd: "/repo" }, deps);
    expect(calls).toHaveLength(3);
  });

  it("answers live for an hour and failures for a minute", async () => {
    let now = 1_000_000;
    const nowMs = () => now;
    const { calls, runCapture } = fakeCapture(PICKER_2_1_280);
    const deps = { runCapture, binaryIdentity: identity, nowMs };
    await probeClaudeModels({ cwd: "/repo" }, deps);
    now += 59 * 60_000;
    await probeClaudeModels({ cwd: "/repo" }, deps);
    expect(calls).toHaveLength(1);
    now += 2 * 60_000;
    await probeClaudeModels({ cwd: "/repo" }, deps);
    expect(calls).toHaveLength(2);

    clearClaudeModelProbeCache();
    const failing = fakeCapture("garbage\n");
    const failDeps = { runCapture: failing.runCapture, binaryIdentity: identity, nowMs };
    await probeClaudeModels({ cwd: "/repo" }, failDeps);
    now += 30_000;
    await probeClaudeModels({ cwd: "/repo" }, failDeps);
    expect(failing.calls).toHaveLength(1);
    now += 31_000;
    await probeClaudeModels({ cwd: "/repo" }, failDeps);
    expect(failing.calls).toHaveLength(2);
  });

  it("a different binary identity is a different entry", async () => {
    const { calls, runCapture } = fakeCapture(PICKER_2_1_280);
    await probeClaudeModels({ cwd: "/repo" }, { runCapture, binaryIdentity: identity });
    await probeClaudeModels(
      { cwd: "/repo" },
      { runCapture, binaryIdentity: () => ({ ...identity(), mtimeMs: 2_000 }) },
    );
    expect(calls).toHaveLength(2);
  });

  it("concurrent callers share one child, and an aborted caller neither kills it nor waits for it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, runCapture } = fakeCapture(async () => {
      await gate;
      return PICKER_2_1_280;
    });
    const deps = { runCapture, binaryIdentity: identity };
    const cancelled = new AbortController();
    const first = probeClaudeModels({ cwd: "/repo", abortSignal: cancelled.signal }, deps);
    const second = probeClaudeModels({ cwd: "/repo" }, deps);
    expect(calls).toHaveLength(1);
    cancelled.abort();
    // The abandoned caller reads the hints at once...
    expect(await first).toEqual(claudeModelRows(null));
    // ...while the shared capture is untouched and still answers everyone else.
    expect(calls[0]?.opts.abortSignal).toBeUndefined();
    release();
    expect((await second).filter((r) => r.origin === "live")).toHaveLength(8);
    // And the answer was kept: no respawn for the next caller.
    await probeClaudeModels({ cwd: "/repo" }, deps);
    expect(calls).toHaveLength(1);
  });

  it("an already-aborted caller never spawns", async () => {
    const { calls, runCapture } = fakeCapture(PICKER_2_1_280);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      probeClaudeModels(
        { cwd: "/repo", abortSignal: cancelled.signal },
        { runCapture, binaryIdentity: identity },
      ),
    ).resolves.toEqual(claudeModelRows(null));
    expect(calls).toHaveLength(0);
  });
});

/**
 * The real spawn against a stub `claude` on disk: the cache is keyed by the
 * binary's identity (realpath, inode, size, mtime), so rewriting the stub
 * re-probes on the very next call — no daemon restart, no module reset.
 */
describe("binary identity on disk", () => {
  let dir: string;
  let bin: string;
  let counter: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-model-probe-"));
    bin = join(dir, "claude-stub");
    counter = join(dir, "spawns");
    vi.resetModules();
    vi.stubEnv("CLAUDEXOR_CLAUDE_BIN", bin);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  }, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

  function pickerLine(values: string[]): string {
    return JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: CLAUDE_INIT_REQUEST_ID,
        response: {
          models: values.map((value) => ({ value, displayName: value, resolvedModel: value })),
        },
      },
    });
  }

  function installStub(values: string[]): void {
    writeFileSync(
      bin,
      `#!/bin/sh\necho spawn >> "${counter}"\ncat <<'CLAUDE_STUB_EOF'\n${pickerLine(values)}\nCLAUDE_STUB_EOF\n`,
    );
    chmodSync(bin, 0o755);
  }

  const spawns = () =>
    existsSync(counter) ? readFileSync(counter, "utf8").split("spawn").length - 1 : 0;

  it("re-reads a rewritten binary without a module reset, and serves an unchanged one from the cache", async () => {
    installStub(["alpha-1"]);
    const probe = await import("./model-probe.js");
    probe.clearClaudeModelProbeCache();
    const liveIds = (rows: Awaited<ReturnType<typeof probe.probeClaudeModels>>) =>
      rows.filter((r) => r.origin === "live").map((r) => r.id);

    expect(liveIds(await probe.probeClaudeModels({ cwd: "/repo" }))).toEqual(["alpha-1"]);
    expect(spawns()).toBe(1);
    // Unchanged bytes: a hit, no second child.
    expect(liveIds(await probe.probeClaudeModels({ cwd: "/repo" }))).toEqual(["alpha-1"]);
    expect(spawns()).toBe(1);

    // The "update at the same path" shape: same path, new size/mtime.
    installStub(["beta-2", "beta-2-longer-row"]);
    expect(liveIds(await probe.probeClaudeModels({ cwd: "/repo" }))).toEqual([
      "beta-2",
      "beta-2-longer-row",
    ]);
    expect(spawns()).toBe(2);
    probe.clearClaudeModelProbeCache();
  });

  it("the real spawn receives no --model, a neutral cwd, and leaves nothing behind", async () => {
    const argvLog = join(dir, "argv");
    writeFileSync(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvLog}"\npwd >> "${argvLog}"\ncat <<'CLAUDE_STUB_EOF'\n${pickerLine(["gamma"])}\nCLAUDE_STUB_EOF\n`,
    );
    chmodSync(bin, 0o755);
    const probe = await import("./model-probe.js");
    probe.clearClaudeModelProbeCache();
    const rows = await probe.probeClaudeModels({ cwd: "/repo" });
    expect(rows.filter((r) => r.origin === "live").map((r) => r.id)).toEqual(["gamma"]);
    // One argv element per line; the `--setting-sources ""` element IS an
    // empty line, so only the trailing newline is dropped, never blank lines.
    const lines = readFileSync(argvLog, "utf8").split("\n");
    lines.pop();
    const cwd = lines.pop();
    expect(lines).toEqual([...probe.CLAUDE_MODEL_PROBE_ARGS]);
    expect(lines).not.toContain("--model");
    expect(cwd).not.toBe("/repo");
    expect(cwd?.includes(join("claude", "model-probe"))).toBe(true);
    expect(existsSync(cwd ?? "/nonexistent")).toBe(false);
    probe.clearClaudeModelProbeCache();
  });
});

/**
 * The spawn layer applies a caller's env patch VERBATIM over the normalized
 * host env, so a patch PATH replaces it and the child resolves `claude` on the
 * patch alone. The probe must resolve the same way: with the managed binary
 * re-prepended it would key and capture a different binary than the run.
 */
describe("a PATH patch resolves the binary the run would execute", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claudexor-probe-path-"));
    vi.resetModules();
    vi.stubEnv("CLAUDEXOR_CLAUDE_BIN", ""); // a bare `claude`, resolved on PATH
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  }, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

  function stubDir(name: string, value: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: CLAUDE_INIT_REQUEST_ID,
        response: { models: [{ value, displayName: value, resolvedModel: value }] },
      },
    });
    writeFileSync(
      join(dir, "claude"),
      `#!/bin/sh\n/bin/cat <<'CLAUDE_STUB_EOF'\n${line}\nCLAUDE_STUB_EOF\n`, // /bin/cat: the child's PATH is the patch alone
      {
        mode: 0o755,
      },
    );
    return dir;
  }

  it("captures and keys the binary on the patch PATH, not a managed one", async () => {
    const alpha = stubDir("alpha", "alpha-model");
    const beta = stubDir("beta", "beta-model");
    const probe = await import("./model-probe.js");
    probe.clearClaudeModelProbeCache();
    const liveIds = (rows: Awaited<ReturnType<typeof probe.probeClaudeModels>>) =>
      rows.filter((r) => r.origin === "live").map((r) => r.id);
    expect(liveIds(await probe.probeClaudeModels({ cwd: "/repo", env: { PATH: beta } }))).toEqual([
      "beta-model",
    ]);
    // A different patch PATH is a different binary, hence a different entry.
    expect(liveIds(await probe.probeClaudeModels({ cwd: "/repo", env: { PATH: alpha } }))).toEqual([
      "alpha-model",
    ]);
    probe.clearClaudeModelProbeCache();
  });
});
