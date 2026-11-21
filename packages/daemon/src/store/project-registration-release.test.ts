import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ControlRunStartRequest } from "@claudexor/schema";
import { BlobFiles } from "./blob-files.js";
import {
  requireServedGeneration,
  setGenerationStatusInTx,
  setGlobalGenerationInTx,
} from "./generations.js";
import { createPartition, type PartitionGeneration } from "./partitions.js";
import { Obligations } from "./obligations.js";
import { SqlCommandPruner } from "./command-prune.js";
import { SqlCommandStore } from "./commands.js";
import { SqlDeferredMessages } from "./deferred-messages.js";
import { SqlProjectRouter } from "./project-router.js";
import { SqlProjectStore } from "./projects.js";
import { SqlResourceStore } from "./resources.js";
import { SqlTerminalFiles } from "./terminal-files.js";
import { EngineStore } from "./store.js";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";

// Paired custody (engine side): the opt-in registration receipt, the bound
// address probe with the one folder comparison, and the confirming side's
// single bound release with the pid fences, the recorded-folder fences
// (execution workspace, one-off scope, served reserved slots, unknown holds)
// and the standard thread fence. Every directory, command and thread here is
// synthetic and stays inside this test's own store.

let root: string,
  store: EngineStore,
  blobs: BlobFiles,
  obligations: Obligations,
  sql: SqlProjectStore,
  router: SqlProjectRouter;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-paired-projects-")));
  store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
  });
  obligations = new Obligations(store);
  store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  blobs = new BlobFiles(store);
  sql = new SqlProjectStore(store, blobs, obligations);
  router = new SqlProjectRouter(sql);
});
afterEachClosed(async () => {
  obligations?.close();
  await store?.close();
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
});

function path(name: string): string {
  const value = join(root, name);
  mkdirSync(value, { recursive: true });
  return value;
}

function register(name: string, key: string) {
  return sql.register({ root: path(name), idempotencyKey: key, clientId: "test", includeStoreId: true });
}

function refusalOf(action: () => unknown): { code: string; status: number } {
  try {
    action();
  } catch (error) {
    const typed = error as { code?: string; status?: number };
    return { code: typed.code ?? "", status: typed.status ?? 0 };
  }
  throw new Error("expected a typed refusal");
}

function journal(): Array<{ type: string }> {
  return store
    .prepare(
      "SELECT type FROM event WHERE type IN ('project.registered','project.unregistered') ORDER BY pid, seq",
    )
    .all() as Array<{ type: string }>;
}

/** A real command store on one registration's journal partition. */
function commandsOf(projectId: string): SqlCommandStore {
  const partition = sql.partition(projectId);
  if (!partition) throw new Error("registered project has no generation");
  return commandsOn(requireServedGeneration(store, partition.pid));
}

/** A real command store on the no-project partition, where one-off requests
 * (`scope.ephemeral`) and their reserved drafts live. */
function oneOffCommands(): SqlCommandStore {
  return commandsOn(sql.global());
}

function commandsOn(generation: PartitionGeneration): SqlCommandStore {
  return new SqlCommandStore(store, blobs, generation, {
    isLive: () => true,
    obligations,
    pruner: new SqlCommandPruner(store, blobs),
    terminalFiles: new SqlTerminalFiles(store, obligations),
  });
}

/** The reserved-slot owner of one generation, wired like the daemon's. */
function draftsOf(commands: SqlCommandStore): SqlDeferredMessages {
  const resources = new SqlResourceStore(store, blobs, obligations);
  return new SqlDeferredMessages(store, blobs, commands.generation, commands, (refs) => {
    resources.resolve(refs);
  });
}

/** One accepted synthetic start in a chosen generation, with a chosen
 * recorded execution workspace (the only string the release fence compares). */
function liveWorkspaceCommand(commands: SqlCommandStore, id: string, workspace?: string) {
  commands.accept({
    id,
    clientId: "test",
    idempotencyKey: id,
    params: {
      mode: "ask",
      prompt: "busy",
      ...(workspace === undefined ? {} : { execution: { delegated: true, workspaceRoot: workspace } }),
    },
  });
}

/** One accepted synthetic one-off request: its declared one-shot scope is the
 * only folder fact it records — no separate execution workspace. */
