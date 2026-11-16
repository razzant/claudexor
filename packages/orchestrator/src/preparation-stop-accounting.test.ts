// #694 r10 (cancel_accounting, visible_preparation): a preparation stop, with or
// without a proven end, releases its lease uncharged (no dispatch happened) and
// completes `cancelled` in phase `workspace`; an unproven end is disclosed with
// what stays held, never folded into a plain cancel. Any other error is left alone.
import { describe, expect, it } from "vitest";
import { PreparationCancelled, PreparationTerminationUnconfirmed } from "@claudexor/workspace";
import { releaseStoppedPreparation } from "./attemptUsageCost.js";

const harness = () => {
  const cancelled: string[] = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  return {
    cancelled,
    events,
    args: {
      ledger: { cancel: (id: string) => cancelled.push(id) },
      leaseId: "lease-1",
      log: {
        emit: (type: string, payload: Record<string, unknown>) => events.push([type, payload]),
      },
      harnessId: "h",
      attemptId: "a1",
    },
  };
};

describe("releaseStoppedPreparation (#694 r10)", () => {
  it("a confirmed stop: lease cancelled, plain cancelled completion", () => {
    const h = harness();
    expect(releaseStoppedPreparation(new PreparationCancelled("stop"), h.args as never)).toBe(true);
    expect(h.cancelled).toEqual(["lease-1"]);
    expect(h.events).toEqual([
      [
        "harness.completed",
        { harness_id: "h", attempt_id: "a1", status: "cancelled", phase: "workspace" },
      ],
    ]);
  });

  it("an unconfirmed stop: lease cancelled too, the completion discloses the held base", () => {
    const h = harness();
    const error = Object.assign(
      new PreparationTerminationUnconfirmed("stop", {
        status: "unconfirmed",
        reason: "output_held",
        rootPid: 7,
        groups: [7],
        directExited: true,
        directExit: Promise.resolve(),
      }),
      { heldBase: "/w/t/a1" },
    );
    expect(releaseStoppedPreparation(error, h.args as never)).toBe(true);
    expect(h.cancelled).toEqual(["lease-1"]);
    expect(h.events[0]?.[1]).toMatchObject({
      status: "cancelled",
      phase: "workspace",
      // The one disclosure shape (the harness terminal's, plus the preparation's reason).
      termination_unconfirmed: {
        survivors: [],
        unresolved: [{ pgid: 7, reason: "output_held" }],
        reason: "output_held",
      },
      held: ["/w/t/a1"],
    });
  });

  it("any other error is not a preparation stop: nothing is released", () => {
    const h = harness();
    expect(releaseStoppedPreparation(new Error("boom"), h.args as never)).toBe(false);
    expect(h.cancelled).toEqual([]);
    expect(h.events).toEqual([]);
  });
});
