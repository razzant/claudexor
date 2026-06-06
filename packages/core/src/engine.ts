import { join } from "node:path";
import type {
  AccessProfile,
  HarnessEvent,
  ModeKind,
  RunEvent,
  RunStatus,
  WorkProduct as WorkProductType,
} from "@claudex/schema";
import { HarnessRunSpec, TaskContract, WorkProduct } from "@claudex/schema";
import { ArtifactStore } from "@claudex/artifact-store";
import { EventLog } from "@claudex/event-log";
import { hashJson, newId, nowIso, redactSecrets, safeInvoke } from "@claudex/util";
import type { AdapterRegistry } from "./adapter.js";
import { HarnessUnavailableError } from "./errors.js";

export interface RunInput {
  repoRoot: string;
  prompt: string;
  harnessId?: string;
  mode?: ModeKind;
  baseRef?: string;
  /** Access profile for the harness (default workspace_write). `full` lets a harness
   *  act autonomously on the whole environment (needed e.g. for terminal tasks). */
  access?: AccessProfile;
  /** Optional model hint forwarded to the harness. */
  model?: string;
  /** Pre-assigned ids so a caller (daemon/control-api) knows them before the run starts. */
  runId?: string;
  taskId?: string;
  /** In-process sink for every RunEvent (mirrors events.jsonl) for live observers. */
  onEvent?: (event: RunEvent) => void;
  /** In-process sink for the full per-harness event stream (richer than RunEvent). */
  onHarnessEvent?: (event: HarnessEvent) => void;
  /** Called once when the run id/dir are known, before any harness work begins. */
  onRunStart?: (info: { runId: string; taskId: string; runDir: string }) => void;
  /** Cancellation: aborts the run and cancels in-flight harness work. */
  signal?: AbortSignal;
}

export interface RunResult {
  runId: string;
  taskId: string;
  status: RunStatus;
  harnessId: string;
  summary: string;
  runDir: string;
  workProductPath: string;
  costUsd: number;
  changedFiles: string[];
}

/**
 * Minimal v0 ExecutionEngine: one harness, one attempt. Later phases add the
 * full pipeline (context pack, gates, review, tournament, arbitration). Every
 * surface (CLI/daemon/MCP/ACP) calls this engine — no second scheduler.
 */
export class ExecutionEngine {
  constructor(private readonly adapters: AdapterRegistry) {}

  listHarnesses(): string[] {
    return [...this.adapters.keys()];
  }

  private pickHarness(harnessId?: string) {
    if (harnessId) {
      const adapter = this.adapters.get(harnessId);
      if (!adapter) throw new HarnessUnavailableError(`Harness not registered: ${harnessId}`);
      return adapter;
    }
    const first = [...this.adapters.values()][0];
    if (!first) throw new HarnessUnavailableError("No harness adapters are registered.");
    return first;
  }

  async run(input: RunInput): Promise<RunResult> {
    const taskId = input.taskId ?? newId("task");
    const runId = input.runId ?? newId("run");
    const mode: ModeKind = input.mode ?? "daily";

    const store = new ArtifactStore(input.repoRoot);
    const paths = store.createRun(runId);
    const log = new EventLog(paths.eventsPath, runId, taskId, input.onEvent);
    safeInvoke(input.onRunStart, { runId, taskId, runDir: paths.root });
    log.emit("run.created", { mode, prompt: redactSecrets(input.prompt) });

    const contract = TaskContract.parse({
      schema_version: 1,
      task_id: taskId,
      created_at: nowIso(),
      repo: { root: input.repoRoot, base_ref: input.baseRef ?? "HEAD" },
      mode: { kind: mode },
      user_intent: { raw: input.prompt },
    });
    store.writeYaml(join(paths.contextDir, "task.yaml"), contract);
    store.writeText(join(paths.contextDir, "TASK.md"), `# Task\n\n${input.prompt}\n`);
    const contractHash = hashJson(contract);
    store.writeText(join(paths.contextDir, "SPEC_HASH"), contractHash + "\n");
    log.emit("task.contract.created", { task_contract_hash: contractHash });

    const adapter = this.pickHarness(input.harnessId);
    const manifest = await adapter.discover();
    store.writeYaml(join(paths.harnessesDir, `${adapter.id}.manifest.yaml`), manifest);

    const sessionId = newId("ses");
    const spec = HarnessRunSpec.parse({
      session_id: sessionId,
      intent: "implement",
      prompt: input.prompt,
      cwd: input.repoRoot,
      access: input.access ?? "workspace_write",
      model_hint: input.model ?? null,
    });
    log.emit("harness.started", { harness_id: adapter.id, session_id: sessionId });

    const messages: string[] = [];
    const changedFiles: string[] = [];
    let costUsd = 0;
    let status: RunStatus = "success";
    let errorText = "";

    const onAbort = () => {
      void adapter.cancel?.(sessionId)?.catch(() => {});
    };
    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      for await (const ev of adapter.run(spec)) {
        if (input.signal?.aborted) {
          status = "cancelled";
          break;
        }
        log.emit("harness.event", { harness_id: adapter.id, event_type: ev.type });
        safeInvoke(input.onHarnessEvent, ev);
        if (ev.type === "message" && ev.text) messages.push(ev.text);
        if (ev.type === "file_change") {
          const p = ev.payload?.["path"];
          if (p) changedFiles.push(String(p));
        }
        if (ev.type === "usage" && ev.usage?.cost_usd) costUsd += ev.usage.cost_usd;
        if (ev.type === "error") {
          status = "failed";
          errorText = ev.error ?? "unknown harness error";
        }
      }
    } catch (err) {
      if (input.signal?.aborted) {
        status = "cancelled";
      } else {
        status = "failed";
        errorText = err instanceof Error ? err.message : String(err);
      }
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }

    log.emit("harness.completed", { harness_id: adapter.id, status, cost_usd: costUsd });

    const attemptDir = join(paths.attemptsDir, "a01");
    const summary = messages.join("\n").trim() || (status === "failed" ? errorText : "(no output)");
    store.writeYaml(join(attemptDir, "attempt.yaml"), {
      attempt_id: "a01",
      harness_id: adapter.id,
      session_id: sessionId,
      status,
      cost_usd: costUsd,
      changed_files: changedFiles,
      error: errorText || undefined,
    });

    const workProduct: WorkProductType = WorkProduct.parse({
      id: newId("wp"),
      kind: "patch",
      source_task_id: taskId,
      producer_attempt_id: "a01",
      meta: { changed_files: changedFiles, harness_id: adapter.id, status },
    });
    const workProductPath = join(paths.finalDir, "work_product.yaml");
    store.writeYaml(workProductPath, workProduct);
    store.writeText(
      join(paths.finalDir, "summary.md"),
      `# Run ${runId}\n\n- Harness: ${adapter.id}\n- Status: ${status}\n- Cost: $${costUsd.toFixed(4)}\n\n## Output\n\n${redactSecrets(summary)}\n`,
    );
    log.emit("work_product.emitted", { kind: "patch", work_product_id: workProduct.id });
    log.emit(status === "success" ? "run.completed" : "run.failed", { status });

    return {
      runId,
      taskId,
      status,
      harnessId: adapter.id,
      summary,
      runDir: paths.root,
      workProductPath,
      costUsd,
      changedFiles,
    };
  }
}
