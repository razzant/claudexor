import { afterAll, describe, expect, it, vi } from "vitest";
import { invalidateDoctorCache } from "@claudexor/core";
import { recorder, resetRecorder } from "./test-support/profile-admission-adapters.js";
import {
  closeDaemons,
  configure,
  finishFixture,
  http,
  openDaemon,
  repository,
  terminal,
  upload,
} from "./test-support/profile-admission-daemon.js";
import { mcpWire } from "./test-support/interaction-daemon.js";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { noProjectRepoRoot } from "@claudexor/util";
import { resetZero, zero } from "./test-support/zero-budget-adapters.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";
import * as daemonRun from "./daemon-run.js";

// Hoisted above every import (same shape as profile-login-win32.integration.test.ts): production
// modules capture the projectless root when they load, so this file's one owned sandbox must exist
// first. Once every close returned in time, the last hook restores its env, then removes it.
const vendorSandbox = await vi.hoisted(async () => {
  const { createVendorSandbox } = await import("./test-support/zero-budget-sandbox.js");
  return createVendorSandbox();
});

// A plain read-only Ask at an effective $0 paid limit must never send a paid
// diagnostic generation request while checking which executors are available,
// and a ready subscription must still answer. Production-shaped consumers: the
// real MCP `claudexor_ask` tool over an in-memory JSON-RPC wire -> the real
// Control API, queue, daemon runner and Orchestrator -> the REAL Claude/Codex
// adapters over vendor stubs (test-support/zero-budget-adapters.ts) whose smoke
// boundary is a counter. Fictitious credentials only; no provider starts.

vi.mock("./registry.js", async (original) => {
  const actual = await original<typeof import("./registry.js")>();
  const { HarnessGateway } = await import("@claudexor/gateway");
  const { zero, zeroRegistry, meteredAdapter } =
    await import("./test-support/zero-budget-adapters.js");
  const registry = (options: { includeFakes?: boolean } = {}) => {
    const lanes = [...zeroRegistry];
    if (zero.metered.present) lanes.push([meteredAdapter.id, meteredAdapter]);
    return new Map(
      lanes.filter(([id]) => options.includeFakes !== false || !id.startsWith("fake-")),
    );
  };
  return {
    ...actual,
    buildRegistry: registry,
    buildGateway: (options: { includeFakes?: boolean } = {}) =>
      new HarnessGateway(registry(options)),
  };
});

const cleanups: Array<() => void | Promise<void>> = [];
afterEachClosed(async () => {
  // Everything this test owns is taken or reset before the first await, so a close
  // that outlives its deadline can never touch the next test's handles.
  const owned = cleanups.splice(0).reverse();
  // Counted before the first await; only the returned tail lowers it again, so a close that
  // rejects or times out leaves the sandbox in place for its still-running tail.
  vendorSandbox.openCloses += 1;
  vi.restoreAllMocks();
  resetRecorder();
  resetZero();
  invalidateDoctorCache();
  const handOverFolders = await closeDaemons();
  for (const close of owned) await close();
  return () => {
    handOverFolders();
    vendorSandbox.openCloses -= 1;
  };
}, 60_000);
afterAll(() => {
  finishFixture();
  // Exactly this file's sandbox, and only when every close finished in time: its captured
  // environment comes back first, then its folder goes. Otherwise both stay for this worker.
  if (vendorSandbox.openCloses !== 0) return;
  vendorSandbox.restoreEnv();
  rmSync(vendorSandbox.root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts); no observations path, so a neighbouring file's evidence is never overwritten

const ZERO = { kind: "finite", maxUsd: 0 } as const;
const UNLIMITED = { kind: "unlimited" } as const;

async function setup(options: {
  settingsBudget?: typeof ZERO | typeof UNLIMITED;
  preferSubscription?: boolean;
}) {
  invalidateDoctorCache();
  const { settingsBudget, preferSubscription } = options;
  configure([], [], (config) => ({
    ...(settingsBudget
      ? { budget: { ...config.budget, paid_budget_per_run: settingsBudget } }
      : {}),
    ...(preferSubscription
      ? { routing: { ...config.routing, auth_preference: "subscription" as const } }
      : {}),
  }));
  const daemon = await openDaemon();
  const repo = await repository(daemon);
  vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
    client: daemon.client as never,
    addr: { baseUrl: daemon.base, token: "fixture" },
    engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" } as never,
  });
  vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
    client: daemon.client as never,
    addr: { baseUrl: daemon.base, token: "fixture" },
    engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" } as never,
  } as never);
  const mcp = mcpWire(cleanups);
  await mcp.start();
  /** The real MCP `claudexor_ask` call, then its terminal `claudexor_run_result`. */
  const ask = async (scope: "project" | "none", extra: Record<string, unknown> = {}) => {
    const started = await mcp.tool("claudexor_ask", {
      prompt: "what is 2+2",
      ...(scope === "project" ? { repoPath: repo } : { noProject: true }),
      ...extra,
    });
    const handle = started.result?.structuredContent;
    expect(handle?.runId, JSON.stringify(started)).toBeTruthy();
    const run = await terminal(daemon, String(handle.runId));
    const result = await mcp.tool("claudexor_run_result", { runId: handle.runId });
    return { run, result: result.result?.structuredContent as Record<string, any> | undefined };
  };
  return { daemon, repo, ask };
}

