/**
 * What one thread's export is made of right now: its engine records, run trees,
 * attachment bytes, lane directory and every copy of every native session its
 * runs recorded, with a named gap for anything it cannot carry or prove.
 * Building it writes nothing.
 */
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import {
  THREAD_EXPORT_SCHEMA_VERSION,
  ThreadExportManifest,
  threadExportItemId,
  threadExportLinkIdentity,
  type ThreadExportGap,
  type ThreadExportGapCode,
  type ThreadExportItem,
  type ThreadExportItemPlane,
  type ThreadExportDigestEntry,
  type ThreadExportSession,
  type ThreadRetireRequest,
  type ThreadRetirementOperation,
} from "@claudexor/schema";
import { hashJson } from "@claudexor/util";
import { readContinuationSources, runFilesExpired } from "@claudexor/workspace";
import {
  bundleSegment,
  digestDecoded,
  walkTree,
  type ExportFileIdentity,
  type WalkedEntry,
} from "./thread-export-walk.js";
import { laneBundlePrefix, readLaneTree } from "./thread-export-digests.js";
import { runSessionObservations, type SessionObservation } from "./thread-export-sessions.js";
import { exportHarnessSessions, type NativeLayout } from "./thread-export-native.js";
export type { NativeLayout, NativeStoreRef } from "./thread-export-native.js";

/** What the store's closure read answers (`@claudexor/daemon`'s `ThreadClosure`). */
export interface ThreadExportClosure {
  storeId: string;
  thread: {
    id: string;
    state: "active" | "closed" | "trashed" | "purged";
    retirement?: ThreadRetireRequest & { acceptedAt: string };
    repo: { root: string } | null;
    workspace: { mode: "in_place" | "isolated" | "delegated"; worktree_path: string | null };
  };
  headRevision: number;
  digest: string;
  turns: { turnId: string; ordinal: number; runId: string | null; promptSha256: string }[];
  commands: {
    jobId: string;
    runId: string | null;
    state: string;
    kind: string;
    threadId: string | null;
    turnId: string | null;
    continueFrom: string | null;
    delegatedFrom: string | null;
    runDir: string | null;
  }[];
  documents: { key: string; path: string }[];
  holds: { code: string; subject: string; message: string }[];
}

export interface ThreadExportDeps {
  /** The thread row and its store alone, for answers that need no closure. */
  thread(threadId: string): { storeId: string; thread: ThreadExportClosure["thread"] } | null;
  /** An observation: the engine answers it from its read-only snapshot, off the request
   * thread, and acceptance reads the closure again itself. `signal` ends the wait. */
  closure(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<ThreadExportClosure | null> | ThreadExportClosure | null;
  document(threadId: string, key: string): Buffer | null;
  /** The harness's declared session layout; null when it declares none. */
  nativeLayout(harness: string): NativeLayout | null;
  /** The lane's exact credential stores, HOME-relative; null when undeclared. */
  laneCredentialStores(laneSegment: string): readonly string[] | null;
  /** The thread's owned lane directory; throws when a link stands in its path. */
  laneDirectory(thread: ThreadExportClosure["thread"]): string;
  isolatedWorktreeExists(thread: ThreadExportClosure["thread"]): boolean;
  /** `heldBy`: the retained command whose own refs these are (a released ID it holds resolves). */
  resolveAttachments(
    refs: { resourceId: string }[],
    heldBy?: { owner: "command" | "turn"; id: string },
  ): {
    resource_id: string;
    name: string;
    path: string;
    sha256: string;
    size_bytes: number;
  }[];
  /** Accept, recording the lane entries acceptance read, for cleanup to recheck. */
  retire(
    threadId: string,
    request: ThreadRetireRequest,
    acceptedLane: readonly ThreadExportDigestEntry[],
  ): unknown;
  operation(threadId: string, operationId: string): ThreadRetirementOperation | null;
  settle(
    threadId: string,
    operationId: string,
    refusal: { code: string; message: string } | null,
  ): ThreadRetirementOperation;
  /** Runs the purge owner's cleanup; a failure leaves it open and is reported by
   * `cleanup`. `signal` is the server's Stop: a stopped attempt also stays open. */
  finishPurge(thread: ThreadExportClosure["thread"], signal?: AbortSignal): Promise<void>;
  cleanup(threadId: string): { reason: string | null } | null;
  hasPurgeLeftovers(thread: ThreadExportClosure["thread"]): boolean;
}

export type ItemSource =
  | { type: "document"; key: string }
  | { type: "file"; file: ExportFileIdentity }
  | { type: "projection"; file: ExportFileIdentity };

export interface Inventory {
  manifest: ThreadExportManifest;
  /** The manifest's items by id, so a transfer addresses one without a scan. */
  items: ReadonlyMap<string, ThreadExportManifest["items"][number]>;
  sources: Map<string, ItemSource>;
}

export const problem = (code: string, status: number, message: string, extra: object = {}) =>
  Object.assign(new Error(message), { code, status, retryable: status === 503, ...extra });
/** A bundle path segment: no separator, no traversal. */
const segment = bundleSegment;

export const BUSY_GAPS: ReadonlySet<ThreadExportGapCode> = new Set([
  "closure_not_quiescent",
  "closure_awaiting_decision",
]);
const DECODED_SUFFIX = ".decoded.jsonl";

class InventoryBuilder {
  readonly gaps: ThreadExportGap[] = [];
  readonly items: ThreadExportItem[] = [];
  readonly sources = new Map<string, ItemSource>();
  private readonly itemIds = new Set<string>();
  readonly observations: SessionObservation[] = [];
  readonly disclosures: { harness: string; source: string; reason: string }[] = [];

