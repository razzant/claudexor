import { createHash, randomUUID } from "node:crypto";
import { noProjectRepoRoot } from "@claudexor/util";
import {
  TERMINAL_LIFECYCLES,
  type ControlPrimaryOutput,
  type ModeKind,
  type RunFacts,
  type RunFailure,
  type RunOutcomeFacts,
} from "@claudexor/schema";
import { daemonOutcomeSummary, ensureDaemon, fetchRunDetail } from "./daemon-run.js";
import { controlProblemError } from "./cli-error.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";
import { primaryOutputForCli } from "./primary-output.js";
import {
  describeRunDetailProblem,
  presentRunPrimaryOutput,
  projectApplyEligibility,
  projectOutcomeBanner,
  projectRunPrimaryOutput,
  projectRunFailure,
  type RunDetailProblem,
} from "./run-detail-projections.js";
import { projectRunOutcomeFacts } from "./daemon-outcome.js";
import { projectRunFacts } from "./run-facts-projection.js";
import { AcpTimeLimitFeed } from "./acp-time-limit-feed.js";

// Daemon job state IS the run lifecycle (D8): terminal set = the ONE
// projection-owned TERMINAL_LIFECYCLES, never a local re-derivation.
const TERMINALS: ReadonlySet<string> = TERMINAL_LIFECYCLES;

// W5: an ACP session/load replays the conversation by fetching one run detail
// per turn. Cap that fan-out to the most recent N turns so reopening a long
// thread cannot issue thousands of per-reopen detail fetches; older turns are
// disclosed as omitted rather than silently dropped.
export const ACP_MAX_REPLAY_TURNS = 50;

/** Bound the load-replay to the most recent ACP_MAX_REPLAY_TURNS turns, and
 *  report how many older turns were omitted (disclosed to the client, never
 *  silently dropped). Pure + exported for test. */
export function selectReplayTurns<T>(rawTurns: readonly T[]): {
  replayTurns: T[];
  omittedTurnCount: number;
} {
  return {
    replayTurns: rawTurns.slice(-ACP_MAX_REPLAY_TURNS),
    omittedTurnCount: Math.max(0, rawTurns.length - ACP_MAX_REPLAY_TURNS),
  };
}

/** One post-terminal GET /runs/:id for the ACP turn result (INV-120), DEGRADING
 *  on failure: a finished turn must never become a JSON-RPC error that loses
 *  the runId. Missing/legacy detail projects null fields; a raised typed
 *  problem (e.g. 500 run_facts_invalid) rides the result as `detailProblem`
 *  so the client still receives the terminal answer plus the typed reason its
 *  detail projections are absent. Exported for test. */
export async function projectTerminalTurnDetail(
  addr: ControlApiAddress,
  runId: string,
  lifecycle: RunOutcomeFacts["lifecycle"],
): Promise<{
  applyEligibility: unknown;
  planReadiness: unknown;
  planQuestions: unknown[];
  failure: RunFailure | null;
  primaryOutput: ControlPrimaryOutput | null;
  outcomeFacts: RunOutcomeFacts | null;
  outcomeBanner: string | null;
  runFacts: RunFacts | null;
  detailProblem?: RunDetailProblem;
}> {
  const empty = {
    applyEligibility: null,
    planReadiness: null,
    planQuestions: [],
    failure: null,
    primaryOutput: null,
    outcomeFacts: null,
    outcomeBanner: null,
    runFacts: null,
  };
  if (!runId) return empty;
  try {
    const detail = await fetchRunDetail(addr, runId);
    const runFacts = projectRunFacts(detail, { runId, lifecycle });
    return {
      applyEligibility: projectApplyEligibility(detail),
      planReadiness:
        detail?.["planReadiness"] && typeof detail["planReadiness"] === "object"
          ? detail["planReadiness"]
          : null,
      planQuestions: Array.isArray(detail?.["planQuestions"])
        ? (detail["planQuestions"] as unknown[])
        : [],
      failure: projectRunFailure(detail),
      primaryOutput: projectRunPrimaryOutput(detail),
      outcomeFacts: projectRunOutcomeFacts(detail),
      outcomeBanner: projectOutcomeBanner(detail),
      runFacts,
    };
  } catch (error) {
    return { ...empty, detailProblem: describeRunDetailProblem(error) };
  }
}

type AcpTerminalRecord = {
  state: string;
  error?: string;
  params?: unknown;
};

