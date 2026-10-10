/**
 * `continueFrom` successor contract on a scripted fake harness (no vendor
 * calls): a predecessor run stops after progress, then a successor run —
 * given exactly the continuation facts the daemon runner resolves — continues
 * it. Asserts the first try's carrier, the spec the successor process
 * receives, the receipt, the chain's work order and the kept/adopted tree.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessAdapter, HarnessContinuityCapability } from "@claudexor/core";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  ConformanceReport,
  ControlRunStartRequest,
  HarnessManifest,
  RunTelemetry,
  type HarnessEvent,
  type HarnessRunSpec,
  type RunEvent,
} from "@claudexor/schema";
import { retainedEnvelopeOfRun } from "@claudexor/workspace";
import { Orchestrator, type RunInput } from "./orchestrator.js";
import { readSessionCapsule } from "./session-capsule.js";

import { continuationForRun } from "../../cli/src/continue-from-run.js";
import { summaryFingerprint } from "../../control-api/src/run-list-fingerprint.js";
import { continuationSummary } from "../../control-api/src/run-continuation-projection.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const WORK_ORDER = "WORK-ORDER-7f3a: build the dashboard";
const RESET = "2026-10-06T21:00:00.000Z";

interface Spawn {
  phase: "predecessor" | "successor";
  profile: string;
  resume: string | null;
  prompt: string;
  model: string | null;
  cwd: string;
}

type Emit = (ev: Partial<HarnessEvent>) => HarnessEvent;
type Script = (
  ctx: Spawn & { spec: HarnessRunSpec; emit: Emit; nth: number },
) => Generator<HarnessEvent>;

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cx-continue-from-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base"],
    { cwd: root, stdio: "pipe" },
  );
  return root;
}

/** A movable fake store: sessions live under `<locator>/sessions/<sid>.jsonl`. */
function fileStoreContinuity(): HarnessContinuityCapability {
  const fileFor = (env: Record<string, string | null | undefined>, sid: string) =>
    join(String(env["CLAUDEXOR_PROFILE_LOCATOR"] ?? "/nowhere"), "sessions", `${sid}.jsonl`);
  return {
    async locate(ref, env) {
      const file = fileFor(env, ref.nativeSessionId);
      return existsSync(file)
        ? { found: true, file, mtimeMs: Date.now(), sidecars: [] }
        : { found: false };
    },
    async move(located, _fromEnv, toEnv) {
      const sid = located.nativeSessionId ?? "?";
      const target = fileFor(toEnv, sid);
      execFileSync("mkdir", ["-p", join(target, "..")]);
      writeFileSync(target, readFileSync(located.file));
      rmSync(located.file);
      return { ok: true, resumeRef: { nativeSessionId: sid } };
    },
  };
}

function seedSession(store: string, sid: string): void {
  execFileSync("mkdir", ["-p", join(store, "sessions")]);
  writeFileSync(join(store, "sessions", `${sid}.jsonl`), `{"sid":"${sid}"}\n`);
}

const limit = (emit: Emit) => [
  emit({
    type: "status",
    status: { kind: "api_retry", error_category: "rate_limit" },
    rate_limit: { resets_at: RESET, retry_delay_ms: null, constraint_id: "five_hour" },
  }),
  emit({ type: "error", error: "usage limit reached" }),
  emit({ type: "completed" }),
];
const crash = (emit: Emit) => [
  emit({ type: "error", error: "connection reset" }),
  emit({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } }),
];

interface Fixture {
  root: string;
  stores: Record<string, string>;
  spawns: Spawn[];
  adapter: HarnessAdapter;
  phase: { current: Spawn["phase"] };
}

