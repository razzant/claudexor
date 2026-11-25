import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_TURN_REPLIES_HEADER,
  CONTROL_CAPABILITIES_HEADER,
  ThreadHistoryPage,
  makeOutcomeFacts,
} from "@claudexor/schema";
import { handleThreadHistoryRoute } from "./thread-history-routes.js";

/** A valid empty history page: no turns, no head run. */
const emptyPage = (threadId: string): ThreadHistoryPage =>
  ThreadHistoryPage.parse({
    storeId: "store-1",
    threadId,
    epoch: "epoch-1",
    revision: { epoch: "6f1e2b4c-0d3a-4c5e-9f70-1a2b3c4d5e6f", sequence: 0 },
    header: {
      thread: {
        id: threadId,
        createdAt: "2026-11-25T00:00:00.000Z",
        updatedAt: "2026-11-25T00:00:00.000Z",
      },
      latestTurnId: null,
      latestOrdinal: null,
      latestAdmission: null,
      headRun: null,
      headRunStatus: "unbound",
      sessions: [],
      sessionsComplete: true,
    },
    turns: [],
    hasOlder: false,
    hasNewer: false,
    olderCursor: null,
    newerCursor: null,
    replayCursor: null,
    replayNextCursor: null,
    limitedBy: null,
  });

function fixture(available = true) {
  const services = {
    threadHistory: vi.fn((input: { threadId: string }) => emptyPage(input.threadId)),
    threadPromptPart: vi.fn(),
  };
  const ctx = {
    threadHistoryReads: available ? services : undefined,
    json: vi.fn(),
    requestError: vi.fn(),
  };
  const read = async (url: string, headers = {}) => {
    const req = new IncomingMessage(new Socket());
    req.url = url;
    req.headers = headers;
    const res = new ServerResponse(req);
    await handleThreadHistoryRoute(ctx, "GET", url.split("?")[0]!, req, res);
    return res;
  };
  return { ctx, services, read };
}

describe("history HTTP boundary", () => {
  it.each([
    "limit=0",
    "limit=21",
    "limit=1&limit=2",
    "limit=1.5",
    "limit=01",
    "cursor=a&afterTurnId=b",
    "unexpected=true",
  ])("refuses %s before reading while the valid query still works", async (query) => {
    const f = fixture();
    await f.read(`/threads/t/history?${query}`);
    expect(f.ctx.requestError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "invalid_thread_history_query", status: 400 }),
      500,
    );
    expect(f.services.threadHistory).not.toHaveBeenCalled();
    expect(f.ctx.json).not.toHaveBeenCalled();
    await f.read("/threads/t/history?limit=1&beforeTurnId=mounted");
    expect(f.services.threadHistory).toHaveBeenCalledWith(
      { threadId: "t", limit: 1, beforeTurnId: "mounted" },
      false,
    );
    expect(f.ctx.json).toHaveBeenCalledWith(expect.anything(), 200, emptyPage("t"));
  });

  it("negotiates reply previews per request without changing history selectors", async () => {
    const f = fixture();
    for (const value of ["1", "0", "true"]) {
      const res = await f.read("/threads/t/history", { [CLAUDE_TURN_REPLIES_HEADER]: value });
      expect(res.getHeader("Vary")).toBe(
        `${CLAUDE_TURN_REPLIES_HEADER}, ${CONTROL_CAPABILITIES_HEADER}`,
      );
      expect(f.services.threadHistory).toHaveBeenLastCalledWith(
        { threadId: "t", limit: 20 },
        value === "1",
      );
    }
  });

  it("negotiates run-deadline/1 facts per request on the same recorded page", async () => {
    const f = fixture();
    const page: ThreadHistoryPage = {
      ...emptyPage("t"),
      turns: [
        {
          run: {
            outcomeFacts: makeOutcomeFacts("cancelled", { reason: "run_deadline_expired" }),
            failure: null,
            runFacts: null,
          },
        },
      ] as unknown as ThreadHistoryPage["turns"],
    };
    f.services.threadHistory.mockReturnValue(page);
    const reasonFor = async (headers: Record<string, string>) => {
      const res = await f.read("/threads/t/history", headers);
      expect(res.getHeader("Vary")).toBe(
        `${CLAUDE_TURN_REPLIES_HEADER}, ${CONTROL_CAPABILITIES_HEADER}`,
      );
      const body = f.ctx.json.mock.lastCall?.[2] as ThreadHistoryPage;
      return body.turns[0]?.run?.outcomeFacts?.reason;
    };
    expect(await reasonFor({ [CONTROL_CAPABILITIES_HEADER]: "1" })).toBe("run_deadline_expired");
    expect(await reasonFor({})).toBe("host_cancelled");
    expect(await reasonFor({ [CONTROL_CAPABILITIES_HEADER]: "0" })).toBe("host_cancelled");
  });

  it("distinguishes unavailable service from successful empty history and bounds explicit prompt reads", async () => {
    const unavailable = fixture(false);
    await unavailable.read("/threads/t/history");
    expect(unavailable.ctx.json).not.toHaveBeenCalled();
    expect(unavailable.ctx.requestError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 503 }),
      500,
    );
    const f = fixture();
    await f.read("/threads/t/turns/turn/prompt?maxBytes=3");
    expect(f.services.threadPromptPart).not.toHaveBeenCalled();
    await f.read("/threads/t/turns/turn/prompt?maxBytes=4&offset=0");
    expect(f.services.threadPromptPart).toHaveBeenCalledWith({
      threadId: "t",
      turnId: "turn",
      maxBytes: 4,
      offset: 0,
    });
  });
});
