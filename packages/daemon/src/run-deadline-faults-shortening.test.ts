/**
 * The run-deadline/1 change matrix for a shortening (10 s → 5 s), every plan of
 * one event, the requested deadline's passing included, with the restarts
 * (the invariants are stated in `run-deadline-faults.test.ts`).
 */
import { afterAll, describe, it } from "vitest";
import { removeTemps, setCase, setMatrix } from "./test-support/run-deadline-faults.js";

afterAll(removeTemps, 0);

const KINDS = [
  "requested",
  "deadline",
  "head-start",
  "warden",
  "terminal",
  "throw",
  "crash",
] as const;
const CASES = await setMatrix([...KINDS], true, { target: 5_000, depth: 1, kinds: [...KINDS] });

describe("run-deadline/1 under faults: one shortening, every plan of one event", () => {
  it.each(CASES)("$name", ({ plan }) => setCase(plan, 5_000));
});
