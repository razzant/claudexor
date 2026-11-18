import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCTOR_TTL_MS, DatedPositives } from "./readiness-policy.js";

describe("dated positive admission facts (INV-135)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("answers only its exact key within the TTL of its physical date, never renewed", () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const facts = new DatedPositives<{ ok: boolean }>();
    facts.observe("a")({ key: "key-1", at: now - 10, value: { ok: true } });
    now += DOCTOR_TTL_MS - 11;
    const hit = facts.get("a", "key-1");
    expect(hit).toEqual({ ok: true });
    hit!.ok = false;
    expect(facts.get("a", "key-1")).toEqual({ ok: true });
    now += 1;
    expect(facts.get("a", "key-1")).toBeUndefined();
  });

  it("drops a fact on a mismatched or unknown key, and by scope", () => {
    const facts = new DatedPositives<number>();
    facts.observe("a")({ key: "key-1", at: Date.now(), value: 1 });
    expect(facts.get("a", null)).toBeUndefined();
    expect(facts.get("a", "key-1")).toBeUndefined();
    facts.observe("a")({ key: "key-1", at: Date.now(), value: 1 });
    expect(facts.get("a", "key-2")).toBeUndefined();
    expect(facts.get("a", "key-1")).toBeUndefined();
    facts.observe("a")({ key: "key-1", at: Date.now(), value: 1 });
    facts.observe("b")({ key: "key-1", at: Date.now(), value: 2 });
    facts.drop((scope) => scope === "a");
    expect(facts.get("a", "key-1")).toBeUndefined();
    expect(facts.get("b", "key-1")).toBe(2);
  });

  it("lets newer contrary evidence win, whichever answer arrives last", () => {
    const facts = new DatedPositives<string>();
    const now = Date.now();
    const earlier = facts.observe("a");
    const later = facts.observe("a");
    later();
    earlier({ key: "key", at: now, value: "older success" });
    expect(facts.get("a", "key")).toBeUndefined();
    const refusal = facts.observe("a");
    facts.observe("a")({ key: "key", at: now, value: "newer success" });
    refusal();
    expect(facts.get("a", "key")).toBe("newer success");
    const pending = facts.observe("b");
    facts.drop();
    pending({ key: "key", at: now, value: "late" });
    expect(facts.get("a", "key")).toBeUndefined();
    expect(facts.get("b", "key")).toBeUndefined();
  });
});
