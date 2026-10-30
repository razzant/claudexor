import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  AccessProfileIncompatibleError,
  EffortPreferenceRejectedError,
  HarnessUnavailableError,
  streamExpectationViolations,
  validateTypedStream,
} from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { createAcpAdapter, copilot } from "./index.js";

const secrets = vi.hoisted(() => ({ token: "fixture-managed-token" as string | null }));
vi.mock("@claudexor/secrets", async (original) => ({
  ...(await original<object>()),
  resolveSecret: () => secrets.token,
}));
const root = mkdtempSync(join(tmpdir(), "acp-adapter-"));
const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const basic = join(fixtures, "recorded-basic.jsonl");
const manifest = parse(readFileSync(join(fixtures, "manifest.yaml"), "utf8")) as {
  fixtures: Record<string, { expectations: Parameters<typeof streamExpectationViolations>[1] }>;
};
let index = 0;
const adapter = (mode = "replay", fixture = basic) => {
  const log = join(root, `commands-${++index}.jsonl`);
  return {
    log,
    adapter: createAcpAdapter({
      ...copilot,
      binary: process.execPath,
      binaryEnv: "CLAUDEXOR_TEST_ACP_BIN",
      flags: [join(fixtures, "agent.mjs"), mode, fixture, log],
    }),
  };
};
const spec = (patch = {}) =>
  HarnessRunSpec.parse({
    session_id: `s-${++index}`,
    intent: "implement",
    cwd: root,
    prompt: "Do the fixture task",
    ...patch,
  });
