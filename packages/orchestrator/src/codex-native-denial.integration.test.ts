import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessAdapter, spawnProcess } from "@claudexor/core";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  ConformanceReport,
  HarnessManifest,
  RunTelemetry,
  type HarnessRunSpec,
  type InteractionAnswerSet,
  type QuotaSnapshot,
} from "@claudexor/schema";
import { Orchestrator, type PendingInteractionContext } from "./orchestrator.js";
import { runCodexAppServer } from "../../harness-codex/src/app-server-run.js";

type Frame = Record<string, unknown>;
type Turn = {
  /** Final agent message of the turn (raw; may be a WorkReport envelope). */
  text: string;
  /** Native automatic-review denial recorded during this turn. */
  denial?: "command" | "patch";
  /** A command item the native policy declined during this turn. */
  declinedCommand?: boolean;
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const envelope = (state: "completed" | "incomplete", output: string) =>
  JSON.stringify({ work_report: { state, required_inputs: [] }, output });

/** Scripted Codex app-server: the vendor process is the only fake in this path. */
function codexPeer(turns: Turn[], cwd: () => string, options: { authorizationFails?: boolean }) {
  const writes: Frame[] = [];
  let started = 0;
  const spawn: typeof spawnProcess = async function* (_bin, _args, opts = {}) {
    const frames: string[] = [];
    let wake: (() => void) | undefined;
    let stopped = false;
    let close!: () => void;
    const closed = new Promise<void>((done) => (close = done));
    const push = (frame: Frame) => {
      frames.push(JSON.stringify(frame));
      wake?.();
      wake = undefined;
    };
    const play = (rpcId: unknown) => {
      const turn = turns[started] ?? { text: "unexpected extra turn" };
      started += 1;
      const turnId = `turn-${started}`;
      push({ method: "turn/started", params: { threadId: "root", turn: { id: turnId } } });
      push({ id: rpcId, result: { turn: { id: turnId } } });
      if (turn.declinedCommand)
        push({
          method: "item/completed",
          params: {
            threadId: "root",
            turnId,
            item: {
              id: `cmd-${started}`,
              type: "commandExecution",
              command: "node --test",
              cwd: cwd(),
              status: "declined",
              aggregatedOutput: "",
            },
          },
        });
      if (turn.denial)
        push({
          method: "item/autoApprovalReview/completed",
          params: {
            threadId: "root",
            turnId,
            reviewId: `review-${started}`,
            targetItemId: `cmd-${started}`,
            action:
              turn.denial === "command"
                ? { type: "command", source: "shell", command: "node --test", cwd: cwd() }
                : { type: "applyPatch", cwd: cwd(), files: ["outside.txt"] },
            review: { status: "denied", rationale: "Needs explicit authorization" },
            startedAtMs: 100,
            completedAtMs: 200,
            decisionSource: "agent",
          },
        });
      push({
        method: "item/completed",
        params: {
          threadId: "root",
          turnId,
          item: { id: `msg-${started}`, type: "agentMessage", text: turn.text },
        },
      });
      push({
        method: "turn/completed",
        params: { threadId: "root", turn: { id: turnId, status: "completed", items: [] } },
      });
    };
    opts.onSpawn?.({
      write(line) {
        const frame = JSON.parse(line) as Frame;
        writes.push(frame);
        const method = frame["method"];
        if (method === "initialize") push({ id: frame["id"], result: {} });
        if (method === "thread/start" || method === "thread/resume")
          push({ id: frame["id"], result: { thread: { id: "root" } } });
        if (method === "turn/start") play(frame["id"]);
        if (method === "thread/approveGuardianDeniedAction")
          push(
            options.authorizationFails
              ? { id: frame["id"], error: { code: -32603, message: "authorization unavailable" } }
              : { id: frame["id"], result: {} },
          );
        if (method === "thread/read")
          push({ id: frame["id"], result: { thread: { status: { type: "idle" } } } });
        if (method === "thread/goal/get")
          push({ id: frame["id"], result: { goal: { status: "complete" } } });
        if (method === "thread/backgroundTerminals/list")
          push({ id: frame["id"], result: { data: [] } });
        if (method === "turn/interrupt") push({ id: frame["id"], result: {} });
      },
      end() {
        stopped = true;
        close();
        wake?.();
      },
      closed,
    });
    while (!stopped || frames.length) {
      if (frames.length) yield { type: "stdout", line: frames.shift()! };
      else await new Promise<void>((done) => (wake = done));
    }
    yield { type: "exit", code: 0, signal: null, durationMs: 0 };
  };
  return { spawn, writes };
}

function fixture(
  turns: Turn[],
  options: { authorizationFails?: boolean; maxRetries?: number } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "codex-native-denial-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"],
    { cwd: root, stdio: "pipe" },
  );
  const config = process.env.CLAUDEXOR_CONFIG_DIR!;
  const profile = {
    profile_id: "a",
    harness_id: "codex",
    display_name: "a",
    credential_kind: "config_dir_login",
    isolation_locator: join(config, "profiles", "a"),
  };
  mkdirSync(profile.isolation_locator, { recursive: true });
  writeFileSync(
    join(config, "config.yaml"),
    JSON.stringify({
      credential_profiles: [profile],
      harnesses: { codex: { default_model: "target" } },
      ...(options.maxRetries === undefined
        ? {}
        : { runtime: { transient_retry: { max_retries: options.maxRetries } } }),
    }),
  );
  let cwd = root;
  const peer = codexPeer(turns, () => cwd, options);
  const specs: HarnessRunSpec[] = [];
  const adapter: HarnessAdapter = {
    id: "codex",
    // The real app-server translation, fed the orchestrator's own spec (its
    // access profile, interaction channel, abort signal and output schema).
    async *run(spec) {
      specs.push(spec);
      cwd = spec.cwd;
      for await (const event of runCodexAppServer({
        bin: "codex",
        args: [],
        spec,
        env: {},
        spawn: peer.spawn,
        pollIntervalMs: 5,
      }))
        // Account decoration is the adapter shell's job, not this path's subject.
        yield {
          ...event,
          credential_route: "vendor_native",
          credential_profile_id: spec.credential_profile?.profile_id,
        };
    },
    discover: async () =>
      HarnessManifest.parse({
        id: "codex",
        display_name: "fixture codex",
        kind: "local_cli",
        provider_family: "local",
        capabilities: {
          implement: true,
          interactive: true,
          read_files: true,
          json_schema_output: true,
          work_report_transport: "constrained",
          structured_output_channel: "final_message",
          known_models: ["target"],
        },
        auth_modes: ["local_session"],
        access_profiles_supported: ["readonly", "workspace_write", "full"],
      }),
    doctor: async () =>
      ConformanceReport.parse({
        harness_id: "codex",
        status: "ok",
        enabled_intents: ["implement"],
        auth_sources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
      }),
    probeCredentialProfile: async (p) => ({
      profile_id: p.profile_id,
      harness_id: "codex",
      availability: "available",
      verification: "passed",
      verification_source: "local_store",
      last_verified_at: new Date().toISOString(),
    }),
  };
  const snapshots: QuotaSnapshot[] = [
    {
      subject: {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "a",
      },
      constraints: [],
      source: "codex_app_server",
      observed_at: new Date().toISOString(),
      freshness: "fresh",
    },
  ];
  const run = async (answer?: (ctx: PendingInteractionContext) => InteractionAnswerSet | null) => {
    const asked: PendingInteractionContext[] = [];
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const result = await new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
      quotaSnapshots: () => snapshots,
    }).run({
      repoRoot: root,
      mode: "agent",
      inPlace: true,
      n: 1,
      prompt: "Make the change and verify it",
      harnesses: ["codex"],
      models: { codex: "target" },
      authPreference: "subscription",
      access: "workspace_write",
      review: false,
      web: "off",
      onEvent: (event) =>
        events.push({ type: event.type, payload: event.payload as Record<string, unknown> }),
      onInteraction: async (ctx) => {
        asked.push(ctx);
        return answer?.(ctx) ?? null;
      },
      interactionTimeoutMs: null,
    });
    const store = new ArtifactStore(root);
    const answerPath = join(result.runDir, "final", "answer.md");
    const retainedPath = join(result.runDir, "final", "retained-output.md");
    const telemetry = RunTelemetry.parse(
      store.readYaml(join(result.runDir, "final/telemetry.yaml")),
    );
    return {
      result,
      asked,
      events,
      telemetry,
      answer: existsSync(answerPath) ? readFileSync(answerPath, "utf8").trim() : null,
      retained: existsSync(retainedPath) ? readFileSync(retainedPath, "utf8") : null,
    };
  };
  return { run, peer, specs };
}

