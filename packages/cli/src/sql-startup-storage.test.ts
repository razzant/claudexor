import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DurableJournal,
  journalPartitionDirectory,
} from "../../daemon/src/store/test-support/fixtures/legacy/journal/index.js";
import { openSqlStoreAfterTransport } from "./sql-startup-storage.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function fixture() {
  const daemonDir = realpathSync(mkdtempSync(join(tmpdir(), "sql-startup-")));
  cleanup.push(() => rmSync(daemonDir, { recursive: true, force: true }));
  return {
    daemonDir,
    advanceFloor: vi.fn(),
    importWorkerEntry: resolve(
      import.meta.dirname,
      "../../daemon/dist/store/maintenance-worker.js",
    ),
    flusherWorkerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
  };
}
describe("SQL startup storage publication", () => {
  it("imports before serving, preserves journal bytes and reopens from SQL without replay", async () => {
    const f = fixture(),
      journalRoot = join(f.daemonDir, "journal");
    const journal = new DurableJournal({ rootDir: journalRoot, partition: "global" });
    journal.append("command.accepted", {
      record: {
        id: "job",
        state: "queued",
        params: { prompt: "kept" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      keyDigest: "key",
      requestDigest: "request",
    });
    journal.close();
    const source = readFileSync(
      join(journalPartitionDirectory(journalRoot, "global"), "journal.bin"),
    );
    const progress: string[] = [];
    const first = await openSqlStoreAfterTransport({
      ...f,
      progress: (p) => progress.push(p.phase),
    });
    expect(f.advanceFloor).toHaveBeenCalledTimes(1);
    expect(progress).toContain("publishing");
    expect(first.prepare("SELECT id FROM command").all()).toEqual([{ id: "job" }]);
    expect(
      readFileSync(
        join(
          journalPartitionDirectory(join(f.daemonDir, "journal-legacy"), "global"),
          "journal.bin",
        ),
      ),
    ).toEqual(source);
    await first.close();
    const again = await openSqlStoreAfterTransport({
      ...f,
      progress: () => {
        throw new Error("must not reimport");
      },
    });
    cleanup.push(() => again.close());
    expect(again.prepare("SELECT id FROM command").all()).toEqual([{ id: "job" }]);
  });
  it("creates a durable fresh global generation and never serves an orphan temporary import as empty", async () => {
    const f = fixture();
    const store = await openSqlStoreAfterTransport(f);
    cleanup.push(() => store.close());
    expect(f.advanceFloor).toHaveBeenCalledTimes(1);
    expect(store.prepare("SELECT name FROM partition").all()).toEqual([{ name: "global" }]);
    const orphan = fixture();
    writeFileSync(join(orphan.daemonDir, "engine.sqlite.import"), "unfinished evidence");
    await expect(openSqlStoreAfterTransport(orphan)).rejects.toMatchObject({
      code: "store_import_source_missing",
    });
    expect(orphan.advanceFloor).not.toHaveBeenCalled();
    expect(existsSync(join(orphan.daemonDir, "engine.sqlite"))).toBe(false);
  });
});