const collect = async (events: AsyncIterable<HarnessEvent>) => {
  const result = [];
  for await (const event of events) result.push(event);
  return result;
};
const commands = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, any>);
beforeEach(() => {
  secrets.token = "fixture-managed-token";
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("ACP adapter over stdio", () => {
  it.each(Object.entries(manifest.fixtures))(
    "replays %s with declared stream semantics",
    async (name, evidence) => {
      const peer = adapter("replay", join(fixtures, name));
      const events = await collect(peer.adapter.run(spec()));
      expect(validateTypedStream(events).completed).toBe(1);
      expect(streamExpectationViolations(events, evidence.expectations)).toEqual([]);
      expect(commands(peer.log).filter((c) => c["method"] === "session/prompt")).toHaveLength(1);
      if (name === "recorded-basic.jsonl") {
        const raw = readFileSync(basic, "utf8")
          .split("\n")
          .find((line) => line.startsWith(" {"))!;
        expect(
          events.some((event) => (event.payload?.["acp_frame"] as any)?.line === `${raw}\n`),
        ).toBe(true);
        expect(events.filter((event) => event.usage).map((event) => event.usage)).toEqual([
          { cost_usd: 0.125 },
        ]);
      }
      if (name === "recorded-unfinished.jsonl")
        expect(events.find((event) => event.type === "error")?.payload?.["code"]).toBe(
          "unfinished_turn",
        );
    },
  );

  it.each(["fake", "server"])(
    "conforms against %s using the same SDK and harness-fake",
    async (mode) => {
      const events = await collect(adapter(mode).adapter.run(spec()));
      expect(validateTypedStream(events)).toMatchObject({ started: 1, completed: 1, errors: 0 });
      expect(
        streamExpectationViolations(events, {
          final_messages: 1,
          final_source: "session/prompt",
          final_is_last_message: true,
        }),
      ).toEqual([]);
    },
  );

  it.each(["refusal", "max_tokens", "max_turn_requests", "cancelled"])(
    "handles stop reason %s",
    async (stop) => {
      const path = join(root, `${stop}.jsonl`);
      writeFileSync(path, readFileSync(basic, "utf8").replace('"end_turn"', JSON.stringify(stop)));
      const events = await collect(adapter("replay", path).adapter.run(spec()));
      expect(events.filter((e) => e.final)).toHaveLength(0);
      expect(events.filter((e) => e.type === "error")).toHaveLength(stop === "cancelled" ? 0 : 1);
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        payload: { aborted: stop === "cancelled" },
      });
    },
  );

  it.each(["disconnect", "oversize", "malformed"])(
    "fails %s after dispatch without resending",
    async (mode) => {
      const peer = adapter(mode);
      const events = await collect(peer.adapter.run(spec()));
      expect(events.filter((e) => e.type === "completed")).toHaveLength(1);
      expect(events.find((e) => e.type === "error")).toMatchObject({
        payload: { prompt_delivery: "possibly_delivered", retryable: false },
      });
      expect(commands(peer.log).filter((c) => c["method"] === "session/prompt")).toHaveLength(1);
    },
  );

  it.each([
    ["held-exit", "truncated"],
    ["disconnect", undefined],
  ])(
    "discloses a forced post-exit drain on the completed event: %s",
    async (mode, drain) => {
      const events = await collect(adapter(mode).adapter.run(spec()));
      expect(events.find((e) => e.type === "error")).toMatchObject({
        payload: { prompt_delivery: "possibly_delivered", retryable: false },
      });
      const completed = events.at(-1);
      expect(completed?.type).toBe("completed");
      expect(completed?.payload?.["output_drain"]).toBe(drain);
    },
    20_000,
  );

  // The client stops reading at the prompt result and only then ends the agent,
  // so a pipe a descendant keeps afterwards cuts nothing that was being read.
  it("claims no forced drain after a successful answer while a descendant still holds stdout", async () => {
    const peer = adapter("reply-held");
    const events = await collect(peer.adapter.run(spec()));
    const holder = Number(readFileSync(`${peer.log}.holder`, "utf8"));
    try {
      expect(() => process.kill(holder, 0)).not.toThrow(); // closing our side is not its death
      expect(validateTypedStream(events)).toMatchObject({ started: 1, completed: 1, errors: 0 });
      expect(events.filter((e) => e.final)).toHaveLength(1);
      expect(events.at(-1)?.payload).toEqual({ aborted: false });
    } finally {
      writeFileSync(`${peer.log}.stop`, "stop only this fixture\n");
      await vi.waitFor(() => expect(() => process.kill(holder, 0)).toThrow(), { timeout: 5_000 });
    }
  }, 20_000);

  it("sends cancel and proves the child and grandchild dead before returning", async () => {
    const peer = adapter("hang");
    const request = spec();
    const result = collect(peer.adapter.run(request));
    let pids: Record<string, any> | undefined;
    try {
      // Budget offline peer startup within the existing 30s test deadline.
      await vi.waitFor(
        () => {
          pids = commands(peer.log).find((line) => line["pid"]);
          expect(pids).toBeDefined();
        },
        { timeout: 10_000 },
      );
      await peer.adapter.cancel!(request.session_id);
      const events = await result;
      expect(events.at(-1)).toMatchObject({ type: "completed", payload: { aborted: true } });
      for (const pid of [pids!["pid"], pids!["child"]])
        expect(() => process.kill(pid, 0)).toThrow();
      expect(commands(peer.log).some((line) => line["method"] === "session/cancel")).toBe(true);
    } finally {
      try {
        await peer.adapter.cancel!(request.session_id);
      } finally {
        await result;
      }
    }
  });

  it("uses only the managed token and scoped home in the real child", async () => {
    vi.stubEnv("GH_TOKEN", "ambient-gh");
    vi.stubEnv("GITHUB_TOKEN", "ambient-github");
    vi.stubEnv("COPILOT_GITHUB_TOKEN", "ambient-copilot");
    try {
      const events = await collect(adapter("environment").adapter.run(spec()));
      const frame = events
        .map((e) => e.payload?.["acp_frame"] as { line?: string } | undefined)
        .find((f) => f?.line?.includes('"method":"fixture/environment"'));
      const env = JSON.parse(frame!.line!).params;
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.COPILOT_GITHUB_TOKEN).toBe("[REDACTED]");
      expect(env.COPILOT_HOME).toBe(join(env.HOME, ".copilot"));
      expect(env.HOME).not.toBe(process.env["HOME"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // INV-146: the answer is working content and arrives exact even when it holds
  // a credential-shaped fixture; only the managed token the engine injected is
  // removed, and the agent's JSON-RPC error diagnostics are masked.
  it("keeps a credential-shaped answer exact and masks only the token and diagnostics", async () => {
    const work = ["ghp", "AcpW0rk7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Yc2"].join("_");
    const vendor = ["sk-proj", "AcpVendor", "q7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Yc2Ae9U"].join("-");
    const [initialize, session] = readFileSync(basic, "utf8").split("\n");
    const chunk = (text: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "native",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      });
    const answered = join(root, "credential-shaped-answer.jsonl");
    writeFileSync(
      answered,
      [
        initialize,
        session,
        chunk(`Fixture: const token = "${work}"; managed fixture-managed-token.`),
        JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } }),
      ].join("\n"),
    );
    const events = await collect(adapter("replay", answered).adapter.run(spec()));
    const final = events.find((e) => e.final);
    expect(final?.text).toBe(`Fixture: const token = "${work}"; managed [REDACTED].`);
    expect(JSON.stringify(events)).not.toContain("fixture-managed-token");

    const failed = join(root, "credential-shaped-error.jsonl");
    writeFileSync(
      failed,
      [
        initialize,
        session,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          error: { code: -32603, message: `upstream rejected ${vendor}` },
        }),
      ].join("\n"),
    );
    const failure = await collect(adapter("replay", failed).adapter.run(spec()));
    expect(failure.find((e) => e.type === "error")?.text).toContain("upstream rejected");
    expect(JSON.stringify(failure)).not.toContain(vendor);
  });

  it("honors an already-aborted signal without starting a process", async () => {
    const abort = new AbortController();
    abort.abort();
    const events = await collect(
      adapter().adapter.run(spec({ extra: { abortSignal: abort.signal } })),
    );
    expect(events).toEqual([
      expect.objectContaining({ type: "completed", payload: { aborted: true } }),
    ]);
  });

  it("reaps the peer when the consumer stops reading", async () => {
    const peer = adapter("hang");
    const stream = peer.adapter.run(spec())[Symbol.asyncIterator]();
    // Advance through the prompt transcript; the peer then parks with a child.
    for (;;) {
      const event = await stream.next();
      if (JSON.stringify(event.value).includes("session/prompt")) break;
    }
    let pids: Record<string, any> | undefined;
    await vi.waitFor(() => {
      pids = commands(peer.log).find((line) => line["pid"]);
      expect(pids).toBeDefined();
    });
    await stream.return?.();
    for (const pid of [pids!["pid"], pids!["child"]]) expect(() => process.kill(pid, 0)).toThrow();
  });

  it("throws typed pre-spawn refusals and keeps the session id reusable", async () => {
    const peer = adapter();
    const request = spec({
      access: "full",
      tool_permission_policy: { web: "auto", allow: ["bash"], deny: ["bash"] },
    });
    await expect(collect(peer.adapter.run(request))).rejects.toMatchObject({
      code: "access_profile_incompatible",
    });
    await expect(collect(peer.adapter.run(request))).rejects.toBeInstanceOf(
      AccessProfileIncompatibleError,
    );
    secrets.token = null;
    await expect(collect(peer.adapter.run(spec()))).rejects.toBeInstanceOf(HarnessUnavailableError);
    expect(existsSync(peer.log)).toBe(false);
    secrets.token = "fixture-managed-token";
    request.tool_permission_policy.deny = [];
    const events = await collect(peer.adapter.run(request));
    expect(validateTypedStream(events)).toMatchObject({ started: 1, completed: 1, errors: 0 });
  });

  it("resolves effort once: the receipt's submitted value is the --effort the child receives", async () => {
    // `ultra` is not on the entry's ladder (it stops at max): the shared
    // preference order places it and the run resolves downward, disclosed.
    const events = await collect(adapter("argv").adapter.run(spec({ effort_hint: "ultra" })));
    const receipt = events.find((event) => event.effort_resolution);
    expect(receipt?.effort_resolution).toMatchObject({
      requested: "ultra",
      submitted: "max",
      resolution: "downward",
      source: "adapter",
      parameter: "--effort",
    });
    expect(receipt?.text).toContain("shared preference order");
    // The receipt precedes the start, like the other knob adapters.
    expect(events.indexOf(receipt!)).toBeLessThan(events.findIndex((e) => e.type === "started"));
    const frame = events
      .map((e) => e.payload?.["acp_frame"] as { line?: string } | undefined)
      .find((f) => f?.line?.includes('"method":"fixture/argv"'));
    const argv = JSON.parse(frame!.line!).params.argv as string[];
    expect(argv[argv.indexOf("--effort") + 1]).toBe("max");
    expect(validateTypedStream(events)).toMatchObject({ started: 1, completed: 1, errors: 0 });
  });

  it("records an omitted receipt and sends no --effort when nothing was requested", async () => {
    const events = await collect(adapter("argv").adapter.run(spec()));
    expect(events.find((event) => event.effort_resolution)?.effort_resolution).toMatchObject({
      requested: null,
      submitted: null,
      resolution: "omitted",
    });
    const frame = events
      .map((e) => e.payload?.["acp_frame"] as { line?: string } | undefined)
      .find((f) => f?.line?.includes('"method":"fixture/argv"'));
    expect(JSON.parse(frame!.line!).params.argv).not.toContain("--effort");
  });

  it("refuses a word neither order places before spawn, typed, and keeps the session reusable", async () => {
    const peer = adapter();
    const request = spec({ effort_hint: "ulta" });
    const events: HarnessEvent[] = [];
    const run = async () => {
      for await (const event of peer.adapter.run(request)) events.push(event);
    };
    await expect(run()).rejects.toBeInstanceOf(EffortPreferenceRejectedError);
    expect(events).toEqual([
      expect.objectContaining({
        effort_resolution: expect.objectContaining({
          requested: "ulta",
          submitted: null,
          resolution: "rejected",
        }),
      }),
    ]);
    expect(existsSync(peer.log)).toBe(false);
    request.effort_hint = "high";
    expect(validateTypedStream(await collect(peer.adapter.run(request)))).toMatchObject({
      started: 1,
      completed: 1,
      errors: 0,
    });
  });

  it.each([
    [{ resume_session_id: "old" }, "resume_unsupported"],
    [{ auth_preference: "subscription" }, "auth_profile_incompatible"],
    [{ external_context_policy: "off" }, "web_policy_incompatible"],
    [{ extra_mcp_servers: [{ name: "test", command: "/missing" }] }, "mcp_unsupported"],
  ])("refuses unsupported requests before spawn", async (patch, code) => {
    const events = await collect(adapter().adapter.run(spec(patch)));
    expect(events.find((e) => e.type === "error")?.payload?.["code"]).toBe(code);
    expect(events.some((e) => e.type === "started")).toBe(false);
  });
});

