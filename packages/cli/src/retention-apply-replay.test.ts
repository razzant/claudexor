import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { ControlApplyRequest, WorkProduct } from "@claudexor/schema";
import { sha256 } from "@claudexor/util";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import {
  handleRunApplyRoutes,
  type RunApplyRouteContext,
} from "../../control-api/src/run-apply-routes.js";
import { readExactRunPatch, runDeliverable } from "../../control-api/src/run-exact-patch.js";
import { createRetentionRunner } from "./retention-service.js";

it("replays the durable delivery receipt while HTTP Apply requires its retained patch", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "retention-apply-")));
  const before = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
  mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
  const sql = await sqlFixture(join(root, "sql"));
  try {
    const repo = join(root, "ephemeral");
    mkdirSync(repo);
    const params = {
      mode: "ask",
      prompt: "Retained evidence",
      scope: { kind: "project", root: repo, ephemeral: true },
    };
    const source = new ArtifactStore(repo).createRun("source");
    const patch =
      "diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+answer\n";
    writeFileSync(join(source.finalDir, "patch.diff"), patch);
    writeFileSync(
      join(source.finalDir, "work_product.yaml"),
      JSON.stringify(
        WorkProduct.parse({
          id: "wp-source",
          kind: "patch",
          source_task_id: "task-source",
          files: { patch: "final/patch.diff" },
          meta: { result_kind: "patch", lifecycle: "succeeded", apply_state: "applied" },
        }),
      ),
    );
    const commands = sql.graph.commands.current();
    commands.accept({
      id: "source-job",
      params,
      idempotencyKey: "source-job",
      clientId: "fixture",
    });
    commands.update("source-job", {
      state: "succeeded",
      runId: "source",
      runDir: source.root,
      finishedAt: "2020-01-01T00:00:00.000Z",
    });
    const body = ControlApplyRequest.parse({ mode: "apply", target: { kind: "original_project" } });
    const input = {
      key: "same-apply",
      client: "control-api",
      operation: "run.apply",
      request: { runId: "source", body, patchSha256: sha256(patch), repoRoot: repo },
    };
    const delivery = sql.graph.commands.beginDelivery(params, input);
    const saved = {
      mode: "apply",
      applied: true,
      alreadyApplied: true,
      detail: "saved delivery receipt",
      finalVerify: { attempted: false, duration_ms: 0 },
      targetPreimageSha: "fixture-preimage",
    };
    sql.graph.commands.completeDelivery(delivery.id, saved);
    let beginCalls = 0;
    const route = async () => {
      let response: { status: number; payload?: unknown; message?: string } | undefined;
      const ctx: RunApplyRouteContext = {
        services: {
          beginDelivery: async (params, value) => {
            beginCalls++;
            return sql.graph.commands.beginDelivery(params, value);
          },
          completeDelivery: async (id, value) => {
            sql.graph.commands.completeDelivery(id, value);
          },
          failDelivery: async (id, error) => {
            sql.graph.commands.failDelivery(id, error);
          },
        },
        findRun: async () => sql.graph.commands.queries.getByRunId("source") ?? null,
        readBody: async () => body,
        json: (_res, status, payload) => {
          response = { status, payload };
        },
        requestError: (_res, error) => {
          const failure = error as Error & { status?: number };
          response = { status: failure.status ?? 500, message: failure.message };
        },
        readPatch: (record) => readExactRunPatch(record, repo),
        readDeliverable: (record) => runDeliverable(record, repo),
        projectRoot: () => repo,
        targetRoot: () => repo,
        gateError: () => null,
        gateSpecs: () => [],
        chainMutation: async (_record, work) => work(),
        appendAudit: () => {},
        markApplied: () => {},
        deliveredApplyState: () => "applied",
      };
      expect(
        await handleRunApplyRoutes(
          ctx,
          "POST",
          "/runs/source/apply",
          { headers: { "idempotency-key": "same-apply" } } as unknown as IncomingMessage,
          {} as ServerResponse,
        ),
      ).toBe(true);
      return response;
    };
    expect(await route()).toMatchObject({ status: 200, payload: saved });
    const gc = createRetentionRunner({
      projects: () => sql.graph.projects,
      threads: sql.graph.threads,
      daemonJobs: () => [],
      purgeThread: async () => {},
      hasPurgeLeftovers: () => false,
    });
    const receipt = await gc({ dry_run: false });
    expect(receipt.errors).toEqual([]);
    expect(receipt.deleted_runs.map((run) => run.run_id)).toEqual(["source"]);
    expect(await route()).toEqual({ status: 404, message: "no patch artifact for this run" });
    expect(beginCalls).toBe(1);
    expect(sql.graph.commands.beginDelivery(params, input)).toMatchObject({
      reused: true,
      result: saved,
    });
  } finally {
    await sql.close();
    if (before === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = before;
    rmSync(root, { recursive: true, force: true });
  }
});
