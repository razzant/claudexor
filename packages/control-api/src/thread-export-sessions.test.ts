import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  threadExportDigest,
  threadExportItemId,
  threadExportLinkIdentity,
} from "@claudexor/schema";
import { storeSessionMaterial } from "./thread-export-native.js";
import {
  nameOwnedBy,
  recordedStart,
  runSessionObservations,
  transcriptFacts,
} from "./thread-export-sessions.js";
import { walkTree } from "./thread-export-walk.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
const tree = () => {
  const root = mkdtempSync(join(tmpdir(), "cx-export-"));
  roots.push(root);
  return root;
};
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

describe("recorded starts", () => {
  it("reads both envelopes the run tree holds", () => {
    expect(
      recordedStart({
        type: "started",
        credential_profile_id: "p",
        payload: { native_session_id: "s" },
      }),
    ).toEqual({ nativeSessionId: "s", harness: null, attemptId: null, profileId: "p" });
    expect(
      recordedStart({
        type: "harness.event",
        payload: {
          harness_id: "codex",
          attempt_id: "a1",
          type: "started",
          payload: { native_session_id: "s" },
        },
      }),
    ).toEqual({ nativeSessionId: "s", harness: "codex", attemptId: "a1", profileId: null });
  });

  it.each([
    ["a start with no native session", { type: "started", payload: {} }],
    [
      "another event naming the key",
      { type: "status", payload: { code: "probe", native_session_id: "s" } },
    ],
    [
      "a wrapped non-start",
      { type: "harness.event", payload: { type: "status", payload: { native_session_id: "s" } } },
    ],
    [
      "tool output quoting a start",
      { type: "tool_result", text: '{"type":"started","payload":{"native_session_id":"s"}}' },
    ],
    ["a non-object", "started"],
  ])("ignores %s", (_name, row) => {
    expect(recordedStart(row)).toBeNull();
  });

  it("attributes a bare attempt event through its run log and names what it cannot read", async () => {
    const root = tree();
    const attempt = join(root, "attempts", "a01", "events.jsonl");
    write(
      attempt,
      `${JSON.stringify({ type: "started", payload: { native_session_id: "sid-1" } })}\n` +
        `{"type":"started","payload":{"native_session_id":"torn"\n`,
    );
    write(
      join(root, "events.jsonl"),
      `${JSON.stringify({
        type: "harness.event",
        payload: {
          harness_id: "claude",
          attempt_id: "a01",
          type: "started",
          payload: { native_session_id: "sid-1" },
        },
      })}\n`,
    );
    const { entries } = await walkTree(root);
    const seen = await runSessionObservations("run", entries);
    expect(seen.observations.map((o) => [o.source, o.harness, o.attemptId])).toEqual(
      expect.arrayContaining([
        ["attempt_event", "claude", "a01"],
        ["run_event", "claude", "a01"],
      ]),
    );
    expect(seen.problems).toEqual([expect.stringContaining("unreadable start record")]);
  });

  it("does not hold or decode a huge unrelated line", async () => {
    const root = tree();
    const huge = "x".repeat(9 << 20);
    // Unrelated: it names no native session, so it cannot hold a start.
    write(
      join(root, "events.jsonl"),
      `{"text":"${huge}","other":"not parsed"}\n` +
        `${JSON.stringify({
          type: "harness.event",
          payload: {
            harness_id: "claude",
            attempt_id: "a",
            type: "started",
            payload: { native_session_id: "after" },
          },
        })}\n`,
    );
    const { entries } = await walkTree(root);
    const seen = await runSessionObservations("run", entries);
    expect(seen.problems).toEqual([]);
    expect(seen.observations.map((o) => o.nativeSessionId)).toEqual(["after"]);
  });
});

describe("starts in lines over the read bound", () => {
  it("reports a start marker in an oversized line instead of dropping it", async () => {
    const root = tree();
    write(
      join(root, "events.jsonl"),
      `${JSON.stringify({
        type: "harness.event",
        payload: {
          harness_id: "claude",
          attempt_id: "a",
          type: "started",
          payload: { native_session_id: "hidden" },
          text: "x".repeat(9 << 20),
        },
      })}\n`,
    );
    const { entries } = await walkTree(root);
    const seen = await runSessionObservations("run", entries);
    expect(seen.observations).toEqual([]);
    expect(seen.problems).toEqual([expect.stringContaining("events.jsonl")]);
  });
});

