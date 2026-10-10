import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { legacyOracle as old } from "./legacy-oracle.js";
import { DurableJournal } from "./fixtures/legacy/journal/index.js";
import type { JournalRecord } from "./fixtures/legacy/journal/index.js";
import { Comparisons, privateMap } from "./equivalence-evidence.js";

/** Load candidate owners from its built daemon, plus the exact setup source
 * through the existing tsx loader. The frozen closure stays independent. */
export async function sqlOwners(root: string) {
  const module = (name: string) =>
    import(pathToFileURL(join(root, `packages/daemon/dist/${name}.js`)).href);
  const [
    store,
    graph,
    threads,
    events,
    interactions,
    decisions,
    rows,
    cursors,
    generations,
    bindings,
    quota,
    terminals,
  ] = await Promise.all([
    module("store/store"),
    module("store/sql-daemon-services"),
    module("store/threads"),
    module("store/event-store"),
    module("store/interactions"),
    module("store/operator-decisions"),
    module("store/thread-rows"),
    module("store/cursors"),
    module("store/generations"),
    module("store/upload-binding-retention"),
    module("quota-registry"),
    module("store/run-events"),
  ]);
  const setup = await import(pathToFileURL(join(root, "packages/cli/src/sql-setup-store.ts")).href);
  return {
    ...store,
    ...graph,
    ...threads,
    ...events,
    ...interactions,
    ...decisions,
    ...rows,
    ...cursors,
    ...generations,
    ...bindings,
    ...quota,
    ...setup,
    ...terminals,
  };
}
export type Owners = Awaited<ReturnType<typeof sqlOwners>>;

function expectedBindings(
  instance: object,
  property: string,
  target: string,
): Map<string, unknown> {
  return new Map(
    [...privateMap(instance, property)].map(([key, raw]) => {
      const value = raw as Record<string, unknown>;
      return [key, { requestDigest: value.requestDigest, targetId: value[target] }];
    }),
  );
}
function compareBindings(
  c: Comparisons,
  store: any,
  pid: number,
  name: string,
  owner: string,
  expected: Map<string, unknown>,
) {
  const rows = store
    .prepare("SELECT key_digest,request_digest,target_id FROM idempotency WHERE owner=? AND pid=?")
    .all(owner, pid) as Array<{ key_digest: string; request_digest: string; target_id: string }>;
  c.equal(
    `bindings:${name}:${owner}`,
    expected,
    new Map(
      rows.map((row) => [
        row.key_digest,
        { requestDigest: row.request_digest, targetId: row.target_id },
      ]),
    ),
  );
}
const tuple = (
  record: Pick<JournalRecord, "partition" | "epoch" | "seq" | "time" | "type" | "payload">,
) => ({
  partition: record.partition,
  epoch: record.epoch,
  seq: record.seq,
  time: record.time,
  type: record.type,
  payload: record.payload,
});

