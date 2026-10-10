import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DurableJournal,
  journalPartitionDirectory,
  type DurableJournalOptions,
  type FoldRecord,
  type JournalRecord,
} from "./store/test-support/fixtures/legacy/journal/index.js";
import { CredentialRoute, QuotaSource, type RunEvent } from "@claudexor/schema";
import { afterEach, describe, expect, it } from "vitest";
import { CommandStore } from "./store/test-support/fixtures/legacy/daemon/command-store.js";
import { InteractionStore } from "./store/test-support/fixtures/legacy/daemon/interactions.js";
import { journalFoldPolicy } from "./journal-fold-policy.js";
import { journaledRunEventCopy } from "./journaled-run-events.js";
import { OperatorDecisionStore } from "./store/test-support/fixtures/legacy/daemon/operator-decisions.js";
import { ProjectStore } from "./store/test-support/fixtures/legacy/daemon/projects.js";
import { QuotaRegistry } from "./quota-registry.js";
import { RunEventStore } from "./store/test-support/fixtures/legacy/daemon/run-events.js";
import { ThreadHeadPingEmitter } from "./store/test-support/fixtures/legacy/daemon/thread-head-ping.js";
import { ThreadStore } from "./store/test-support/fixtures/legacy/daemon/threads.js";

const roots: string[] = [];
const journals: DurableJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function view(type: string, payload: unknown, seq = 1): FoldRecord {
  return { seq, type, time: "2026-09-14T00:00:00.000Z", payload, byteLength: 1 };
}

const journalFoldVerdict = (record: FoldRecord) => journalFoldPolicy.verdict(record);

const NOW = new Date("2026-09-14T00:05:00.000Z");
const now = () => NOW;
const T0 = "2026-09-14T00:00:00.000Z";

type Snapshot = ReturnType<typeof snapshot>;

function snapshot(
  harness: string,
  subjectId: string | null,
  usedRatio: number,
  extra: Partial<{ source: string; applies: string[]; observed: string }> = {},
) {
  return {
    subject: {
      harness,
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: subjectId,
    },
    constraints: [
      {
        id: "five_hour",
        label: "5 hour",
        ...(extra.applies ? { applies_to_models: extra.applies } : {}),
        used_ratio: usedRatio,
        window_seconds: 18_000,
        resets_at: null,
        cooldown_until: null,
      },
    ],
    source: (extra.source ?? "claude_oauth_usage") as "claude_oauth_usage",
    observed_at: extra.observed ?? T0,
    freshness: "fresh" as const,
  };
}

const describeSnapshot = (value: Snapshot) =>
  `${value.subject.harness}/${value.subject.subject_id}@${value.constraints[0]!.used_ratio}`;

function runEvent(
  runId: string,
  type: RunEvent["type"],
  payload: Record<string, unknown> = {},
  seq = 1,
): RunEvent {
  return { seq, ts: T0, run_id: runId, task_id: `task-${runId}`, type, payload };
}

