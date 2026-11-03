import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRunRetryRoute, type RunRetryRouteContext } from "./run-retry-routes.js";
import type { DaemonRunRecord } from "./daemon-server.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
function fixture(explicit?: "standard" | "fast") {
  const root = mkdtempSync(join(tmpdir(), "retry-processing-"));
  roots.push(root);
  mkdirSync(join(root, "context"));
  writeFileSync(
    join(root, "context", "task.yaml"),
    [
      "schema_version: 2",
      "task_id: task-source",
      "created_at: 2026-09-12T00:00:00.000Z",
      "repo:",
      `  root: ${JSON.stringify(root)}`,
      "  base_ref: HEAD",
      "mode:",
      "  kind: agent",
      "user_intent:",
      "  raw: work",
      "processing_preference: standard",
      "tests:",
      "  commands: []",
      "",
    ].join("\n"),
  );
  const source = {
    id: "source-job",
    runId: "source",
    runDir: root,
    state: "succeeded",
    params: {
      prompt: "work",
      mode: "agent",
      scope: { kind: "project", root },
      execution: { isolation: "envelope", workspaceKind: "directory", scopePaths: ["chosen"] },
      ...(explicit ? { processingPreference: explicit } : {}),
    },
  } as DaemonRunRecord;
  const enqueue = vi.fn(async (_params: unknown) => ({ id: "retry-job" }));
  const findAccepted = vi.fn(async (): Promise<DaemonRunRecord | null> => null);
  const json = vi.fn();
  const preflight = vi.fn(async () => {});
  const ctx = {
    daemon: { enqueue, findAccepted } as unknown as RunRetryRouteContext["daemon"],
    findRun: async () => source,
    waitForRunStart: async () => ({ id: "retry-job", runId: "retry", state: "running" }),
    serializeThreadMutation: async (_id, work) => work(),
    json,
    requestError: (_res, error) => {
      throw error;
    },
    services: { preflightRunRequirements: preflight },
  } as RunRetryRouteContext;
  const req = { headers: { "idempotency-key": "exact-retry" } } as unknown as IncomingMessage;
  return { ctx, req, enqueue, findAccepted, json, preflight, source };
}

describe("exact retry processing custody", () => {
  it.each([true, false])(
    "omits internal continuation model provenance from an editable draft (%s)",
    async (inherited) => {
      const f = fixture();
      f.source.params = {
        ...(f.source.params as object),
        continueFrom: "predecessor",
        continueModelInherited: inherited,
        model: "selected",
      };
      await handleRunRetryRoute(
        f.ctx,
        "GET",
        "/runs/source/run-again",
        f.req,
        {} as ServerResponse,
      );
      const draft = f.json.mock.calls[0]?.[2];
      expect(draft.request).toHaveProperty("model", "selected");
      expect(draft.request).not.toHaveProperty("continueModelInherited");
      expect(draft.differences).toContainEqual({
        field: "continueModelInherited",
        change: "omitted",
        reason: "model intent is resolved from the edited request",
      });
    },
  );
  it.each([undefined, "fast"] as const)(
    "preserves original processing and scope (explicit=%s)",
    async (explicit) => {
      const f = fixture(explicit);
      await handleRunRetryRoute(f.ctx, "POST", "/runs/source/retry", f.req, {} as ServerResponse);
      expect(f.enqueue.mock.calls[0]?.[0]).toMatchObject({
        processingPreference: explicit ?? "standard",
        execution: { workspaceKind: "directory", scopePaths: ["chosen"] },
        retryOf: "source",
      });
    },
  );
  it("rejoins an accepted retry before rerunning preparation or dispatch", async () => {
    const f = fixture();
    f.findAccepted.mockResolvedValue({
      id: "retry-job",
      runId: "retry",
      state: "running",
      params: { processingPreference: "standard" },
    } as DaemonRunRecord);
    await handleRunRetryRoute(f.ctx, "POST", "/runs/source/retry", f.req, {} as ServerResponse);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.preflight).not.toHaveBeenCalled();
    expect(f.json.mock.calls[0]?.[2]).toMatchObject({ runId: "retry", retryOf: "source" });
  });
});
