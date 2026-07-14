import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DurableJournal, JournalCursorError } from "@claudexor/journal";
import { JournalManager } from "./journal-manager.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-journal-manager-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function registerProbe(manager: JournalManager, name = "probe") {
  return manager.registerProjection({
    name,
    create: (journal) => ({ journal }),
    validate: ({ journal }) => {
      journal.records();
    },
  });
}

function corruptFirstByte(path: string): Buffer {
  const bytes = readFileSync(path);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  writeFileSync(path, bytes, { mode: 0o600 });
  return bytes;
}

function seedCorruptPartition(partition = "global") {
  const first = new JournalManager(root, { partition });
  const slot = registerProbe(first);
  first.start();
  slot.current().journal.append("probe.saved", { value: 1 });
  const journalPath = slot.current().journal.path;
  first.close();
  return { journalPath, corruptBytes: corruptFirstByte(journalPath) };
}

interface StoredOperation {
  status: "prepared" | "completed";
  quarantinePath: string;
  receipt: unknown;
}

function storedOperation(): StoredOperation {
  const operationsRoot = join(root, "recovery-operations");
  const partitionDirs = readdirSync(operationsRoot);
  if (partitionDirs.length !== 1) {
    throw new Error(`expected one recovery partition, found ${partitionDirs.length}`);
  }
  const dir = join(operationsRoot, partitionDirs[0]!);
  const names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  if (names.length !== 1) throw new Error(`expected one recovery operation, found ${names.length}`);
  return JSON.parse(readFileSync(join(dir, names[0]!), "utf8")) as StoredOperation;
}

