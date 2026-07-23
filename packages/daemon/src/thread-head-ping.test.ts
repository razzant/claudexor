import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "@claudexor/journal";
import { describe, expect, it } from "vitest";
import { ThreadHeadPingEmitter } from "./thread-head-ping.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

function journalAt(root: string): DurableJournal {
  return new DurableJournal({ rootDir: root, partition: "global" });
}

describe("ThreadHeadPingEmitter", () => {
  it("emits monotonic per-thread revisions as content-free journal records", () => {
    const root = realpathSync(reapMk(join(tmpdir(), "claudexor-head-ping-")));
    const journal = journalAt(root);
    const emitter = new ThreadHeadPingEmitter(journal);

    emitter.ping({ threadId: "th-a", projectId: "proj-1" });
    emitter.ping({ threadId: "th-a", projectId: "proj-1" });
    emitter.ping({ threadId: "th-b", projectId: null });

    const records = journal.records().filter((record) => record.type === "thread.head.updated");
    expect(records.map((record) => record.payload)).toEqual([
      { thread_id: "th-a", project_id: "proj-1", revision: 1 },
      { thread_id: "th-a", project_id: "proj-1", revision: 2 },
      { thread_id: "th-b", project_id: null, revision: 1 },
    ]);
    expect(emitter.revision("th-a")).toBe(2);
    expect(emitter.revision("th-b")).toBe(1);
    expect(emitter.revision("th-unknown")).toBe(0);
  });

  it("resumes the revision counter across a restart (journal-backed)", () => {
    const root = realpathSync(reapMk(join(tmpdir(), "claudexor-head-ping-")));
    const first = journalAt(root);
    new ThreadHeadPingEmitter(first).ping({ threadId: "th-a", projectId: null });
    first.close();

    const reopened = journalAt(root);
    const emitter = new ThreadHeadPingEmitter(reopened);
    expect(emitter.revision("th-a")).toBe(1);
    emitter.ping({ threadId: "th-a", projectId: null });
    const last = reopened.records().at(-1);
    expect(last?.payload).toEqual({ thread_id: "th-a", project_id: null, revision: 2 });
  });
});
