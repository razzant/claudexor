import { describe, expect, it } from "vitest";
import { ResolvedConfig } from "@claudexor/schema";
import { daemonRuntimeDiffLines } from "./settings-display.js";

const localConfig = ResolvedConfig.parse({
  project: {},
  trust: {},
  global: {
    runtime: {
      reviewer_timeout_ms: 600_000,
      transient_retry: {
        max_retries: 2,
        initial_delay_ms: 1_000,
        max_delay_ms: 10_000,
      },
    },
  },
});

describe("daemonRuntimeDiffLines", () => {
  it("shows daemon runtime overrides separately from the local shell config", () => {
    expect(
      daemonRuntimeDiffLines(localConfig, {
        sources: [],
        defaultPortfolio: "subscription-first",
        interactionTimeoutMs: 1_200_000,
        routing: {
          defaultPolicy: "auto",
          primaryHarness: null,
          eligibleHarnesses: [],
          envInheritance: "mirror_native",
          authPreference: "auto",
        },
        budget: { maxUsdPerRun: null },
        runtime: {
          reviewerTimeoutMs: 2_400_000,
          harnessInactivityTimeoutMs: 1_200_000,
          transientRetry: {
            maxRetries: 2,
            initialDelayMs: 1_000,
            maxDelayMs: 10_000,
          },
        },
        harnesses: {},
      }),
    ).toEqual([
      "daemon.effective.interaction_timeout_ms: 1200000 (local shell: 900000)",
      "daemon.effective.runtime.reviewer_timeout_ms: 2400000 (local shell: 600000)",
    ]);
  });

  it("stays quiet when daemon and local runtime match", () => {
    expect(
      daemonRuntimeDiffLines(localConfig, {
        sources: [],
        defaultPortfolio: "subscription-first",
        interactionTimeoutMs: 900_000,
        routing: {
          defaultPolicy: "auto",
          primaryHarness: null,
          eligibleHarnesses: [],
          envInheritance: "mirror_native",
          authPreference: "auto",
        },
        budget: { maxUsdPerRun: null },
        runtime: {
          reviewerTimeoutMs: 600_000,
          harnessInactivityTimeoutMs: 1_200_000,
          transientRetry: {
            maxRetries: 2,
            initialDelayMs: 1_000,
            maxDelayMs: 10_000,
          },
        },
        harnesses: {},
      }),
    ).toEqual([]);
  });
});
