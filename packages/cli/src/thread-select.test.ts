import { describe, expect, it } from "vitest";
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
