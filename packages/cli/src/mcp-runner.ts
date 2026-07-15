import { ModeKind } from "@claudexor/schema";
import {
  connectDaemonIfRunning,
  daemonOutcomeSummary,
  ensureDaemon,
  enqueueAndAwait,
  fetchApplyEligibility,
} from "./daemon-run.js";
import { primaryOutputForCli } from "./primary-output.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";

export interface SurfaceRunnerHooks {
  onEvent?: (event: any) => void;
  onInteraction?: (ctx: any) => Promise<any | null>;
  signal?: AbortSignal;
}

/**
 * Shared MCP/ACP runner. All product modes cross the daemon's /v2 boundary;
 * interactive questions bridge through pendingInteractions and typed answers.
 */
export function mcpSurfaceRunner() {
  return async (p: any, hooks?: SurfaceRunnerHooks) => {
    if (p?.mode === "__status" || p?.mode === "__capabilities") {
      return catalogQuery(p.mode);
    }
    if (p?.mode === "__runs_list" || p?.mode === "__run_inspect" || p?.mode === "__apply_check") {
      return recoveryQuery(p.mode, typeof p?.runId === "string" ? p.runId : "");
    }
    if (p?.mode === "__journal_recovery") return journalRecoveryQuery(p);
    const mode = ModeKind.parse(p?.mode ?? "agent");
    const { client, addr } = await ensureDaemon();
    const repoRoot =
      typeof p?.repoPath === "string" && p.repoPath.trim() ? p.repoPath : process.cwd();
    const body: Record<string, unknown> = {
      prompt: String(p?.prompt ?? ""),
      mode,
      scope: { kind: "project", root: repoRoot },
      execution: { isolation: "envelope" },
      ...(p?.harness ? { harnesses: [String(p.harness)] } : {}),
      ...(p?.primaryHarness ? { primaryHarness: String(p.primaryHarness) } : {}),
      ...(p?.race === true
        ? { n: typeof p?.n === "number" ? p.n : 2 }
        : typeof p?.n === "number"
          ? { n: p.n }
          : {}),
      ...(p?.create === true ? { create: true } : {}),
      ...(Array.isArray(p?.tests) ? { tests: p.tests.map(String) } : {}),
      ...(typeof p?.maxUsd === "number" ? { maxUsd: p.maxUsd } : {}),
      ...(p?.access ? { access: String(p.access) } : {}),
      // `externalContextPolicy` is the control-api-parity alias of `web`; the
      // validator already enforced equality when both are present. Honor the
      // alias alone too — dropping it would silently run the daemon default.
      ...(p?.web
        ? { web: String(p.web) }
        : p?.externalContextPolicy
          ? { web: String(p.externalContextPolicy) }
          : {}),
      ...(p?.model ? { model: String(p.model) } : {}),
      ...(p?.effort ? { effort: String(p.effort) } : {}),
      ...(Array.isArray(p?.reviewerPanel) ? { reviewerPanel: p.reviewerPanel } : {}),
      ...(p?.reviewerModels && typeof p.reviewerModels === "object"
        ? { reviewerModels: p.reviewerModels }
        : {}),
      ...(p?.reviewerEfforts && typeof p.reviewerEfforts === "object"
        ? { reviewerEfforts: p.reviewerEfforts }
        : {}),
      ...(Array.isArray(p?.protectedPathApprovals)
        ? { protectedPathApprovals: p.protectedPathApprovals }
        : {}),
    };
    const interactionBridge = hooks?.onInteraction
      ? makeInteractionBridge(addr, hooks.onInteraction)
      : undefined;
    // Host cancellation (MCP notifications/cancelled -> ctx signal) becomes
    // the same TYPED daemon cancel the CLI's Ctrl-C path posts; the wait loop
    // then resolves with the honest cancelled terminal.
    const cancelBridge = hooks?.signal ? makeCancelBridge(addr, hooks.signal) : undefined;
    const onPollTick =
      interactionBridge || cancelBridge
        ? async (info: { runId: string }) => {
            cancelBridge?.(info);
            await interactionBridge?.(info);
          }
        : undefined;
    const out = await enqueueAndAwait(client, addr, body, {
      waitForTerminal: true,
      ...(onPollTick ? { onPollTick } : {}),
    });
    // The MCP result: the run's primary output as the summary (the daemon
    // outcome reason for non-success terminals), plus the artifact handle.
    const primary = out.runDir ? primaryOutputForCli(out.runDir, mode) : null;
    const reason = daemonOutcomeSummary(out);
    const summary =
      primary && primary.kind !== "patch"
        ? primary.text.trim()
        : (reason ??
          (primary?.kind === "patch" ? "patch produced (see artifacts)" : `run ${out.status}`));
    // The derived apply verdict rides the result (single producer: the run
    // detail endpoint). Soft-fail: a detail hiccup never eats the run result.
    const applyEligibility = await fetchApplyEligibility(addr, out.runId);
    return { runId: out.runId, runDir: out.runDir, status: out.status, summary, applyEligibility };
  };
}

