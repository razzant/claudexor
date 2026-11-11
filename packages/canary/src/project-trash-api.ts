/** Control API client of the #333 project trash removal canary stories. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { ControlDaemonStatus, type ControlRunDetail, type ControlThread } from "@claudexor/schema";
import type { Sandbox } from "./support.js";

export function controlApi(sb: Sandbox) {
  let address = { host: "", port: 0 };
  let token = "";
  const call = async (method: string, path: string, body?: unknown, key?: string) => {
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
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as any, text };
  };
  const connect = async () => {
    address = JSON.parse(readFileSync(join(sb.configDir, "daemon", "control-api.json"), "utf8"));
    token = readFileSync(join(sb.configDir, "daemon", "token"), "utf8").trim();
    expect((await call("POST", "/handshake", { protocolMajor: 3, client: "canary" })).status).toBe(
      200,
    );
  };
  const terminal = async (runId: string): Promise<ControlRunDetail> => {
    let detail: ControlRunDetail | undefined;
    await vi.waitFor(
      async () => {
        const read = await call("GET", `/runs/${runId}`);
        expect(read.status).toBe(200);
        detail = read.body as ControlRunDetail;
        expect(["succeeded", "failed", "cancelled", "interrupted"]).toContain(detail.summary.state);
      },
      { timeout: 60_000, interval: 100 },
    );
    return detail!;
  };
  const projectIds = async (): Promise<string[]> =>
    ((await call("GET", "/projects")).body.projects as Array<{ id: string }>).map((p) => p.id);
  const jobState = async (jobId: string): Promise<string | undefined> =>
    (
      (await call("GET", "/runs?limit=1000")).body.runs as Array<{ jobId: string; state: string }>
    ).find((run) => run.jobId === jobId)?.state;
  const openObligations = async (): Promise<number | null | undefined> =>
    ControlDaemonStatus.parse((await call("GET", "/daemon/status")).body).store?.obligations_open;
  const threadStates = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      ((await call("GET", "/threads")).body.threads as ControlThread[]).map((t) => [t.id, t.state]),
    );
  const thread = async (root: string, workspace: "in_place" | "isolated", key: string) => {
    const created = await call(
      "POST",
      "/threads",
      {
        scope: { kind: "project", root },
        workspace,
        mode: "agent",
        access: "workspace_write",
        primaryHarness: "fake-session",
        eligibleHarnesses: ["fake-session"],
      },
      key,
    );
    expect(created.status, created.text).toBe(200);
    return (created.body as ControlThread).id;
  };
  const turn = async (
    threadId: string,
    body: Record<string, unknown>,
    key: string,
    status: 200 | 202 = 200,
  ) => {
    const started = await call("POST", `/threads/${threadId}/turns`, body, key);
    expect(started.status, started.text).toBe(status);
    return started.body as {
      jobId: string;
      turnId: string;
      runId?: string;
      runDir?: string;
      state?: string;
    };
  };
  const trash = async (threadId: string) => {
    const trashed = await call("POST", `/threads/${threadId}/trash`);
    expect(trashed.status, trashed.text).toBe(200);
    expect(trashed.body.state).toBe("trashed");
  };
  return {
    call,
    connect,
    terminal,
    projectIds,
    openObligations,
    jobState,
    threadStates,
    thread,
    turn,
    trash,
  };
}
