import { createHash, randomUUID } from "node:crypto";
import { TERMINAL_LIFECYCLES } from "@claudexor/schema";
import { daemonOutcomeSummary, ensureDaemon, fetchApplyEligibility } from "./daemon-run.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";
import { primaryOutputForCli } from "./primary-output.js";

// Daemon job state IS the run lifecycle (D8): terminal set = the ONE
// projection-owned TERMINAL_LIFECYCLES, never a local re-derivation.
const TERMINALS: ReadonlySet<string> = TERMINAL_LIFECYCLES;

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
      throw new Error(
        typeof body["message"] === "string"
          ? (body["message"] as string)
          : typeof body["error"] === "string"
            ? (body["error"] as string)
            : `control API ${path} failed (HTTP ${response.status})`,
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
  if (p.mode === "__acp_session_load" || p.mode === "__acp_session_resume") {
    const turns = (Array.isArray(detail["turns"]) ? detail["turns"] : []).map((turn) => {
      const value = turn as Record<string, unknown>;
      const result = (value["run"] as Record<string, unknown> | null)?.["result"] as
        Record<string, unknown> | undefined;
      return {
        prompt: typeof value["prompt"] === "string" ? value["prompt"] : "",
        summary: typeof result?.["summary"] === "string" ? result["summary"] : null,
      };
    });
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
      return {
        runId,
        runDir,
        status: record.state,
        summary,
        applyEligibility: runId ? await fetchApplyEligibility(addr, runId) : null,
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
  return {
    sessionId: String(thread["id"] ?? ""),
    cwd: String(thread["repoRoot"] ?? ""),
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
