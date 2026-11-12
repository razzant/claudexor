import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { CredentialProfile, HarnessRunSpec } from "@claudexor/schema";
import { copilot } from "./entry.js";
import { acpArgs, acpEffortResolution, decidePermission } from "./policy.js";
import { acpChildEnv, acpToken, probeAcpProfile } from "./env.js";
import { composeSpawnEnv } from "@claudexor/core";

const root = mkdtempSync(join(tmpdir(), "acp-policy-"));
const cwd = join(root, "workspace");
mkdirSync(cwd);
afterAll(() => rmSync(root, { recursive: true, force: true }), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
const permission = (kind: string, rawInput: unknown = {}) =>
  ({
    sessionId: "native",
    toolCall: { toolCallId: "t1", kind, rawInput },
    options: [
      { optionId: "always", kind: "allow_always", name: "Always" },
      { optionId: "once", kind: "allow_once", name: "Once" },
    ],
  }) as RequestPermissionRequest;
const selected = { outcome: { outcome: "selected", optionId: "once" } };
const denied = { outcome: { outcome: "cancelled" } };

describe("ACP typed permissions", () => {
  it("refuses a dangling symlink whose new target would be outside cwd", () => {
    symlinkSync(join(root, "not-created"), join(cwd, "dangling"));
    expect(
      decidePermission("workspace_write", cwd, permission("edit", { path: "dangling" })),
    ).toEqual(denied);
    expect(
      decidePermission("workspace_write", cwd, permission("edit", { path: "dangling/new.txt" })),
    ).toEqual(denied);
  });
  it.each(["read", "search"])("readonly admits %s with workspace evidence", (kind) => {
    expect(decidePermission("readonly", cwd, permission(kind, { pattern: "needle" }))).toEqual(
      selected,
    );
    expect(decidePermission("readonly", cwd, permission(kind, { path: "src/a.ts" }))).toEqual(
      selected,
    );
  });
  it.each(["edit", "execute", "fetch", "other"])("readonly refuses %s", (kind) => {
    expect(
      decidePermission("readonly", cwd, permission(kind, { command: "echo hi", path: "src/a.ts" })),
    ).toEqual(denied);
  });
  it("admits workspace edits and session-bound commands", () => {
    expect(
      decidePermission("workspace_write", cwd, permission("edit", { path: "new/a.ts" })),
    ).toEqual(selected);
    expect(
      decidePermission("workspace_write", cwd, permission("execute", { command: "npm test" })),
    ).toEqual(selected);
  });
  it.each([
    permission("edit"),
    permission("edit", { path: "../outside" }),
    permission("read"),
    permission("execute", { command: [] }),
    permission("edit", { paths: [null] }),
    permission("edit", { paths: 42 }),
    permission("fetch", { url: "https://example.com" }),
    permission("edit", []),
  ])("refuses unknown or outside requests", (params) => {
    expect(decidePermission("workspace_write", cwd, params)).toEqual(denied);
  });
  it("resolves an escaping symlink even for a not-yet-created file", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(cwd, "link"), process.platform === "win32" ? "junction" : "dir");
    expect(
      decidePermission("workspace_write", cwd, permission("edit", { path: "link/new.ts" })),
    ).toEqual(denied);
  });
  it("uses only a supplied permission option and never escalates inherit_native", () => {
    expect(decidePermission("full", cwd, permission("execute"))).toEqual({
      outcome: { outcome: "selected", optionId: "always" },
    });
    expect(decidePermission("inherit_native", cwd, permission("edit", { path: "a" }))).toEqual(
      denied,
    );
    const request = permission("edit", { path: "a" });
    request.options = request.options.slice(0, 1);
    expect(decidePermission("workspace_write", cwd, request)).toEqual(denied);
  });
  it("enforces readonly at spawn even if permission callbacks never arrive", () => {
    const spec = HarnessRunSpec.parse({
      session_id: "s",
      task_id: "t",
      intent: "review",
      prompt: "read",
      cwd,
      access: "readonly",
      model_hint: "opaque model",
      effort_hint: "max",
    });
    expect(acpArgs(copilot, spec)).toContain("--available-tools=view,glob,grep");
    expect(acpArgs(copilot, spec).slice(-1)[0]).toBe("--available-tools=view,glob,grep");
    spec.tool_permission_policy.allow = ["view", "bash"];
    expect(acpArgs(copilot, spec)).toContain("--available-tools=view");
    spec.tool_permission_policy.deny = ["view"];
    expect(() => acpArgs(copilot, spec)).toThrow("no available tools");
  });
  // Copilot applies --available-tools and ignores --excluded-tools when both are passed.
  const toolFlags = (access: string, allow: string[], deny: string[]) =>
    acpArgs(
      copilot,
      HarnessRunSpec.parse({
        session_id: "s",
        task_id: "t",
        intent: "implement",
        prompt: "p",
        cwd,
        access,
        tool_permission_policy: { allow, deny },
      }),
    ).filter((arg) => arg.startsWith("--available-tools=") || arg.startsWith("--excluded-tools="));
  it.each(["full", "inherit_native"])("subtracts deny from the %s allowlist", (access) => {
    expect(toolFlags(access, ["view", "bash"], ["bash"])).toEqual(["--available-tools=view"]);
    expect(toolFlags(access, [], ["bash"])).toEqual(["--excluded-tools=bash"]);
    expect(toolFlags(access, [], [])).toEqual([]);
    expect(() => toolFlags(access, ["bash"], ["bash"])).toThrow("no available tools");
  });
  it("readonly subtracts deny from its allowlist and passes no ignored denylist", () => {
    expect(toolFlags("readonly", ["view", "grep", "bash"], ["grep"])).toEqual([
      "--available-tools=view",
    ]);
    expect(toolFlags("readonly", [], ["grep", "bash"])).toEqual(["--available-tools=view,glob"]);
  });
});

