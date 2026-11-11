import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateGlobalConfig } from "@claudexor/config";
import type { AdapterRegistry, HarnessAdapter } from "@claudexor/core";
import { HarnessGateway, type HarnessStatus } from "@claudexor/gateway";
import { normalizeRunStartRequest } from "@claudexor/control-api";
import { CLAUDE_EFFORT_SNAPSHOT, createClaudeAdapter } from "@claudexor/harness-claude";
import { CODEX_VENDOR_CLI_VERSION, createCodexAdapter } from "@claudexor/harness-codex";
import { createFakeHarness } from "@claudexor/harness-fake";
import { AGY_CAPABILITY_PROFILE } from "@claudexor/harness-agy";
import {
  handleThreadTurnCreate,
  type ThreadTurnRouteCtx,
} from "../../control-api/src/thread-turn-routes.js";
import {
  Attachment,
  ConformanceReport,
  ControlRunStartRequest,
  ControlThreadTurnRequest,
  CredentialProfile,
  HarnessManifest,
  HarnessCapabilityProfile,
  type Intent,
  type AttachmentInputClass,
} from "@claudexor/schema";
import { createRunRequirementsPreflight } from "./request-preflight.js";

// The production registry/gateway composition, for the cases that pass no
// registry or statusAll seam: fakes are explicit-only and absent from host status.
const production = vi.hoisted(() => ({ adapters: [] as Array<{ id: string }> }));
vi.mock("./registry.js", async (original) => {
  const actual = await original<typeof import("./registry.js")>();
  const { HarnessGateway } = await import("@claudexor/gateway");
  const registry = (options: { includeFakes?: boolean } = {}) =>
    new Map(
      (production.adapters as HarnessAdapter[])
        .filter((adapter) => options.includeFakes !== false || !adapter.id.startsWith("fake-"))
        .map((adapter) => [adapter.id, adapter]),
    );
  return {
    ...actual,
    buildRegistry: registry,
    buildGateway: (options: { includeFakes?: boolean } = {}) =>
      new HarnessGateway(registry(options)),
  };
});

// Requirements admission (owner decision: account readiness is checked by the
// normal run) resolves pool, pin and capability facts statically; it never
// probes an account row, reads thread bindings or quota/unusable evidence.

const textInput: AttachmentInputClass = {
  kind: "file",
  mime_types: ["text/plain"],
  max_bytes: 1024,
  max_count: 1,
  transport: "text_inline",
};
const attachment = Attachment.parse({
  resource_id: "notes",
  kind: "file",
  mime: "text/plain",
  name: "notes.txt",
  sha256: `sha256:${"a".repeat(64)}`,
  size_bytes: 12,
  path: "/fixture/notes.txt",
});
const profile = (id: string, harness = "codex", enabled = true) =>
  CredentialProfile.parse({
    profile_id: id,
    harness_id: harness,
    display_name: id,
    enabled,
    credential_kind: "config_dir_login",
    isolation_locator: `/fixture/profiles/${harness}/${id}`,
  });

