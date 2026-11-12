import { describe, expect, it } from "vitest";
import {
  attemptTelemetryRecord,
  browserUnused,
  createAttemptTelemetry,
  observeAttemptTelemetry,
  webUnsatisfied,
} from "./attemptTelemetry.js";
import type { HarnessEvent } from "@claudexor/schema";
import { CodexBrowserStartup } from "../../harness-codex/src/app-server-mcp-startup.js";
import { beginNativeRetry } from "./native-retry-telemetry.js";

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
        // #118: the adapter's typed stamp for a result that shows a loaded page.
        web_retrieval: "verified",
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

  it("a successful Browser call that read no web page satisfies the gate but retrieves nothing (#118)", () => {
    for (const result of [
      { name: "mcp__browser__browser_close", kind: "mcp", status: "ok" },
      { name: "browser_click", kind: "mcp", target: "browser:browser_click", status: "ok" },
      // An unstamped result proves the call completed, not what it retrieved.
      { name: "browser_navigate", kind: "mcp", target: "browser:browser_navigate", status: "ok" },
    ]) {
      const t = armed();
      observeAttemptTelemetry(t, ev("tool_result", result));
      // The required-web gate is unchanged: any completed Browser call counts.
      expect(t.browser.satisfied).toBe(true);
      expect(t.web.satisfied).toBe(true);
      expect(webUnsatisfied(t)).toBe(false);
      // The strength says no page or search was retrieved, not "web reached".
      expect(t.web.verification, result.name).toBe("none");
      expect(t.web.verifiedContent).toBeNull();
      expect(attemptTelemetryRecord("a", "claude", t).web).toMatchObject({
        status: "satisfied",
        verification: "none",
        verified_content: null,
      });
    }
  });

  it("a Browser page read that reached an error page is dispatch strength", () => {
    const t = armed();
    observeAttemptTelemetry(
      t,
      ev("tool_result", {
        name: "mcp__browser__browser_navigate",
        kind: "mcp",
        status: "ok",
        web_retrieval: "dispatched",
      }),
    );
    expect(t.web.verification).toBe("dispatched");
    expect(t.web.verifiedContent).toBeNull();
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

describe("#118 what a verified web result showed", () => {
  const result = (name: string, content: string) =>
    ev("tool_result", {
      name,
      kind: name.startsWith("mcp__") ? "mcp" : "web",
      target: "x",
      status: "ok",
      web_retrieval: "verified",
      web_content: content,
    });

  it("Claude WebSearch is verified search results, never a fetched page", () => {
    const t = createAttemptTelemetry("live", true, "live");
    observeAttemptTelemetry(t, result("WebSearch", "search_results"));
    expect(t.web.verification).toBe("verified");
    expect(t.web.verifiedContent).toBe("search_results");
    expect(attemptTelemetryRecord("a", "claude", t).web).toMatchObject({
      verification: "verified",
      verified_content: "search_results",
    });
  });

  it("a page outranks search results in either order and is never displaced", () => {
    for (const order of [
      ["WebSearch", "WebFetch", "WebSearch"],
      ["WebFetch", "WebSearch"],
    ]) {
      const t = armed();
      for (const name of order)
        observeAttemptTelemetry(t, result(name, name === "WebSearch" ? "search_results" : "page"));
      expect(t.web.verifiedContent, order.join(" > ")).toBe("page");
    }
    const t = armed();
    observeAttemptTelemetry(t, result("WebSearch", "search_results"));
    observeAttemptTelemetry(t, result("mcp__browser__browser_snapshot", "page"));
    expect(t.web.verifiedContent).toBe("page");
  });

  it("a verified stamp without a content kind keeps what is known", () => {
    const t = createAttemptTelemetry("live", true, "live");
    observeAttemptTelemetry(
      t,
      ev("tool_result", {
        name: "WebFetch",
        kind: "web",
        status: "ok",
        web_retrieval: "verified",
      }),
    );
    expect(t.web.verification).toBe("verified");
    expect(t.web.verifiedContent).toBeNull();
  });
});

describe("#215 the selected Browser's startup outcome", () => {
  /** The real Codex producer's one receipt for a Browser that reached `state`. */
  function receipt(state: "ready" | "failed" | "starting" | null, error?: string): HarnessEvent {
    const startup = new CodexBrowserStartup({
      browser: { output_dir: null, headless: true },
      external_context_policy: "live",
    });
    if (state) startup.observe(state, error);
    startup.finishWait(1_234);
    return startup.takeEvents("s")[0]!;
  }

  it("records each outcome exactly as the adapter reported it", () => {
    for (const [state, error, status] of [
      ["ready", undefined, "ready"],
      ["failed", "spawn ENOENT token=sk-secret-123456789012345678901234", "failed"],
      ["starting", undefined, "starting"],
      [null, undefined, "not_observed"],
    ] as const) {
      const t = armed();
      observeAttemptTelemetry(t, receipt(state, error));
      const startup = attemptTelemetryRecord("a", "codex", t).browser?.startup;
      expect(startup, status).toMatchObject({ status, waited_ms: 1_234 });
      if (error) {
        expect(startup?.error).toContain("spawn ENOENT");
        expect(startup?.error).not.toContain("sk-secret-123456789012345678901234");
      } else expect(startup?.error ?? null).toBeNull();
      // A startup verdict is not Browser use: nothing was called or retrieved.
      expect(t.browser.attempted).toBe(false);
      expect(t.web.attempted).toBe(false);
    }
  });

  it("says nothing when no receipt arrived or the Browser was not armed", () => {
    expect(attemptTelemetryRecord("a", "codex", armed()).browser?.startup).toBeUndefined();
    const unarmed = createAttemptTelemetry("live", true, "live");
    observeAttemptTelemetry(unarmed, receipt("ready"));
    expect(attemptTelemetryRecord("a", "codex", unarmed).browser).toBeUndefined();
  });

  it("belongs to one native try: a retry starts without the earlier verdict", () => {
    const t = armed();
    observeAttemptTelemetry(t, receipt("ready"));
    beginNativeRetry(t);
    expect(attemptTelemetryRecord("a", "codex", t).browser?.startup).toBeUndefined();
    observeAttemptTelemetry(t, receipt("failed", "browser exited"));
    expect(attemptTelemetryRecord("a", "codex", t).browser?.startup?.status).toBe("failed");
  });
});
