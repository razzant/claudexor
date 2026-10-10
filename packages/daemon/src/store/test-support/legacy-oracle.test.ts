import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { journalPartitionDirectory } from "./fixtures/legacy/journal/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { readFixtureManifest, verifyFixtureManifest, LEGACY_BASELINE } from "./fixture-manifest.js";
import {
  copyFixture,
  openFixtureJournal,
  readLogicalFixture,
  writeLogicalFixture,
  type LogicalFixture,
} from "./fixture-loader.js";
import { legacyOracle } from "./legacy-oracle.js";
import { legacySnapshot, legacyStores } from "./legacy-replay.js";

const here = dirname(fileURLToPath(import.meta.url));
type Stores = ReturnType<typeof legacyStores>;
type Fixture = LogicalFixture & {
  lookups: {
    command: Parameters<Stores["commands"]["find"]>[0];
    decision: NonNullable<Parameters<Stores["decisions"]["findByIdempotency"]>[1]>;
    thread: Parameters<Stores["threads"]["findThreadCreation"]>[0];
    setup: Parameters<Stores["setup"]["resolveCreate"]>[0];
  };
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workingRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "legacy-oracle-")));
  roots.push(root);
  return root;
}

function observations(
  journal: ReturnType<typeof openFixtureJournal>,
  stores: Stores,
  fixture: Fixture,
) {
  return {
    snapshot: legacySnapshot(journal, stores),
    bindings: {
      command: stores.commands.find(fixture.lookups.command),
      decision: stores.decisions.findByIdempotency("run-success", fixture.lookups.decision),
      thread: stores.threads.findThreadCreation(fixture.lookups.thread),
      setup: stores.setup.resolveCreate(fixture.lookups.setup),
    },
    interactions: {
      closed: stores.interactions.status("run-success", "question-closed"),
      open: stores.interactions.status("run-success", "question-open"),
    },
  };
}

describe("frozen legacy oracle (M0, not SQL equivalence)", () => {
  it("seals the baseline bytes, import-only rewrites, frozen closure and fixture provenance", () => {
    const manifest = readFixtureManifest();
    expect(manifest.baseline).toBe(LEGACY_BASELINE);
    expect(manifest.snapshots).toHaveLength(219);
    expect(Object.keys(legacyOracle)).toHaveLength(34);
    expect(verifyFixtureManifest(manifest)).toEqual([]);
    const changed = structuredClone(manifest);
    changed.snapshots[0]!.copiedSha256 = "0".repeat(64);
    expect(verifyFixtureManifest(changed)).toContain(
      `snapshot changed: ${changed.snapshots[0]!.snapshotPath}`,
    );
    const incomplete = structuredClone(manifest);
    incomplete.snapshots = incomplete.snapshots.filter(
      (row) => row.snapshotPath !== "fixtures/legacy/daemon/job-record.ts",
    );
    expect(verifyFixtureManifest(incomplete)).toContain(
      "unsealed local import: fixtures/legacy/daemon/command-store.ts -> ./job-record.js",
    );
  });

  it("replays two private copies exactly, with seeded cursors, bindings and terminal facts", () => {
    const fixture = readLogicalFixture(join(here, "fixtures/global.json")) as Fixture;
    const expected = JSON.parse(readFileSync(join(here, "fixtures/global.expected.json"), "utf8"));
    const root = workingRoot();
    const original = join(root, "original");
    writeLogicalFixture(original, fixture);
    const journalPath = join(
      journalPartitionDirectory(join(original, "journal"), fixture.partition),
      "journal.bin",
    );
    const digest = () => createHash("sha256").update(readFileSync(journalPath)).digest("hex");
    const before = digest();
    for (const name of ["first", "second"]) {
      const copy = join(root, name);
      copyFixture(original, copy);
      const journal = openFixtureJournal(copy, fixture);
      try {
        const stores = legacyStores(journal, copy, fixture.now);
        expect(stores.commands).toBeInstanceOf(legacyOracle.daemonCommandStore.CommandStore);
        expect(stores.quota).toBeInstanceOf(legacyOracle.daemonQuotaRegistry.QuotaRegistry);
        expect(stores.setup).toBeInstanceOf(legacyOracle.cliSetupJobStore.SetupJobStore);
        const observed = observations(journal, stores, fixture);
        assert.deepStrictEqual(observed, expected);
        let seed = 0x5eed;
        const positions = [0, 1, journal.currentSequence()];
        for (let index = 0; index < 100; index++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          positions.push(seed % (journal.currentSequence() + 1));
        }
        for (const sequence of positions) {
          const cursor = journal.cursorAt(sequence);
          expect(journal.sequenceAfter(cursor)).toBe(sequence);
          assert.deepStrictEqual(
            journal
              .records(sequence)
              .map((record) => ({ type: record.type, payload: record.payload })),
            fixture.records.slice(sequence),
          );
        }
        const wrong = structuredClone(expected);
        wrong.snapshot.commands[0].params.prompt = "A changed expected field must fail.";
        expect(() => assert.deepStrictEqual(observed, wrong)).toThrow();
        expect(existsSync(join(copy, "engine.sqlite"))).toBe(false);
      } finally {
        journal.close();
      }
    }
    expect(digest()).toBe(before);
  });

  it("does not include the oracle in the built production daemon package", () => {
    const dist = resolve(here, "../../../dist");
    expect(existsSync(join(dist, "index.js")), "build the daemon first").toBe(true);
    expect(existsSync(join(dist, "store/test-support"))).toBe(false);
  });
});
