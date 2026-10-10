import { chmodSync, cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalFoldPolicy } from "@claudexor/daemon";
import {
  DurableJournal,
  journalPartitionDirectory,
} from "../../daemon/src/store/test-support/fixtures/legacy/journal/index.js";
import type { ControlSetupJob } from "@claudexor/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SetupJobStore } from "../../daemon/src/store/test-support/fixtures/legacy/cli/setup-job-store.js";

let root: string;
let plainRoot: string;
const journals: DurableJournal[] = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "setup-store-fold-")));
  plainRoot = realpathSync(mkdtempSync(join(tmpdir(), "setup-store-plain-")));
});
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(plainRoot, { recursive: true, force: true });
});

const job = (jobId: string): ControlSetupJob => ({
  jobId,
  harness: "codex",
  action: "login",
  transport: "daemon",
  state: "queued",
  phase: "preparing",
  command: null,
  guideUrl: null,
  message: "waiting",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  profileId: null,
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

/** Open the same written partition twice through the REAL reader: once with
 * the daemon fold, once without, so the journal engine itself is under test. */
function openPair(): { folded: DurableJournal; plain: DurableJournal } {
  const source = join(root, "journal");
  const copy = join(plainRoot, "journal");
  cpSync(source, copy, { recursive: true });
  chmodSync(copy, 0o700);
  chmodSync(journalPartitionDirectory(copy, "global"), 0o700);
  const common = { partition: "global", deferCompaction: true } as const;
  const folded = new DurableJournal({ rootDir: source, ...common, fold: journalFoldPolicy });
  const plain = new DurableJournal({ rootDir: copy, ...common });
  journals.push(folded, plain);
  return { folded, plain };
}

describe("journal fold policy over the setup lifecycle projection", () => {
  it("keeps every saved transition (the reducer validates them) and forgets terminal logs", () => {
    const store = new SetupJobStore(root);
    const idempotency = { key: "create-a", client: "test", request: { harness: "codex" } };
    store.create(job("setup-a"), idempotency);
    store.appendLog("setup-a", "launching");
    store.update("setup-a", {
      state: "waiting_for_input",
      message: "awaiting",
      phase: "launching",
      startedAt: "2026-01-01T00:00:01.000Z",
    });
    store.appendLog("setup-a", "still going");
    store.update("setup-a", {
      state: "failed",
      phase: "completed",
      finishedAt: "2026-01-01T00:00:02.000Z",
      outcome: { reason: "launch_failed" },
    });
    store.appendLog("setup-a", "after terminal");
    store.create(job("setup-b"));
    store.appendLog("setup-b", "active job log");
    store.journal.close();

    const { folded, plain } = openPair();
    const full = plain.records();
    const retained = folded.records();
    expect(folded.retiredAtReplay().count).toBe(full.length - retained.length);
    expect(folded.currentSequence()).toBe(plain.currentSequence());
    const types = (type: string) => retained.filter((record) => record.type === type);
    expect(types("setup.job.saved")).toHaveLength(
      full.filter((r) => r.type === "setup.job.saved").length,
    );
    expect(types("setup.job.create_bound")).toEqual(
      full.filter((r) => r.type === "setup.job.create_bound"),
    );
    expect(
      types("setup.job.log").map((record) => (record.payload as { line: string }).line),
    ).toEqual([
      expect.stringContaining("after terminal"),
      expect.stringContaining("active job log"),
    ]);

    const replayFull = new SetupJobStore(plainRoot, { journal: plain });
    const replayFolded = new SetupJobStore(root, { journal: folded });
    for (const replay of [replayFull, replayFolded])
      expect(replay.recoveryState().status).toBe("ready");
    expect(replayFolded.list()).toEqual(replayFull.list());
    expect(replayFolded.status("setup-a")).toEqual(replayFull.status("setup-a"));
    expect(replayFolded.resolveCreate(idempotency)).toEqual(replayFull.resolveCreate(idempotency));
    expect(replayFolded.events("setup-a")).toEqual(replayFull.events("setup-a"));
    expect(replayFolded.events("setup-b")).toEqual(replayFull.events("setup-b"));
    expect(replayFolded.snapshot("setup-b")).toEqual(replayFull.snapshot("setup-b"));
  });
});
