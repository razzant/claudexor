import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  EffortPreferenceRejectedError,
  canonicalIsolationLocator,
  composeSpawnEnv,
  type CliRunLoopOptions,
} from "@claudexor/core";
import { HarnessRunSpec, type CredentialProfile, type HarnessEvent } from "@claudexor/schema";
import { userConfigDir } from "@claudexor/util";
import { createGrokAdapter } from "./index.js";

const profile: CredentialProfile = {
  profile_id: "grok-evidence",
  harness_id: "grok",
  display_name: "evidence",
  credential_kind: "config_dir_login",
  isolation_locator: join(userConfigDir(), "profiles", "grok-evidence"),
  secret_ref: null,
  enabled: true,
  created_at: null,
};
const ready = async () => ({ authenticated: true, models: [], detail: "vendor confirmed" });
const spec = (extra = {}) =>
  HarnessRunSpec.parse({
    session_id: "s",
    intent: "explain",
    cwd: process.cwd(),
    prompt: "hello",
    credential_profile: profile,
    access: "readonly",
    ...extra,
  });
const recorded = (name: string): unknown[] =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
const collect = async (events: AsyncIterable<HarnessEvent>) => {
  const out: HarnessEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};

/** Replays native frames through the adapter's own parser and stop rule. */
function replay(frames: unknown[], launches: string[][] = []) {
  return createGrokAdapter({
    probeLogin: ready,
    runCli: async function* (opts) {
      launches.push(opts.args);
      for (const frame of frames) {
        for (const event of opts.parseEvent(frame, opts.spec.session_id) ?? []) {
          yield event;
          if (opts.stopAfterEvent?.(event)) return;
        }
      }
      yield {
        type: "completed",
        session_id: opts.spec.session_id,
        ts: new Date().toISOString(),
        payload: { exit_code: 0 },
      };
    },
  });
}

describe("pre-run login evidence", () => {
  it.each([
    [true, "timeout"],
    [false, "unknown"],
  ] as const)(
    "does not condemn the account when the pre-run probe is inconclusive (timed out: %s)",
    async (timedOut, kind) => {
      const runCli = vi.fn();
      const adapter = createGrokAdapter({
        probeLogin: async () => ({
          authenticated: false,
          failed: true,
          timedOut,
          models: [],
          detail: "grok models did not answer; login state is unknown",
        }),
        runCli,
      });
      const events = await collect(adapter.run(spec()));
      const error = events.find((event) => event.type === "error");
      // A typed transient, not an auth verdict: retry may run, rotation does
      // not record the credential as dead.
      expect(error).toMatchObject({
        transient: { kind },
        payload: { code: "grok_login_probe_inconclusive" },
      });
      expect(error?.status).toBeUndefined();
      expect(events.at(-1)?.type).toBe("completed");
      expect(runCli).not.toHaveBeenCalled();
    },
  );

  it("ends a run cancelled during the probe as aborted, without a failure", async () => {
    const runCli = vi.fn();
    const cancel = new AbortController();
    const adapter = createGrokAdapter({
      probeLogin: async () => {
        cancel.abort();
        return { authenticated: false, failed: true, models: [], detail: "cancelled" };
      },
      runCli,
    });
    const events = await collect(adapter.run(spec({ extra: { abortSignal: cancel.signal } })));
    expect(events).toMatchObject([{ type: "completed", aborted: true }]);
    expect(runCli).not.toHaveBeenCalled();
  });

  it("still refuses before spawning on an explicit vendor sign-in refusal", async () => {
    const runCli = vi.fn();
    const adapter = createGrokAdapter({
      probeLogin: async () => ({ authenticated: false, models: [], detail: "logged out" }),
      runCli,
    });
    await expect(collect(adapter.run(spec()))).rejects.toThrow("logged out");
    expect(runCli).not.toHaveBeenCalled();
  });
});

describe("shared effort placement", () => {
  it.each([
    ["none", "low", "floor"],
    ["minimal", "low", "floor"],
    ["low", "low", "exact"],
    ["xhigh", "xhigh", "exact"],
    ["max", "xhigh", "downward"],
    ["ultra", "xhigh", "downward"],
  ])("submits %s as %s (%s) and the receipt matches argv", async (requested, sent, resolution) => {
    const launches: string[][] = [];
    const events = await collect(
      replay(recorded("ask.jsonl"), launches).run(spec({ effort_hint: requested })),
    );
    const receipt = events.find((event) => event.effort_resolution)?.effort_resolution;
    expect(receipt).toMatchObject({ requested, submitted: sent, resolution });
    const args = launches[0]!;
    expect(args[args.indexOf("--reasoning-effort") + 1]).toBe(receipt?.submitted);
  });

  it("omits the flag without a preference and still rejects an unplaceable word", async () => {
    const launches: string[][] = [];
    await collect(replay(recorded("ask.jsonl"), launches).run(spec()));
    expect(launches[0]).not.toContain("--reasoning-effort");
    const runCli = vi.fn();
    await expect(
      collect(createGrokAdapter({ probeLogin: ready, runCli }).run(spec({ effort_hint: "turbo" }))),
    ).rejects.toBeInstanceOf(EffortPreferenceRejectedError);
    expect(runCli).not.toHaveBeenCalled();
  });
});

