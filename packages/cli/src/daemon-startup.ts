import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DaemonClient, type DaemonServingMode } from "@claudexor/daemon";
import { CONTROL_PROTOCOL_MAJOR } from "@claudexor/schema";

/** Single canonical admission snapshot; both transports read the SAME fact. */
export class DaemonStartupAdmission {
  private mode: DaemonServingMode = "recovery_only";
  readonly snapshot = (): DaemonServingMode => this.mode;
  enterRecoveryOnly(): void {
    this.mode = "recovery_only";
  }
  openNormal(): void {
    this.mode = "normal";
  }
}

interface RecoveryTransportBind {
  server: { start(): Promise<void> };
  control: { start(): Promise<{ host: string; port: number }> } | null;
  requested: () => boolean;
  daemonDir: string;
  logPath: string;
  socketPath: string;
}

/** Stage 3 bind: start the REAL socket + control transports (product
 * admission still closed) and publish their addresses. Returns the control
 * address, or null when the control API is disabled or shutdown began. A Stop
 * during a listen surfaces as that server's own typed `daemon_stopping`
 * refusal, raised after its stop joined the start: shutdown began. Any other
 * start failure stays a startup failure, whether or not a Stop is under way. */
export async function bindRecoveryTransport(
  input: RecoveryTransportBind,
): Promise<{ host: string; port: number } | null> {
  try {
    return await bindTransport(input);
  } catch (error) {
    if (input.requested() && (error as { code?: unknown } | null)?.code === "daemon_stopping")
      return null;
    throw error;
  }
}

async function bindTransport(
  input: RecoveryTransportBind,
): Promise<{ host: string; port: number } | null> {
  const stamp = () => `[${new Date().toISOString()}]`;
  if (!input.requested()) await input.server.start();
  if (!input.requested()) {
    appendFileSync(
      input.logPath,
      `${stamp()} claudexord listening on ${input.socketPath} (recovery-only admission)\n`,
    );
  }
  if (!input.control) {
    if (!input.requested()) {
      appendFileSync(
        input.logPath,
        `${stamp()} claudexor control-api disabled by CLAUDEXOR_NO_CONTROL_API=1\n`,
      );
    }
    return null;
  }
  if (input.requested()) return null;
  const controlAddr = await input.control.start();
  if (input.requested()) return null;
  writeFileSync(
    join(input.daemonDir, "control-api.json"),
    `${JSON.stringify({ ...controlAddr, tokenPath: join(input.daemonDir, "token") }, null, 2)}\n`,
    { mode: 0o600 },
  );
  appendFileSync(
    input.logPath,
    `${stamp()} claudexor control-api listening on http://${controlAddr.host}:${controlAddr.port}\n`,
  );
  return controlAddr;
}

interface RecoveryTransportProof {
  socketPath: string;
  identity: { version: string; sha: string };
  token: string;
  control: { host: string; port: number } | null;
  /** Startup cancellation: a Stop aborts it before closing these transports. */
  signal?: AbortSignal;
}

/** Stage 3 proof: prove self-health and exact identity through the REAL
 * transport while product admission is still closed. The proof dials the
 * socket itself: the daemon's in-process client cannot stand in for it.
 * "cancelled" means a Stop aborted startup before the proof decided; that Stop
 * fences and closes these very transports, so nothing answered after the
 * abort is evidence about them. A decided failure and any other error reject. */
export async function proveRecoveryTransport(
  input: RecoveryTransportProof,
): Promise<"proved" | "cancelled"> {
  try {
    await proveTransport(input);
    return "proved";
  } catch (error) {
    if (input.signal?.aborted && error === input.signal.reason) return "cancelled";
    throw error;
  }
}

async function proveTransport(input: RecoveryTransportProof): Promise<void> {
  type HealthReply = { ok?: unknown; servingMode?: unknown } | null;
  let health: HealthReply;
  try {
    health = (await new DaemonClient(input.socketPath, input.token).health()) as HealthReply;
  } finally {
    // The socket RPC has no abort of its own: once startup was aborted, its
    // answer or failure is reported as that abort (fetch below does the same).
    input.signal?.throwIfAborted();
  }
  if (health?.ok !== true || health.servingMode !== "recovery_only") {
    throw new Error(
      "daemon transport proof failed: socket health did not report a recovery-only serving daemon",
    );
  }
  if (!input.control) return;
  const response = await fetch(`http://${input.control.host}:${input.control.port}/v2/handshake`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ protocolMajor: CONTROL_PROTOCOL_MAJOR, client: "claudexord-startup" }),
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`daemon transport proof failed: control handshake HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    engine?: { version?: unknown; sha?: unknown };
    servingMode?: unknown;
  } | null;
  if (
    body?.engine?.version !== input.identity.version ||
    body.engine.sha !== input.identity.sha ||
    body.servingMode !== "recovery_only"
  ) {
    throw new Error(
      "daemon transport proof failed: control handshake did not prove this exact recovery-only runtime",
    );
  }
}

/** Post-admission ghost-project quarantine (F2), normal admission only. */
export function quarantineGhostProjectsAtStartup(
  threads: {
    quarantineGhostProjects(): Iterable<{ projectId: string; reason: string; root: string }>;
  },
  log: (message: string) => void,
): void {
  try {
    for (const ghost of threads.quarantineGhostProjects()) {
      log(`projects: quarantined ghost ${ghost.projectId} (${ghost.reason}): ${ghost.root}`);
    }
  } catch (error) {
    log(`projects: ghost sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
