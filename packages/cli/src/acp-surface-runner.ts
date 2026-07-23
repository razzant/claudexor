import { createHash, randomUUID } from "node:crypto";
import { noProjectRepoRoot } from "@claudexor/util";
import { TERMINAL_LIFECYCLES } from "@claudexor/schema";
import {
  daemonOutcomeSummary,
  ensureDaemon,
  fetchApplyEligibility,
  fetchPlanQuestions,
  fetchPlanReadiness,
} from "./daemon-run.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";
import { primaryOutputForCli } from "./primary-output.js";

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

type Hooks = {
  onInteraction?: (ctx: any) => Promise<any | null>;
  signal?: AbortSignal;
};

type Bridges = {
  cancel: (
    addr: ControlApiAddress,
    signal: AbortSignal,
  ) => (info: { runId: string }) => Promise<void>;
  interactions: (
    addr: ControlApiAddress,
    handler: (ctx: any) => Promise<any | null>,
  ) => (info: { runId: string }) => Promise<void>;
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
      // Preserve the typed code/status on the throwable so callers can disclose
      // a MACHINE reason (e.g. run_expired_by_retention) rather than only prose.
      throw Object.assign(
        new Error(
          typeof body["message"] === "string"
            ? (body["message"] as string)
            : typeof body["error"] === "string"
              ? (body["error"] as string)
              : `control API ${path} failed (HTTP ${response.status})`,
        ),
        {
          status: response.status,
          ...(typeof body["code"] === "string" ? { code: body["code"] as string } : {}),
        },
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
  const controls = Object.fromEntries(
    Object.entries(p).filter(
      ([key]) =>
        !["mode", "sessionId", "repoPath", "prompt", "attachments", "deferred"].includes(key),
    ),
  );
  if (controls["runMode"] !== undefined) {
    controls["mode"] = controls["runMode"];
    delete controls["runMode"];
  }
  if (typeof controls["harness"] === "string") {
    controls["harnesses"] = [controls["harness"]];
    delete controls["harness"];
  }
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
    ? bridges.interactions(addr, hooks.onInteraction)
    : null;
  for (;;) {
    const record = await client.status(jobId);
    runId = record.runId ?? runId;
    runDir = record.runDir ?? runDir;
    if (runId) {
      if (cancel) await cancel({ runId });
      if (interactions) await interactions({ runId });
    }
    if (TERMINALS.has(record.state)) {
      const primary = runDir ? primaryOutputForCli(runDir, "agent") : null;
      const summary =
        primary && primary.kind !== "patch"
          ? primary.text.trim()
          : (daemonOutcomeSummary({ runId, status: record.state, error: record.error }) ??
            `run ${record.state}`);
      // Plan lifecycle (D17): a plan turn that ends needs_answers carries its
      // derived readiness + the ENGINE-parsed open questions so the ACP surface
      // renders them as TURN TEXT (the user answers in an ordinary follow-up
      // plan turn — the same server path, no typed-form faking the protocol
      // lacks). Empty/null for non-plan turns and ready plans.
      return {
        runId,
        runDir,
        status: record.state,
        summary,
        applyEligibility: runId ? await fetchApplyEligibility(addr, runId) : null,
        planReadiness: runId ? await fetchPlanReadiness(addr, runId) : null,
        planQuestions: runId ? await fetchPlanQuestions(addr, runId) : [],
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
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
