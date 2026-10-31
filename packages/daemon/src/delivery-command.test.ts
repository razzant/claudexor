import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setGlobalGenerationInTx } from "./store/generations.js";
import { createPartition } from "./store/partitions.js";
import { createSqlDaemonServices } from "./store/sql-daemon-services.js";
import { EngineStore } from "./store/store.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe("the durable delivery journal over the SQL store", () => {
  it("keeps a refusal's code, recovery actions and context, so a replay answers the same", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "delivery-journal-")));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const store = await EngineStore.open({
      daemonDir: root,
      workerEntry: resolve(import.meta.dirname, "../dist/store/flusher-worker.js"),
    });
    cleanups.push(() => store.close());
    store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
    const graph = createSqlDaemonServices(store, { purgeFiles: async () => [root] });
    cleanups.push(() => graph.close());
    const params = { prompt: "p", mode: "agent", scope: { kind: "none" } };
    const input = {
      key: "apply-1",
      client: "control-api",
      operation: "run.apply",
      request: { body: { mode: "apply" } },
    };
    const begun = graph.commands.beginDelivery(params, input);
    expect(begun).toMatchObject({ reused: false, state: "running" });
    const action = "Fix the cause, then revert the run with the revert_run decision";
    const context = { treeMutated: true, paths: ["new.weird"], pathCount: 1 };
    graph.commands.failDelivery(
      begun.id,
      Object.assign(new Error("the write could not be taken back"), {
        status: 409,
        code: "git_failed",
        requiredActions: [action],
        context,
      }),
    );
    expect(graph.commands.beginDelivery(params, input)).toMatchObject({
      reused: true,
      state: "failed",
      error: "the write could not be taken back",
      errorCode: "git_failed",
      errorRequiredActions: [action],
      errorContext: context,
      result: { status: 409, code: "git_failed" },
    });
  });
});
