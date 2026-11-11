import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { ConformanceReport, ControlRunDetail, HarnessManifest } from "@claudexor/schema";
import { Orchestrator } from "../../orchestrator/src/orchestrator.js";
import { DaemonControlApiServer } from "../../control-api/src/daemon-server.js";

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  enqueueAndAwait: vi.fn(),
  fetchCouncil: vi.fn(),
}));
vi.mock("./daemon-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./daemon-run.js")>()),
  ensureDaemon: mocks.ensureDaemon,
  enqueueAndAwait: mocks.enqueueAndAwait,
  fetchCouncil: mocks.fetchCouncil,
  fetchRunDetail: async () => null,
  fetchApplyEligibility: async () => null,
  fetchPlanReadiness: async () => null,
  fetchRunOutcomeFacts: async () => null,
}));
vi.mock("./live.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./live.js")>()),
  followRun: async () => {},
}));

function planner(id: string, bad: boolean): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "openai",
        capabilities: {
          read_files: true,
          plan: true,
          work_report_transport: "constrained",
          json_schema_output: true,
          structured_output_channel: "final_message",
        },
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["plan", "synthesize"],
      });
    },
    async *run(spec) {
      const base = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...base, type: "started", credential_route: "vendor_native" };
      yield {
        ...base,
        type: "message",
        final: true,
        text: JSON.stringify({
          output: "# Prepared plan\n\n## Open Questions\n- (none)",
          work_report: {
            state: "completed",
            required_inputs:
              bad && spec.intent === "plan"
                ? [
                    {
                      kind: "decision",
                      locator: null,
                      description: "Choose the compatibility policy",
                    },
                  ]
                : [],
          },
        }),
      };
      yield { ...base, type: "completed" };
    },
  };
}

describe("Council human CLI terminal display", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  it.each([false, true])(
    "renders producer membership and original failed-member reason (all contradictory: %s)",
    async (allContradictory) => {
      const repo = mkdtempSync(join(tmpdir(), "claudexor-cli-council-"));
      roots.push(repo);
      writeFileSync(join(repo, "README.md"), "# Empty fixture repository\n");
      const addr = { baseUrl: "http://127.0.0.1:1", token: "fixture-only" };
      let fullDetail: ReturnType<typeof ControlRunDetail.parse> | undefined;
      mocks.ensureDaemon.mockResolvedValue({ client: {}, addr });
      mocks.enqueueAndAwait.mockImplementation(async (_client, _addr, body) => {
        expect(body).toMatchObject({ mode: "plan", council: true });
        const result = await new Orchestrator({
          registry: new Map([
            ["planner-a", planner("planner-a", true)],
            ["planner-b", planner("planner-b", allContradictory)],
          ]),
          reviewers: [],
        }).run({
          repoRoot: repo,
          prompt: body.prompt,
          mode: "plan",
          council: true,
          harnesses: ["planner-a", "planner-b"],
          primaryHarness: "planner-a",
          paidBudget: { kind: "unlimited" },
        });
        expect(result.lifecycle).toBe("succeeded");
        const record = {
          id: result.runId,
          runId: result.runId,
          taskId: result.taskId,
          runDir: result.runDir,
          state: result.lifecycle,
          params: {
            mode: "plan",
            council: true,
            prompt: body.prompt,
            scope: { kind: "project", root: repo, context: "auto" },
          },
        };
        const server = new DaemonControlApiServer({
          token: "council-http-fixture",
          daemon: {
            enqueue: async () => {
              throw new Error("read-only fixture");
            },
            status: async () => record,
            list: async () => [record],
            cancel: async () => {
              throw new Error("read-only fixture");
            },
          },
        });
        const { host, port } = await server.start();
        try {
          const response = await fetch(`http://${host}:${port}/v2/runs/${result.runId}`, {
            headers: {
              authorization: "Bearer council-http-fixture",
              "X-Claudexor-Protocol-Major": "3",
            },
          });
          expect(response.status).toBe(200);
          const detail = ControlRunDetail.parse(await response.json());
          fullDetail = detail;
          expect(detail.runFacts?.participants.planners).toBe(2);
          expect(detail.council?.members[0]).toMatchObject({ status: "failed" });
          mocks.fetchCouncil.mockResolvedValue(detail.council);
        } finally {
          await server.stop();
        }
        return { runId: result.runId, runDir: result.runDir, status: result.lifecycle };
      });
      const priorArgv = process.argv;
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      let output = "";
      let errors = "";
      const capture =
        (append: (chunk: string) => void) =>
        (...args: unknown[]) => {
          append(String(args[0] ?? ""));
          (args.find((arg) => typeof arg === "function") as (() => void) | undefined)?.();
          return true;
        };
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(
        capture((chunk) => {
          output += chunk;
        }) as never,
      );
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(
        capture((chunk) => {
          errors += chunk;
        }) as never,
      );
      process.argv = [process.execPath, "claudexor", "plan", "Prepare the plan", "--council"];
      try {
        await import("./cli.js");
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 2_500 });
      } finally {
        process.argv = priorArgv;
        stdout.mockRestore();
        stderr.mockRestore();
      }
      expect(errors).toBe("");
      expect(fullDetail?.candidates).toEqual([]);
      expect(output).toContain(
        `merged by ${allContradictory ? "planner-a" : "planner-b"}; ${allContradictory ? 0 : 1} of 2 contract-accepted draft(s) (degraded)`,
      );
      expect(output).toContain(
        "council failures: planner-a: work_report contract: a completed work_report must not list required_inputs",
      );
      expect(output).toContain(
        "Unverified draft retained for the merge: council/draft-planner-a.md",
      );
    },
  );
});
