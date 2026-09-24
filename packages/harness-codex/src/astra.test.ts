import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasModelInventoryForRoute, validateModel } from "@claudexor/core";
import { HarnessRunSpec, knownModelIdsForRoute, type HarnessEvent } from "@claudexor/schema";
import { CODEX_VENDOR_CLI_VERSION, clearCodexEffortCache, createCodexAdapter } from "./index.js";
import { readModelListEfforts, type CodexEffortCatalog } from "./effort-probe.js";

const captured = JSON.parse(
  readFileSync(new URL("../fixtures/models-0.156.1.json", import.meta.url), "utf8"),
) as { data: unknown[] };
const capturedCatalog = readModelListEfforts(captured.data);

beforeEach(() => {
  clearCodexEffortCache();
  for (const kind of ["INPUT", "OUTPUT", "CACHED"])
    vi.stubEnv(`CLAUDEXOR_CODEX_PRICE_${kind}`, undefined);
});
afterEach(() => {
  clearCodexEffortCache();
  vi.unstubAllEnvs();
});

describe("GPT-6 Astra on the pinned Codex CLI", () => {
  it.each(["live", "snapshot"] as const)(
    "admits Astra and sends ultra unchanged with the %s catalog",
    async (source) => {
      expect(CODEX_VENDOR_CLI_VERSION).toBe("0.156.1");
      expect(capturedCatalog).not.toBeNull();
      let cliArgs: string[] | undefined;
      const adapter = createCodexAdapter({
        detectVersion: async () => `codex-cli ${CODEX_VENDOR_CLI_VERSION}`,
        probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
        hasApiKey: () => false,
        probeEfforts: async () => (source === "live" ? capturedCatalog : null),
        runCliHarness: async function* (options): AsyncGenerator<HarnessEvent> {
          cliArgs = options.args;
          yield* options.parseEvent?.(
            { type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 10 } },
            options.spec.session_id,
          ) ?? [];
          yield {
            type: "completed",
            session_id: options.spec.session_id,
            ts: "2026-09-05T00:00:00.000Z",
          };
        },
      });
      const manifest = await adapter.discover();
      const known = knownModelIdsForRoute(manifest.capabilities.known_models, "local_session");
      expect(validateModel("gpt-6-astra", known, "manifest").status).toBe("ok");
      expect(manifest.capabilities.model_effort_levels["gpt-6-astra"]).toEqual({
        levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
        // 0.156.1 moved astra's advertised default down from `medium`.
        default: "low",
      });
      for (const hidden of ["gpt-reserve", "codex-auto-review"])
        expect(validateModel(hidden, known, "manifest").status).toBe("rejected");

      const spec = HarnessRunSpec.parse({
        session_id: `astra-${source}`,
        intent: "explain",
        prompt: "Return the requested short answer.",
        cwd: "/repo",
        access: "readonly",
        model_hint: "gpt-6-astra",
        effort_hint: "ultra",
        auth_preference: "subscription",
      });
      const events: HarnessEvent[] = [];
      for await (const event of adapter.run(spec)) events.push(event);
      expect(cliArgs).toBeDefined();
      expect(cliArgs![cliArgs!.indexOf("-m") + 1]).toBe("gpt-6-astra");
      expect(cliArgs).toContain('model_reasoning_effort="ultra"');
      expect(events.some((event) => event.type === "error")).toBe(false);
      const usage = events.find((event) => event.type === "usage")?.usage;
      expect(usage?.input_tokens).toBe(1000);
      expect(usage?.cost_usd).toBeUndefined();
      expect(usage?.estimated).toBeUndefined();
      expect(
        events.find((event) => Array.isArray(event.payload?.["ignored_settings"])),
      ).toBeUndefined();
    },
  );
});