/** Builds a realistic global partition through the real projections. */
function buildFixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "claudexor-fold-policy-")));
  roots.push(root);
  const projectRoots = ["p1", "p2", "p2b"].map((name) => {
    const dir = join(root, name);
    mkdirSync(dir);
    return dir;
  });
  const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global", now });
  const projects = new ProjectStore(journal);
  const headPing = new ThreadHeadPingEmitter(journal);
  const threads = new ThreadStore(journal, (ping) => headPing.ping(ping));
  const commands = new CommandStore(journal, now);
  const interactions = new InteractionStore(journal);
  const decisions = new OperatorDecisionStore(journal);
  const runEvents = new RunEventStore(journal);
  const quota = new QuotaRegistry(journal, [], now);
  const record = (event: RunEvent) => runEvents.record(journaledRunEventCopy(event));
  const request = (runId: string, interactionId: string) =>
    interactions.request({
      runId,
      taskId: `task-${runId}`,
      attemptId: "a01",
      harnessId: "fake",
      request: { interaction_id: interactionId, source_tool: "AskUserQuestion", questions: [] },
      requestedAt: T0,
      timeoutAt: null,
    });

  // Registry: one kept project, one relinked then unregistered.
  const p1 = projects.register({
    root: projectRoots[0]!,
    idempotencyKey: "reg-1",
    clientId: "t",
  });
  const p2 = projects.register({
    root: projectRoots[1]!,
    idempotencyKey: "reg-2",
    clientId: "t",
  });
  projects.relink(p2.id, projectRoots[2]!);
  projects.unregister(p2.id);

  // A thread with a turn, session, lane checkpoint and rename (each pings).
  const thread = threads.createThread({ title: "" });
  const turn = threads.createTurn(thread.id, "First prompt of the thread");
  threads.recordSession(thread.id, "codex", "native-1", "gpt-5", null);
  threads.recordLaneCheckpoint(thread.id, "codex", null, turn.id);
  threads.updateThread(thread.id, { title: "Renamed" });

  const params = (prompt: string) => ({
    mode: "agent",
    prompt,
    scope: { kind: "project", root: projectRoots[0]! },
  });
  const commandKeys: Array<{ params: unknown; idempotencyKey: string; clientId: string }> = [];
  const accept = (id: string, value: unknown) => {
    const key = { params: value, idempotencyKey: `key-${id}`, clientId: "t" };
    commandKeys.push(key);
    return commands.accept({ id, ...key }).record;
  };

  // job-a: a full successful run with an answered question and a decision.
  accept("job-a", params("prompt a"));
  commands.update("job-a", {
    state: "running",
    startedAt: T0,
    runId: "run-a",
    taskId: "task-run-a",
  });
  record(runEvent("run-a", "run.created", { mode: "agent", prompt: "prompt a" }, 1));
  request("run-a", "int-1");
  record(runEvent("run-a", "interaction.requested", { interaction_id: "int-1" }, 2));
  interactions.resolve("run-a", "int-1", "answered");
  record(runEvent("run-a", "interaction.answered", { interaction_id: "int-1" }, 3));
  record(runEvent("run-a", "output.ready", { kind: "answer", path: "final/answer.md" }, 4));
  record(runEvent("run-a", "run.completed", { lifecycle: "succeeded" }, 5));
  commands.update("job-a", {
    state: "succeeded",
    result: { lifecycle: "succeeded" },
    finishedAt: T0,
  });
  decisions.record(
    {
      runId: "run-a",
      action: "accept_risk",
      findingIds: ["f-1"],
      acceptedRisks: ["r-1"],
      patchSha256: `sha256:${"a".repeat(64)}`,
      decidedAt: T0,
    },
    { key: "decision-1", client: "t", request: { runId: "run-a" } },
  );

  // job-b: failed run whose question was still pending at the terminal (the
  // run_terminal resolution lands AFTER the terminal event); later pruned.
  accept("job-b", params("prompt b"));
  commands.update("job-b", {
    state: "running",
    startedAt: T0,
    runId: "run-b",
    taskId: "task-run-b",
  });
  record(runEvent("run-b", "run.created", { mode: "agent", prompt: "prompt b" }, 1));
  request("run-b", "int-4");
  record(runEvent("run-b", "interaction.requested", { interaction_id: "int-4" }, 2));
  record(runEvent("run-b", "run.failed", { lifecycle: "failed" }, 3));
  commands.update("job-b", { state: "failed", error: "boom", finishedAt: T0 });
  interactions.resolveRun("run-b", "run_terminal");

  // job-d: succeeded and pruned together with job-b.
  accept("job-d", params("prompt d"));
  commands.update("job-d", {
    state: "running",
    startedAt: T0,
    runId: "run-d",
    taskId: "task-run-d",
  });
  record(runEvent("run-d", "run.created", { mode: "agent", prompt: "prompt d" }, 1));
  record(runEvent("run-d", "run.completed", { lifecycle: "succeeded" }, 2));
  commands.update("job-d", { state: "succeeded", finishedAt: T0 });
  commands.prune(["job-b", "job-d"]);

  // job-m: a model-operation receipt, retained forever.
  accept("job-m", {
    kind: "model",
    request: { resourceId: "res-1", sha256: `sha256:${"b".repeat(64)}`, sizeBytes: 3 },
  });
  commands.update("job-m", { state: "running", startedAt: T0 });
  commands.update("job-m", {
    state: "succeeded",
    result: { lifecycle: "succeeded" },
    finishedAt: T0,
  });

  // job-c: still queued at the crash; run-c live with a pending question.
  accept("job-c", params("prompt c"));
  record(runEvent("run-c", "run.created", { mode: "ask", prompt: "prompt c" }, 1));
  request("run-c", "int-3");
  record(runEvent("run-c", "interaction.requested", { interaction_id: "int-3" }, 2));
  record(runEvent("run-c", "output.ready", { kind: "answer", path: "final/answer.md" }, 3));

  // job-e: the terminal committed but the command update never did (crash).
  accept("job-e", params("prompt e"));
  commands.update("job-e", {
    state: "running",
    startedAt: T0,
    runId: "run-e",
    taskId: "task-run-e",
  });
  record(runEvent("run-e", "run.created", { mode: "agent", prompt: "prompt e" }, 1));
  record(runEvent("run-e", "run.completed", { lifecycle: "succeeded" }, 2));

  // Quota: changes, scoped pairs, a cursor pair, a removal and a re-add, a
  // scoped pair superseded by a plain upsert (leaves one stale prepare), then
  // a raw upsert after the last marker (crash before its marker).
  quota.upsert(snapshot("claude", "work", 0.4));
  quota.upsert(snapshot("claude", "work", 0.5));
  quota.upsert(snapshot("claude", null, 0.3, { applies: ["fable"] }));
  quota.upsert(snapshot("claude", null, 0.6, { applies: ["fable"] }));
  quota.upsert(snapshot("claude", null, 0.65));
  quota.upsert(snapshot("claude", null, 0.8, { applies: ["fable"] }));
  quota.upsert(snapshot("cursor", "cur", 0.1, { source: "cursor_rate_limit" }));
  quota.upsert(snapshot("cursor", "cur", 0.2, { source: "cursor_rate_limit" }));
  quota.upsert(snapshot("codex", "x", 0.2));
  quota.removeSubject("claude", "work");
  quota.upsert(snapshot("claude", "work", 0.7));
  quota.upsert(snapshot("claude", "work", 0.75, { applies: ["fable"] }));
  quota.upsert(snapshot("claude", "work", 0.9));
  journal.append("quota.snapshot.upserted", snapshot("codex", "x", 0.3));

  headPing.ping({ threadId: thread.id, projectId: null });
  headPing.ping({ threadId: thread.id, projectId: null });
  journal.append("future.unknown", { keep: true });
  journal.append("journal.partition_quarantined", { schemaVersion: 1 });
  journal.close();
  return {
    root,
    commandKeys,
    runs: ["run-a", "run-b", "run-c", "run-d", "run-e"],
    threadId: thread.id,
    turnId: turn.id,
    projectId: p1.id,
    projectRoot: projectRoots[0]!,
  };
}

