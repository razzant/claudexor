import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "@claudexor/journal";
import { describe, expect, it } from "vitest";
import { ProjectStore } from "./projects.js";

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-projects-")));
  const journalRoot = join(base, "state");
  const firstRoot = join(base, "first");
  const secondRoot = join(base, "second");
  mkdirSync(firstRoot);
  mkdirSync(secondRoot);
  const journal = new DurableJournal({ rootDir: journalRoot, partition: "global" });
  return { base, journalRoot, firstRoot, secondRoot, journal, store: new ProjectStore(journal) };
}

describe("ProjectStore", () => {
  it("starts empty, registers idempotently, and survives restart without v1 import", () => {
    const f = fixture();
    expect(f.store.list()).toEqual([]);
    const input = { root: f.firstRoot, idempotencyKey: "register-1", clientId: "test" };
    const project = f.store.register(input);
    expect(f.store.register(input).id).toBe(project.id);
    expect(() => f.store.register({ ...input, root: f.secondRoot })).toThrow(/different request/);
    f.journal.close();
    const reloaded = new ProjectStore(
      new DurableJournal({ rootDir: f.journalRoot, partition: "global" }),
    );
    expect(reloaded.list()).toEqual([project]);
    expect(reloaded.register(input).id).toBe(project.id);
  });

  it("deduplicates canonical roots and relinks one stable project id", () => {
    const f = fixture();
    const project = f.store.register({
      root: f.firstRoot,
      idempotencyKey: "register-1",
      clientId: "test",
    });
    const same = f.store.register({
      root: `${f.base}/first/..//first`,
      idempotencyKey: "register-2",
      clientId: "test",
    });
    expect(same.id).toBe(project.id);
    expect(f.store.list()).toHaveLength(1);
    expect(f.store.relink(project.id, f.secondRoot)).toMatchObject({
      id: project.id,
      root: realpathSync(f.secondRoot),
    });
    expect(f.store.relink(project.id, f.secondRoot).id).toBe(project.id);
  });
});
