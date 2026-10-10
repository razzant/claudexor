import { describe, expect, it } from "vitest";
import { continuationRefusal, selectRunListPage, type CommandListQuery } from "@claudexor/schema";
import { selectProductCommands } from "./store/test-support/fixtures/legacy/daemon/command-retention.js";
import { publicCommandList } from "./store/test-support/fixtures/legacy/daemon/command-list-projection.js";
import type { JobRecord } from "./job-record.js";

const record = (
  id: string,
  params: Record<string, unknown> = {},
  state: JobRecord["state"] = "failed",
): JobRecord => ({
  id: `job-${id}`,
  runId: `run-${id}`,
  createdAt: "2026-10-08T00:00:00.000Z",
  state,
  params: { mode: "ask", prompt: "original prompt", ...params },
});

describe("addressed command selection", () => {
  it.each([undefined, null, {}, { surprise: true }, { id: "x", activeOnly: true }])(
    "refuses an unaddressed or mixed query %j",
    (query) => {
      expect(() => publicCommandList([], query)).toThrowError(
        expect.objectContaining({
          status: 400,
          code: query == null ? "list_query_required" : "invalid_command_list_query",
        }),
      );
      expect(publicCommandList([], { id: "missing" })).toEqual([]);
    },
  );

  it("matches full-history continuation verdicts, aliases, rejected successors, cycles and head", () => {
    const unrelated = Array.from({ length: 1600 }, (_, i) =>
      record(`other-${i}`, {
        instructions: {
          get body() {
            throw new Error("unrelated body traversed");
          },
        },
      }),
    );
    const chain = [
      record("p"),
      record("s", { continueFrom: "job-p" }),
      record("head", { continueFrom: "run-s" }),
    ];
    const rejected = { ...record("rejected", { continueFrom: "run-p" }), runId: undefined };
    for (const relevant of [
      chain,
      [rejected, ...chain],
      [chain[0]!],
      [record("live", {}, "running")],
      [record("thread", { threadId: "th" })],
      [record("cycle", { continueFrom: "run-cycle" })],
    ]) {
      const all = [...unrelated, ...relevant];
      for (const from of [
        "job-p",
        "run-p",
        "run-s",
        "run-head",
        "run-live",
        "run-thread",
        "run-cycle",
        "missing",
      ]) {
        const request = { mode: "ask", continueFrom: from };
        const selected = publicCommandList(all, { continuationChainOf: from });
        expect(continuationRefusal(request, selected)).toEqual(continuationRefusal(request, all));
      }
    }
    expect(
      continuationRefusal(
        { continueFrom: "run-p" },
        publicCommandList(chain, { continuationChainOf: "run-p" }),
      ),
    ).toMatchObject({ context: { head: "run-head" } });
    expect(
      continuationRefusal(
        { continueFrom: "run-head" },
        publicCommandList(chain, { continuationChainOf: "run-head" }),
      ),
    ).toBeNull();
  });

  it("bounds pages before projection and keeps keyset neighbors after cursor pruning", () => {
    const rows = Array.from({ length: 1600 }, (_, i) =>
      record(String(i).padStart(4, "0"), { prompt: "large input ".repeat(1000) }),
    );
    const query = { limit: 5, state: null, cursor: null };
    const expected = selectRunListPage(rows, query);
    const selected = publicCommandList(rows, { page: query });
    expect(selected).toHaveLength(6);
    expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeGreaterThan(16 * 1024 * 1024);
    expect(selectRunListPage(selected, query).page.map((r) => r.id)).toEqual(
      expected.page.map((r) => r.id),
    );
    const cursor = { id: expected.page.at(-1)!.id, createdAt: expected.page.at(-1)!.createdAt };
    const pruned = rows.filter((r) => r.id !== cursor.id);
    const nextQuery = { ...query, cursor };
    const next = selectRunListPage(publicCommandList(pruned, { page: nextQuery }), nextQuery);
    expect(next.page.map((r) => r.id)).toEqual(
      selectRunListPage(rows, nextQuery).page.map((r) => r.id),
    );
    expect(next.nextCursor).toEqual(selectRunListPage(rows, nextQuery).nextCursor);
    expect(selected[0]).not.toHaveProperty("params.prompt");
    expect(selected[0]).toHaveProperty("promptPreview", "large input ".repeat(20) + "...");
  });

  it("selects thread, ids and uncapped descendants without unrelated bodies; one full turn retry", () => {
    const poison = record("foreign", {
      instructions: {
        get body() {
          throw new Error("unrelated body traversed");
        },
      },
    });
    const parent = record("parent", { threadId: "th" });
    const children = Array.from({ length: 1010 }, (_, i) =>
      record(
        `child-${i}`,
        {
          delegatedFromRunId: i ? `run-child-${i - 1}` : "run-parent",
          threadId: "th",
          turnId: "turn",
        },
        i ? "failed" : "queued",
      ),
    );
    const all = [poison, parent, ...children];
    const cases: [CommandListQuery, number][] = [
      [{ delegatedDescendantsOf: "run-parent" }, 1010],
      [{ threadId: "th" }, 1011],
      [{ threadIds: ["th"] }, 1011],
      [{ threadId: "th", activeOnly: true }, 1],
      [{ activeOnly: true }, 1],
      [{ ids: ["run-parent", "job-child-0"] }, 2],
      [{ id: "run-parent" }, 1],
      [{ turnId: "turn" }, 1],
    ];
    for (const [query, count] of cases) expect(publicCommandList(all, query)).toHaveLength(count);
    expect(publicCommandList(all, { turnId: "turn" })[0]).toMatchObject({
      id: "job-child-1009",
      params: { prompt: "original prompt" },
    });
    expect(publicCommandList(all, { threadId: "missing" })).toEqual([]);
    expect(publicCommandList(all, { threadId: "undefined" })).toEqual([]);
    expect(publicCommandList(all, { threadIds: ["null", "undefined"] })).toEqual([]);
    expect(selectProductCommands(all, { delegatedDescendantsOf: "run-parent" })).toEqual(children);
  });
});
