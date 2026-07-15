import { describe, expect, it } from "vitest";
import { defaultNativeCodexHome } from "@claudexor/harness-codex";
import {
  codexQuotaInvocation,
  parseCodexRateLimitsResponse,
  refreshCodexQuota,
} from "./codex-quota-source.js";

describe("Codex app-server quota source", () => {
  it("keeps every bucket/window and vendor metadata without an aggregate", () => {
    const [snapshot] = parseCodexRateLimitsResponse(
      {
        rateLimits: { planType: "plus", limitId: "codex" },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1782368577 },
            secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1782387153 },
            burst: { usedPercent: 5, windowDurationMins: 15, resetsAt: 1782351000 },
            metadata: { display: "not a window" },
          },
          review: {
            limitId: "review",
            limitName: "Review",
            primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: 1782360000 },
          },
        },
      },
      new Date("2026-07-15T12:00:00.000Z"),
    );
    expect(snapshot?.subject.plan_label).toBe("plus");
    expect(snapshot?.constraints.map((item) => [item.id, item.used_ratio])).toEqual([
      ["codex:primary", 0.2],
      ["codex:secondary", 0.4],
      ["codex:burst", 0.05],
      ["review:primary", 0.1],
    ]);
  });

  it("binds quota reads to the Claudexor-owned native profile and scrubs provider secrets", () => {
    const invocation = codexQuotaInvocation({
      PATH: "/bin",
      HOME: "/operator",
      CODEX_HOME: "/operator/.codex",
      OPENAI_API_KEY: "secret",
      ANTHROPIC_API_KEY: "other-secret",
      OPENAI_API_BASE: "https://redirect.invalid",
    });

    expect(invocation.args).toEqual([
      "-c",
      'cli_auth_credentials_store="file"',
      "app-server",
      "--stdio",
    ]);
    expect(invocation.env.CODEX_HOME).toBe(defaultNativeCodexHome());
    expect(invocation.env.OPENAI_API_KEY).toBeUndefined();
    expect(invocation.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(invocation.env.OPENAI_API_BASE).toBeUndefined();
    expect(invocation.env.HOME).toBe("/operator");
  });

  it("rejects a missing Codex binary without an unhandled child-process error", async () => {
    await expect(refreshCodexQuota({ bin: "/definitely/missing/claudexor-codex" })).rejects.toThrow(
      "Codex app-server quota refresh failed",
    );
  });
});