/**
 * The live refusal this change removes. `model/list` answered with the CLI's
 * bundled default list — the same five ids, in the same shape, with astra
 * dropped from the front and gpt-5.2 appended at the back — while the very
 * same accounts ran astra. The manifest now declares that this inventory
 * proves presence only (INV-104), so the run goes to the vendor.
 */
describe("the codex adapter under a stale model/list (the gate itself: modelGovernance.test.ts)", () => {
  const STALE: CodexEffortCatalog = {
    models: Object.fromEntries(
      ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2"].map((id) => [
        id,
        { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
      ]),
    ),
    defaultModel: "gpt-5.6-sol",
  };

  const staleAdapter = (capture: string[] = []) =>
    createCodexAdapter({
      detectVersion: async () => `codex-cli ${CODEX_VENDOR_CLI_VERSION}`,
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      hasApiKey: () => false,
      probeEfforts: async () => STALE,
      runCliHarness: async function* (options): AsyncGenerator<HarnessEvent> {
        capture.push(...options.args);
        yield {
          type: "completed",
          session_id: options.spec.session_id,
          ts: "2026-09-21T00:00:00Z",
        };
      },
    });

  it("declares its live inventory advisory, scoped to the native route", async () => {
    const manifest = await staleAdapter().discover();
    expect(manifest.capabilities.model_inventory_absence).toBe("advisory");
    expect(manifest.capabilities.model_inventory_routes).toEqual(["local_session"]);
    // The live list omits astra; the manifest (a different truth source, used on
    // other routes) still carries it. Neither is ever swapped for the other.
    const adapter = staleAdapter();
    expect(await adapter.models!({ cwd: "/repo" })).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ id: "gpt-6-astra" })]),
    );
    expect(knownModelIdsForRoute(manifest.capabilities.known_models, "local_session")).toContain(
      "gpt-6-astra",
    );
  });

  it("keeps UNSCOPED consumers on manifest truth, where the gate stays strict", async () => {
    // settings-service (quality tiers + per-harness defaults), the doctor's
    // configuredModelCheck and the capabilities catalog all call
    // `harnessModels(id, cwd, true)` with NO route, so the live producer is not
    // applicable to them and they keep judging against `known_models`.
    const adapter = staleAdapter();
    const routes = (await adapter.discover()).capabilities.model_inventory_routes;
    expect(hasModelInventoryForRoute(adapter, routes, null)).toBe(false);
    expect(hasModelInventoryForRoute(adapter, routes, "api_key")).toBe(false);
    expect(hasModelInventoryForRoute(adapter, routes, "local_session")).toBe(true);
  });

  it.each([
    ["xhigh", 'model_reasoning_effort="xhigh"'],
    ["ultra", null],
  ] as const)(
    "resolves effort %s for a model the stale list lacks, and never drops one silently",
    async (effort, expectedArg) => {
      const args: string[] = [];
      const spec = HarnessRunSpec.parse({
        session_id: `astra-stale-${effort}`,
        intent: "explain",
        prompt: "Return the requested short answer.",
        cwd: "/repo",
        access: "readonly",
        model_hint: "gpt-6-astra",
        effort_hint: effort,
        auth_preference: "subscription",
      });
      const events: HarnessEvent[] = [];
      for await (const event of staleAdapter(args).run(spec)) events.push(event);
      // The model reaches the vendor verbatim either way.
      expect(args[args.indexOf("-m") + 1]).toBe("gpt-6-astra");
      const disclosed = events.find((event) => Array.isArray(event.payload?.["ignored_settings"]));
      if (expectedArg) {
        // A level the stale ladders DO carry rides through, and nothing is disclosed.
        expect(args).toContain(expectedArg);
        expect(disclosed).toBeUndefined();
      } else {
        // A level none of them carries is not sent — and the run SAYS so.
        expect(args.some((arg) => arg.startsWith("model_reasoning_effort="))).toBe(false);
        expect(disclosed?.payload?.["ignored_settings"]).toEqual([
          expect.stringContaining("effort=ultra"),
        ]);
      }
    },
  );
});