function lane(
  id: string,
  options: {
    defaultReady?: boolean;
    attachments?: boolean;
    browser?: boolean;
    auxiliaryWritableRoots?: boolean;
    implement?: boolean;
    enabledIntents?: Intent[];
  } = {},
) {
  const probe = vi.fn(async (row: CredentialProfile) => ({
    profile_id: row.profile_id,
    harness_id: id,
    availability: "available" as const,
    verification: "passed" as const,
    verification_source: "local_store" as const,
    last_verified_at: null,
    detail: "profile authenticated",
  }));
  const discover = vi.fn(async () =>
    HarnessManifest.parse({
      id,
      display_name: id,
      kind: "local_cli",
      provider_family: "local",
      capability_profile: {
        attachment_inputs: options.attachments === false ? [] : [textInput],
        mcp_injection_requires_full_access: !options.auxiliaryWritableRoots,
        access_control: { auxiliary_writable_roots: options.auxiliaryWritableRoots ?? false },
      },
      capabilities: {
        implement: options.implement ?? true,
        read_files: true,
        browser_tool: options.browser ?? true,
      },
      access_profiles_supported: ["readonly", "workspace_write", "full"],
    }),
  );
  const doctor = vi.fn(async () =>
    ConformanceReport.parse({
      harness_id: id,
      status: options.defaultReady ? "ok" : "unavailable",
      enabled_intents: options.enabledIntents ?? (options.defaultReady ? ["implement"] : []),
      reasons: options.defaultReady ? [] : ["default HOME is not authenticated"],
    }),
  );
  const adapter: HarnessAdapter = {
    id,
    capabilityProfile: HarnessCapabilityProfile.parse({
      access_control: { auxiliary_writable_roots: options.auxiliaryWritableRoots ?? false },
    }),
    discover,
    doctor,
    probeCredentialProfile: probe,
    async *run() {
      throw new Error("preflight must never start a vendor run");
    },
  };
  return { adapter, probe, discover, doctor };
}

type Lane = ReturnType<typeof lane>;

function fixture(
  lanes: Array<Lane | HarnessAdapter>,
  sticky: string | null = "sticky",
  resource = attachment,
) {
  const adapters = lanes.map((entry) => ("adapter" in entry ? entry.adapter : entry));
  const registry: AdapterRegistry = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const gateway = new HarnessGateway(registry);
  const statusAll = vi.fn(async (cwd: string, ids?: string[]) =>
    gateway.statusAll({ cwd, fresh: true }, ids),
  );
  const threadProfileId = vi.fn(() => sticky);
  const preflight = createRunRequirementsPreflight(
    { resolve: (refs) => (refs?.length ? [resource] : []) },
    "/fixture/no-project",
    {
      registry,
      statusAll,
      threadProfileId,
      accessDefault: () => "full",
      gitCapability: async () => ({
        status: "available",
        version: "fixture",
        detail: null,
        remediation: null,
      }),
    },
  );
  return { preflight, statusAll, threadProfileId };
}
const request = (overrides: Record<string, unknown> = {}) =>
  ControlRunStartRequest.parse({
    prompt: "read notes",
    mode: "agent",
    scope: { kind: "project", root: "/fixture/project" },
    attachments: [{ resourceId: "notes" }],
    ...overrides,
  });
const probes = (...lanes: Lane[]) => lanes.flatMap((entry) => entry.probe.mock.calls);

/** The real Codex/Claude adapters over vendor runtime stubs: their own
 * manifests and Browser/attachment declarations, no binary, no account. */
function realCodex(): HarnessAdapter {
  return createCodexAdapter({
    detectVersion: async () => CODEX_VENDOR_CLI_VERSION,
    brokenInstallAdvisory: () => null,
    probeLogin: async () => ({ authed: false, method: "logged_out", probeError: null }),
    hasApiKey: () => false,
    codexApiKey: () => undefined,
    probeEfforts: async () => null,
  });
}
function realClaude(): HarnessAdapter {
  return createClaudeAdapter({
    detectVersion: async () => "2.1.261",
    installation: () => ({ path: null, advisory: null }),
    probeAuthStatus: async () => ({
      loggedIn: false,
      authed: false,
      authMethod: null,
      probeError: null,
    }),
    anthropicApiKey: () => null,
    claudeOAuthToken: () => null,
    probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "fixture" }),
    probeEffortLevels: async () => ({ levels: CLAUDE_EFFORT_SNAPSHOT, live: false }),
  });
}

/** One real thread-turn route call; returns the HTTP answer, the refusal it
 * recorded on the turn and the params it enqueued. */
