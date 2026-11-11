import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CredentialProfile } from "@claudexor/schema";
import type { spawnProcess, SpawnOptions } from "@claudexor/core";
import { CODEX_FILE_AUTH_ARGS } from "./auth.js";
import { prepareCodexModelAuth, refreshCodexModelAuth } from "./model-auth.js";

const NOW = 1900000000000;
const jwt = (claims: unknown) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
const auth = (exp = NOW / 1000 + 1000, account = "account", principal = "user") =>
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: jwt({ exp, "https://api.openai.com/auth": { chatgpt_account_id: account } }),
      account_id: account,
      refresh_token: "REFRESH_MUST_NOT_ESCAPE",
      id_token: jwt({ sub: principal }),
    },
  });
const profile = (changes: Record<string, unknown> = {}) =>
  CredentialProfile.parse({
    profile_id: "work",
    harness_id: "codex",
    display_name: "Work",
    credential_kind: "config_dir_login",
    isolation_locator: join(realpathSync(process.env.CLAUDEXOR_CONFIG_DIR!), "profiles", "work"),
    ...changes,
  });

describe("managed Codex model credentials", () => {
  it("reads only the selected file and does not return refresh material", async () => {
    const read = vi.fn(async () => auth()),
      refresh = vi.fn();
    const result = await prepareCodexModelAuth(profile(), new AbortController().signal, {
      readAuthFile: read,
      refresh,
      now: () => NOW,
    });
    expect(read).toHaveBeenCalledWith(join(profile().isolation_locator!, "auth.json"));
    expect(refresh).not.toHaveBeenCalled();
    expect(result.accountId).toBe("account");
    expect(result.accountFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("REFRESH_MUST_NOT_ESCAPE");
  });
  it("uses the official refresh seam once and rereads the current token", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(auth(NOW / 1000 - 1))
      .mockResolvedValueOnce(auth());
    const refresh = vi.fn(async () => {}),
      signal = new AbortController().signal;
    const result = await prepareCodexModelAuth(profile(), signal, {
      readAuthFile: read,
      refresh,
      now: () => NOW,
    });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(profile().isolation_locator, signal);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.expiresAt).toBeGreaterThan(NOW);
  });
  it("fingerprint survives a token refresh but not account or principal change", async () => {
    const get = (body: string) =>
      prepareCodexModelAuth(profile(), new AbortController().signal, {
        readAuthFile: async () => body,
        now: () => NOW,
      });
    const original = await get(auth());
    expect((await get(auth(NOW / 1000 + 5000))).accountFingerprint).toBe(
      original.accountFingerprint,
    );
    expect((await get(auth(undefined, "other-account"))).accountFingerprint).not.toBe(
      original.accountFingerprint,
    );
    expect((await get(auth(undefined, undefined, "other-user"))).accountFingerprint).not.toBe(
      original.accountFingerprint,
    );
  });
  it("plan changes invalidate capability identity without changing account identity", async () => {
    const get = async (plan: string) => {
      const body = JSON.parse(auth());
      body.tokens.id_token = jwt({
        sub: "user",
        "https://api.openai.com/auth": { chatgpt_plan_type: plan },
      });
      return prepareCodexModelAuth(profile(), new AbortController().signal, {
        readAuthFile: async () => JSON.stringify(body),
        now: () => NOW,
      });
    };
    const free = await get("free"),
      pro = await get("pro");
    expect(free.accountFingerprint).toBe(pro.accountFingerprint);
    expect(free.capabilityFingerprint).not.toBe(pro.capabilityFingerprint);
  });
  it("does not infer successful refresh from the helper returning", async () => {
    const refresh = vi.fn(async () => {});
    await expect(
      prepareCodexModelAuth(profile(), new AbortController().signal, {
        readAuthFile: async () => auth(NOW / 1000 - 1),
        refresh,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ problem: { code: "auth_refresh_failed" } });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("refuses a changed account during refresh", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(auth(NOW / 1000 - 1))
      .mockResolvedValueOnce(auth(undefined, "other"));
    await expect(
      prepareCodexModelAuth(profile(), new AbortController().signal, {
        readAuthFile: read,
        refresh: async () => {},
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ problem: { code: "auth_changed" } });
  });
  it("serializes refresh of one home and rereads before a queued caller refreshes", async () => {
    let current = auth(NOW / 1000 - 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi.fn(async () => {
      await gate;
      current = auth();
    });
    const deps = { readAuthFile: async () => current, refresh, now: () => NOW };
    const first = prepareCodexModelAuth(profile(), new AbortController().signal, deps);
    const second = prepareCodexModelAuth(profile(), new AbortController().signal, deps);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.accountFingerprint).toBe(b.accountFingerprint);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("cancels a queued waiter promptly without releasing later callers past live refresh", async () => {
    let current = auth(NOW / 1000 - 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi.fn(async () => {
      await gate;
      current = auth();
    });
    const deps = { readAuthFile: async () => current, refresh, now: () => NOW };
    const controller = new AbortController();
    const first = prepareCodexModelAuth(profile(), new AbortController().signal, deps);
    const cancelled = prepareCodexModelAuth(profile(), controller.signal, deps);
    const last = prepareCodexModelAuth(profile(), new AbortController().signal, deps);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    expect(refresh).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, last]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("a cancelled refresher does not cancel another waiting caller", async () => {
    let current = auth(NOW / 1000 - 1);
    let active = 0,
      maxActive = 0;
    const controller = new AbortController();
    const refresh = vi.fn(async (_home: string, signal: AbortSignal) => {
      maxActive = Math.max(maxActive, ++active);
      try {
        if (signal === controller.signal) {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        } else current = auth();
      } finally {
        active--;
      }
    });
    const deps = { readAuthFile: async () => current, refresh, now: () => NOW };
    const first = prepareCodexModelAuth(profile(), controller.signal, deps);
    const second = prepareCodexModelAuth(profile(), new AbortController().signal, deps);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(first).rejects.toThrow();
    expect((await second).expiresAt).toBeGreaterThan(NOW);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });
  it.each([
    { enabled: false },
    { harness_id: "claude" },
    { isolation_locator: "/outside/managed-root" },
  ])("refuses an invalid profile without a credential read: %j", async (changes) => {
    const read = vi.fn(async () => auth()),
      refresh = vi.fn();
    await expect(
      prepareCodexModelAuth(profile(changes), new AbortController().signal, {
        readAuthFile: read,
        refresh,
      }),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
  it("guards an auth-file symlink, not only the profile directory", async () => {
    if (process.platform === "win32") return; // Unix symlink fixture; canonical path helper has cross-platform coverage.
    const other = mkdtempSync(join(tmpdir(), "codex-model-foreign-"));
    const selected = profile();
    mkdirSync(selected.isolation_locator!, { recursive: true });
    symlinkSync(other, join(selected.isolation_locator!, "auth.json"));
    const read = vi.fn(async () => auth());
    try {
      await expect(
        prepareCodexModelAuth(selected, new AbortController().signal, { readAuthFile: read }),
      ).rejects.toMatchObject({ problem: { code: "auth_unavailable" } });
      expect(read).not.toHaveBeenCalled();
    } finally {
      rmSync(join(selected.isolation_locator!, "auth.json"));
      rmSync(other, { recursive: true, force: true });
    }
  });
  it("does not expose unreadable credentials or claim missing file means logout", async () => {
    await expect(
      prepareCodexModelAuth(profile(), new AbortController().signal, {
        readAuthFile: async () => {
          throw new Error("SECRET_DIAGNOSTIC");
        },
      }),
    ).rejects.toMatchObject({
      message: "The selected managed Codex credential file cannot be read.",
      problem: { code: "auth_unavailable" },
    });
  });
  it("does not invent an account fingerprint when principal metadata is absent", async () => {
    const body = JSON.stringify({ tokens: { access_token: "opaque", account_id: "account" } });
    const result = await prepareCodexModelAuth(profile(), new AbortController().signal, {
      readAuthFile: async () => body,
    });
    expect(result.accountFingerprint).toBeNull();
    expect(result.expiresAt).toBeNull();
  });
  it("rejects contradictory principal claims instead of binding continuation to another user", async () => {
    const body = JSON.stringify({
      tokens: {
        access_token: jwt({
          exp: NOW / 1000 + 1000,
          "https://api.openai.com/auth": { chatgpt_user_id: "current" },
        }),
        account_id: "account",
        id_token: jwt({ "https://api.openai.com/auth": { chatgpt_user_id: "other" } }),
      },
    });
    await expect(
      prepareCodexModelAuth(profile(), new AbortController().signal, {
        readAuthFile: async () => body,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ problem: { code: "auth_unavailable" } });
  });
  it("pre-dispatch cancellation performs no read or refresh", async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn(async () => auth()),
      refresh = vi.fn();
    await expect(
      prepareCodexModelAuth(profile(), controller.signal, { readAuthFile: read, refresh }),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("official Codex refresh protocol", () => {
  it("uses initialized + account/read refreshToken and closes its scoped child", async () => {
    const sent: unknown[] = [];
    let cleaned = false;
    const run: typeof spawnProcess = async function* (_bin, args, opts: SpawnOptions = {}) {
      expect(args).toEqual([...CODEX_FILE_AUTH_ARGS, "app-server", "--stdio"]);
      expect(opts.env?.CODEX_HOME).toBe(profile().isolation_locator);
      expect(opts.env?.OPENAI_API_KEY).toBeNull();
      expect(opts.cwd).toBe(profile().isolation_locator);
      opts.onSpawn?.({
        write: (data) => sent.push(JSON.parse(data)),
        end: () => {},
        closed: Promise.resolve(),
      });
      try {
        yield { type: "stdout", line: '{"id":1,"result":{}}' };
        yield { type: "stdout", line: '{"id":2,"result":{"account":{"type":"chatgpt"}}}' };
      } finally {
        cleaned = true;
      }
    };
    await refreshCodexModelAuth(profile().isolation_locator!, new AbortController().signal, run);
    expect(sent).toMatchObject([
      { id: 1, method: "initialize", params: { clientInfo: { name: "claudexor" } } },
      { method: "initialized", params: null },
      { id: 2, method: "account/read", params: { refreshToken: true } },
    ]);
    expect(cleaned).toBe(true);
  });
  it("propagates unconfirmed process termination as refresh failure", async () => {
    const run: typeof spawnProcess = async function* (_bin, _args, opts = {}) {
      try {
        yield { type: "stdout", line: '{"id":2,"result":{"account":{"type":"chatgpt"}}}' };
      } finally {
        opts.onTerminationUnconfirmed?.({ rootPid: 1, survivors: [2], unresolved: [] });
      }
    };
    await expect(
      refreshCodexModelAuth(profile().isolation_locator!, new AbortController().signal, run),
    ).rejects.toMatchObject({ problem: { code: "auth_refresh_failed" } });
  });
  it("discloses genuine logged-out response but not vendor diagnostics", async () => {
    const run: typeof spawnProcess = async function* () {
      yield { type: "stderr", line: "SECRET_DIAGNOSTIC" };
      yield { type: "stdout", line: '{"id":2,"result":{"account":null}}' };
    };
    await expect(
      refreshCodexModelAuth(profile().isolation_locator!, new AbortController().signal, run),
    ).rejects.toMatchObject({ problem: { code: "auth_required" } });
  });
  it("does not confuse a malformed vendor response with a confirmed logout", async () => {
    const run: typeof spawnProcess = async function* () {
      yield { type: "stdout", line: '{"id":2,"result":{}}' };
    };
    await expect(
      refreshCodexModelAuth(profile().isolation_locator!, new AbortController().signal, run),
    ).rejects.toMatchObject({ problem: { code: "auth_refresh_failed" } });
  });
});
