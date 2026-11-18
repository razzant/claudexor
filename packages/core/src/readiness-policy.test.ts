import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCTOR_TTL_MS, DatedPositives } from "./readiness-policy.js";

describe("dated positive admission facts (INV-135)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("answers only its exact key within the TTL of its physical date, never renewed", () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const facts = new DatedPositives<{ ok: boolean }>();
    facts.set("a", "key-1", now - 10, { ok: true });
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
    facts.set("a", "key-1", Date.now(), 1);
    expect(facts.get("a", null)).toBeUndefined();
    expect(facts.get("a", "key-1")).toBeUndefined();
    facts.set("a", "key-1", Date.now(), 1);
    expect(facts.get("a", "key-2")).toBeUndefined();
    expect(facts.get("a", "key-1")).toBeUndefined();
    facts.set("a", "key-1", Date.now(), 1);
    facts.set("b", "key-1", Date.now(), 2);
    facts.drop((scope) => scope === "a");
    expect(facts.get("a", "key-1")).toBeUndefined();
    expect(facts.get("b", "key-1")).toBe(2);
  });

  it("lets newer contrary evidence win, whichever answer arrives last", () => {
    const facts = new DatedPositives<string>();
    const now = Date.now();
    facts.set("a", "key", now - 30, "older success", now - 30);
    facts.contradict("a", now - 20);
    expect(facts.get("a", "key")).toBeUndefined();
    facts.set("a", "key", now - 30, "older success, late", now - 30);
    expect(facts.get("a", "key")).toBeUndefined();
    facts.set("a", "key", now - 10, "newer success", now - 10);
    facts.contradict("a", now - 15);
    expect(facts.get("a", "key")).toBe("newer success");
    facts.contradict(null, now);
    expect(facts.get("a", "key")).toBeUndefined();
    facts.set("b", "key", now - 5, "started before the floor", now - 5);
    expect(facts.get("b", "key")).toBeUndefined();
  });
});
