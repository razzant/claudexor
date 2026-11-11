import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import { runCapture } from "@claudexor/core";
import {
  ConformanceReport,
  HarnessManifest,
  RunFailure,
  type HarnessEvent,
} from "@claudexor/schema";
import { Orchestrator } from "./orchestrator.js";

// A harness that VOICED its own error and then exited non-zero: the failure
// record carries the vendor's own typed failure and stops saying "crashed",
// while retry, rotation, cooldown and credential verdicts behave exactly as
// they did when the same exit was labelled `process_crash`. The neutrality
// tests below go RED when the `retryable: false` override on exit evidence is
// removed (`unknown_harness_error` is retryable in the category table).

const reapDirs: string[] = [];
function reapMk(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  reapDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of reapDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

async function initRepo(): Promise<string> {
  const repo = reapMk("claudexor-vendor-failure-");
  await runCapture("git", ["-C", repo, "init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  await runCapture("git", ["-C", repo, "add", "-A"]);
  await runCapture("git", [
    "-C",
    repo,
    ...["-c", "user.email=t@t.dev", "-c", "user.name=t"],
    ...["commit", "-m", "init"],
  ]);
  return repo;
}

const VENDOR_FAILURE = {
  code: "server_overloaded",
  message: "Selected model is at capacity. Please try a different model.",
  source: "codex_rollout",
};

type Lane = "ask" | "agent";
type Script = (spec: { session_id: string; cwd: string }, spawn: number) => Iterable<unknown>;

/** One stub harness per lane: read-only for `ask`, implement-capable for `agent`. */
function stubAdapter(lane: Lane, spawns: Array<string | null>, script: Script): HarnessAdapter {
  const id = "stub";
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "local",
        capabilities:
          lane === "ask" ? { plan: true, review: true, read_files: true } : { implement: true },
        access_profiles_supported: [lane === "ask" ? "readonly" : "workspace_write"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: lane === "ask" ? ["explain", "audit", "plan", "review"] : ["implement"],
      });
    },
    async probeCredentialProfile(profile) {
      return {
        profile_id: profile.profile_id,
        harness_id: id,
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        detail: "fixture profile verified",
        last_verified_at: new Date().toISOString(),
      };
    },
    async *run(spec) {
      spawns.push(spec.credential_profile?.profile_id ?? null);
      for (const event of script(spec, spawns.length)) yield event as never;
    },
  };
}

interface Observed {
  spawns: Array<string | null>;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  quotaSinkEvents: HarnessEvent[];
  lifecycle: string;
  failure: RunFailure | null;
  /** The returned summary (the daemon job's error). */
  summary: string;
}

async function runLane(lane: Lane, script: Script): Promise<Observed> {
  const repo = await initRepo();
  const spawns: Array<string | null> = [];
  const events: Observed["events"] = [];
  const quotaSinkEvents: HarnessEvent[] = [];
  const res = await new Orchestrator({
    registry: new Map([["stub", stubAdapter(lane, spawns, script)]]),
    reviewers: [],
    quotaEventSink: (_harnessId, event) => void quotaSinkEvents.push(event),
  }).run({
    repoRoot: repo,
    prompt: lane === "ask" ? "2+2?" : "do it",
    mode: lane,
    harnesses: ["stub"],
    ...(lane === "agent" ? { n: 1 } : {}),
    onEvent: (event) =>
      events.push({ type: event.type, payload: event.payload as Record<string, unknown> }),
  });
  const failurePath = join(res.runDir, "final", "failure.yaml");
  const failure = existsSync(failurePath)
    ? RunFailure.parse(new ArtifactStore(repo).readYaml(failurePath))
    : null;
  return {
    spawns,
    events,
    quotaSinkEvents,
    lifecycle: res.lifecycle,
    failure,
    summary: res.summary,
  };
}

/** A PROXY of the installed Ouroboros reader of a failed run's cause
 * (`run_failure_cause`: `failure.safeMessage`, whitespace-collapsed and cut at
 * 512 characters), mirrored here; it is not that reader itself. */
