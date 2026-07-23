import { describe, expect, it } from "vitest";
import {
  browserUnused,
  createAttemptTelemetry,
  observeAttemptTelemetry,
  webUnsatisfied,
} from "./attemptTelemetry.js";
import type { HarnessEvent } from "@claudexor/schema";

const ts = "2026-07-23T00:00:00.000Z";

// Browser armed (server "browser") + web required (live policy).
function armed() {
  return createAttemptTelemetry("live", true, "live", [], null, null, "browser");
}

function ev(type: string, tool: Record<string, unknown>): HarnessEvent {
  return { type, session_id: "s", ts, tool } as unknown as HarnessEvent;
}

describe("QA-040 browser MCP evidence", () => {
  it("codex browser navigate (kind=mcp, target browser:...) satisfies web + records browser evidence", () => {
    const t = armed();
    observeAttemptTelemetry(
      t,
      ev("tool_call", {
        name: "browser_navigate",
        kind: "mcp",
        target: "browser:browser_navigate",
      }),
    );
    observeAttemptTelemetry(
      t,
      ev("tool_result", {
        name: "browser_navigate",
        kind: "mcp",
        target: "browser:browser_navigate",
        status: "ok",
      }),
    );
    expect(t.browser.attempted).toBe(true);
    expect(t.browser.satisfied).toBe(true);
    expect(t.web.attempted).toBe(true);
    expect(t.web.satisfied).toBe(true);
    expect(t.web.verification).toBe("verified");
    expect(webUnsatisfied(t)).toBe(false); // no false "never attempted" RED
  });

  it("claude browser navigate (mcp__browser__*) satisfies web too", () => {
    const t = armed();
    observeAttemptTelemetry(
      t,
      ev("tool_call", { name: "mcp__browser__browser_navigate", kind: "mcp" }),
    );
    observeAttemptTelemetry(
      t,
      ev("tool_result", { name: "mcp__browser__browser_navigate", kind: "mcp", status: "ok" }),
    );
    expect(t.browser.satisfied).toBe(true);
    expect(webUnsatisfied(t)).toBe(false);
  });

  it("a failed browser navigate blocks required web with the real error, not 'never attempted'", () => {
    const t = armed();
    observeAttemptTelemetry(
      t,
      ev("tool_result", {
        name: "browser_navigate",
        kind: "mcp",
        target: "browser:browser_navigate",
        status: "error",
        error_summary: "navigation failed",
      }),
    );
    expect(t.browser.attempted).toBe(true);
    expect(t.browser.failed).toBe(true);
    expect(t.web.satisfied).toBe(false);
    expect(webUnsatisfied(t)).toBe(true);
    expect(t.web.errorSummary).toContain("navigation failed");
  });

  it("a user MCP server named otherwise cannot spoof browser evidence", () => {
    const t = armed();
    observeAttemptTelemetry(
      t,
      ev("tool_result", {
        name: "mcp__notes__save",
        kind: "mcp",
        target: "notes:save",
        status: "ok",
      }),
    );
    expect(t.browser.attempted).toBe(false);
    expect(t.web.satisfied).toBe(false);
  });

  it("browser armed but unused while web_search satisfied is disclosed, not failed", () => {
    const t = armed();
    observeAttemptTelemetry(
      t,
      ev("tool_result", {
        name: "web_search",
        kind: "web",
        target: "q",
        status: "ok",
        web_retrieval: "dispatched",
      }),
    );
    expect(t.web.satisfied).toBe(true);
    expect(t.browser.attempted).toBe(false);
    expect(browserUnused(t)).toBe(true);
    expect(webUnsatisfied(t)).toBe(false);
  });

  it("does not treat browser calls as evidence when the browser was NOT armed", () => {
    const t = createAttemptTelemetry("live", true, "live"); // no browser server
    observeAttemptTelemetry(
      t,
      ev("tool_result", {
        name: "browser_navigate",
        kind: "mcp",
        target: "browser:browser_navigate",
        status: "ok",
      }),
    );
    expect(t.browser.requested).toBe(false);
    expect(t.web.satisfied).toBe(false);
  });
});

describe("QA-042 web verification strength", () => {
  it("codex dispatched web_search satisfies the gate at dispatch strength (not verified)", () => {
    const t = createAttemptTelemetry("live", true, "live");
    observeAttemptTelemetry(
      t,
      ev("tool_result", {
        name: "web_search",
        kind: "web",
        target: "u",
        status: "ok",
        web_retrieval: "dispatched",
      }),
    );
    expect(t.web.satisfied).toBe(true); // no false-block
    expect(t.web.verification).toBe("dispatched"); // but NOT "verified"
    expect(webUnsatisfied(t)).toBe(false);
  });

  it("claude verified web result claims verified strength", () => {
    const t = createAttemptTelemetry("live", true, "live");
    observeAttemptTelemetry(
      t,
      ev("tool_result", {
        name: "WebFetch",
        kind: "web",
        target: "u",
        status: "ok",
        web_retrieval: "verified",
      }),
    );
    expect(t.web.verification).toBe("verified");
  });

  it("a verified result is never downgraded by a later dispatched one", () => {
    const t = createAttemptTelemetry("live", true, "live");
    observeAttemptTelemetry(
      t,
      ev("tool_result", {
        name: "WebFetch",
        kind: "web",
        target: "a",
        status: "ok",
        web_retrieval: "verified",
      }),
    );
    observeAttemptTelemetry(
      t,
      ev("tool_result", {
        name: "web_search",
        kind: "web",
        target: "b",
        status: "ok",
        web_retrieval: "dispatched",
      }),
    );
    expect(t.web.verification).toBe("verified");
  });
});
