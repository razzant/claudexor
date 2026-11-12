import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HarnessEvent, HarnessModel, HarnessRunSpec } from "@claudexor/schema";
import { orderedAppender } from "@claudexor/util";
import { createCursorAdapter } from "../../harness-cursor/src/index.js";
import { createReviewerArtifactContext } from "../../review/src/reviewerArtifacts.js";
import {
  prepareReviewerRunSpec,
  recordPreparedEffort,
} from "../../review/src/reviewerPreparation.js";
import { runModelGovernedRoute } from "./modelGovernance.js";

it.each(["grok-4.7-high", "grok-4.7-xhigh"])(
  "discloses an exact effort selection only when it changes the requested model %s",
  async (model) => {
    const root = mkdtempSync(join(tmpdir(), "effort-disclosure-"));
    try {
      const adapter = createCursorAdapter({
        cursorApiKey: () => "fixture-key",
        smokeIsolatedApiKey: async () => ({ ok: true, detail: "fixture" }),
        listCursorModels: async () =>
          ["grok-4.7-high", "grok-4.7-xhigh"].map((id) => HarnessModel.parse({ id })),
        runCliHarness: async function* ({ spec }) {
          yield { type: "completed", session_id: spec.session_id, ts: new Date(0).toISOString() };
        },
      });
      const spec = HarnessRunSpec.parse({
        session_id: "effort-disclosure",
        intent: "explain",
        cwd: root,
        prompt: "fixture",
        auth_preference: "api_key",
        model_hint: model,
        effort_hint: "xhigh",
      });
      const events: HarnessEvent[] = [];
      for await (const event of runModelGovernedRoute(
        {
          adapter,
          knownModels: [],
          modelInventory: { model_inventory_absence: "advisory" },
          authRouteEstimate: "api_key",
          quotaAdmission: { profile: null },
          settings: null,
        },
        spec,
      ))
        events.push(event);
      const receipts = events.filter((event) => event.effort_resolution);
      expect(receipts).toHaveLength(1);

      const prepared = await prepareReviewerRunSpec(adapter, spec);
      const artifact = createReviewerArtifactContext(root, 0, {
        adapter,
        providerFamily: "cursor",
      });
      recordPreparedEffort(artifact, spec.session_id, prepared.effort, new Set(), prepared.spec);
      // The receipt line is queued on the ordered appender: read it once landed.
      await orderedAppender.settled(artifact.eventsPath);
      const reviewerEvent = JSON.parse(readFileSync(artifact.eventsPath, "utf8"));
      for (const event of [receipts[0]!, reviewerEvent]) {
        expect(HarnessEvent.parse(event).effort_resolution).toMatchObject({
          parameter: "--model",
          requested: "xhigh",
          submitted: "xhigh",
          resolution: "exact",
        });
        if (model === "grok-4.7-high") {
          expect.soft(event.text).toContain("[effort] effort=xhigh: exact; submitted=xhigh");
          expect.soft(event.text).toContain('selected the listed variant "grok-4.7-xhigh"');
          expect.soft(event.text).toContain('requested model "grok-4.7-high"');
          // An exact selection is information, never an ignored-setting warning.
          expect.soft(event.payload?.["ignored_settings"]).toBeUndefined();
        } else {
          expect(event.text).toBeUndefined();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
