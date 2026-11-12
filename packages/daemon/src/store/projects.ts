import { randomUUID } from "node:crypto";
import {
  Project as ProjectSchema,
  Thread as ThreadSchema,
  SCHEMA_VERSION,
  type Project,
  type ProjectNesting,
  type Thread,
  type ControlProjectRemoveReceipt,
} from "@claudexor/schema";
import { hashJson, newId, nowIso } from "@claudexor/util";
import { reduceThreadLifecycle } from "../thread-lifecycle.js";
import {
  canonicalRoot,
  assertNotClaudexorOwned,
  parseMutation,
  projectNesting,
  validateKey,
  type ProjectMutation,
  type ProjectRegistration,
} from "../projects.js";
import type { BlobFiles } from "./blob-files.js";
import { prepareEvent, appendPreparedEventInTx } from "./event-store.js";
import { archiveGenerationInTx, globalGeneration, requireServedGeneration } from "./generations.js";
import {
  bindIdempotencyInTx,
  deleteTargetIdempotencyInTx,
  lookupIdempotency,
} from "./idempotency.js";
import {
  requireTransaction,
  runMutation,
  type MutationContext,
  type SqlWriteContext,
} from "./mutation.js";
import type { Obligations } from "./obligations.js";
import { insertPartitionInTx, partitionById, type PartitionGeneration } from "./partitions.js";
import type { EngineStore } from "./store.js";
import { decodeBody, encodeBody } from "./thread-rows.js";
import { SqlThreadStore } from "./threads.js";

export type ProjectMutationType =
  "project.registered" | "project.relinked" | "project.unregistered";

/** Pure import/runtime reducer; callers bind project partition ids when known.
 * Creation provenance comes from record order, never timestamp coincidence. */
export function applyProjectMutation(
  sql: SqlWriteContext,
  pid: number,
  type: ProjectMutationType,
  value: unknown,
  time: string,
  currentPid?: number | null,
): ProjectMutation {
  requireTransaction(sql);
  const mutation = parseMutation(value);
  const { project, registration } = mutation;
  const previous = sql
    .prepare("SELECT pid,status,creation_key_digest,current_pid FROM project WHERE id=?")
    .get(project.id) as
    | {
        pid: number;
        status: string;
        creation_key_digest: string | null;
        current_pid: number | null;
      }
    | undefined;
  if (previous && previous.pid !== pid)
    throw new Error("project belongs to another global generation");
  if (type === "project.unregistered") {
    sql.prepare("UPDATE project SET status='archived' WHERE id=? AND pid=?").run(project.id, pid);
    deleteTargetIdempotencyInTx(sql, "project", pid, project.id);
    if (previous?.current_pid != null) archiveGenerationInTx(sql, previous.current_pid);
    return mutation;
  }
  const creationKey = previous ? previous.creation_key_digest : (registration?.keyDigest ?? null);
  sql
    .prepare(
      `INSERT INTO project(id,pid,root,status,current_pid,created_at,updated_at,body,creation_key_digest)
    VALUES(?,?,?,'active',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET root=excluded.root,
      status='active',updated_at=excluded.updated_at,body=excluded.body,current_pid=excluded.current_pid`,
    )
    .run(
      project.id,
      pid,
      project.root,
      currentPid ?? previous?.current_pid ?? null,
      project.created_at,
      project.updated_at,
      encodeBody(project),
      creationKey,
    );
  if (registration) {
    const saved = bindIdempotencyInTx(sql, {
      owner: "project",
      pid,
      keyDigest: registration.keyDigest,
      requestDigest: registration.requestDigest,
      targetId: registration.projectId,
      operation: "project.register",
      createdAt: time,
    });
    if (saved.targetId !== registration.projectId)
      throw new Error("conflicting project registration history");
  }
  return mutation;
}

/** Global registry owner; registered project generations are created atomically. */
export class SqlProjectStore {
  constructor(
    readonly store: EngineStore,
    readonly blobs: BlobFiles,
    readonly obligations: Obligations,
  ) {}

  global(): PartitionGeneration {
    const generation = globalGeneration(this.store);
    if (!generation) throw new Error("global generation is not initialized");
    return requireServedGeneration(this.store, generation.pid);
  }

  list(): Project[] {
    return this.store
      .prepare("SELECT body FROM project WHERE pid=? AND status='active' ORDER BY created_at,rowid")
      .all(this.global().pid)
      .map((row) => decodeBody<Project>(row as { body: Uint8Array }));
  }

  get(id: string): Project | undefined {
    const row = this.store
      .prepare("SELECT body FROM project WHERE id=? AND pid=? AND status='active'")
      .get(id, this.global().pid) as { body: Uint8Array } | undefined;
    return row ? decodeBody<Project>(row) : undefined;
  }