const reportedCause = (failure: RunFailure | null) =>
  (failure?.safeMessage ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 512);
const firstLine = (text: string) => text.split("\n")[0]!;
const SYSTEM_ERROR = "Codex app-server thread settled in systemError";
/** The record's inspection step: quoted and attributed, the same for every code. */
const VENDOR_STEP =
  "Read the vendor's own failure record (codex_rollout: server_overloaded) before retrying";

/** A two-account rotate-policy pool for the stub harness, scoped to one test. */
async function withRotatePool<T>(fn: () => Promise<T>): Promise<T> {
  const configDir = reapMk("claudexor-vendor-failure-config-");
  const previous = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  const row = (profileId: string): string[] => [
    `  - profile_id: ${profileId}`,
    "    harness_id: stub",
    `    display_name: ${profileId}`,
    "    credential_kind: config_dir_login",
    `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", `stub-${profileId}`))}`,
  ];
  writeFileSync(
    join(configDir, "config.yaml"),
    [
      "credential_profiles:",
      ...row("a"),
      ...row("b"),
      "harnesses:",
      "  stub:",
      "    profile_policy:",
      "      limit_action: rotate",
      "",
    ].join("\n"),
  );
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previous;
  }
}

const types = (o: Observed): string[] => o.events.map((e) => e.type);
const continuedCarriers = (o: Observed): unknown[] =>
  o.events
    .filter((e) => e.type === "run.continuity")
    .map((e) => (e.payload["receipt"] as { carrier?: unknown } | undefined)?.carrier);
const started = (s: { session_id: string }, ts: string) => ({
  type: "started",
  session_id: s.session_id,
  ts,
});
const toolCall = (s: { session_id: string }, ts: string) => ({
  type: "tool_call",
  session_id: s.session_id,
  ts,
  tool: { name: "bash", kind: "command" },
});
const voicedError = (s: { session_id: string }, ts: string) => ({
  type: "error",
  session_id: s.session_id,
  ts,
  error: VENDOR_FAILURE.message,
});
const completed = (s: { session_id: string }, ts: string, payload?: Record<string, unknown>) => ({
  type: "completed",
  session_id: s.session_id,
  ts,
  ...(payload ? { payload } : {}),
});

