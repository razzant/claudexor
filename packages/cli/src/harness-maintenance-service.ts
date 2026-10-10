/**
 * The engine-owned harness maintenance OPERATION. One accepted request is one
 * durable command on the daemon's existing queue/cancel/idempotency authority
 * (the model-operation precedent: no second scheduler or job ledger). Execution
 * runs the CLI primitive (`harness inspect|update`, harness-maintenance.ts) as
 * a child through core spawnProcess, so the blocking installer never runs on
 * the daemon event loop, Cancel reaches the whole process group, and an
 * unconfirmed tree death stays a typed fact instead of a clean cancel.
 *
 * Evidence (before/target/after/mutation) lives in the command record. The
 * proved `before` and the exact resolved target are written durably BEFORE
 * the first mutation; a restart leaves the command interrupted with that
 * evidence and never replays the install. A small in-memory index answers
 * per-harness reads without scanning history on every poll.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProcess } from "@claudexor/core";
import {
  commandStoreForId,
  commandStoreForRequest,
  commandStores,
  type LegacyCommandAuthority,
  type DaemonClient,
  type JobRecord,
  type RunContext,
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
import { INSTALLABLE_HARNESSES } from "./harness-command-specs.js";
import {
  harnessMaintenanceRecipe,
  isInstallableHarness,
  NPM_PINS,
} from "./harness-install-recipes.js";
import type { HarnessInspection } from "./harness-maintenance.js";

export const HARNESS_MAINTENANCE_OPERATION_ID = "harness.maintenance.create";
const CLIENT_ID = "control-api";
const Inspection = HarnessMaintenanceEntry.omit({ previous: true, operation: true });
type Evidence = HarnessMaintenanceEvidence;

/** The CLI entry beside this module: the packaged bundle, else the dist CLI. */
export function claudexorCliEntry(moduleUrl = import.meta.url, exists = existsSync): string {
  const directory = dirname(fileURLToPath(moduleUrl));
  const bundled = resolve(directory, "claudexor.bundle.cjs");
  return exists(bundled) ? bundled : resolve(directory, "cli.js");
}

export interface HarnessMaintenanceDependencies {
  commands: LegacyCommandAuthority;
  client: Pick<DaemonClient, "enqueue" | "cancel">;
  readiness?: () => Pick<AuthReadinessService, "invalidate">;
  /** Test seams; production runs `<node> <cli entry>` through spawnProcess. */
  cli?: { command: string; args: string[] };
  spawn?: typeof spawnProcess;
  cancelKillDelayMs?: number;
  now?: () => Date;
}

function problem(code: string, message: string, retryable = false): ControlProblem {
  return ControlProblem.parse({ code, message: redactSecrets(message), retryable });
}

function failure(code: string, message: string, status: number, context = {}): Error {
  return Object.assign(new Error(message), { code, status, retryable: false, context });
}