describe("session-bound names", () => {
  it("binds exact ids, bounded", () => {
    expect(nameOwnedBy("sid-1.jsonl", "sid-1")).toBe(true);
    expect(nameOwnedBy("rollout-2026-sid-1.jsonl.zst", "sid-1")).toBe(true);
    expect(nameOwnedBy("sid-1-agent-sid-1.json", "sid-1")).toBe(true);
    expect(nameOwnedBy("sid-10.jsonl", "sid-1")).toBe(false);
    expect(nameOwnedBy("xsid-1.jsonl", "sid-1")).toBe(false);
  });

  it("walks only declared locations, never enters a link, and carries a matched directory", async () => {
    const root = tree();
    const secret = join(tree(), "secret.txt");
    write(secret, "OUTSIDE");
    write(join(root, "projects", "-w", "sid-1.jsonl"), "t\n");
    write(join(root, "projects", "-w", "sid-1", "tool-results", "a.txt"), "a\n");
    symlinkSync(secret, join(root, "projects", "-w", "sid-1", "link"));
    write(join(root, "projects", "-w", "sid-2.jsonl"), "other\n");
    write(join(root, "todos", "sid-1-agent-sid-1.json"), "[]\n");
    write(join(root, "undeclared", "sid-1.txt"), "never listed\n");
    symlinkSync(join(root, "projects"), join(root, "todos", "sid-1-linkdir"));
    symlinkSync(join(root, "projects"), join(root, "projects", "looped"));
    const material = await storeSessionMaterial(
      { storeKey: "s", profileId: null, root },
      { projects: 2, todos: 1, absent: 1 },
      ["sid-1"],
    );
    expect(material.problems).toEqual([]);
    const entries = material.owned.get("sid-1")!;
    expect(entries.map((entry) => [entry.rel, entry.kind]).sort()).toEqual([
      ["projects/-w/sid-1.jsonl", "file"],
      ["projects/-w/sid-1/link", "symlink"],
      ["projects/-w/sid-1/tool-results/a.txt", "file"],
      ["todos/sid-1-agent-sid-1.json", "file"],
      ["todos/sid-1-linkdir", "symlink"],
    ]);
  });
});

describe("digest formula", () => {
  it("matches an independent computation of the published formula", () => {
    const a = createHash("sha256").update("a").digest("hex");
    const b = createHash("sha256").update("b").digest("hex");
    const idA = threadExportItemId("run", "runs/r/a.txt");
    const idB = threadExportItemId("lane", "lanes/t/b.txt");
    expect(idA).toMatch(/^i[0-9a-f]{32}$/);
    const lines = [`${idA} ${a} 1\n`, `${idB} ${b} 1\n`].sort();
    const expected = `sha256:${createHash("sha256").update(lines.join("")).digest("hex")}`;
    expect(
      threadExportDigest([
        { itemId: idB, sha256: `sha256:${b}`, sizeBytes: 1 },
        { itemId: idA, sha256: `sha256:${a}`, sizeBytes: 1 },
      ]),
    ).toBe(expected);
    expect(threadExportLinkIdentity("é")).toEqual({
      sha256: `sha256:${createHash("sha256").update("é").digest("hex")}`,
      sizeBytes: 2,
    });
  });
});

describe("store references a transcript names", () => {
  const transcript = (values: Record<string, string>) => {
    const path = join(tree(), "s.jsonl");
    write(path, `${JSON.stringify({ version: "2.1.316", ...values })}\n`);
    return path;
  };

  it("are read by Windows path rules from a Windows transcript", async () => {
    const path = transcript({
      plan: "C:\\owned\\store\\plans\\referenced.md",
      spilled: "c:/OWNED/Store/projects/-c/s/tool-results/x.txt",
      sibling: "C:\\owned\\storeroom\\elsewhere.md",
      prose: "see C:\\owned\\store\\plans\\referenced.md",
    });
    const facts = await transcriptFacts(path, "version", ["C:\\owned\\store\\"], "win32");
    expect([...facts.storeReferences].sort()).toEqual([
      "plans/referenced.md",
      "projects/-c/s/tool-results/x.txt",
    ]);
  });

  it("keep Darwin's exact separator, where a backslash is part of a name", async () => {
    const path = transcript({
      plan: "/owned/store/plans/referenced.md",
      named: "/owned/store\\plans\\not-inside.md",
      cased: "/OWNED/store/plans/other.md",
    });
    for (const platform of ["darwin", "linux"] as const) {
      const facts = await transcriptFacts(path, "version", ["/owned/store"], platform);
      expect([...facts.storeReferences]).toEqual(["plans/referenced.md"]);
    }
  });
});
