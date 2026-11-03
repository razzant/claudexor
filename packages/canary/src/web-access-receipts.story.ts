/**
 * [INV-045:web-access-receipts] Through the built CLI and the real daemon, a run
 * states what it requested, what was prepared for each route, whether a native
 * session was reported, what its web evidence covers and, only from the lane's
 * own fact, what became of HOME (#118, #413). Nothing here changes a capability.
 *
 * With CX_WEB_ACCESS_EVIDENCE_DIR set, the surfaces' raw output is kept there.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlRunDetail, ControlThread } from "@claudexor/schema";
import { type Sandbox, cli, makeSandbox, readRunYaml, runFileExists } from "./support.js";

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = makeSandbox();
});
afterEach(() => {
  sandbox.dispose();
});

const EVIDENCE = process.env["CX_WEB_ACCESS_EVIDENCE_DIR"];
function keep(name: string, content: string): void {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, name), content);
}

interface AttemptFacts {
  harness_id: string;
  route_controls?: Record<string, unknown>;
  native_session_started?: boolean;
  harness_home_isolated?: boolean;
}
interface TelemetryFacts {
  attempts: AttemptFacts[];
  web: { observation?: unknown; verification?: string; status?: string };
}

const telemetryOf = (runDir: string) => readRunYaml<TelemetryFacts>(runDir, "final/telemetry.yaml");

function api(sb: Sandbox) {
  const address = JSON.parse(
    readFileSync(join(sb.configDir, "daemon", "control-api.json"), "utf8"),
  );
  const token = readFileSync(join(sb.configDir, "daemon", "token"), "utf8").trim();
  return async (method: string, path: string, body?: unknown, key?: string) => {
    const response = await fetch(`http://${address.host}:${address.port}/v2${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-claudexor-protocol-major": "3",
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, text, body: (text ? JSON.parse(text) : {}) as any };
  };
}

describe("[INV-045:web-access-receipts] run receipts say what was prepared, reported and observed", () => {
  it("an in-place readonly Agent with Web Off, through telemetry, inspect and the Control API", async () => {
    const run = cli(sandbox, [
      "agent",
      "Report what the repository contains",
      "--harness",
      "fake-success",
      "--access",
      "readonly",
      "--web",
      "off",
      "--no-review",
      "--json",
    ]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const { runId, runDir } = run.json() as { runId: string; runDir: string };

    const telemetry = telemetryOf(runDir);
    expect(telemetry.attempts).toHaveLength(1);
    expect(telemetry.attempts[0]).toMatchObject({
      route_controls: {
        web_mechanism: "none",
        access: "readonly",
        native_access: null,
        access_mechanism: "none",
      },
      native_session_started: true,
      // The lane's own fact: this lane did not replace HOME.
      harness_home_isolated: false,
    });
    expect(telemetry.web.observation).toEqual({ evidence: "tool_calls", network: "not_measured" });

    const text = cli(sandbox, ["inspect", runId]);
    expect(text.code, text.stdout + text.stderr).toBe(0);
    keep("inspect-web-off-readonly.txt", text.stdout);
    expect(text.stdout).toContain("access: requested=readonly effective=readonly");
    expect(text.stdout).toContain(
      "access route: harness=fake-success access=readonly native=none mechanism=none os_file_boundary=none_declared native_session=started home=not_scoped",
    );
    expect(text.stdout).toContain("web: policy=off effective=off required=false evidence=none");
    expect(text.stdout).toContain(
      "web route: harness=fake-success mode=off mechanism=none browser=not_injected native_session=started",
    );
    expect(text.stdout).toContain("web scope: evidence=tool_calls network=not_measured");
    expect(text.stdout).not.toMatch(/enforce/i);

    const json = cli(sandbox, ["inspect", runId, "--json"]);
    expect(json.code, json.stdout + json.stderr).toBe(0);
    keep("inspect-web-off-readonly.json", json.stdout);
    const inspected = json.json() as { telemetry: TelemetryFacts };
    expect(inspected.telemetry.attempts[0]?.route_controls).toEqual(
      telemetry.attempts[0]?.route_controls,
    );
    expect(inspected.telemetry.attempts[0]?.native_session_started).toBe(true);
    expect(inspected.telemetry.web.observation).toEqual(telemetry.web.observation);

    const call = api(sandbox);
    const detail = await call("GET", `/runs/${encodeURIComponent(runId)}`);
    expect(detail.status, detail.text).toBe(200);
    keep("api-web-off-readonly.json", JSON.stringify(detail.body.summary, null, 2));
    expect(detail.body.summary.routeControls).toEqual([
      {
        harnessId: "fake-success",
        webMode: "off",
        webMechanism: "none",
        browser: false,
        browserStartup: null,
        access: "readonly",
        nativeAccess: null,
        accessMechanism: "none",
        nativeSessionStarted: true,
        homeScoped: false,
      },
    ]);
    expect(detail.body.summary.webEvidence).toMatchObject({
      mode: "off",
      status: "none",
      verification: "none",
      verifiedContent: null,
      observation: { evidence: "tool_calls", network: "not_measured" },
      available: true,
    });
    // The list projection says the same.
    const listed = await call("GET", "/runs?limit=5");
    expect(listed.status, listed.text).toBe(200);
    const row = (listed.body.runs as { runId: string; routeControls?: unknown }[]).find(
      (candidate) => candidate.runId === runId,
    );
    expect(row?.routeControls).toEqual(detail.body.summary.routeControls);
  });

  it("the HOME fact comes from each lane: envelope scoped, Ask and Plan silent, delegated scoped", async () => {
    // Isolated envelope: the engine gave the child a scoped HOME.
    const envelope = cli(sandbox, [
      "agent",
      "Create the deterministic fixture change",
      "--harness",
      "fake-implement",
      "--no-review",
      "--json",
    ]);
    expect(envelope.code, envelope.stdout + envelope.stderr).toBe(0);
    const envelopeRun = envelope.json() as { runId: string; runDir: string };
    expect(telemetryOf(envelopeRun.runDir).attempts[0]).toMatchObject({
      route_controls: { access: "workspace_write", access_mechanism: "none" },
      native_session_started: true,
      harness_home_isolated: true,
    });
    const envelopeText = cli(sandbox, ["inspect", envelopeRun.runId]);
    keep("inspect-envelope.txt", envelopeText.stdout);
    expect(envelopeText.stdout).toMatch(/access route: .* home=scoped/);

    // Ask and Plan lanes record no applied HOME fact, so nothing is claimed.
    for (const command of ["ask", "plan"]) {
      const lane = cli(sandbox, [command, "What is here?", "--harness", "fake-success", "--json"]);
      expect(lane.code, lane.stdout + lane.stderr).toBe(0);
      const laneRun = lane.json() as { runId: string; runDir: string };
      const attempt = telemetryOf(laneRun.runDir).attempts[0];
      expect(attempt?.route_controls).toMatchObject({ access: "readonly" });
      expect(attempt?.native_session_started).toBe(true);
      expect(attempt?.harness_home_isolated).toBeUndefined();
      const laneText = cli(sandbox, ["inspect", laneRun.runId]);
      keep(`inspect-${command}.txt`, laneText.stdout);
      expect(laneText.stdout).toMatch(/access route: harness=fake-success access=readonly /);
      expect(laneText.stdout).not.toMatch(/access route: .* home=/);
      const detail = await api(sandbox)("GET", `/runs/${encodeURIComponent(laneRun.runId)}`);
      expect(detail.body.summary.routeControls[0].homeScoped).toBeNull();
    }

    // Delegated: the third lane, always scoped, through the real thread API.
    const copy = join(sandbox.home, "delegated-copy");
    execFileSync("git", ["clone", "-q", "--no-hardlinks", sandbox.repo, copy]);
    const call = api(sandbox);
    const created = await call(
      "POST",
      "/threads",
      {
        scope: { kind: "project", root: sandbox.repo },
        workspace: "delegated",
        workspaceRoot: copy,
        mode: "agent",
        access: "full",
        primaryHarness: "fake-session",
        eligibleHarnesses: ["fake-session"],
      },
      "web-access-thread",
    );
    expect(created.status, created.text).toBe(200);
    const thread = created.body as ControlThread;
    const started = await call(
      "POST",
      `/threads/${thread.id}/turns`,
      { prompt: "Check the subject" },
      "web-access-turn",
    );
    expect(started.status, started.text).toBe(200);
    let delegated: ControlRunDetail | undefined;
    await vi.waitFor(
      async () => {
        const read = await call("GET", `/runs/${started.body.runId}`);
        delegated = read.body as ControlRunDetail;
        expect(delegated.summary.state).toBe("succeeded");
      },
      { timeout: 60_000, interval: 100 },
    );
    const [attemptDir] = readdirSync(join(started.body.runDir, "attempts"));
    expect(readRunYaml(started.body.runDir, `attempts/${attemptDir}/attempt.yaml`)).toMatchObject({
      harness_home_isolated: true,
    });
    expect(delegated?.summary.routeControls).toEqual([
      expect.objectContaining({
        harnessId: "fake-session",
        access: "full",
        accessMechanism: "none",
        nativeSessionStarted: true,
        homeScoped: true,
      }),
    ]);
  });

  it("a route refused before it was prepared records no route at all", async () => {
    // Refused at admission, before the gate: this sandbox has no Cursor CLI, and
    // with one, Web Off would refuse a route that has no web switch.
    const refused = cli(sandbox, [
      "ask",
      "What is here?",
      "--harness",
      "cursor",
      "--web",
      "off",
      "--json",
    ]);
    expect(refused.code).not.toBe(0);
    keep("refused-web-off-cursor.json", refused.stdout + refused.stderr);
    const out = refused.json() as { runId: string; runDir: string };
    expect(runFileExists(out.runDir, "final/telemetry.yaml")).toBe(false);
    const text = cli(sandbox, ["inspect", out.runId]);
    keep("inspect-refused-web-off-cursor.txt", text.stdout);
    expect(text.stdout).toContain("evidence=unavailable");
    expect(text.stdout).not.toMatch(/access route:|web route:/);
    const detail = await api(sandbox)("GET", `/runs/${encodeURIComponent(out.runId)}`);
    expect(detail.status, detail.text).toBe(200);
    keep("api-refused-web-off-cursor.json", JSON.stringify(detail.body.summary, null, 2));
    expect(detail.body.summary.routeControls).toEqual([]);
    expect(detail.body.summary.webEvidence).toMatchObject({ mode: "off", available: false });
  });
});
