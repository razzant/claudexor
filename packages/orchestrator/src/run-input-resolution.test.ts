import { describe, expect, it } from "vitest";
import { ResolvedConfig, type EffortHint } from "@claudexor/schema";
import type { RunInput } from "./orchestrator.js";
import { resolveRunInputDefaults } from "./run-input-resolution.js";

function config(
  options: {
    eligible?: string[];
    primary?: string | null;
    harnesses?: Record<string, { default_model?: string; effort?: EffortHint }>;
  } = {},
) {
  return ResolvedConfig.parse({
    project: {},
    trust: {},
    global: {
      routing: {
        eligible_harnesses: options.eligible ?? [],
        primary_harness: options.primary ?? null,
      },
      harnesses: options.harnesses ?? {},
    },
  });
}

function resolve(
  input: Partial<RunInput>,
  options: Parameters<typeof config>[0] & { registry?: Iterable<string> } = {},
) {
  return resolveRunInputDefaults(
    { repoRoot: "/tmp/project", prompt: "test", mode: "agent", ...input },
    {
      config: config(options),
      registryIds: options.registry ?? ["codex", "claude"],
    },
  );
}

describe("resolveRunInputDefaults route freeze", () => {
  it("freezes one pure-Auto lane without turning Auto into an explicit pool", () => {
    const result = resolve(
      {},
      {
        registry: ["codex"],
        harnesses: { codex: { default_model: "settings-model", effort: "high" } },
      },
    );

    expect(result.harnesses).toBeUndefined();
    expect(result.models).toEqual({ codex: "settings-model" });
    expect(result.efforts).toEqual({ codex: "high" });
  });

  it("freezes every settings-backed lane in a multi-lane pure-Auto universe", () => {
    const result = resolve(
      {},
      {
        harnesses: {
          codex: { default_model: "codex-settings", effort: "high" },
          claude: { default_model: "claude-settings", effort: "max" },
        },
      },
    );

    expect(result.harnesses).toBeUndefined();
    expect(result.models).toEqual({ codex: "codex-settings", claude: "claude-settings" });
    expect(result.efforts).toEqual({ codex: "high", claude: "max" });
  });

  it("keeps explicit and Settings-selected pools unchanged", () => {
    const settingsPool = resolve(
      {},
      {
        eligible: ["claude"],
        harnesses: {
          codex: { default_model: "codex-settings", effort: "high" },
          claude: { default_model: "claude-settings", effort: "max" },
        },
      },
    );
    expect(settingsPool.harnesses).toEqual(["claude"]);
    expect(settingsPool.models).toEqual({ claude: "claude-settings" });
    expect(settingsPool.efforts).toEqual({ claude: "max" });

    const explicitPool = resolve(
      { harnesses: ["codex"] },
      {
        eligible: ["claude"],
        harnesses: {
          codex: { default_model: "codex-settings", effort: "high" },
          claude: { default_model: "claude-settings", effort: "max" },
        },
      },
    );
    expect(explicitPool.harnesses).toEqual(["codex"]);
    expect(explicitPool.models).toEqual({ codex: "codex-settings" });
    expect(explicitPool.efforts).toEqual({ codex: "high" });
  });

  it("applies map over scalar over Settings without leaking a model scalar to other lanes", () => {
    const result = resolve(
      {
        harnesses: ["codex", "claude"],
        primaryHarness: "codex",
        model: "scalar-model",
        models: { codex: "mapped-model" },
        effort: "medium",
        efforts: { claude: "max" },
      },
      {
        harnesses: {
          codex: { default_model: "codex-settings", effort: "low" },
          claude: { default_model: "claude-settings", effort: "high" },
        },
      },
    );

    expect(result.model).toBeUndefined();
    expect(result.effort).toBeUndefined();
    expect(result.models).toEqual({ codex: "mapped-model", claude: "claude-settings" });
    expect(result.efforts).toEqual({ codex: "medium", claude: "max" });
  });

  it("leaves empty route maps empty when no lane has a default", () => {
    const result = resolve({}, { registry: ["codex"] });
    expect(result.models).toEqual({});
    expect(result.efforts).toEqual({});
  });

  it("rejects unknown effort-map lanes at the same owner as model-map lanes", () => {
    expect(() => resolve({ efforts: { typo: "high" } }, { registry: ["codex"] })).toThrow(
      "efforts map names unknown harness 'typo'",
    );
  });
});

describe("resolveRunInputDefaults model choice (#395)", () => {
  const withInstance = (
    input: Partial<RunInput>,
    instance: Record<string, string>,
    harnesses: Record<string, { default_model?: string }> = {},
  ) =>
    resolveRunInputDefaults(
      { repoRoot: "/tmp/project", prompt: "test", mode: "agent", ...input },
      {
        config: config({ harnesses }),
        registryIds: ["raw"],
        instanceModel: (id) => instance[id] ?? null,
      },
    );

  it("freezes run, then saved, then the instance's own choice", () => {
    const instance = { raw: "operator/env" };
    const saved = { raw: { default_model: "saved/model" } };
    expect(withInstance({ models: { raw: "run/model" } }, instance, saved).models).toEqual({
      raw: "run/model",
    });
    expect(withInstance({}, instance, saved).models).toEqual({ raw: "saved/model" });
    expect(withInstance({}, instance).models).toEqual({ raw: "operator/env" });
    expect(withInstance({}, {}).models).toEqual({});
  });

  it("treats a blank model as no choice, falling through to the next one", () => {
    const instance = { raw: "operator/env" };
    expect(withInstance({ models: { raw: "   " } }, instance).models).toEqual({
      raw: "operator/env",
    });
    expect(withInstance({}, instance, { raw: { default_model: "  " } }).models).toEqual({
      raw: "operator/env",
    });
    expect(withInstance({ models: { raw: "" } }, {}).models).toEqual({});
    expect(withInstance({ model: "  ", harnesses: ["raw"] }, {}).models).toEqual({});
  });
});
