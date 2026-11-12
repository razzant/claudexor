import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMaintenanceRoute } from "./maintenance-routes.js";
import { OPERATION_CATALOG } from "./operation-catalog.js";

const OPERATION = {
  id: "job-1",
  harness: "codex",
  state: "queued",
  phase: "accepted",
  createdAt: "2026-10-09T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  requester: { source: "control-api", requestId: "k1" },
  installationHome: null,
  commands: [],
  elsewhere: null,
  activeRunsAtStart: null,
  exitCode: null,
  outcome: "unknown",
  target: { kind: "latest", version: null },
  before: null,
  after: null,
  mutation: "none",
  termination: "not_applicable",
  limitations: [],
  progress: [],
  problem: null,
};

function harness(services: Record<string, unknown>) {
  const sent: Array<{ status: number; body: unknown }> = [];
  const errors: unknown[] = [];
  const ctx = {
    services,
    readBody: async (req: IncomingMessage) => (req as unknown as { body: unknown }).body,
    json: (_res: ServerResponse, status: number, body: unknown) => sent.push({ status, body }),
    requestError: (_res: ServerResponse, error: unknown) => errors.push(error),
  };
  const call = (
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    handleMaintenanceRoute(
      ctx,
      method,
      url.split("?")[0]!.replace(/^\/v2/, ""),
      { url, headers, body } as unknown as IncomingMessage,
      {} as ServerResponse,
    );
  return { call, sent, errors };
}

describe("harness maintenance routes", () => {
  it("advertises the capability through generated catalog descriptors", () => {
    const ids = OPERATION_CATALOG.operations.map((operation) => operation.id);
    for (const id of [
      "get:maintenance.harnesses",
      "post:maintenance.operations",
      "get:maintenance.operations.id",
      "post:maintenance.operations.id.cancel",
      "post:maintenance.gc",
    ])
      expect(ids).toContain(id);
    const create = OPERATION_CATALOG.operations.find((o) => o.id === "post:maintenance.operations");
    expect(create).toMatchObject({ idempotency: "key_required", completion: "durable_handle" });
  });

  it("create requires an Idempotency-Key and answers 202 with the durable handle", async () => {
    const createMaintenanceOperation = vi.fn(async () => OPERATION);
    const h = harness({ createMaintenanceOperation });
    const body = { harness: "codex", target: { kind: "latest" } };
    expect(await h.call("POST", "/v2/maintenance/operations", body)).toBe(true);
    expect(createMaintenanceOperation).not.toHaveBeenCalled();
    expect(h.errors[0]).toMatchObject({ code: "idempotency_key_required" });
    await h.call("POST", "/v2/maintenance/operations", body, { "idempotency-key": "k1" });
    expect(createMaintenanceOperation).toHaveBeenCalledWith(body, "k1");
    expect(h.sent.at(-1)).toMatchObject({ status: 202, body: { id: "job-1", state: "queued" } });
  });

  it("inventory forwards repeatable harness filters and refuses unknown query keys", async () => {
    const maintenanceInventory = vi.fn(async () => ({
      observedAt: "2026-10-09T00:00:00.000Z",
      harnesses: [],
    }));
    const h = harness({ maintenanceInventory });
    await h.call("GET", "/v2/maintenance/harnesses?harness=codex&harness=cursor&checkLatest=true");
    expect(maintenanceInventory).toHaveBeenCalledWith({
      harnessIds: ["codex", "cursor"],
      fresh: false,
      checkLatest: true,
    });
    await h.call("GET", "/v2/maintenance/harnesses?login=true");
    expect(maintenanceInventory).toHaveBeenCalledTimes(1);
    expect(h.errors).toHaveLength(1);
  });

  it("status and cancel address one operation; other verbs fall through", async () => {
    const getMaintenanceOperation = vi.fn(async () => OPERATION);
    const cancelMaintenanceOperation = vi.fn(async () => ({ ...OPERATION, state: "cancelled" }));
    const h = harness({ getMaintenanceOperation, cancelMaintenanceOperation });
    await h.call("GET", "/v2/maintenance/operations/job-1");
    await h.call("POST", "/v2/maintenance/operations/job-1/cancel");
    expect(getMaintenanceOperation).toHaveBeenCalledWith("job-1");
    expect(cancelMaintenanceOperation).toHaveBeenCalledWith("job-1");
    expect(await h.call("DELETE", "/v2/maintenance/operations/job-1")).toBe(false);
    expect(await h.call("GET", "/v2/maintenance/operations/job-1/cancel")).toBe(false);
  });
});
