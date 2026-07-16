import { describe, expect, it } from "vitest";
import { ControlThread } from "@claudexor/schema";
import { pickResumableThread } from "./thread-select.js";

const thread = (id: string, updatedAt: string, state = "active"): ControlThread =>
  ControlThread.parse({
    id,
    title: id,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt,
    state,
  });

describe("pickResumableThread (--resume, W13/G5)", () => {
  it("picks the most recently updated ACTIVE thread", () => {
    const picked = pickResumableThread([
      thread("old", "2026-07-16T09:00:00.000Z"),
      thread("newest", "2026-07-16T12:00:00.000Z"),
      thread("mid", "2026-07-16T10:00:00.000Z"),
    ]);
    expect(picked?.id).toBe("newest");
  });

  it("never resumes a trashed/archived thread, even if it is the newest", () => {
    const picked = pickResumableThread([
      thread("active-old", "2026-07-16T08:00:00.000Z"),
      thread("trashed-new", "2026-07-16T23:00:00.000Z", "trashed"),
    ]);
    expect(picked?.id).toBe("active-old");
  });

  it("returns undefined when there is no active thread to continue", () => {
    expect(pickResumableThread([])).toBeUndefined();
    expect(
      pickResumableThread([thread("t", "2026-07-16T09:00:00.000Z", "trashed")]),
    ).toBeUndefined();
  });
});
