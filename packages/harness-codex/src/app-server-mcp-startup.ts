import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";
import type { JsonObject } from "./app-server-protocol.js";

/** Codex's own limit on each injected server's startup (`startup_timeout_sec`). */
export const CODEX_MCP_STARTUP_TIMEOUT_SEC = 90;

const CODEX_BROWSER_SERVER = "browser";

/**
 * Backstop for a missing status. Codex's own verdict is the deadline (observed at
 * 90.06 s on codex-cli 0.162.1); the margin lets it, and its real cause, arrive first.
 */
const CODEX_BROWSER_STARTUP_DEADLINE_MS = (CODEX_MCP_STARTUP_TIMEOUT_SEC + 5) * 1000;

type CodexMcpStartupState = "starting" | "ready" | "failed" | "cancelled";
type CodexMcpStatuses = Map<string, { status: CodexMcpStartupState; error?: string }>;

const isStartupState = (value: unknown): value is CodexMcpStartupState =>
  value === "starting" || value === "ready" || value === "failed" || value === "cancelled";

/** Startup is not ready while a required MCP server is still initializing. */
export function codexRequiredMcpStatuses(spec: HarnessRunSpec): CodexMcpStatuses {
  return new Map(
    spec.extra_mcp_servers
      .filter((server) => server.required)
      .map((server) => [server.name, { status: "starting" }] as const),
  );
}

export async function waitForCodexMcp(
  statuses: CodexMcpStatuses,
  nextNotification: (method: string) => Promise<JsonObject>,
): Promise<void> {
  while (statuses.size) {
    const failed = [...statuses].filter(
      ([, value]) => value.status === "failed" || value.status === "cancelled",
    );
    if (failed.length)
      throw new Error(
        `required MCP servers failed to initialize: ${failed.map(([name, value]) => `${name}: ${value.error ?? value.status}`).join(", ")}`,
      );
    if ([...statuses.values()].every((value) => value.status === "ready")) return;
    await nextNotification("mcpServer/startupStatus/updated");
  }
}

export const codexBrowserInjected = (
  spec: Pick<HarnessRunSpec, "browser" | "external_context_policy">,
): boolean => Boolean(spec.browser) && spec.external_context_policy !== "off";

/**
 * Startup of the Browser this run explicitly selected. It stays an optional server:
 * failure never fails the run. LIVE-VERIFIED (codex-cli 0.162.1, real Browser MCP,
 * local scripted Responses provider): a server not ready about 1 s after `turn/start`
 * is absent from the first model request's tools, in code mode (`ALL_TOOLS`) and
 * through `tool_search` alike, while a client that waits for `ready` gets them with
 * no restart. Codex reports the outcome once per process, also after `thread/resume`.
 */
export class CodexBrowserStartup {
  private status: CodexMcpStartupState | null = null;
  private error: string | null = null;
  /** What was known when `turn/start` was allowed; a later frame never rewrites it. */
  private receipt: {
    status: CodexMcpStartupState | null;
    error: string | null;
    waitedMs: number;
  } | null = null;
  private readonly injected: boolean;

  constructor(spec: Pick<HarnessRunSpec, "browser" | "external_context_policy">) {
    this.injected = codexBrowserInjected(spec);
  }

  observe(status: CodexMcpStartupState, error: string | undefined): void {
    this.status = status;
    this.error = error ?? null;
  }

  get settled(): boolean {
    return !this.injected || (this.status !== null && this.status !== "starting");
  }

  finishWait(waitedMs: number): void {
    this.receipt = { status: this.status, error: this.error, waitedMs };
  }

  /** The one startup receipt of this run, as evidence: never an error or a verdict. */
  takeEvents(sessionId: string): HarnessEvent[] {
    if (!this.injected || this.receipt === null) return [];
    const { status, waitedMs } = this.receipt;
    const error = this.receipt.error === null ? null : redactSecrets(this.receipt.error);
    this.receipt = null;
    const text =
      status === "ready"
        ? `Browser MCP ready before the first model request (waited ${waitedMs} ms).`
        : status === "failed" || status === "cancelled"
          ? `Browser MCP ${status === "failed" ? "failed to start" : "startup was cancelled"}; the run continues without Browser tools: ${error ?? "Codex gave no reason"}`
          : `Browser MCP reported no startup result after ${waitedMs} ms (last status: ${status ?? "none"}); the first model request may not offer Browser tools.`;
    return [
      {
        type: "status",
        session_id: sessionId,
        ts: nowIso(),
        text,
        payload: {
          code: "codex_browser_startup",
          status: status ?? "not_observed",
          waited_ms: waitedMs,
          ...(error === null ? {} : { error }),
        },
      },
    ];
  }
}

/** One native startup frame: Browser's receipt and required state; `true` = a required server failed. */
export function observeCodexMcpStartup(
  params: JsonObject | null,
  required: CodexMcpStatuses,
  browser: CodexBrowserStartup,
): boolean {
  const name = params?.["name"];
  const status = params?.["status"];
  if (typeof name !== "string" || !isStartupState(status)) return false;
  const reason = params?.["error"] ?? params?.["failureReason"];
  const error = typeof reason === "string" ? reason : undefined;
  if (name === CODEX_BROWSER_SERVER) browser.observe(status, error);
  if (!required.has(name)) return false;
  required.set(name, { status, ...(error === undefined ? {} : { error }) });
  return status === "failed" || status === "cancelled";
}

/** The next frame or process change; `false` once `timeoutMs` lapses in silence. */
export const notificationArrival = (
  waiter: { wake?: () => void },
  timeoutMs?: number,
): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    waiter.wake = () => {
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    if (timeoutMs !== undefined)
      timer = setTimeout(() => {
        waiter.wake = undefined;
        resolve(false);
      }, timeoutMs);
  });

/** Holds `turn/start` for selected Browser: until its outcome, the deadline, Stop or process loss. */
export async function waitForCodexBrowser(input: {
  startup: CodexBrowserStartup;
  deadlineMs: number | undefined;
  /** Throws once the process is gone. */
  assertProcessLive(): void;
  stopRequested(): boolean;
  /** The thread already failed natively: no Browser verdict could change that. */
  abandoned(): boolean;
  nextArrival(timeoutMs: number): Promise<boolean>;
}): Promise<void> {
  const { startup } = input;
  const deadlineMs = input.deadlineMs ?? CODEX_BROWSER_STARTUP_DEADLINE_MS;
  const startedAt = Date.now();
  for (;;) {
    input.assertProcessLive();
    if (input.stopRequested()) throw new Error("Codex run stopped during Browser startup");
    const waitedMs = Date.now() - startedAt;
    if (startup.settled || input.abandoned() || waitedMs >= deadlineMs) {
      startup.finishWait(waitedMs);
      return;
    }
    await input.nextArrival(deadlineMs - waitedMs);
  }
}
