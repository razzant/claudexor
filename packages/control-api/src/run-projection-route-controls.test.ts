import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { ControlRunSummary, RunTelemetry, SCHEMA_VERSION } from "@claudexor/schema";
import { summarizeRun } from "./run-projection.js";
import type { DaemonRunRecord } from "./run-record.js";

/**
 * #118/#413: the run summary carries what each route was handed for web and
 * file access, and the scope of the web evidence, projected from the engine's
 * telemetry without re-deriving anything.
 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const offWeb = {
  required: false,
  policy: "off",
  effective_mode: "off",
  attempted: false,
  satisfied: false,
  status: "none",
};

function summary(telemetry: Record<string, unknown> | null): ControlRunSummary {
  const runDir = mkdtempSync(join(tmpdir(), "claudexor-route-controls-projection-"));
  roots.push(runDir);
  mkdirSync(join(runDir, "final"));
  if (telemetry) {
    const parsed = RunTelemetry.parse({
      schema_version: SCHEMA_VERSION,
      run_id: "run-rc",
      task_id: "task-rc",
      mode: "agent",
      requested_access: "readonly",
      effective_access: "readonly",
      external_context_policy: "off",
      effective_web_mode: "off",
      web: offWeb,
      generated_at: "2026-11-01T00:00:00.000Z",
      ...telemetry,
    });
    writeFileSync(join(runDir, "final", "telemetry.yaml"), stringifyYaml(parsed));
  }
  const record: DaemonRunRecord = {
    id: "job-rc",
    runId: "run-rc",
    taskId: "task-rc",
    state: "succeeded",
    runDir,
    params: { mode: "agent", prompt: "audit", access: "readonly" },
  };
  return ControlRunSummary.parse(summarizeRun(record));
}

const codex = {
  web_mechanism: "native",
  access: "readonly",
  native_access: "sandbox=read-only approvalPolicy=never approvalsReviewer=auto_review",
  access_mechanism: "fs_sandbox",
};
const claude = {
  web_mechanism: "tools",
  access: "readonly",
  native_access: "--permission-mode plan",
  access_mechanism: "tool_allowlist",
};

describe("route controls and web scope on the run summary", () => {
  it("projects each distinct route once, with the applied HOME fact only where recorded", () => {
    const s = summary({
      attempts: [
        {
          attempt_id: "a01",
          harness_id: "codex",
          web: offWeb,
          route_controls: codex,
          native_session_started: true,
          harness_home_isolated: false,
        },
        {
          attempt_id: "a02",
          harness_id: "codex",
          web: offWeb,
          route_controls: codex,
          native_session_started: true,
          harness_home_isolated: false,
        },
        {
          attempt_id: "a03",
          harness_id: "claude",
          web: offWeb,
          route_controls: claude,
          native_session_started: true,
        },
      ],
    });
    expect(s.routeControls).toEqual([
      {
        harnessId: "codex",
        webMode: "off",
        webMechanism: "native",
        browser: false,
        access: "readonly",
        nativeAccess: codex.native_access,
        accessMechanism: "fs_sandbox",
        nativeSessionStarted: true,
        homeScoped: false,
        browserStartup: null,
      },
      {
        harnessId: "claude",
        webMode: "off",
        webMechanism: "tools",
        browser: false,
        access: "readonly",
        nativeAccess: "--permission-mode plan",
        accessMechanism: "tool_allowlist",
        nativeSessionStarted: true,
        homeScoped: null,
        browserStartup: null,
      },
    ]);
    expect(s.webEvidence.observation).toEqual({ evidence: "tool_calls", network: "not_measured" });
  });

  it("projects the selected Browser's reported startup, and nothing for a route that reported none", () => {
    const browser = (startup?: Record<string, unknown>) => ({
      requested: true,
      server_name: "browser",
      ...(startup ? { startup } : {}),
    });
    const s = summary({
      attempts: [
        {
          attempt_id: "a01",
          harness_id: "codex",
          web: offWeb,
          route_controls: codex,
          native_session_started: true,
          browser: browser({ status: "failed", waited_ms: 812, error: "spawn ENOENT" }),
        },
        {
          attempt_id: "a02",
          harness_id: "codex",
          web: offWeb,
          route_controls: codex,
          native_session_started: true,
          browser: browser({ status: "ready", waited_ms: 2_140 }),
        },
        {
          attempt_id: "a03",
          harness_id: "codex",
          web: offWeb,
          route_controls: codex,
          native_session_started: false,
          browser: browser(),
        },
      ],
    });
    expect(s.routeControls.map((route) => [route.browser, route.browserStartup])).toEqual([
      [true, { status: "failed", waitedMs: 812, error: "spawn ENOENT" }],
      [true, { status: "ready", waitedMs: 2_140, error: null }],
      // Handed to the route but never reported: prepared settings are not a connection.
      [true, null],
    ]);
  });

  it("keeps a route that was only prepared distinct from one whose native session started", () => {
    const s = summary({
      attempts: [
        {
          attempt_id: "a01",
          harness_id: "codex",
          web: offWeb,
          route_controls: codex,
          native_session_started: false,
        },
        {
          attempt_id: "a02",
          harness_id: "codex",
          web: offWeb,
          route_controls: codex,
          native_session_started: true,
        },
      ],
    });
    expect(s.routeControls.map((route) => route.nativeSessionStarted)).toEqual([false, true]);
  });

  it("projects retrieval strength, so a dispatched search is not presented as verified", () => {
    const searched = {
      ...offWeb,
      policy: "auto",
      effective_mode: "cached",
      attempted: true,
      satisfied: true,
      status: "satisfied",
      verification: "dispatched",
      tool: "web_search",
    };
    const s = summary({
      external_context_policy: "auto",
      effective_web_mode: "cached",
      web: searched,
    });
    expect(s.webEvidence).toMatchObject({
      status: "satisfied",
      verification: "dispatched",
      verifiedContent: null,
    });
  });

  it("projects what a verified result showed, so a search never reads as a fetched page", () => {
    for (const content of ["search_results", "page"] as const) {
      const s = summary({
        external_context_policy: "live",
        effective_web_mode: "live",
        web: {
          ...offWeb,
          policy: "live",
          effective_mode: "live",
          attempted: true,
          satisfied: true,
          status: "satisfied",
          verification: "verified",
          verified_content: content,
          tool: content === "page" ? "WebFetch" : "WebSearch",
        },
      });
      expect(s.webEvidence).toMatchObject({ verification: "verified", verifiedContent: content });
    }
  });

  it("keeps legacy runs honest: no route facts are invented, unknown stays unknown", () => {
    const legacy = summary({ attempts: [{ attempt_id: "a01", harness_id: "codex", web: offWeb }] });
    expect(legacy.routeControls).toEqual([]);
    const none = summary(null);
    expect(none.routeControls).toEqual([]);
    expect(none.webEvidence.available).toBe(false);
    expect(none.webEvidence.observation).toBeNull();
    expect(none.webEvidence.verification).toBe("none");
    expect(none.webEvidence.verifiedContent).toBeNull();
    // A record from before the content kind existed says nothing about it.
    expect(summary({ web: { ...offWeb, verification: "verified" } }).webEvidence).toMatchObject({
      verification: "verified",
      verifiedContent: null,
    });
  });
});
