import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ControlRunDetail,
  ControlThread,
  ControlThreadApplyResponse,
  ControlThreadTurnResponse,
} from "@claudexor/schema";
import { type Sandbox, cli, makeSandbox, readEvents, readRunYaml } from "./support.js";

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = makeSandbox();
});
afterEach(() => {
  sandbox.dispose();
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

describe("ordinary Agent review intent", () => {
  it.each([{ controls: [] }, { controls: ["--no-review", "--attempts", "3"] }])(
    "[INV-112:ordinary-unreviewed-apply] preserves opt-out through CLI, daemon and delivery: %j",
    ({ controls }) => {
      const run = cli(sandbox, [
        "agent",
        "Create the deterministic fixture change",
        "--harness",
        "fake-implement",
        ...controls,
        "--json",
      ]);
      expect(run.code, run.stdout + run.stderr).toBe(0);
      const result = run.json() as { runId: string; runDir: string; runFacts: unknown };
      const stored = readRunYaml(result.runDir, "final/run_facts.yaml");
      expect(stored).toMatchObject({
        outcome: { lifecycle: "succeeded", review: "not_run", review_requested: false },
        apply: { eligibility: { eligible: true, state: "not_verified" } },
        required_actions: [],
      });
      expect(result.runFacts).toEqual(stored);
      expect(readRunYaml(result.runDir, "context/task.yaml")).toMatchObject({
        review_requested: false,
      });
      const events = readEvents(result.runDir);
      expect(
        events.some((e) => e.type === "review.preflight" || e.type === "reviewer.started"),
      ).toBe(false);
      const stopped = cli(sandbox, ["daemon", "stop"]);
      expect(stopped.code, stopped.stdout + stopped.stderr).toBe(0);
      const inspected = cli(sandbox, ["inspect", result.runId, "--json"]);
      expect(inspected.code, inspected.stdout + inspected.stderr).toBe(0);
      expect((inspected.json() as { runFacts: unknown }).runFacts).toEqual(stored);
      const applied = cli(sandbox, ["apply", result.runId]);
      expect(applied.code, applied.stdout + applied.stderr).toBe(0);
      expect(readFileSync(join(sandbox.repo, "FAKE_CHANGE.txt"), "utf8")).toBe(
        "fake-implement deterministic change\n",
      );
    },
  );

  it.each([
    { command: "agent", controls: ["--review"] },
    { command: "best-of", controls: ["--n", "1"] },
  ])(
    "[INV-112:explicit-review-retained] retains requested review through the daemon: %j",
    ({ command, controls }) => {
      const run = cli(sandbox, [
        command,
        "Create the deterministic fixture change",
        "--harness",
        "fake-implement",
        ...controls,
        "--json",
      ]);
      expect(run.code, run.stdout + run.stderr).toBe(0);
      const result = run.json() as { runId: string; runDir: string };
      expect(readRunYaml(result.runDir, "context/task.yaml")).toMatchObject({
        review_requested: true,
      });
      expect(readRunYaml(result.runDir, "final/run_facts.yaml")).toMatchObject({
        outcome: { review: "not_run", review_requested: true },
        apply: { eligibility: { eligible: false } },
      });
      const apply = cli(sandbox, ["apply", result.runId, "--dry-run"]);
      expect(apply.code).toBe(1);
    },
  );

  it.each([
    { mode: "apply", review: false, gateExit: 0, expectedStatus: 200 },
    { mode: "branch", review: false, gateExit: 0, expectedStatus: 200 },
    { mode: "apply", review: true, gateExit: 0, expectedStatus: 409 },
    { mode: "apply", review: false, gateExit: 1, expectedStatus: 409 },
  ])(
    "[INV-112:isolated-thread-review-delivery] delivers through the real thread boundary: %j",
    async ({ mode, review, gateExit, expectedStatus }) => {
      const started = cli(sandbox, ["daemon", "start", "--json"]);
      expect(started.code, started.stdout + started.stderr).toBe(0);
      const address = JSON.parse(
        readFileSync(join(sandbox.configDir, "daemon", "control-api.json"), "utf8"),
      ) as { host: string; port: number };
      const token = readFileSync(join(sandbox.configDir, "daemon", "token"), "utf8").trim();
      let requestId = 0;
      const api = async <T>(
        method: string,
        path: string,
        body?: unknown,
        expected = 200,
      ): Promise<T> => {
        const response = await fetch(`http://${address.host}:${address.port}/v2${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-claudexor-protocol-major": "3",
            "idempotency-key": `thread-review-${++requestId}`,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        expect(response.status, text).toBe(expected);
        return JSON.parse(text) as T;
      };
      expect(await api("POST", "/handshake", { protocolMajor: 3, client: "canary" })).toMatchObject(
        {
          compatible: true,
        },
      );
      const thread = await api<ControlThread>("POST", "/threads", {
        scope: { kind: "project", root: sandbox.repo },
        mode: "agent",
        workspace: "isolated",
        primaryHarness: "fake-implement",
        eligibleHarnesses: ["fake-implement"],
      });
      const turn = await api<ControlThreadTurnResponse>("POST", `/threads/${thread.id}/turns`, {
        prompt: "Create the deterministic fixture change in this isolated thread",
        mode: "agent",
        review,
        ...(review ? {} : { attempts: expectedStatus === 200 ? 3 : 1 }),
        tests: [
          {
            program: process.execPath,
            args: [
              "-e",
              gateExit === 0
                ? "process.exit(require('fs').existsSync('FAKE_CHANGE.txt') ? 0 : 1)"
                : "process.exit(1)",
            ],
            envAllowlist: [],
          },
        ],
      });
      if (!("runId" in turn)) throw new Error(`thread turn did not start: ${JSON.stringify(turn)}`);
      await vi.waitFor(
        async () => {
          const detail = await api<ControlRunDetail>("GET", `/runs/${turn.runId}`);
          expect(["succeeded", "failed", "cancelled", "interrupted"]).toContain(
            detail.summary.state,
          );
        },
        { timeout: 60_000, interval: 100 },
      );

      // The turn wrote the persistent thread tree, not the original project.
      // Required review still controls the later transfer to the original root.
      // Do not fabricate a verifier receipt to get past the thread preflight.
      const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: sandbox.repo,
        encoding: "utf8",
      });
      const threadTree = worktrees
        .split("\n\n")
        .find((block) => block.includes(`branch refs/heads/claudexor/thread-${thread.id}`));
      const workspace = /^worktree (.+)$/m.exec(threadTree ?? "")?.[1];
      expect(workspace).toBeTruthy();
      const content = "fake-implement deterministic change\n";
      expect(readFileSync(join(workspace!, "FAKE_CHANGE.txt"), "utf8")).toBe(content);
      expect(existsSync(join(sandbox.repo, "FAKE_CHANGE.txt"))).toBe(false);
      const facts = readRunYaml(turn.runDir!, "final/run_facts.yaml");
      expect(facts).toMatchObject({
        outcome: {
          review_requested: review,
          review: "not_run",
          checks: gateExit === 0 ? "passed" : "failed",
        },
      });
      const decision = readRunYaml<{ final_verify: unknown }>(
        turn.runDir!,
        "arbitration/decision.yaml",
      );
      expect(decision.final_verify).toBeNull();
      if (expectedStatus === 200) {
        expect(readRunYaml(turn.runDir!, "final/work_product.yaml")).toMatchObject({
          meta: { adopted: true, apply_state: "applied" },
        });
      }

      const delivered = await api<ControlThreadApplyResponse & { code?: string }>(
        "POST",
        `/threads/${thread.id}/apply`,
        { mode, ...(mode === "branch" ? { branch: "canary/thread-review-off" } : {}) },
        expectedStatus,
      );
      if (expectedStatus === 409) {
        expect(delivered.code).toBe("thread_run_unverified");
        expect(existsSync(join(sandbox.repo, "FAKE_CHANGE.txt"))).toBe(false);
        return;
      }
      expect(delivered).toMatchObject({
        applied: true,
        status: mode === "branch" ? "branched" : "applied",
        delivery: { finalVerify: { attempted: true, applied_cleanly: true, gates_passed: true } },
      });
      expect(delivered.delivery?.targetPreimageSha).toMatch(/^[0-9a-f]{40}$/);
      expect(delivered.delivery?.finalVerify?.base_sha).toBe(delivered.delivery?.targetPreimageSha);
      expect(readFileSync(join(sandbox.repo, "FAKE_CHANGE.txt"), "utf8")).toBe(content);
      if (mode === "branch") {
        expect(
          execFileSync("git", ["branch", "--show-current"], {
            cwd: sandbox.repo,
            encoding: "utf8",
          }).trim(),
        ).toBe("canary/thread-review-off");
      }
      expect(readRunYaml(turn.runDir!, "arbitration/decision.yaml")).toMatchObject({
        facts: { review_requested: false, review: "not_run" },
      });
    },
  );
});
