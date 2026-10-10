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

/** Stage 3 bind: start the REAL socket + control transports (product
 * admission still closed) and publish their addresses. Returns the control
 * address, or null when the control API is disabled or shutdown began. */
export async function bindRecoveryTransport(input: {
  server: { start(): Promise<void> };
  control: { start(): Promise<{ host: string; port: number }> } | null;
  requested: () => boolean;
  daemonDir: string;
  logPath: string;
  socketPath: string;
}): Promise<{ host: string; port: number } | null> {
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

/** Stage 3 proof: prove self-health and exact identity through the REAL
 * transport while product admission is still closed. The proof dials the
 * socket itself: the daemon's in-process client cannot stand in for it. */
export async function proveRecoveryTransport(input: {
  socketPath: string;
  identity: { version: string; sha: string };
  token: string;
  control: { host: string; port: number } | null;
}): Promise<void> {
  const health = (await new DaemonClient(input.socketPath, input.token).health()) as {
    ok?: unknown;
    servingMode?: unknown;
  } | null;
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