/** Effective mode persisted on the daemon job after the thread-turn funnel. */
export function acpTerminalRecordMode(
  record: Pick<AcpTerminalRecord, "params">,
): ModeKind | undefined {
  if (!record.params || typeof record.params !== "object" || Array.isArray(record.params)) {
    return undefined;
  }
  const value = (record.params as Record<string, unknown>)["mode"];
  return value === "ask" || value === "plan" || value === "agent" ? value : undefined;
}

/**
 * ACP terminal text consumes the Control API's canonical bounded/redacted
 * primaryOutput. Local artifact discovery exists only as a degrading fallback
 * when that one detail read failed; its mode comes from the durable daemon job,
 * never from an ACP default or a hard-coded Agent assumption.
 */
export function acpTerminalSummary(input: {
  runId: string;
  runDir: string;
  record: AcpTerminalRecord;
  detail: Awaited<ReturnType<typeof projectTerminalTurnDetail>>;
}): string {
  const localFallback =
    input.detail.detailProblem && input.runDir
      ? primaryOutputForCli(input.runDir, acpTerminalRecordMode(input.record), {
          failure: input.detail.failure,
          lifecycle: TERMINALS.has(input.record.state)
            ? (input.record.state as RunOutcomeFacts["lifecycle"])
            : undefined,
        })
      : null;
  const primary = input.detail.primaryOutput ?? localFallback;
  const presented = presentRunPrimaryOutput(primary);
  return presented
    ? presented
    : (input.detail.outcomeBanner ??
        daemonOutcomeSummary({
          runId: input.runId,
          status: input.record.state,
          error: input.record.error,
          outcomeFacts: input.detail.outcomeFacts ?? undefined,
        }) ??
        `run ${input.record.state}`);
}

/** A machine-ish reason for a failed per-turn run-detail fetch: prefer the
 *  typed control-API `code` (e.g. run_expired_by_retention), then the HTTP
 *  status, then a generic marker — never the raw English message. */
export function typedFetchReason(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; status?: unknown };
    if (typeof e.code === "string" && e.code) return e.code;
    if (typeof e.status === "number") return `http_${e.status}`;
  }
  return "detail_unavailable";
}

/** Translate ACP aliases into the strict Control API run-start vocabulary. */
export function projectAcpRunControls(input: Record<string, unknown>): Record<string, unknown> {
  const controls = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) =>
        !["mode", "sessionId", "repoPath", "prompt", "attachments", "deferred"].includes(key),
    ),
  );
  if (controls["runMode"] !== undefined) {
    controls["mode"] = controls["runMode"];
    delete controls["runMode"];
  }
  if (controls["race"] === true && typeof controls["n"] !== "number") controls["n"] = 2;
  delete controls["race"];
  if (typeof controls["harness"] === "string") {
    controls["harnesses"] = [controls["harness"]];
    delete controls["harness"];
  }
  return controls;
}

type Hooks = {
  onEvent?: (event: unknown) => void;
  onInteraction?: (ctx: any) => Promise<any | null>;
  signal?: AbortSignal;
};

type Bridges = {
  cancel: (
    addr: ControlApiAddress,
    signal: AbortSignal,
  ) => (info: { runId: string }) => Promise<void>;
  /** Prompts run beside the poll loop; the caller's cancel or close() ends any left open. */
  interactions: (
    addr: ControlApiAddress,
    handler: (ctx: any) => Promise<any | null>,
    callerSignal?: AbortSignal,
  ) => ((info: { runId: string }) => Promise<void>) & { close(): void };
};

