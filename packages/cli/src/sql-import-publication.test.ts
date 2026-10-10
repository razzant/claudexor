import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preserveLegacyJournal, publishImportedStore } from "./sql-import-publication.js";

const synced = vi.hoisted(() => ({ files: 0 }));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  fsyncSync: vi.fn((fd: number) => {
    if (actual.fstatSync(fd).isFile()) synced.files += 1;
    actual.fsyncSync(fd);
  }),
}));
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
const roots: string[] = [];
afterEach(() => {
  vi.mocked(fs.fsyncSync).mockClear();
  synced.files = 0;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const daemonDir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "import-publish-")));
  roots.push(daemonDir);
  fs.mkdirSync(join(daemonDir, "journal"));
  fs.writeFileSync(join(daemonDir, "journal", "evidence"), "original frames");
  fs.writeFileSync(join(daemonDir, "engine.sqlite.import"), "closed verified database");
  return daemonDir;
}

describe("closed SQL import publication", () => {
  it("syncs the database before raising the floor and preserves every source byte", () => {
    const daemonDir = fixture(),
      order: string[] = [];
    const result = publishImportedStore({
      daemonDir,
      externalDirectories: [daemonDir],
      advanceFloor: () => {
        expect(synced.files).toBe(1);
        expect(fs.existsSync(join(daemonDir, "engine.sqlite"))).toBe(false);
        order.push("advance");
      },
      afterStep: (step) => order.push(step),
    });
    expect(order).toEqual(["synced", "advance", "floor", "database", "journal"]);
    expect(fs.readFileSync(result.databasePath, "utf8")).toBe("closed verified database");
    expect(fs.readFileSync(join(result.legacyPath!, "evidence"), "utf8")).toBe("original frames");
  });
  it("refuses a surviving WAL before any floor or rename", () => {
    const daemonDir = fixture(),
      advanceFloor = vi.fn();
    fs.writeFileSync(join(daemonDir, "engine.sqlite.import-wal"), "uncheckpointed");
    expect(() =>
      publishImportedStore({ daemonDir, externalDirectories: [], advanceFloor }),
    ).toThrow(expect.objectContaining({ code: "store_import_wal_present" }));
    expect(advanceFloor).not.toHaveBeenCalled();
    expect(fs.existsSync(join(daemonDir, "engine.sqlite"))).toBe(false);
    expect(fs.existsSync(join(daemonDir, "journal", "evidence"))).toBe(true);
  });
  for (const crashAt of ["synced", "floor", "database", "journal"] as const) {
    it(`resumes a crash after ${crashAt} without losing the verified database or journal`, () => {
      const daemonDir = fixture();
      expect(() =>
        publishImportedStore({
          daemonDir,
          externalDirectories: [],
          advanceFloor: () => {},
          afterStep: (step) => {
            if (step === crashAt) throw new Error("simulated crash");
          },
        }),
      ).toThrow("simulated crash");
      if (fs.existsSync(join(daemonDir, "engine.sqlite"))) preserveLegacyJournal(daemonDir);
      else publishImportedStore({ daemonDir, externalDirectories: [], advanceFloor: () => {} });
      expect(fs.readFileSync(join(daemonDir, "engine.sqlite"), "utf8")).toBe(
        "closed verified database",
      );
      expect(fs.readFileSync(join(daemonDir, "journal-legacy", "evidence"), "utf8")).toBe(
        "original frames",
      );
    });
  }
  it("retains an earlier legacy archive when publication needs a new one", () => {
    const daemonDir = fixture();
    fs.mkdirSync(join(daemonDir, "journal-legacy"));
    fs.writeFileSync(join(daemonDir, "journal-legacy", "old"), "earlier evidence");
    const result = publishImportedStore({
      daemonDir,
      externalDirectories: [],
      advanceFloor: () => {},
    });
    expect(result.legacyPath).not.toBe(join(daemonDir, "journal-legacy"));
    expect(fs.readFileSync(join(daemonDir, "journal-legacy", "old"), "utf8")).toBe(
      "earlier evidence",
    );
    expect(fs.readFileSync(join(result.legacyPath!, "evidence"), "utf8")).toBe("original frames");
  });
});