function oneOffCommand(commands: SqlCommandStore, id: string, folder: string): void {
  commands.accept({
    id,
    clientId: "test",
    idempotencyKey: id,
    params: {
      mode: "ask",
      prompt: "one-off",
      scope: { kind: "project", root: folder, ephemeral: true },
    },
  });
}

/** This harness's one poisoned read: the named draft body cannot answer, and
 * nothing else about the store changes — no row, file or digest is touched. */
class UnreadableBody extends BlobFiles {
  constructor(
    store: EngineStore,
    private readonly unreadable: string,
  ) {
    super(store);
  }
  override read(sha256: string): Buffer {
    if (sha256 === this.unreadable) throw new Error("this test's body read is unavailable");
    return super.read(sha256);
  }
}

describe("paired project registration (engine side)", () => {
  it("answers the durable store identity only on the opt-in, and never reuses an id", () => {
    const dir = path("project");
    const plain = sql.register({ root: dir, idempotencyKey: "plain", clientId: "test" });
    expect(plain.created).toBe(true);
    expect("storeId" in plain).toBe(false);
    const optIn = sql.register({
      root: dir,
      idempotencyKey: "opt",
      clientId: "test",
      includeStoreId: true,
    });
    expect(optIn.created).toBe(false);
    expect(optIn.project.id).toBe(plain.project.id);
    expect(optIn.storeId).toBe(store.storeId);
    // A key replay keeps its own creation provenance; the id stays one.
    expect(
      sql.register({ root: dir, idempotencyKey: "plain", clientId: "test", includeStoreId: true })
        .created,
    ).toBe(true);
    expect(
      sql.register({ root: dir, idempotencyKey: "opt", clientId: "test", includeStoreId: true })
        .project.id,
    ).toBe(plain.project.id);
  });

  it("keeps the legacy replay answer, but a store-identity key refuses a moved root", () => {
    const first = register("a", "key");
    const id = first.project.id;
    sql.relink(id, path("b"));
    expect(
      refusalOf(() =>
        sql.register({
          root: join(root, "a"),
          idempotencyKey: "key",
          clientId: "test",
          includeStoreId: true,
        }),
      ),
    ).toEqual({ code: "project_root_mismatch", status: 409 });
    const legacy = sql.register({ root: join(root, "a"), idempotencyKey: "key", clientId: "test" });
    expect(legacy.project.id).toBe(id);
    expect(legacy.project.root).toBe(join(root, "b"));
  });

  it("probes the bound registration without ever leaking another record's state", () => {
    const { project, storeId } = register("one", "probe");
    const binding = { expectedStoreId: storeId!, expectedRoot: project.root };
    expect(sql.inspectRegistration(project.id, binding)).toEqual({
      projectId: project.id,
      storeId,
      root: project.root,
      state: "present",
    });
    expect(
      refusalOf(() => sql.inspectRegistration(project.id, { ...binding, expectedStoreId: "0000" })),
    ).toEqual({ code: "store_mismatch", status: 409 });
    expect(
      refusalOf(() =>
        sql.inspectRegistration(project.id, { ...binding, expectedRoot: join(root, "b") }),
      ),
    ).toEqual({ code: "project_root_mismatch", status: 409 });
    expect(sql.inspectRegistration("prj-unknown", binding)).toEqual({
      projectId: "prj-unknown",
      storeId,
      root: project.root,
      state: "absent",
    });
    expect(store.prepare("SELECT status FROM project WHERE id=?").get(project.id)).toEqual({
      status: "active",
    });
    expect(journal()).toEqual([{ type: "project.registered" }]);
  });

  it("answers the one folder comparison for the already-admitted candidate", () => {
    const { project, storeId } = register("origin", "compare");
    const binding = { expectedStoreId: storeId!, expectedRoot: project.root };
    const probe = (candidate?: string) =>
      sql.inspectRegistration(project.id, binding, candidate);
    // The exact recorded spelling, and a symlink alias of the same folder: same.
    expect(probe(project.root)).toEqual({
      projectId: project.id,
      storeId,
      root: project.root,
      state: "present",
      candidateMatch: "same",
    });
    const alias = join(root, "origin-alias");
    symlinkSync(project.root, alias);
    expect(probe(alias).candidateMatch).toBe("same");
    // A really different directory: different, proven by the objects' identity.
    expect(probe(path("other")).candidateMatch).toBe("different");
    // A candidate that is no longer a directory carries no directory identity.
    const file = join(root, "plain.txt");
    writeFileSync(file, "not a folder\n");
    expect(probe(file).candidateMatch).toBe("unknown");
    // An undecidable candidate is unknown, never different.
    expect(probe(join(root, "vanished")).candidateMatch).toBe("unknown");
    // The registered folder moved and its old path relaid to it: still one folder.
    const moved = join(root, "origin-moved");
    renameSync(project.root, moved);
    symlinkSync(moved, project.root);
    expect(probe(moved).candidateMatch).toBe("same");
    expect(probe(alias).candidateMatch).toBe("same");
    // Without a candidate the answer keeps its plain shape.
    expect("candidateMatch" in probe()).toBe(false);
  });

  it("releases exactly once, repeats answer absent, and never reuses the released id", () => {
    const dir = path("one");
    writeFileSync(join(dir, "sentinel.txt"), "fixture\n");
    const { project, storeId } = register("one", "release");
    const binding = { expectedStoreId: storeId!, expectedRoot: project.root };
    expect(sql.release(project.id, binding)).toEqual({
      projectId: project.id,
      storeId,
      root: project.root,
      state: "released",
    });
    expect(sql.release(project.id, binding)).toEqual({
      projectId: project.id,
      storeId,
      root: project.root,
      state: "absent",
    });
    expect(sql.inspectRegistration(project.id, binding).state).toBe("absent");
    expect(store.prepare("SELECT status FROM project WHERE id=?").get(project.id)).toEqual({
      status: "archived",
    });
    expect(journal()).toEqual([
      { type: "project.registered" },
      { type: "project.unregistered" },
    ]);
    // Release never deletes a file, and the released id is never handed out again.
    expect(readFileSync(join(dir, "sentinel.txt"), "utf8")).toBe("fixture\n");
    const again = sql.register({
      root: dir,
      idempotencyKey: "again",
      clientId: "test",
      includeStoreId: true,
    });
    expect(again.created).toBe(true);
    expect(again.project.id).not.toBe(project.id);
    expect(sql.inspectRegistration(project.id, binding).state).toBe("absent");
  });

  it("refuses release while the partition holds live work, whatever it names", () => {
    const { project, storeId } = register("one", "busy");
    const binding = { expectedStoreId: storeId!, expectedRoot: project.root };
    const commands = commandsOf(project.id);
    liveWorkspaceCommand(commands, "job-1", "/another-fs-domain/q");
    expect(refusalOf(() => sql.release(project.id, binding))).toEqual({
      code: "project_has_active_run",
      status: 409,
    });
    expect(store.prepare("SELECT status FROM project WHERE id=?").get(project.id)).toEqual({
      status: "active",
    });
    commands.update("job-1", { state: "succeeded", finishedAt: new Date().toISOString() });
    expect(sql.release(project.id, binding).state).toBe("released");
  });

  it("holds a registration whose folder another generation's live work executes in", () => {
    const p = register("one", "p");
    const r = register("two", "r");
    const rCommands = commandsOf(r.project.id);
    // A live command in R's generation whose recorded workspace IS P's folder,
    // spelled through a symlink: the workspace fence holds P's release.
    const alias = join(root, "one-alias");
    symlinkSync(p.project.root, alias);
    liveWorkspaceCommand(rCommands, "job-r", alias);
    expect(
      refusalOf(() =>
        sql.release(p.project.id, {
          expectedStoreId: p.storeId!,
          expectedRoot: p.project.root,
        }),
      ),
    ).toEqual({ code: "project_has_active_run", status: 409 });
    // A workspace proven to be another folder leaves P's release free.
    rCommands.update("job-r", { state: "succeeded", finishedAt: new Date().toISOString() });
    liveWorkspaceCommand(rCommands, "job-r2", r.project.root);
    expect(
      sql.release(p.project.id, {
        expectedStoreId: p.storeId!,
        expectedRoot: p.project.root,
      }).state,
    ).toBe("released");
    // R itself stays present and untouched.
    expect(
      sql.inspectRegistration(r.project.id, {
        expectedStoreId: r.storeId!,
        expectedRoot: r.project.root,
      }).state,
    ).toBe("present");
  });

  it("treats an undecidable workspace spelling as held, never as different", () => {
    const p = register("one", "p");
    const r = register("two", "r");
    const rCommands = commandsOf(r.project.id);
    liveWorkspaceCommand(rCommands, "job-u", join(root, "nowhere"));
    expect(
      refusalOf(() =>
        sql.release(p.project.id, {
          expectedStoreId: p.storeId!,
          expectedRoot: p.project.root,
        }),
      ).code,
    ).toBe("project_has_active_run");
    rCommands.update("job-u", { state: "succeeded", finishedAt: new Date().toISOString() });
    expect(
      sql.release(p.project.id, {
        expectedStoreId: p.storeId!,
        expectedRoot: p.project.root,
      }).state,
    ).toBe("released");
  });

  it("keeps a waiting reserved slot through an owner change, then releases once it clears", () => {
    const { project, storeId } = register("one", "draft");
    const binding = { expectedStoreId: storeId!, expectedRoot: project.root };
    const commands = commandsOf(project.id);
    commands.accept({
      id: "job-1",
      clientId: "test",
      idempotencyKey: "start",
      params: { mode: "ask", prompt: "first" },
    });
    const resources = new SqlResourceStore(store, blobs, obligations);
    const drafts = new SqlDeferredMessages(store, blobs, commands.generation, commands, (refs) => {
      resources.resolve(refs);
    });
    const receipt = drafts.mutate(
      { action: "create", predecessorId: "job-1", prompt: "next", attachments: [] },
      "create",
      ControlRunStartRequest.parse({ mode: "ask", prompt: "next" }),
    );
    expect(receipt.draft.state).toBe("waiting");
    const draftId = receipt.draft.draftId;
    expect(refusalOf(() => sql.release(project.id, binding))).toEqual({
      code: "project_has_active_run",
      status: 409,
    });
    // The slot is pid-keyed, so an owner change (a replace keeps the row) holds it too.
    drafts.mutate(
      {
        action: "replace",
        draftId,
        expectedRevision: 1,
        prompt: "next owner",
        attachments: [],
      },
      "replace",
    );
    expect(refusalOf(() => sql.release(project.id, binding))).toEqual({
      code: "project_has_active_run",
      status: 409,
    });
    drafts.mutate({ action: "clear", draftId, expectedRevision: 2 }, "clear");
    commands.update("job-1", { state: "succeeded", finishedAt: new Date().toISOString() });
    expect(sql.release(project.id, binding).state).toBe("released");
  });

  it("holds the folder a global one-off request declares, and releases once it finishes", () => {
    const { project, storeId } = register("one", "one-off");
    const binding = { expectedStoreId: storeId!, expectedRoot: project.root };
    // A no-project one-off request that names this folder and records no
    // separate execution workspace: its declared scope anchors the run here.
    const commands = oneOffCommands();
    oneOffCommand(commands, "job-off", project.root);
    expect(refusalOf(() => sql.release(project.id, binding))).toEqual({
      code: "project_has_active_run",
      status: 409,
    });
    // Accounting, not a lock: finishing the request frees the registration.
    commands.update("job-off", { state: "succeeded", finishedAt: new Date().toISOString() });
    expect(sql.release(project.id, binding).state).toBe("released");
  });

  it("keeps a NAMED project's scope out of the fence: only one-off roots anchor it", () => {
    const p = register("one", "p");
    const r = register("two", "r");
    // R's live work records a named scope spelling P's folder. A named scope is
    // a registry key, not an execution address: it never decides P's release.
    commandsOf(r.project.id).accept({
      id: "job-r",
      clientId: "test",
      idempotencyKey: "job-r",
      params: { mode: "ask", prompt: "named", scope: { kind: "project", root: p.project.root } },
    });
    expect(
      sql.release(p.project.id, {
        expectedStoreId: p.storeId!,
        expectedRoot: p.project.root,
      }).state,
    ).toBe("released");
  });

  it("counts a reserved one-off draft whose captured start records only its scope", () => {
    const { project, storeId } = register("one", "draft-one-off");
    const binding = { expectedStoreId: storeId!, expectedRoot: project.root };
    const commands = oneOffCommands();
    commands.accept({
      id: "job-off",
      clientId: "test",
      idempotencyKey: "job-off",
      params: { mode: "ask", prompt: "first" },
    });
    const drafts = draftsOf(commands);
    const draft = drafts.mutate(
      { action: "create", predecessorId: "job-off", prompt: "next", attachments: [] },
      "create",
      ControlRunStartRequest.parse({
        mode: "ask",
        prompt: "next",
        scope: { kind: "project", root: project.root, ephemeral: true },
      }),
    ).draft;
    expect(refusalOf(() => sql.release(project.id, binding))).toEqual({
      code: "project_has_active_run",
      status: 409,
    });
    drafts.mutate({ action: "clear", draftId: draft.draftId, expectedRevision: 1 }, "clear");
    expect(sql.release(project.id, binding).state).toBe("released");
  });

  it("counts a reserved slot only while its generation is served", () => {
    const p = register("one", "p");
    const r = register("two", "r");
    const commands = commandsOf(r.project.id);
    commands.accept({
      id: "job-r",
      clientId: "test",
      idempotencyKey: "job-r",
      params: { mode: "ask", prompt: "reserved" },
    });
    // R's reserved next job would start in P's folder.
    draftsOf(commands).mutate(
      { action: "create", predecessorId: "job-r", prompt: "next", attachments: [] },
      "create",
      ControlRunStartRequest.parse({
        mode: "ask",
        prompt: "next",
        scope: { kind: "project", root: r.project.root },
        execution: { delegated: true, isolation: "live", workspaceRoot: p.project.root },
      }),
    );
    const binding = { expectedStoreId: p.storeId!, expectedRoot: p.project.root };
    expect(refusalOf(() => sql.release(p.project.id, binding))).toEqual({
      code: "project_has_active_run",
      status: 409,
    });
    // A retired generation cannot dispatch, so its slot stops holding P.
    store.transaction(() => setGenerationStatusInTx(store, commands.generation.pid, "archived"));
    expect(sql.release(p.project.id, binding).state).toBe("released");
  });

  it("holds unknown recorded facts and invents no folder for them", () => {
    const a = register("one", "a");
    const b = register("two", "b");
    const commands = oneOffCommands();
    commands.accept({
      id: "job-off",
      clientId: "test",
      idempotencyKey: "job-off",
      params: { mode: "ask", prompt: "first" },
    });
    const drafts = draftsOf(commands);
    const draft = drafts.mutate(
      { action: "create", predecessorId: "job-off", prompt: "next", attachments: [] },
      "create",
      ControlRunStartRequest.parse({
        mode: "ask",
        prompt: "next",
        scope: { kind: "project", root: a.project.root, ephemeral: true },
      }),
    ).draft;
    const bodySha = (
      store.prepare("SELECT body_sha FROM deferred_message WHERE id=?").get(draft.draftId) as {
        body_sha: string;
      }
    ).body_sha;
    // Readable, the draft names A only: B's release is free.
    expect(
      sql.release(b.project.id, { expectedStoreId: b.storeId!, expectedRoot: b.project.root })
        .state,
    ).toBe("released");
    // Unreadable, the same draft proves nothing either way: A is held, not
    // guessed. One poisoned read only — no row, file or digest is damaged.
    const poisoned = new SqlProjectStore(store, new UnreadableBody(store, bodySha), obligations);
    expect(
      refusalOf(() =>
        poisoned.release(a.project.id, {
          expectedStoreId: a.storeId!,
          expectedRoot: a.project.root,
        }),
      ),
    ).toEqual({ code: "project_has_active_run", status: 409 });
    expect(store.prepare("SELECT state FROM deferred_message WHERE id=?").get(draft.draftId)).toEqual(
      { state: "waiting" },
    );
    expect(blobs.read(bodySha).byteLength).toBeGreaterThan(0);
  });

  it("refuses release over a non-purged thread without touching it", () => {
    const { project, storeId } = register("one", "threaded");
    const binding = { expectedStoreId: storeId!, expectedRoot: project.root };
    const thread = router.createThread({ repoRoot: project.root });
    const before = router.getThread(thread.id);
    expect(refusalOf(() => sql.release(project.id, binding))).toEqual({
      code: "project_has_threads",
      status: 409,
    });
    // The refusal changed nothing: the thread stands exactly as it was.
    expect(router.getThread(thread.id)).toEqual(before);
    expect(store.prepare("SELECT status FROM project WHERE id=?").get(project.id)).toEqual({
      status: "active",
    });
    router.trashThread(thread.id);
    router.purgeThread(thread.id);
    expect(sql.release(project.id, binding).state).toBe("released");
  });
});