/** The fixture partition through the REAL reader twice: the written file with
 * the daemon fold, and a byte-identical copy without one — so the journal
 * engine itself, not a mirror of it, is what the proof runs on. `full` and
 * `retained` are the two retained sets as seen at open, before any replay. */
function openPair(root: string, prepare = false) {
  const source = join(root, "journal");
  const copy = join(root, "journal-plain");
  cpSync(source, copy, { recursive: true });
  chmodSync(copy, 0o700);
  chmodSync(journalPartitionDirectory(copy, "global"), 0o700);
  chmodSync(join(journalPartitionDirectory(copy, "global"), "journal.bin"), 0o600);
  const options: DurableJournalOptions = {
    rootDir: source,
    partition: "global",
    now,
    deferCompaction: true,
    fold: journalFoldPolicy,
  };
  const folded = prepare ? DurableJournal.prepare(options) : new DurableJournal(options);
  const plain = new DurableJournal({ ...options, rootDir: copy, fold: undefined });
  journals.push(folded, plain);
  return { folded, plain, full: plain.records(), retained: folded.records() };
}

/** A partition whose history carries one duplicate frame — exact for a
 * terminal and a request, a conflicting-digest twin for an acceptance — the
 * corruption the projections' own integrity checks exist for. */
function buildDuplicateFixture(kind: "terminal" | "request" | "accepted"): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "claudexor-fold-dup-")));
  roots.push(root);
  const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global", now });
  const runEvents = new RunEventStore(journal);
  const interactions = new InteractionStore(journal);
  runEvents.record(journaledRunEventCopy(runEvent("run-x", "run.created", { mode: "ask" }, 1)));
  if (kind === "accepted") {
    // Same id and idempotency key, conflicting request digest.
    const commands = new CommandStore(journal, now);
    commands.accept({
      id: "job-x",
      params: { mode: "ask" },
      idempotencyKey: "key-x",
      clientId: "t",
    });
    const [accepted] = journal.records<{ requestDigest: string }>(0, ["command.accepted"]);
    journal.append("command.accepted", {
      ...accepted!.payload,
      requestDigest: `sha256:${"f".repeat(64)}`,
    });
  } else if (kind === "terminal") {
    const terminal = runEvent("run-x", "run.completed", { lifecycle: "succeeded" }, 2);
    runEvents.record(terminal);
    runEvents.record(terminal);
  } else {
    interactions.request({
      runId: "run-x",
      taskId: "task-run-x",
      attemptId: "a01",
      harnessId: "fake",
      request: { interaction_id: "int-x", source_tool: "AskUserQuestion", questions: [] },
      requestedAt: T0,
      timeoutAt: null,
    });
    const [requested] = journal.records(0, ["interaction.requested"]);
    journal.append("interaction.requested", requested!.payload);
  }
  journal.close();
  return root;
}