export async function comparePartition(input: {
  c: Comparisons;
  owners: Owners;
  store: any;
  graph: any;
  generation: any;
  journal: DurableJournal;
  referenceRoot: string;
  sqlRoot: string;
  now: string;
  headRevisions: Map<string, unknown>;
  prunedRoots: Set<string>;
  activeProjects: Set<string>;
}): Promise<{
  events: number;
  cursorChecks: number;
  commands: number;
  threads: number;
  served: boolean;
}> {
  const { c, owners, store, graph, generation, journal, referenceRoot, sqlRoot } = input;
  const name = generation.name as string,
    pid = generation.pid as number;
  const commands = new old.daemonCommandStore.CommandStore(journal, () => new Date(input.now));
  const threads = new old.daemonThreads.ThreadStore(journal);
  const decisions = new old.daemonOperatorDecisions.OperatorDecisionStore(journal);
  const interactions = new old.daemonInteractions.InteractionStore(journal);
  const records = journal.records();
  const ledger = new owners.SqlEventLedger(store, graph.blobs, generation);
  const sqlCommands = graph.commands.commandStore(generation);
  const sqlThreads = new owners.SqlThreadStore(store, graph.blobs, generation, graph.obligations);
  const sqlDecisions = new owners.SqlOperatorDecisionStore(store, ledger);
  const sqlInteractions = new owners.SqlInteractionStore(store, ledger);
  const commandRows = commands.records();
  c.equal(
    `command-order:${name}`,
    commandRows.map((row) => row.id),
    store
      .prepare("SELECT id FROM command WHERE pid=? ORDER BY rowid")
      .all(pid)
      .map((row: { id: string }) => row.id),
  );
  for (const row of commandRows) c.equal(`command:${name}:${row.id}`, row, sqlCommands.get(row.id));
  compareBindings(
    c,
    store,
    pid,
    name,
    "command",
    expectedBindings(commands, "idByKeyDigest", "id"),
  );
  compareBindings(
    c,
    store,
    pid,
    name,
    "thread",
    expectedBindings(threads, "threadIdByKey", "threadId"),
  );
  compareBindings(c, store, pid, name, "turn", expectedBindings(threads, "turnIdByKey", "turnId"));
  compareBindings(c, store, pid, name, "decision", expectedBindings(decisions, "byKey", "runId"));
  for (const root of commands.prunedScopeRoots()) input.prunedRoots.add(root);

  const expectedState = Reflect.get(threads, "state") as {
    threads: Array<{ id: string }>;
    turns: unknown[];
    sessions: unknown[];
    checkpoints: unknown[];
  };
  const actualState = {
    threads: sqlThreads.allThreads(),
    sessions: sqlThreads.allSessions(),
    checkpoints: sqlThreads.allCheckpoints(),
    turns: store
      .prepare("SELECT body,prompt_sha FROM turn WHERE pid=? ORDER BY rowid")
      .all(pid)
      .map((row: any) => owners.hydrateTurn(row, graph.blobs)),
  };
  c.equal(`threads-state:${name}`, expectedState, actualState);
  if (name !== "global")
    for (const thread of expectedState.threads)
      c.equal(
        `head:${name}:${thread.id}`,
        input.headRevisions.get(thread.id) ?? 0,
        sqlThreads.revision(thread.id),
      );
  const expectedPending = privateMap(interactions, "pending");
  const runs = new Set<string>(
    [...expectedPending.values()].map((row) => (row as { runId: string }).runId),
  );
  for (const row of store.prepare("SELECT DISTINCT run_id FROM interaction WHERE pid=?").all(pid))
    runs.add(row.run_id);
  for (const run of runs)
    c.equal(
      `pending:${name}:${run}`,
      interactions.pendingForRun(run),
      sqlInteractions.pendingForRun(run),
    );
  for (const [run, value] of privateMap(decisions, "byRun"))
    c.equal(`decision:${name}:${run}`, value, sqlDecisions.get(run));
  c.equal(
    `decision-count:${name}`,
    privateMap(decisions, "byRun").size,
    Number(store.prepare("SELECT count(*) AS n FROM operator_decision WHERE pid=?").get(pid).n),
  );
  const terminals = old.daemonRunEventTerminalIndex.durableTerminalRunEvents(journal);
  const actualTerminals = new Map<string, unknown>(
    store
      .prepare("SELECT run_id FROM run_terminal WHERE pid=?")
      .all(pid)
      .map((row: { run_id: string }) => [
        row.run_id,
        owners.storedTerminal(store, row.run_id, pid),
      ]),
  );
  c.equal(`terminal:${name}`, terminals, actualTerminals);

  if (name === "global") {
    const projects = new old.daemonProjects.ProjectStore(journal);
    c.equal("projects:list", projects.list(), graph.projects.list());
    for (const project of projects.list()) {
      input.activeProjects.add(project.id);
      c.equal(
        `projects:nesting:${project.id}`,
        projects.nestingFor(project.id),
        graph.projects.nestingFor(project.id),
      );
    }
    compareBindings(
      c,
      store,
      pid,
      name,
      "project",
      expectedBindings(projects, "registrationByKey", "projectId"),
    );
    const heads = new old.daemonThreadHeadPing.ThreadHeadPingEmitter(journal);
    for (const [id, revision] of privateMap(heads, "revisions"))
      input.headRevisions.set(id, revision);
    // Global threads were inspected before this map was available.
    for (const thread of expectedState.threads)
      c.equal(
        `global-head:${thread.id}`,
        heads.revision(thread.id),
        sqlThreads.revision(thread.id),
      );
    const quota = new old.daemonQuotaRegistry.QuotaRegistry(journal, [], () => new Date(input.now));
    c.equal("quota:read", quota.read(), graph.quota.read());
    c.equal("quota:resources", quota.readResources(), graph.quota.readResources());
    c.equal(
      "quota:freshness",
      quota.readConstraintFreshness(),
      graph.quota.readConstraintFreshness(),
    );
    c.equal(
      "quota:signature",
      Reflect.get(quota, "lastPublishedProjectionSignature"),
      Reflect.get(graph.quota, "lastPublishedProjectionSignature"),
    );
    const setup = new old.cliSetupJobStore.SetupJobStore(referenceRoot, {
      journal,
      now: () => new Date(input.now),
    });
    const sqlSetup = new owners.SqlSetupJobStore(sqlRoot, store, ledger);
    c.equal("setup:list", setup.list(), sqlSetup.list());
    compareBindings(c, store, pid, name, "setup", expectedBindings(setup, "createByKey", "jobId"));
    for (const job of setup.list()) {
      c.equal(
        `setup:snapshot:${job.jobId}`,
        setup.snapshot(job.jobId),
        sqlSetup.snapshot(job.jobId),
      );
      c.equal(`setup:events:${job.jobId}`, setup.events(job.jobId), sqlSetup.events(job.jobId));
      for (const event of setup.events(job.jobId))
        c.equal(
          `setup:resume:${job.jobId}:${event.sequence}`,
          setup.events(job.jobId, event.cursor),
          sqlSetup.events(job.jobId, event.cursor),
        );
    }
  }
  const served = owners.isServedPid(store, pid);
  const expectedServed =
    name === "global" || (name.startsWith("project:") && input.activeProjects.has(name.slice(8)));
  c.equal(`visibility:${name}`, expectedServed, served);
  if (served) {
    c.equal(`threads-public:${name}`, threads.listThreads(), sqlThreads.listThreads());
    c.equal(
      `threads-purged:${name}`,
      threads.listThreads("purged"),
      sqlThreads.listThreads("purged"),
    );
    for (const thread of expectedState.threads) {
      c.equal(
        `turns-public:${name}:${thread.id}`,
        threads.turnsFor(thread.id),
        sqlThreads.turnsFor(thread.id),
      );
      c.equal(
        `sessions-public:${name}:${thread.id}`,
        threads.sessionsForThread(thread.id),
        sqlThreads.sessionsForThread(thread.id),
      );
      c.equal(
        `checkpoints-public:${name}:${thread.id}`,
        threads.laneCheckpointsForThread(thread.id),
        sqlThreads.laneCheckpointsForThread(thread.id),
      );
    }
  }
  const retained = records.filter((row) => row.type !== "thread.entities_upserted"); // R5 §9: the single immediate imported stream difference.
  c.equal(
    `stream-count:${name}`,
    retained.length,
    Number(store.prepare("SELECT count(*) AS n FROM event WHERE pid=?").get(pid).n),
  );
  const max = journal.currentSequence();
  let seed = 0x5eed;
  const positions = [0, max, retained.at(-1)?.seq ?? 0];
  for (let i = 0; i < 100; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    positions.push(seed % (max + 1));
  }
  const types = [...new Set(retained.map((row) => row.type))];
  for (const seq of positions) {
    const cursor = journal.cursorAt(seq);
    c.equal(
      `cursor:${name}:${seq}`,
      seq,
      owners.decodeJournalCursor(cursor, name, generation.epoch, generation.nextSeq),
    );
    const expected = retained.filter((row) => row.seq > seq);
    if (served)
      c.equal(
        `events-public:${name}:${seq}`,
        expected.map((row) => ({
          schemaVersion: 1,
          cursor: journal.cursorFor(row),
          partition: name,
          type: row.type,
          observedAt: row.time,
          payload: row.payload,
        })),
        owners.readJournalEvents(store, name, cursor, graph.blobs),
      );
    else
      c.equal(
        `events-retained:${name}:${seq}`,
        expected.map(tuple),
        ledger.records(seq, types).map(tuple),
      );
  }
  for (const [label, cursor] of [
    ["stale", owners.encodeJournalCursor(name, "different-epoch", 0)],
    ["foreign", owners.encodeJournalCursor("other", generation.epoch, 0)],
    ["ahead", owners.encodeJournalCursor(name, generation.epoch, max + 1)],
  ]) {
    const error = (fn: () => unknown) => {
      try {
        fn();
        return null;
      } catch (e) {
        const value = e as Error & {
          code?: string;
          status?: number;
          retryable?: boolean;
          requiredActions?: unknown;
        };
        return {
          message: value.message,
          code: value.code,
          status: value.status,
          retryable: value.retryable,
          requiredActions: value.requiredActions,
        };
      }
    };
    c.equal(
      `cursor-error:${name}:${label}`,
      error(() => journal.sequenceAfter(cursor)),
      error(() => owners.decodeJournalCursor(cursor, name, generation.epoch, generation.nextSeq)),
    );
  }
  return {
    events: retained.length,
    cursorChecks: positions.length,
    commands: commandRows.length,
    threads: expectedState.threads.length,
    served,
  };
}