const choose = (ctx: PendingInteractionContext, label: string): InteractionAnswerSet => ({
  interaction_id: ctx.request.interaction_id,
  answers: [{ question_id: "approval", selected_labels: [label], free_text: null }],
});

const harnessCodes = (events: Array<{ type: string; payload: Record<string, unknown> }>) =>
  events
    .filter((event) => event.type === "harness.event")
    .map((event) => (event.payload?.["payload"] as Record<string, unknown> | undefined)?.["code"])
    .filter(Boolean);

describe("orchestrator outcome for Codex native automatic-review denials", () => {
  it("keeps the worker's WorkReport, answer and declined-tool evidence when a denial cannot be offered", async () => {
    const f = fixture([
      {
        text: envelope("incomplete", "Could not write outside.txt: native review denied it"),
        denial: "patch",
        declinedCommand: true,
      },
    ]);
    const { result, asked, events, telemetry, answer } = await f.run();
    expect(f.specs[0]).toMatchObject({ access: "workspace_write" });
    expect(f.specs[0]?.output_schema).toBeTruthy();
    expect(asked).toEqual([]);
    expect(harnessCodes(events)).toContain("codex_auto_review_not_offered");
    expect(result.lifecycle, result.summary).toBe("succeeded");
    // The model-attested WorkReport still vetoes a clean, applyable result.
    expect(result.facts.work_state?.state).toBe("incomplete");
    expect(answer).toBe("Could not write outside.txt: native review denied it");
    // The declined native action remains unrecovered tool-error evidence.
    expect(telemetry.attempts[0]?.tool_errors_total).toBe(1);
    expect(telemetry.attempts[0]?.unrecovered_tool_errors).toBe(1);
    expect(JSON.stringify(telemetry.attempts[0]?.tool_errors)).toContain("node --test");
    expect(telemetry.attempts[0]?.outcome).toMatchObject({
      harness_errored: false,
      deliverable_present: true,
    });
    expect(telemetry.attempts[0]?.outcome.status).not.toBe("success");
  }, 30_000);

  it("keeps the completed answer and a clean outcome when the controller declines the retry", async () => {
    const f = fixture([
      { text: envelope("completed", "Done; the extra check was declined"), denial: "command" },
    ]);
    const { result, asked, answer } = await f.run((ctx) => choose(ctx, "Decline"));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.request.questions[0]?.options.map((option) => option.label)).toEqual([
      "Authorize one retry",
      "Decline",
    ]);
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(result.facts.work_state?.state).toBe("completed");
    expect(answer).toBe("Done; the extra check was declined");
    expect(f.peer.writes.filter((frame) => frame["method"] === "turn/start")).toHaveLength(1);
  }, 30_000);

  it("uses the authorized retry turn's WorkReport and answer, without a second authorization loop", async () => {
    const f = fixture([
      { text: envelope("incomplete", "Blocked: node --test needs permission"), denial: "command" },
      { text: envelope("incomplete", "Native review refused the retry again"), denial: "command" },
    ]);
    const { result, asked, events, answer } = await f.run((ctx) =>
      choose(ctx, "Authorize one retry"),
    );
    expect(asked).toHaveLength(1);
    expect(
      f.peer.writes.filter((frame) => frame["method"] === "thread/approveGuardianDeniedAction"),
    ).toHaveLength(1);
    expect(f.peer.writes.filter((frame) => frame["method"] === "turn/start")).toHaveLength(2);
    expect(harnessCodes(events)).toContain("codex_auto_review_not_offered");
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(result.facts.work_state?.state).toBe("incomplete");
    expect(answer).toBe("Native review refused the retry again");
  }, 30_000);

  it("fails the run when native authorization fails and no continuation is allowed, keeping the completed answer", async () => {
    const f = fixture(
      [{ text: envelope("completed", "Blocked before retry"), denial: "command" }],
      {
        authorizationFails: true,
        maxRetries: 0,
      },
    );
    const { result, telemetry, answer, retained } = await f.run((ctx) =>
      choose(ctx, "Authorize one retry"),
    );
    expect(result.lifecycle, result.summary).toBe("failed");
    expect(result.facts.reason).toBe("harness_failed");
    expect(f.specs).toHaveLength(1);
    expect(f.peer.writes.filter((frame) => frame["method"] === "turn/start")).toHaveLength(1);
    expect(telemetry.attempts[0]?.outcome).toMatchObject({
      status: "failed",
      harness_errored: true,
      deliverable_present: true,
    });
    // A failed run publishes no deliverable; the completed bytes stay diagnostic.
    expect(answer).toBeNull();
    expect(retained).toContain("Blocked before retry");
  }, 30_000);

  it("continues an authorization failure through the existing bounded native-session continuation", async () => {
    const f = fixture(
      [
        { text: envelope("completed", "Blocked before retry"), denial: "command" },
        { text: envelope("completed", "Resumed and finished without the denied check") },
      ],
      { authorizationFails: true },
    );
    const { result, events, answer } = await f.run((ctx) => choose(ctx, "Authorize one retry"));
    expect(f.specs).toHaveLength(2);
    expect(f.specs[1]?.resume_session_id).toBe("root");
    expect(f.peer.writes.some((frame) => frame["method"] === "thread/resume")).toBe(true);
    expect(events.some((event) => event.type === "run.continuity")).toBe(true);
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(answer).toBe("Resumed and finished without the denied check");
  }, 30_000);
});