function fixture(profiles: string[], script: Script): Fixture {
  const root = gitRepo();
  const configDir = process.env.CLAUDEXOR_CONFIG_DIR!;
  const stores = Object.fromEntries(profiles.map((id) => [id, join(root, `store-${id}`)]));
  writeFileSync(
    join(configDir, "config.yaml"),
    JSON.stringify({
      runtime: { transient_retry: { max_retries: 2, initial_delay_ms: 1, max_delay_ms: 2 } },
      credential_profiles: profiles.map((id) => ({
        profile_id: id,
        harness_id: "fake",
        display_name: id,
        credential_kind: "config_dir_login",
        isolation_locator: stores[id],
      })),
      harnesses: { fake: { profile_policy: { limit_action: "rotate" } } },
    }),
  );
  const spawns: Spawn[] = [];
  const phase = { current: "predecessor" as Spawn["phase"] };
  const adapter: HarnessAdapter = {
    id: "fake",
    continuity: fileStoreContinuity(),
    async discover() {
      return HarnessManifest.parse({
        id: "fake",
        display_name: "fake",
        kind: "local_cli",
        provider_family: "local",
        capabilities: {
          implement: true,
          read_files: true,
          effort_levels: ["high"],
          repair: true,
          explain: true,
          audit: true,
          known_models: ["m1", "m2"],
        },
        auth_modes: ["local_session"],
        access_profiles_supported: ["workspace_write", "readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "fake",
        status: "ok",
        enabled_intents: ["implement", "repair", "explain", "audit"],
        auth_sources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
      });
    },
    async probeCredentialProfile(profile) {
      return {
        profile_id: profile.profile_id,
        harness_id: "fake",
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        last_verified_at: new Date().toISOString(),
      };
    },
    async models() {
      return ["m1", "m2"].map((id) => ({ id, label: null, context_window: null, routes: null }));
    },
    async *run(spec) {
      const profile = spec.credential_profile!.profile_id;
      const ctx: Spawn = {
        phase: phase.current,
        profile,
        resume: spec.resume_session_id ?? null,
        prompt: spec.prompt,
        model: spec.model_hint ?? null,
        cwd: spec.cwd,
      };
      spawns.push(ctx);
      const nth = spawns.filter((s) => s.phase === ctx.phase).length;
      const emit: Emit = (ev) =>
        ({
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          credential_route: "vendor_native",
          credential_profile_id: profile,
          ...ev,
        }) as HarnessEvent;
      yield* script({ ...ctx, spec, emit, nth });
    },
  };
  return { root, stores, spawns, adapter, phase };
}

async function runOnce(f: Fixture, input: Partial<RunInput>) {
  const events: RunEvent[] = [];
  const result = await new Orchestrator({
    registry: new Map([["fake", f.adapter]]),
    reviewers: [],
  }).run({
    repoRoot: f.root,
    mode: "agent",
    prompt: WORK_ORDER,
    harnesses: ["fake"],
    review: false,
    models: { fake: "m1" },
    effort: "high",
    authPreference: "subscription",
    web: "off",
    ...input,
    onEvent: (event) => events.push(event),
  });
  const receipts = events
    .filter((e) => e.type === "run.continuity")
    .map((e) => e.payload["receipt"] as Record<string, unknown>);
  const terminal = events.find((e) =>
    ["run.failed", "run.completed", "run.blocked"].includes(e.type),
  );
  return {
    result,
    events,
    receipts,
    resumable: terminal?.payload["resumable"] as Record<string, unknown> | undefined,
  };
}

/** The predecessor, then its successor with the facts `continuationForRun` resolves. */
async function chain(
  f: Fixture,
  opts: {
    predecessor?: Partial<RunInput>;
    successor?: Partial<RunInput>;
    preference?: "auto" | "packet";
    between?: (runDir: string) => void;
    adopt?: boolean;
    inheritModel?: boolean;
  } = {},
) {
  const pred = await runOnce(f, {
    inPlace: true,
    continuation: { retain: true },
    ...opts.predecessor,
  });
  opts.between?.(pred.result.runDir);
  f.phase.current = "successor";
  const adopt = opts.adopt ? retainedEnvelopeOfRun(pred.result.runDir, pred.result.runId) : null;
  const succ = await runOnce(f, {
    inPlace: true,
    prompt: "Also add tests",
    ...opts.successor,
    continuation: {
      retain: true,
      adopt,
      from: {
        runId: pred.result.runId,
        runDir: pred.result.runDir,
        state: pred.result.lifecycle,
        workOrder: WORK_ORDER,
        preference: opts.preference ?? "auto",
        inheritModel: opts.inheritModel,
      },
    },
  });
  return { pred, succ };
}

/** Predecessor script: start a session on its profile, edit, then hit a typed limit. */
function editThenLimit(f: () => Fixture): Script {
  return function* ({ phase, profile, spec, emit }) {
    if (phase !== "predecessor") return;
    seedSession(f().stores[profile]!, "sid-A");
    yield emit({ type: "started", observed_model: "m1", payload: { native_session_id: "sid-A" } });
    writeFileSync(join(spec.cwd, "part1.txt"), "first half\n");
    yield emit({ type: "file_change", payload: { path: "part1.txt" } });
    yield* limit(emit);
  };
}

function finishing(emit: Emit, cwd: string, resumed: string): HarnessEvent[] {
  writeFileSync(join(cwd, "part2.txt"), "second half\n");
  return [
    emit({ type: "started", observed_model: "m1", payload: { native_session_id: resumed } }),
    emit({ type: "file_change", payload: { path: "part2.txt" } }),
    emit({ type: "message", text: "Done: both parts.", final: true }),
    emit({ type: "completed" }),
  ];
}

function attemptDirOf(runDir: string): string {
  return join(runDir, "attempts", readdirSync(join(runDir, "attempts")).sort()[0]!);
}

describe("continueFrom successor: first try", () => {
  it.each(
    (["agent", "ask"] as const).flatMap((mode) =>
      ["a", "b"].flatMap((target) =>
        [true, false].map((foreignFirst) => ({ mode, target, foreignFirst })),
      ),
    ),
  )(
    "resolves both stores by harness ($mode, target $target, foreign first: $foreignFirst)",
    async ({ mode, target, foreignFirst }) => {
      const foreignFiles: string[] = [];
      let f!: Fixture;
      f = fixture(["a", "b"], function* ({ phase, spec, emit, resume }) {
        const store = spec.credential_profile!.isolation_locator!;
        if (phase === "predecessor") {
          seedSession(store, "sid-A");
          yield emit({
            type: "started",
            observed_model: "m1",
            payload: { native_session_id: "sid-A" },
          });
          yield emit({
            type: "tool_call",
            tool: { name: "Read", kind: "file", target: "README.md" },
          });
          yield* limit(emit);
          return;
        }
        expect(resume).toBe("sid-A");
        expect(readFileSync(join(store, "sessions", "sid-A.jsonl"), "utf8")).toBe(
          '{"sid":"sid-A"}\n',
        );
        yield emit({
          type: "started",
          observed_model: "m1",
          payload: { native_session_id: "sid-A" },
        });
        yield emit({ type: "message", text: "Finished the saved work.", final: true });
        yield emit({ type: "completed" });
      });
      const { pred, succ } = await chain(f, {
        predecessor: { mode, credentialProfileId: "a" },
        successor: { mode, credentialProfileId: target },
        between: () => {
          const file = join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml");
          const config = JSON.parse(readFileSync(file, "utf8"));
          const profiles = config.credential_profiles as {
            profile_id: string;
            harness_id: string;
            isolation_locator: string;
            enabled?: boolean;
          }[];
          const foreign = profiles.map((row) => {
            const store = join(f.root, `foreign-${row.profile_id}`);
            seedSession(store, "sid-A");
            const path = join(store, "sessions", "sid-A.jsonl");
            writeFileSync(path, "foreign history\n");
            foreignFiles.push(path);
            return {
              ...row,
              harness_id: row.profile_id === "a" ? "claude" : "codex",
              isolation_locator: store,
            };
          });
          // History reads remain legal after the source account is disabled for dispatch.
          if (target === "b") profiles.find((row) => row.profile_id === "a")!.enabled = false;
          config.credential_profiles = foreignFirst
            ? [...foreign, ...profiles]
            : [...profiles, ...foreign];
          writeFileSync(file, JSON.stringify(config));
        },
      });
      expect(pred.result.lifecycle).toBe("failed");
      expect(succ.result.lifecycle, succ.result.summary).toBe("succeeded");
      expect(succ.receipts[0]).toMatchObject({
        carrier: target === "a" ? "native" : "native_moved",
        from: { runId: pred.result.runId, profileId: "a" },
        to: { profileId: target },
      });
      expect(readSessionCapsule(attemptDirOf(succ.result.runDir))).toMatchObject({
        harness: "fake",
        holderProfileId: target,
        file: join(f.stores[target]!, "sessions", "sid-A.jsonl"),
      });
      expect(existsSync(join(f.stores.a!, "sessions", "sid-A.jsonl"))).toBe(target === "a");
      for (const path of foreignFiles) expect(readFileSync(path, "utf8")).toBe("foreign history\n");
    },
  );

  it.each(["native identity rejection", "typed limit"] as const)(
    "keeps predecessor evidence in a later packet after the successor's %s",
    async (stop) => {
      let f!: Fixture;
      f = fixture(stop === "typed limit" ? ["a", "b"] : ["a"], function* (ctx) {
        if (ctx.phase === "predecessor") {
          seedSession(f.stores[ctx.profile]!, "sid-A");
          yield ctx.emit({
            type: "started",
            observed_model: "m1",
            payload: { native_session_id: "sid-A" },
          });
          yield ctx.emit({
            type: "message",
            text: "The original answer contains a migration plan.",
            final: true,
          });
          yield ctx.emit({
            type: "tool_call",
            tool: {
              name: "InspectMigration",
              kind: "file",
              target: "migration.ts",
              use_id: "pending-a",
            },
          });
          yield* limit(ctx.emit);
        } else if (ctx.nth === 1) {
          if (stop === "typed limit") {
            yield ctx.emit({
              type: "started",
              observed_model: "m1",
              payload: { native_session_id: "sid-A" },
            });
            yield* limit(ctx.emit);
          } else {
            yield ctx.emit({ type: "started", payload: { native_session_id: "sid-other" } });
            yield ctx.emit({ type: "completed", aborted: true });
          }
        } else {
          yield* finishing(ctx.emit, ctx.cwd, "sid-packet");
        }
      });
      if (stop === "typed limit") {
        f.adapter.continuity!.move = async () => ({ ok: false, reason: "scripted move rejection" });
      }
      const { pred, succ } = await chain(f, {
        predecessor: { credentialProfileId: "a" },
        between: (runDir) => {
          const event = (seq: number, type: string) =>
            JSON.stringify({
              seq,
              type,
              ts: new Date().toISOString(),
              run_id: "run-a",
              task_id: "task-a",
              payload: {
                message_id: "correction-a",
                text: "Keep the public migration API stable",
                attempt_id: "a01",
              },
            });
          appendFileSync(
            join(runDir, "events.jsonl"),
            `${event(900, "message.accepted")}\n${event(901, "message.delivered")}\n`,
          );
        },
      });
      expect(succ.result.lifecycle, succ.result.summary).toBe("succeeded");
      expect(succ.receipts.map((r) => r["carrier"])).toEqual(["native", "packet"]);
      expect(succ.receipts[0]).toMatchObject({
        identityCheck:
          stop === "typed limit" ? "matched_before_effects" : "mismatch_before_effects",
      });
      const tries = f.spawns.filter((spawn) => spawn.phase === "successor");
      expect(tries[0]).toMatchObject({ resume: "sid-A", profile: "a" });
      expect(tries[1]).toMatchObject({ resume: null, profile: stop === "typed limit" ? "b" : "a" });
      if (stop === "typed limit") {
        expect(succ.receipts[1]).toMatchObject({ cause: "vendor_limit", to: { profileId: "b" } });
      }
      const packet = readFileSync(
        join(attemptDirOf(succ.result.runDir), "continuation", "evidence-index-try1.md"),
        "utf8",
      );
      expect(packet).toContain("Keep the public migration API stable");
      expect(packet).toContain("(delivered)");
      expect(packet).toContain("The original answer contains a migration plan.");
      expect(packet).toContain("InspectMigration — migration.ts (unresolved");
      expect(packet).toContain(join(pred.result.runDir, "events.jsonl"));
      expect(packet).toContain(attemptDirOf(pred.result.runDir));
    },
  );
  it("resumes the predecessor's session on the same account with the notice and the caller's text, never the work order", async () => {
    let f!: Fixture;
    const predScript = editThenLimit(() => f);
    f = fixture(["a"], function* (ctx) {
      if (ctx.phase === "predecessor") return yield* predScript(ctx);
      yield* finishing(ctx.emit, ctx.cwd, "sid-A");
    });
    const { pred, succ } = await chain(f);
    expect(pred.result.lifecycle).not.toBe("succeeded");
    expect(pred.resumable).toMatchObject({
      cause: "pool_exhausted",
      session: { nativeSessionId: "sid-A", holderProfileId: "a" },
    });
    expect(succ.result.lifecycle, succ.result.summary).toBe("succeeded");
    const first = f.spawns.find((s) => s.phase === "successor")!;
    expect(first.resume).toBe("sid-A");
    expect(first.prompt).toContain("The previous process stopped (every account's usage limit)");
    expect(first.prompt).toContain("Also add tests");
    expect(first.prompt).not.toContain(WORK_ORDER);
    expect(first.prompt).not.toContain("different working tree");
    expect(succ.receipts).toHaveLength(1);
    expect(succ.receipts[0]).toMatchObject({
      tryIndex: 0,
      carrier: "native",
      cause: "pool_exhausted",
      from: { runId: pred.result.runId, profileId: "a" },
      to: { profileId: "a" },
      workspace: "same_root",
      memory: "full",
      observedModel: "m1",
      modelMismatch: false,
      identityCheck: "matched_before_effects",
      inputDelivery: "confirmed",
    });
    // The chain's work order and the session holder carry over to the successor.
    expect(readFileSync(join(succ.result.runDir, "context", "work-order.md"), "utf8")).toBe(
      `${WORK_ORDER}\n\nAlso add tests\n`,
    );
    expect(readSessionCapsule(attemptDirOf(succ.result.runDir))).toMatchObject({
      nativeSessionId: "sid-A",
      holderProfileId: "a",
    });
    expect(existsSync(join(f.root, "part1.txt")) && existsSync(join(f.root, "part2.txt"))).toBe(
      true,
    );
  });

  it("moves the session to the successor's account when it starts on another one (native_moved)", async () => {
    let f!: Fixture;
    const predScript = editThenLimit(() => f);
    f = fixture(["a", "b"], function* (ctx) {
      if (ctx.phase === "predecessor") {
        // Pin a: the predecessor ends on a's limit instead of hopping in-run.
        return yield* predScript(ctx);
      }
      yield* finishing(ctx.emit, ctx.cwd, "sid-A");
    });
    const { pred, succ } = await chain(f, {
      predecessor: { credentialProfileId: "a" },
      successor: { credentialProfileId: "b" },
    });
    expect(pred.resumable).toMatchObject({ cause: "pinned_limit" });
    const first = f.spawns.find((s) => s.phase === "successor")!;
    expect([first.profile, first.resume]).toEqual(["b", "sid-A"]);
    expect(existsSync(join(f.stores["b"]!, "sessions", "sid-A.jsonl"))).toBe(true);
    expect(existsSync(join(f.stores["a"]!, "sessions", "sid-A.jsonl"))).toBe(false);
    expect(succ.receipts[0]).toMatchObject({
      tryIndex: 0,
      carrier: "native_moved",
      from: { runId: pred.result.runId, profileId: "a" },
      to: { profileId: "b" },
    });
    expect(succ.result.lifecycle, succ.result.summary).toBe("succeeded");
  });

  it("re-briefs a fresh session when the caller asks for a packet: the evidence index carries the work order", async () => {
    let f!: Fixture;
    const predScript = editThenLimit(() => f);
    f = fixture(["a"], function* (ctx) {
      if (ctx.phase === "predecessor") return yield* predScript(ctx);
      yield* finishing(ctx.emit, ctx.cwd, "sid-new");
    });
    const { pred, succ } = await chain(f, { preference: "packet" });
    const first = f.spawns.find((s) => s.phase === "successor")!;
    expect(first.resume).toBeNull();
    expect(first.prompt).toContain("Also add tests");
    expect(first.prompt).toContain("evidence index");
    expect(first.prompt).toContain(WORK_ORDER);
    expect(first.model).toBe("m1");
    const index = join(attemptDirOf(succ.result.runDir), "continuation", "evidence-index-try0.md");
    expect(readFileSync(index, "utf8")).toContain("part1.txt");
    expect(succ.receipts[0]).toMatchObject({
      tryIndex: 0,
      carrier: "packet",
      memory: "partial",
      identityCheck: "not_applicable",
      from: { runId: pred.result.runId },
    });
  });

  it("tool-only work + a delivered correction + no answer: the packet successor sees the correction, the undelivered message and the unresolved call", async () => {
    const f = fixture(["a"], function* ({ phase, emit, cwd }) {
      if (phase === "predecessor") {
        yield emit({ type: "started", observed_model: "m1", payload: {} });
        yield emit({
          type: "tool_call",
          tool: { name: "Write", kind: "file", target: "src/chart.ts" },
        });
        yield emit({ type: "tool_result", tool: { name: "Write", kind: "file", status: "ok" } });
        yield emit({
          type: "tool_call",
          tool: { name: "Bash", kind: "command", target: "pnpm test" },
        });
        yield* crash(emit);
        return;
      }
      yield* finishing(emit, cwd, "sid-new");
    });
    const { succ } = await chain(f, {
      between: (runDir) => {
        // Live messages as POST /v2/runs/:id/messages journals them.
        const row = (type: string, id: string, text: string) =>
          `${JSON.stringify({ seq: 900, ts: RESET, run_id: "r", task_id: "t", type, payload: { message_id: id, text } })}\n`;
        appendFileSync(join(runDir, "events.jsonl"), row("message.accepted", "m1", "Use red bars"));
        appendFileSync(
          join(runDir, "events.jsonl"),
          row("message.delivered", "m1", "Use red bars"),
        );
        appendFileSync(
          join(runDir, "events.jsonl"),
          row("message.accepted", "m2", "Also label the axes"),
        );
      },
    });
    const first = f.spawns.find((s) => s.phase === "successor")!;
    // No native session was recorded: the successor is re-briefed.
    expect(first.resume).toBeNull();
    expect(first.prompt).toContain("Use red bars");
    expect(first.prompt).toContain("Write — src/chart.ts (completed)");
    expect(first.prompt).toContain("Bash — pnpm test (unresolved");
    // The undelivered message is a reference to reconcile, never a blind replay.
    expect(first.prompt).toContain("may not have been delivered");
    expect(first.prompt).toContain("Also label the axes");
    expect(succ.receipts[0]).toMatchObject({ inputDelivery: "uncertain", cause: "transport" });
  });

  it("a successor whose first native try dies before progress resumes the session again instead of replaying a context-free notice", async () => {
    let f!: Fixture;
    const predScript = editThenLimit(() => f);
    f = fixture(["a"], function* (ctx) {
      if (ctx.phase === "predecessor") return yield* predScript(ctx);
      if (ctx.nth === 1) return yield* crash(ctx.emit);
      yield* finishing(ctx.emit, ctx.cwd, "sid-A");
    });
    const { succ } = await chain(f);
    const tries = f.spawns.filter((s) => s.phase === "successor");
    expect(tries.map((s) => s.resume)).toEqual(["sid-A", "sid-A"]);
    expect(tries[1]!.prompt).toContain("The previous process stopped (the process died)");
    expect(succ.result.lifecycle, succ.result.summary).toBe("succeeded");
    expect(succ.receipts.map((r) => [r["tryIndex"], r["carrier"], r["cause"]])).toEqual([
      [0, "native", "pool_exhausted"],
      [1, "native", "transport"],
    ]);
  });
});

describe("continueFrom successor: kept isolated envelope", () => {
  it("adopts the predecessor's kept envelope with the same files; a live successor elsewhere runs in a different root", async () => {
    let f!: Fixture;
    const predScript = editThenLimit(() => f);
    f = fixture(["a"], function* (ctx) {
      if (ctx.phase === "predecessor") return yield* predScript(ctx);
      expect(readFileSync(join(ctx.cwd, "part1.txt"), "utf8")).toBe("first half\n");
      yield* finishing(ctx.emit, ctx.cwd, "sid-A");
    });
    const { pred, succ } = await chain(f, {
      predecessor: { inPlace: false },
      successor: { inPlace: false },
      adopt: true,
    });
    expect(pred.resumable).toMatchObject({ workspace: { kind: "retained_envelope" } });
    const keptRoot = (pred.resumable!["workspace"] as { root: string }).root;
    const first = f.spawns.find((s) => s.phase === "successor")!;
    expect(first.cwd).toBe(keptRoot);
    expect(succ.receipts[0]).toMatchObject({ carrier: "native", workspace: "same_root" });
    // One cumulative patch: the predecessor's half and the successor's half.
    expect(succ.result.lifecycle, succ.result.summary).toBe("succeeded");
    const patch = readFileSync(join(succ.result.runDir, "final", "patch.diff"), "utf8");
    expect(patch).toContain("part1.txt");
    expect(patch).toContain("part2.txt");
    // The finished successor released the kept tree.
    expect(retainedEnvelopeOfRun(pred.result.runDir, pred.result.runId)).toBeNull();
    expect(existsSync(keptRoot)).toBe(false);
  });

  it("names a different root when the successor runs live elsewhere", async () => {
    let f!: Fixture;
    const predScript = editThenLimit(() => f);
    f = fixture(["a"], function* (ctx) {
      if (ctx.phase === "predecessor") return yield* predScript(ctx);
      yield* finishing(ctx.emit, ctx.cwd, "sid-A");
    });
    const { pred, succ } = await chain(f, { predecessor: { inPlace: false } });
    expect(succ.receipts[0]).toMatchObject({ carrier: "native", workspace: "different_root" });
    const first = f.spawns.find((s) => s.phase === "successor")!;
    expect(first.prompt).toContain("runs in a different working tree");
    expect(first.prompt).toContain("Also add tests");
    // The predecessor's kept tree stays kept until its own disposition.
    expect(retainedEnvelopeOfRun(pred.result.runDir, pred.result.runId)).not.toBeNull();
  });
});

describe("continueFrom through an unadopted head", () => {
  it.each([
    { newCorrection: false, retry: false },
    { newCorrection: true, retry: false },
    { newCorrection: true, retry: true },
  ])(
    "preserves complete undelivered input with newest-first inline quotes (new correction: $newCorrection, unstarted retry: $retry)",
    async ({ newCorrection, retry }) => {
      let f!: Fixture;
      const predScript = editThenLimit(() => f);
      f = fixture(["a"], function* (ctx) {
        if (ctx.phase === "predecessor") return yield* predScript(ctx);
        if (retry && ctx.nth <= 2) return yield* crash(ctx.emit);
        yield* finishing(ctx.emit, ctx.cwd, "sid-A");
      });
      const correction = "Correction: keep the public migration API as is";
      const longInput = newCorrection
        ? "Keep the existing work. ".repeat(100).slice(0, 2240)
        : "Continue the migration carefully. ".repeat(90).slice(0, 2700) +
          "\nFinal correction: preserve the existing API now.";
      expect(longInput).toHaveLength(newCorrection ? 2240 : 2749);
      expect(correction).toHaveLength(47);
      const { pred, succ: failed } = await chain(f, {
        successor: { prompt: longInput, credentialProfileId: "missing-profile" },
      });
      expect(failed.result.lifecycle).toBe("failed");
      const records = [
        { ...pred.result, params: { prompt: WORK_ORDER }, state: pred.result.lifecycle },
        {
          ...failed.result,
          params: { prompt: longInput, continueFrom: pred.result.runId },
          state: failed.result.lifecycle,
        },
      ];
      const continuation = () =>
        continuationForRun(
          ControlRunStartRequest.parse({
            continueFrom: records.at(-1)!.runId,
            scope: { kind: "project", root: f.root },
            execution: { isolation: "live" },
          }),
          { getByRunId: (id) => records.find((record) => record.runId === id) },
        );
      if (newCorrection) {
        const next = await runOnce(f, {
          inPlace: true,
          prompt: correction,
          credentialProfileId: "missing-profile",
          continuation: continuation(),
        });
        expect(next.result.lifecycle).toBe("failed");
        records.push({
          ...next.result,
          params: { prompt: correction, continueFrom: failed.result.runId },
          state: next.result.lifecycle,
        });
      }
      const resumed = await runOnce(f, {
        inPlace: true,
        prompt: "Finish it",
        continuation: continuation(),
      });
      expect(resumed.result.lifecycle, resumed.result.summary).toBe("succeeded");
      expect(resumed.receipts[0]).toMatchObject({ carrier: "native", inputDelivery: "uncertain" });
      if (retry) {
        expect(resumed.receipts).toHaveLength(3);
        expect(resumed.receipts.every((receipt) => receipt["inputDelivery"] === "uncertain")).toBe(
          true,
        );
      }
      const prompt = f.spawns.at(-1)!.prompt;
      expect(prompt).toContain("may not have been delivered");
      expect(prompt).toContain("do not replay it blindly");
      if (newCorrection) {
        expect(prompt).toContain(correction);
        expect(prompt.indexOf(correction)).toBeLessThan(prompt.indexOf(longInput.slice(0, 80)));
      }
      const shown =
        2048 - (newCorrection ? correction.length : 0) - (retry ? "Finish it".length : 0);
      const path = join(resumed.result.runDir, "context", "work-order.md");
      expect(prompt).toContain(
        `[cut: ${shown} of ${longInput.length} characters; the complete text is in ${path}]`,
      );
      expect(readFileSync(path, "utf8")).toContain(longInput);
      // The engine's existing work order already holds the complete input.
      expect(readdirSync(join(resumed.result.runDir, "context"))).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^uncertain-input-/)]),
      );
    },
  );

  it.each(["preflight", "ask", "ask-same-root"] as const)(
    "reaches the retained tree after a %s successor",
    async (middle) => {
      let f!: Fixture;
      const predScript = editThenLimit(() => f);
      f = fixture(["a"], function* (ctx) {
        if (ctx.phase === "predecessor") return yield* predScript(ctx);
        if (ctx.spec.access === "readonly") {
          yield ctx.emit({
            type: "started",
            observed_model: "m1",
            payload: { native_session_id: "sid-A" },
          });
          yield ctx.emit({
            type: "message",
            text: "The first half remains; finish the second half.",
            final: true,
          });
          yield ctx.emit({ type: "completed" });
        } else {
          expect(readFileSync(join(ctx.cwd, "part1.txt"), "utf8")).toBe("first half\n");
          yield* finishing(ctx.emit, ctx.cwd, "sid-A");
        }
      });
      const a = await runOnce(f, { continuation: { retain: true } });
      const held = retainedEnvelopeOfRun(a.result.runDir, a.result.runId)!;
      expect(held).not.toBeNull();
      const records = [
        {
          id: a.result.runId,
          runId: a.result.runId,
          runDir: a.result.runDir,
          state: a.result.lifecycle,
          params: { prompt: WORK_ORDER, continueFrom: undefined as string | undefined },
        },
      ];
      const continuation = (runId: string, sameRoot = false) =>
        continuationForRun(
          ControlRunStartRequest.parse({
            prompt: "",
            continueFrom: runId,
            scope: { kind: "project", root: f.root },
            ...(sameRoot
              ? { execution: { isolation: "live", workspaceRoot: held.envelope.worktree_path } }
              : {}),
          }),
          { getByRunId: (id) => records.find((record) => record.runId === id) },
        );
      f.phase.current = "successor";
      const b = await runOnce(f, {
        mode: middle === "preflight" ? "agent" : "ask",
        prompt: "Explain what is left",
        ...(middle === "preflight"
          ? { credentialProfileId: "missing-profile" }
          : { access: "readonly" as const }),
        continuation: continuation(a.result.runId),
      });
      expect(b.result.lifecycle, b.result.summary).toBe(
        middle === "preflight" ? "failed" : "succeeded",
      );
      records.push({
        id: b.result.runId,
        runId: b.result.runId,
        runDir: b.result.runDir,
        state: b.result.lifecycle,
        params: { prompt: "Explain what is left", continueFrom: a.result.runId },
      } as (typeof records)[number]);
      if (middle === "preflight") {
        expect(continuationSummary(records[1]!).resumable).toMatchObject({
          carriers: ["native", "native_moved", "packet"],
          session: { nativeSessionId: "sid-A" },
          workspace: { kind: "retained_envelope", root: held.envelope.worktree_path },
        });
      }
      const fingerprint = summaryFingerprint(records[1]!);
      const sameRoot = middle === "ask-same-root";
      const next = continuation(b.result.runId, sameRoot);
      if (sameRoot) expect(next.adopt).toBeNull();
      const c = await runOnce(f, {
        prompt: "Finish it",
        ...(sameRoot ? { inPlace: true, executionRoot: held.envelope.worktree_path } : {}),
        continuation: next,
      });
      if (!sameRoot) {
        expect(summaryFingerprint(records[1]!)).not.toBe(fingerprint);
        expect(continuationSummary(records[1]!).resumable?.workspace.kind).not.toBe(
          "retained_envelope",
        );
      }
      expect(c.result.lifecycle, c.result.summary).toBe("succeeded");
      expect(f.spawns.at(-1)).toMatchObject({ resume: "sid-A", cwd: held.envelope.worktree_path });
      expect(c.receipts[0]).toMatchObject({
        carrier: "native",
        from: { runId: b.result.runId },
        workspace: "same_root",
      });
      expect(f.spawns.at(-1)!.prompt).not.toContain("different working tree");
      if (middle === "preflight") {
        expect(f.spawns.at(-1)!.prompt).toContain("Explain what is left");
        expect(f.spawns.at(-1)!.prompt).toContain("do not replay it blindly");
        expect(c.receipts[0]).toMatchObject({ inputDelivery: "uncertain" });
      }
      if (sameRoot) {
        expect(readFileSync(join(held.envelope.worktree_path, "part1.txt"), "utf8")).toBe(
          "first half\n",
        );
      } else {
        expect(readFileSync(join(c.result.runDir, "final", "patch.diff"), "utf8")).toContain(
          "first half",
        );
      }
    },
  );
});