async function catalogQuery(mode: "__status" | "__capabilities"): Promise<unknown> {
  const { addr } = await ensureDaemon();
  const path = mode === "__status" ? "/harnesses" : "/agent-capabilities";
  const response = await controlApiFetch(addr, path);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(`control API ${path} failed (HTTP ${response.status})`);
  if (mode === "__capabilities") return body;
  const harnesses = Array.isArray(body["harnesses"])
    ? (body["harnesses"] as Record<string, unknown>[])
    : [];
  return {
    ...body,
    available: harnesses.filter((item) => item["status"] === "ok").map((item) => item["id"]),
  };
}

/**
 * Recovery queries — thin read-only projections over the daemon control API
 * (auto-starting it like every daemon-tracked path). A host that lost a run
 * handle finds it again without shelling out to the CLI.
 */
async function recoveryQuery(mode: string, runId: string): Promise<unknown> {
  // Read-only recovery must not BOOT a daemon: with no daemon there are no
  // daemon-tracked runs to recover — say so instead of spawning one.
  const conn = await connectDaemonIfRunning();
  if (!conn) {
    return {
      summary:
        "the Claudexor daemon is not running — there are no live daemon-tracked runs to recover (start one with `claudexor daemon start` or run a mutating tool first)",
    };
  }
  const { addr } = conn;
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const res = await controlApiFetch(addr, path, {
      headers: { authorization: `Bearer ${addr.token}` },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok)
      throw new Error(
        typeof body["message"] === "string"
          ? (body["message"] as string)
          : `HTTP ${res.status} for ${path}`,
      );
    return body;
  };
  if (mode === "__runs_list") {
    const body = await get("/runs");
    const runs = Array.isArray(body["runs"]) ? (body["runs"] as Record<string, unknown>[]) : [];
    return {
      summary: `${runs.length} daemon-tracked run(s)`,
      runs: runs.map((r) => ({
        runId: r["runId"] ?? r["id"] ?? null,
        status: r["status"] ?? r["state"] ?? null,
        mode: r["mode"] ?? null,
        createdAt: r["createdAt"] ?? null,
      })),
    };
  }
  if (!runId) throw new Error("runId is required");
  if (mode === "__run_inspect") {
    const detail = await get(`/runs/${encodeURIComponent(runId)}`);
    const summary = (detail["summary"] ?? {}) as Record<string, unknown>;
    const decision = (detail["decision"] ?? null) as Record<string, unknown> | null;
    return {
      summary:
        typeof detail["finalSummary"] === "string" && detail["finalSummary"]
          ? detail["finalSummary"]
          : `run ${runId}: ${String(summary["status"] ?? "unknown")}`,
      runId,
      status: summary["status"] ?? null,
      decisionStatus: decision ? (decision["status"] ?? null) : null,
      applyEligibility: detail["applyEligibility"] ?? null,
      pendingInteractions: Array.isArray(detail["pendingInteractions"])
        ? (detail["pendingInteractions"] as unknown[]).length
        : 0,
    };
  }
  // __apply_check: the server-side dry gate + patch check (no mutation).
  const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}/apply/check`, {
    method: "POST",
    headers: { authorization: `Bearer ${addr.token}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      summary: `apply check refused: ${typeof body["message"] === "string" ? body["message"] : `HTTP ${res.status}`}`,
      runId,
      eligible: false,
    };
  }
  // HTTP 200 carries the ApplyResult; `ok:false` means `git apply --check`
  // itself failed — an honest conflict verdict, never "applies cleanly".
  if (body["ok"] !== true) {
    const stderr =
      typeof body["stderr"] === "string" && body["stderr"].trim()
        ? `: ${body["stderr"].trim()}`
        : "";
    return {
      summary: `apply check failed: the patch does NOT apply cleanly${stderr}`,
      runId,
      eligible: false,
      check: body,
    };
  }
  return {
    summary: "apply check passed: the patch applies cleanly to the original project",
    runId,
    eligible: true,
    check: body,
  };
}

