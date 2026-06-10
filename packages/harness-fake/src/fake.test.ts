import { describe, expect, it } from "vitest";
import { runDoctor } from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { createFakeHarness, FAKE_KINDS } from "./index.js";

function registry() {
  const m = new Map();
  for (const k of FAKE_KINDS) m.set(k, createFakeHarness(k));
  return m;
}

function spec(prompt = "do it"): HarnessRunSpec {
  return HarnessRunSpec.parse({ session_id: "ses-test", intent: "implement", prompt, cwd: "/tmp" });
}

async function collect(events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

// The fake adapters are the conformance fixtures for the typed event contract:
// every adapter must emit usage with cost, file changes, and a terminal completed.
describe("fake harness adapters", () => {
  it("fake-success emits file_change, exact usage cost, and a terminal completed", async () => {
    const events = await collect(createFakeHarness("fake-success").run(spec()));
    expect(events.some((e) => e.type === "file_change" && e.payload?.["path"] === "FAKE_CHANGE.txt")).toBe(true);
    const usage = events.find((e) => e.type === "usage");
    expect(usage?.usage?.cost_usd).toBeCloseTo(0.01);
    expect(events[events.length - 1]?.type).toBe("completed");
  });

  it("forwards access profile and model hint through the run spec", async () => {
    const s = HarnessRunSpec.parse({
      session_id: "ses-fwd",
      intent: "implement",
      prompt: "x",
      cwd: "/tmp",
      access: "full",
      model_hint: "some-model",
    });
    // The spec object IS the adapter contract: what the orchestrator sets is
    // exactly what the adapter receives (no engine middleman since v0.7).
    expect(s.access).toBe("full");
    expect(s.model_hint).toBe("some-model");
    const events = await collect(createFakeHarness("fake-success").run(s));
    expect(events.some((e) => e.type === "completed")).toBe(true);
  });

  it("fake-fail-tests still terminates with completed (failure is gate truth, not stream truth)", async () => {
    const events = await collect(createFakeHarness("fake-fail-tests").run(spec()));
    expect(events[events.length - 1]?.type).toBe("completed");
  });

  it("doctor reports fake-invalid-json as degraded with disabled review", async () => {
    const reports = await runDoctor(registry(), { cwd: "/tmp" });
    const degraded = reports.find((r) => r.harness_id === "fake-invalid-json");
    expect(degraded?.status).toBe("degraded");
    expect(degraded?.disabled_intents).toContain("review");
  });
});
