import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EFFORT_PREFERENCE_ORDER, HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { clearCodexEffortCache, codexExecArgs, createCodexAdapter } from "./index.js";
import { codexAppServerThreadParams, type CodexAppServerRunInput } from "./app-server-run.js";
import { codexEffortClampedEvent, codexEffortIgnoredEvent } from "./effort-gate.js";
import {
  CODEX_EFFORT_SNAPSHOT,
  codexEffortFor,
  codexEffortResolution,
  type CodexEffortCatalog,
} from "./effort-probe.js";

/**
 * Owner decision 2026-10-05 (effort ladder): the vendor's own order decides
 * every word it lists; the shared preference order only PLACES a word no codex
 * model lists, onto a level the routed model really advertises. One resolution
 * result feeds the argv, the typed receipt and the timeline disclosure.
 */

/** Two real catalog shapes: a model that stops at xhigh beside one that lists ultra. */
const catalog: CodexEffortCatalog = {
  models: {
    "gpt-5.5": { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
    "gpt-6-astra": { levels: ["low", "medium", "high", "xhigh", "max", "ultra"], default: "low" },
  },
  defaultModel: "gpt-6-astra",
};

beforeEach(() => clearCodexEffortCache());
afterEach(() => clearCodexEffortCache());

function emitted(args: string[]): string | null {
  const hit = args.find((arg) => arg.startsWith("model_reasoning_effort="));
  return hit ? (/"([^"]*)"/.exec(hit)?.[1] ?? null) : null;
}

function runSpec(sessionId: string, model: string, effort: string) {
  return HarnessRunSpec.parse({
    session_id: sessionId,
    intent: "implement",
    prompt: "do it",
    cwd: "/repo",
    model_hint: model,
    effort_hint: effort,
    auth_preference: "auto",
  });
}

const stubs = {
  detectVersion: async () => "codex-cli 0.156.1",
  probeLogin: async () => ({ authed: true, method: "chatgpt" as const, probeError: null }),
  hasApiKey: () => false,
  probeEfforts: async () => catalog,
};

/** Drive the exec path; returns the spawned argv (undefined when nothing spawned). */
async function execRun(spec: HarnessRunSpec) {
  let cliArgs: string[] | undefined;
  const adapter = createCodexAdapter({
    ...stubs,
    runCliHarness: async function* (options): AsyncGenerator<HarnessEvent> {
      cliArgs = options.args;
      yield { type: "completed", session_id: options.spec.session_id, ts: "2026-10-05T00:00:00Z" };
    },
  });
  const events: HarnessEvent[] = [];
  let thrown: unknown;
  try {
    for await (const event of adapter.run(spec)) events.push(event);
  } catch (error) {
    thrown = error;
  }
  const receipt = events.find((event) => event.effort_resolution)?.effort_resolution;
  return { cliArgs, events, receipt, thrown };
}

describe("codex: the vendor order first, the shared order only for words no model lists", () => {
  it("does not spawn codex when the run is stopped at its effort receipt", async () => {
    let spawned = false;
    const adapter = createCodexAdapter({
      ...stubs,
      runCliHarness: async function* (options): AsyncGenerator<HarnessEvent> {
        spawned = true;
        yield {
          type: "completed",
          session_id: options.spec.session_id,
          ts: "2026-10-05T00:00:00Z",
        };
      },
    });
    const stop = new AbortController();
    const spec = runSpec("v-stopped", "gpt-5.5", "high");
    spec.extra["abortSignal"] = stop.signal;
    const events: HarnessEvent[] = [];
    // A consumer that keeps reading after Stop (to drain teardown evidence).
    for await (const event of adapter.run(spec)) {
      events.push(event);
      if (event.effort_resolution) stop.abort();
    }
    expect(events.some((event) => event.effort_resolution)).toBe(true);
    expect(spawned).toBe(false);
  });

  it("gpt-5.5 + ultra clamps to xhigh inside the VENDOR order — no shared placement is claimed", async () => {
    const { cliArgs, receipt, events } = await execRun(runSpec("v-ultra", "gpt-5.5", "ultra"));
    expect(receipt).toMatchObject({
      requested: "ultra",
      submitted: "xhigh",
      resolution: "downward",
    });
    // A sibling lists ultra, so codex's own merged ladder ranks it: the receipt
    // carries no shared-order reason, and the pinned canonical shape is untouched.
    expect(receipt?.reason).toBeUndefined();
    expect(emitted(cliArgs!)).toBe("xhigh");
    const disclosure = events.find((event) => Array.isArray(event.payload?.["ignored_settings"]));
    expect(disclosure?.text).toContain("clamped to xhigh");
    expect(disclosure?.text).not.toContain("shared preference order");
  });

  it.each(["none", "minimal"] as const)(
    "%s is listed by no codex model: the shared order FLOORS it to low, disclosed with its reason",
    async (requested) => {
      const { cliArgs, receipt, events, thrown } = await execRun(
        runSpec(`floor-${requested}`, "gpt-5.5", requested),
      );
      expect(thrown).toBeUndefined();
      expect(receipt).toMatchObject({ requested, submitted: "low", resolution: "floor" });
      expect(receipt?.reason).toContain("shared preference order");
      expect(receipt?.reason).toContain(EFFORT_PREFERENCE_ORDER.join(" < "));
      // One result: the flag sent IS the receipt's submitted value...
      expect(emitted(cliArgs!)).toBe(receipt?.submitted);
      // ...and the timeline event describes that same result, reason included.
      const disclosure = events.find((event) => Array.isArray(event.payload?.["ignored_settings"]));
      expect(disclosure?.text).toContain(`effort=${requested} (clamped to low`);
      expect(disclosure?.text).toContain("shared preference order");
      expect(disclosure?.effort_resolution).toEqual(receipt);
    },
  );

  it("ultra on a catalog where NO model lists it resolves downward by the shared order", async () => {
    const stale: CodexEffortCatalog = {
      models: { "gpt-5.5": catalog.models["gpt-5.5"]! },
      defaultModel: "gpt-5.5",
    };
    const resolved = codexEffortResolution(stale, "gpt-5.5", "ultra");
    expect(resolved.resolution).toMatchObject({ submitted: "xhigh", resolution: "downward" });
    expect(resolved.resolution.reason).toContain("claims neither vendor support");
    expect(codexEffortFor(stale, "gpt-5.5", "ultra")).toBe("xhigh");
  });

  it("a typo stays a typed pre-spawn refusal on this knob route — never a guessed level", async () => {
    const { cliArgs, receipt, thrown } = await execRun(runSpec("typo", "gpt-5.5", "ulta"));
    expect(receipt).toMatchObject({ requested: "ulta", submitted: null, resolution: "rejected" });
    expect(receipt?.reason).toContain("outside the shared preference order");
    expect(String(thrown)).toMatch(/cannot place/);
    expect(cliArgs).toBeUndefined();
  });

  it("contradicting vendor lists disable BOTH orders; an advertised level still passes verbatim", () => {
    const disputed: CodexEffortCatalog = {
      models: {
        "gpt-a": { levels: ["low", "high"], default: "low" },
        "gpt-b": { levels: ["high", "low"], default: "high" },
      },
      defaultModel: "gpt-a",
    };
    // `none` is in the shared order, but the vendor disputes low<high, so the
    // fallback has no honest rank either: refuse rather than invent.
    expect(codexEffortResolution(disputed, "gpt-a", "none").resolution.resolution).toBe("rejected");
    expect(codexEffortFor(disputed, "gpt-a", "high")).toBe("high");
  });
});