describe("ACP discovery and free/explicit probes", () => {
  it("declares conservative capabilities and no native account login", async () => {
    const manifest = await adapter().adapter.discover();
    expect(manifest).toMatchObject({
      id: "copilot",
      provider_family: "unknown",
      auth_modes: ["api_key"],
      capabilities: {
        json_schema_output: false,
        work_report_transport: "validated",
        model_inventory_absence: "advisory",
        web_policy: "uncontrolled",
        tool_lists: true,
      },
      capability_profile: {
        access_control: { readonly_mechanism: "tool_allowlist", write_mechanism: "none" },
        mcp_injection: false,
        live_input: "none",
      },
    });
    expect(manifest.capabilities.effort_levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
  it("default doctor sends no prompt; model inventory uses configOptions", async () => {
    const peer = adapter();
    const report = await peer.adapter.doctor({ cwd: root });
    expect(report.status).toBe("degraded");
    expect(report.auth_sources[0]?.verification).toBe("not_run");
    expect(commands(peer.log).map((c) => c["method"])).toEqual(["initialize", "session/new"]);
    expect(await peer.adapter.models!({ cwd: root })).toEqual([
      expect.objectContaining({ id: "fixture-model", origin: "live" }),
    ]);
    expect(commands(peer.log).some((c) => c["method"] === "session/prompt")).toBe(false);
  });
  it.each([false, true])("credits write policy only with a callback: %s", async (permission) => {
    const peer = adapter(
      "replay",
      permission ? join(fixtures, "recorded-permission.jsonl") : basic,
    );
    const report = await peer.adapter.doctor({ cwd: root, conformance: true });
    expect(report.checks.find((c) => c.id === "write_conformance")?.status).toBe(
      permission ? "pass" : "fail",
    );
    expect(peer.adapter.capabilityProfile?.access_control.write_mechanism).toBe(
      permission ? "tool_policy" : "none",
    );
    const prompt = commands(peer.log).filter((c) => c["method"] === "session/prompt");
    expect(prompt).toHaveLength(1);
    const cwd = commands(peer.log).find((c) => c["method"] === "session/new")!["params"].cwd;
    expect(resolve(cwd)).not.toBe(root);
  });
  // Remote install reads the `installed` check after the installer exits; the
  // shared readiness table maps it (and `api_key`) for every surface.
  it("keeps the installed check when a later doctor step fails", async () => {
    const checks = async (target: ReturnType<typeof createAcpAdapter>) =>
      (await target.doctor({ cwd: root })).checks.map((c) => [c.id, c.status, c.detail]);
    expect(await checks(adapter().adapter)).toEqual([
      ["installed", "pass", undefined],
      ["api_key", "pass", undefined],
      ["acp_session", "pass", expect.any(String)],
      ["write_conformance", "skip", expect.any(String)],
    ]);
    expect(await checks(adapter("auth").adapter)).toEqual([
      ["installed", "pass", undefined],
      ["api_key", "pass", undefined],
      ["not_logged_in", "fail", expect.stringContaining("not logged in")],
    ]);
    const missing = createAcpAdapter({
      ...copilot,
      binary: join(root, "missing"),
      binaryEnv: "CLAUDEXOR_TEST_ACP_BIN",
    });
    expect(await checks(missing)).toEqual([
      ["installed", "fail", expect.stringContaining("not installed")],
    ]);
    secrets.token = null;
    expect(await checks(adapter().adapter)).toEqual([
      ["installed", "pass", undefined],
      ["api_key", "fail", expect.stringContaining("store the copilot secret")],
    ]);
  });

  it("types auth-required, missing binary/token, protocol mismatch and hint fallback", async () => {
    expect((await adapter("auth").adapter.doctor({ cwd: root })).reasons.join()).toContain(
      "not_logged_in",
    );
    expect((await adapter("protocol").adapter.doctor({ cwd: root })).reasons.join()).toContain(
      "protocol_version",
    );
    const missing = createAcpAdapter({
      ...copilot,
      binary: join(root, "missing"),
      binaryEnv: "CLAUDEXOR_TEST_ACP_BIN",
    });
    expect((await missing.doctor({ cwd: root })).status).toBe("unavailable");
    secrets.token = null;
    expect((await adapter().adapter.doctor({ cwd: root })).reasons.join()).toContain(
      "not logged in",
    );
    expect(await adapter().adapter.models!({ cwd: root })).toEqual(
      copilot.modelHints.map((id) => expect.objectContaining({ id, origin: "hint" })),
    );
  });
});
