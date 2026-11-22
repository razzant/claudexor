/**
 * The run-deadline/1 renewal matrix, plans that start with the warden claiming or the terminal arriving
 * (the invariants are stated in `run-deadline-faults.test.ts`).
 */
import { afterAll, describe, it } from "vitest";
import { removeTemps, setCase, setMatrix } from "./test-support/run-deadline-faults.js";

afterAll(removeTemps, 0);

const CASES = await setMatrix(["warden", "terminal"], false);

describe("run-deadline/1 under faults: one renewal, plans that start with the warden claiming or the terminal arriving", () => {
  it.each(CASES)("$name", ({ plan }) => setCase(plan));
});