async function threadTurn(
  preflight: (request: ControlRunStartRequest) => Promise<void>,
  input: Record<string, unknown>,
) {
  let response: { status: number; body: Record<string, unknown> } | undefined;
  let enqueued: Record<string, unknown> | undefined;
  const refusals: unknown[] = [];
  const ctx: ThreadTurnRouteCtx = {
    json: (_res, status, body) => {
      response = { status, body: body as Record<string, unknown> };
    },
    normalizeStart: normalizeRunStartRequest,
    preflightThreadRunRequirements: preflight,
    threadTurnChains: new Map(),
    threadDetail: async () => ({
      thread: {
        repo: null,
        mode: "ask",
        auth_preference: "auto",
        head_run_id: null,
        primary_harness: null,
        eligible_harnesses: [],
        workspace: { mode: "in_place" },
      },
      sessions: [],
      turns: [],
    }),
    createThreadTurn: async () => ({ id: "turn" }),
    setTurnEnqueueError: (_turnId, problem) => refusals.push(problem),
    waitForRunStart: async () => ({ id: "job", state: "queued" }) as never,
    isTerminalState: () => false,
    readRunArtifactText: async () => null,
    resolveRunArtifactPath: async () => null,
    daemon: {
      enqueue: async (params: Record<string, unknown>) => {
        enqueued = params;
        return { id: "job", state: "queued" };
      },
    } as unknown as ThreadTurnRouteCtx["daemon"],
  };
  await handleThreadTurnCreate(
    ctx,
    {} as ServerResponse,
    "thread",
    ControlThreadTurnRequest.parse({
      prompt: "read notes",
      mode: "ask",
      attachments: [{ resourceId: "notes" }],
      ...input,
    }),
    "request-key",
  );
  return { response: response!, enqueued, refusals };
}

beforeEach(() => {
  process.env.CLAUDEXOR_CONFIG_DIR = mkdtempSync(join(tmpdir(), "preflight-profiles-"));
  updateGlobalConfig((config) => ({
    ...config,
    credential_profiles: [profile("work"), profile("sticky")],
  }));
});