describe("continueFrom: an ancestor's steering without delivery proof", () => {
  const STEERING = "Steering correction: preserve the public migration API.";
  /** The row the live-message route leaves after an `accepted` outcome, before the terminal. */
  function leaveUnconfirmedSteering(runDir: string): void {
    const file = join(runDir, "events.jsonl");
    const rows = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const terminal = rows.findIndex((row) =>
      ["run.failed", "run.completed", "run.blocked"].includes(String(row["type"])),
    );
    const first = rows[0]!;
    rows.splice(terminal, 0, {
      ts: first["ts"],
      run_id: first["run_id"],
      task_id: first["task_id"],
      type: "message.accepted",
      payload: { message_id: "steer-1", attempt_id: "a01", text: STEERING },
    });
    rows.forEach((row, index) => (row["seq"] = index + 1));
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  }

  it("keeps it through an unstarted in-run native retry of the successor", async () => {
    let f!: Fixture;
    const predScript = editThenLimit(() => f);
    f = fixture(["a"], function* (ctx) {
      if (ctx.phase === "predecessor") return yield* predScript(ctx);
      if (ctx.nth === 1) return yield* crash(ctx.emit);
      yield* finishing(ctx.emit, ctx.cwd, "sid-A");
    });
    const { succ } = await chain(f, {
      successor: { prompt: "Finish it" },
      between: leaveUnconfirmedSteering,
    });
    expect(succ.result.lifecycle, succ.result.summary).toBe("succeeded");
    const tries = f.spawns.filter((spawn) => spawn.phase === "successor");
    expect(tries).toHaveLength(2);
    expect(tries.map((spawn) => spawn.resume)).toEqual(["sid-A", "sid-A"]);
    for (const spawn of tries) expect(spawn.prompt).toContain(STEERING);
    expect(succ.receipts.at(-1)).toMatchObject({ carrier: "native", inputDelivery: "uncertain" });
  });

  it("keeps it for the next run after a successor exhausts its unstarted tries", async () => {
    let f!: Fixture;
    const predScript = editThenLimit(() => f);
    f = fixture(["a"], function* (ctx) {
      if (ctx.phase === "predecessor") return yield* predScript(ctx);
      if (ctx.nth <= 3) return yield* crash(ctx.emit);
      yield* finishing(ctx.emit, ctx.cwd, "sid-A");
    });
    const { pred, succ: failed } = await chain(f, {
      successor: { prompt: "Finish it" },
      between: leaveUnconfirmedSteering,
    });
    expect(failed.result.lifecycle).toBe("failed");
    const records = [
      { ...pred.result, params: { prompt: WORK_ORDER }, state: pred.result.lifecycle },
      {
        ...failed.result,
        params: { prompt: "Finish it", continueFrom: pred.result.runId },
        state: failed.result.lifecycle,
      },
    ];
    const next = await runOnce(f, {
      inPlace: true,
      prompt: "Continue now",
      continuation: continuationForRun(
        ControlRunStartRequest.parse({
          prompt: "Continue now",
          continueFrom: failed.result.runId,
          scope: { kind: "project", root: f.root },
          execution: { isolation: "live" },
        }),
        { getByRunId: (id) => records.find((record) => record.runId === id) },
      ),
    });
    expect(next.result.lifecycle, next.result.summary).toBe("succeeded");
    expect(next.receipts[0]).toMatchObject({ carrier: "native", inputDelivery: "uncertain" });
    expect(f.spawns.at(-1)!.prompt).toContain(STEERING);
  });

  it("is not repeated once a successor's process started with it", async () => {
    let f!: Fixture;
    const predScript = editThenLimit(() => f);
    f = fixture(["a"], function* (ctx) {
      if (ctx.phase === "predecessor") return yield* predScript(ctx);
      if (ctx.nth === 1) {
        yield ctx.emit({
          type: "started",
          observed_model: "m1",
          payload: { native_session_id: "sid-A" },
        });
        return yield* limit(ctx.emit);
      }
      yield* finishing(ctx.emit, ctx.cwd, "sid-A");
    });
    const { pred, succ: stopped } = await chain(f, {
      successor: { prompt: "Finish it" },
      between: leaveUnconfirmedSteering,
    });
    expect(stopped.result.lifecycle).not.toBe("succeeded");
    expect(f.spawns.filter((spawn) => spawn.phase === "successor")[0]!.prompt).toContain(STEERING);
    const records = [
      { ...pred.result, params: { prompt: WORK_ORDER }, state: pred.result.lifecycle },
      {
        ...stopped.result,
        params: { prompt: "Finish it", continueFrom: pred.result.runId },
        state: stopped.result.lifecycle,
      },
    ];
    const next = await runOnce(f, {
      inPlace: true,
      prompt: "Continue now",
      continuation: continuationForRun(
        ControlRunStartRequest.parse({
          prompt: "Continue now",
          continueFrom: stopped.result.runId,
          scope: { kind: "project", root: f.root },
          execution: { isolation: "live" },
        }),
        { getByRunId: (id) => records.find((record) => record.runId === id) },
      ),
    });
    expect(next.result.lifecycle, next.result.summary).toBe("succeeded");
    expect(f.spawns.at(-1)).toMatchObject({ resume: "sid-A" });
    expect(f.spawns.at(-1)!.prompt).not.toContain(STEERING);
  });
});