describe("ACP credential and environment isolation", () => {
  const profile = CredentialProfile.parse({
    profile_id: "work",
    harness_id: "copilot",
    display_name: "Work",
    credential_kind: "api_key",
    secret_ref: "copilot:work",
  });
  it("uses only the exact managed secret; presence is not vendor verification", () => {
    expect(acpToken(copilot, profile, (ref) => (ref === "copilot:work" ? "stored" : null))).toBe(
      "stored",
    );
    expect(probeAcpProfile(copilot, profile, () => "stored")).toMatchObject({
      availability: "available",
      verification: "not_run",
    });
    expect(() => acpToken(copilot, profile, () => null)).toThrow("not logged in");
    expect(() => acpToken(copilot, { ...profile, secret_ref: "copilot" }, () => "default")).toThrow(
      "namespaced",
    );
    expect(() => acpToken(copilot, { ...profile, harness_id: "codex" }, () => "wrong")).toThrow(
      "namespaced",
    );
  });
  it("forwards OS/proxy settings, scopes all homes, and excludes host secrets and BYOK", () => {
    const env = acpChildEnv(copilot, cwd, "managed", {
      PATH: "/usr/bin",
      HOME: "/host",
      COPILOT_HOME: "/host/copilot",
      https_proxy: "http://proxy",
      COPILOT_GITHUB_TOKEN: "ambient",
      GH_TOKEN: "host",
      GITHUB_TOKEN: "host",
      OPENAI_API_KEY: "paid",
      COPILOT_PROVIDER_BASE_URL: "https://other",
      NODE_OPTIONS: "--require=host",
      HOST_SERVICE_TOKEN: "host",
      COPILOT_ALLOW_ALL: "true",
      CODEX_THREAD_ID: "parent",
    });
    expect(env["HOME"]).toBe(cwd);
    expect(env["COPILOT_HOME"]).toBe(join(cwd, ".copilot"));
    expect(env["COPILOT_GITHUB_TOKEN"]).toBe("managed");
    expect(env["https_proxy"]).toBe("http://proxy");
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "OPENAI_API_KEY",
      "COPILOT_PROVIDER_BASE_URL",
      "NODE_OPTIONS",
      "HOST_SERVICE_TOKEN",
      "COPILOT_ALLOW_ALL",
      "CODEX_THREAD_ID",
    ])
      expect(env[key] ?? null).toBeNull();
  });
});

