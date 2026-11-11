import { describe, expect, it } from "vitest";
import { HarnessModel } from "@claudexor/schema";
import { cursorProcessingModels, prepareCursorProcessing } from "./processing.js";
import { createCursorAdapter } from "./index.js";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import type { CliRunLoopOptions } from "@claudexor/core";

const models = [
  "cursor-grok-4.6-xhigh",
  "cursor-grok-4.6-xhigh-fast",
  "cursor-grok-4.6-high-fast",
  "claude-fable-5-1-high",
].map((id) => HarnessModel.parse({ id }));

/** Frozen `cursor@valintine` slice: a standard and a fast grok-4.7 family. */
const grok = [
  "grok-4.7-low",
  "grok-4.7-medium",
  "grok-4.7-high",
  "grok-4.7-xhigh",
  "grok-4.7-low-fast",
  "grok-4.7-medium-fast",
  "grok-4.7-high-fast",
  "grok-4.7-xhigh-fast",
].map((id) => HarnessModel.parse({ id }));

function adapterCapturing(
  listCursorModels: () => Promise<HarnessModel[]>,
  onRun: (opts: CliRunLoopOptions) => void,
) {
  return createCursorAdapter({
    cursorApiKey: () => "fixture-key",
    smokeIsolatedApiKey: async () => ({ ok: true, detail: "fixture" }),
    listCursorModels,
    runCliHarness: async function* (opts): AsyncGenerator<HarnessEvent> {
      onRun(opts);
      yield { type: "completed", session_id: opts.spec.session_id, ts: "2026-09-12T00:00:00Z" };
    },
  });
}

describe("Cursor processing uses listed same-effort variants", () => {
  it("dispatches prepared native variant without rewriting the requested cognitive model", async () => {
    let captured: CliRunLoopOptions | undefined;
    const prepared = prepareCursorProcessing("fast", "cursor-grok-4.6-xhigh", models);
    const adapter = adapterCapturing(
      async () => {
        throw new Error("prepared dispatch must not rediscover");
      },
      (opts) => (captured = opts),
    );
    const spec = HarnessRunSpec.parse({
      session_id: "s",
      intent: "implement",
      prompt: "test",
      cwd: "/repo",
      access: "workspace_write",
      auth_preference: "api_key",
      model_hint: "cursor-grok-4.6-xhigh",
      processing: prepared.receipt,
      processing_cost_basis: prepared.costBasis,
    });
    for await (const _event of adapter.run(spec)) {
      /* consume */
    }
    expect(captured?.args[captured.args.indexOf("--model") + 1]).toBe("cursor-grok-4.6-xhigh-fast");
    expect(captured?.spec.model_hint).toBe("cursor-grok-4.6-xhigh");
  });
  it("honors no-paid policy on an existing Fast selection only through a real ordinary pair", () => {
    expect(
      prepareCursorProcessing(undefined, "cursor-grok-4.6-xhigh-fast", models, false),
    ).toMatchObject({
      model: "cursor-grok-4.6-xhigh",
      receipt: { requested: null, submitted: "standard" },
    });
    expect(
      prepareCursorProcessing(undefined, "cursor-grok-4.6-high-fast", models, false).model,
    ).toBe("cursor-grok-4.6-high-fast");
  });
  it("selects an actual pair and keeps billing and execution unknown", () => {
    expect(prepareCursorProcessing("fast", "cursor-grok-4.6-xhigh", models)).toMatchObject({
      model: "cursor-grok-4.6-xhigh-fast",
      receipt: { submitted: "fast", observed: "unknown" },
      costBasis: { kind: "unknown" },
    });
  });
  it("does not invent a suffix or borrow another effort's variant", () => {
    expect(prepareCursorProcessing("fast", "claude-fable-5-1-high", models).model).toBe(
      "claude-fable-5-1-high",
    );
    expect(
      prepareCursorProcessing(
        "fast",
        "cursor-grok-4.6-xhigh",
        models.filter((m) => m.id !== "cursor-grok-4.6-xhigh-fast"),
      ).model,
    ).toBe("cursor-grok-4.6-xhigh");
  });
  it("preserves deliberately selected native Fast while Economy never creates Fast", () => {
    expect(
      prepareCursorProcessing("standard", "cursor-grok-4.6-xhigh-fast", models).receipt,
    ).toMatchObject({ submitted: "fast", reason: "native_explicit" });
    expect(prepareCursorProcessing("economy", "cursor-grok-4.6-xhigh", models).model).toBe(
      "cursor-grok-4.6-xhigh",
    );
  });
  it("does not turn catalog failure into a missing model or an invented capability", () => {
    expect(prepareCursorProcessing("fast", "cursor-grok-4.6-xhigh", []).model).toBe(
      "cursor-grok-4.6-xhigh",
    );
    expect(
      cursorProcessingModels(models).find((m) => m.id === "claude-fable-5-1-high")?.processing,
    ).toBeUndefined();
  });
});

