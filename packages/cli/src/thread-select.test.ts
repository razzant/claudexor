import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ThreadStore } from "../../daemon/src/store/test-support/fixtures/legacy/daemon/threads.js";
import { DurableJournal } from "../../daemon/src/store/test-support/fixtures/legacy/journal/index.js";
import { ControlThread } from "@claudexor/schema";
import { pickResumableThread } from "./thread-select.js";

const PROJECT = "/work/project-a";

const thread = (
  id: string,
  updatedAt: string,
  state = "active",
  repoRoot: string | null = PROJECT,
): ControlThread =>
  ControlThread.parse({
    id,
    title: id,
    repoRoot,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt,
    state,
  });

describe("pickResumableThread (--resume, W13/G5, D28 project scope)", () => {
  it("picks the most recently updated ACTIVE thread in this project", () => {
    const picked = pickResumableThread(
      [
        thread("old", "2026-07-16T09:00:00.000Z"),
        thread("newest", "2026-07-16T12:00:00.000Z"),
        thread("mid", "2026-07-16T10:00:00.000Z"),
      ],
      PROJECT,
    );
    expect(picked?.id).toBe("newest");
  });

  it("never resumes a trashed/archived thread, even if it is the newest", () => {
    const picked = pickResumableThread(
      [
        thread("active-old", "2026-07-16T08:00:00.000Z"),
        thread("trashed-new", "2026-07-16T23:00:00.000Z", "trashed"),
      ],
      PROJECT,
    );
    expect(picked?.id).toBe("active-old");
  });

  it("scopes to the current project: a newer thread in ANOTHER project is not resumed (D28)", () => {
    const picked = pickResumableThread(
      [
        thread("this-project", "2026-07-16T08:00:00.000Z", "active", PROJECT),
        thread("other-project", "2026-07-16T23:00:00.000Z", "active", "/work/project-b"),
      ],
      PROJECT,
    );
    expect(picked?.id).toBe("this-project");
  });

  it("never resumes a project-less thread when scoped to a project", () => {
    const picked = pickResumableThread(
      [thread("no-project", "2026-07-16T23:00:00.000Z", "active", null)],
      PROJECT,
    );
    expect(picked).toBeUndefined();
  });

  it("filing an older thread into a folder does not make it the --resume target", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-thread-select-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    vi.useFakeTimers({ now: new Date("2026-10-03T08:00:00.000Z"), toFake: ["Date"] });
    try {
      const store = new ThreadStore(journal);
      const older = store.createThread({ repoRoot: PROJECT });
      vi.setSystemTime(new Date("2026-10-03T09:00:00.000Z"));
      const newer = store.createThread({ repoRoot: PROJECT });
      vi.setSystemTime(new Date("2026-10-03T10:00:00.000Z"));
      store.updateThread(older.id, { folder: "Research" });
      // The wire fields the selection reads (the control-api thread projection).
      const listed = store.listThreads().map((t) =>
        ControlThread.parse({
          id: t.id,
          folder: t.folder,
          repoRoot: t.repo?.root ?? null,
          state: t.state,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
        }),
      );
      expect(listed.find((t) => t.id === older.id)?.folder).toBe("Research");
      expect(pickResumableThread(listed, PROJECT)?.id).toBe(newer.id);
    } finally {
      vi.useRealTimers();
      journal.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns undefined when there is no active thread to continue in this project", () => {
    expect(pickResumableThread([], PROJECT)).toBeUndefined();
    expect(
      pickResumableThread([thread("t", "2026-07-16T09:00:00.000Z", "trashed")], PROJECT),
    ).toBeUndefined();
    expect(
      pickResumableThread(
        [thread("elsewhere", "2026-07-16T09:00:00.000Z", "active", "/work/project-b")],
        PROJECT,
      ),
    ).toBeUndefined();
  });
});