describe("requirements admission resolves static facts; the run checks account readiness", () => {
  it("admits a named-only pin over a logged-out default HOME without probing an account", async () => {
    const codex = lane("codex");
    const { preflight, statusAll } = fixture([codex]);
    await expect(preflight(request({ credentialProfileId: "work" }))).resolves.toBeUndefined();
    await expect(
      preflight(request({ credentialProfileId: "work", attachments: [], browser: true })),
    ).resolves.toBeUndefined();
    expect(probes(codex)).toEqual([]);
    // Auto membership still reads host status; the selected profile names the lane.
    expect(statusAll).toHaveBeenCalledTimes(2);
  });

  it("leaves a registered but unready pin to execution instead of refusing it early", async () => {
    const codex = lane("codex");
    codex.probe.mockResolvedValue({
      profile_id: "work",
      harness_id: "codex",
      availability: "unavailable",
      verification: "not_run",
      verification_source: "local_store",
      last_verified_at: null,
      detail: "logged out",
    } as never);
    const { preflight } = fixture([codex]);
    await expect(preflight(request({ credentialProfileId: "work" }))).resolves.toBeUndefined();
    await expect(
      preflight(request({ credentialProfileId: "work", harnesses: ["codex"] })),
    ).resolves.toBeUndefined();
    expect(probes(codex)).toEqual([]);
  });

  it.each([
    { input: {}, status: 400, code: "attachment_pool_unsupported" },
    { input: { credentialProfileId: "work" }, status: 202, code: undefined },
    { input: { credentialProfileId: null }, status: 202, code: undefined },
  ])(
    "omission inherits, an id overrides and null clears the thread pin: $input",
    async ({ input, status, code }) => {
      updateGlobalConfig((config) => ({
        ...config,
        credential_profiles: [profile("sticky", "notext"), profile("work", "text")],
      }));
      const notext = lane("notext", { attachments: false });
      const text = lane("text");
      const { preflight, threadProfileId } = fixture([notext, text]);
      const turn = await threadTurn(preflight, input);
      expect(turn.response.status).toBe(status);
      if (code) {
        // The inherited pin selected the lane that cannot read the file.
        expect(turn.response.body).toMatchObject({ code });
        expect(turn.refusals).toEqual([expect.objectContaining({ code, retryable: false })]);
        expect(turn.enqueued).toBeUndefined();
      } else if ("credentialProfileId" in input) {
        expect(turn.enqueued).toHaveProperty("credentialProfileId", input.credentialProfileId);
      }
      expect(threadProfileId).toHaveBeenCalledTimes("credentialProfileId" in input ? 0 : 1);
      expect(probes(notext, text)).toEqual([]);
    },
  );

  it.each([
    { pin: "ghost", setup: () => {}, reason: /ghost.*not registered/ },
    {
      pin: "work",
      setup: () =>
        updateGlobalConfig((config) => ({
          ...config,
          credential_profiles: [profile("work", "codex", false), profile("sibling")],
        })),
      reason: /work.*disabled/,
    },
    {
      pin: "work",
      setup: () =>
        updateGlobalConfig((config) => ({
          ...config,
          harnesses: { codex: { ...config.harnesses.codex, enabled: false } },
        })),
      reason: /work.*belongs to unavailable harness/,
    },
  ])(
    "an Auto pin that is $reason refuses typed and is never substituted",
    async ({ pin, setup, reason }) => {
      setup();
      const codex = lane("codex", { defaultReady: true });
      const other = lane("other", { defaultReady: true });
      const { preflight } = fixture([codex, other]);
      const result = preflight(request({ credentialProfileId: pin }));
      await expect(result).rejects.toMatchObject({ status: 400, code: "harness_unavailable" });
      await expect(result).rejects.toThrow(reason);
      expect(probes(codex, other)).toEqual([]);
    },
  );

  it("an explicit pool keeps every lane strict about the pin's registration, state and owner", async () => {
    updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: [profile("work"), profile("off", "codex", false)],
    }));
    const codex = lane("codex", { defaultReady: true });
    const other = lane("other", { defaultReady: true });
    const { preflight } = fixture([codex, other]);
    for (const [input, reason] of [
      [{ credentialProfileId: "ghost", harnesses: ["codex"] }, /codex: .*"ghost".*not registered/],
      [{ credentialProfileId: "off", harnesses: ["codex"] }, /codex: .*"off".*disabled/],
      [{ credentialProfileId: "work", harnesses: ["other"] }, /other: .*not registered.*"other"/],
      [{ credentialProfileId: "work", harnesses: ["codex", "other"] }, /other: .*not registered/],
    ] as const) {
      const result = preflight(request(input));
      await expect(result).rejects.toMatchObject({ status: 400, code: "harness_unavailable" });
      await expect(result).rejects.toThrow(reason);
    }
    await expect(
      preflight(request({ credentialProfileId: "work", harnesses: ["codex"] })),
    ).resolves.toBeUndefined();
    expect(probes(codex, other)).toEqual([]);
  });

  it("uses execution's pool projection: Settings is strict, the request wins, [] stays Auto", async () => {
    const notext = lane("notext", { attachments: false, defaultReady: true });
    const text = lane("text", { defaultReady: true });
    const { preflight, statusAll } = fixture([notext, text], null);
    const settings = (pool: string[]) =>
      updateGlobalConfig((config) => ({
        ...config,
        routing: { ...config.routing, eligible_harnesses: pool },
      }));
    settings(["notext", "text"]);
    await expect(preflight(request())).rejects.toMatchObject({
      code: "attachment_pool_unsupported",
    });
    expect(statusAll).not.toHaveBeenCalled();
    await expect(preflight(request({ harnesses: ["text"] }))).resolves.toBeUndefined();
    // An empty request pool is not replaced by Settings, exactly as at execution.
    await expect(preflight(request({ harnesses: [] }))).resolves.toBeUndefined();
    expect(statusAll).toHaveBeenCalledTimes(1);
    settings(["text"]);
    await expect(preflight(request())).resolves.toBeUndefined();
    expect(statusAll).toHaveBeenCalledTimes(1);
    expect(notext.doctor).toHaveBeenCalledTimes(1);
  });

  it("explicit pools read adapter manifests, never host status, even with registered rows", async () => {
    const codex = lane("codex");
    const other = lane("other");
    const { preflight, statusAll } = fixture([codex, other]);
    await expect(preflight(request({ harnesses: ["codex", "other"] }))).resolves.toBeUndefined();
    expect(statusAll).not.toHaveBeenCalled();
    expect(codex.doctor).not.toHaveBeenCalled();
    expect(codex.discover).toHaveBeenCalledTimes(1);
    expect(other.discover).toHaveBeenCalledTimes(1);
    const missing = lane("codex");
    missing.discover.mockRejectedValue(new Error("vendor executable is not installed"));
    await expect(
      fixture([missing, other]).preflight(request({ harnesses: ["codex"] })),
    ).rejects.toMatchObject({ status: 400, code: "harness_unavailable" });
  });

  it("Auto membership keeps host status: row-bearing lanes join, fakes and default-only gaps do not", async () => {
    updateGlobalConfig((config) => ({ ...config, credential_profiles: [profile("work")] }));
    const codex = lane("codex");
    const plain = lane("plain");
    const fake = createFakeHarness("fake-success");
    const { preflight, statusAll } = fixture([codex, plain, fake], null);
    await expect(preflight(request())).resolves.toBeUndefined();
    expect(statusAll).toHaveBeenCalledWith("/fixture/project", ["codex", "plain", "fake-success"]);
    // `codex` joined only through its enabled row; `plain` has neither default nor row.
    expect(codex.discover).toHaveBeenCalledTimes(1);
    expect(probes(codex, plain)).toEqual([]);
    updateGlobalConfig((config) => ({ ...config, credential_profiles: [] }));
    const refused = preflight(request());
    await expect(refused).rejects.toMatchObject({ status: 400, code: "harness_unavailable" });
    await expect(refused).rejects.toThrow(/no doctor-OK default route or enabled account row/);
  });

  it("a candidate refusal keeps its declared reason and code on the refused turn", async () => {
    const { preflight } = fixture([lane("codex", { defaultReady: true })]);
    const turn = await threadTurn(preflight, { credentialProfileId: "ghost" });
    expect(turn.response.status).toBe(400);
    expect(turn.response.body).toMatchObject({
      code: "harness_unavailable",
      error: expect.stringMatching(/ghost.*not registered/),
    });
    expect(turn.refusals).toEqual([
      expect.objectContaining({ code: "harness_unavailable", retryable: false }),
    ]);
  });

  it("rejects an ambiguous platform binding set without probing a profile", async () => {
    const codex = lane("codex");
    codex.adapter = {
      ...codex.adapter,
      capabilityProfile: HarnessCapabilityProfile.parse({
        auth: {
          credential_profile_policies: [
            {
              source: "native_session",
              platforms: ["darwin", "linux", "win32"],
              identity_scope: "os_user",
              max_enabled_profiles: 1,
              cleanup_owner: "vendor",
            },
          ],
        },
      }),
    };
    await expect(
      fixture([codex]).preflight(request({ credentialProfileId: "work" })),
    ).rejects.toMatchObject({ code: "credential_profile_ambiguous" });
    expect(probes(codex)).toEqual([]);
  });

  it.each([
    { harnesses: undefined, attachments: true, code: undefined },
    { harnesses: ["agy", "codex"], attachments: true, code: "attachment_pool_unsupported" },
    { harnesses: undefined, attachments: false, code: "credential_profile_ambiguous" },
  ])(
    "checks cardinality only for attachment-compatible candidates: $harnesses/$attachments",
    async ({ harnesses, attachments, code }) => {
      // Simulate the real Windows AGY policy on this host, not Windows execution.
      const agy = lane("agy", { attachments: false, defaultReady: true });
      const policies = AGY_CAPABILITY_PROFILE.auth.credential_profile_policies;
      if (!policies?.length) throw new Error("AGY must declare its platform profile policy");
      agy.adapter = {
        ...agy.adapter,
        capabilityProfile: HarnessCapabilityProfile.parse({
          ...AGY_CAPABILITY_PROFILE,
          auth: {
            ...AGY_CAPABILITY_PROFILE.auth,
            credential_profile_policies: policies.map((policy) => ({
              ...policy,
              platforms: ["darwin", "linux", "win32"],
            })),
          },
        }),
      };
      updateGlobalConfig((config) => ({
        ...config,
        credential_profiles: [profile("old-one", "agy"), profile("old-two", "agy")],
      }));
      const codex = lane("codex", { defaultReady: true });
      const result = fixture([agy, codex], null).preflight(
        request({
          harnesses,
          browser: true,
          attachments: attachments ? [{ resourceId: "notes" }] : [],
        }),
      );
      if (code) await expect(result).rejects.toMatchObject({ code });
      else await expect(result).resolves.toBeUndefined();
      expect(probes(agy, codex)).toEqual([]);
    },
  );

  it.each([
    { selection: "auto", roots: true, code: undefined },
    { selection: "auto", roots: true, nativeBrowser: true, code: "browser_unavailable" },
    { selection: "auto", roots: true, browser: false, code: undefined },
    {
      selection: "settings",
      roots: true,
      browser: false,
      code: "auxiliary_writable_roots_unsupported",
    },
    { selection: "pin", roots: true, browser: false, code: "auxiliary_writable_roots_unsupported" },
    { selection: "request", roots: true, code: "auxiliary_writable_roots_unsupported" },
    { selection: "settings", roots: true, code: "auxiliary_writable_roots_unsupported" },
    { selection: "pin", roots: true, code: "auxiliary_writable_roots_unsupported" },
    { selection: "auto", roots: false, code: "credential_profile_ambiguous" },
    { selection: "request", roots: false, code: "credential_profile_ambiguous" },
    { selection: "settings", roots: false, code: "credential_profile_ambiguous" },
    { selection: "pin", roots: false, code: "credential_profile_ambiguous" },
  ])(
    "auxiliary roots compose with profile cardinality: $selection/roots=$roots/browser=$browser",
    async ({ selection, roots, browser = true, nativeBrowser = false, code }) => {
      // Real Windows AGY cardinality policy, projected onto this test host.
      // The other lane declares workspace-write Browser to isolate pool admission;
      // the real Codex Browser access contract is covered separately below.
      const agy = lane("agy", { defaultReady: true });
      agy.adapter = {
        ...agy.adapter,
        capabilityProfile: HarnessCapabilityProfile.parse({
          ...AGY_CAPABILITY_PROFILE,
          auth: {
            ...AGY_CAPABILITY_PROFILE.auth,
            credential_profile_policies:
              AGY_CAPABILITY_PROFILE.auth.credential_profile_policies!.map((policy) => ({
                ...policy,
                platforms: ["darwin", "linux", "win32"],
              })),
          },
        }),
      };
      const codex = lane("codex", { defaultReady: true, auxiliaryWritableRoots: true });
      if (nativeBrowser) codex.discover.mockImplementation(realCodex().discover);
      updateGlobalConfig((config) => ({
        ...config,
        credential_profiles: [profile("old-one", "agy"), profile("old-two", "agy")],
        routing: {
          ...config.routing,
          eligible_harnesses: selection === "settings" ? ["codex", "agy"] : [],
        },
      }));
      const { preflight, statusAll } = fixture([codex, agy], null);
      const result = preflight(
        request({
          browser,
          attachments: [],
          access: "workspace_write",
          harnesses: selection === "request" ? ["codex", "agy"] : undefined,
          credentialProfileId: selection === "pin" ? "old-one" : undefined,
          execution: roots ? { auxiliaryWritableRoots: ["/fixture/download-cache"] } : {},
        }),
      );
      if (code) await expect(result).rejects.toMatchObject({ code });
      else await expect(result).resolves.toBeUndefined();
      expect(probes(agy, codex)).toEqual([]);
      if (roots) {
        expect(agy.discover).not.toHaveBeenCalled();
        expect(agy.doctor).not.toHaveBeenCalled();
        if (selection === "auto" && browser)
          expect(statusAll).toHaveBeenCalledWith("/fixture/project", ["codex"]);
        else expect(statusAll).not.toHaveBeenCalled();
      }
    },
  );

  it("Browser needs one effective lane among the attachment-compatible lanes", async () => {
    updateGlobalConfig((config) => ({ ...config, credential_profiles: [] }));
    const reader = lane("reader", { browser: false, defaultReady: true });
    const browser = lane("browser", { attachments: false, defaultReady: true });
    const { preflight } = fixture([reader, browser], null);
    await expect(preflight(request({ browser: true }))).rejects.toMatchObject({
      code: "browser_unavailable",
    });
    await expect(
      preflight(request({ browser: true, harnesses: ["reader", "browser"] })),
    ).rejects.toMatchObject({ code: "attachment_pool_unsupported" });
    await expect(preflight(request({ browser: true, attachments: [] }))).resolves.toBeUndefined();
  });

  it("keeps each real adapter's Browser access, web and attachment declarations", async () => {
    const { preflight } = fixture([realCodex(), realClaude()], null);
    const browse = (harness: string, overrides: Record<string, unknown> = {}) =>
      preflight(request({ harnesses: [harness], attachments: [], browser: true, ...overrides }));
    await expect(browse("claude", { access: "workspace_write" })).resolves.toBeUndefined();
    await expect(browse("codex", { access: "full" })).resolves.toBeUndefined();
    await expect(browse("codex", { access: "workspace_write" })).rejects.toMatchObject({
      code: "browser_unavailable",
    });
    await expect(browse("claude", { mode: "plan" })).rejects.toMatchObject({
      code: "browser_unavailable",
    });
    await expect(browse("codex", { access: "full", web: "off" })).rejects.toMatchObject({
      code: "browser_unavailable",
    });
    await expect(preflight(request({ harnesses: ["claude"] }))).resolves.toBeUndefined();
    await expect(preflight(request({ harnesses: ["codex"] }))).resolves.toBeUndefined();
    await expect(preflight(request({ harnesses: ["codex", "claude"] }))).resolves.toBeUndefined();
  });

  it("admits PDF on Codex but refuses an explicit pool containing incompatible Claude", async () => {
    const { preflight } = fixture([realCodex(), realClaude()], null, {
      ...attachment,
      mime: "application/pdf",
      name: "notes.pdf",
    });
    await expect(preflight(request({ harnesses: ["codex"] }))).resolves.toBeUndefined();
    for (const harnesses of [["claude"], ["codex", "claude"]])
      await expect(preflight(request({ harnesses }))).rejects.toMatchObject({
        code: "attachment_pool_unsupported",
      });
  });

  it("fixture regression: an explicit fake-success + codex Browser pool is judged by manifests", async () => {
    // A registered row once made admission read the fake-less host status for
    // this explicit pool and call fake-success unavailable (fixtures only:
    // fakes never enter production pools).
    production.adapters = [createFakeHarness("fake-success"), realCodex()];
    const preflight = createRunRequirementsPreflight({ resolve: () => [] }, "/fixture/no-project", {
      accessDefault: () => "full",
      gitCapability: async () => ({
        status: "available",
        version: "fixture",
        detail: null,
        remediation: null,
      }),
    });
    const browse = (access: string) =>
      preflight(
        request({ harnesses: ["fake-success", "codex"], attachments: [], browser: true, access }),
      );
    await expect(browse("full")).resolves.toBeUndefined();
    await expect(browse("workspace_write")).rejects.toMatchObject({ code: "browser_unavailable" });
  });

  it("an Ouroboros-shaped request without attachments or Browser reaches no admission dependency", async () => {
    const codex = lane("codex", { defaultReady: true });
    const { preflight, statusAll, threadProfileId } = fixture([codex]);
    for (const shape of [
      { harnesses: ["codex"], primaryHarness: "codex", model: "gpt-5.5" },
      { harnesses: ["codex"], credentialProfileId: "work", authPreference: "subscription" },
      { harnesses: ["codex"], credentialProfileId: null, threadId: "thread", mode: "ask" },
    ]) {
      await expect(preflight(request({ ...shape, attachments: [] }))).resolves.toBeUndefined();
    }
    expect(statusAll).not.toHaveBeenCalled();
    expect(threadProfileId).not.toHaveBeenCalled();
    expect(codex.discover).not.toHaveBeenCalled();
    expect(codex.doctor).not.toHaveBeenCalled();
    expect(probes(codex)).toEqual([]);
  });
});