function replay(journal: DurableJournal) {
  const commands = new CommandStore(journal, now);
  commands.validateProjection();
  const interactions = new InteractionStore(journal);
  interactions.validateProjection();
  const decisions = new OperatorDecisionStore(journal);
  decisions.validateProjection();
  const runEvents = new RunEventStore(journal);
  runEvents.validateProjection();
  const projects = new ProjectStore(journal);
  projects.validateProjection();
  const quota = new QuotaRegistry(journal, [], now);
  quota.validateProjection();
  const headPing = new ThreadHeadPingEmitter(journal);
  headPing.validateProjection();
  const threads = new ThreadStore(journal);
  threads.validateProjection();
  commands.recoverAfterStartup();
  interactions.recoverAfterStartup();
  quota.recoverAfterStartup();
  return { commands, interactions, decisions, runEvents, projects, quota, headPing, threads };
}

function observe(
  p: ReturnType<typeof replay>,
  f: ReturnType<typeof buildFixture>,
): Record<string, unknown> {
  return {
    commands: p.commands.records().sort((a, b) => a.id.localeCompare(b.id)),
    idempotency: f.commandKeys.map((key) => {
      try {
        return p.commands.find(key)?.id ?? null;
      } catch (error) {
        return String(error);
      }
    }),
    pending: f.runs.map((run) => p.interactions.pendingForRun(run)),
    decisions: f.runs.map((run) => p.decisions.get(run)),
    projects: p.projects.list(),
    projectByRoot: p.projects.findByRoot(f.projectRoot)?.id ?? null,
    // Snapshot ORDER is Map insertion order (a removal plus re-add already
    // reorders it today) and no consumer reads it positionally; compare the set.
    quota: {
      ...p.quota.read(),
      snapshots: [...p.quota.read().snapshots].sort((a, b) =>
        JSON.stringify([a.subject, a.source]).localeCompare(JSON.stringify([b.subject, b.source])),
      ),
    },
    revision: p.headPing.revision(f.threadId),
    threads: p.threads.listThreads(),
    turns: p.threads.turnsFor(f.threadId),
    sessions: p.threads.sessionsForThread(f.threadId),
    checkpoints: p.threads.laneCheckpointsForThread(f.threadId),
    resumeMap: p.threads.resumeMap(f.threadId),
  };
}

/** Recovery side effects appended after `seq`, with the one order-dependent
 * field masked: the quota marker digest covers the projection in
 * Map-insertion order (see `observe`). */
