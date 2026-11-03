import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHarness } from "@claudexor/harness-fake";
import {
  spawnProcess,
  reapProcessTree,
  WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE,
  type HarnessAdapter,
} from "@claudexor/core";
import { readRunEvents } from "@claudexor/event-log";
import { runCodexAppServer } from "../../harness-codex/src/app-server-run.js";
import { Orchestrator } from "./orchestrator.js";

const peer = fileURLToPath(
  new URL("../../harness-codex/fixtures/app-server/cleanup-peer.mjs", import.meta.url),
);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

describe("completed Codex verdict through the real read-only result owner", () => {
  it.each(['{"verdict":"PASS"}', '{"verdict":"FAIL","finding":"defect"}'])(
    "retains %s as a succeeded execution, never cleanup prose",
    async (text) => {
      const root = mkdtempSync(join(tmpdir(), "cx-codex-cleanup-"));
      roots.push(root);
      execFileSync("git", ["init", "-b", "main", root]);
      writeFileSync(join(root, "input.txt"), "fixture\n");
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "fixture",
      ]);
      const base = createFakeHarness("fake-work-complete");
      // Fake only discovery/conformance: actual Codex adapter, native child I/O,
      // orchestrator finality and durable result readers run below.
      const adapter: HarnessAdapter = {
        ...base,
        run: (spec) =>
          runCodexAppServer({
            bin: process.execPath,
            args: [peer],
            env: {
              CX_FIXTURE_ANSWER: JSON.stringify({
                work_report: { state: "completed", required_inputs: [] },
                output: text,
              }),
            },
            spec,
            pollIntervalMs: 0,
            spawn: (bin, args, options) =>
              spawnProcess(bin, args, {
                ...options,
                reap: async (opts) => {
                  const real = await reapProcessTree(opts);
                  if (real.state === "unconfirmed" && real.survivors.length) return real;
                  return {
                    state: "unconfirmed",
                    survivors: [],
                    unresolved: [
                      { pgid: opts.rootPid, reason: WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE },
                    ],
                  };
                },
              }),
          }),
      };
      const result = await new Orchestrator({
        registry: new Map([[adapter.id, adapter]]),
        reviewers: [],
      }).run({
        repoRoot: root,
        mode: "ask",
        prompt: "Return the fixture review",
        harnesses: [adapter.id],
      });
      expect(result.lifecycle, JSON.stringify(result)).toBe("succeeded");
      const answer = readFileSync(join(result.runDir, "final/answer.md"), "utf8");
      expect(answer.trim()).toBe(`# Answer\n\n${text}`);
      expect(answer).not.toContain("termination_unconfirmed");
      const events = readRunEvents(join(result.runDir, "events.jsonl")).events;
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "harness.completed",
          payload: expect.objectContaining({ status: "success" }),
        }),
      );
      const terminal = events.find(
        (e) => e.type === "harness.event" && e.payload["type"] === "completed",
      );
      expect(terminal?.payload["payload"]).toMatchObject({
        termination_unconfirmed: {
          survivors: [],
          unresolved: [{ reason: WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE }],
        },
      });
      // Kept inside the test sandbox until its owner cleans it, not a live run root.
    },
    30000,
  );
});
