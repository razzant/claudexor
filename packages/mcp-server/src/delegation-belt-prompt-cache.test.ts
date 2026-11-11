import { describe, expect, it } from "vitest";
import { DELEGATION_ENV } from "@claudexor/util";
import { readDelegationPolicy } from "./delegation-belt.js";

const base = {
  [DELEGATION_ENV.parentRunId]: "parent",
  [DELEGATION_ENV.repoRoot]: "/source",
  [DELEGATION_ENV.depth]: "0",
};

describe("delegation belt prompt-cache lifetime", () => {
  it("restores the parent's captured lifetime for every child", () => {
    for (const ttl of ["5m", "1h"] as const)
      expect(readDelegationPolicy({ ...base, [DELEGATION_ENV.promptCacheTtl]: ttl })).toMatchObject(
        { promptCacheTtl: ttl },
      );
    expect(readDelegationPolicy(base)).not.toHaveProperty("promptCacheTtl");
  });

  it("fails closed on a garbled captured value", () => {
    expect(() => readDelegationPolicy({ ...base, [DELEGATION_ENV.promptCacheTtl]: "2h" })).toThrow(
      "invalid captured delegation promptCacheTtl",
    );
  });
});
