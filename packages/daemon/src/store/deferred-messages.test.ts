import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("@claudexor/schema", () => import("../../../schema/src/index.js"));
import {
  ControlRunStartRequest,
  makeOutcomeFacts,
  RunFacts,
  SCHEMA_VERSION,
} from "@claudexor/schema";
import { EngineStore } from "./store.js";
import { BlobFiles } from "./blob-files.js";
import { createPartition } from "./partitions.js";
import { setGlobalGenerationInTx, setGenerationStatusInTx } from "./generations.js";
import { SqlCommandStore } from "./commands.js";
import { SqlCommandPruner } from "./command-prune.js";
import { SqlTerminalFiles } from "./terminal-files.js";
import { Obligations } from "./obligations.js";
import { SqlDeferredMessages } from "./deferred-messages.js";
import { runMutation } from "./mutation.js";
import { applyTerminalInTx } from "./run-events.js";
import { SqlCommandQueries } from "./command-queries.js";
import { DaemonServer } from "../server.js";
import { diskRetentionReferences } from "./retention-references.js";
import { validateDeferredMessages } from "./deferred-message-rows.js";
import { SqlResourceStore } from "./resources.js";
import { chunks } from "./test-support/resource-fixture.js";
import { assertDeferredOperator } from "../deferred-message-owner.js";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";

const cleanup: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-deferred-")));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
  });
  cleanup.push(() => store.close());
  const generation = store.transaction(() => {
    const g = createPartition(store, "global");
    setGlobalGenerationInTx(store, g.pid);
    return g;
  });
  const blobs = new BlobFiles(store),
    obligations = new Obligations(store);
  const pruner = new SqlCommandPruner(store, blobs);
  const commands = new SqlCommandStore(store, blobs, generation, {
    isLive: () => true,
    obligations,
    pruner,
    terminalFiles: new SqlTerminalFiles(store, obligations),
  });
  const resources = new SqlResourceStore(store, blobs, obligations);
  cleanup.push(() => resources.drainCleanup());
  const drafts = new SqlDeferredMessages(store, blobs, generation, commands, (refs) => {
    resources.resolve(refs);
  });
  const start = ControlRunStartRequest.parse({ mode: "ask", prompt: "first" });
  commands.accept({ id: "job-1", params: start, clientId: "test", idempotencyKey: "first" });
  const create = () =>
    drafts.mutate(
      { action: "create", predecessorId: "job-1", prompt: "verify", attachments: [] },
      "create",
      start,
    );
  const settle = () => {
    const facts = RunFacts.parse({
      schema_version: SCHEMA_VERSION,
      run_id: "run-1",
      task_id: "task-1",
      mode: "ask",
      outcome: {
        ...makeOutcomeFacts("succeeded"),
        review_requested: false,
        work_state: { state: "completed", source: "constrained" },
      },
      deliverable: { present: true, kind: "answer", path: "final/answer.md" },
      presentation: { state: "ready", primary: { kind: "answer", path: "final/answer.md" } },
      participants: { planners: 0, attempts: [] },
      gates: { configured: false, required: 0, total: 0, executed: false, state: "not_configured" },
      review: { state: "not_run", blockers: 0, blocker_ids: [] },
      apply: { eligibility: null },
      required_actions: [],
      generated_at: new Date().toISOString(),
    });
    commands.update("job-1", {
      state: "succeeded",
      runId: "run-1",
      taskId: "task-1",
      runDir: root,
      finishedAt: new Date().toISOString(),
    });
    runMutation(store, (tx) =>
      applyTerminalInTx(tx, generation.pid, {
        run_id: "run-1",
        task_id: "task-1",
        seq: 1,
        ts: new Date().toISOString(),
        type: "run.completed",
        payload: { run_facts: facts, facts: facts.outcome, lifecycle: "succeeded", reason: null },
      }),
    );
  };
  return { store, blobs, drafts, commands, generation, start, create, settle, pruner, resources };
}

