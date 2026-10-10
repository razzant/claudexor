/**
 * Two-stage daemon startup admission (issue #165 D5).
 *
 * Stage order enforced by main(): (1) acquire the root authority barrier with
 * its epoch/floor refusals; (2) read-only prepare + validate the global AND
 * every registered project partition — zero recovery writes; (3) bind the
 * REAL transport (socket + control API) with product admission CLOSED and
 * prove self-health/exact identity through it; (4) only then advance the
 * semantic floor, run destructive recovery (crash-GC, prepared activation,
 * recoverAfterStartup terminalization) and open normal admission. A
 * recovery-needed partition leaves the recovery plane online with the floor
 * UNCHANGED and cleanup OFF.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DaemonClient,
  type DaemonServingMode,
  type JournalManagerPreparation,
  type ProjectPartitionsPreparation,
  type RootAuthorityGrant,
  processMemoryFields,
  recordAdmissionMemory,
} from "@claudexor/daemon";
import { JournalRecoveryRequiredError } from "@claudexor/journal";
import { CONTROL_PROTOCOL_MAJOR } from "@claudexor/schema";

/** Single canonical admission snapshot; both transports read the SAME fact. */
export class DaemonStartupAdmission {
  private mode: DaemonServingMode = "recovery_only";
  readonly snapshot = (): DaemonServingMode => this.mode;
  openNormal(): void {
    this.mode = "normal";
  }
}

/** Stage-2 verdict: every partition that blocks destructive recovery. The
 * loose Picks let the C6 in-process reopen feed LIVE inspections through the
 * same verdict the frozen stage-2 receipts use. */
export function recoveryBlockedPartitions(input: {
  globalPreparation: { inspection: Pick<JournalManagerPreparation["inspection"], "status"> };
  partitionsPreparation: Pick<
    ProjectPartitionsPreparation,
    "coverage" | "recoveryRequiredPartitions"
  >;
}): string[] {
  const blocked: string[] = [];
  if (input.globalPreparation.inspection.status !== "ready") blocked.push("global");
  if (input.partitionsPreparation.coverage !== "complete") {
    blocked.push("project-registry");
  }
  blocked.push(...input.partitionsPreparation.recoveryRequiredPartitions);
  return blocked;
}

/** C6a: whether the control API binds this startup. CLAUDEXOR_NO_CONTROL_API=1
 * is honored only on a clean verdict — the recovery surface IS the point of
 * the recovery plane, so a recovery-required verdict overrides it (logged). */
export function controlApiEnabledForStartup(input: {
  disabledByEnv: boolean;
  blockedPartitions: string[];
  log: (message: string) => void;
}): boolean {
  if (!input.disabledByEnv) return true;
  if (input.blockedPartitions.length === 0) return false;
  input.log(
    "recovery-required startup verdict overrides CLAUDEXOR_NO_CONTROL_API=1: binding the control API to serve the recovery surface",
  );
  return true;
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

/** Stage 4: revalidate every read-only preparation FIRST; only on all-green
 * advance the floor, run destructive recovery and open normal admission — or
 * the protected recovery-only outcome (floor unchanged, cleanup off). */
export async function completeStartupAdmission(input: {
  grant: Pick<RootAuthorityGrant, "advanceFloor">;
  blockedPartitions: string[];
  global: {
    revalidatePreparation(): void;
    activatePrepared(): void;
    recoverAfterStartup(): void;
  };
  partitions: {
    revalidatePreparation(): void;
    activatePrepared(): void;
    recoverAfterStartup(): void;
  };
  crashGc: () => Promise<void>;
  admission: DaemonStartupAdmission;
  log: (message: string) => void;
}): Promise<DaemonServingMode> {
  if (input.blockedPartitions.length > 0) {
    input.log(
      `startup admission: serving recovery only — floor unchanged, destructive recovery and cleanup OFF (recovery required: ${input.blockedPartitions.join(", ")})`,
    );
    return "recovery_only";
  }
  // C3: prove the filesystem still matches every stage-2 preparation BEFORE
  // the first irreversible act. Any revalidation failure leaves the floor
  // UNCHANGED and zero destructive work done.
  try {
    input.global.revalidatePreparation();
    input.partitions.revalidatePreparation();
  } catch (error) {
    if (error instanceof JournalRecoveryRequiredError) {
      input.log(
        `startup admission: preparation revalidation failed; serving recovery only with floor unchanged (${error.message})`,
      );
      return "recovery_only";
    }
    throw error;
  }
  input.grant.advanceFloor();
  await input.crashGc();
  try {
    input.global.activatePrepared();
    input.partitions.activatePrepared();
    input.global.recoverAfterStartup();
    input.partitions.recoverAfterStartup();
  } catch (error) {
    if (error instanceof JournalRecoveryRequiredError) {
      // Activation re-revalidates and raced a journal mutation: stay on the
      // recovery plane instead of serving a partition we could not activate.
      input.log(
        `startup admission: prepared activation entered recovery; serving recovery only (${error.message})`,
      );
      return "recovery_only";
    }
    throw error;
  }
  input.admission.openNormal();
  recordAdmissionMemory();
  input.log(`startup admission: normal product admission open (${processMemoryFields()})`);
  return "normal";
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
