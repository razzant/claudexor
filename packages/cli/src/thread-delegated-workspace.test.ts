import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControlRunStartRequest,
  SCHEMA_VERSION,
  Thread as ThreadSchema,
  type Thread,
} from "@claudexor/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertThreadExecutionBinding,
  resolveThreadExecutionWorkspace,
  threadExecutionRequiresWorktree,
} from "./thread-execution-workspace.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cx-delegated-ws-"));
  roots.push(dir);
  return dir;
}

function delegatedThread(workspaceRoot: string, repoRoot = "/author/project"): Thread {
  return ThreadSchema.parse({
    schema_version: SCHEMA_VERSION,
    id: "th-del",
    created_at: "2026-10-08T00:00:00.000Z",
    updated_at: "2026-10-08T00:00:00.000Z",
    repo: { root: repoRoot, base_ref: "HEAD" },
    mode: "agent",
    workspace: { mode: "delegated", workspace_root: workspaceRoot },
  });
}

function ordinaryThread(mode: "in_place" | "isolated" = "in_place"): Thread {
  return ThreadSchema.parse({
    schema_version: SCHEMA_VERSION,
    id: "th-ord",
    created_at: "2026-10-08T00:00:00.000Z",
    updated_at: "2026-10-08T00:00:00.000Z",
    repo: { root: "/author/project", base_ref: "HEAD" },
    workspace: { mode },
  });
}

function request(execution: Record<string, unknown>, root = "/author/project") {
  return ControlRunStartRequest.parse({
    prompt: "check",
    mode: "agent",
    scope: { kind: "project", root },
    execution,
    threadId: "th-del",
  });
}

describe("delegated thread workspace resolution", () => {
  it.each([
    ["agent", "workspace_write"],
    ["agent", "full"],
    ["agent", "readonly"],
    ["ask", undefined],
    ["plan", undefined],
  ] as const)(
    "%s (%s) executes in the caller-owned root without a managed worktree or promotion",
    async (mode, access) => {
      const root = tempDir();
      const ensureWorktree = vi.fn();
      const setThreadWorktree = vi.fn();
      await expect(
        resolveThreadExecutionWorkspace({
          threadId: "th-del",
          repoRoot: "/author/project",
          mode,
          access,
          requestedInPlace: mode === "agent",
          // Protected paths would promote an in_place thread; never this one.
          protectedPaths: ["protected/**"],
          threads: { getThread: () => delegatedThread(root), setThreadWorktree },
          ensureWorktree,
        }),
      ).resolves.toEqual({ executionRoot: root, inPlace: true, promoted: false });
      expect(ensureWorktree).not.toHaveBeenCalled();
      expect(setThreadWorktree).not.toHaveBeenCalled();
    },
  );

  it("keeps explicit directory execution sourced from the bound root", async () => {
    const root = tempDir();
    const threads = { getThread: () => delegatedThread(root), setThreadWorktree: vi.fn() };
    for (const requestedInPlace of [true, false]) {
      await expect(
        resolveThreadExecutionWorkspace({
          threadId: "th-del",
          repoRoot: "/author/project",
          mode: "agent",
          requestedInPlace,
          workspaceKind: "directory",
          protectedPaths: [],
          threads,
        }),
      ).resolves.toEqual({ executionRoot: root, inPlace: requestedInPlace, promoted: false });
    }
  });

  it("refuses a missing caller root as a retryable typed refusal, never the project root", async () => {
    const root = join(tempDir(), "gone");
    const ensureWorktree = vi.fn();
    await expect(
      resolveThreadExecutionWorkspace({
        threadId: "th-del",
        repoRoot: "/author/project",
        mode: "agent",
        requestedInPlace: true,
        protectedPaths: [],
        threads: { getThread: () => delegatedThread(root), setThreadWorktree: vi.fn() },
        ensureWorktree,
      }),
    ).rejects.toMatchObject({
      code: "delegated_workspace_unavailable",
      retryable: true,
      status: 409,
    });
    expect(ensureWorktree).not.toHaveBeenCalled();
  });

  it("never requires a managed worktree for a delegated thread", () => {
    expect(
      threadExecutionRequiresWorktree({
        thread: delegatedThread("/caller/copy"),
        mode: "agent",
        access: "full",
        protectedPaths: ["protected/**"],
      }),
    ).toBe(false);
  });
});

describe("thread execution binding (raw daemon agreement)", () => {
  it("accepts exactly the bound delegated execution", () => {
    expect(() =>
      assertThreadExecutionBinding(
        delegatedThread("/caller/copy"),
        request({ isolation: "live", delegated: true, workspaceRoot: "/caller/copy" }),
      ),
    ).not.toThrow();
  });

  it.each([
    ["a different root", { isolation: "live", delegated: true, workspaceRoot: "/elsewhere" }],
    ["no root", { isolation: "live", delegated: true }],
    ["no delegated authority", { isolation: "live", workspaceRoot: "/caller/copy" }],
  ])("refuses a delegated thread run with %s", (_label, execution) => {
    expect(() =>
      assertThreadExecutionBinding(delegatedThread("/caller/copy"), request(execution)),
    ).toThrow(expect.objectContaining({ code: "thread_execution_mismatch", retryable: false }));
  });

  it("refuses a run whose project is not the thread's project", () => {
    expect(() =>
      assertThreadExecutionBinding(
        delegatedThread("/caller/copy"),
        request(
          { isolation: "live", delegated: true, workspaceRoot: "/caller/copy" },
          "/another/project",
        ),
      ),
    ).toThrow(expect.objectContaining({ code: "thread_execution_mismatch" }));
  });

  it.each(["in_place", "isolated"] as const)(
    "refuses a forged delegated root on an ordinary %s thread",
    (mode) => {
      expect(() =>
        assertThreadExecutionBinding(
          ordinaryThread(mode),
          request({ isolation: "live", delegated: true, workspaceRoot: "/caller/copy" }),
        ),
      ).toThrow(expect.objectContaining({ code: "thread_execution_mismatch" }));
      expect(() =>
        assertThreadExecutionBinding(ordinaryThread(mode), request({ isolation: "live" })),
      ).not.toThrow();
    },
  );
});