async function journalRecoveryQuery(input: Record<string, unknown>): Promise<unknown> {
  const conn = await connectDaemonIfRunning();
  if (!conn) throw new Error("the Claudexor daemon is not running");
  const action = String(input["action"] ?? "inspect");
  const partition = String(input["partition"] ?? "");
  if (!partition) throw new Error("partition is required");
  const base = `/recovery/partitions/${encodeURIComponent(partition)}`;
  const suffix =
    action === "inspect"
      ? ""
      : action === "validate" || action === "export" || action === "quarantine"
        ? `/${action}`
        : null;
  if (suffix === null) throw new Error(`unknown journal recovery action '${action}'`);
  const body =
    action === "quarantine"
      ? {
          expectedFingerprint: String(input["expectedFingerprint"] ?? ""),
          confirmation: String(input["confirmation"] ?? ""),
        }
      : undefined;
  const response = await controlApiFetch(conn.addr, `${base}${suffix}`, {
    method: action === "inspect" ? "GET" : "POST",
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      typeof result["message"] === "string"
        ? (result["message"] as string)
        : `journal recovery failed (HTTP ${response.status})`,
    );
  }
  return result;
}

/**
 * Cancel bridge: once the run is BOUND (we know its id), an aborted host
 * signal posts the typed cancel control exactly once. Runs on the poll tick
 * so an abort that races run-binding still lands.
 */
export function makeCancelBridge(
  addr: ControlApiAddress,
  signal: AbortSignal,
): (info: { runId: string }) => void {
  let posted = false;
  return ({ runId }) => {
    if (posted || !signal.aborted || !runId) return;
    posted = true;
    void controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}/control`, {
      method: "POST",
      headers: { Authorization: `Bearer ${addr.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        control: { kind: "cancel", reason: "mcp host cancelled the tool call" },
      }),
    }).catch(() => {
      posted = false; // transient failure: retry on the next tick
    });
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
    let pending: Array<{
      interactionId?: string;
      questions?: unknown[];
      timeoutAt?: string | null;
    }> = [];
    try {
      const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
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
          request: {
            interaction_id: id,
            questions: Array.isArray(pi.questions) ? pi.questions : [],
          },
          timeoutAt: pi.timeoutAt ?? undefined,
        });
        const answers = result && Array.isArray(result.answers) ? result.answers : null;
        if (answers) {
          await controlApiFetch(
            addr,
            `/runs/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(id)}/answer`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${addr.token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                answers: answers.map((a: any) => ({
                  questionId: a.question_id,
                  selectedLabels: a.selected_labels ?? [],
                  ...(a.free_text ? { freeText: a.free_text } : {}),
                })),
              }),
            },
          ).catch(() => {
            /* stale/failed answers surface as engine timeout-decline; never crash the wait loop */
          });
        }
      } finally {
        handling = false;
      }
    }
  };
}
