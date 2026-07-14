import type { Project, Thread, ThreadTurn } from "@claudexor/schema";
import { hashJson } from "@claudexor/util";
import { commandProjection, type CommandStore } from "./command-store.js";
import { JournalManager, type JournalProjectionSlot } from "./journal-manager.js";
import type { ProjectStore } from "./projects.js";
import {
  threadProjection,
  type CreateThreadInput,
  type CreateTurnInput,
  type ThreadStore,
  type UpdateThreadInput,
} from "./threads.js";
import type { CommandAuthority } from "./command-authority.js";

interface ProjectPartition {
  manager: JournalManager;
  commands: JournalProjectionSlot<CommandStore>;
  threads: JournalProjectionSlot<ThreadStore>;
}

export class ProjectPartitions implements CommandAuthority {
  private readonly partitions = new Map<string, ProjectPartition>();

  constructor(
    private readonly rootDir: string,
    private readonly projects: JournalProjectionSlot<ProjectStore>,
    private readonly globalCommands: JournalProjectionSlot<CommandStore>,
    private readonly globalThreads: JournalProjectionSlot<ThreadStore>,
  ) {
    this.sync();
  }

  all(): CommandStore[] {
    return [
      this.globalCommands.current(),
      ...this.healthy().map((entry) => entry.commands.current()),
    ];
  }

  forRequest(params: unknown): CommandStore {
    const input = record(params);
    const threadId = stringField(input, "threadId");
    if (threadId) {
      const store = this.threadStoreForThread(threadId);
      if (store) return this.commandStoreForThreadStore(store);
    }
    const scope = record(input.scope);
    if (scope.kind !== "project") return this.globalCommands.current();
    const root = stringField(scope, "root");
    return this.partitionForRoot(root).commands.current();
  }

  findById(id: string): CommandStore | undefined {
    return this.all().find((store) => store.get(id));
  }

  registerProject(input: Parameters<ProjectStore["register"]>[0]): Project {
    const project = this.projects.current().register(input);
    this.ensure(project.id);
    return project;
  }

  relinkProject(id: string, root: string): Project {
    const project = this.projects.current().relink(id, root);
    this.ensure(id).threads.current().relinkProjectRoot(project.root);
    return project;
  }

  createThread(input: CreateThreadInput): Thread {
    if (input.repoRoot && !this.projects.current().findByRoot(input.repoRoot)) {
      this.registerProject({
        root: input.repoRoot,
        idempotencyKey: `thread-auto-register-${hashJson(input.repoRoot)}`,
        clientId: "thread-create",
      });
    }
    return this.threadStoreForRoot(input.repoRoot).createThread(input);
  }

  listThreads(): Thread[] {
    return this.threadStores().flatMap((store) => store.listThreads());
  }

  getThread(id: string): Thread | undefined {
    return this.threadStoreForThread(id)?.getThread(id);
  }

  turnsFor(id: string): ThreadTurn[] {
    return this.threadStoreForThread(id)?.turnsFor(id) ?? [];
  }

  sessionsForThread(id: string) {
    return this.threadStoreForThread(id)?.sessionsForThread(id) ?? [];
  }

  createTurn(id: string, prompt: string, input: CreateTurnInput = {}): ThreadTurn {
    return this.requireThreadStore(id).createTurn(id, prompt, input);
  }

  updateThread(id: string, patch: UpdateThreadInput): Thread {
    return this.requireThreadStore(id).updateThread(id, patch);
  }

  setThreadWorktree(id: string, path: string, baseSha: string): void {
    this.requireThreadStore(id).setThreadWorktree(id, path, baseSha);
  }

  assertKnownIds(threadId: unknown, turnId: unknown): { threadId?: string; turnId?: string } {
    const id = typeof threadId === "string" && threadId ? threadId : undefined;
    const turn = typeof turnId === "string" && turnId ? turnId : undefined;
    const store = id
      ? this.requireThreadStore(id)
      : turn
        ? this.requireTurnStore(turn)
        : this.globalThreads.current();
    return store.assertKnownIds(threadId, turnId);
  }

  getTurn(id: string): ThreadTurn | undefined {
    return this.threadStoreForTurn(id)?.getTurn(id);
  }

  bindTurnRun(id: string, runId: string): void {
    this.requireTurnStore(id).bindTurnRun(id, runId);
  }

  setTurnEnqueueError(
    id: string,
    message: string,
    code: string | null = null,
    retryable = true,
  ): void {
    this.requireTurnStore(id).setTurnEnqueueError(id, message, code, retryable);
  }

  resumeMap(id: string): Record<string, string> {
    return this.requireThreadStore(id).resumeMap(id);
  }

  recordSession(
    id: string,
    harnessId: string,
    nativeSessionId: string,
    observedModel?: string | null,
  ): void {
    this.requireThreadStore(id).recordSession(id, harnessId, nativeSessionId, observedModel);
  }

  close(): void {
    for (const entry of this.partitions.values()) entry.manager.close();
    this.partitions.clear();
  }

  private sync(): void {
    const ids = new Set(
      this.projects
        .current()
        .list()
        .map((project) => project.id),
    );
    for (const id of ids) this.ensure(id);
    for (const [id, entry] of this.partitions) {
      if (ids.has(id)) continue;
      entry.manager.close();
      this.partitions.delete(id);
    }
  }

  private ensure(projectId: string): ProjectPartition {
    const existing = this.partitions.get(projectId);
    if (existing) return existing;
    const manager = new JournalManager(this.rootDir, { partition: `project:${projectId}` });
    const commands = manager.registerProjection(commandProjection());
    const threads = manager.registerProjection(threadProjection());
    manager.start();
    const entry = { manager, commands, threads };
    this.partitions.set(projectId, entry);
    return entry;
  }

  private healthy(): ProjectPartition[] {
    this.sync();
    return [...this.partitions.values()].filter(
      (entry) => entry.manager.inspect().status === "ready",
    );
  }

  private partitionForRoot(root: string): ProjectPartition {
    const project = this.projects.current().findByRoot(root);
    if (!project) {
      throw Object.assign(new Error(`project is not registered: ${root}`), {
        code: "project_not_registered",
        status: 404,
      });
    }
    return this.ensure(project.id);
  }

  private threadStores(): ThreadStore[] {
    return [
      this.globalThreads.current(),
      ...this.healthy().map((entry) => entry.threads.current()),
    ];
  }

  private threadStoreForRoot(root: string | null | undefined): ThreadStore {
    return root ? this.partitionForRoot(root).threads.current() : this.globalThreads.current();
  }

  private threadStoreForThread(id: string): ThreadStore | undefined {
    return this.threadStores().find((store) => store.getThread(id));
  }

  private threadStoreForTurn(id: string): ThreadStore | undefined {
    return this.threadStores().find((store) => store.getTurn(id));
  }

  private requireThreadStore(id: string): ThreadStore {
    const store = this.threadStoreForThread(id);
    if (!store) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
    return store;
  }

  private requireTurnStore(id: string): ThreadStore {
    const store = this.threadStoreForTurn(id);
    if (!store) throw Object.assign(new Error(`no such turn: ${id}`), { status: 404 });
    return store;
  }

  private commandStoreForThreadStore(store: ThreadStore): CommandStore {
    if (store === this.globalThreads.current()) return this.globalCommands.current();
    const entry = this.healthy().find((candidate) => candidate.threads.current() === store);
    if (!entry) throw new Error("thread partition has no command authority");
    return entry.commands.current();
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === "string" ? field : "";
}
