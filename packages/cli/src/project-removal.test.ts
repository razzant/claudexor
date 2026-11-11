import { describe, expect, it } from "vitest";
import { ControlProjectRemoveReceipt, type Thread } from "@claudexor/schema";
import { projectRemovalService } from "./project-removal.js";

const receipt = {
  projectId: "prj-1",
  root: "/repo/a",
  registryRemoved: true as const,
  journalPartitionArchived: true,
  archivedPartitionPath: "partition:project:prj-1@e",
  artifactsRetained: true as const,
  activeRunCheck: "snapshot" as const,
};
const thread = (id: string) => ({ id, state: "trashed" }) as Thread;

function fakeStore(purged: Thread[] = []) {
  const calls: Array<{ method: string; roots: ReadonlySet<string> }> = [];
  return {
    calls,
    threads: {
      removeProject: (_id: string, roots: ReadonlySet<string>) => {
        calls.push({ method: "removeProject", roots });
        return receipt;
      },
      removeProjectWithTrashedThreads: (_id: string, roots: ReadonlySet<string>) => {
        calls.push({ method: "removeProjectWithTrashedThreads", roots });
        return { receipt, purged };
      },
    },
  };
}

describe("project removal service (#333)", () => {
  it("keeps the default request on the unchanged removal and its receipt shape", async () => {
    const store = fakeStore([thread("th-a")]);
    const cleaned: string[] = [];
    const remove = projectRemovalService(
      store.threads,
      () => [{ runId: "r1", state: "running", params: { scope: { kind: "project", root: "/x" } } }],
      async (item) => {
        cleaned.push(item.id);
      },
    );
    const result = await remove("prj-1");
    expect(result).toEqual(receipt);
    expect(ControlProjectRemoveReceipt.parse(result)).not.toHaveProperty("purgedThreads");
    expect(store.calls.map((call) => call.method)).toEqual(["removeProject"]);
    expect([...store.calls[0]!.roots]).toEqual(["/x"]);
    expect(cleaned).toEqual([]);
  });

  it("purges through the opt-in, cleans up one thread at a time and reports pending cleanup", async () => {
    const store = fakeStore([thread("th-a"), thread("th-b"), thread("th-c")]);
    const order: string[] = [];
    let running = 0;
    const remove = projectRemovalService(
      store.threads,
      () => [],
      async (item) => {
        running += 1;
        expect(running).toBe(1);
        order.push(`start:${item.id}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        order.push(`end:${item.id}`);
        if (item.id === "th-b")
          throw new Error("EACCES: permission denied, rmdir '/runtime/lanes/th-b'");
      },
    );
    const result = ControlProjectRemoveReceipt.parse(
      await remove("prj-1", { trashedThreads: "purge" }),
    );
    expect(store.calls.map((call) => call.method)).toEqual(["removeProjectWithTrashedThreads"]);
    expect(order).toEqual([
      "start:th-a",
      "end:th-a",
      "start:th-b",
      "end:th-b",
      "start:th-c",
      "end:th-c",
    ]);
    expect(result).toEqual({
      ...receipt,
      purgedThreads: [
        { threadId: "th-a", cleanup: "completed", cleanupError: null },
        {
          threadId: "th-b",
          cleanup: "pending",
          cleanupError: "EACCES: permission denied, rmdir '/runtime/lanes/th-b'",
        },
        { threadId: "th-c", cleanup: "completed", cleanupError: null },
      ],
    });
  });

  it("reports an empty purge list when the trash was empty", async () => {
    const remove = projectRemovalService(
      fakeStore().threads,
      () => [],
      async () => undefined,
    );
    expect(await remove("prj-1", { trashedThreads: "purge" })).toEqual({
      ...receipt,
      purgedThreads: [],
    });
  });

  it("takes the activity snapshot and commits in the same turn on both paths", async () => {
    for (const options of [undefined, { trashedThreads: "purge" as const }]) {
      const store = fakeStore();
      let nextTurn = false;
      queueMicrotask(() => {
        nextTurn = true;
      });
      const pending = projectRemovalService(
        store.threads,
        () => [],
        async () => undefined,
      )("prj-1", options);
      expect(store.calls).toHaveLength(1);
      expect(nextTurn).toBe(false);
      await pending;
    }
  });

  it("fails closed before any store call when an active run's scope cannot be resolved", async () => {
    const store = fakeStore([thread("th-a")]);
    const remove = projectRemovalService(
      store.threads,
      () => [{ runId: "r9", state: "queued", params: { scope: { kind: "project" } } }],
      async () => undefined,
    );
    await expect(remove("prj-1", { trashedThreads: "purge" })).rejects.toMatchObject({
      code: "active_run_scope_unresolved",
      status: 409,
    });
    expect(store.calls).toEqual([]);
  });
});
