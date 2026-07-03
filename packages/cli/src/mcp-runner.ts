import { Orchestrator } from "@claudexor/orchestrator";
import { AccessProfile, EffortHint, ExternalContextPolicy } from "@claudexor/schema";
import { buildGateway, buildRegistry } from "./registry.js";
import { daemonOutcomeSummary, ensureDaemon, enqueueAndAwait } from "./daemon-run.js";
import { primaryOutputForCli } from "./primary-output.js";
import type { ControlApiAddress } from "./live.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SurfaceRunnerHooks {
  onEvent?: (event: any) => void;
  onInteraction?: (ctx: any) => Promise<any | null>;
  signal?: AbortSignal;
}

/**
 * The IN-PROCESS runner for read-only surface calls (ask/plan/audit and a
 * suggest-autonomy orchestrate — nothing to apply or unblock, per the CLI
 * doctrine in cli.ts). Also answers `__status` from the doctor-backed gateway.
 */
export function orchestratorRunner() {
  const registry = buildRegistry();
  const orch = new Orchestrator({ registry });
  return async (p: any, hooks?: SurfaceRunnerHooks) => {
    if (p?.mode === "__status") {
      // Doctor-backed truth (probe-cheap): fakes and unavailable harnesses are
      // never presented as available tools to an MCP host.
      const statuses = await buildGateway({ includeFakes: false }).statusAll({
        cwd: process.cwd(),
      });
      return {
        harnesses: statuses.map((s) => ({ id: s.id, status: s.status, intents: s.enabledIntents })),
        available: statuses.filter((s) => s.status === "ok").map((s) => s.id),
      };
    }
    const reviewerPanel = Array.isArray(p?.reviewerPanel) ? p.reviewerPanel : undefined;
    const reviewerModels =
      p?.reviewerModels && typeof p.reviewerModels === "object" ? p.reviewerModels : undefined;
    const reviewerEfforts =
      p?.reviewerEfforts && typeof p.reviewerEfforts === "object" ? p.reviewerEfforts : undefined;
    const runner =
      reviewerPanel || reviewerModels || reviewerEfforts
        ? new Orchestrator({
            registry,
            reviewerPanel,
            reviewerModels,
            reviewerEfforts,
          })
        : orch;
    return runner.run({
      repoRoot: typeof p?.repoPath === "string" && p.repoPath.trim() ? p.repoPath : process.cwd(),
      prompt: String(p?.prompt ?? ""),
      mode: p?.mode ?? "agent",
      harnesses: p?.harness ? [String(p.harness)] : undefined,
      primaryHarness: p?.primaryHarness ? String(p.primaryHarness) : undefined,
      web: p?.web ? ExternalContextPolicy.parse(String(p.web)) : undefined,
      externalContextPolicy: p?.externalContextPolicy
        ? ExternalContextPolicy.parse(String(p.externalContextPolicy))
        : undefined,
      model: p?.model ? String(p.model) : undefined,
      effort: p?.effort ? EffortHint.parse(String(p.effort)) : undefined,
      n: typeof p?.n === "number" ? p.n : p?.race === true ? 2 : undefined,
      untilClean: p?.untilClean === true,
      swarm: p?.swarm === true,
      create: p?.create === true,
      tests: Array.isArray(p?.tests) ? p.tests.map(String) : undefined,
      maxUsd: typeof p?.maxUsd === "number" ? p.maxUsd : undefined,
      access: p?.access ? AccessProfile.parse(String(p.access)) : undefined,
      protectedPathApprovals: Array.isArray(p?.protectedPathApprovals)
        ? p.protectedPathApprovals
        : undefined,
      onEvent: hooks?.onEvent,
      onInteraction: hooks?.onInteraction,
      signal: hooks?.signal,
    });
  };
}

/**
 * The MCP surface runner (D27): MUTATING verbs (mode=agent — run/race/create)
 * are DAEMON-TRACKED exactly like the CLI (`GET /runs` sees them, `claudexor
 * decision` can unblock them, cancel works), read-only verbs stay in-process
 * — the same doctrine split as cli.ts. Interactive questions on daemon runs
 * bridge through pendingInteractions polling + the typed answer endpoint,
 * driven by the caller's onInteraction hook (the MCP server maps that hook to
 * host elicitation).
 */