const appendedAfter = (journal: DurableJournal, seq: number) =>
  journal
    .records(seq)
    .map((record) => [
      record.type,
      record.type === "quota.projection.updated"
        ? { ...(record.payload as object), projection_signature: "<order-dependent>" }
        : record.payload,
    ]);

const ofType = (records: readonly JournalRecord[], type: string) =>
  records.filter((record) => record.type === type);

describe("journal fold policy verdicts", () => {
  it("is one frozen, stateless policy: the same record always gets the same verdict", () => {
    expect(Object.isFrozen(journalFoldPolicy)).toBe(true);
    const record = view("quota.snapshot.upserted", snapshot("claude", "work", 0.4), 7);
    expect(journalFoldVerdict(record)).toEqual(journalFoldVerdict({ ...record, seq: 3 }));
  });

  it("groups acceptances per id, slots updates; a prune tombstone forgets the ids and their runs, and survives per root set", () => {
    expect(journalFoldVerdict(view("command.accepted", { record: { id: "job-1" } }))).toEqual({
      group: "c:job-1:a",
    });
    expect(journalFoldVerdict(view("command.updated", { record: { id: "job-1" } }))).toEqual({
      slot: "c:job-1:u",
    });
    expect(
      journalFoldVerdict(
        view("command.pruned", {
          ids: ["job-1", "job-2"],
          roots: ["/b", "/a"],
          run_ids: ["run-1"],
        }),
      ),
    ).toEqual({
      slot: "c:pruned:/a\0/b",
      retire: [
        "c:job-1:a",
        "c:job-1:u",
        "c:job-2:a",
        "c:job-2:u",
        "r:run-1:t",
        "r:run-1:live",
        "r:run-1:c",
      ],
    });
    // A legacy tombstone (no roots, no run ids) forgets the commands only.
    expect(journalFoldVerdict(view("command.pruned", { ids: ["job-3"] }))).toEqual({
      slot: "c:pruned:",
      retire: ["c:job-3:a", "c:job-3:u"],
    });
    expect(journalFoldVerdict(view("command.pruned", { ids: [] }))).toEqual({});
  });

  it("keeps a run's terminal frames as a group (never a slot) and groups live progress", () => {
    for (const type of ["run.completed", "run.failed", "run.blocked"]) {
      expect(journalFoldVerdict(view("run.event", { run_id: "run-1", type }))).toEqual({
        group: "r:run-1:t",
        retire: ["r:run-1:live", "r:run-1:c"],
      });
    }
    expect(journalFoldVerdict(view("run.event", { run_id: "run-1", type: "run.created" }))).toEqual(
      {
        slot: "r:run-1:c",
      },
    );
    expect(
      journalFoldVerdict(view("run.event", { run_id: "run-1", type: "output.ready" })),
    ).toEqual({
      group: "r:run-1:live",
    });
    expect(journalFoldVerdict(view("run.event", { type: "output.ready" }))).toEqual({});
  });

  it("forgets a resolved interaction pair through its resolution", () => {
    expect(
      journalFoldVerdict(view("interaction.requested", { runId: "run-1", interactionId: "q-1" })),
    ).toEqual({ group: "i:run-1:q-1" });
    expect(
      journalFoldVerdict(
        view("interaction.resolved", {
          runId: "run-1",
          interactionIds: ["q-1", "q-2"],
          terminal: "run_terminal",
        }),
      ),
    ).toEqual({ drop: true, retire: ["i:run-1:q-1", "i:run-1:q-2"] });
  });

  it("keys quota by the legacy snapshot key in two slots per subject and retires per subject", () => {
    expect(journalFoldVerdict(view("quota.projection.updated", {}))).toEqual({ slot: "q:marker" });
    const key = `q:${["claude", "vendor_native", "work", "claude_oauth_usage"].join("\0")}`;
    expect(
      journalFoldVerdict(view("quota.snapshot.upserted", snapshot("claude", "work", 0.4))),
    ).toEqual({ slot: `${key}:u` });
    // A scoped prepare is keyed by the LEGACY base its commit carries on the
    // wire, so the prepare slot and the upsert slot share one subject key.
    const scoped = snapshot("cursor", "cur", 0.1, { source: "cursor_rate_limit" });
    const legacyKey = `q:${["cursor", "vendor_native", "cur", "claude_api_retry"].join("\0")}`;
    expect(
      journalFoldVerdict(
        view("quota.snapshot.scoped_prepared", { version: 1, base_hash: "x", snapshot: scoped }),
      ),
    ).toEqual({ slot: `${legacyKey}:p` });
    expect(
      journalFoldVerdict(
        view("quota.snapshot.upserted", { ...scoped, source: "claude_api_retry" }),
      ),
    ).toEqual({ slot: `${legacyKey}:u` });
    const removed = journalFoldVerdict(
      view("quota.subject.removed", { harness: "claude", subject_id: null }),
    );
    expect(removed.slot).toBe("q:claude\0:removed");
    expect(removed.retire).toContain('q:windows:["claude",null]');
    expect(removed.retire).toHaveLength(
      1 + 2 * CredentialRoute.options.length * QuotaSource.options.length,
    );
    const nullKey = `q:${["claude", "vendor_native", "", "claude_oauth_usage"].join("\0")}`;
    expect(removed.retire).toContain(`${nullKey}:p`);
    expect(removed.retire).toContain(`${nullKey}:u`);
    expect(journalFoldVerdict(view("quota.snapshot.upserted", { not: "a snapshot" }))).toEqual({});
    expect(
      journalFoldVerdict(view("quota.snapshot.scoped_prepared", { version: 1, snapshot: {} })),
    ).toEqual({});
  });

  it("keeps the latest head ping per thread, keeps setup saves and retires terminal logs", () => {
    expect(journalFoldVerdict(view("thread.head.updated", { thread_id: "th-1" }))).toEqual({
      slot: "t:th-1",
    });
    expect(journalFoldVerdict(view("setup.job.log", { jobId: "setup-1", line: "x" }))).toEqual({
      group: "s:setup-1:log",
    });
    expect(
      journalFoldVerdict(view("setup.job.saved", { job: { jobId: "setup-1", state: "running" } })),
    ).toEqual({});
    expect(
      journalFoldVerdict(
        view("setup.job.saved", { job: { jobId: "setup-1", state: "succeeded" } }),
      ),
    ).toEqual({ retire: ["s:setup-1:log"] });
  });

  it("keeps everything it cannot classify and never throws", () => {
    for (const type of [
      "thread.entities_upserted",
      "project.registered",
      "operator.decision_recorded",
      "journal.recovery_tail_discarded",
      "setup.job.create_bound",
      "future.unknown",
    ]) {
      expect(journalFoldVerdict(view(type, { anything: true }))).toEqual({});
    }
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("poisoned payload");
        },
      },
    );
    expect(journalFoldVerdict(view("command.accepted", hostile))).toEqual({});
    expect(journalFoldVerdict(view("run.event", null))).toEqual({});
  });
});