describe("ACP child env keeps run custody and host facts past the credential filter (#449 item 6)", () => {
  const run = `CLAUDEXOR_RUN_SCOPE_${"a".repeat(32)}`;
  const install = `OURO_INSTALL_SCOPE_${"b".repeat(32)}`;
  const source = {
    PATH: "/usr/bin",
    HOME: "/host",
    [run]: "1",
    [install]: "1",
    CLAUDEXOR_HOME_SCOPED: "1",
    CLAUDEXOR_OPERATOR_HOME: "/Users/op",
    PLAYWRIGHT_BROWSERS_PATH: "0",
    GH_TOKEN: "host",
    OPENAI_API_KEY: "paid",
    [`FAKE_SCOPE_${"c".repeat(32)}`]: "2", // grammar-shaped name, wrong value: not custody
  };
  it("the final env carries the markers and facts in BOTH inheritance modes and still drops secrets", () => {
    const patch = acpChildEnv(copilot, cwd, "managed", source);
    for (const mode of ["mirror_native", "clean"] as const) {
      const env = composeSpawnEnv(mode, patch);
      expect(env[run]).toBe("1");
      expect(env[install]).toBe("1");
      expect(env["CLAUDEXOR_HOME_SCOPED"]).toBe("1");
      expect(env["CLAUDEXOR_OPERATOR_HOME"]).toBe("/Users/op");
      expect(env["PLAYWRIGHT_BROWSERS_PATH"]).toBe("0");
      expect(env["HOME"]).toBe(cwd);
      expect(env["COPILOT_GITHUB_TOKEN"]).toBe("managed");
      expect(env["GH_TOKEN"] ?? null).toBeNull();
      expect(env["OPENAI_API_KEY"] ?? null).toBeNull();
      expect(env[`FAKE_SCOPE_${"c".repeat(32)}`] ?? null).toBeNull();
    }
  });
  it("a source without custody entries adds none", () => {
    const patch = acpChildEnv(copilot, cwd, "managed", { PATH: "/usr/bin", HOME: "/host" });
    // The patch nulls every parent key (incl. any scope key this test process
    // itself runs under); none may be SET.
    expect(Object.entries(patch).filter(([k, v]) => k.includes("_SCOPE_") && v !== null)).toEqual(
      [],
    );
    expect(patch["CLAUDEXOR_HOME_SCOPED"] ?? null).toBeNull();
  });
});

describe("ACP effort goes through the shared resolver (one result for argv and receipt)", () => {
  const effortSpec = (effort: string | null) =>
    HarnessRunSpec.parse({
      session_id: "s",
      task_id: "t",
      intent: "implement",
      prompt: "p",
      cwd,
      effort_hint: effort,
    });
  const flag = (args: string[]) => {
    const at = args.indexOf("--effort");
    return at < 0 ? null : args[at + 1];
  };

  it.each([
    // The entry's own ladder decides every word it lists...
    ["max", "max", "exact", false],
    ["low", "low", "exact", false],
    // ...and the shared preference order only places the ones it does not.
    ["ultra", "max", "downward", true],
    ["none", "low", "floor", true],
    ["minimal", "low", "floor", true],
  ] as const)("%s → --effort %s (%s)", (requested, submitted, resolution, shared) => {
    const receipt = acpEffortResolution(copilot, requested);
    expect(receipt).toMatchObject({
      requested,
      submitted,
      resolution,
      source: "adapter",
      parameter: "--effort",
    });
    expect(receipt.reason?.includes("shared preference order") ?? false).toBe(shared);
    expect(flag(acpArgs(copilot, effortSpec(requested)))).toBe(submitted);
  });

  it("refuses a word neither order places — a refusal that exists only because there is a knob", () => {
    const receipt = acpEffortResolution(copilot, "ulta");
    expect(receipt).toMatchObject({ requested: "ulta", submitted: null, resolution: "rejected" });
    expect(receipt.reason).toContain("low, medium, high, xhigh, max");
    expect(flag(acpArgs(copilot, effortSpec("ulta")))).toBeNull();
  });

  it("an entry that declares no levels has no knob: nothing is sent and nothing is refused", () => {
    const knobless = { ...copilot, effortLevels: [] };
    expect(acpEffortResolution(knobless, "high")).toMatchObject({
      requested: "high",
      submitted: null,
      resolution: "omitted",
      parameter: null,
    });
    // An unknown word is not a new refusal here; the receipt only notes it.
    const typo = acpEffortResolution(knobless, "ulta");
    expect(typo).toMatchObject({ submitted: null, resolution: "omitted" });
    expect(typo.reason).toContain("outside the shared preference order");
    expect(flag(acpArgs(knobless, effortSpec("high")))).toBeNull();
  });

  it("the builder sends the receipt value it is handed instead of resolving again", () => {
    expect(flag(acpArgs(copilot, effortSpec("ultra"), "medium"))).toBe("medium");
    expect(flag(acpArgs(copilot, effortSpec("max"), null))).toBeNull();
  });
});