describe("continueFrom model selection", () => {
  it.each([
    { mode: "agent", inheritModel: true },
    { mode: "agent", inheritModel: false },
    { mode: "ask", inheritModel: true },
    { mode: "ask", inheritModel: false },
  ] as const)(
    "distinguishes an inherited hint from a caller choice ($mode, inherited: $inheritModel)",
    async ({ mode, inheritModel }) => {
      let f!: Fixture;
      const predScript = editThenLimit(() => f);
      f = fixture(["a"], function* (ctx) {
        if (ctx.phase === "predecessor") return yield* predScript(ctx);
        yield* finishing(ctx.emit, ctx.cwd, "sid-A");
      });
      const { succ } = await chain(f, {
        successor: { mode, models: { fake: "m2" } },
        inheritModel,
      });
      expect(succ.result.lifecycle, succ.result.summary).toBe("succeeded");
      expect(f.spawns.find((s) => s.phase === "successor")!.model).toBe(inheritModel ? "m1" : "m2");
      expect(succ.receipts[0]).toMatchObject({ observedModel: "m1", modelMismatch: !inheritModel });
      const telemetry = RunTelemetry.parse(
        new ArtifactStore(f.root).readYaml(join(succ.result.runDir, "final", "telemetry.yaml")),
      );
      expect(telemetry.attempts[0]).toMatchObject({
        requested_model: inheritModel ? "m1" : "m2",
        observed_model: "m1",
      });
      expect(telemetry.auth_route?.model_mismatch).toEqual(
        inheritModel ? null : { requested: "m2", observed: "m1" },
      );
    },
  );
  it.each(["auto", "packet"] as const)(
    "pins the attested model across settings drift (%s)",
    async (preference) => {
      let f!: Fixture;
      const predScript = editThenLimit(() => f);
      f = fixture(["a"], function* (ctx) {
        if (ctx.phase === "predecessor") return yield* predScript(ctx);
        yield* finishing(ctx.emit, ctx.cwd, preference === "packet" ? "sid-new" : "sid-A");
      });
      const { succ } = await chain(f, {
        preference,
        predecessor: { models: undefined },
        successor: { models: undefined },
        between: () => {
          const path = join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml");
          const config = JSON.parse(readFileSync(path, "utf8"));
          config.harnesses.fake.default_model = "m2";
          writeFileSync(path, JSON.stringify(config));
        },
      });
      expect(succ.result.lifecycle, succ.result.summary).toBe("succeeded");
      expect(f.spawns.find((s) => s.phase === "successor")!.model).toBe("m1");
      expect(succ.receipts[0]).toMatchObject({ observedModel: "m1", modelMismatch: false });
    },
  );
});

