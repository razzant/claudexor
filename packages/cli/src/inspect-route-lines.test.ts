import { describe, expect, it } from "vitest";
import { RunTelemetry, SCHEMA_VERSION } from "@claudexor/schema";
import { accessRouteLines, webRouteLines } from "./inspect-route-lines.js";

/**
 * #118/#413: `claudexor inspect` states what each route was handed for file and
 * web access and what the web evidence covers, projected from telemetry.
 */
const offWeb = { policy: "off", effective_mode: "off", status: "none" };

function telemetry(attempts: Record<string, unknown>[], web: Record<string, unknown> = offWeb) {
  return RunTelemetry.parse({
    schema_version: SCHEMA_VERSION,
    run_id: "run-lines",
    task_id: "task-lines",
    mode: "agent",
    requested_access: "readonly",
    effective_access: "readonly",
    external_context_policy: "off",
    effective_web_mode: "off",
    web,
    attempts,
    generated_at: "2026-11-01T00:00:00.000Z",
  });
}

const cursor = {
  attempt_id: "a01",
  harness_id: "cursor",
  web: { policy: "auto", effective_mode: "auto" },
  browser: { requested: true, server_name: "browser" },
  route_controls: {
    web_mechanism: "uncontrolled",
    access: "readonly",
    native_access: "--force --sandbox enabled --trust --mode ask",
    access_mechanism: "tool_allowlist",
  },
  native_session_started: true,
  harness_home_isolated: false,
};
const codex = {
  attempt_id: "a02",
  harness_id: "codex",
  web: offWeb,
  route_controls: {
    web_mechanism: "native",
    access: "readonly",
    native_access: "sandbox=read-only approvalPolicy=never approvalsReviewer=auto_review",
    access_mechanism: "fs_sandbox",
  },
  native_session_started: false,
};
const inherited = {
  attempt_id: "a04",
  harness_id: "claude",
  web: { policy: "auto", effective_mode: "auto" },
  route_controls: {
    web_mechanism: "tools",
    access: "inherit_native",
    native_access: null,
    access_mechanism: "native_settings",
  },
  native_session_started: true,
  harness_home_isolated: true,
};

describe("inspect route lines", () => {
  it("names each route's native access, its mechanism and the OS boundary it lacks", () => {
    expect(accessRouteLines(telemetry([cursor, codex, { ...codex, attempt_id: "a03" }]))).toEqual([
      'access route: harness=cursor access=readonly native="--force --sandbox enabled --trust --mode ask" mechanism=tool_allowlist os_file_boundary=none_declared native_session=started home=not_scoped',
      'access route: harness=codex access=readonly native="sandbox=read-only approvalPolicy=never approvalsReviewer=auto_review" mechanism=fs_sandbox os_file_boundary=vendor_sandbox native_session=not_reported',
    ]);
  });

  it("inherit_native states what passed and leaves the boundary unknown, never absent", () => {
    expect(accessRouteLines(telemetry([inherited]))).toEqual([
      "access route: harness=claude access=inherit_native native=none mechanism=native_settings os_file_boundary=unknown native_session=started home=scoped",
    ]);
  });

  it("names each route's web switch and the scope of the web evidence", () => {
    expect(webRouteLines(telemetry([cursor, codex]))).toEqual([
      "web route: harness=cursor mode=auto mechanism=uncontrolled browser=injected browser_startup=not_reported native_session=started",
      "web route: harness=codex mode=off mechanism=native browser=not_injected native_session=not_reported",
      "web scope: evidence=tool_calls network=not_measured",
    ]);
  });

  it("states the scope and verification strength even when no route receipt exists", () => {
    const searched = {
      policy: "auto",
      effective_mode: "cached",
      attempted: true,
      satisfied: true,
      status: "satisfied",
      verification: "dispatched",
    };
    expect(accessRouteLines(telemetry([]))).toEqual([]);
    expect(webRouteLines(telemetry([], searched))).toEqual([
      "web retrieval: dispatched",
      "web scope: evidence=tool_calls network=not_measured",
    ]);
  });

  it("states the selected Browser's reported startup beside the route, never inferring one", () => {
    const route = (startup?: Record<string, unknown>) => ({
      ...codex,
      browser: { requested: true, server_name: "browser", ...(startup ? { startup } : {}) },
    });
    const line = (startup?: Record<string, unknown>) =>
      webRouteLines(telemetry([route(startup)]))[0];
    expect(line({ status: "ready", waited_ms: 2140 })).toContain(
      "browser=injected browser_startup=ready waited_ms=2140",
    );
    expect(line({ status: "failed", waited_ms: 812, error: "spawn ENOENT" })).toContain(
      'browser=injected browser_startup=failed waited_ms=812 browser_startup_error="spawn ENOENT"',
    );
    expect(line()).toContain("browser=injected browser_startup=not_reported native_session");
  });

  it("names what a verified result showed, and says when completed calls retrieved nothing", () => {
    const satisfied = { ...offWeb, attempted: true, satisfied: true, status: "satisfied" };
    const line = (web: Record<string, unknown>) => webRouteLines(telemetry([], web))[0];
    expect(
      line({ ...satisfied, verification: "verified", verified_content: "search_results" }),
    ).toBe("web retrieval: verified (search results)");
    expect(line({ ...satisfied, verification: "verified", verified_content: "page" })).toBe(
      "web retrieval: verified (page)",
    );
    // An older record without the content kind keeps its plain strength.
    expect(line({ ...satisfied, verification: "verified" })).toBe("web retrieval: verified");
    // A Browser close or click completed, but no page or search result was retrieved.
    expect(line({ ...satisfied, verification: "none" })).toBe("web retrieval: none");
    expect(line(offWeb)).toBe("web scope: evidence=tool_calls network=not_measured");
  });
});