/** Daemon-thread implementation behind the official ACP protocol projection. */
export async function acpSessionQuery(
  p: any,
  hooks: Hooks | undefined,
  bridges: Bridges,
): Promise<unknown> {
  const { client, addr } = await ensureDaemon();
  const request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Record<string, unknown>> => {
    const response = await controlApiFetch(addr, path, init);
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw controlProblemError(
        response.status,
        body,
        `control API ${path} failed (HTTP ${response.status})`,
      );
    }
    return body;
  };
  if (p.mode === "__acp_session_new") {
    const body = await request("/threads", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        title: "ACP session",
        scope: { kind: "project", root: String(p.repoPath ?? "") },
        workspace: "in_place",
      }),
    });
    return sessionRecord(body);
  }
  if (p.mode === "__acp_session_list") {
    const body = await request("/threads");
    const sessions = (Array.isArray(body["threads"]) ? body["threads"] : [])
      // A trashed thread is a deleted conversation awaiting purge, not a session.
      .filter((thread) => (thread as Record<string, unknown>)["state"] !== "trashed")
      .map((thread) => sessionRecord(thread as Record<string, unknown>))
      .filter((session) => !p.repoPath || session.cwd === p.repoPath);
    return { sessions };
  }
  const sessionId = String(p.sessionId ?? "");
  if (!sessionId) throw new Error("ACP session id is required");
  if (p.mode === "__acp_session_close") {
    return sessionRecord(
      await request(`/threads/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "closed" }),
      }),
    );
  }
  const detail = await request(`/threads/${encodeURIComponent(sessionId)}`);
  const session = sessionRecord((detail["thread"] ?? {}) as Record<string, unknown>);
  if (p.repoPath && session.cwd !== p.repoPath) {
    throw new Error(`ACP session ${sessionId} belongs to a different cwd`);
  }
  if (p.mode === "__acp_session_resume") {
    // ACP resume MUST NOT replay conversation history — it is the no-history
    // continuation capability. Return the session shell only; the server emits
    // zero session/update notifications for resume.
    return { ...session };
  }
  if (p.mode === "__acp_session_load") {
    // ACP loadSession MUST replay the ENTIRE conversation before responding
    // (QA-020). Build ordered {prompt, output} entries from the durable turns:
    // the user half is ControlThreadTurn.prompt; the agent half is the Control
    // API's OWN typed primary-output owner (ControlRunDetail.primaryOutput) —
    // the same artifact macOS/run-detail render — never the non-existent
    // `run.result.summary`. A runless (refused/preflight-failed) turn keeps its
    // user prompt and discloses its typed enqueue error so it never vanishes.
    // This per-turn run-detail read happens only on reopen (bounded to the
    // thread's own turns), not on the hot thread-hydration path where INV-136's
    // no-N+1 compact-card contract still holds. The reads are further BOUNDED to
    // the most recent ACP_MAX_REPLAY_TURNS turns (W5): an old thread with
    // thousands of turns must not fan out one detail fetch per turn on reopen. A
    // failed per-turn detail fetch DISCLOSES a typed reason instead of vanishing.
    const rawTurns = Array.isArray(detail["turns"]) ? detail["turns"] : [];
    const { replayTurns, omittedTurnCount } = selectReplayTurns(rawTurns);
    const turns: Array<{
      prompt: string;
      output: { kind: string; text: string; truncated: boolean } | null;
    }> = [];
    // Disclose the cap so the reopened conversation never silently starts
    // mid-stream as if the earlier turns never existed.
    if (omittedTurnCount > 0) {
      turns.push({
        prompt: "",
        output: {
          kind: "diagnostic",
          text: `[replaying the most recent ${ACP_MAX_REPLAY_TURNS} turns; ${omittedTurnCount} earlier turn(s) omitted]`,
          truncated: true,
        },
      });
    }
    for (const turn of replayTurns) {
      const value = turn as Record<string, unknown>;
      const prompt = typeof value["prompt"] === "string" ? value["prompt"] : "";
      const runId = typeof value["runId"] === "string" ? value["runId"] : "";
      let output: { kind: string; text: string; truncated: boolean } | null = null;
      if (runId) {
        try {
          const run = await request(`/runs/${encodeURIComponent(runId)}`);
          const primary = run["primaryOutput"] as Record<string, unknown> | null | undefined;
          const text = typeof primary?.["text"] === "string" ? primary["text"].trim() : "";
          if (text) {
            output = {
              kind: typeof primary?.["kind"] === "string" ? (primary["kind"] as string) : "answer",
              text,
              truncated: primary?.["truncated"] === true,
            };
          }
        } catch (error) {
          // The run detail could not be fetched (e.g. artifacts reclaimed by
          // retention -> typed 410 run_expired_by_retention). Disclose the typed
          // reason; do NOT drop the agent half silently.
          output = {
            kind: "diagnostic",
            text: `[output unavailable: ${typedFetchReason(error)}]`,
            truncated: false,
          };
        }
      } else {
        const enqueueError = value["enqueueError"] as Record<string, unknown> | null | undefined;
        const message =
          typeof enqueueError?.["message"] === "string" ? enqueueError["message"].trim() : "";
        if (message) output = { kind: "diagnostic", text: message, truncated: false };
      }
      turns.push({ prompt, output });
    }
    return { ...session, turns };
  }
  if (p.mode !== "__acp_session_prompt") throw new Error(`unknown ACP action ${p.mode}`);

  const attachments = await uploadAttachments(addr, p.attachments);
  const controls = projectAcpRunControls(p);
  const started = await request(`/threads/${encodeURIComponent(sessionId)}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({
      prompt: String(p.prompt ?? ""),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...controls,
    }),
  });
  const jobId = String(started["jobId"] ?? started["runId"] ?? "");
  let runId = typeof started["runId"] === "string" ? started["runId"] : "";
  let runDir = typeof started["runDir"] === "string" ? started["runDir"] : "";
  const cancel = hooks?.signal ? bridges.cancel(addr, hooks.signal) : null;
  const interactions = hooks?.onInteraction
    ? bridges.interactions(addr, hooks.onInteraction, hooks.signal)
    : null;
  const events = hooks?.onEvent ? new AcpTimeLimitFeed(addr, hooks.onEvent) : null;
  let terminal = false;
  try {
    for (;;) {
      const record = await client.status(jobId);
      runId = record.runId ?? runId;
      runDir = record.runDir ?? runDir;
      if (runId) {
        events?.start(runId);
        if (cancel) await cancel({ runId });
        // Never waits for a prompt, so the cancel above and the terminal below
        // are still observed; only a blocking prompt's failure rejects here.
        if (interactions) await interactions({ runId });
      }
      if (TERMINALS.has(record.state)) {
        terminal = true;
        const detail = await projectTerminalTurnDetail(
          addr,
          runId,
          record.state as RunOutcomeFacts["lifecycle"],
        );
        const summary = acpTerminalSummary({ runId, runDir, record, detail });
        const { primaryOutput: _primaryOutput, ...terminalProjection } = detail;
        // Plan lifecycle (D17): a plan turn that ends needs_answers carries its
        // derived readiness + the ENGINE-parsed open questions so the ACP surface
        // renders them as TURN TEXT (the user answers in an ordinary follow-up
        // plan turn — the same server path, no typed-form faking the protocol
        // lacks). Empty/null for non-plan turns and ready plans. ONE degrading
        // detail read feeds all terminal projections (projectTerminalTurnDetail).
        return {
          runId,
          runDir,
          status: record.state,
          summary,
          ...terminalProjection,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    interactions?.close();
    await events?.close(terminal);
  }
}

function sessionRecord(thread: Record<string, unknown>): {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
} {
  const repoRoot = typeof thread["repoRoot"] === "string" ? thread["repoRoot"] : "";
  return {
    sessionId: String(thread["id"] ?? ""),
    // No-project threads persist repoRoot:null. ACP requires an absolute cwd on
    // BOTH list and load (load also equality-checks it), so map a null/empty
    // scope to the canonical no-project synthetic root the daemon already owns
    // and materializes (~/.cache/claudexor/no-project) rather than the invalid
    // empty string no conforming client could ever load back (QA-068).
    cwd: repoRoot || noProjectRepoRoot(),
    title: typeof thread["title"] === "string" ? thread["title"] : null,
    updatedAt: typeof thread["updatedAt"] === "string" ? thread["updatedAt"] : null,
  };
}

async function uploadAttachments(
  addr: ControlApiAddress,
  input: unknown,
): Promise<Array<{ resourceId: string }>> {
  if (!Array.isArray(input) || input.length === 0) return [];
  const refs: Array<{ resourceId: string }> = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    const bytes = Buffer.from(String(value["data"] ?? ""), "base64");
    const create = await controlApiFetch(addr, "/uploads", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        kind: value["kind"] === "image" ? "image" : "file",
        mime: String(value["mime"] ?? "application/octet-stream"),
        name: String(value["name"] ?? "acp-resource"),
        sizeBytes: bytes.byteLength,
      }),
    });
    const upload = (await create.json().catch(() => ({}))) as Record<string, unknown>;
    if (!create.ok) throw new Error(`ACP attachment create failed (HTTP ${create.status})`);
    const uploadId = String(upload["uploadId"] ?? "");
    const put = await controlApiFetch(addr, `/uploads/${encodeURIComponent(uploadId)}/bytes`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    if (!put.ok) throw new Error(`ACP attachment upload failed (HTTP ${put.status})`);
    const finalize = await controlApiFetch(
      addr,
      `/uploads/${encodeURIComponent(uploadId)}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          expectedSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        }),
      },
    );
    const resource = (await finalize.json().catch(() => ({}))) as Record<string, unknown>;
    if (!finalize.ok) throw new Error(`ACP attachment finalize failed (HTTP ${finalize.status})`);
    refs.push({ resourceId: String(resource["resourceId"] ?? "") });
  }
  return refs;
}
