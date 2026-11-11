import { programUpdateAvailable } from "@claudexor/core";
/** Vendor work stays in a custodied CLI child. The existing command store owns
 * idempotency, cancellation, retention and rejoin; there is no update scheduler. */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProcess, type ChildStdin } from "@claudexor/core";
import {
  commandStoreForId,
  commandStoreForRequest,
  type CommandAuthority,
  type MaintenanceCommandSummary,
  type DaemonClient,
  type RunContext,
  type RunEventBus,
} from "@claudexor/daemon";
import type { AuthReadinessService } from "@claudexor/gateway";
import { clearCodexEffortCache } from "@claudexor/harness-codex";
import {
  ControlHarnessMaintenanceCreateRequest,
  ControlHarnessMaintenanceInventory,
  ControlHarnessMaintenanceOperation,
  ControlProblem,
  HarnessMaintenanceEntry,
  HarnessMaintenanceEvidence,
  HarnessMaintenanceParams,
  isHarnessMaintenanceOperation,
  isTerminalLifecycle,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { accountObservations } from "./account-observations.js";
import { emptyMaintenanceEvidence, type HarnessInspection } from "./harness-maintenance.js";
import { harnessProgram, harnessPrograms } from "./harness-programs.js";
import { MAINTENANCE_EVIDENCE_PREFIX } from "./harness-installer.js";
import { trackHarnessRuns } from "./harness-maintenance-runs.js";

export const HARNESS_MAINTENANCE_OPERATION_ID = "harness.maintenance.create";
const CLIENT_ID = "control-api";
const Inspection = HarnessMaintenanceEntry.omit({ operation: true });
type Evidence = HarnessMaintenanceEvidence;
export function claudexorCliEntry(moduleUrl = import.meta.url, exists = existsSync): string {
  const directory = dirname(fileURLToPath(moduleUrl));
  const bundled = resolve(directory, "claudexor.bundle.cjs");
  return exists(bundled) ? bundled : resolve(directory, "cli.js");
}
export interface HarnessMaintenanceDependencies {
  commands: CommandAuthority;
  maintenanceQueries: { maintenanceForHarness(harness: string): MaintenanceCommandSummary[] };
  client: Pick<DaemonClient, "enqueue" | "cancel">;
  readiness?: () => Pick<AuthReadinessService, "invalidate">;
  bus?: RunEventBus;
  cli?: { command: string; args: string[] };
  spawn?: typeof spawnProcess;
  cancelKillDelayMs?: number;
  now?: () => Date;
}
const problem = (code: string, message: string) =>
  ControlProblem.parse({ code, message: redactSecrets(message), retryable: true });
const failure = (code: string, message: string, status = 409, context = {}) =>
  Object.assign(new Error(message), { code, status, retryable: false, context });

export function createHarnessMaintenance(deps: HarnessMaintenanceDependencies) {
  const now = () => (deps.now ?? (() => new Date()))();
  const cli = deps.cli ?? { command: process.execPath, args: [claudexorCliEntry()] };
  const spawn = deps.spawn ?? spawnProcess;
  const latestSeen = new Map<string, HarnessInspection["newest"]>();
  const generations = new Map<string, number>();
  const creating = new Set<string>();
  const accepting = new Map<
    string,
    { body: string; result: Promise<ControlHarnessMaintenanceOperation> }
  >();
  const activeRuns = deps.bus ? trackHarnessRuns(deps.bus) : null;
  const operationsOf = (id: string) => deps.maintenanceQueries.maintenanceForHarness(id);
  const save = (id: string, evidence: Evidence) => {
    const store = commandStoreForId(deps.commands, id);
    if (!store) throw new Error("Maintenance command record disappeared before mutation");
    store.update(id, { result: evidence });
  };

  async function runChild(
    args: string[],
    signal?: AbortSignal,
    prepared?: (evidence: Evidence) => void,
  ) {
    let stdout = "";
    const progress: string[] = [];
    let unconfirmed = false;
    let input: ChildStdin | undefined;
    for await (const event of spawn(cli.command, [...cli.args, ...args, "--json"], {
      abortSignal: signal,
      cancelSignal: "SIGTERM",
      cancelKillDelayMs: deps.cancelKillDelayMs ?? 10_000,
      ...(prepared
        ? {
            env: { CLAUDEXOR_MAINTENANCE_PROTOCOL: "1" },
            keepStdinOpen: true,
            onSpawn: (io: ChildStdin) => {
              input = io;
            },
          }
        : {}),
    })) {
      if (event.type === "stdout") {
        if (stdout.length + event.line.length > 1024 * 1024)
          throw failure("maintenance_receipt_too_large", "Maintenance receipt exceeded 1 MiB", 502);
        stdout += `${event.line}\n`;
      } else if (event.type === "stderr") {
        if (prepared && event.line.startsWith(MAINTENANCE_EVIDENCE_PREFIX)) {
          const evidence = HarnessMaintenanceEvidence.parse(
            JSON.parse(event.line.slice(MAINTENANCE_EVIDENCE_PREFIX.length)),
          );
          signal?.throwIfAborted();
          prepared(evidence); // synchronous store commit before the child may mutate
          input?.write("ack\n");
        } else {
          progress.push(redactSecrets(event.line).slice(0, 400));
          if (progress.length > 40) progress.shift();
        }
      } else if (event.type === "termination_unconfirmed") unconfirmed = true;
    }
    let json: unknown = null;
    try {
      json = JSON.parse(stdout.trim());
    } catch {
      /* interrupted or malformed receipt */
    }
    return { json, progress, unconfirmed };
  }

  // Read the program again on every requested inventory read. An external
  // updater or unchanged wrapper is as authoritative as this operation.
  async function inspect(
    ids: string[],
    latest: boolean,
    signal?: AbortSignal,
  ): Promise<HarnessInspection[]> {
    const result: HarnessInspection[] = [];
    for (const id of ids) {
      const generation = (generations.get(id) ?? 0) + 1;
      generations.set(id, generation);
      const out = await runChild(
        ["harness", "inspect", id, ...(latest ? ["--latest"] : [])],
        signal,
      );
      signal?.throwIfAborted();
      if (out.unconfirmed)
        throw failure(
          "maintenance_inspection_failed",
          "Inspection child termination could not be confirmed",
          502,
        );
      const raw = (out.json as { harnesses?: unknown[] } | null)?.harnesses?.[0];
      const parsed = Inspection.safeParse(raw);
      if (!parsed.success || parsed.data.harness !== id)
        throw failure(
          "maintenance_inspection_failed",
          `No typed inspection for ${id}: ${out.progress.slice(-3).join(" | ")}`,
          502,
        );
      if (generations.get(id) !== generation) {
        result.push(...(await inspect([id], latest, signal)));
        continue;
      }
      if (parsed.data.newest.status !== "not_read") latestSeen.set(id, parsed.data.newest);
      else if (latestSeen.has(id)) parsed.data.newest = latestSeen.get(id)!;
      parsed.data.updateAvailable = programUpdateAvailable(
        harnessProgram(id).versionScheme,
        parsed.data.selection.version,
        parsed.data.newest.status === "available" ? parsed.data.newest.version : null,
      );
      result.push(parsed.data);
    }
    return result;
  }

  function detail(id: string): ControlHarnessMaintenanceOperation {
    const record = commandStoreForId(deps.commands, id)?.get(id);
    const params = HarnessMaintenanceParams.safeParse(record?.params);
    if (!record || !params.success)
      throw failure(
        "maintenance_operation_not_found",
        "No current-format maintenance operation at this id",
        404,
      );
    const { lifecycle: _lifecycle, ...result } = (record.result ?? {}) as Record<string, unknown>;
    const parsed = HarnessMaintenanceEvidence.safeParse(result);
    const evidence = parsed.success
      ? parsed.data
      : emptyMaintenanceEvidence(params.data.target, params.data.requester);
    if (isTerminalLifecycle(record.state) && record.state !== "succeeded" && !evidence.problem) {
      evidence.problem = problem(
        record.errorCode ?? `maintenance_${record.state}`,
        record.error ?? `Maintenance ended ${record.state}`,
      );
      if (evidence.phase === "installing") {
        evidence.outcome = "unknown";
        evidence.mutation = "unknown";
      }
    }
    return ControlHarnessMaintenanceOperation.parse({
      ...evidence,
      id,
      harness: params.data.harness,
      state: record.state,
      createdAt: record.createdAt,
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
    });
  }
  function invalidate(harness: string) {
    generations.set(harness, (generations.get(harness) ?? 0) + 1);
    accountObservations.invalidateHarness(harness);
    deps.readiness?.().invalidate(harness);
    clearCodexEffortCache();
  }
  async function execute(raw: unknown, ctx: RunContext) {
    const params = HarnessMaintenanceParams.parse(raw);
    let evidence = emptyMaintenanceEvidence(params.target, params.requester);
    evidence.phase = "preparing";
    evidence.activeRunsAtStart = activeRuns?.count(params.harness) ?? null;
    let lifecycle: "succeeded" | "failed" | "cancelled" = "failed";
    let spawned = false;
    try {
      save(ctx.jobId, evidence);
      ctx.signal.throwIfAborted();
      spawned = true;
      const out = await runChild(
        [
          "harness",
          "update",
          params.harness,
          ...(params.target.version ? ["--vendor-version", params.target.version] : []),
          "--yes",
        ],
        ctx.signal,
        (prepared) => {
          evidence = {
            ...prepared,
            requester: params.requester,
            activeRunsAtStart: evidence.activeRunsAtStart,
          };
          save(ctx.jobId, evidence);
        },
      );
      const {
        ok,
        harness: _harness,
        dryRun: _dryRun,
        ...body
      } = (out.json ?? {}) as Record<string, unknown>;
      const receipt = HarnessMaintenanceEvidence.safeParse(body);
      if (receipt.success)
        evidence = {
          ...receipt.data,
          requester: params.requester,
          activeRunsAtStart: evidence.activeRunsAtStart,
        };
      else {
        evidence.progress = out.progress;
        if ((evidence as Evidence).phase === "installing") {
          evidence.mutation = "unknown";
          evidence.outcome = "unknown";
        }
      }
      evidence.termination = out.unconfirmed
        ? "unconfirmed"
        : ctx.signal.aborted
          ? "confirmed"
          : "not_applicable";
      if (ctx.signal.aborted) {
        lifecycle = "cancelled";
        // Re-observe after confirmed tree death. The cancelled child might have
        // committed its update before it could return a receipt.
        if (!out.unconfirmed && !receipt.success && evidence.phase === "installing") {
          try {
            const [row] = await inspect([params.harness], false);
            evidence.after = row!.selection;
            if (
              evidence.before &&
              (evidence.before.path !== row!.selection.path ||
                evidence.before.realPath !== row!.selection.realPath ||
                evidence.before.version !== row!.selection.version)
            ) {
              evidence.mutation = "applied";
              evidence.outcome = "changed";
            }
          } catch {
            /* Unknown effects remain explicit. */
          }
        }
        evidence.problem = problem(
          "maintenance_cancelled",
          evidence.mutation === "none"
            ? "Cancelled before mutation."
            : "Cancelled after the vendor command started; inspect the recorded before/after evidence.",
        );
      } else if (receipt.success && ok === true) lifecycle = "succeeded";
      else
        evidence.problem ??= problem(
          "maintenance_failed",
          out.progress.at(-1) ?? "The vendor operation returned no complete receipt.",
        );
    } catch (error) {
      lifecycle = ctx.signal.aborted ? "cancelled" : "failed";
      evidence.problem = problem(
        (error as { code?: string }).code ?? "maintenance_failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      evidence.phase = "settled";
      if (spawned) invalidate(params.harness);
    }
    return { lifecycle, ...evidence };
  }

  const routes = {
    maintenanceInventory: async (
      input: { harnessIds?: string[]; fresh?: boolean; checkLatest?: boolean } = {},
    ) => {
      const ids = input.harnessIds?.length
        ? input.harnessIds
        : harnessPrograms().map((program) => program.id);
      ids.forEach(harnessProgram);
      const rows = await inspect(ids, input.checkLatest === true);
      return ControlHarnessMaintenanceInventory.parse({
        observedAt: now().toISOString(),
        harnesses: rows.map((row) => {
          const [operation] = operationsOf(row.harness);
          let recorded: ControlHarnessMaintenanceOperation | null = null;
          if (operation) {
            try {
              recorded = detail(operation.id);
            } catch {
              /* Legacy receipts keep their addressed command record. */
            }
          }
          return { ...row, operation: recorded };
        }),
      });
    },
    createMaintenanceOperation: async (body: unknown, idempotencyKey: string) => {
      const request = ControlHarnessMaintenanceCreateRequest.parse(body);
      const canonical = JSON.stringify(request);
      const pending = accepting.get(idempotencyKey);
      if (pending) {
        if (pending.body !== canonical)
          throw failure(
            "idempotency_conflict",
            "This idempotency key is already accepting a different request.",
          );
        return pending.result;
      }
      harnessProgram(request.harness);
      const params = HarnessMaintenanceParams.parse({
        kind: "harness_maintenance",
        harness: request.harness,
        target: {
          kind: request.target.kind,
          version: request.target.kind === "version" ? request.target.version : null,
        },
        requester: { source: CLIENT_ID, requestId: idempotencyKey },
      });
      const envelope = {
        idempotencyKey,
        clientId: CLIENT_ID,
        operation: HARNESS_MAINTENANCE_OPERATION_ID,
      };
      const replay = commandStoreForRequest(deps.commands, params).find({
        ...envelope,
        params,
        idempotencyParams: request,
      });
      if (replay) return detail(replay.id);
      const active = operationsOf(request.harness).find(
        (record) => !isTerminalLifecycle(record.state),
      );
      if (active || creating.has(request.harness))
        throw failure(
          "maintenance_already_active",
          `${request.harness} already has a maintenance operation`,
          409,
          { operationId: active?.id ?? null },
        );
      creating.add(request.harness);
      const accepted = (async () => {
        const { id } = await deps.client.enqueue(params, {
          ...envelope,
          idempotencyRequest: request,
        });
        return detail(id);
      })();
      accepting.set(idempotencyKey, { body: canonical, result: accepted });
      try {
        return await accepted;
      } finally {
        accepting.delete(idempotencyKey);
        creating.delete(request.harness);
      }
    },
    getMaintenanceOperation: async (id: string) => detail(id),
    cancelMaintenanceOperation: async (id: string) => {
      if (!isTerminalLifecycle(detail(id).state)) await deps.client.cancel(id, "user_cancelled");
      return detail(id);
    },
  };
  function decorateHarnessList<A extends unknown[]>(list: (...args: A) => Promise<unknown>) {
    return async (...args: A) => {
      const value = (await list(...args)) as { harnesses?: Array<Record<string, unknown>> };
      if (!value?.harnesses) return value;
      return {
        ...value,
        harnesses: value.harnesses.map((row) => {
          const [current] = operationsOf(String(row.id));
          if (!current || isTerminalLifecycle(current.state)) return row;
          const text = `Claudexor is maintaining ${String(row.id)}; new native starts may fail until operation ${current.id} finishes`;
          return {
            ...row,
            reasons: [...((row.reasons as string[]) ?? []), text],
            readiness: [
              ...((row.readiness as unknown[]) ?? []),
              {
                id: "maintenance",
                kind: "binary",
                title: "Maintenance in progress",
                status: "skip",
                detail: text,
              },
            ],
          };
        }),
      };
    };
  }
  return {
    owns: isHarnessMaintenanceOperation,
    execute,
    routes,
    decorateHarnessList,
    bind(services: { harnesses?: (input?: never) => Promise<unknown> } & Record<string, unknown>) {
      Object.assign(services, routes);
      if (services.harnesses) services.harnesses = decorateHarnessList(services.harnesses);
    },
    close: () => activeRuns?.close(),
  };
}