describe("Cursor effort selects the listed variant of the model's family (one prepared result)", () => {
  it("declares --model as its effort carrier", () => {
    expect(createCursorAdapter().effortParameter).toBe("--model");
  });

  it("model == receipt.submittedNative == argv --model; the effort receipt is the level token", async () => {
    let captured: CliRunLoopOptions | undefined;
    const prepared = prepareCursorProcessing(undefined, "grok-4.7-high", grok, true, "max");
    expect(prepared.model).toBe("grok-4.7-xhigh");
    expect(prepared.receipt.submittedNative).toBe("grok-4.7-xhigh");
    expect(prepared.effort).toMatchObject({
      requested: "max",
      submitted: "xhigh",
      resolution: "downward",
      parameter: "--model",
      source: "account_catalog",
    });
    const adapter = adapterCapturing(
      async () => {
        throw new Error("prepared dispatch must not rediscover");
      },
      (opts) => (captured = opts),
    );
    const spec = HarnessRunSpec.parse({
      session_id: "s-effort",
      intent: "implement",
      prompt: "test",
      cwd: "/repo",
      access: "workspace_write",
      auth_preference: "api_key",
      model_hint: "grok-4.7-high",
      effort_hint: "max",
      processing: prepared.receipt,
      processing_cost_basis: prepared.costBasis,
    });
    for await (const _event of adapter.run(spec)) {
      /* consume */
    }
    expect(captured?.args[captured.args.indexOf("--model") + 1]).toBe(prepared.model);
    // The caller's own hint is the requested id; the final id lives in the receipt.
    expect(captured?.spec.model_hint).toBe("grok-4.7-high");
    expect(captured?.spec.processing?.submittedNative).toBe("grok-4.7-xhigh");
  });

  it("applies the level first and the fast/standard pair after it", () => {
    expect(prepareCursorProcessing("fast", "grok-4.7-high", grok, true, "low")).toMatchObject({
      model: "grok-4.7-low-fast",
      receipt: { requested: "fast", submitted: "fast", submittedNative: "grok-4.7-low-fast" },
      effort: { requested: "low", submitted: "low", resolution: "exact" },
    });
    // none → floor onto the weakest listed level, still inside the fast family.
    expect(
      prepareCursorProcessing(undefined, "grok-4.7-xhigh-fast", grok, true, "none"),
    ).toMatchObject({
      model: "grok-4.7-low-fast",
      effort: { submitted: "low", resolution: "floor" },
    });
  });

  it("the paid policy still runs after the level choice: no-paid turns the chosen fast level into its ordinary twin", () => {
    expect(
      prepareCursorProcessing(undefined, "grok-4.7-xhigh-fast", grok, false, "low"),
    ).toMatchObject({
      model: "grok-4.7-low",
      receipt: {
        submitted: "standard",
        submittedNative: "grok-4.7-low",
        reason: "paid_processing_disallowed; ordinary_variant_selected",
      },
      effort: { submitted: "low", resolution: "exact" },
    });
  });

  it("a direct run with only an effort prepares itself from the live list and sends the selected id", async () => {
    let captured: CliRunLoopOptions | undefined;
    let listed = 0;
    const adapter = adapterCapturing(
      async () => {
        listed += 1;
        return grok;
      },
      (opts) => (captured = opts),
    );
    const spec = HarnessRunSpec.parse({
      session_id: "s-direct",
      intent: "implement",
      prompt: "test",
      cwd: "/repo",
      access: "workspace_write",
      auth_preference: "api_key",
      model_hint: "grok-4.7-high",
      effort_hint: "max",
    });
    for await (const _event of adapter.run(spec)) {
      /* consume */
    }
    expect(listed).toBe(1);
    expect(captured?.args[captured.args.indexOf("--model") + 1]).toBe("grok-4.7-xhigh");
    expect(captured?.spec.processing).toMatchObject({
      requested: null,
      submittedNative: "grok-4.7-xhigh",
    });
  });

  it("an unknown word or an empty account list keeps the id, omitted, with a note — the run proceeds", () => {
    const unknown = prepareCursorProcessing(undefined, "grok-4.7-xhigh-fast", grok, true, "ulta");
    expect(unknown.model).toBe("grok-4.7-xhigh-fast");
    expect(unknown.effort).toMatchObject({
      requested: "ulta",
      submitted: null,
      resolution: "omitted",
    });
    expect(unknown.effort?.reason).toContain("outside the shared preference order");
    const empty = prepareCursorProcessing(undefined, "grok-4.7-high", [], true, "max");
    expect(empty.model).toBe("grok-4.7-high");
    expect(empty.effort).toMatchObject({
      requested: "max",
      submitted: null,
      resolution: "omitted",
    });
    expect(empty.effort?.reason).toContain("--list-models");
  });

  it("without an effort the compound id is sent exactly as written", () => {
    expect(prepareCursorProcessing(undefined, "grok-4.7-high", grok)).toMatchObject({
      model: "grok-4.7-high",
      effort: { requested: null, submitted: null, resolution: "omitted" },
    });
  });
});

describe("Cursor preparation hands its own catalog read to the per-spawn gate", () => {
  it("returns exactly the rows it selected from, out of the same single read", async () => {
    // Synthetic Cursor-style rows; no recorded real catalog/init pair exists.
    const labelled = [
      HarnessModel.parse({ id: "gpt-5.5-high", label: "GPT-5.5 High" }),
      HarnessModel.parse({ id: "gpt-5.5-high-fast", label: "GPT-5.5 High Fast" }),
    ];
    let listed = 0;
    const adapter = adapterCapturing(
      async () => {
        listed += 1;
        return labelled;
      },
      () => undefined,
    );
    const prepared = await adapter.prepareProcessing!({
      cwd: "/repo",
      authPreference: "api_key",
      model: "gpt-5.5-high",
      effort: null,
    });
    expect(listed).toBe(1);
    expect(prepared.model).toBe("gpt-5.5-high");
    expect(prepared.catalog).toEqual(labelled);
  });
});