export function mcpSurfaceRunner() {
  const inProcess = orchestratorRunner();
  return async (p: any, hooks?: SurfaceRunnerHooks) => {
    if (p?.mode !== "agent") return inProcess(p, hooks);
    const { client, addr } = await ensureDaemon();
    const repoRoot = typeof p?.repoPath === "string" && p.repoPath.trim() ? p.repoPath : process.cwd();
    const body: Record<string, unknown> = {
      prompt: String(p?.prompt ?? ""),
      mode: "agent",
      scope: { kind: "project", root: repoRoot },
      execution: { isolation: "envelope" },
      ...(p?.harness ? { harnesses: [String(p.harness)] } : {}),
      ...(p?.primaryHarness ? { primaryHarness: String(p.primaryHarness) } : {}),
      ...(p?.race === true ? { n: typeof p?.n === "number" ? p.n : 2 } : typeof p?.n === "number" ? { n: p.n } : {}),
      ...(p?.create === true ? { create: true } : {}),
      ...(Array.isArray(p?.tests) ? { tests: p.tests.map(String) } : {}),
      ...(typeof p?.maxUsd === "number" ? { maxUsd: p.maxUsd } : {}),
      ...(p?.access ? { access: String(p.access) } : {}),
      // `externalContextPolicy` is the control-api-parity alias of `web`; the
      // validator already enforced equality when both are present. Honor the
      // alias alone too — dropping it would silently run the daemon default.
      ...(p?.web ? { web: String(p.web) } : p?.externalContextPolicy ? { web: String(p.externalContextPolicy) } : {}),
      ...(p?.model ? { model: String(p.model) } : {}),
      ...(p?.effort ? { effort: String(p.effort) } : {}),
      ...(Array.isArray(p?.reviewerPanel) ? { reviewerPanel: p.reviewerPanel } : {}),
      ...(p?.reviewerModels && typeof p.reviewerModels === "object" ? { reviewerModels: p.reviewerModels } : {}),
      ...(p?.reviewerEfforts && typeof p.reviewerEfforts === "object" ? { reviewerEfforts: p.reviewerEfforts } : {}),
      ...(Array.isArray(p?.protectedPathApprovals) ? { protectedPathApprovals: p.protectedPathApprovals } : {}),
    };
    const interactionBridge = hooks?.onInteraction ? makeInteractionBridge(addr, hooks.onInteraction) : undefined;
    const out = await enqueueAndAwait(client, addr, body, {
      waitForTerminal: true,
      ...(interactionBridge ? { onPollTick: interactionBridge } : {}),
    });
    // The MCP result: the run's primary output as the summary (the daemon
    // outcome reason for non-success terminals), plus the artifact handle.
    const primary = out.runDir ? primaryOutputForCli(out.runDir, "agent") : null;
    const reason = daemonOutcomeSummary(out);
    const summary =
      primary && primary.kind !== "patch"
        ? primary.text.trim()
        : (reason ?? (primary?.kind === "patch" ? "patch produced (see artifacts)" : `run ${out.status}`));
    return { runId: out.runId, runDir: out.runDir, status: out.status, summary };
  };
}

/**
 * Poll-tick bridge: watch the run's pendingInteractions on the control API and
 * forward each NEW interaction to the caller's hook exactly once; answers go
 * back through the typed answer endpoint. A stale answer (engine already
 * timed out and declined) is the endpoint's problem to refuse — the bridge
 * never fakes delivery.
 */
export function makeInteractionBridge(
  addr: ControlApiAddress,
  onInteraction: (ctx: any) => Promise<any | null>,
): (info: { runId: string }) => Promise<void> {
  const seen = new Set<string>();
  let lastCheck = 0;
  let handling = false;
  return async ({ runId }) => {
    if (handling || Date.now() - lastCheck < 1_000) return;
    lastCheck = Date.now();
    let pending: Array<{ interactionId?: string; questions?: unknown[]; timeoutAt?: string | null }> = [];
    try {
      const res = await fetch(`${addr.baseUrl}/runs/${encodeURIComponent(runId)}`, {
        headers: { Authorization: `Bearer ${addr.token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) return;
      const detail = (await res.json()) as { pendingInteractions?: typeof pending };
      pending = detail.pendingInteractions ?? [];
    } catch {
      return; // transient control-api hiccup: the next tick retries
    }
    for (const pi of pending) {
      const id = typeof pi.interactionId === "string" ? pi.interactionId : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      handling = true;
      try {
        const result = await onInteraction({
          request: { interaction_id: id, questions: Array.isArray(pi.questions) ? pi.questions : [] },
          timeoutAt: pi.timeoutAt ?? undefined,
        });
        const answers = result && Array.isArray(result.answers) ? result.answers : null;
        if (answers) {
          await fetch(`${addr.baseUrl}/runs/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(id)}/answer`, {
            method: "POST",
            headers: { Authorization: `Bearer ${addr.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              answers: answers.map((a: any) => ({
                questionId: a.question_id,
                selectedLabels: a.selected_labels ?? [],
                ...(a.free_text ? { freeText: a.free_text } : {}),
              })),
            }),
          }).catch(() => {
            /* stale/failed answers surface as engine timeout-decline; never crash the wait loop */
          });
        }
      } finally {
        handling = false;
      }
    }
  };
}