describe("continueFrom root and completed-work notices", () => {
  it("names the saved patch when finished isolated work continues from the project base", async () => {
    let f!: Fixture;
    f = fixture(["a"], function* (ctx) {
      if (ctx.phase === "predecessor") seedSession(f.stores[ctx.profile]!, "sid-A");
      yield* finishing(ctx.emit, ctx.cwd, "sid-A");
    });
    const { pred, succ } = await chain(f, { predecessor: { inPlace: false } });
    expect(pred.result.lifecycle, pred.result.summary).toBe("succeeded");
    const patch = join(pred.result.runDir, "final", "patch.diff");
    expect(existsSync(patch)).toBe(true);
    const next = f.spawns.find((s) => s.phase === "successor")!;
    expect(next.prompt).toContain("different working tree");
    expect(next.prompt).toContain(patch);
    expect(succ.receipts[0]).toMatchObject({ workspace: "different_root" });
  });

  it("treats an unknown root as the same inherited project scope", async () => {
    let f!: Fixture;
    f = fixture(["a"], function* (ctx) {
      yield ctx.emit({
        type: "message",
        text: "The work can proceed in the project root.",
        final: true,
      });
      yield ctx.emit({ type: "completed" });
    });
    const a = await runOnce(f, { inPlace: true, continuation: { retain: true } });
    const continuation = continuationForRun(
      ControlRunStartRequest.parse({
        continueFrom: a.result.runId,
        scope: { kind: "project", root: f.root },
        execution: { isolation: "live" },
      }),
      {
        getByRunId: (id) =>
          id === a.result.runId
            ? {
                runId: a.result.runId,
                runDir: a.result.runDir,
                state: a.result.lifecycle,
                params: { prompt: WORK_ORDER, scope: { kind: "project", root: f.root } },
              }
            : undefined,
      },
    );
    f.phase.current = "successor";
    const b = await runOnce(f, { inPlace: true, prompt: "Continue", continuation });
    expect(b.result.lifecycle, b.result.summary).toBe("succeeded");
    expect(b.receipts[0]).toMatchObject({ workspace: "same_root" });
    expect(f.spawns.at(-1)!.prompt).not.toContain("different working tree");
  });

  it.each(["auto", "packet", "later-packet"] as const)(
    "uses a neutral notice for an empty follow-up to succeeded work (%s)",
    async (preference) => {
      let f!: Fixture;
      f = fixture(["a"], function* (ctx) {
        if (ctx.phase === "predecessor") seedSession(f.stores[ctx.profile]!, "sid-A");
        if (ctx.phase === "successor" && preference === "later-packet" && ctx.nth === 1) {
          yield ctx.emit({ type: "started", payload: { native_session_id: "sid-other" } });
          yield ctx.emit({ type: "completed", aborted: true });
          return;
        }
        yield* finishing(
          ctx.emit,
          ctx.cwd,
          ctx.phase === "successor" && preference !== "auto" ? "sid-new" : "sid-A",
        );
      });
      const { pred, succ } = await chain(f, {
        preference: preference === "later-packet" ? "auto" : preference,
        successor: { prompt: "" },
      });
      expect(pred.result.lifecycle, pred.result.summary).toBe("succeeded");
      expect(pred.resumable).toBeUndefined();
      expect(succ.result.lifecycle, succ.result.summary).toBe("succeeded");
      if (preference === "later-packet") {
        expect(succ.receipts.map((receipt) => receipt["carrier"])).toEqual(["native", "packet"]);
        const packet = readFileSync(
          join(attemptDirOf(succ.result.runDir), "continuation", "evidence-index-try1.md"),
          "utf8",
        );
        expect(packet).toContain("# Evidence index of the previous work");
        expect(packet).not.toContain("previous process stopped");
      }
      const prompt = f.spawns.at(-1)!.prompt;
      expect(prompt).not.toContain("previous process stopped");
      expect(prompt).not.toContain("could not finish");
      expect(prompt).toContain("Continue from the previous work");
    },
  );
});
