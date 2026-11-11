import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleThreadHistoryRoute } from "./thread-history-routes.js";

function fixture(available = true) {
  const services = { threadHistory: vi.fn(), threadPromptPart: vi.fn() };
  const ctx = {
    threadHistoryReads: available ? services : undefined,
    json: vi.fn(),
    requestError: vi.fn(),
  };
  const read = async (url: string) => {
    const req = { url, aborted: false, socket: { destroyed: false } } as IncomingMessage;
    await handleThreadHistoryRoute(ctx, "GET", url.split("?")[0]!, req, {
      destroyed: false,
    } as ServerResponse);
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
    expect(f.services.threadHistory).toHaveBeenCalledWith({
      threadId: "t",
      limit: 1,
      beforeTurnId: "mounted",
    });
    expect(f.ctx.json).toHaveBeenCalledWith(expect.anything(), 200, undefined);
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
