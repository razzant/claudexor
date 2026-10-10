import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableJournal } from "../test-support/fixtures/legacy/journal/index.js";
import { inspectPreparedJournal as frozenInspect } from "../test-support/fixtures/legacy/journal/read-only-preparation.js";
import { inspectPreparedJournal, fingerprintPreparedJournal } from "./read-only-preparation.js";
import { journalPartitionDirectory } from "./journal-partition.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(partition = "global", populate = true) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "legacy-reader-")));
  roots.push(root);
  const journalRoot = join(root, "journal");
  mkdirSync(journalRoot, { mode: 0o700 });
  if (populate) {
    const writer = new DurableJournal({
      rootDir: journalRoot,
      partition,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    writer.append("fixture.event", { private: "retained payload", n: 1 });
    writer.close();
  }
  const partitionDir = journalPartitionDirectory(journalRoot, partition);
  const options = {
    rootDir: journalRoot,
    partitionDir,
    journalPath: join(partitionDir, "journal.bin"),
    intentPath: join(partitionDir, "append.pending.json"),
    partition,
    initialEpoch: "virtual-epoch",
  };
  return { root, journalRoot, partitionDir, options };
}
function bytesAndModes(path: string): unknown {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { symlink: true, mode: stat.mode };
  return stat.isDirectory()
    ? {
        mode: stat.mode,
        children: Object.fromEntries(
          readdirSync(path)
            .sort()
            .map((name) => [name, bytesAndModes(join(path, name))]),
        ),
      }
    : {
        mode: stat.mode,
        size: stat.size,
        sha: createHash("sha256").update(readFileSync(path)).digest("hex"),
      };
}
function inspectUnchanged(f: ReturnType<typeof fixture>) {
  const before = bytesAndModes(f.root);
  const actual = inspectPreparedJournal(f.options);
  expect(actual).toEqual(frozenInspect(f.options));
  expect(bytesAndModes(f.root)).toEqual(before);
  return actual;
}

describe("cold legacy inspection without writer activation", () => {
  it("preserves records, physical chain, original time and the frozen content/identity receipt", () => {
    const f = fixture();
    const result = inspectUnchanged(f);
    expect(result.recovery.status).toBe("ready");
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      seq: 1,
      time: "2026-01-01T00:00:00.000Z",
      payload: { private: "retained payload", n: 1 },
    });
    expect(result.nextSeq).toBe(2);
    expect(result.previousFrameHash).toBe(result.records[0]!.frameHash);
    const { fingerprint, preparationIdentity } = fingerprintPreparedJournal(
      f.journalRoot,
      f.partitionDir,
    );
    expect(result.receipt).toMatchObject({ fingerprint, preparationIdentity });
  });
  it("leaves a missing registered partition virtual without making any directory", () => {
    const f = fixture("project:missing", false);
    const result = inspectUnchanged(f);
    expect(result.receipt.virtual).toBe(true);
    expect(result.epoch).toBe("virtual-epoch");
    expect(result.nextSeq).toBe(1);
    expect(existsSync(f.partitionDir)).toBe(false);
  });
  it("reports corrupt acknowledged bytes without rewriting the source", () => {
    const f = fixture();
    const bytes = readFileSync(f.options.journalPath);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(f.options.journalPath, bytes);
    expect(inspectUnchanged(f).recovery.status).toBe("recovery_required");
  });
  it("defers a witnessed uncertain append without consuming its intent or suffix", () => {
    const f = fixture();
    const original = readFileSync(f.options.journalPath);
    writeFileSync(f.options.journalPath, Buffer.concat([original, Buffer.from("CLX")]));
    writeFileSync(
      f.options.intentPath,
      JSON.stringify({ v: 1, offset: original.length, length: 3 }),
      { mode: 0o600 },
    );
    const result = inspectUnchanged(f);
    expect(result.recovery.status).toBe("ready");
    expect(result.receipt.deferredRepair?.discardedBytes).toBe(3);
    expect(result.records).toHaveLength(1);
  });
  it("rejects an existing non-directory partition without replacing it", () => {
    const f = fixture("global", false);
    writeFileSync(f.partitionDir, "owner bytes", { mode: 0o600 });
    expect(inspectUnchanged(f).recovery.status).toBe("recovery_required");
  });
  it.each(["root", "journalRoot", "partitionDir"] as const)(
    "refuses non-private %s without changing permissions",
    (key) => {
      if (process.platform === "win32") return;
      const f = fixture();
      chmodSync(f[key], 0o755);
      expect(inspectUnchanged(f).recovery.status).toBe("recovery_required");
    },
  );
  it("refuses a symlinked journal root without touching the outside tree", () => {
    if (process.platform === "win32") return;
    const f = fixture();
    const outside = join(f.root, "outside");
    renameSync(f.journalRoot, outside);
    symlinkSync(outside, f.journalRoot, "dir");
    const before = bytesAndModes(outside);
    expect(inspectUnchanged(f).recovery.status).toBe("recovery_required");
    expect(bytesAndModes(outside)).toEqual(before);
  });
  it("changes preparation identity for a byte-identical replacement, preserving its content fingerprint", () => {
    const f = fixture();
    const prior = inspectUnchanged(f).receipt;
    const previous = `${f.partitionDir}.previous`;
    renameSync(f.partitionDir, previous);
    cpSync(previous, f.partitionDir, { recursive: true, preserveTimestamps: true });
    chmodSync(f.partitionDir, 0o700);
    const next = inspectUnchanged(f).receipt;
    expect(next.fingerprint).toBe(prior.fingerprint);
    expect(next.preparationIdentity).not.toBe(prior.preparationIdentity);
  });
  it("contains traversal-like logical partition names in the legacy directory formula", () => {
    const f = fixture("../../private/other", false);
    expect(f.partitionDir.startsWith(`${f.journalRoot}/`)).toBe(true);
    expect(inspectUnchanged(f).recovery.status).toBe("ready");
    expect(existsSync(f.partitionDir)).toBe(false);
  });
});