describe("SQL reserved deferred message", () => {
  it("replays before CAS, rejects key/body mismatch and leaves immutable command params intact", async () => {
    const f = await fixture();
    const first = f.create();
    const edit = {
      action: "replace" as const,
      draftId: first.draft.draftId,
      expectedRevision: 1,
      prompt: "second",
      attachments: [],
    };
    expect(f.drafts.mutate(edit, "edit").appliedRevision).toBe(2);
    expect(f.drafts.mutate(edit, "edit").appliedRevision).toBe(2);
    expect(() => f.drafts.mutate({ ...edit, prompt: "different" }, "edit")).toThrow(
      /different request/,
    );
    expect(() => f.drafts.mutate(edit, "new-key")).toThrow(/revision/);
    expect(f.commands.get("job-1")?.params).toEqual(f.start);
    expect(f.create().appliedRevision).toBe(1);
    expect(f.create().draft.revision).toBe(2);
  });
  it("canonicalizes job/run aliases into one slot", async () => {
    const f = await fixture();
    f.commands.update("job-1", { runId: "run-1" });
    f.create();
    expect(() =>
      f.drafts.mutate(
        { action: "create", predecessorId: "run-1", prompt: "other", attachments: [] },
        "other",
        f.start,
      ),
    ).toThrow(/reserved/);
    expect(f.drafts.reservation("run-1")?.predecessorJobId).toBe("job-1");
  });
  it("reads slots through a job or run alias without hydrating the predecessor command", async () => {
    const f = await fixture();
    f.commands.update("job-1", { runId: "run-1" });
    const hydrated = vi.spyOn(f.commands, "get");
    const bodies = vi.spyOn(f.blobs, "read");
    expect(f.drafts.reservation("run-1")).toBeNull();
    expect(f.drafts.latest("job-1")).toBeNull();
    expect(f.drafts.latest("unknown")).toBeNull();
    expect(hydrated).not.toHaveBeenCalled();
    expect(bodies).not.toHaveBeenCalled();
    const draft = f.create().draft;
    hydrated.mockClear();
    bodies.mockClear();
    expect(f.drafts.reservation("run-1")).toMatchObject({
      draftId: draft.draftId,
      predecessorJobId: "job-1",
      predecessorRunId: "run-1",
    });
    expect(f.drafts.latest("job-1")?.draftId).toBe(draft.draftId);
    expect(hydrated).not.toHaveBeenCalled();
    expect(bodies).not.toHaveBeenCalled();
  });
  it("clear targets draft identity, permits a new draft and cannot cancel its replacement", async () => {
    const f = await fixture();
    const first = f.create().draft;
    const clear = { action: "clear" as const, draftId: first.draftId, expectedRevision: 1 };
    expect(f.drafts.mutate(clear, "clear").draft.state).toBe("cleared");
    const next = f.drafts.mutate(
      { action: "create", predecessorId: "job-1", prompt: "new", attachments: [] },
      "new",
      f.start,
    ).draft;
    expect(f.drafts.mutate(clear, "clear").draft.draftId).toBe(first.draftId);
    expect(f.drafts.reservation("job-1")?.draftId).toBe(next.draftId);
    expect(f.commands.get("job-1")?.state).toBe("queued");
  });
  it("never dispatches live work or accepts a stale prepared revision", async () => {
    const f = await fixture();
    const draft = f.create().draft;
    expect(
      f.drafts.promote(
        draft.draftId,
        1,
        f.drafts.request(draft.draftId),
        () => null,
        () => {},
      ).record,
    ).toBeNull();
    f.settle();
    f.drafts.mutate(
      {
        action: "replace",
        draftId: draft.draftId,
        expectedRevision: 1,
        prompt: "changed",
        attachments: [],
      },
      "edit",
    );
    expect(() =>
      f.drafts.promote(
        draft.draftId,
        1,
        f.start,
        () => null,
        () => {},
      ),
    ).toThrow(/revision/);
  });
  it("freezes and accepts once; replay survives changed admission and revision", async () => {
    const f = await fixture();
    const draft = f.create().draft;
    f.settle();
    const promoted = f.drafts.promote(
      draft.draftId,
      1,
      f.drafts.request(draft.draftId),
      () => null,
      () => {},
    );
    expect(promoted.draft.state).toBe("dispatched");
    expect(promoted.record?.params).toMatchObject({ continueFrom: "run-1", prompt: "verify" });
    const replay = f.drafts.promote(
      draft.draftId,
      99,
      f.start,
      () => ({ code: "shutdown" }),
      () => {
        throw new Error("refused now");
      },
    );
    expect(replay.record?.id).toBe(promoted.record?.id);
    expect(replay.reused).toBe(true);
    expect(() =>
      f.drafts.mutate({ action: "clear", draftId: draft.draftId, expectedRevision: 1 }, "clear"),
    ).toThrow(/dispatched/);
  });
  it("rolls back acceptance if freeze fails, and recovers a committed notification failure", async () => {
    const f = await fixture();
    const draft = f.create().draft;
    f.settle();
    f.store.exec(
      "CREATE TEMP TRIGGER fail_freeze BEFORE UPDATE OF successor_job_id ON deferred_message BEGIN SELECT RAISE(ABORT,'freeze failed'); END",
    );
    expect(() =>
      f.drafts.promote(
        draft.draftId,
        1,
        f.drafts.request(draft.draftId),
        () => null,
        () => {},
      ),
    ).toThrow();
    expect(f.store.prepare("SELECT count(*) n FROM command").get()).toMatchObject({ n: 1 });
    expect(f.drafts.get(draft.draftId)?.state).toBe("waiting");
    f.store.exec("DROP TRIGGER fail_freeze");
    const accept = f.commands.acceptInTx.bind(f.commands);
    vi.spyOn(f.commands, "acceptInTx").mockImplementation((tx, prepared) => {
      const result = accept(tx, prepared);
      tx.changes.afterCommit(() => {
        throw new Error("lost reply");
      });
      return result;
    });
    expect(() =>
      f.drafts.promote(
        draft.draftId,
        1,
        f.drafts.request(draft.draftId),
        () => null,
        () => {},
      ),
    ).toThrow(/committed/);
    expect(f.drafts.get(draft.draftId)?.state).toBe("dispatched");
    expect(
      f.drafts.promote(
        draft.draftId,
        1,
        f.start,
        () => null,
        () => {},
      ).reused,
    ).toBe(true);
  });
  it("holds failed admission, late Stop and restart without rearming on edit", async () => {
    const f = await fixture();
    const draft = f.create().draft;
    f.settle();
    const out = f.drafts.promote(
      draft.draftId,
      1,
      f.drafts.request(draft.draftId),
      () => ({ code: "stop_requested" }),
      () => {},
    );
    expect(out.draft.hold?.code).toBe("stop_requested");
    expect(
      f.drafts.mutate(
        {
          action: "replace",
          draftId: draft.draftId,
          expectedRevision: 1,
          prompt: "edited held",
          attachments: [],
        },
        "edit",
      ).draft.state,
    ).toBe("held");
    f.drafts.recoverAfterStartup();
    expect(f.drafts.get(draft.draftId)?.state).toBe("held");
    expect(
      f.drafts.promote(
        draft.draftId,
        2,
        f.start,
        () => null,
        () => {},
      ).record,
    ).toBeNull();
  });
  it("retains exact draft dependencies and refuses a retired generation", async () => {
    const f = await fixture();
    const draft = f.create().draft;
    f.settle();
    f.pruner.prune(["job-1"]);
    expect(f.commands.get("job-1")).toBeDefined();
    f.store.transaction(() => setGenerationStatusInTx(f.store, f.generation.pid, "archived"));
    const held = f.drafts.promote(
      draft.draftId,
      1,
      f.drafts.request(draft.draftId),
      () => null,
      () => {},
    );
    expect(held.record).toBeNull();
    expect(held.draft.hold?.code).toBe("partition_retired");
  });
  it("blocks every ordinary continuation at central admission while exact command replays work", async () => {
    const f = await fixture();
    f.create();
    f.settle();
    const server = new DaemonServer({
      socketPath: "unused",
      token: "test",
      runner: async () => ({}),
      commands: {
        current: () => f.commands,
        forRequest: () => f.commands,
        findById: () => f.commands,
        deferredFor: () => f.drafts,
        queries: new SqlCommandQueries(f.store, f.blobs),
        pruneHistory: f.pruner.pruneHistory.bind(f.pruner),
      },
    });
    cleanup.push(() => server.stop());
    await expect(
      server.dispatch("claudexor.enqueue", {
        request: { ...f.start, continueFrom: "run-1" },
        clientId: "test",
        idempotencyKey: "new",
      }),
    ).rejects.toMatchObject({ code: "continuation_reserved" });
    await expect(
      server.dispatch("claudexor.enqueue", {
        request: f.start,
        clientId: "test",
        idempotencyKey: "first",
      }),
    ).resolves.toMatchObject({ id: "job-1", reused: true });
  });
  it("retains predecessor files on held drafts and releases body ownership atomically on clear", async () => {
    const f = await fixture();
    const draft = f.create().draft;
    f.settle();
    f.drafts.hold(draft.draftId, { code: "stop_requested" });
    const proof = await diskRetentionReferences(f.store);
    expect(proof.referencedRunIds.has("run-1")).toBe(true);
    expect(proof.recheck?.()).toBe(true);
    proof.close?.();
    const body = f.store
      .prepare("SELECT body_sha FROM deferred_message WHERE id=?")
      .get(draft.draftId) as { body_sha: string };
    expect(f.store.prepare("SELECT 1 FROM blob WHERE sha256=?").get(body.body_sha)).toBeDefined();
    f.drafts.mutate({ action: "clear", draftId: draft.draftId, expectedRevision: 1 }, "clear");
    expect(f.store.prepare("SELECT 1 FROM blob WHERE sha256=?").get(body.body_sha)).toBeUndefined();
    f.pruner.prune(["job-1"]);
    expect(f.drafts.get(draft.draftId)).toBeNull();
    expect(
      f.store.prepare("SELECT 1 FROM idempotency WHERE owner='deferred_message'").get(),
    ).toBeUndefined();
  });
  it("rechecks resource purpose and exact bytes and replaces the complete reference list", async () => {
    const f = await fixture();
    const draft = f.create().draft;
    const upload = f.resources.create(
      { kind: "file", mime: "text/plain", name: "evidence.txt", sizeBytes: 4 },
      "upload",
    );
    await f.resources.write(upload.uploadId, chunks("test"));
    const resource = f.resources.finalize(upload.uploadId, undefined, "finalize");
    const edit = {
      action: "replace" as const,
      draftId: draft.draftId,
      expectedRevision: 1,
      prompt: "check attached evidence",
      attachments: [{ resourceId: resource.resourceId }],
    };
    f.drafts.mutate(edit, "attach");
    expect(f.drafts.get(draft.draftId)?.attachments).toEqual(edit.attachments);
    f.drafts.mutate({ ...edit, expectedRevision: 2, attachments: [] }, "remove");
    expect(f.drafts.get(draft.draftId)?.attachments).toEqual([]);
    const model = f.resources.publishModel(Buffer.from("{}"));
    expect(() =>
      f.drafts.mutate(
        { ...edit, expectedRevision: 3, attachments: [{ resourceId: model.resourceId }] },
        "wrong-purpose",
      ),
    ).toThrow(expect.objectContaining({ code: "resource_purpose_mismatch" }));
    const fs = await import("node:fs");
    fs.writeFileSync(f.blobs.filePath(resource.sha256.replace("sha256:", "")), "evil");
    expect(() => f.drafts.mutate({ ...edit, expectedRevision: 3 }, "bad-digest")).toThrow(
      expect.objectContaining({ code: "resource_digest_mismatch" }),
    );
    // Original body/key replays ignore mutable resource failures and stale CAS.
    expect(f.drafts.mutate(edit, "attach").appliedRevision).toBe(2);
  });
  it("startup holds waiting work and retains the exact accepted successor without relaunch", async () => {
    const f = await fixture();
    const draft = f.create().draft;
    const reopened = new SqlDeferredMessages(f.store, f.blobs, f.generation, f.commands);
    reopened.recoverAfterStartup();
    expect(reopened.get(draft.draftId)?.hold?.code).toBe("restart_requires_controller");
    reopened.mutate({ action: "clear", draftId: draft.draftId, expectedRevision: 1 }, "clear");
    const next = reopened.mutate(
      { action: "create", predecessorId: "job-1", prompt: "next", attachments: [] },
      "next",
      f.start,
    ).draft;
    f.settle();
    const accepted = reopened.promote(
      next.draftId,
      1,
      reopened.request(next.draftId),
      () => null,
      () => {},
    );
    f.commands.recoverAfterStartup();
    reopened.recoverAfterStartup();
    expect(reopened.get(next.draftId)?.successorJobId).toBe(accepted.record?.id);
    expect(accepted.record && f.commands.get(accepted.record.id)?.state).toBe("interrupted");
    expect(reopened.get(next.draftId)?.state).toBe("dispatched");
    validateDeferredMessages(f.store, f.blobs, f.generation.pid);
  });
  it("confines deferred work to the operator and refuses engine Delegate child targets", async () => {
    const f = await fixture();
    expect(() => assertDeferredOperator(true)).toThrow(
      expect.objectContaining({ code: "delegation_forbidden", status: 403 }),
    );
    const child = { ...f.start, parentRunId: "parent", delegatedFromRunId: "parent" };
    f.commands.accept({ id: "child", params: child, clientId: "test", idempotencyKey: "child" });
    expect(() =>
      f.drafts.mutate(
        { action: "create", predecessorId: "child", prompt: "post-parent work", attachments: [] },
        "child-draft",
        f.start,
      ),
    ).toThrow(expect.objectContaining({ code: "delegation_forbidden", status: 403 }));
    // Caller-owned external workspaces are ordinary operator-owned one-shots,
    // distinct from server-owned Delegate child lineage.
    expect(() =>
      assertDeferredOperator(false, {
        ...f.start,
        execution: { isolation: "live", delegated: true },
      }),
    ).not.toThrow();
    const first = f.create();
    vi.spyOn(f.commands, "get").mockImplementation(() => {
      throw new Error("later admission unavailable");
    });
    expect(f.create().appliedRevision).toBe(first.appliedRevision);
  });
  it("native HTTP429 willRetry progress is not terminal authority", async () => {
    const f = await fixture();
    const draft = f.create().draft;
    f.commands.update("job-1", {
      state: "running",
      result: { error: { status: 429, willRetry: true } },
    });
    expect(
      f.drafts.promote(
        draft.draftId,
        1,
        f.drafts.request(draft.draftId),
        () => null,
        () => {},
      ).draft.state,
    ).toBe("waiting");
    f.commands.update("job-1", {
      state: "failed",
      finishedAt: new Date().toISOString(),
      result: { lifecycle: "failed", error: { status: 429, willRetry: false } },
    });
    expect(
      f.drafts.promote(
        draft.draftId,
        1,
        f.drafts.request(draft.draftId),
        () => null,
        () => {},
      ).draft.hold?.code,
    ).toBe("predecessor_failed");
  });
  it("holds typed current admission refusals with no retry after restoration or held edit", async () => {
    const f = await fixture();
    const draft = f.create().draft;
    f.settle();
    const admission = vi.fn(() => {
      throw Object.assign(new Error("profile disabled"), {
        code: "credential_profile_disabled",
        requiredActions: ["Inspect the selected profile."],
        retryable: false,
      });
    });
    const result = f.drafts.promote(
      draft.draftId,
      1,
      f.drafts.request(draft.draftId),
      () => null,
      admission,
    );
    expect(result.draft.hold).toMatchObject({
      code: "admission_refused",
      problem: {
        code: "credential_profile_disabled",
        message: "profile disabled",
        required_actions: ["Inspect the selected profile."],
      },
    });
    f.drafts.mutate(
      {
        action: "replace",
        draftId: draft.draftId,
        expectedRevision: 1,
        prompt: "edited",
        attachments: [],
      },
      "edit",
    );
    const restored = vi.fn();
    expect(
      f.drafts.promote(draft.draftId, 2, f.drafts.request(draft.draftId), () => null, restored)
        .record,
    ).toBeNull();
    expect(admission).toHaveBeenCalledOnce();
    expect(restored).not.toHaveBeenCalled();
  });
  it("linearizes clear before a prepared dispatch and retains large addressed content", async () => {
    const f = await fixture();
    const draft = f.create().draft;
    const text = "Verify the retained result. ".repeat(4000);
    f.drafts.mutate(
      {
        action: "replace",
        draftId: draft.draftId,
        expectedRevision: 1,
        prompt: text,
        attachments: [],
      },
      "large",
    );
    expect(f.drafts.get(draft.draftId)?.prompt).toBe(text);
    f.settle();
    const prepared = f.drafts.request(draft.draftId);
    f.drafts.mutate({ action: "clear", draftId: draft.draftId, expectedRevision: 2 }, "clear");
    expect(() =>
      f.drafts.promote(
        draft.draftId,
        2,
        prepared,
        () => null,
        () => {},
      ),
    ).toThrow(
      expect.objectContaining({
        code: "draft_revision_conflict",
        context: expect.objectContaining({ state: "cleared" }),
      }),
    );
    expect(f.store.prepare("SELECT count(*) n FROM command").get()).toMatchObject({ n: 1 });
  });
  it("returns typed thread and unsupported-shape refusals without creating reservations", async () => {
    const f = await fixture();
    for (const [id, params, code] of [
      ["thread", { ...f.start, threadId: "thread-1" }, "use_thread_turn"],
      ["plan", { ...f.start, mode: "plan" }, "continue_from_unsupported"],
      ["race", { ...f.start, mode: "agent", n: 2 }, "continue_from_unsupported"],
    ] as const) {
      f.commands.accept({ id, params, clientId: "test", idempotencyKey: id });
      expect(() =>
        f.drafts.mutate(
          { action: "create", predecessorId: id, prompt: "next", attachments: [] },
          `draft-${id}`,
          f.start,
        ),
      ).toThrow(expect.objectContaining({ code }));
      expect(f.drafts.reservation(id)).toBeNull();
    }
    expect(() =>
      f.drafts.mutate(
        { action: "create", predecessorId: "job-1", prompt: "next", attachments: [] },
        "hidden-authority",
        { ...f.start, delegatedFromRunId: "parent" },
      ),
    ).toThrow(expect.objectContaining({ code: "draft_controls_invalid" }));
  });
});