describe("credential source evidence", () => {
  it("confirms session login (`oauth`, recorded 1.0.67) from Grok's own init", async () => {
    const events = await collect(replay(recorded("ask.jsonl")).run(spec()));
    expect(events.find((event) => event.type === "started")).toMatchObject({
      credential_route: "vendor_native",
      credential_source: "native_session",
      credential_profile_id: "grok-evidence",
    });
    expect(events.find((event) => event.final)?.text).toBe("OK");
  });

  it("keeps the source unknown when Grok does not report it", async () => {
    const [init, ...rest] = recorded("ask.jsonl") as Record<string, unknown>[];
    const { apiKeySource: _dropped, ...silent } = init!;
    const events = await collect(replay([silent, ...rest]).run(spec()));
    expect(events.some((event) => event.credential_source !== undefined)).toBe(false);
    expect(events.every((event) => event.credential_route === "vendor_native")).toBe(true);
    expect(
      events.find((event) => event.payload?.code === "grok_credential_source_unreported"),
    ).toBeTruthy();
    expect(events.some((event) => event.request_refusal)).toBe(false);
    expect(events.find((event) => event.final)?.text).toBe("OK");
  });

  // `user` is the guide's API-key value; any other value is unverified too.
  it.each(["user", "api_key"])(
    "stops before any answer when Grok reports source %s",
    async (source) => {
      const [init, ...rest] = recorded("ask.jsonl") as Record<string, unknown>[];
      const events = await collect(
        replay([{ ...init, apiKeySource: source }, ...rest]).run(spec()),
      );
      const refusal = events.find((event) => event.type === "error");
      expect(refusal?.payload).toMatchObject({
        code: "grok_credential_source_unconfirmed",
        reported_source: source,
      });
      // Typed for the engine's request-refusal stop: no retry, no rotation.
      expect(refusal?.request_refusal).toEqual({
        kind: "credential_source_unconfirmed",
        native_code: "grok_credential_source_unconfirmed",
        source: "grok_init",
        reported_source: source,
      });
      // `oauth` is named as session login; it does not identify grok.com.
      expect(refusal?.error).not.toContain("grok.com");
      expect(refusal?.status).toBeUndefined();
      expect(events.some((event) => event.final || event.type === "usage")).toBe(false);
      expect(events.some((event) => event.credential_source !== undefined)).toBe(false);
    },
  );

  it.each([
    ["readonly", { tools: ["read_file", "list_dir", "grep", "run_terminal_cmd"] }],
    ["readonly", { permissionMode: "default" }],
    ["workspace_write", { tools: "read_file" }],
  ] as const)(
    "%s: a reported key source is the typed refusal even when the tool policy also differs (%j)",
    async (access, policy) => {
      const [init, ...rest] = recorded("ask.jsonl") as Record<string, unknown>[];
      const events = await collect(
        replay([{ ...init, ...policy, apiKeySource: "user" }, ...rest]).run(spec({ access })),
      );
      const errors = events.filter((event) => event.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.payload).toMatchObject({
        code: "grok_credential_source_unconfirmed",
        reported_source: "user",
      });
      expect(errors[0]?.request_refusal).toMatchObject({
        kind: "credential_source_unconfirmed",
        reported_source: "user",
      });
      expect(events.some((event) => event.final || event.type === "usage")).toBe(false);
    },
  );

  it("keeps a tool-policy contradiction under session login an untyped access refusal (control)", async () => {
    const [init, ...rest] = recorded("ask.jsonl") as Record<string, unknown>[];
    for (const frame of [
      { ...init, permissionMode: "default" },
      { ...init, permissionMode: "default", apiKeySource: undefined },
    ]) {
      const events = await collect(replay([frame, ...rest]).run(spec()));
      const errors = events.filter((event) => event.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.payload?.code).toBe("grok_access_policy_unconfirmed");
      expect(errors[0]?.request_refusal).toBeUndefined();
      expect(events.some((event) => event.final)).toBe(false);
    }
  });
});

