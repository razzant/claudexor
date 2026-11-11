import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HarnessRunSpec, type CredentialProfile, type HarnessEvent } from "@claudexor/schema";
import { stampCredentialProfileSelection, type CliRunLoopOptions } from "@claudexor/core";
import type { CursorStatusObservation } from "./auth.js";
import { createCursorAdapter } from "./index.js";
import {
  canonicalCursorProfileHome,
  cursorProfilePathEnv,
  cursorProfileRunEnv,
  probeCursorCredentialAccount,
  probeCursorCredentialProfile,
  resolveCursorProfileRoute,
} from "./profile.js";
import { CURSOR_STATUS_LAST_POSITIVE_MS, createCursorStatusCoordinator } from "./status-cache.js";

describe("Cursor config-dir credential profiles (INV-135)", () => {
  let root: string;
  let priorRoot: string | undefined;
  let home: string;

  const profile = (over: Partial<CredentialProfile> = {}): CredentialProfile => ({
    profile_id: "valentine",
    harness_id: "cursor",
    display_name: "Valentine",
    credential_kind: "config_dir_login",
    isolation_locator: home,
    secret_ref: null,
    enabled: true,
    created_at: null,
    ...over,
  });

  beforeEach(() => {
    // realpath: macOS tmpdir is a /var → /private/var symlink, and the locator
    // canonicalizer resolves it — the expected home must use the same spelling.
    root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-cursor-profile-")));
    priorRoot = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    home = join(root, "profiles", "cursor-valentine");
  });

  afterEach(() => {
    if (priorRoot === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = priorRoot;
    rmSync(root, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  it("canonicalizes only Claudexor-owned homes", () => {
    expect(canonicalCursorProfileHome(home)).toBe(home);
    expect(() => canonicalCursorProfileHome("relative/home")).toThrow(/absolute/);
    expect(() => canonicalCursorProfileHome(join(tmpdir(), "outside"))).toThrow(/must live under/);
  });

  it("names the profile HOME a native profile child receives for applied evidence", () => {
    const adapter = createCursorAdapter();
    const live = HarnessRunSpec.parse({
      session_id: "s",
      intent: "explain",
      cwd: root,
      prompt: "p",
      credential_profile: profile(),
      env: { HOME: "/engine/lane/home" },
    });
    expect(adapter.childHome?.(live)).toBe(home);
    // An API-key row keeps the engine HOME: no profile HOME is substituted.
    expect(
      adapter.childHome?.({
        ...live,
        credential_profile: profile({
          credential_kind: "api_key",
          isolation_locator: null,
          secret_ref: "cursor:valentine",
        }),
      }),
    ).toBeNull();
    expect(adapter.childHome?.({ ...live, credential_profile: null })).toBeNull();
  });

  it("separates profile auth paths from lane config/session paths", () => {
    const paths = cursorProfilePathEnv(home, "/tmp/cursor-lane");
    expect(paths).toMatchObject({
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      XDG_CONFIG_HOME: join(home, ".config"),
      CURSOR_CONFIG_DIR: "/tmp/cursor-lane/.cursor",
      CURSOR_DATA_DIR: "/tmp/cursor-lane/.cursor",
      AGENT_CLI_CREDENTIAL_STORE: "file",
    });
    const env = cursorProfileRunEnv(home, {
      HOME: "/tmp/cursor-lane",
      CURSOR_API_KEY: "must-be-scrubbed",
    });
    expect(env["HOME"]).toBe(home);
    expect(env["CURSOR_API_KEY"]).toBeNull();
    expect(env["CURSOR_CONFIG_DIR"]).toBe("/tmp/cursor-lane/.cursor");
  });

  it("routes only a login proven in the exact profile file-store env", async () => {
    let observed: Record<string, string | null | undefined> | undefined;
    const runtime = {
      nativeAuthOk: async (env: typeof observed) => {
        observed = env;
        return { kind: "authenticated" } as const;
      },
      resolveProfileSecret: () => null,
    };
    const route = await resolveCursorProfileRoute(profile(), { HOME: "/tmp/thread-lane" }, runtime);
    expect(route).toMatchObject({ kind: "native" });
    expect(observed).toMatchObject({
      HOME: home,
      CURSOR_CONFIG_DIR: "/tmp/thread-lane/.cursor",
      AGENT_CLI_CREDENTIAL_STORE: "file",
      CURSOR_API_KEY: null,
    });
  });

  it("refuses a logged-out named profile instead of falling back to default auth", async () => {
    let secretReads = 0;
    const route = await resolveCursorProfileRoute(
      profile(),
      {},
      {
        nativeAuthOk: async () => ({ kind: "loggedOut" }),
        resolveProfileSecret: () => {
          secretReads += 1;
          return "default-must-not-be-used";
        },
      },
    );
    expect(route).toMatchObject({ refusal: expect.stringContaining("profile login") });
    expect(secretReads).toBe(0);
  });

  it("refuses when the status probe cannot decide instead of guessing readiness", async () => {
    const route = await resolveCursorProfileRoute(
      profile(),
      {},
      {
        nativeAuthOk: async () => ({ kind: "unknown", error: "status transport failed" }),
        resolveProfileSecret: () => null,
      },
    );
    expect(route).toMatchObject({
      refusal: expect.stringContaining("status probe failed"),
    });
    // Unknown is not a logout (#363): no login advice rides this refusal.
    const refusal = "refusal" in route ? route.refusal : "";
    expect(refusal).toContain("login state is unknown");
    expect(refusal).not.toMatch(/run the profile login|auth login/);
  });

  const lastPositive = { observedAt: "2026-09-28T19:52:00.000Z", ageMs: 95_000 };
  const timedOutWithLastPositive = {
    kind: "unknown" as const,
    error: "cursor-agent status did not answer within 10s (SIGKILL); login state unknown",
    timedOut: true,
    lastPositive,
  };

  it("projects a timeout's bounded last positive as disclosed stale evidence, never a pass (#363)", async () => {
    const status = await probeCursorCredentialProfile(profile(), {
      nativeAuthOk: async () => timedOutWithLastPositive,
      resolveProfileSecret: () => null,
    });
    expect(status).toEqual({
      profile_id: "valentine",
      harness_id: "cursor",
      availability: "unknown",
      verification: "not_run",
      verification_source: "local_store",
      stale: true,
      stale_age_ms: 95_000,
      stale_basis: "last_positive_after_timeout",
      detail:
        "cursor-agent status did not answer within 10s (SIGKILL); login state unknown; the last positive status answer (2026-09-28T19:52:00.000Z, 95000ms old) stands in for unpinned routing only",
      last_verified_at: null,
    });
    expect(status.detail).not.toMatch(/run the profile login|auth login/);
    // Without a remembered positive, the same timeout is plain unknown.
    const { lastPositive: _dropped, ...plainTimeout } = timedOutWithLastPositive;
    const plain = await probeCursorCredentialProfile(profile(), {
      nativeAuthOk: async () => plainTimeout,
      resolveProfileSecret: () => null,
    });
    expect(plain).not.toHaveProperty("stale");
    expect(plain).not.toHaveProperty("stale_basis");
    expect(plain).toMatchObject({ availability: "unknown", verification: "not_run" });
  });

  it.each([95_000, 95_000.2])(
    "projects a producer age of %s as integer stale evidence",
    async (rawAge) => {
      let clock = 0;
      let calls = 0;
      const coordinator = createCursorStatusCoordinator({
        monotonicMs: () => clock,
        mutating: () => false,
        probe: async () =>
          ++calls === 1
            ? { kind: "authenticated" }
            : {
                kind: "unknown",
                timedOut: true,
                error: "timeout",
              },
      });
      const runtime = { nativeAuthOk: coordinator.status, resolveProfileSecret: () => null };
      expect(await probeCursorCredentialProfile(profile(), runtime)).toMatchObject({
        verification: "passed",
      });
      clock = rawAge;
      const status = await probeCursorCredentialProfile(profile(), runtime);
      expect(status).toMatchObject({
        verification: "not_run",
        stale_basis: "last_positive_after_timeout",
        stale_age_ms: Math.ceil(rawAge),
      });
      expect(Number.isInteger(status.stale_age_ms)).toBe(true);
      expect(status.stale_age_ms).toBeGreaterThanOrEqual(rawAge);
      expect(calls).toBe(2);
    },
  );

  it("a route check rides a timeout's last positive only when its caller admits it (#363)", async () => {
    const asked: unknown[] = [];
    const runtime = {
      nativeAuthOk: async (_env?: unknown, _signal?: AbortSignal, options?: unknown) => {
        asked.push(options);
        return timedOutWithLastPositive;
      },
      resolveProfileSecret: () => null,
    };
    await expect(
      resolveCursorProfileRoute(profile(), {}, runtime, undefined, { admitLastPositive: true }),
    ).resolves.toMatchObject({ kind: "native", staleAuth: lastPositive });
    // No caller decision is the strict contract: the same answer refuses.
    const strict = await resolveCursorProfileRoute(profile(), {}, runtime);
    const refusal = "refusal" in strict ? strict.refusal : "";
    expect(refusal).toContain("login state is unknown");
    expect(refusal).toContain("serves unpinned routing only, never an explicit pin");
    expect(refusal).not.toMatch(/run the profile login|auth login/);
    // An explicit pin also waits for the answer (#532) and names the bound.
    const pin = await resolveCursorProfileRoute(profile(), {}, runtime, undefined, {
      pinned: true,
    });
    expect(asked).toEqual([undefined, undefined, { pinned: true }]);
    const pinRefusal = "refusal" in pin ? pin.refusal : "";
    expect(pinRefusal).toContain("Cursor did not confirm sign-in within 120s");
    expect(pinRefusal).toContain(
      "a pinned account waits for that answer and never starts on an older one",
    );
    expect(pinRefusal).not.toMatch(/run the profile login|auth login/);
  });

  it("keeps the account identity null while only a stale positive stands in", async () => {
    const receipt = await probeCursorCredentialAccount(profile(), {
      nativeAuthOk: async () => timedOutWithLastPositive,
      resolveProfileSecret: () => null,
    });
    expect(receipt.identity).toBeNull();
  });

  it("stamps a reused positive status answer with the instant the vendor gave it (#363)", async () => {
    const observedAt = "2026-09-28T19:52:00.000Z";
    const status = await probeCursorCredentialProfile(profile(), {
      nativeAuthOk: async () => ({ kind: "authenticated", observedAt }),
      resolveProfileSecret: () => null,
    });
    expect(status).toMatchObject({
      availability: "available",
      verification: "passed",
      last_verified_at: observedAt,
    });
  });

  it("turns an out-of-tree isolation locator into a typed refusal, never a probe", async () => {
    const route = await resolveCursorProfileRoute(
      profile({ isolation_locator: join(tmpdir(), "outside-claudexor") }),
      {},
      {
        nativeAuthOk: async () => {
          throw new Error("must not probe an unconfined home");
        },
        resolveProfileSecret: () => null,
      },
    );
    expect(route).toMatchObject({ refusal: expect.stringContaining("must live under") });
  });

  it("preserves namespaced Cursor API-key profiles", async () => {
    const route = await resolveCursorProfileRoute(
      profile({
        credential_kind: "api_key",
        isolation_locator: null,
        secret_ref: "cursor:valentine",
      }),
      {},
      {
        nativeAuthOk: async () => ({ kind: "loggedOut" }),
        resolveProfileSecret: (ref) => (ref === "cursor:valentine" ? "cursor-key" : null),
      },
    );
    expect(route).toEqual({ kind: "api_key", key: "cursor-key" });
  });

  it.each([
    {
      probe: { kind: "authenticated" as const },
      availability: "available",
      verification: "passed",
    },
    {
      probe: { kind: "loggedOut" as const },
      availability: "unavailable",
      verification: "not_run",
    },
    {
      probe: { kind: "unknown" as const, error: "status transport failed" },
      availability: "unknown",
      verification: "not_run",
    },
    {
      probe: { kind: "unknown" as const },
      availability: "unknown",
      verification: "not_run",
    },
  ])("maps profile status evidence without reading default credentials", async (expected) => {
    const status = await probeCursorCredentialProfile(profile(), {
      nativeAuthOk: async () => expected.probe,
      resolveProfileSecret: () => {
        throw new Error("must not read a default secret");
      },
    });
    expect(status).toMatchObject({
      profile_id: "valentine",
      harness_id: "cursor",
      availability: expected.availability,
      verification: expected.verification,
    });
  });

  it("returns a named profile email and readiness from one status observation", async () => {
    let calls = 0;
    const receipt = await probeCursorCredentialAccount(profile(), {
      nativeAuthOk: async () => {
        calls += 1;
        return { kind: "authenticated", email: "valentine@example.test" };
      },
      resolveProfileSecret: () => {
        throw new Error("must not read a default secret");
      },
    });
    expect(calls).toBe(1);
    expect(receipt).toMatchObject({
      status: {
        profile_id: "valentine",
        harness_id: "cursor",
        availability: "available",
        verification: "passed",
      },
      identity: { email: "valentine@example.test" },
    });
    expect(receipt.identity).not.toHaveProperty("plan");
  });

  it("keeps API-key profiles identity-free and does not run a native status probe", async () => {
    let nativeCalls = 0;
    const receipt = await probeCursorCredentialAccount(
      profile({
        credential_kind: "api_key",
        isolation_locator: null,
        secret_ref: "cursor:valentine",
      }),
      {
        nativeAuthOk: async () => {
          nativeCalls += 1;
          return { kind: "authenticated", email: "must-not-appear@example.test" };
        },
        resolveProfileSecret: () => "cursor-key",
      },
    );
    expect(nativeCalls).toBe(0);
    expect(receipt.identity).toBeNull();
    expect(receipt.status).toMatchObject({
      availability: "available",
      verification: "not_run",
    });
  });

  // Cursor strict profile routing at RUN level (INV-135), mirroring the codex
  // suite: the named identity is exactly its file-store HOME or a typed error
  // event — never the default Keychain session, key ladder, or a host bridge.
  describe("run routing", () => {
    const spec = (over: Partial<HarnessRunSpec> = {}): HarnessRunSpec =>
      HarnessRunSpec.parse({
        session_id: "s-cursor-profile",
        intent: "implement",
        prompt: "do it",
        cwd: "/repo",
        ...over,
      });

    it("pins the file-store env into BOTH the probe and the child and stamps events", async () => {
      let probedEnv: Record<string, string | null | undefined> | undefined;
      let cliOpts: CliRunLoopOptions | undefined;
      let stamped: HarnessEvent | undefined;
      const adapter = createCursorAdapter({
        detectVersion: async () => "cursor-test",
        nativeAuthOk: async (env) => {
          probedEnv = env;
          return { kind: "authenticated" };
        },
        cursorApiKey: () => {
          throw new Error("default key ladder must not run under a profile");
        },
        resolveProfileSecret: () => {
          throw new Error("secret store must not be read for a native profile");
        },
        runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
          cliOpts = opts;
          const out = opts.parseEvent?.({ type: "system", subtype: "init" }, "s1");
          for (const ev of out ?? []) {
            stamped = ev;
            yield ev;
          }
          yield { type: "completed", session_id: "s1", ts: new Date().toISOString() };
        },
      });
      const events: HarnessEvent[] = [];
      for await (const ev of adapter.run(
        spec({
          credential_profile: profile(),
          env: { HOME: "/tmp/thread-lane", CURSOR_API_KEY: "must-be-scrubbed" },
        }),
      ))
        events.push(ev);
      expect(events.some((e) => e.type === "error")).toBe(false);
      for (const env of [probedEnv, cliOpts?.env]) {
        expect(env).toMatchObject({
          HOME: home,
          CURSOR_CONFIG_DIR: "/tmp/thread-lane/.cursor",
          CURSOR_DATA_DIR: "/tmp/thread-lane/.cursor",
          AGENT_CLI_CREDENTIAL_STORE: "file",
          CURSOR_API_KEY: null,
        });
      }
      // A named profile must never receive the host login-Keychain bridge.
      expect(existsSync(join(home, "Library", "Keychains"))).toBe(false);
      expect(stamped?.credential_profile_id).toBe("valentine");
      expect(stamped?.credential_route).toBe("vendor_native");
    });

    // #363: the ENGINE stamps whether the row was an explicit pin; the adapter
    // never infers it from the profile, and an unstamped profile is a pin.
    const selected = (pinned: boolean | null): HarnessRunSpec => {
      const s = spec({ credential_profile: profile() });
      if (pinned !== null) stampCredentialProfileSelection(s, { pinned });
      return s;
    };
    const runOn = async (
      nativeAuthOk: () => Promise<CursorStatusObservation>,
      runSpec: HarnessRunSpec,
    ): Promise<{ events: HarnessEvent[]; launches: number }> => {
      let launches = 0;
      const adapter = createCursorAdapter({
        detectVersion: async () => "cursor-test",
        nativeAuthOk,
        cursorApiKey: () => {
          throw new Error("default key ladder must not run under a profile");
        },
        resolveProfileSecret: () => {
          throw new Error("secret store must not be read for a native profile");
        },
        runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
          launches += 1;
          expect(opts.env).toMatchObject({
            AGENT_CLI_CREDENTIAL_STORE: "file",
            CURSOR_API_KEY: null,
          });
          yield { type: "completed", session_id: "s1", ts: new Date().toISOString() };
        },
      });
      const events: HarnessEvent[] = [];
      for await (const ev of adapter.run(runSpec)) events.push(ev);
      return { events, launches };
    };
    const staleEvents = (events: HarnessEvent[]) =>
      events.filter((e) => e.payload?.["auth_status_stale"] === true);

    it("an unpinned choice starts on a timeout's bounded last positive, disclosed first (#363)", async () => {
      const { events, launches } = await runOn(
        async () => timedOutWithLastPositive,
        selected(false),
      );
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(events[0]).toMatchObject({
        type: "status",
        text: "[auth] cursor-agent status did not answer; using the last positive status answer from 2026-09-28T19:52:00.000Z (95000ms old)",
        payload: { auth_status_stale: true, auth_status_stale_age_ms: 95_000 },
      });
      expect(launches).toBe(1);
    });

    it.each([
      {
        label: "an explicit pin",
        pinned: true,
        reason: "Cursor did not confirm sign-in within 120s",
        rule: "never starts on an older one",
      },
      {
        label: "an unstamped profile",
        pinned: null,
        reason: "login state is unknown",
        rule: "never an explicit pin",
      },
    ])(
      "the same timed-out sequence refuses $label without launching (#363)",
      async ({ pinned, reason, rule }) => {
        const asked: unknown[] = [];
        const { events, launches } = await runOn(async (...args: unknown[]) => {
          asked.push(args[2]);
          return timedOutWithLastPositive;
        }, selected(pinned));
        expect(events.map((e) => e.type)).toEqual(["error", "completed"]);
        const error = (events[0] as { error?: string }).error ?? "";
        expect(error).toContain(reason);
        expect(error).toContain(rule);
        expect(error).not.toMatch(/run the profile login|auth login/);
        expect(staleEvents(events)).toEqual([]);
        expect(launches).toBe(0);
        // Only the engine's explicit pin stamp asks for the pin's wait (#532).
        expect(asked).toEqual([pinned ? { pinned: true } : undefined]);
      },
    );

    it("a stamp for another profile never admits the row it now carries (#363)", async () => {
      const runSpec = selected(false);
      runSpec.credential_profile = profile({ profile_id: "other" });
      const { events, launches } = await runOn(async () => timedOutWithLastPositive, runSpec);
      expect(events.map((e) => e.type)).toEqual(["error", "completed"]);
      expect(launches).toBe(0);
    });

    it("a timeout with no remembered positive refuses even an unpinned choice (#363)", async () => {
      const { lastPositive: _dropped, ...plainTimeout } = timedOutWithLastPositive;
      const { events, launches } = await runOn(async () => plainTimeout, selected(false));
      expect(events.map((e) => e.type)).toEqual(["error", "completed"]);
      expect((events[0] as { error?: string }).error).toContain("login state is unknown");
      expect(launches).toBe(0);
    });

    it("through the row store coordinator, only a live last positive starts an unpinned spawn: logout, credential mutation, expiry and other unknowns refuse (#363)", async () => {
      let now = Date.parse("2026-09-29T08:00:00.000Z");
      let next: CursorStatusObservation = { kind: "authenticated" };
      const coordinator = createCursorStatusCoordinator({
        probe: async () => next,
        monotonicMs: () => now,
        wallMs: () => now,
        mutating: () => false,
      });
      const timeout: CursorStatusObservation = {
        kind: "unknown",
        error: "cursor-agent status did not answer within 10s (SIGTERM); login state unknown",
        timedOut: true,
      };
      const step = async (
        observation: CursorStatusObservation,
        advanceMs: number,
        pinned: boolean,
      ) => {
        now += advanceMs;
        next = observation;
        const { events, launches } = await runOn(coordinator.status, selected(pinned));
        return { launched: launches === 1, stale: staleEvents(events).length === 1 };
      };
      const answered = { launched: true, stale: false };
      const onStale = { launched: true, stale: true };
      const refused = { launched: false, stale: false };
      const afterReuse = 61_000;

      // A fresh positive, then a timeout: unpinned starts disclosed, a pin refuses.
      expect(await step({ kind: "authenticated" }, 0, false)).toEqual(answered);
      expect(await step(timeout, afterReuse, false)).toEqual(onStale);
      expect(await step(timeout, 1_000, true)).toEqual(refused);
      // A positive logged-out answer revokes the store's last positive.
      expect(await step({ kind: "loggedOut" }, 1_000, false)).toEqual(refused);
      expect(await step(timeout, 1_000, false)).toEqual(refused);
      // A Claudexor credential mutation revokes it too.
      expect(await step({ kind: "authenticated" }, 1_000, false)).toEqual(answered);
      coordinator.clear();
      expect(await step(timeout, afterReuse, false)).toEqual(refused);
      // An expired last positive no longer stands in.
      expect(await step({ kind: "authenticated" }, 1_000, false)).toEqual(answered);
      expect(await step(timeout, CURSOR_STATUS_LAST_POSITIVE_MS, false)).toEqual(refused);
      // Only a timeout consults it: any other unknown answer refuses.
      expect(await step({ kind: "authenticated" }, 1_000, false)).toEqual(answered);
      expect(
        await step({ kind: "unknown", error: "status transport failed" }, afterReuse, false),
      ).toEqual(refused);
    });

    it("a logged-out named profile refuses typed without launching or falling back", async () => {
      let launches = 0;
      const adapter = createCursorAdapter({
        detectVersion: async () => "cursor-test",
        nativeAuthOk: async () => ({ kind: "loggedOut" }),
        cursorApiKey: () => {
          throw new Error("default key ladder must not run under a profile");
        },
        resolveProfileSecret: () => {
          throw new Error("secret store must not be read for a native profile");
        },
        runCliHarness: async function* (): AsyncGenerator<HarnessEvent> {
          launches += 1;
        },
      });
      const events: HarnessEvent[] = [];
      for await (const ev of adapter.run(spec({ credential_profile: profile() }))) events.push(ev);
      expect(events.map((e) => e.type)).toEqual(["error", "completed"]);
      expect((events[0] as { error?: string }).error).toContain("profile login");
      expect(launches).toBe(0);
    });
  });
});