const probes = () => Object.values(zero.paidProbeCalls).reduce((a, b) => a + b, 0);

describe("read-only Ask at an effective $0 paid limit", () => {
  it.each(["project", "none"] as const)(
    "a ready subscription account answers with no paid diagnostic request (%s scope)",
    async (scope) => {
      // A ready native session beside every fictitious key and setup-token source.
      zero.sources = {
        nativeClaude: true,
        anthropicKey: true,
        claudeSetupToken: true,
        openaiKey: true,
      };
      // No metrics file and no earlier run: the route is known only from the
      // ready native session itself.
      const { ask } = await setup({});
      // The daemon opened inside the file's one owned sandbox, fixed before production modules
      // loaded: control-services captured its projectless root at load and created it on open; a
      // binding that predated the sandbox would have created the ambient one instead.
      const captured = join(vendorSandbox.home, ".cache", "claudexor", "no-project");
      expect(noProjectRepoRoot()).toBe(captured);
      expect(statSync(captured).isDirectory()).toBe(true);
      expect(process.env["HOME"]).toBe(vendorSandbox.home);
      expect(process.env["USERPROFILE"]).toBe(vendorSandbox.home);
      expect(process.env["CLAUDEXOR_CLAUDE_BIN"]).toBe(
        join(vendorSandbox.root, "absent", "claude"),
      );
      expect(process.env["CLAUDEXOR_CLAUDE_NATIVE_DIR"]).toBeUndefined();
      expect(process.env["CLAUDEXOR_CODEX_NATIVE_HOME"]).toBeUndefined();
      const { run, result } = await ask(scope, { paidBudget: ZERO });
      expect(run.state, String(run.error)).toBe("succeeded");
      // The answer is the fake execution's own text, read through the real MCP projection.
      expect(result?.["summary"]).toBe("done");
      // The spec the engine built pins the verified native session, so the spawn
      // never meets a key route beside it.
      expect(zero.spawns).toEqual([
        {
          harness: "claude",
          authPreference: "subscription",
          route: "subscription",
          profile: null,
          model: null,
        },
      ]);
      expect(zero.paidProbeCalls).toEqual({ claudeApiKey: 0, claudeSetupToken: 0, codexApiKey: 0 });
      expect(zero.doctors.length).toBeGreaterThan(0);
      expect(zero.doctors.every((d) => d.diagnosticGeneration === "forbidden")).toBe(true);
    },
    120_000,
  );

  it("a ready subscription answers when the zero limit comes from Settings", async () => {
    zero.sources = {
      nativeClaude: true,
      anthropicKey: true,
      claudeSetupToken: true,
      openaiKey: true,
    };
    const { ask } = await setup({ settingsBudget: ZERO });
    const { run, result } = await ask("project");
    expect(run.state, String(run.error)).toBe("succeeded");
    expect(result?.["summary"]).toBe("done");
    expect(zero.spawns).toMatchObject([
      { harness: "claude", authPreference: "subscription", route: "subscription" },
    ]);
    expect(zero.paidProbeCalls).toEqual({ claudeApiKey: 0, claudeSetupToken: 0, codexApiKey: 0 });
  }, 120_000);

  it("an explicit allowance beside a ready subscription is not pinned and keeps today's checks", async () => {
    zero.sources = {
      nativeClaude: true,
      anthropicKey: true,
      claudeSetupToken: false,
      openaiKey: false,
    };
    const { ask } = await setup({});
    const { run } = await ask("project", { paidBudget: UNLIMITED });
    expect(run.state, String(run.error)).toBe("succeeded");
    expect(zero.spawns.length).toBeGreaterThan(0);
    expect(zero.spawns.every((spawn) => spawn.authPreference === "auto")).toBe(true);
    expect(zero.doctors.length).toBeGreaterThan(0);
    expect(zero.doctors.every((d) => d.diagnosticGeneration !== "forbidden")).toBe(true);
  }, 120_000);

  it.each(["project", "none"] as const)(
    "an explicit model on a ready subscription is checked by a catalog read that carries the withheld mode (%s scope)",
    async (scope) => {
      zero.sources = {
        nativeClaude: true,
        anthropicKey: true,
        claudeSetupToken: true,
        openaiKey: true,
      };
      const { ask } = await setup({});
      const { run, result } = await ask(scope, {
        paidBudget: ZERO,
        harness: "claude",
        model: "fixture-model",
      });
      expect(run.state, String(run.error)).toBe("succeeded");
      expect(result?.["summary"]).toBe("done");
      // Not vacuous: the stubbed inventory was really read, and only under the mode.
      expect(zero.catalogs.length).toBeGreaterThan(0);
      expect(zero.catalogs.every((c) => c.diagnosticGeneration === "forbidden")).toBe(true);
      expect(zero.spawns).toMatchObject([
        {
          harness: "claude",
          authPreference: "subscription",
          route: "subscription",
          model: "fixture-model",
        },
      ]);
      expect(zero.paidProbeCalls).toEqual({ claudeApiKey: 0, claudeSetupToken: 0, codexApiKey: 0 });
    },
    120_000,
  );

  it.each(["project", "none"] as const)(
    "key-only and setup-token-only executors are not verified, not spawned, and the refusal says why (%s scope)",
    async (scope) => {
      zero.sources = {
        nativeClaude: false,
        anthropicKey: true,
        claudeSetupToken: true,
        openaiKey: true,
      };
      const { ask } = await setup({});
      const { run } = await ask(scope, { paidBudget: ZERO });
      expect(run.state).toBe("failed");
      expect(run.error).toMatch(/no doctor-OK default route/);
      expect(run.error).toMatch(/verification not run: paid diagnostic generation is disabled/);
      expect(zero.paidProbeCalls).toEqual({ claudeApiKey: 0, claudeSetupToken: 0, codexApiKey: 0 });
      expect(zero.spawns).toEqual([]);
    },
    120_000,
  );

  it("takes the zero limit from Settings when the request omits it, and lets an explicit request override", async () => {
    zero.sources = {
      nativeClaude: false,
      anthropicKey: true,
      claudeSetupToken: false,
      openaiKey: false,
    };
    const { ask } = await setup({ settingsBudget: ZERO });
    const settingsZero = await ask("project");
    expect(settingsZero.run.state).toBe("failed");
    expect(probes()).toBe(0);
    // An explicit unlimited request wins over Settings: today's verification runs.
    invalidateDoctorCache();
    const explicit = await ask("project", { paidBudget: UNLIMITED });
    expect(explicit.run.state, String(explicit.run.error)).toBe("succeeded");
    expect(zero.paidProbeCalls.claudeApiKey).toBeGreaterThan(0);
    expect(zero.spawns.at(-1)).toMatchObject({ harness: "claude", route: "api_key" });
  }, 120_000);

  it("keeps verifying and serving a paid route when the paid budget is explicitly unlimited", async () => {
    zero.sources = {
      nativeClaude: false,
      anthropicKey: true,
      claudeSetupToken: false,
      openaiKey: true,
    };
    const { ask } = await setup({});
    const { run } = await ask("project", { paidBudget: UNLIMITED });
    expect(run.state, String(run.error)).toBe("succeeded");
    expect(zero.paidProbeCalls.claudeApiKey + zero.paidProbeCalls.codexApiKey).toBeGreaterThan(0);
    expect(zero.spawns.at(-1)?.route).toBe("api_key");
    expect(zero.doctors.every((d) => d.diagnosticGeneration !== "forbidden")).toBe(true);
  }, 120_000);

  it("a metered lane is sent only when paid use is funded, never at the zero limit because Settings prefer subscriptions", async () => {
    // Set before setup: the registry offers the synthetic metered lane from the daemon's start.
    zero.metered.present = true;
    const { ask } = await setup({ preferSubscription: true });
    // Not vacuous: deliberately funded, the same lane is served once.
    const funded = await ask("project", { paidBudget: UNLIMITED });
    expect(funded.run.state, String(funded.run.error)).toBe("succeeded");
    expect(zero.metered.runs).toBe(1);
    invalidateDoctorCache();
    const denied = await ask("project", { paidBudget: ZERO });
    expect(denied.run.state).toBe("failed");
    // No send at the zero limit, and the reservation's own typed refusal is what stopped it.
    expect(zero.metered.runs).toBe(1);
    const refusal = denied.run.events.find(
      (event) => event.type === "budget.lease.created" && event.payload["granted"] === false,
    );
    expect(refusal?.payload["denied"]).toBe("finite_zero");
    expect(zero.spawns).toEqual([]);
    expect(probes()).toBe(0);
  }, 120_000);

  it("static HTTP admission of project Auto + attachments sends no paid diagnostic request", async () => {
    zero.sources = {
      nativeClaude: false,
      anthropicKey: true,
      claudeSetupToken: true,
      openaiKey: true,
    };
    const { daemon, repo } = await setup({});
    const notes = await upload(daemon, "file");
    const answer = await http(daemon, "POST", "/runs", {
      prompt: "read the notes",
      mode: "ask",
      scope: { kind: "project", root: repo },
      attachments: [notes],
      paidBudget: ZERO,
    });
    expect(answer.status).toBe(400);
    expect(String(answer.body["message"])).toMatch(/no doctor-OK default route/);
    // The withheld proofs and the paid limit are named, and no credential bytes leak.
    expect(String(answer.body["message"])).toMatch(/verification not run/);
    expect(String(answer.body["message"])).toMatch(/no paid budget remains for this Ask/);
    expect(JSON.stringify(answer.body)).not.toContain("fixture-not-a-real-key");
    expect(zero.paidProbeCalls).toEqual({ claudeApiKey: 0, claudeSetupToken: 0, codexApiKey: 0 });
    expect(recorder.enqueues).toHaveLength(0);
  }, 120_000);
});