  findByRoot(root: string): Project | undefined {
    const row = this.store
      .prepare("SELECT body FROM project WHERE pid=? AND root=? AND status='active'")
      .get(this.global().pid, canonicalRoot(root)) as { body: Uint8Array } | undefined;
    return row ? decodeBody<Project>(row) : undefined;
  }

  nestingFor(id: string): ProjectNesting[] {
    return projectNesting(this.list()).get(id) ?? [];
  }
  listWithNesting(): Array<Project & { nesting: ProjectNesting[] }> {
    const projects = this.list();
    const nesting = projectNesting(projects);
    return projects.map((project) => ({ ...project, nesting: nesting.get(project.id) ?? [] }));
  }

  partition(id: string): PartitionGeneration | null {
    const row = this.store
      .prepare("SELECT current_pid FROM project WHERE id=? AND pid=? AND status='active'")
      .get(id, this.global().pid) as { current_pid: number | null } | undefined;
    return row?.current_pid == null ? null : partitionById(this.store, row.current_pid);
  }

  register(input: { root: string; idempotencyKey: string; clientId: string }): ProjectRegistration {
    validateKey(input.idempotencyKey);
    const root = canonicalRoot(input.root);
    assertNotClaudexorOwned(root);
    const pid = this.global().pid;
    const keyDigest = hashJson({
      client: input.clientId,
      partition: "global",
      operation: "project.register",
      key: input.idempotencyKey,
    });
    const requestDigest = hashJson({ root });
    const saved = lookupIdempotency(
      this.store,
      { owner: "project", pid, keyDigest },
      requestDigest,
    );
    if (saved) {
      const row = this.store
        .prepare(
          "SELECT body,creation_key_digest FROM project WHERE id=? AND pid=? AND status='active'",
        )
        .get(saved.targetId, pid) as
        { body: Uint8Array; creation_key_digest: string | null } | undefined;
      if (!row) throw new Error("project registration points to a missing project");
      return { project: decodeBody<Project>(row), created: row.creation_key_digest === keyDigest };
    }
    const existing = this.findByRoot(root);
    const now = nowIso();
    const project =
      existing ??
      ProjectSchema.parse({
        schema_version: SCHEMA_VERSION,
        id: newId("prj"),
        root,
        created_at: now,
        updated_at: now,
      });
    const mutation: ProjectMutation = {
      project,
      registration: { keyDigest, requestDigest, projectId: project.id },
    };
    const event = prepareEvent(this.blobs, {
      type: "project.registered",
      time: now,
      payload: mutation,
    });
    runMutation(this.store, (tx) => {
      const partition = existing
        ? this.partition(project.id)
        : insertPartitionInTx(tx, {
            name: `project:${project.id}`,
            epoch: randomUUID().replace(/-/g, ""),
            projectId: project.id,
            createdAt: now,
          });
      applyProjectMutation(tx, pid, "project.registered", mutation, now, partition?.pid);
      appendPreparedEventInTx(tx, this.blobs, pid, event);
    });
    return { project, created: !existing };
  }

  relink(id: string, rootInput: string): Project {
    const current = this.get(id);
    if (!current) throw Object.assign(new Error(`no such project: ${id}`), { status: 404 });
    const root = canonicalRoot(rootInput);
    assertNotClaudexorOwned(root);
    const owner = this.findByRoot(root);
    if (owner && owner.id !== id)
      throw Object.assign(new Error(`project root is already registered to ${owner.id}`), {
        code: "project_root_conflict",
        status: 409,
      });
    if (root === current.root) return current;
    const project = ProjectSchema.parse({ ...current, root, updated_at: nowIso() });
    const generation = this.partition(id);
    if (!generation) throw new Error("registered project has no generation");
    requireServedGeneration(this.store, generation.pid);
    const threads = new SqlThreadStore(this.store, this.blobs, generation, this.obligations);
    const changed = (
      this.store
        .prepare("SELECT body FROM thread WHERE pid=? ORDER BY rowid")
        .all(generation.pid) as Array<{ body: Uint8Array }>
    )
      .map((row) => decodeBody<Thread>(row))
      .filter((thread) => thread.repo && thread.repo.root !== root)
      .map((thread) =>
        ThreadSchema.parse({ ...thread, repo: { ...thread.repo!, root }, updated_at: nowIso() }),
      );
    const prepared = changed.length ? threads.prepare({ threads: changed }) : null;
    const event = prepareEvent(this.blobs, {
      type: "project.relinked",
      time: nowIso(),
      payload: { project },
    });
    runMutation(this.store, (tx) => {
      applyProjectMutation(tx, this.global().pid, "project.relinked", { project }, event.time);
      appendPreparedEventInTx(tx, this.blobs, this.global().pid, event);
      if (prepared) threads.applyInTx(tx, prepared);
    });
    return project;
  }

  unregister(id: string): Project | undefined {
    const project = this.get(id);
    if (!project) return undefined;
    const event = unregisteredEvent(this.blobs, project);
    runMutation(this.store, (tx) => this.unregisterInTx(tx, project, event));
    return project;
  }