// The statusAll seam keeps its execution-shaped projection: a Gateway-null
// manifest is the gateway's own failed discovery and is not rediscovered.
describe("Auto discovery failures", () => {
  it.each([false, true])(
    "an Auto lane whose discovery failed is skipped, browser=%s",
    async (browser) => {
      updateGlobalConfig((config) => ({
        ...config,
        credential_profiles: [profile("work"), profile("work", "other")],
      }));
      const unavailable = lane("codex");
      unavailable.discover.mockRejectedValue(new Error("vendor executable is not installed"));
      const other = lane("other", { defaultReady: true });
      const { preflight } = fixture([unavailable, other]);
      await expect(
        preflight(
          request({
            credentialProfileId: "work",
            ...(browser ? { browser: true, attachments: [], access: "full" } : {}),
          }),
        ),
      ).resolves.toBeUndefined();
      expect(unavailable.discover).toHaveBeenCalledTimes(1);
      expect(probes(unavailable, other)).toEqual([]);
    },
  );

  it("reuses an already discovered Gateway manifest", async () => {
    const codex = lane("codex");
    await expect(
      fixture([codex]).preflight(request({ credentialProfileId: "work" })),
    ).resolves.toBeUndefined();
    expect(codex.discover).toHaveBeenCalledTimes(1);
  });

  it("refuses typed when the only Auto lane cannot be discovered", async () => {
    const codex = lane("codex");
    codex.discover.mockRejectedValue(new Error("vendor executable is not installed"));
    await expect(
      fixture([codex]).preflight(request({ credentialProfileId: "work" })),
    ).rejects.toMatchObject({
      status: 400,
      code: "harness_unavailable",
      message: "codex is unavailable (discovery failed)",
    });
  });

  it("projected statuses without a manifest are discovered once more", async () => {
    const codex = lane("codex");
    const registry: AdapterRegistry = new Map([[codex.adapter.id, codex.adapter]]);
    const preflight = createRunRequirementsPreflight(
      { resolve: () => [attachment] },
      "/fixture/no-project",
      {
        registry,
        statusAll: async (): Promise<
          Array<Pick<HarnessStatus, "id" | "status" | "enabledIntents">>
        > => [{ id: "codex", status: "unavailable", enabledIntents: [] }],
        accessDefault: () => "full",
      },
    );
    await expect(preflight(request({ credentialProfileId: "work" }))).resolves.toBeUndefined();
    expect(codex.discover).toHaveBeenCalledTimes(1);
  });
});
