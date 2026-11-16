import { describe, expect, it } from "vitest";
import { AnswerAssembly } from "@claudexor/core";
import type { HarnessFailureCategory } from "@claudexor/schema";
import { refusedBeforeOwnWork } from "./rotation-predicate.js";
import type { ContinuedTry } from "./inrun-continuity-carrier.js";
import type { TransientFailureObservation } from "./transientClassify.js";

const observation = (
  category: HarnessFailureCategory,
  entitlementDenied = false,
): TransientFailureObservation => ({
  kind: "unknown",
  category,
  retryable: category === "rate_limited" || category === "unknown_harness_error",
  retryDelayMs: null,
  httpStatus: null,
  signal: null,
  adapterCode: null,
  ...(entitlementDenied ? { entitlementDenied: true as const } : {}),
});
const held = observation("capability_refused", true);
const exit = { ...observation("unknown_harness_error"), retryable: false };
const hop: ContinuedTry = {
  carrier: "native_moved",
  cause: "vendor_limit",
  fromProfileId: "a",
  toProfileId: "b",
  memory: "full",
  inputDelivery: "confirmed",
  summarized: false,
};
const quiet = { sawAgentProgress: false, fileChanges: 0, sawSessionStart: true };
const facts = (over: Partial<Parameters<typeof refusedBeforeOwnWork>[0]> = {}) => ({
  newTransients: [held, exit],
  markers: quiet,
  answer: new AnswerAssembly(),
  harnessErrored: true,
  ...over,
});
const finalAnswer = () => {
  const answer = new AnswerAssembly();
  answer.observe({ type: "message", text: "done", final: true, session_id: "s", ts: "t" } as never);
  return answer;
};

describe("refusedBeforeOwnWork", () => {
  it("holds for the hop target's proven account denial with no work of its own", () => {
    expect(refusedBeforeOwnWork(facts(), hop, undefined)).toBe(true);
    // The candidate lane: the try left the tree exactly as the previous try did.
    expect(refusedBeforeOwnWork(facts({ workspaceIdentity: "tree-1" }), hop, "tree-1")).toBe(true);
    // A packet hop (no movable session) is the same newly selected account.
    expect(refusedBeforeOwnWork(facts(), { ...hop, carrier: "packet" }, undefined)).toBe(true);
  });

  it.each<[string, Parameters<typeof refusedBeforeOwnWork>]>([
    ["the attempt's first try or a fresh replay", [facts(), null, undefined]],
    [
      "a same-account resume",
      [facts(), { ...hop, carrier: "native", fromProfileId: "b" }, undefined],
    ],
    [
      "a successor's or later attempt's first try",
      [facts(), { ...hop, from: { runId: "run-1", attemptId: "a01" } }, undefined],
    ],
    ["no typed refusal (an untyped exit)", [facts({ newTransients: [exit] }), hop, undefined]],
    ["an auth rejection", [facts({ newTransients: [observation("auth_failed")] }), hop, undefined]],
    [
      "a capability refusal not proven account-wide",
      [facts({ newTransients: [observation("capability_refused")] }), hop, undefined],
    ],
    [
      "the denial beside a configuration refusal",
      [facts({ newTransients: [held, observation("config_error")] }), hop, undefined],
    ],
    [
      "agent progress (a started tool counts)",
      [facts({ markers: { ...quiet, sawAgentProgress: true } }), hop, undefined],
    ],
    ["a disclosed file change", [facts({ markers: { ...quiet, fileChanges: 1 } }), hop, undefined]],
    ["an accepted final answer", [facts({ answer: finalAnswer() }), hop, undefined]],
    ["a changed tree", [facts({ workspaceIdentity: "tree-2" }), hop, "tree-1"]],
    ["an unknown tree after the try", [facts({ workspaceIdentity: null }), hop, "tree-1"]],
    ["an unknown tree before the try", [facts({ workspaceIdentity: "tree-1" }), hop, null]],
    ["a tree with no earlier capture", [facts({ workspaceIdentity: "tree-1" }), hop, undefined]],
  ])("never holds for %s", (_name, args) => {
    expect(refusedBeforeOwnWork(...args)).toBe(false);
  });
});
