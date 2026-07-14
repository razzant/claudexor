import {
  appendFileSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DurableJournal } from "@claudexor/journal";
import type { ControlSetupJob } from "@claudexor/schema";
import { SetupJobStore } from "./setup-job-store.js";

let root: string;
const job = (jobId: string, phase: ControlSetupJob["phase"] = "preparing"): ControlSetupJob => ({
  jobId,
  harness: "codex",
  action: "login",
  state: "queued",
  phase,
  command: null,
  guideUrl: null,
  message: "waiting",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  authCapability: {
    attemptId: `attempt-${jobId}`,
    challengeDigest: "a".repeat(64),
    requestDigest: "b".repeat(64),
    disclosure: {
      schemaVersion: 1,
      protocolVersion: 1,
      harness: "codex",
      requested: "subscription",
      requiredRoute: "vendor_native",
      requiredSource: "native_session",
      networkScope: "selected_harness_only",
      billingKnowledge: "unknown",
      incrementalCostKnowledge: "unknown",
      mayConsumeQuota: true,
      generatedAt: "2026-01-01T00:00:00.000Z",
    },
    state: "disclosed",
  },
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "setup-store-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("SetupJobStore global-journal authority", () => {
  it("does not read, migrate, chmod, or mutate any v1 setup bytes", () => {
    const legacyRoot = join(root, "setup-jobs");
    const legacyJobDir = join(legacyRoot, "jobs", "setup-legacy");
    mkdirSync(legacyJobDir, { recursive: true, mode: 0o755 });
    const legacyRegistry = join(legacyRoot, "jobs.json");
    const legacySnapshot = join(legacyJobDir, "job.json");
    writeFileSync(legacyRegistry, JSON.stringify([job("setup-legacy")], null, 4) + "\n", {
      mode: 0o644,
    });
    writeFileSync(legacySnapshot, JSON.stringify(job("setup-legacy")) + "\n", { mode: 0o640 });
    const before = [
      [legacyRegistry, readFileSync(legacyRegistry), statSync(legacyRegistry).mode & 0o777],
      [legacySnapshot, readFileSync(legacySnapshot), statSync(legacySnapshot).mode & 0o777],
    ] as const;

    const store = new SetupJobStore(root);
    store.create(job("setup-new"));
    expect(store.list().map((row) => row.jobId)).toEqual(["setup-new"]);
    for (const [path, bytes, mode] of before) {
      expect(readFileSync(path)).toEqual(bytes);
      expect(statSync(path).mode & 0o777).toBe(mode);
    }
  });

  it("persists lifecycle only in the journal, never job.json/events.jsonl/meta snapshots", () => {
    const store = new SetupJobStore(root);
    store.create(job("setup-a"));
    store.update("setup-a", {
      state: "waiting_for_input",
      message: "updated",
      phase: "launching",
      startedAt: "2026-01-01T00:00:01.000Z",
    });
    store.appendLog("setup-a", "redacted operational log");
    expect(readdirSync(store.paths("setup-a").dir).sort()).toEqual([]);
    expect(readdirSync(store.paths("setup-a").dir).join("\n")).not.toMatch(
      /job\.json|events\.jsonl|meta|snapshot/,
    );

    const reopened = new SetupJobStore(root);
    expect(reopened.status("setup-a")).toMatchObject({ message: "updated", phase: "launching" });
  });

  it("uses the opaque global journal cursor for exact replay after restart", () => {
    const store = new SetupJobStore(root);
    store.create(job("setup-a"));
    const first = store.events("setup-a")[0]!;
    expect(first.previousCursor).toBeNull();
    store.update("setup-a", {
      state: "waiting_for_input",
      message: "second",
      phase: "launching",
      startedAt: "2026-01-01T00:00:01.000Z",
    });

    const reopened = new SetupJobStore(root);
    const replay = reopened.events("setup-a", first.cursor);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({
      previousCursor: first.cursor,
      message: "second",
      job: { phase: "launching" },
    });
    expect(replay[0]?.cursor).not.toBe(first.cursor);
    expect(reopened.events("setup-a", replay[0]!.cursor)).toEqual([]);
  });

  it("builds a client-relative cursor chain across sparse global journal sequences", () => {
    const store = new SetupJobStore(root);
    store.create(job("setup-a"));
    const first = store.events("setup-a")[0]!;

    store.appendLog("setup-a", "unrelated-to-status-chain");
    store.create(job("setup-b"));
    store.update("setup-b", {
      state: "waiting_for_input",
      message: "other job",
      phase: "launching",
      startedAt: "2026-01-01T00:00:01.000Z",
    });
    store.update("setup-a", {
      state: "waiting_for_input",
      message: "second",
      phase: "launching",
      startedAt: "2026-01-01T00:00:01.000Z",
    });
    store.appendLog("setup-b", "another gap");
    store.update("setup-a", {
      state: "waiting_for_input",
      message: "third",
      phase: "awaiting_user",
    });

    const replay = store.events("setup-a", first.cursor);
    expect(replay).toHaveLength(2);
    expect(replay[0]).toMatchObject({ previousCursor: first.cursor, message: "second" });
    expect(replay[1]).toMatchObject({ previousCursor: replay[0]!.cursor, message: "third" });
    expect(replay[0]!.sequence).toBeGreaterThan(first.sequence + 1);
    expect(replay[1]!.sequence).toBeGreaterThan(replay[0]!.sequence + 1);

    const reopened = new SetupJobStore(root);
    expect(reopened.events("setup-a", first.cursor)).toEqual(replay);
  });

  it("anchors the first event to a snapshot cursor even when unrelated records advance the journal", () => {
    const store = new SetupJobStore(root);
    store.create(job("setup-a"));
    const snapshot = store.snapshot("setup-a");
    store.create(job("setup-b"));
    store.appendLog("setup-b", "global sequence gap");
    store.update("setup-a", {
      state: "waiting_for_input",
      message: "after snapshot",
      phase: "launching",
      startedAt: "2026-01-01T00:00:01.000Z",
    });

    const [event] = store.events("setup-a", snapshot.cursor);
    expect(event).toMatchObject({ previousCursor: snapshot.cursor, message: "after snapshot" });
    expect(event!.sequence).toBeGreaterThan(snapshot.sequence + 1);
  });

  it("fails closed on full-frame corruption and does not repair or overwrite bytes", () => {
    const store = new SetupJobStore(root);
    store.create(job("setup-a"));
    const corrupted = readFileSync(store.journal.path);
    corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
    writeFileSync(store.journal.path, corrupted, { mode: 0o600 });

    const reopened = new SetupJobStore(root);
    expect(reopened.recoveryState().status).toBe("recovery_required");
    expect(() => reopened.create(job("setup-b"))).toThrow(/requires recovery/);
    expect(readFileSync(store.journal.path)).toEqual(corrupted);
  });

  it("marks a checksummed but semantically invalid setup record recovery_required", () => {
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    journal.append("setup.job.saved", { job: { jobId: "not-a-valid-setup-job" } });
    const store = new SetupJobStore(root);
    expect(store.recoveryState()).toMatchObject({
      status: "recovery_required",
      reason: expect.stringContaining("invalid setup.job.saved payload"),
    });
    const exposed = store.recoveryState();
    (exposed as { status: string }).status = "ready";
    expect(store.recoveryState().status).toBe("recovery_required");
    expect(() => store.create(job("setup-b"))).toThrow(/requires recovery/);
  });

  it("does not acknowledge a torn tail over a semantically corrupt surviving history", () => {
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    journal.append("setup.job.saved", { job: { jobId: "not-a-valid-setup-job" } });
    appendFileSync(journal.path, Buffer.from([0x43, 0x4c, 0x58]));
    const unexplained = readFileSync(journal.path);

    const store = new SetupJobStore(root);
    expect(store.recoveryState()).toMatchObject({
      status: "recovery_required",
      reason: expect.stringContaining("unexplained suffix"),
    });
    expect(() => store.journal.records()).toThrow(/requires recovery/);
    // No prepared HEAD intent exists, so these bytes are an unexplained
    // external mutation, not an automatically discardable torn append.
    expect(readdirSync(store.journal.partitionDir)).not.toContain("tail-recovery.pending.json");
    expect(readFileSync(store.journal.path)).toEqual(unexplained);
  });

  it("refuses a symlink artifact root and never follows obsolete log sidecars", () => {
    const actual = join(root, "actual-artifacts");
    mkdirSync(actual);
    const linkedRoot = join(root, "setup-artifacts");
    symlinkSync(actual, linkedRoot);
    expect(() => new SetupJobStore(root)).toThrow(/unsafe|not canonical|not a real directory/);
    rmSync(linkedRoot);

    const store = new SetupJobStore(root);
    const paths = store.paths("setup-safe");
    mkdirSync(paths.dir, { mode: 0o700 });
    const outside = join(root, "outside");
    const obsoleteLog = join(paths.dir, "job.log");
    writeFileSync(outside, "do-not-touch");
    symlinkSync(outside, obsoleteLog);
    store.create(job("setup-safe"));
    expect(() => store.appendLog("setup-safe", "journal-only-log")).not.toThrow();
    expect(readFileSync(outside, "utf8")).toBe("do-not-touch");

    rmSync(obsoleteLog);
    linkSync(outside, obsoleteLog);
    expect(() => store.appendLog("setup-safe", "journal-only-hardlink-log")).not.toThrow();
    expect(readFileSync(outside, "utf8")).toBe("do-not-touch");
  });

  it("retains terminal history and filters active projections without destructive pruning", () => {
    const store = new SetupJobStore(root);
    for (let index = 0; index < 510; index += 1) {
      const id = `setup-terminal-${String(index).padStart(3, "0")}`;
      store.create({
        ...job(id),
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
      store.update(id, {
        state: "failed",
        phase: "completed",
        finishedAt: new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString(),
        outcome: { reason: "launch_failed" },
      });
    }
    store.create(job("setup-active"));
    expect(store.list({ active: false })).toHaveLength(510);
    expect(store.list({ active: true }).map((row) => row.jobId)).toEqual(["setup-active"]);
    expect(new SetupJobStore(root).list()).toHaveLength(511);
  });
});