describe("journal fold policy replay equivalence", () => {
  it("replays the folded partition to the same validated state as the full history", () => {
    const f = buildFixture();
    const { folded, plain, full, retained } = openPair(f.root);
    expect(retained.length).toBeLessThan(full.length);
    expect(folded.retiredAtReplay().count).toBe(full.length - retained.length);
    expect(folded.retiredAtReplay().bytes).toBeGreaterThan(0);
    expect(plain.retiredAtReplay()).toEqual({ count: 0, bytes: 0 });
    // Chain state comes from the disk in both: same epoch, same next sequence.
    expect(folded.currentSequence()).toBe(plain.currentSequence());
    expect(folded.currentEpoch()).toBe(plain.currentEpoch());
    // The fold only removes: every survivor is the exact original frame, in order.
    const bySeq = new Map(full.map((record) => [record.seq, record]));
    for (const record of retained) expect(record).toEqual(bySeq.get(record.seq));
    expect(retained.map((record) => record.seq)).toEqual(
      [...retained.map((record) => record.seq)].sort((a, b) => a - b),
    );

    const seqAtOpen = plain.currentSequence();
    const fullState = replay(plain);
    const foldedState = replay(folded);
    expect(observe(foldedState, f)).toEqual(observe(fullState, f));
    expect(foldedState.commands.prunedScopeRoots()).toEqual([f.projectRoot]);
    // Recovery side effects (interrupted commands and questions, the quota
    // recovery marker) are identical, and both continue the disk chain.
    expect(appendedAfter(folded, seqAtOpen)).toEqual(appendedAfter(plain, seqAtOpen));
    expect(plain.records(seqAtOpen).map((record) => record.type)).toEqual([
      "command.updated",
      "command.updated",
      "interaction.resolved",
      "quota.projection.updated",
    ]);
    expect(folded.currentSequence()).toBe(plain.currentSequence());
    // The crash-recovery path still finds run-e's durable terminal after the fold.
    expect(foldedState.commands.get("job-e")).toMatchObject({
      state: "interrupted",
      errorCode: "legacy_terminal_recovery_unavailable",
    });
    expect(foldedState.commands.get("job-c")).toMatchObject({ state: "interrupted" });
    // Disclosed delta: a settled question of a finished run reads "missing"
    // instead of "resolved" once its pair is forgotten (both are non-delivery).
    expect(fullState.interactions.status("run-a", "int-1")).toBe("resolved");
    expect(foldedState.interactions.status("run-a", "int-1")).toBe("missing");
  });

  it("prepares read-only, then activates, to the same retained set and state", () => {
    const f = buildFixture();
    const { folded, plain, full, retained } = openPair(f.root, true);
    const shape = (records: readonly { seq: number; type: string }[]) =>
      records.map((record) => [record.seq, record.type]);
    expect(folded.retiredAtReplay().count).toBe(full.length - retained.length);
    folded.activatePrepared();
    expect(shape(folded.records())).toEqual(shape(retained));
    expect(folded.retiredAtReplay().count).toBe(full.length - retained.length);
    expect(folded.currentSequence()).toBe(plain.currentSequence());
    const seqAtOpen = plain.currentSequence();
    const foldedState = replay(folded);
    expect(observe(foldedState, f)).toEqual(observe(replay(plain), f));
    expect(appendedAfter(folded, seqAtOpen)).toEqual(appendedAfter(plain, seqAtOpen));
    expect(foldedState.commands.prunedScopeRoots()).toEqual([f.projectRoot]);
  });

  it("keeps duplicate terminal and request frames so a folded replay fails as loudly as the plain one", () => {
    const failure = (open: () => unknown) => {
      try {
        open();
      } catch (error) {
        return { name: (error as Error).constructor.name, message: (error as Error).message };
      }
      throw new Error("expected the projection to refuse the duplicate");
    };
    {
      const { folded, plain, retained } = openPair(buildDuplicateFixture("terminal"));
      expect(
        ofType(retained, "run.event").map((r) => (r.payload as { type: string }).type),
      ).toEqual(["run.completed", "run.completed"]);
      const expected = failure(() => new RunEventStore(plain));
      expect(expected).toEqual({
        name: "Error",
        message: "multiple durable terminal events for run run-x",
      });
      expect(failure(() => new RunEventStore(folded))).toEqual(expected);
    }
    {
      const { folded, plain, retained } = openPair(buildDuplicateFixture("request"));
      expect(ofType(retained, "interaction.requested")).toHaveLength(2);
      const expected = failure(() => new InteractionStore(plain));
      expect(expected).toEqual({ name: "Error", message: "duplicate interaction request history" });
      expect(failure(() => new InteractionStore(folded))).toEqual(expected);
    }
    {
      const { folded, plain, retained } = openPair(buildDuplicateFixture("accepted"));
      expect(ofType(retained, "command.accepted")).toHaveLength(2);
      const replayCommands = (journal: DurableJournal) => () =>
        new CommandStore(journal, now).validateProjection();
      const expected = failure(replayCommands(plain));
      expect(expected).toEqual({
        name: "Error",
        message: "conflicting command idempotency history",
      });
      expect(failure(replayCommands(folded))).toEqual(expected);
    }
  });

  it("never leaves a partial pair, a headless update, two terminals or a pruned run behind", () => {
    const f = buildFixture();
    const { full, retained } = openPair(f.root);
    const types = (type: string) => ofType(retained, type);
    const accepted = new Set(
      types("command.accepted").map((r) => (r.payload as { record: { id: string } }).record.id),
    );
    for (const update of types("command.updated")) {
      expect(accepted.has((update.payload as { record: { id: string } }).record.id)).toBe(true);
    }
    expect([...accepted].sort()).toEqual(["job-a", "job-c", "job-e", "job-m"]);
    // The prune tombstone survives with the pruned commands' roots (crash-GC)
    // and run ids (the runs' journaled events go with the commands).
    expect(types("command.pruned").map((r) => r.payload)).toEqual([
      { ids: ["job-b", "job-d"], roots: [f.projectRoot], run_ids: ["run-b", "run-d"] },
    ]);
    const terminals = types("run.event")
      .map((r) => r.payload as { run_id: string; type: string })
      .filter((e) => ["run.completed", "run.failed", "run.blocked"].includes(e.type));
    expect(new Set(terminals.map((e) => e.run_id)).size).toBe(terminals.length);
    // A finished run keeps exactly its terminal; a live run keeps its
    // progress; a pruned command's run keeps nothing.
    const eventsOf = (run: string) =>
      types("run.event")
        .map((r) => r.payload as { run_id: string; type: string })
        .filter((e) => e.run_id === run)
        .map((e) => e.type);
    expect(eventsOf("run-a")).toEqual(["run.completed"]);
    expect(eventsOf("run-e")).toEqual(["run.completed"]);
    expect(eventsOf("run-c")).toEqual(["run.created", "interaction.requested", "output.ready"]);
    expect(eventsOf("run-b")).toEqual([]);
    expect(eventsOf("run-d")).toEqual([]);
    // Interaction pairs: no resolution survives, and every surviving request is
    // one the full history still had pending.
    expect(types("interaction.resolved")).toEqual([]);
    expect(
      types("interaction.requested").map(
        (r) => (r.payload as { interactionId: string }).interactionId,
      ),
    ).toEqual(["int-3"]);
    // Quota: per subject the latest prepare and the latest upsert survive. A
    // retained upsert whose disk predecessor was a prepare keeps that prepare
    // (the pair replays adjacent); a prepare whose commit a later plain upsert
    // superseded is the one stale frame per subject the scheme tolerates.
    const fullBySeq = new Map(full.map((record) => [record.seq, record]));
    const retainedSeqs = new Set(retained.map((record) => record.seq));
    const prepares = types("quota.snapshot.scoped_prepared");
    const upserts = types("quota.snapshot.upserted");
    const preparedSnapshot = (r: JournalRecord) => (r.payload as { snapshot: Snapshot }).snapshot;
    expect(prepares.map((r) => describeSnapshot(preparedSnapshot(r)))).toEqual([
      "claude/null@0.8",
      "cursor/cur@0.2",
      "claude/work@0.75",
    ]);
    expect(upserts.map((r) => describeSnapshot(r.payload as Snapshot))).toEqual([
      "claude/null@0.8",
      "cursor/cur@0.2",
      "claude/work@0.9",
      "codex/x@0.3",
    ]);
    for (const upsert of upserts) {
      if (fullBySeq.get(upsert.seq - 1)?.type === "quota.snapshot.scoped_prepared") {
        expect(retainedSeqs.has(upsert.seq - 1)).toBe(true);
      }
    }
    const stale = prepares.filter((prepare) => !retainedSeqs.has(prepare.seq + 1));
    expect(stale.map((r) => describeSnapshot(preparedSnapshot(r)))).toEqual(["claude/work@0.75"]);
    for (const prepare of stale) {
      expect(fullBySeq.get(prepare.seq + 1)?.type).toBe("quota.snapshot.upserted");
    }
    expect(types("quota.subject.removed")).toHaveLength(1);
    expect(types("quota.projection.updated")).toHaveLength(1);
    expect(types("thread.head.updated")).toHaveLength(1);
    expect(types("future.unknown")).toHaveLength(1);
    expect(types("journal.partition_quarantined")).toHaveLength(1);
  });
});