export function compareResources(input: {
  c: Comparisons;
  owners: Owners;
  store: any;
  graph: any;
  referenceRoot: string;
  sqlRoot: string;
  sourcePresent: boolean;
  knownFinalizeTargets: Map<string, string>;
}) {
  const { c, owners, store, graph, referenceRoot, sqlRoot } = input;
  const reference = new old.daemonResourceStore.ResourceStore(
    join(referenceRoot, "resource-store"),
  );
  c.equal(
    "resources:model-list",
    reference.listModelResources(),
    graph.resources.listModelResources(),
  );
  const dir = join(referenceRoot, "resource-store/resources");
  let resources = 0,
    bindings = 0,
    createAdoptions = 0,
    finalizeAdoptions = 0;
  for (const name of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const id = name.slice(0, -5),
      expected = Reflect.get(reference, "metadata").call(reference, id);
    c.equal(
      `resource:${id}`,
      expected,
      Reflect.get(graph.resources, "metadata").call(graph.resources, id),
    );
    const sha = expected.sha256.slice(7);
    c.equal(
      `resource-bytes:${id}`,
      readFileSync(join(referenceRoot, "resource-store/blobs", sha)),
      readFileSync(join(sqlRoot, "resource-store/blobs", sha)),
    );
    if (expected.purpose === "model") {
      const ref = { resourceId: id, sha256: expected.sha256, sizeBytes: expected.sizeBytes };
      c.equal(`resource-read:${id}`, reference.readModel(ref), graph.resources.readModel(ref));
    } else {
      const a = reference.resolve([{ resourceId: id }])[0]!,
        b = graph.resources.resolve([{ resourceId: id }])[0]!;
      c.equal(
        `attachment-location-reference:${id}`,
        join(referenceRoot, "resource-store/blobs", sha),
        a.path,
      );
      c.equal(`attachment-location-sql:${id}`, join(sqlRoot, "resource-store/blobs", sha), b.path);
      // All persisted attachment facts are checked against each concrete root;
      // no path is removed or rewritten in either observed object.
      const fields = {
        resource_id: id,
        kind: expected.kind,
        mime: expected.mime,
        name: expected.name,
        sha256: expected.sha256,
        size_bytes: expected.sizeBytes,
      };
      c.equal(
        `attachment-reference:${id}`,
        { ...fields, path: join(referenceRoot, "resource-store/blobs", sha) },
        a,
      );
      c.equal(
        `attachment-sql:${id}`,
        { ...fields, path: join(sqlRoot, "resource-store/blobs", sha) },
        b,
      );
    }
    resources++;
  }
  const sqlBindings = new owners.UploadBindings(store);
  for (const [operation, property] of [
    ["create", "createIdempotency"],
    ["finalize", "finalizeIdempotency"],
  ]) {
    for (const [key, raw] of privateMap(reference, property!)) {
      const expected = raw as { requestDigest: string; result: unknown },
        digest = owners.uploadKeyDigest(operation, key);
      const actual = sqlBindings.readLegacy(operation, key, digest);
      c.equal(`upload-binding:${operation}:${digest}`, { operation, key, ...expected }, actual);
      bindings++;
      if (operation === "create") {
        const saved = sqlBindings.lookup(operation, key, expected.requestDigest);
        c.equal(
          `upload-adoption:${digest}`,
          {
            requestDigest: expected.requestDigest,
            result: expected.result,
            targetId: (expected.result as { uploadId: string }).uploadId,
          },
          { requestDigest: saved?.requestDigest, result: saved?.result, targetId: saved?.targetId },
        );
        createAdoptions++;
      } else if (input.knownFinalizeTargets.has(key)) {
        const id = input.knownFinalizeTargets.get(key)!;
        c.equal(
          `upload-finalize-replay:${digest}`,
          reference.finalize(id, undefined, key),
          graph.resources.finalize(id, undefined, key),
        );
        finalizeAdoptions++;
      }
    }
  }
  for (const [id] of privateMap(reference, "uploads"))
    c.equal(`upload-status:${id}`, reference.status(id), graph.resources.status(id));
  return {
    sourcePresent: input.sourcePresent,
    resources,
    bindings,
    createAdoptions,
    finalizeAdoptions,
    finalizeTargetDisclosure:
      "Legacy finalize receipts do not store an upload id; exact point-read receipts are compared without inventing a target.",
  };
}