describe("subscription cost basis", () => {
  it("marks native work included with an unobserved debit, never a priced charge", async () => {
    const events = await collect(replay(recorded("ask.jsonl")).run(spec()));
    for (const event of events)
      expect(event.processing_cost_basis, event.type).toMatchObject({
        kind: "included",
        debit: "unobserved",
      });
    expect(events.find((event) => event.type === "usage")?.usage?.cost_usd).toBeUndefined();
  });

  it("prepares the same basis for engine routing and discloses an unavailable tier", async () => {
    const adapter = createGrokAdapter({ probeLogin: ready });
    const prepared = await adapter.prepareProcessing!({
      cwd: process.cwd(),
      credentialProfile: profile,
      preference: "fast",
      model: "grok-4.7",
      effort: null,
    });
    expect(prepared).toMatchObject({
      model: "grok-4.7",
      receipt: { requested: "fast", submitted: null, reason: "processing_control_unavailable" },
      costBasis: { kind: "included", debit: "unobserved" },
    });
    expect(prepared.effort).toBeUndefined();
    const unprofiled = await adapter.prepareProcessing!({
      cwd: process.cwd(),
      model: null,
      effort: null,
    });
    expect(unprofiled.costBasis.kind).toBe("unknown");
    expect(unprofiled.costBasis.debit).toBeUndefined();
  });
});

describe("web_fetch under a web-off policy", () => {
  /** The child env exactly as the run loop composes it from the parent. */
  async function childEnv(extra: Record<string, unknown>) {
    let invocation: CliRunLoopOptions | undefined;
    const adapter = createGrokAdapter({
      probeLogin: ready,
      runCli: async function* (opts) {
        invocation = opts;
      },
    });
    await collect(adapter.run(spec(extra)));
    return { args: invocation!.args, env: composeSpawnEnv("mirror_native", invocation!.env) };
  }

  it.each([
    ["full", { tool_permission_policy: { web: "off", allow: [], deny: [] } }],
    ["full", { external_context_policy: "off" }],
    ["readonly", { tool_permission_policy: { web: "off", allow: [], deny: [] } }],
  ] as const)("%s: an inherited GROK_WEB_FETCH=1 is pinned to 0 (%j)", async (access, policy) => {
    const inherited = process.env.GROK_WEB_FETCH;
    process.env.GROK_WEB_FETCH = "1";
    try {
      const child = await childEnv({ access, ...policy, env: { GROK_WEB_FETCH: "1" } });
      expect(child.env.GROK_WEB_FETCH).toBe("0");
      expect(child.args).toContain("--disable-web-search");
      // Explicit full stays full: only the web tool switch changes.
      if (access === "full") expect(child.args).toContain("--always-approve");
    } finally {
      if (inherited === undefined) delete process.env.GROK_WEB_FETCH;
      else process.env.GROK_WEB_FETCH = inherited;
    }
  });

  it("leaves the vendor switch alone when web is allowed (control)", async () => {
    const child = await childEnv({ access: "full", env: { GROK_WEB_FETCH: "1" } });
    expect(child.env.GROK_WEB_FETCH).toBe("1");
    expect(child.args).not.toContain("--disable-web-search");
    expect(child.args).toContain("--always-approve");
  });
});

describe("workspace roots that a permission rule cannot carry", () => {
  it("refuses a comma in the workspace_write root, and only there", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-comma-"));
    const cwd = join(root, "a,b");
    mkdirSync(cwd);
    try {
      const runCli = vi.fn(async function* (): AsyncGenerator<HarnessEvent> {});
      const adapter = createGrokAdapter({ probeLogin: ready, runCli });
      await expect(collect(adapter.run(spec({ access: "workspace_write", cwd })))).rejects.toThrow(
        /permission-rule metacharacters/,
      );
      expect(runCli).not.toHaveBeenCalled();
      // readonly and explicit full carry no root rule and stay available.
      for (const access of ["readonly", "full"] as const)
        await collect(adapter.run(spec({ access, cwd })));
      expect(runCli).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("applied HOME evidence", () => {
  it("names the profile HOME its child actually receives", () => {
    const adapter = createGrokAdapter();
    const live = spec({ env: { HOME: "/engine/lane/home" } });
    expect(adapter.childHome?.(live)).toBe(
      canonicalIsolationLocator(profile.isolation_locator!, "test"),
    );
    expect(adapter.childHome?.(spec({ credential_profile: null }))).toBeNull();
  });
});