  private unregisterInTx(
    tx: MutationContext,
    project: Project,
    event: ReturnType<typeof unregisteredEvent>,
  ): void {
    applyProjectMutation(tx, this.global().pid, "project.unregistered", { project }, event.time);
    appendPreparedEventInTx(tx, this.blobs, this.global().pid, event);
  }

  remove(id: string, activeRunRoots: ReadonlySet<string>): ControlProjectRemoveReceipt {
    const { project, partition } = this.removable(id);
    if (partition) {
      const n = Number(
        (
          this.store
            .prepare("SELECT count(*) AS n FROM thread WHERE pid=? AND state<>'purged'")
            .get(partition.pid) as { n: number }
        ).n,
      );
      if (n)
        throw Object.assign(
          new Error(
            `project ${id} still has ${n} thread(s); trash and purge them before removing it`,
          ),
          { code: "project_has_threads", status: 409 },
        );
    }
    if (activeRunRoots.has(project.root)) throw activeRunRefusal(id);
    this.unregister(id);
    return removalReceipt(project, partition);
  }

  /** #333 explicit opt-in: purge the threads already in the trash and retire
   * the generation in ONE transaction. A thread outside the trash, or any
   * queued/running command of the partition (a turn, an Apply delivery, a run
   * under a former root), refuses before any change: purge deletes directories
   * that work uses. Directory cleanup follows the commit via the purge owner. */
  removeWithTrashedThreads(id: string, activeRunRoots: ReadonlySet<string>): ProjectRemoval {
    const { project, partition } = this.removable(id);
    const threads = partition
      ? new SqlThreadStore(this.store, this.blobs, partition, this.obligations)
      : null;
    const trashed: Thread[] = [];
    if (partition) {
      const live = (
        this.store
          .prepare("SELECT body FROM thread WHERE pid=? AND state<>'purged' ORDER BY rowid")
          .all(partition.pid) as Array<{ body: Uint8Array }>
      ).map((row) => decodeBody<Thread>(row));
      const outside = live.filter((thread) => thread.state !== "trashed").length;
      if (outside)
        throw Object.assign(
          new Error(
            `project ${id} still has ${outside} thread(s) outside the trash; trash them before removing the project with its trashed threads`,
          ),
          { code: "project_has_threads", status: 409 },
        );
      trashed.push(...live);
    }
    if (activeRunRoots.has(project.root)) throw activeRunRefusal(id);
    if (
      partition &&
      this.store
        .prepare(
          "SELECT 1 FROM command WHERE live=1 AND state IN ('queued','running') AND pid=? LIMIT 1",
        )
        .get(partition.pid)
    )
      throw activeRunRefusal(id);
    const purged = trashed.map((thread) => reduceThreadLifecycle(thread, "purge"));
    const prepared = threads && purged.length ? threads.prepare({ threads: purged }) : null;
    const event = unregisteredEvent(this.blobs, project);
    runMutation(this.store, (tx) => {
      if (prepared) threads!.applyInTx(tx, prepared);
      // The same pre-purge payload the single thread purge commits.
      for (const thread of trashed)
        this.obligations.create("purge_fs", thread.id, partition!.pid, { thread });
      this.unregisterInTx(tx, project, event);
    });
    return { receipt: removalReceipt(project, partition), purged: trashed };
  }

  private removable(id: string): { project: Project; partition: PartitionGeneration | null } {
    const project = this.get(id);
    if (!project)
      throw Object.assign(new Error(`no such project: ${id}`), {
        code: "project_not_found",
        status: 404,
      });
    const partition = this.partition(id);
    return {
      project,
      partition: partition ? requireServedGeneration(this.store, partition.pid) : null,
    };
  }
}

/** The opted-in removal's committed decision and each purged thread's
 * pre-purge record, which the purge owner's directory cleanup consumes. */
export interface ProjectRemoval {
  receipt: ControlProjectRemoveReceipt;
  purged: Thread[];
}

function unregisteredEvent(blobs: BlobFiles, project: Project) {
  return prepareEvent(blobs, {
    type: "project.unregistered",
    time: nowIso(),
    payload: { project },
  });
}

function activeRunRefusal(id: string): Error {
  return Object.assign(
    new Error(`project ${id} has a live or queued run; wait for it to finish before removing it`),
    { code: "project_has_active_run", status: 409 },
  );
}

function removalReceipt(
  project: Project,
  partition: PartitionGeneration | null,
): ControlProjectRemoveReceipt {
  return {
    projectId: project.id,
    root: project.root,
    registryRemoved: true,
    journalPartitionArchived: partition !== null,
    archivedPartitionPath: partition ? `partition:${partition.name}@${partition.epoch}` : null,
    artifactsRetained: true,
    activeRunCheck: "snapshot",
  };
}
