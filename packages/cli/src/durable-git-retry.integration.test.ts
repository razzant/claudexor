import { legacyCommandFixture } from "../../daemon/src/store/test-support/legacy-command-fixture.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterRegistry, HarnessAdapter } from "@claudexor/core";
import { CommandStore } from "../../daemon/src/store/test-support/fixtures/legacy/daemon/command-store.js";
import { DaemonClient, DaemonServer, type JobRecord } from "@claudexor/daemon";
import { ThreadStore } from "../../daemon/src/store/test-support/fixtures/legacy/daemon/threads.js";
import { DaemonControlApiServer, normalizeRunStartRequest } from "@claudexor/control-api";
import { DurableJournal } from "../../daemon/src/store/test-support/fixtures/legacy/journal/index.js";
import {
  Attachment,
  ControlRunStartRequest,
  HarnessManifest,
  HarnessRunSpec,
  type GitCapability,
  type ResourceAttachmentRef,
} from "@claudexor/schema";
import { describe, expect, it } from "vitest";
import { createRunRequirementsPreflight, preflightRunGitRequirement } from "./request-preflight.js";
import { threadRunStartRequiresGit } from "./thread-execution-workspace.js";

async function awaitTerminal(client: DaemonClient, jobId: string): Promise<JobRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = (await client.status(jobId)) as JobRecord;
    if (record.state !== "queued" && record.state !== "running") return record;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${jobId} did not reach a terminal state`);
}

describe("durable thread Git preflight", () => {
  it("QA-D19: Exact Retry replays the refused target and resources after Git becomes available", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-git-retry-")));
    const repo = join(root, "repo");
    const runDir = join(root, "run-retried");
    const resourcePath = join(root, "contract.txt");
    mkdirSync(repo, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(resourcePath, "immutable contract\n");

    const journal = new DurableJournal({
      rootDir: join(root, "journal"),
      partition: "project:git-retry",
    });
    const commands = new CommandStore(journal);
    const threads = new ThreadStore(journal);
    const thread = threads.createThread({
      repoRoot: repo,
      mode: "agent",
      workspace: "isolated",
      primaryHarness: "provider-fixture",
      eligibleHarnesses: ["provider-fixture"],
    });

    const attachment = Attachment.parse({
      resource_id: "res-contract",
      kind: "file",
      mime: "text/plain",
      name: "contract.txt",
      sha256: `sha256:${"a".repeat(64)}`,
      size_bytes: 19,
      path: resourcePath,
    });
    const resources = {
      resolve(refs: ResourceAttachmentRef[] = []) {
        return refs.map((ref) => {
          if (ref.resourceId !== attachment.resource_id) {
            throw new Error(`unknown resource: ${ref.resourceId}`);
          }
          return attachment;
        });
      },
    };

    let providerCalls = 0;
    const providerSpecs: HarnessRunSpec[] = [];
    const provider: HarnessAdapter = {
      id: "provider-fixture",
      async discover() {
        return HarnessManifest.parse({
          id: "provider-fixture",
          display_name: "Provider fixture",
          kind: "local_cli",
          provider_family: "local",
          capabilities: { implement: true },
          capability_profile: {
            attachment_inputs: [
              {
                kind: "file",
                mime_types: ["text/plain"],
                max_bytes: 1024,
                max_count: 1,
                transport: "text_inline",
              },
            ],
          },
          access_profiles_supported: ["readonly", "workspace_write", "full"],
        });
      },
      async doctor() {
        throw new Error("the requirements preflight must not run provider doctor");
      },
      async *run(spec) {
        providerCalls += 1;
        providerSpecs.push(structuredClone(spec));
      },
    };
    const registry: AdapterRegistry = new Map([[provider.id, provider]]);

    let gitAvailable = false;
    let controlGitProbes = 0;
    let daemonGitProbes = 0;
    const gitCapability = (owner: "control" | "daemon") => async (): Promise<GitCapability> => {
      if (owner === "control") controlGitProbes += 1;
      else daemonGitProbes += 1;
      return gitAvailable
        ? {
            status: "available",
            version: "git version fixture",
            detail: null,
            remediation: null,
          }
        : {
            status: "missing",
            version: null,
            detail: "No executable named git was found on PATH.",
            remediation: "Install Git and retry.",
          };
    };
    const preflightThreadRunRequirements = createRunRequirementsPreflight(
      resources,
      root,
      {
        registry,
        gitCapability: gitCapability("control"),
        requiresGit: (request) =>
          threadRunStartRequiresGit(request, threads.getThread(thread.id), []),
      },
      { git: "durable_job" },
    );

    const runnerInputs: ControlRunStartRequest[] = [];
    const socketPath = join(root, "daemon.sock");
    const token = "git-retry-token";
    const daemon = new DaemonServer({
      socketPath,
      token,
      commands: legacyCommandFixture({ current: () => commands }),
      onTurnEnqueueFailed: (turnId, problem) => threads.setTurnEnqueueError(turnId, problem),
      runner: async (raw, context) => {
        const request = normalizeRunStartRequest(raw);
        runnerInputs.push(structuredClone(request));
        await preflightRunGitRequirement(request, {
          gitCapability: gitCapability("daemon"),
          requiresGit: (candidate) =>
            threadRunStartRequiresGit(
              candidate,
              candidate.threadId ? threads.getThread(candidate.threadId) : undefined,
              [],
            ),
        });

        const turn = request.turnId ? threads.getTurn(request.turnId) : undefined;
        if (!turn) throw new Error("durable turn disappeared before provider execution");
        const spec = HarnessRunSpec.parse({
          session_id: "ses-git-retry",
          intent: "implement",
          prompt: request.prompt,
          instructions: request.instructions,
          cwd: repo,
          access: request.access,
          external_context_policy: request.web ?? request.externalContextPolicy ?? "auto",
          model_hint: request.models?.[provider.id] ?? request.model ?? null,
          effort_hint: request.efforts?.[provider.id] ?? request.effort ?? null,
          max_turns: request.maxTurns ?? null,
          auth_preference: request.authPreference,
          attachments: turn.attachments,
        });
        context.onRunStart({ runId: "run-retried", taskId: "task-retried", runDir });
        threads.bindTurnRun(turn.id, "run-retried");
        for await (const _event of provider.run(spec)) {
          // The fixture intentionally emits no events; invocation is the assertion.
        }
        return { lifecycle: "succeeded" };
      },
    });
    const daemonClient = new DaemonClient(socketPath, token);
    const control = new DaemonControlApiServer({
      token,
      daemon: daemonClient,
      pollMs: 5,
      runStartTimeoutMs: 2_000,
      services: {
        threadDetail: async (id) => {
          const value = threads.getThread(id);
          if (!value) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
          return { thread: value, sessions: [], turns: threads.turnsFor(id) };
        },
        createThreadTurn: async (id, prompt, options) =>
          threads.createTurn(id, prompt, {
            parentRunId: options.parentRunId,
            planRunId: options.planRunId,
            planHash: options.planHash,
            planOverridden: options.planOverridden,
            attachments: resources.resolve(options.attachments),
            idempotency: options.idempotency,
          }),
        setTurnEnqueueError: (turnId, problem) => threads.setTurnEnqueueError(turnId, problem),
        preflightThreadRunRequirements,
      },
    });

    await daemon.start();
    const address = await control.start();
    const base = `http://${address.host}:${address.port}/v2`;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-claudexor-protocol-major": "3",
    };
    const prompt = "Implement the attached contract without changing its scope.";
    const turnRequest = {
      prompt,
      mode: "agent",
      harnesses: [provider.id],
      primaryHarness: provider.id,
      attempts: 3,
      access: "workspace_write",
      web: "off",
      models: { [provider.id]: "fixture-model" },
      efforts: { [provider.id]: "high" },
      attachments: [{ resourceId: attachment.resource_id }],
    };

    try {
      const refusedResponse = await fetch(`${base}/threads/${thread.id}/turns`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": "git-refused-turn" },
        body: JSON.stringify(turnRequest),
      });
      expect(refusedResponse.status).toBe(503);
      const refused = (await refusedResponse.json()) as {
        code: string;
        retryable: boolean;
        context: { jobId: string; turnId: string };
      };
      expect(refused).toMatchObject({
        code: "git_missing",
        retryable: true,
      });
      expect(controlGitProbes).toBe(0);
      expect(daemonGitProbes).toBe(1);
      expect(providerCalls).toBe(0);
      await expect(awaitTerminal(daemonClient, refused.context.jobId)).resolves.toMatchObject({
        state: "failed",
        errorCode: "git_missing",
        errorRetryable: true,
      });

      const replayedProjection = new ThreadStore(journal);
      expect(replayedProjection.getTurn(refused.context.turnId)).toMatchObject({
        id: refused.context.turnId,
        thread_id: thread.id,
        run_id: null,
        prompt,
        attachments: [attachment],
        enqueue_error: {
          code: "git_missing",
          retryable: true,
          required_actions: ["Install Git and retry."],
          context: { capability: "git", capabilityStatus: "missing" },
        },
      });

      gitAvailable = true;
      const retryResponse = await fetch(
        `${base}/threads/${thread.id}/turns/${refused.context.turnId}/retry`,
        {
          method: "POST",
          headers: { ...headers, "Idempotency-Key": "git-now-available" },
          body: "{}",
        },
      );
      expect(retryResponse.status).toBe(200);
      const retried = (await retryResponse.json()) as { jobId: string; runId: string };
      expect(retried.runId).toBe("run-retried");
      await expect(awaitTerminal(daemonClient, retried.jobId)).resolves.toMatchObject({
        state: "succeeded",
        runId: "run-retried",
      });

      expect(daemonGitProbes).toBe(2);
      expect(providerCalls).toBe(1);
      expect(runnerInputs).toHaveLength(2);
      expect(runnerInputs[1]).toEqual(runnerInputs[0]);
      expect(runnerInputs[1]).toMatchObject({
        prompt,
        scope: { kind: "project", root: repo },
        execution: { isolation: "live" },
        threadId: thread.id,
        turnId: refused.context.turnId,
        harnesses: [provider.id],
        primaryHarness: provider.id,
        attempts: 3,
        access: "workspace_write",
        web: "off",
        models: { [provider.id]: "fixture-model" },
        efforts: { [provider.id]: "high" },
      });
      expect(providerSpecs).toEqual([
        expect.objectContaining({
          prompt,
          cwd: repo,
          access: "workspace_write",
          external_context_policy: "off",
          model_hint: "fixture-model",
          effort_hint: "high",
          attachments: [attachment],
        }),
      ]);
      expect(threads.turnsFor(thread.id)).toHaveLength(1);
      expect(threads.getTurn(refused.context.turnId)).toMatchObject({
        run_id: "run-retried",
        enqueue_error: null,
        attachments: [attachment],
      });
    } finally {
      await control.stop();
      await daemon.stop();
      journal.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
