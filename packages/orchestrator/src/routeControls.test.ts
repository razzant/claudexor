import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCliHarness, type HarnessAdapter } from "@claudexor/core";
import { HarnessEvent, HarnessRunSpec, RunTelemetry, SCHEMA_VERSION } from "@claudexor/schema";
import {
  attemptTelemetryRecord,
  createAttemptTelemetry,
  observeAttemptTelemetry,
} from "./attemptTelemetry.js";
import { runModelGovernedRoute, type ModelGovernedRoute } from "./modelGovernance.js";

/**
 * #118/#413: the shared per-spawn gate records what the engine prepared for a
 * route's web and file access, without changing it, and the attempt separately
 * says whether a native session was reported started. A prepared receipt is
 * therefore never read as a process having run it.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ACCESS_CONTROL = {
  readonly_mechanism: "tool_allowlist",
  write_mechanism: "tool_policy",
  auxiliary_writable_roots: false,
} as const;

function routed(adapter: Partial<HarnessAdapter>): ModelGovernedRoute {
  return {
    adapter: { id: "cursor", ...adapter },
    knownModels: [],
    webSupport: "uncontrolled",
    accessControl: ACCESS_CONTROL,
  } as unknown as ModelGovernedRoute;
}

const completing = (nativeAccess?: (spec: HarnessRunSpec) => string | null) => {
  const sent: HarnessRunSpec[] = [];
  const route = routed({
    run: (spec: HarnessRunSpec) => {
      sent.push(spec);
      return (async function* () {
        yield { type: "completed", session_id: spec.session_id, ts: "2026-11-01T00:00:00.000Z" };
      })() as AsyncIterable<HarnessEvent>;
    },
    ...(nativeAccess ? { nativeAccess } : {}),
  });
  return { route, sent };
};

const spec = (access: string, web = "auto", extra: Record<string, unknown> = {}) => {
  const parsed = HarnessRunSpec.parse({
    session_id: "ses-route-controls",
    intent: "implement",
    prompt: "go",
    cwd: tmpdir(),
    access,
    external_context_policy: web,
    env: { AGENT_CLI_CREDENTIAL_STORE: "file" },
  });
  Object.assign(parsed.extra, extra);
  return parsed;
};

async function events(route: ModelGovernedRoute, s: HarnessRunSpec): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const event of runModelGovernedRoute(route, s)) out.push(event);
  return out;
}

/** The orchestrator's own fold, ending in the attempt's telemetry record. */
function fold(evs: HarnessEvent[]) {
  const t = createAttemptTelemetry("auto", false);
  for (const event of evs) observeAttemptTelemetry(t, event);
  return attemptTelemetryRecord("a01", "cursor", t);
}

describe("per-spawn route controls receipt", () => {
  it("records the declared mechanism and the adapter's own native access setting", async () => {
    const { route, sent } = completing((s) =>
      s.access === "readonly" ? "--mode ask --sandbox enabled --force" : null,
    );
    const [receipt] = (await events(route, spec("readonly"))).filter((e) => e.route_controls);
    expect(receipt?.type).toBe("status");
    expect(receipt?.route_controls).toEqual({
      web_mechanism: "uncontrolled",
      access: "readonly",
      native_access: "--mode ask --sandbox enabled --force",
      access_mechanism: "tool_allowlist",
    });
    expect(() => HarnessEvent.parse(receipt)).not.toThrow();
    // Disclosure only: the spec the adapter receives is not changed by it.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.access).toBe("readonly");
  });

  it("names the declared mechanism per profile; inherit_native never reads as no confinement", async () => {
    const { route } = completing();
    const mechanism = async (access: string) =>
      (await events(route, spec(access))).find((e) => e.route_controls)?.route_controls;
    expect(await mechanism("workspace_write")).toMatchObject({
      access_mechanism: "tool_policy",
      native_access: null,
    });
    expect(await mechanism("full")).toMatchObject({ access: "full", access_mechanism: "none" });
    expect(await mechanism("inherit_native")).toMatchObject({
      access: "inherit_native",
      access_mechanism: "native_settings",
    });
  });
});