  constructor(
    private readonly deps: ThreadExportDeps,
    private readonly closure: ThreadExportClosure,
    private readonly signal?: AbortSignal,
  ) {}

  gap(code: ThreadExportGapCode, subject: string, message: string): void {
    this.gaps.push({ code, subject, message });
  }

  private add(
    plane: ThreadExportItemPlane,
    path: string,
    fields: Partial<ThreadExportItem> & Pick<ThreadExportItem, "kind">,
    source?: ItemSource,
  ): string {
    const itemId = threadExportItemId(plane, path);
    // A name bound to two sessions of this closure is one file, carried once.
    if (this.itemIds.has(itemId)) return itemId;
    this.itemIds.add(itemId);
    this.items.push({
      itemId,
      plane,
      path,
      sizeBytes: null,
      mtimeMs: null,
      sha256: null,
      projectionOf: null,
      linkTarget: null,
      ...fields,
    });
    if (source) this.sources.set(itemId, source);
    return itemId;
  }

  addEntry(plane: ThreadExportItemPlane, prefix: string, entry: WalkedEntry): void {
    const path = `${prefix}/${entry.rel}`;
    if (entry.kind === "symlink") {
      const identity = threadExportLinkIdentity(entry.linkTarget);
      this.add(plane, path, {
        kind: "symlink",
        linkTarget: entry.linkTarget,
        sizeBytes: identity.sizeBytes,
        sha256: identity.sha256,
      });
    } else if (entry.kind === "special") this.add(plane, path, { kind: "special" });
    else
      this.add(
        plane,
        path,
        { kind: "file", sizeBytes: entry.file.sizeBytes, mtimeMs: entry.file.mtimeMs },
        { type: "file", file: entry.file },
      );
  }

  /** Engine records: exact JSON documents, hashed from the rows they serialize. */
  async documents(threadId: string): Promise<unknown[]> {
    const parsed: unknown[] = [];
    for (const document of this.closure.documents) {
      await yieldToAdmission();
      this.signal?.throwIfAborted();
      const bytes = this.deps.document(threadId, document.key);
      if (!bytes) throw stale("a closure record changed while it was read");
      this.add(
        "sql",
        document.path,
        {
          kind: "file",
          sizeBytes: bytes.length,
          sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        },
        { type: "document", key: document.key },
      );
      parsed.push({ key: document.key, value: JSON.parse(bytes.toString("utf8")) as unknown });
    }
    return parsed;
  }