describe("codex: argv, receipt and disclosure come from ONE result", () => {
  it("the exec builder sends the receipt's submitted value instead of resolving again", () => {
    const base = {
      access: "workspace_write" as const,
      model_hint: "gpt-6-astra",
      effort_hint: "ultra",
      external_context_policy: "auto" as const,
      prompt: "hello",
      instructions: undefined,
      attachments: [],
      browser: null,
    };
    // Without a receipt the builder resolves through the same function (snapshot).
    expect(emitted(codexExecArgs(base))).toBe(
      codexEffortFor(CODEX_EFFORT_SNAPSHOT, "gpt-6-astra", "ultra"),
    );
    // With one, the receipt wins outright — including "send nothing".
    expect(emitted(codexExecArgs(base, { effort: "high" }))).toBe("high");
    expect(emitted(codexExecArgs(base, { effort: null }))).toBeNull();
    expect(emitted(codexExecArgs({ ...base, resume_session_id: "s" }, { effort: "low" }))).toBe(
      "low",
    );
  });

  it("the app-server thread params take the same receipt value", () => {
    const spec = runSpec("thread", "gpt-6-astra", "ultra");
    expect(codexAppServerThreadParams(spec)["config"]).toMatchObject({
      model_reasoning_effort: "ultra",
    });
    expect(codexAppServerThreadParams(spec, "high")["config"]).toMatchObject({
      model_reasoning_effort: "high",
    });
    expect(codexAppServerThreadParams(spec, null)["config"]).not.toHaveProperty(
      "model_reasoning_effort",
    );
  });

  it("the app-server RUN hands its transport the receipt's submitted value", async () => {
    let input: CodexAppServerRunInput | undefined;
    const adapter = createCodexAdapter({
      ...stubs,
      runAppServer: async function* (received): AsyncGenerator<HarnessEvent> {
        input = received;
        yield {
          type: "completed",
          session_id: received.spec.session_id,
          ts: "2026-10-05T00:00:00Z",
        };
      },
    });
    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(runSpec("app-floor", "gpt-5.5", "minimal")))
      events.push(event);
    const receipt = events.find((event) => event.effort_resolution)?.effort_resolution;
    expect(receipt).toMatchObject({ requested: "minimal", submitted: "low", resolution: "floor" });
    expect(input?.effort).toBe("low");
    expect(codexAppServerThreadParams(input!.spec, input!.effort)["config"]).toMatchObject({
      model_reasoning_effort: "low",
    });
  });

  it("every (model, word) pair: flag, receipt and the two disclosure seams agree", () => {
    const words = [...EFFORT_PREFERENCE_ORDER, "ulta", "hyperdrive"];
    for (const model of ["gpt-5.5", "gpt-6-astra", "gpt-unlisted", null]) {
      for (const requested of words) {
        const resolved = codexEffortResolution(catalog, model, requested);
        const { submitted, resolution } = resolved.resolution;
        const spec = { session_id: "s", model_hint: model, effort_hint: requested };
        expect(codexEffortFor(catalog, model, requested)).toBe(submitted);
        const ignored = codexEffortIgnoredEvent(catalog, spec, resolved);
        const clamped = codexEffortClampedEvent(catalog, spec, resolved);
        // Exactly one seam per outcome: nothing sent → ignored; moved → clamped.
        expect(ignored !== null).toBe(submitted === null);
        expect(clamped !== null).toBe(resolution === "downward" || resolution === "floor");
        // Only a level the final model really advertises is ever submitted.
        if (submitted !== null) {
          const advertised = catalog.models[model ?? catalog.defaultModel!]?.levels ?? [
            ...catalog.models["gpt-6-astra"]!.levels,
          ];
          expect(advertised).toContain(submitted);
        }
      }
    }
  });
});
