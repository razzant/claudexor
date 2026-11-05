import { expect, it } from "vitest";
import { join } from "node:path";
import { ThreadHistoryPage, ThreadPromptPart } from "@claudexor/schema";
import { cli, makeSandbox, inspectSandboxLease } from "./support.js";
import { mcpStdioClient } from "./mcp-stdio.js";
import { ok, refused, daemonApi } from "./mcp-controller-support.js";

it("[INV-142:thread-history] built CLI/MCP reads bounded answers, explicit prompts and legacy detail", async () => {
  const sb = makeSandbox();
  const mcp = mcpStdioClient(sb);
  try {
    const absent = cli(sb, ["thread", "history", "missing", "--json"]);
    expect(absent.code).not.toBe(0);
    expect(inspectSandboxLease(sb.env, sb.repo).status).toBe("absent");
    await mcp.initialize();
    const thread = await ok(mcp, "claudexor_thread_create", {
      repoPath: sb.repo,
      title: "History canary",
    });
    for (const prompt of ["first question", "second question"]) {
      const result = cli(sb, [
        "ask",
        prompt,
        "--thread",
        thread.id,
        "--harness",
        "fake-success",
        "--json",
      ]);
      expect(result.code, result.stdout + result.stderr).toBe(0);
    }
    const result = cli(sb, ["thread", "history", thread.id, "--limit", "1", "--json"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const newest = ThreadHistoryPage.parse(result.json());
    expect(newest.turns).toHaveLength(1);
    expect(newest.turns[0]?.prompt).toBe("second question");
    expect(newest.turns[0]?.primaryOutput?.text).toBeTruthy();
    expect(newest.turns[0]?.run?.state).toBe("succeeded");
    expect(newest.turns[0]?.runStatus).toBe("available");
    expect(newest.turns[0]?.primaryOutputStatus).toBe("available");
    expect(newest.header.headRunStatus).toBe("available");
    expect(newest.header.latestOrdinal).toBe(1);
    expect(newest.turns[0]?.run?.runDir).toBeTruthy();
    expect(newest.turns[0]?.run).toHaveProperty("authRoute");
    const oldest = ThreadHistoryPage.parse(
      await ok(mcp, "claudexor_thread_history", {
        threadId: thread.id,
        limit: 1,
        cursor: newest.olderCursor,
      }),
    );
    expect(oldest.turns[0]?.prompt).toBe("first question");
    expect(oldest.header.latestOrdinal).toBe(1);
    const before = ThreadHistoryPage.parse(
      await ok(mcp, "claudexor_thread_history", {
        threadId: thread.id,
        limit: 1,
        beforeTurnId: oldest.turns[0]!.id,
      }),
    );
    expect(before.turns).toEqual([]);
    expect(before.hasNewer).toBe(true);
    const reverse = cli(sb, [
      "thread",
      "history",
      thread.id,
      "--limit",
      "1",
      "--cursor",
      before.newerCursor!,
      "--json",
    ]);
    expect(reverse.code, reverse.stdout + reverse.stderr).toBe(0);
    expect(ThreadHistoryPage.parse(reverse.json()).turns[0]?.id).toBe(oldest.turns[0]!.id);
    const part = ThreadPromptPart.parse(
      await ok(mcp, "claudexor_thread_prompt", {
        threadId: thread.id,
        turnId: oldest.turns[0]!.id,
        maxBytes: 4,
      }),
    );
    expect(part.text).toBe("firs");
    expect(part.totalBytes).toBe(14);
    const invalid = cli(sb, [
      "thread",
      "history",
      thread.id,
      "--cursor",
      newest.olderCursor!,
      "--limit",
      "2",
      "--json",
    ]);
    expect(invalid.code).not.toBe(0);
    expect(invalid.json()).toMatchObject({ code: "thread_history_cursor_stale" });
    await refused(mcp, "claudexor_thread_history", { threadId: thread.id, cursor: "not=a=cursor" });
    const legacy = await daemonApi(sb)(`/threads/${thread.id}`);
    expect(legacy.turns).toHaveLength(2);
    expect(legacy.thread.runIds).toHaveLength(2);
    const { DatabaseSync } = await import("node:sqlite");
    const store = new DatabaseSync(join(sb.configDir, "daemon", "engine.sqlite"), {
      readOnly: true,
    });
    try {
      expect(store.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
      expect(store.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
        value: "7",
      });
      expect(
        store.prepare("SELECT name FROM sqlite_master WHERE name='turn_plan_answer'").get(),
      ).toEqual({ name: "turn_plan_answer" });
      expect(
        store.prepare("SELECT name FROM sqlite_master WHERE name='thread_history_header'").get(),
      ).toBeUndefined();
    } finally {
      store.close();
    }
  } finally {
    await mcp.close();
    sb.dispose();
  }
}, 180_000);
