import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resetRunListFingerprintProbeCountForTests,
  runListFingerprintProbeCountForTests,
  summaryFingerprint,
} from "./run-list-fingerprint.js";
import type { DaemonRunRecord } from "./run-record.js";

describe("run-list fingerprint probe work", () => {
  it("rechecks exactly four paths per unchanged terminal record (QA-052)", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-fingerprint-terminal-cost-"));
    const records = [0, 1].map((index) => {
      const runDir = join(root, String(index));
      mkdirSync(runDir);
      return {
        id: `job-${index}`,
        runId: `run-${index}`,
        runDir,
        state: "succeeded",
        params: {},
        finishedAt: "2026-07-29T00:00:00.000Z",
      } as DaemonRunRecord;
    });
    try {
      const previous = records.map((record) => summaryFingerprint(record));
      expect(previous.map((fingerprint) => fingerprint.dependencies.length)).toEqual([4, 4]);
      resetRunListFingerprintProbeCountForTests();
      expect(summaryFingerprint(records[0]!, previous[0])).toBe(previous[0]);
      expect(runListFingerprintProbeCountForTests()).toBe(4);
      expect(summaryFingerprint(records[1]!, previous[1])).toBe(previous[1]);
      expect(runListFingerprintProbeCountForTests()).toBe(8);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps all eighteen artifact paths for an active record (QA-052)", () => {
    const runDir = mkdtempSync(join(tmpdir(), "claudexor-fingerprint-active-cost-"));
    const record = {
      id: "job-active",
      runId: "run-active",
      runDir,
      state: "running",
      params: {},
    } as DaemonRunRecord;
    try {
      resetRunListFingerprintProbeCountForTests();
      const previous = summaryFingerprint(record);
      expect(previous.dependencies).toHaveLength(18);
      expect(runListFingerprintProbeCountForTests()).toBe(18);
      resetRunListFingerprintProbeCountForTests();
      expect(summaryFingerprint(record, previous)).toBe(previous);
      expect(runListFingerprintProbeCountForTests()).toBe(18);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe("run-list delivery fingerprint", () => {
  it("detects a same-size atomic replacement with the same millisecond mtime", () => {
    const runDir = mkdtempSync(join(tmpdir(), "claudexor-run-fingerprint-"));
    const finalDir = join(runDir, "final");
    const statePath = join(finalDir, "delivery_state.yaml");
    const replacement = join(finalDir, ".delivery-next");
    mkdirSync(finalDir);
    const timestamp = new Date("2026-07-29T00:00:00.123Z");
    writeFileSync(statePath, "state: old\n");
    utimesSync(statePath, timestamp, timestamp);
    const record = {
      id: "job-1",
      runId: "run-1",
      runDir,
      state: "succeeded",
      params: {},
      finishedAt: timestamp.toISOString(),
    } as unknown as DaemonRunRecord;

    try {
      const before = summaryFingerprint(record);
      writeFileSync(replacement, "state: new\n");
      utimesSync(replacement, timestamp, timestamp);
      renameSync(replacement, statePath);
      const after = summaryFingerprint(record, before);
      expect(after.value).not.toBe(before.value);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("invalidates a terminal summary when retention replaces the run tree", () => {
    const runDir = mkdtempSync(join(tmpdir(), "claudexor-run-fingerprint-retention-"));
    const finalDir = join(runDir, "final");
    mkdirSync(finalDir);
    writeFileSync(join(finalDir, "answer.md"), "ready\n");
    const record = {
      id: "job-retained",
      runId: "run-retained",
      runDir,
      state: "succeeded",
      params: {},
      finishedAt: "2026-07-29T00:00:00.000Z",
    } as unknown as DaemonRunRecord;

    const before = summaryFingerprint(record);
    rmSync(runDir, { recursive: true, force: true });
    mkdirSync(runDir);
    writeFileSync(join(runDir, "tombstone.yaml"), "reason: retention\n");
    try {
      expect(summaryFingerprint(record, before).value).not.toBe(before.value);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe("remembered continuation addresses", () => {
  it("rebuilds for pointer creation/replacement/deletion, custody-only changes, and changed source sets", async () => {
    const { writeContinuationSources, ENVELOPE_CUSTODY_FILE, RETAINED_ENVELOPE_POINTER } =
      await import("@claudexor/workspace");
    const root = mkdtempSync(join(tmpdir(), "cx-fingerprint-chain-"));
    const dirs = ["head", "first", "second", "third", "env-a", "env-b"].map((name) =>
      join(root, name),
    );
    for (const dir of dirs) mkdirSync(join(dir, "final"), { recursive: true });
    const [head, first, second, third, envA, envB] = dirs as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const rec = { id: "head", runId: "head", runDir: head, state: "failed", params: {} };
    const source = (runDir: string) => ({
      runDir,
      runId: runDir.split("/").at(-1)!,
      state: "failed",
    });
    writeContinuationSources(head, [source(first), source(second)]);
    const pointer = (dir: string, base: string) =>
      writeFileSync(join(dir, RETAINED_ENVELOPE_POINTER), JSON.stringify({ envelope_base: base }));
    let previous = summaryFingerprint(rec);
    const changed = () => {
      const next = summaryFingerprint(rec, previous);
      expect(next.value).not.toBe(previous.value);
      expect(summaryFingerprint(rec, next)).toBe(next);
      previous = next;
    };
    try {
      pointer(first, envA);
      changed();
      // The second ancestor stays remembered even while the first is retained.
      pointer(second, envB);
      changed();
      writeFileSync(join(envB, ENVELOPE_CUSTODY_FILE), "live");
      changed();
      pointer(second, envA);
      changed();
      rmSync(join(second, RETAINED_ENVELOPE_POINTER));
      changed();
      writeContinuationSources(head, [source(third)]);
      changed();
      pointer(third, envB);
      changed();
      writeFileSync(join(envB, ENVELOPE_CUSTODY_FILE), "adopted");
      changed();
      rmSync(third, { recursive: true });
      changed(); // No tombstone publication.
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