  /** Run trees, including continuation sources named only on disk. */
  async runs(): Promise<void> {
    const pending = this.closure.commands
      .filter((command): command is typeof command & { runDir: string } => !!command.runDir)
      .map((command) => ({ runId: command.runId ?? command.jobId, runDir: command.runDir }));
    const seen = new Set<string>();
    for (const run of pending) {
      if (seen.has(run.runDir)) continue;
      seen.add(run.runDir);
      this.signal?.throwIfAborted();
      const stat = await lstat(run.runDir).catch(() => null);
      if (!stat) {
        this.gap("run_directory_missing", run.runId, `run directory ${run.runDir} is missing`);
        continue;
      }
      if (!stat.isDirectory()) {
        this.gap("run_tree_unreadable", run.runId, `${run.runDir} is not a plain directory`);
        continue;
      }
      if (runFilesExpired(run.runDir)) {
        this.gap("run_files_expired", run.runId, `retention already reclaimed run ${run.runId}`);
        continue;
      }
      const prefix = `runs/${segment(run.runId)}`;
      const walked = await walkTree(run.runDir, "", this.signal);
      for (const entry of walked.entries) this.addEntry("run", prefix, entry);
      for (const issue of walked.problems)
        this.gap("run_tree_unreadable", `${run.runId}/${issue.rel}`, issue.message);
      const seen2 = await runSessionObservations(run.runId, walked.entries, this.signal);
      this.observations.push(...seen2.observations);
      for (const message of seen2.problems)
        this.gap("run_observations_unreadable", run.runId, message);
      try {
        for (const source of readContinuationSources(run.runDir, { strict: true }))
          pending.push({ runId: source.runId, runDir: source.runDir });
      } catch (error) {
        this.gap(
          "run_observations_unreadable",
          run.runId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  /**
   * Attachment bytes a turn or command names, by the digest its record carries. Each
   * document reads its refs as its own holder; a resource is unavailable only when no
   * document could read it. A delivery repeats its run's params and holds nothing
   * (#249), so its copy of a released ID is answered by the run's command or turn.
   */
  async attachments(documents: readonly unknown[]): Promise<void> {
    const named = new Map<string, { name: string; path: string; sha256: string; size: number }>();
    const unread = new Map<string, string>();
    for (const document of documents as { key: string; value: Record<string, unknown> }[]) {
      const params = document.key.startsWith("command:")
        ? (document.value["params"] as Record<string, unknown> | undefined)
        : document.key.startsWith("turn:")
          ? document.value
          : null;
      const list = params?.["attachments"];
      if (!Array.isArray(list)) continue;
      const [kind, ...rest] = document.key.split(":");
      const holder = {
        owner: kind === "command" ? "command" : "turn",
        id: rest.join(":"),
      } as const;
      for (const raw of list as Record<string, unknown>[]) {
        try {
          const resolved =
            typeof raw["path"] === "string"
              ? [raw as unknown as ReturnType<ThreadExportDeps["resolveAttachments"]>[number]]
              : this.deps.resolveAttachments([{ resourceId: String(raw["resourceId"]) }], holder);
          for (const item of resolved)
            named.set(item.resource_id, {
              name: item.name,
              path: item.path,
              sha256: item.sha256,
              size: item.size_bytes,
            });
        } catch (error) {
          const id = String(raw["resourceId"] ?? raw["resource_id"] ?? document.key);
          if (!unread.has(id))
            unread.set(id, error instanceof Error ? error.message : String(error));
        }
      }
    }
    for (const [id, message] of unread)
      if (!named.has(id)) this.gap("attachment_unavailable", id, message);
    for (const [id, item] of named) {
      const stat = await lstat(item.path).catch(() => null);
      if (!stat?.isFile() || stat.size !== item.size) {
        this.gap("attachment_unavailable", id, `attachment ${id} bytes are missing or resized`);
        continue;
      }
      this.add(
        "resource",
        `resources/${segment(id)}/${segment(item.name)}`,
        { kind: "file", sizeBytes: item.size, mtimeMs: stat.mtimeMs, sha256: item.sha256 },
        {
          type: "file",
          file: {
            absPath: item.path,
            dev: stat.dev,
            ino: stat.ino,
            sizeBytes: item.size,
            mtimeMs: stat.mtimeMs,
          },
        },
      );
    }
  }

  /** The lane directory: all that retirement deletes, exact credential stores aside. */
  async lanes(thread: ThreadExportClosure["thread"]): Promise<WalkedEntry[]> {
    const prefix = laneBundlePrefix(thread.id);
    let root: string;
    try {
      root = this.deps.laneDirectory(thread);
    } catch (error) {
      this.gap(
        "lane_unreadable",
        thread.id,
        error instanceof Error ? error.message : String(error),
      );
      return [];
    }
    const lane = await readLaneTree(root, this.deps.laneCredentialStores, this.signal);
    for (const issue of lane.problems) this.gap("lane_unreadable", issue.rel, issue.message);
    for (const name of lane.undeclared)
      this.gap(
        "lane_credentials_undeclared",
        name,
        `lane ${name} belongs to a harness that declares no credential stores; its files were not read`,
      );
    for (const rel of lane.credentialStores)
      this.add("lane", `${prefix}/${rel}`, { kind: "credential_store" });
    for (const entry of lane.entries) this.addEntry("lane", prefix, entry);
    return lane.entries;
  }

  /** Every exact session across its harness's stores; every distinct copy stays. */
  async sessions(
    documents: readonly unknown[],
    laneEntries: readonly WalkedEntry[],
  ): Promise<ThreadExportSession[]> {
    for (const document of documents as { key: string; value: Record<string, unknown> }[]) {
      if (!document.key.startsWith("session:")) continue;
      const native = document.value["native_session_id"];
      if (typeof native === "string" && native)
        this.observations.push({
          harness: String(document.value["harness_id"]),
          nativeSessionId: native,
          source: "thread_session",
          runId: null,
          attemptId: null,
          profileId: (document.value["profile_id"] as string | null) ?? null,
          cwd: null,
          context: null,
        });
    }
    const bySession = new Map<string, ThreadExportSession>();
    const byHarness = new Map<string, Set<string>>();
    for (const seen of this.observations) {
      if (!seen.harness) {
        this.gap(
          "native_session_unattributed",
          seen.nativeSessionId,
          `no record of run ${seen.runId ?? "unknown"} names the harness of this session`,
        );
        continue;
      }
      const key = `${seen.harness}\0${seen.nativeSessionId}`;
      const session = bySession.get(key) ?? {
        harness: seen.harness,
        nativeSessionId: seen.nativeSessionId,
        status: "exported" as const,
        provenance: [],
        copies: [],
      };
      bySession.set(key, session);
      session.provenance.push({
        source: seen.source,
        runId: seen.runId,
        attemptId: seen.attemptId,
        profileId: seen.profileId,
        cwd: seen.cwd,
      });
      const ids = byHarness.get(seen.harness) ?? new Set<string>();
      ids.add(seen.nativeSessionId);
      byHarness.set(seen.harness, ids);
    }
    for (const [harness, ids] of byHarness)
      await exportHarnessSessions(
        harness,
        this.deps.nativeLayout(harness),
        new Map([...ids].map((id) => [id, bySession.get(`${harness}\0${id}`)!])),
        laneEntries,
        {
          gap: (code, subject, message) => this.gap(code, subject, message),
          carry: (prefix, entry) => this.addEntry("native", prefix, entry),
          disclose: (source, reason) => this.disclosures.push({ harness, source, reason }),
        },
        this.signal,
      );
    return [...bySession.values()];
  }

  /** Decoded text beside each compressed session part; the original stays exact. */
  async projections(): Promise<void> {
    for (const item of [...this.items]) {
      if (item.kind !== "file" || !item.path.endsWith(".jsonl.zst")) continue;
      if (item.plane !== "native" && item.plane !== "lane") continue;
      const source = this.sources.get(item.itemId);
      if (source?.type !== "file") continue;
      try {
        const decoded = await digestDecoded(source.file, this.signal);
        this.add(
          "projection",
          `${item.path}${DECODED_SUFFIX}`,
          {
            kind: "file",
            sizeBytes: decoded.sizeBytes,
            mtimeMs: source.file.mtimeMs,
            sha256: decoded.sha256,
            projectionOf: item.itemId,
          },
          { type: "projection", file: source.file },
        );
      } catch (error) {
        this.signal?.throwIfAborted();
        this.gap(
          "native_projection_failed",
          item.path,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
}

export const stale = (message: string) =>
  problem("thread_export_stale", 409, message, { requiredActions: ["re-read the manifest"] });

export async function buildInventory(
  deps: ThreadExportDeps,
  threadId: string,
  signal?: AbortSignal,
): Promise<Inventory> {
  const closure = await deps.closure(threadId, signal);
  if (!closure) throw problem("thread_not_found", 404, `no such thread: ${threadId}`);
  if (closure.thread.state === "purged")
    throw problem("thread_purged", 410, "thread was purged; its export is no longer produced");
  const builder = new InventoryBuilder(deps, closure, signal);
  for (const hold of closure.holds)
    builder.gap(hold.code as ThreadExportGapCode, hold.subject, hold.message);
  if (closure.thread.workspace.mode === "isolated" && deps.isolatedWorktreeExists(closure.thread))
    builder.gap(
      "isolated_worktree_present",
      closure.thread.id,
      "an isolated worktree is outside this export, and retirement would delete it",
    );
  const documents = await builder.documents(threadId);
  await builder.runs();
  await builder.attachments(documents);
  const laneEntries = await builder.lanes(closure.thread);
  const sessions = await builder.sessions(documents, laneEntries);
  await builder.projections();
  // A concurrent writer changed the rows this inventory describes.
  if ((await deps.closure(threadId, signal))?.digest !== closure.digest)
    throw stale("the closure changed while its inventory was read");
  const items = builder.items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const gaps = builder.gaps;
  const exportId = hashJson({
    closure: closure.digest,
    gaps,
    items: items.map((item) => [
      item.itemId,
      item.kind,
      item.sizeBytes,
      item.mtimeMs,
      item.sha256,
      item.linkTarget,
    ]),
  });
  const manifest = ThreadExportManifest.parse({
    schemaVersion: THREAD_EXPORT_SCHEMA_VERSION,
    storeId: closure.storeId,
    threadId,
    exportId,
    closureDigest: closure.digest,
    threadState: closure.thread.state,
    headRevision: closure.headRevision,
    workspaceMode: closure.thread.workspace.mode,
    coverage: gaps.length === 0 ? "complete" : "partial",
    retirable: gaps.length === 0,
    gaps,
    disclosures: builder.disclosures,
    closure: {
      turns: closure.turns,
      runs: closure.commands.map(({ runDir: _runDir, ...command }) => command),
    },
    sessions,
    items,
  });
  return {
    sources: builder.sources,
    items: new Map(manifest.items.map((item) => [item.itemId, item])),
    manifest,
  };
}
