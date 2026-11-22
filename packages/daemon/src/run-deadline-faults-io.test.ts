/**
 * The run-deadline/1 renewal matrix, plans that start with a failed or dying record operation
 * (the invariants are stated in `run-deadline-faults.test.ts`).
 */
import { afterAll, describe, it } from "vitest";
import { removeTemps, setCase, setMatrix } from "./test-support/run-deadline-faults.js";

afterAll(removeTemps, 0);

const CASES = await setMatrix(["throw", "crash"], false);

describe("run-deadline/1 under faults: one renewal, plans that start with a failed or dying record operation", () => {
  it.each(CASES)("$name", ({ plan }) => setCase(plan));
});