for (const lane of ["ask", "agent"] as const) {
  // After progress a death is continued on the same account (owner 1B: no
  // session id was reported, so each continuation is a packet re-brief),
  // bounded by transient_retry.max_retries (default 2, real backoff delays).
  describe(`vendor failure on the terminal record (${lane} lane)`, { timeout: 20_000 }, () => {
    it("carries the vendor's typed failure, says nothing about a crash, and continues only on the same account", async () => {
      const o = await runLane(lane, function* (spec) {
        const ts = new Date().toISOString();
        yield started(spec, ts);
        yield toolCall(spec, ts);
        yield voicedError(spec, ts);
        yield completed(spec, ts, {
          exit_code: 1,
          harness_reported_error: true,
          vendor_failure: VENDOR_FAILURE,
        });
      });
      expect(o.lifecycle).toBe("failed");
      expect(o.spawns).toEqual([null, null, null]);
      expect(continuedCarriers(o)).toEqual(["packet", "packet"]);
      expect(o.failure).toMatchObject({
        category: "harness_error",
        code: null,
        harnessId: "stub",
        safeMessage: expect.stringContaining("at capacity"),
        vendorFailure: VENDOR_FAILURE,
        nextActions: [VENDOR_STEP, "Open diagnostics", "Retry the run"],
      });
      // Words the error already carries are not repeated: the code is added once.
      const lead = firstLine(o.failure!.safeMessage);
      expect(lead).toContain(`${VENDOR_FAILURE.message} (vendor codex_rollout: server_overloaded)`);
      expect(lead.split(VENDOR_FAILURE.message)).toHaveLength(2);
      expect(firstLine(o.summary)).toBe(lead);
      const exhausted = o.events.filter((e) => e.type === "route.transient.exhausted");
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0]?.payload).toMatchObject({
        category: "unknown_harness_error",
        retries: 0,
        max_retries: expect.any(Number),
      });
      expect(types(o)).not.toContain("route.transient.retry_scheduled");
      expect(types(o)).not.toContain("route.profile.rotated");
      expect(types(o)).not.toContain("route.profile.credential_unusable");
    });

    it("names the vendor's own failure beside a synthetic error: record lead, returned summary and inspection step (#633, #635)", async () => {
      const o = await runLane(lane, function* (spec) {
        const ts = new Date().toISOString();
        yield started(spec, ts);
        yield toolCall(spec, ts);
        yield { type: "error", session_id: spec.session_id, ts, error: SYSTEM_ERROR };
        yield completed(spec, ts, { harness_reported_error: true, vendor_failure: VENDOR_FAILURE });
      });
      // Decisions are unchanged: the same continuations on the same account.
      expect(o.spawns).toEqual([null, null, null]);
      expect(continuedCarriers(o)).toEqual(["packet", "packet"]);
      expect(o.failure).toMatchObject({
        category: "harness_error",
        code: null,
        vendorFailure: VENDOR_FAILURE,
        nextActions: [VENDOR_STEP, "Open diagnostics", "Retry the run"],
      });
      const cause = `${SYSTEM_ERROR} (vendor codex_rollout: server_overloaded, "${VENDOR_FAILURE.message}")`;
      const lead = firstLine(o.failure!.safeMessage);
      expect(lead).toBe(lane === "agent" ? `a01/stub: ${cause}` : cause);
      expect(firstLine(o.summary)).toBe(lead);
      // What the installed Ouroboros reader keeps of the record names the cause.
      expect(reportedCause(o.failure)).toContain("server_overloaded");
      expect(reportedCause(o.failure)).toContain(VENDOR_FAILURE.message);
    });

    it("a later try without the vendor's record never speaks with an earlier try's", async () => {
      const o = await runLane(lane, function* (spec, spawn) {
        const ts = new Date().toISOString();
        yield started(spec, ts);
        yield toolCall(spec, ts);
        yield { type: "error", session_id: spec.session_id, ts, error: SYSTEM_ERROR };
        yield completed(spec, ts, {
          harness_reported_error: true,
          ...(spawn === 1 ? { vendor_failure: VENDOR_FAILURE } : {}),
        });
      });
      expect(o.spawns).toEqual([null, null, null]);
      expect(o.failure?.vendorFailure).toBeNull();
      expect(o.failure?.poolAttempts.map((row) => row.vendorFailure)).toEqual([
        VENDOR_FAILURE,
        null,
        null,
      ]);
      expect(firstLine(o.failure!.safeMessage)).not.toContain("(vendor");
      expect(o.failure?.nextActions).toEqual(["Open diagnostics", "Retry the run"]);
    });

    it("each try's cause line pairs that try's own error with that try's own record", async () => {
      const record = (n: number) => ({ code: `c${n}`, message: `w${n}`, source: "codex_rollout" });
      const o = await runLane(lane, function* (spec, spawn) {
        const ts = new Date().toISOString();
        yield started(spec, ts);
        yield toolCall(spec, ts);
        const errors = spawn === 3 ? ["try-3 first", "try-3 second"] : [`try-${spawn} broke`];
        for (const error of errors) yield { type: "error", session_id: spec.session_id, ts, error };
        yield completed(spec, ts, { harness_reported_error: true, vendor_failure: record(spawn) });
      });
      expect(o.spawns).toEqual([null, null, null]);
      expect(o.failure?.vendorFailure).toEqual(record(3));
      expect(o.failure?.poolAttempts.map((row) => row.vendorFailure)).toEqual(
        [1, 2, 3].map(record),
      );
      // The last try's errors only: the candidate lane names its first, the
      // read-only lane its last (unchanged); never an earlier try's error or record.
      const own = lane === "agent" ? "a01/stub: try-3 first" : "try-3 second";
      const lead = `${own} (vendor codex_rollout: c3, "w3")`;
      expect(firstLine(o.failure!.safeMessage)).toBe(lead);
      expect(firstLine(o.summary)).toBe(lead);
    });

    it("keeps a REAL crash a crash: no vendor failure, crash guidance intact", async () => {
      const o = await runLane(lane, function* (spec) {
        const ts = new Date().toISOString();
        yield started(spec, ts);
        yield toolCall(spec, ts);
        yield voicedError(spec, ts);
        yield completed(spec, ts, {
          exit_signal: "SIGKILL",
          harness_reported_error: true,
          vendor_failure: {
            code: "server_overloaded",
            message: "at capacity",
            source: "codex_rollout",
          },
        });
      });
      expect(o.spawns).toEqual([null, null, null]);
      expect(continuedCarriers(o)).toEqual(["packet", "packet"]);
      expect(o.failure?.vendorFailure).toBeNull();
      expect(o.failure?.nextActions[0]).toBe(
        "The harness process crashed; open diagnostics for the exit detail",
      );
      const exhausted = o.events.find((e) => e.type === "route.transient.exhausted");
      expect(exhausted?.payload).toMatchObject({ category: "process_crash", retries: 0 });
    });

    it("leaves vendorFailure null when the adapter attached none (no readable vendor record)", async () => {
      const o = await runLane(lane, function* (spec) {
        const ts = new Date().toISOString();
        yield started(spec, ts);
        yield toolCall(spec, ts);
        yield voicedError(spec, ts);
        yield completed(spec, ts, { exit_code: 1, harness_reported_error: true });
      });
      expect(o.failure?.vendorFailure).toBeNull();
      expect(o.failure?.nextActions).toEqual(["Open diagnostics", "Retry the run"]);
    });

    it("writes no failure record for a successful run", async () => {
      const o = await runLane(lane, function* (spec) {
        const ts = new Date().toISOString();
        yield started(spec, ts);
        if (lane === "agent") writeFileSync(join(spec.cwd, "CHANGED.txt"), "made it\n");
        yield { type: "message", session_id: spec.session_id, ts, text: "4" };
        yield completed(spec, ts, { exit_code: 0 });
      });
      expect(o.lifecycle).toBe("succeeded");
      expect(o.failure).toBeNull();
      expect(types(o)).not.toContain("route.transient.exhausted");
    });

    it("neutrality: a voiced PRE-PROGRESS death still rotates structurally, exactly once, and is never retried in place", async () => {
      const o = await withRotatePool(() =>
        runLane(lane, function* (spec, spawn) {
          const ts = new Date().toISOString();
          yield started(spec, ts);
          if (spawn === 1) {
            yield voicedError(spec, ts);
            yield completed(spec, ts, {
              exit_code: 1,
              harness_reported_error: true,
              vendor_failure: { ...VENDOR_FAILURE, code: "usage_limit_exceeded" },
            });
            return;
          }
          if (lane === "agent") writeFileSync(join(spec.cwd, "CHANGED.txt"), "made it\n");
          yield { type: "message", session_id: spec.session_id, ts, text: "4" };
          yield completed(spec, ts, { exit_code: 0 });
        }),
      );
      // One spawn per account: the refused account is not replayed in place
      // (no same-profile transient retry), the pool sibling serves the run.
      expect(o.spawns).toEqual(["a", "b"]);
      expect(o.lifecycle).toBe("succeeded");
      const rotated = o.events.filter((e) => e.type === "route.profile.rotated");
      expect(rotated).toHaveLength(1);
      expect(rotated[0]?.payload["reason"]).toBe("structural_pre_progress_failure");
      expect(types(o)).not.toContain("route.transient.retry_scheduled");
      // A vendor code that NAMES a limit is opaque: it condemns no credential
      // and hands the quota/cooldown projection no rate-limit signal.
      expect(types(o)).not.toContain("route.profile.credential_unusable");
      expect(o.quotaSinkEvents.some((e) => e.rate_limit)).toBe(false);
    });
  });
}