describe("JournalManager", () => {
  it("projects durable events behind opaque partition cursors", () => {
    const manager = new JournalManager(root, { partition: "project:events" });
    const slot = registerProbe(manager);
    manager.start();
    slot.current().journal.append("probe.first", { value: 1 });
    slot.current().journal.append("probe.second", { value: 2 });
    const events = manager.events();
    expect(events.map((event) => [event.partition, event.type])).toEqual([
      ["project:events", "probe.first"],
      ["project:events", "probe.second"],
    ]);
    expect(manager.events(events[0]!.cursor).map((event) => event.type)).toEqual(["probe.second"]);
    manager.close();
  });

  it("isolates recovery and projection availability by partition", () => {
    const partitions = ["global", "project:a", "project:b"] as const;
    const seeded = partitions.map((partition) => {
      const manager = new JournalManager(root, { partition });
      const slot = registerProbe(manager);
      expect(manager.start().partition).toBe(partition);
      slot.current().journal.append("probe.saved", { partition });
      const path = slot.current().journal.path;
      manager.close();
      return { partition, path };
    });
    corruptFirstByte(seeded[1]!.path);

    const reopened = partitions.map((partition) => {
      const manager = new JournalManager(root, { partition });
      const slot = registerProbe(manager);
      return { partition, manager, slot, inspection: manager.start() };
    });
    expect(reopened[0]!.inspection.status).toBe("ready");
    expect(reopened[1]!.inspection.status).toBe("recovery_required");
    expect(reopened[2]!.inspection.status).toBe("ready");
    expect(() => reopened[1]!.slot.current()).toThrow(/requires recovery/);
    for (const entry of [reopened[0]!, reopened[2]!]) {
      expect(entry.slot.current().journal.records()).toHaveLength(1);
      entry.slot.current().journal.append("probe.after_reopen", { partition: entry.partition });
    }
    for (const entry of reopened) entry.manager.close();
  });

  it("owns one writer, seals registration, and validates every projection", () => {
    const manager = new JournalManager(root, {
      now: () => new Date("2026-07-14T00:00:00.000Z"),
    });
    const first = registerProbe(manager, "first");
    const second = registerProbe(manager, "second");
    expect(manager.start().status).toBe("ready");
    expect(first.current().journal).toBe(second.current().journal);
    expect(first.generation()).toBe(1);
    expect(manager.validate().projectionStatus.every((row) => row.status === "valid")).toBe(true);
    expect(() => registerProbe(manager, "late")).toThrow(/registration is closed/);
    manager.close();
  });

  it("keeps inspect, validate and secret-safe export online without mutating corrupt bytes", () => {
    const { journalPath, corruptBytes } = seedCorruptPartition();
    const mode = statSync(journalPath).mode & 0o777;
    const manager = new JournalManager(root, {
      now: () => new Date("2026-07-14T01:00:00.000Z"),
    });
    registerProbe(manager);
    const inspection = manager.start();
    expect(inspection.status).toBe("recovery_required");
    expect(manager.validate().projectionStatus).toEqual([
      expect.objectContaining({ name: "probe", status: "invalid" }),
    ]);

    const outside = join(root, "outside-secret");
    writeFileSync(outside, "secret-sentinel", { mode: 0o640 });
    symlinkSync(outside, join(manager.partitionDir, "unknown-link"));
    linkSync(outside, join(manager.partitionDir, "unknown-hardlink"));
    const exported = manager.exportRecovery();
    const manifest = JSON.parse(
      readFileSync(join(exported.bundlePath, "manifest.json"), "utf8"),
    ) as { entries: Array<{ name: string; copiedAs: string | null }> };
    expect(manifest.entries.find((row) => row.name === "unknown-link")?.copiedAs).toBeNull();
    expect(manifest.entries.find((row) => row.name === "unknown-hardlink")?.copiedAs).toBeNull();
    expect(readFileSync(outside, "utf8")).toBe("secret-sentinel");
    expect(statSync(outside).mode & 0o777).toBe(0o640);
    expect(readFileSync(journalPath)).toEqual(corruptBytes);
    expect(statSync(journalPath).mode & 0o777).toBe(mode);
    manager.close();
  });

  it("quarantines by fingerprint, rebinds a fresh epoch, and replays idempotently", () => {
    const first = new JournalManager(root);
    const firstSlot = registerProbe(first);
    first.start();
    const oldJournal = firstSlot.current().journal;
    oldJournal.append("probe.saved", { value: 1 });
    const oldCursor = oldJournal.currentCursor();
    const path = oldJournal.path;
    first.close();
    corruptFirstByte(path);

    const manager = new JournalManager(root);
    const slot = registerProbe(manager);
    const inspection = manager.start();
    const request = {
      idempotencyKey: "recover-global-once",
      expectedFingerprint: inspection.fingerprint,
      confirmation: "quarantine_and_start_fresh" as const,
    };
    expect(manager.preflightQuarantine(request)).toEqual({ disposition: "new", receipt: null });
    const receipt = manager.quarantineAndStartFresh(request);
    expect(receipt.previousFingerprint).toBe(inspection.fingerprint);
    expect(manager.inspect().status).toBe("ready");
    expect(slot.generation()).toBe(2);
    expect(
      slot
        .current()
        .journal.records()
        .map((record) => record.type),
    ).toEqual(["journal.partition_quarantined"]);
    expect(() => slot.current().journal.sequenceAfter(oldCursor)).toThrow(JournalCursorError);
    expect(manager.quarantineAndStartFresh(request)).toEqual(receipt);
    expect(() =>
      manager.quarantineAndStartFresh({ ...request, expectedFingerprint: "0".repeat(64) }),
    ).toThrow(/idempotency conflict/);
    manager.close();
  });

  it("reports the exact project partition in export and quarantine receipts", () => {
    const partition = "project:alpha";
    const { journalPath } = seedCorruptPartition(partition);
    const manager = new JournalManager(root, { partition });
    registerProbe(manager);
    const inspection = manager.start();
    expect(inspection.partition).toBe(partition);
    const exported = manager.exportRecovery();
    expect(exported.partition).toBe(partition);
    const manifest = JSON.parse(
      readFileSync(join(exported.bundlePath, "manifest.json"), "utf8"),
    ) as { partition: string };
    expect(manifest.partition).toBe(partition);
    const receipt = manager.quarantineAndStartFresh({
      idempotencyKey: "recover-project-alpha",
      expectedFingerprint: inspection.fingerprint,
      confirmation: "quarantine_and_start_fresh",
    });
    expect(receipt.partition).toBe(partition);
    expect(receipt.quarantinePath).not.toContain("global-");
    expect(existsSync(journalPath)).toBe(true);
    manager.close();
  });

  it.each([
    ["healthy partition", "ready", "f".repeat(64), "only a corrupt partition"],
    ["stale fingerprint", "corrupt", "0".repeat(64), "fingerprint mismatch"],
  ])(
    "rejects %s before creating recovery operation state",
    (_name, state, fingerprint, message) => {
      const manager = new JournalManager(root);
      registerProbe(manager);
      if (state === "corrupt") seedCorruptPartition();
      manager.start();
      expect(() =>
        manager.preflightQuarantine({
          idempotencyKey: "preflight",
          expectedFingerprint: fingerprint,
          confirmation: "quarantine_and_start_fresh",
        }),
      ).toThrow(message);
      expect(existsSync(join(root, "recovery-operations"))).toBe(false);
      manager.close();
    },
  );

  it("finishes a prepared quarantine after a crash immediately after rename", () => {
    seedCorruptPartition();
    const crashing = new JournalManager(root, {
      faults: {
        afterQuarantineRename: () => {
          throw new Error("simulated crash after rename");
        },
      },
    });
    registerProbe(crashing);
    const inspection = crashing.start();
    expect(() =>
      crashing.quarantineAndStartFresh({
        idempotencyKey: "crash-after-rename",
        expectedFingerprint: inspection.fingerprint,
        confirmation: "quarantine_and_start_fresh",
      }),
    ).toThrow(/simulated crash/);
    expect(storedOperation().status).toBe("prepared");
    crashing.close();

    const resumed = new JournalManager(root);
    const slot = registerProbe(resumed);
    expect(resumed.start().status).toBe("ready");
    expect(
      slot
        .current()
        .journal.records()
        .map((record) => record.type),
    ).toEqual(["journal.partition_quarantined"]);
    expect(storedOperation().status).toBe("completed");
    resumed.close();
  });

  it("binds a durable fresh receipt after a crash before the completed marker", () => {
    seedCorruptPartition();
    const crashing = new JournalManager(root, {
      faults: {
        afterQuarantineReceipt: () => {
          throw new Error("simulated crash after receipt");
        },
      },
    });
    registerProbe(crashing);
    const inspection = crashing.start();
    expect(() =>
      crashing.quarantineAndStartFresh({
        idempotencyKey: "crash-after-receipt",
        expectedFingerprint: inspection.fingerprint,
        confirmation: "quarantine_and_start_fresh",
      }),
    ).toThrow(/simulated crash/);
    crashing.close();

    const resumed = new JournalManager(root);
    const slot = registerProbe(resumed);
    expect(resumed.start().status).toBe("ready");
    expect(slot.current().journal.records()).toHaveLength(1);
    expect(storedOperation().status).toBe("completed");
    resumed.close();
  });

  it("fails closed when source and quarantine coexist without the exact receipt", () => {
    seedCorruptPartition();
    const crashing = new JournalManager(root, {
      faults: {
        afterQuarantineRename: () => {
          throw new Error("simulated crash");
        },
      },
    });
    registerProbe(crashing);
    const inspection = crashing.start();
    expect(() =>
      crashing.quarantineAndStartFresh({
        idempotencyKey: "ambiguous",
        expectedFingerprint: inspection.fingerprint,
        confirmation: "quarantine_and_start_fresh",
      }),
    ).toThrow(/simulated crash/);
    crashing.close();

    const rogue = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    rogue.append("rogue.record", { value: 1 });
    rogue.close();
    const restarted = new JournalManager(root);
    const slot = registerProbe(restarted);
    expect(restarted.start().status).toBe("recovery_required");
    expect(() => slot.current()).toThrow(/requires recovery/);
    restarted.close();
  });
});
