/**
 * Every catalog read of a route (the strict pre-run gate, the listing check and the
 * dispatch gate's repeat read) carries the probe mode of the admission that built
 * the route. A withheld mode never widens what an absence may refuse: the
 * harness's own declaration still judges. Fictitious adapter; no provider, no network.
 */
import { describe, expect, it } from "vitest";
import {
  HarnessUnavailableError,
  type HarnessAdapter,
  type HarnessModelSpec,
} from "@claudexor/core";
import { HarnessModel, HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import {
  assertRouteModelsAllowed,
  routeListsModel,
  runModelGovernedRoute,
  type ModelGovernedRoute,
} from "./modelGovernance.js";

const listed = () => [HarnessModel.parse({ id: "listed" })];

/** What the fixture's second (dispatch-time) model preparation answers. */
const PREPARED = {
  model: "listed",
  receipt: {
    requested: null,
    submitted: null,
    submittedNative: null,
    observed: "unknown" as const,
    observedNative: [],
    reason: null,
    source: "fixture",
  },
  costBasis: { nativeMode: null, kind: "unknown" as const, source: "fixture" },
};

/** One route over an adapter whose catalog read is a recorder. */
function lane(
  catalog: ReturnType<typeof listed>,
  options: { mode?: "forbidden"; absence?: "advisory" } = {},
) {
  const reads: Array<string | null> = [];
  const prepares: Array<string | null> = [];
  const adapter = {
    id: "fixture",
    async prepareProcessing(spec: { diagnosticGeneration?: string }) {
      prepares.push(spec.diagnosticGeneration ?? null);
      return PREPARED;
    },
    async models(spec?: HarnessModelSpec) {
      reads.push(spec?.diagnosticGeneration ?? null);
      return catalog;
    },
    async *run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      yield {
        type: "completed",
        session_id: spec.session_id,
        ts: new Date().toISOString(),
      } as HarnessEvent;
    },
  } as unknown as HarnessAdapter;
  const routed: ModelGovernedRoute = {
    adapter,
    knownModels: [],
    authRouteEstimate: "local_session",
    quotaAdmission: { profile: null },
    settings: null,
    ...(options.absence ? { modelInventory: { model_inventory_absence: options.absence } } : {}),
    ...(options.mode ? { diagnosticGeneration: options.mode } : {}),
  };
  return {
    reads,
    prepares,
    routed,
    admit: (model: string) => assertRouteModelsAllowed([routed], { fixture: model }, "/repo"),
  };
}

describe("the model gate keeps the admission's probe mode", () => {
  it("reads the catalog under the forbidden mode and adds nothing otherwise", async () => {
    const forbidden = lane(listed(), { mode: "forbidden" });
    const allowed = lane(listed());
    await forbidden.admit("listed");
    await allowed.admit("listed");
    expect(forbidden.reads).toEqual(["forbidden"]);
    expect(allowed.reads).toEqual([null]);
  });

  it("leaves the judgement to the harness's own declaration in either mode", async () => {
    // An advisory harness forwards what its answer did not list; an authoritative one refuses.
    await expect(
      lane([], { mode: "forbidden", absence: "advisory" }).admit("pinned"),
    ).resolves.toBeUndefined();
    for (const mode of ["forbidden", undefined] as const)
      await expect(lane([], mode ? { mode } : {}).admit("pinned")).rejects.toBeInstanceOf(
        HarnessUnavailableError,
      );
  });

  it("admits a listed model and refuses an absent one under the forbidden mode", async () => {
    await expect(lane(listed(), { mode: "forbidden" }).admit("listed")).resolves.toBeUndefined();
    await expect(lane(listed(), { mode: "forbidden" }).admit("absent")).rejects.toBeInstanceOf(
      HarnessUnavailableError,
    );
  });

  const dispatchSpec = () =>
    HarnessRunSpec.parse({
      session_id: "ses-gate",
      intent: "audit",
      prompt: "q",
      cwd: "/repo",
      model_hint: "listed",
    });
  async function drain(dispatch: ReturnType<typeof lane>, spec: HarnessRunSpec): Promise<void> {
    for await (const _event of runModelGovernedRoute(dispatch.routed, spec)) {
      // Drained: the gate's own catalog read and preparation happen before the first event.
    }
  }

  it("carries the same mode into the listing check, the dispatch repeat read and its second preparation", async () => {
    const dispatch = lane(listed(), { mode: "forbidden" });
    const spec = dispatchSpec();
    await drain(dispatch, spec);
    expect(await routeListsModel(dispatch.routed, spec, "listed")).toBe(true);
    expect(dispatch.reads).toEqual(["forbidden", "forbidden"]);
    expect(dispatch.prepares).toEqual(["forbidden"]);
  });

  it("adds no mode to the repeat read or the second preparation when allowed", async () => {
    const dispatch = lane(listed());
    await drain(dispatch, dispatchSpec());
    expect(dispatch.reads).toEqual([null]);
    expect(dispatch.prepares).toEqual([null]);
  });
});