describe("a prepared receipt stays distinct from a native session that ran", () => {
  it("a stop before dispatch records nothing and never reaches the adapter", async () => {
    const { route, sent } = completing(() => "--force");
    const stop = new AbortController();
    stop.abort();
    const evs = await events(route, spec("readonly", "auto", { abortSignal: stop.signal }));
    expect(evs.filter((e) => e.route_controls)).toEqual([]);
    expect(sent).toEqual([]);
    expect(fold(evs).route_controls).toBeUndefined();
    expect(fold(evs).native_session_started).toBeUndefined();
  });

  it("an adapter's own pre-spawn refusal keeps the prepared receipt but reports no native start", async () => {
    // The exact sequence the real Cursor and Claude refusals produce; their
    // native-access tests prove they launch nothing and emit no `started`.
    const route = routed({
      nativeAccess: () => "--force --sandbox enabled --trust --mode ask",
      run: (s: HarnessRunSpec) =>
        (async function* () {
          yield { type: "error", session_id: s.session_id, ts: "t", error: "not logged in" };
          yield { type: "completed", session_id: s.session_id, ts: "t" };
        })() as AsyncIterable<HarnessEvent>,
    });
    const record = fold(await events(route, spec("readonly")));
    expect(record.route_controls).toMatchObject({
      access: "readonly",
      native_access: "--force --sandbox enabled --trust --mode ask",
    });
    expect(record.native_session_started).toBe(false);
  });

  /** A real child process through the real run loop: `started` comes from its own stdout. */
  function realProcessAdapter(marker: string): Partial<HarnessAdapter> {
    return {
      nativeAccess: () => "--qa-real-process",
      run: (s: HarnessRunSpec) =>
        runCliHarness({
          spec: s,
          bin: process.execPath,
          args: [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");console.log("{}");`,
          ],
          label: "qa-real-process",
          parseEvent: (_obj, sessionId) => [
            { type: "started", session_id: sessionId, ts: "2026-11-01T00:00:00.000Z" },
          ],
        }),
    };
  }

  it("an actual spawn reports the native start under the same receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-route-controls-spawn-"));
    dirs.push(dir);
    const marker = join(dir, "ran");
    const evs = await events(routed(realProcessAdapter(marker)), spec("readonly"));
    expect(existsSync(marker)).toBe(true);
    const types = evs.map((e) => e.type);
    expect(types.indexOf("started")).toBeGreaterThan(evs.findIndex((e) => e.route_controls));
    const record = fold(evs);
    expect(record.route_controls?.native_access).toBe("--qa-real-process");
    expect(record.native_session_started).toBe(true);
  });

  it("a stop that lands right after the receipt dispatches nothing, and keeps the receipt without a start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-route-controls-stop-"));
    dirs.push(dir);
    const marker = join(dir, "ran");
    const stop = new AbortController();
    const seen: HarnessEvent[] = [];
    const t = createAttemptTelemetry("auto", false);
    const real = realProcessAdapter(marker);
    let calls = 0;
    const route = routed({
      ...real,
      run: (s: HarnessRunSpec) => {
        calls += 1;
        return real.run!(s);
      },
    });
    for await (const event of runModelGovernedRoute(
      route,
      spec("readonly", "auto", { abortSignal: stop.signal }),
    )) {
      seen.push(event);
      // The orchestrator's own rule: after Stop, events are stored evidence only,
      // and it keeps reading to drain them.
      if (stop.signal.aborted) continue;
      observeAttemptTelemetry(t, event);
      if (event.route_controls) stop.abort();
    }
    // The gate checks Stop again after the receipt: the adapter is never called,
    // so no child is spawned and nothing after the receipt is reported.
    expect(calls).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(seen.at(-1)?.route_controls?.native_access).toBe("--qa-real-process");
    expect(seen.some((event) => event.type === "started" || event.type === "completed")).toBe(
      false,
    );
    // What was prepared stays on record, and no native start is claimed.
    const record = attemptTelemetryRecord("a01", "cursor", t);
    expect(record.route_controls?.native_access).toBe("--qa-real-process");
    expect(record.native_session_started).toBe(false);
  });

  it("a later refused try does not erase a native session the attempt already started", () => {
    const t = createAttemptTelemetry("auto", false);
    const prepared: HarnessEvent = {
      type: "status",
      session_id: "s",
      ts: "2026-11-01T00:00:00.000Z",
      route_controls: {
        web_mechanism: "native",
        access: "readonly",
        native_access: "sandbox=read-only",
        access_mechanism: "fs_sandbox",
      },
    };
    observeAttemptTelemetry(t, prepared);
    observeAttemptTelemetry(t, { type: "started", session_id: "s", ts: prepared.ts });
    observeAttemptTelemetry(t, prepared); // the next try prepared again and never started
    expect(attemptTelemetryRecord("a01", "codex", t).native_session_started).toBe(true);
  });
});

describe("the attempt record", () => {
  it("carries the applied HOME fact only where the lane recorded one", () => {
    const t = createAttemptTelemetry("off", false);
    const controls = {
      web_mechanism: "native",
      access: "readonly",
      native_access: "sandbox=read-only approvalPolicy=never approvalsReviewer=auto_review",
      access_mechanism: "fs_sandbox",
    } as const;
    observeAttemptTelemetry(t, {
      type: "status",
      session_id: "s",
      ts: "2026-11-01T00:00:00.000Z",
      route_controls: controls,
    });
    const record = attemptTelemetryRecord("a01", "codex", t, { harness_home_isolated: false });
    expect(record.route_controls).toEqual(controls);
    expect(record.harness_home_isolated).toBe(false);
    // No applied fact (Ask/Plan lanes record none): nothing is claimed.
    expect(attemptTelemetryRecord("a02", "codex", t).harness_home_isolated).toBeUndefined();
  });

  it("states the web observation scope on every web record, including legacy ones", () => {
    const t = createAttemptTelemetry("off", false);
    expect(attemptTelemetryRecord("a01", "codex", t).web.observation).toEqual({
      evidence: "tool_calls",
      network: "not_measured",
    });
    const legacy = RunTelemetry.parse({
      schema_version: SCHEMA_VERSION,
      run_id: "run-1",
      task_id: "task-1",
      mode: "ask",
      requested_access: "readonly",
      effective_access: "readonly",
      external_context_policy: "off",
      effective_web_mode: "off",
      web: {},
      generated_at: "2026-11-01T00:00:00.000Z",
    });
    expect(legacy.web.observation).toEqual({ evidence: "tool_calls", network: "not_measured" });
  });
});