export function createHarnessMaintenance(deps: HarnessMaintenanceDependencies) {
  const now = () => (deps.now ?? (() => new Date()))();
  const cli = deps.cli ?? { command: process.execPath, args: [claudexorCliEntry()] };
  const spawn = deps.spawn ?? spawnProcess;
  const inventory = new Map<string, HarnessInspection>();
  const inventoryGenerations = new Map<string, number>();
  const latestSeen = new Map<string, Pick<HarnessInspection, "available" | "availableProblem">>();
  const creating = new Set<string>();
  let index: Map<string, string[]> | null = null;

  const byHarness = (): Map<string, string[]> => {
    if (index) return index;
    index = new Map();
    const records = commandStores(deps.commands)
      .flatMap((store) => store.records())
      .filter((record) => isHarnessMaintenanceOperation(record.params))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    for (const record of records)
      remember(record.id, (record.params as { harness: string }).harness);
    return index;
  };
  const remember = (id: string, harness: string): void => {
    const ids = index!.get(harness) ?? [];
    if (!ids.includes(id)) index!.set(harness, [...ids, id]);
  };
  /** Newest first; ids pruned by ordinary retention drop out of the index. */
  const operationsOf = (harness: string): JobRecord[] => {
    const ids = byHarness().get(harness) ?? [];
    const live = ids.flatMap((id) => commandStoreForId(deps.commands, id)?.get(id) ?? []);
    if (live.length !== ids.length)
      byHarness().set(
        harness,
        live.map((record) => record.id),
      );
    return live.reverse();
  };
  const evidenceOf = (record: JobRecord): Evidence | null => {
    const { lifecycle: _lifecycle, ...result } = (record.result ?? {}) as Record<string, unknown>;
    const parsed = HarnessMaintenanceEvidence.safeParse(result);
    return parsed.success ? parsed.data : null;
  };
  /** A proved earlier version from retained evidence, only where a mutation
   * could have replaced it. Unknown or pruned stays unknown. */
  const previousOf = (harness: string): { version: string; operationId: string } | null => {
    for (const record of operationsOf(harness)) {
      const evidence = evidenceOf(record);
      if (evidence?.before?.proved && evidence.before.version && evidence.mutation !== "none")
        return { version: evidence.before.version, operationId: record.id };
    }
    return null;
  };

  async function runChild(args: string[], signal?: AbortSignal) {
    let stdout = "";
    const progress: string[] = [];
    let unconfirmed = false;
    for await (const event of spawn(cli.command, [...cli.args, ...args, "--json"], {
      ...(signal ? { abortSignal: signal } : {}),
      cancelSignal: "SIGTERM",
      cancelKillDelayMs: deps.cancelKillDelayMs ?? 10_000,
    })) {
      if (event.type === "stdout") stdout += `${event.line}\n`;
      else if (event.type === "stderr") {
        progress.push(redactSecrets(event.line).slice(0, 400));
        if (progress.length > 40) progress.shift();
      } else if (event.type === "termination_unconfirmed") unconfirmed = true;
    }
    let json: unknown = null;
    try {
      json = JSON.parse(stdout.trim());
    } catch {
      json = null;
    }
    return { json, progress, unconfirmed };
  }

  async function inspect(
    ids: string[],
    latest: boolean,
    fresh: boolean,
    signal?: AbortSignal,
  ): Promise<HarnessInspection[]> {
    let stale = fresh || latest ? ids : ids.filter((id) => !inventory.has(id));
    while (stale.length) {
      // A multi-harness child returns all rows, including ones not requested.
      const generations = new Map(inventoryGenerations);
      const one = stale.length === 1 ? [stale[0]!] : [];
      const out = await runChild(
        ["harness", "inspect", ...one, ...(latest ? ["--latest"] : [])],
        signal,
      );
      if (out.unconfirmed || signal?.aborted)
        throw Object.assign(
          failure("maintenance_cancelled", "Maintenance preparation was cancelled", 409),
          {
            termination: out.unconfirmed ? "unconfirmed" : "confirmed",
          },
        );
      const rows = (out.json as { harnesses?: unknown } | null)?.harnesses;
      const parsed = Array.isArray(rows) ? rows.map((row) => Inspection.safeParse(row)) : [];
      if (!parsed.length || parsed.some((row) => !row.success))
        throw failure(
          "maintenance_inspection_failed",
          `harness inspection did not return its typed answer: ${out.progress.slice(-3).join(" | ")}`,
          502,
        );
      for (const row of parsed) {
        const value = row.data! as HarnessInspection;
        if (generations.get(value.harness) !== inventoryGenerations.get(value.harness)) continue;
        if (latest) latestSeen.set(value.harness, value);
        inventory.set(value.harness, value);
      }
      // A newer read may already own the invalidated row. Otherwise acquire it
      // now, so this caller also gets current facts instead of an empty answer.
      stale = ids.filter(
        (id) => generations.get(id) !== inventoryGenerations.get(id) && !inventory.has(id),
      );
    }
    return ids.flatMap((id) => inventory.get(id) ?? []);
  }

  function detail(id: string): ControlHarnessMaintenanceOperation {
    const record = commandStoreForId(deps.commands, id)?.get(id);
    const params = HarnessMaintenanceParams.safeParse(record?.params);
    if (!record || !params.success)
      throw failure("maintenance_operation_not_found", "No such maintenance operation", 404);
    const evidence: Evidence = evidenceOf(record) ?? {
      phase: "accepted",
      mechanism: null,
      target: params.data.target,
      before: null,
      after: null,
      mutation: "none",
      termination: "not_applicable",
      limitations: [],
      progress: [],
      problem: null,
    };
    if (isTerminalLifecycle(record.state) && !evidence.problem && record.state !== "succeeded")
      evidence.problem = problem(
        record.errorCode ?? `maintenance_${record.state}`,
        record.error ?? `maintenance ended ${record.state}`,
      );
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

  function save(id: string, evidence: Evidence): void {
    commandStoreForId(deps.commands, id)?.update(id, { result: evidence });
  }

  /** After any step that may have changed bytes: drop this harness's cached
   * observations so the next read re-proves them (no account fanout). */
  function invalidate(harness: string): void {
    inventoryGenerations.set(harness, (inventoryGenerations.get(harness) ?? 0) + 1);
    inventory.delete(harness);
    accountObservations.invalidateHarness(harness);
    deps.readiness?.().invalidate(harness);
    // Keyed by binary path, which an in-place install keeps. (Claude's model
    // probe cache is package-private; its documented TTL/fresh bypass remain.)
    clearCodexEffortCache();
  }

  async function execute(raw: unknown, ctx: RunContext) {
    const params = HarnessMaintenanceParams.parse(raw);
    const { harness } = params;
    const evidence: Evidence = {
      phase: "preparing",
      mechanism: null,
      target: { ...params.target },
      before: null,
      after: null,
      mutation: "none",
      termination: "not_applicable",
      limitations: [],
      progress: [],
      problem: null,
    };
    let lifecycle: "succeeded" | "failed" | "cancelled" = "failed";
    let spawned = false;
    try {
      save(ctx.jobId, evidence);
      const npm = harnessMaintenanceRecipe(harness as never).mechanism === "managed_npm";
      const [row] = await inspect(
        [harness],
        npm && params.target.kind === "latest",
        true,
        ctx.signal,
      );
      ctx.signal.throwIfAborted();
      if (!row) throw failure("maintenance_inspection_failed", `no inspection for ${harness}`, 502);
      evidence.mechanism = row.mechanism;
      const managed = row.mechanism === "managed_npm";
      evidence.before = {
        version: managed ? row.installed.version : row.selection.version,
        binary: managed ? row.installed.binary : row.selection.binary,
        selection: row.selection.kind,
        proved: managed ? row.installed.proved : row.selection.version !== null,
      };
      if (!row.maintainable || !row.targets.includes(params.target.kind))
        throw failure("harness_not_maintainable", row.remedy ?? "target is not supported", 409);
      const version =
        managed && params.target.kind === "latest" ? row.available?.version : params.target.version;
      if (managed && !version)
        throw failure(
          "latest_unavailable",
          row.availableProblem?.message ?? "no latest version",
          502,
        );
      // Durable BEFORE the first mutation: proved before, exact target, effect unknown.
      evidence.target = { kind: params.target.kind, version: version ?? null };
      evidence.phase = "installing";
      evidence.mutation = "unknown";
      evidence.limitations = ["in_place_replacement", "new_starts_may_fail"];
      save(ctx.jobId, evidence);
      spawned = true;
      const out = await runChild(
        ["harness", "update", harness, ...(version ? ["--vendor-version", version] : []), "--yes"],
        ctx.signal,
      );
      const receipt = (out.json ?? {}) as Partial<{
        ok: boolean;
        code: string;
        refusal: string;
        after: Evidence["after"];
        mutation: Evidence["mutation"];
        limitations: string[];
      }>;
      evidence.progress = out.progress.slice(-20);
      evidence.termination = out.unconfirmed
        ? "unconfirmed"
        : ctx.signal.aborted
          ? "confirmed"
          : "not_applicable";
      if (receipt.after !== undefined) evidence.after = receipt.after;
      if (receipt.mutation) evidence.mutation = receipt.mutation;
      if (receipt.limitations) evidence.limitations = receipt.limitations;
      if (ctx.signal.aborted) {
        lifecycle = "cancelled";
        evidence.problem = problem(
          "maintenance_cancelled",
          evidence.mutation === "none"
            ? "cancelled; nothing was changed"
            : "cancelled after the installer started; the installation may be partially replaced",
        );
      } else if (receipt.ok === true) lifecycle = "succeeded";
      else {
        if (!receipt.mutation) evidence.mutation = "unknown";
        evidence.problem = problem(
          receipt.code ?? "maintenance_failed",
          receipt.refusal ??
            (out.progress.slice(-3).join(" | ") || "the update child returned no receipt"),
        );
      }
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const termination = (error as { termination?: unknown }).termination;
      if (termination === "unconfirmed" || termination === "confirmed")
        evidence.termination = termination;
      lifecycle = ctx.signal.aborted ? "cancelled" : "failed";
      evidence.problem = problem(
        typeof code === "string" ? code : "maintenance_failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      evidence.phase = "settled";
      // Any started step may have touched bytes (a vendor "no change" too).
      if (spawned) invalidate(harness);
    }
    return { lifecycle, ...evidence };
  }

  const routes = {
    maintenanceInventory: async (
      input: {
        harnessIds?: string[];
        fresh?: boolean;
        checkLatest?: boolean;
      } = {},
    ) => {
      const ids = input.harnessIds?.length ? input.harnessIds : [...INSTALLABLE_HARNESSES];
      const unknown = ids.filter((id) => !isInstallableHarness(id));
      if (unknown.length)
        throw failure("harness_not_installable", `unknown harness: ${unknown.join(", ")}`, 400);
      const rows = await inspect(ids, input.checkLatest === true, input.fresh === true);
      return ControlHarnessMaintenanceInventory.parse({
        observedAt: now().toISOString(),
        harnesses: rows.map((row) => {
          const seen = latestSeen.get(row.harness);
          const [current] = operationsOf(row.harness);
          const evidence = current ? evidenceOf(current) : null;
          return {
            ...row,
            available: row.available ?? seen?.available ?? null,
            availableProblem: row.availableProblem ?? seen?.availableProblem ?? null,
            previous: row.targets.includes("previous") ? previousOf(row.harness) : null,
            operation: current
              ? {
                  id: current.id,
                  state: current.state,
                  phase: evidence?.phase ?? "accepted",
                  targetVersion: evidence?.target.version ?? null,
                  finishedAt: current.finishedAt ?? null,
                }
              : null,
          };
        }),
      });
    },
    createMaintenanceOperation: async (body: unknown, idempotencyKey: string) => {
      const request = ControlHarnessMaintenanceCreateRequest.parse(body);
      const { harness, target } = request;
      if (!isInstallableHarness(harness))
        throw failure("harness_not_installable", `unknown harness: ${harness}`, 400);
      const routing = {
        kind: "harness_maintenance",
        harness,
        target: { kind: target.kind, version: null },
      };
      const envelope = {
        idempotencyKey,
        clientId: CLIENT_ID,
        operation: HARNESS_MAINTENANCE_OPERATION_ID,
      };
      const replay = commandStoreForRequest(deps.commands, routing).find({
        ...envelope,
        params: routing,
        idempotencyParams: request,
      });
      if (replay) return detail(replay.id);
      const recipe = harnessMaintenanceRecipe(harness);
      const cached = inventory.get(harness);
      if (!recipe.targets.includes(target.kind) || (cached && !cached.maintainable))
        throw failure(
          "harness_not_maintainable",
          cached?.remedy ?? `${harness} cannot install target ${target.kind}`,
          409,
          {
            selection: cached?.selection ?? null,
          },
        );
      const active = operationsOf(harness).find((record) => !isTerminalLifecycle(record.state));
      if (active || creating.has(harness))
        throw failure(
          "maintenance_already_active",
          `${harness} already has a maintenance operation`,
          409,
          {
            operationId: active?.id ?? null,
          },
        );
      const version =
        target.kind === "version"
          ? target.version
          : target.kind === "baseline"
            ? (NPM_PINS[harness]?.version ?? null)
            : target.kind === "previous"
              ? (previousOf(harness)?.version ?? null)
              : null;
      if (target.kind !== "latest" && !version)
        throw failure(
          "maintenance_target_unknown",
          `no proved ${target.kind} version is known for ${harness}`,
          409,
        );
      creating.add(harness);
      try {
        const params = HarnessMaintenanceParams.parse({
          ...routing,
          target: { kind: target.kind, version },
        });
        const { id } = await deps.client.enqueue(params, {
          ...envelope,
          idempotencyRequest: request,
        });
        byHarness();
        remember(id, harness);
        return detail(id);
      } finally {
        creating.delete(harness);
      }
    },
    getMaintenanceOperation: async (id: string) => detail(id),
    cancelMaintenanceOperation: async (id: string) => {
      const current = detail(id);
      if (!isTerminalLifecycle(current.state)) await deps.client.cancel(id, "user_cancelled");
      return detail(id);
    },
  };

  /** Readiness projection: an active operation is disclosed on its harness row
   * (existing fields) so a failed native start reads as maintenance, not auth. */
  function decorateHarnessList<A extends unknown[]>(list: (...args: A) => Promise<unknown>) {
    return async (...args: A) => {
      const value = (await list(...args)) as { harnesses?: Array<Record<string, unknown>> };
      if (!value?.harnesses) return value;
      return {
        ...value,
        harnesses: value.harnesses.map((row) => {
          const [current] = operationsOf(String(row.id));
          if (!current || isTerminalLifecycle(current.state)) return row;
          const target = evidenceOf(current)?.target.version;
          const detailText = `Claudexor is maintaining ${String(row.id)}${target ? ` (installing ${target})` : ""}; new native starts may fail until operation ${current.id} finishes`;
          return {
            ...row,
            reasons: [...((row.reasons as string[] | undefined) ?? []), detailText],
            readiness: [
              ...((row.readiness as unknown[] | undefined) ?? []),
              {
                id: "maintenance",
                kind: "binary",
                title: "Maintenance in progress",
                status: "skip",
                detail: detailText,
              },
            ],
          };
        }),
      };
    };
  }

  return {
    owns: (params: unknown) => isHarnessMaintenanceOperation(params),
    execute,
    routes,
    decorateHarnessList,
    /** Daemon composition: routes + readiness decoration on the control services. */
    bind(services: { harnesses?: (input?: never) => Promise<unknown> } & Record<string, unknown>) {
      Object.assign(services, routes);
      if (services.harnesses) services.harnesses = decorateHarnessList(services.harnesses);
    },
  };
}

/** The daemon's composition (claudexord.ts); readiness is bound lazily. */
export function daemonHarnessMaintenance(
  commands: LegacyCommandAuthority,
  client: Pick<DaemonClient, "enqueue" | "cancel">,
  readiness: () => Pick<AuthReadinessService, "invalidate">,
) {
  return createHarnessMaintenance({ commands, client, readiness });
}
