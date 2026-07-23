import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JournalManager, type JournalQuarantineRequest } from "@claudexor/daemon";
import {
  DaemonControlApiServer,
  type DaemonControlApiOptions,
  type DaemonFacadeClient,
} from "@claudexor/control-api";
import { createSetupJobManager, type SetupJobManagerOptions } from "./setup-jobs.js";
import { SetupJobStore } from "./setup-job-store.js";
import { SetupLifecycleBinding } from "./setup-lifecycle-binding.js";

type SetupManager = ReturnType<typeof createSetupJobManager>;

const unusedAuthVerifier = {
  prepare(input: { attemptId: string; harness: string }) {
    return {
      binding: {
        attemptId: input.attemptId,
        challengeDigest: "a".repeat(64),
        requestDigest: "b".repeat(64),
        disclosure: {
          schemaVersion: 1 as const,
          protocolVersion: 1 as const,
          harness: input.harness,
          requested: "subscription" as const,
          requiredRoute: "vendor_native" as const,
          requiredSource: "native_session" as const,
          networkScope: "selected_harness_only" as const,
          billingKnowledge: "unknown" as const,
          incrementalCostKnowledge: "unknown" as const,
          mayConsumeQuota: true,
          generatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
  },
  async verify() {
    throw new Error("capability verification is not used by the non-Darwin fixture");
  },
  cleanup() {},
} satisfies NonNullable<SetupJobManagerOptions["authCapabilityVerifier"]>;

function registerSetupProjection(manager: JournalManager) {
  return manager.registerProjection({
    name: "setup",
    create: (journal) => new SetupJobStore(manager.rootDir, { journal }),
    validate: (store) => store.validateProjection(),
  });
}

function corruptFirstByte(path: string): void {
  const bytes = readFileSync(path);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  writeFileSync(path, bytes, { mode: 0o600 });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("daemon recovery composition", () => {
  it("keeps recovery online while setup is degraded, quarantines, rebinds, and runs setup in the fresh epoch", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-recovery-integration-")));

    const seed = new JournalManager(root);
    const seedSlot = registerSetupProjection(seed);
    seed.start();
    const oldJournal = seedSlot.current().journal;
    oldJournal.append("integration.seed", { purpose: "create one complete frame" });
    const oldCursor = oldJournal.currentCursor();
    const journalPath = oldJournal.path;
    seed.close();
    corruptFirstByte(journalPath);

    const journal = new JournalManager(root);
    const setupSlot = registerSetupProjection(journal);
    const degraded = journal.start();
    expect(degraded.status).toBe("recovery_required");

    const handles: SetupManager[] = [];
    const setup = new SetupLifecycleBinding(setupSlot, (store) => {
      const handle = createSetupJobManager({
        rootDir: root,
        store,
        probeAuthSource: async () => null,
        authCapabilityVerifier: unusedAuthVerifier,
        platform: "linux",
        monitorPollMs: 5,
      });
      handles.push(handle);
      return handle;
    });
    await setup.start();
    expect(handles).toHaveLength(0);

    const daemon: DaemonFacadeClient = {
      async enqueue() {
        return { id: "unused", state: "queued" };
      },
      async status(id) {
        return { id, state: "failed" };
      },
      async list() {
        return [];
      },
      async cancel() {
        return { cancelled: true };
      },
    };
    const services: NonNullable<DaemonControlApiOptions["services"]> = {
      createSetupJob: async (input) =>
        setup.current().create(input.request, {
          key: input.idempotencyKey,
          client: input.clientId,
        }),
      setupJobStatus: async (input) => setup.current().status(input),
      setupJobEvents: async (input) => setup.current().events(input),
      recoveryInspectPartition: async () => journal.inspect(),
      recoveryValidatePartition: async () => journal.validate(),
      recoveryExportPartition: async () => journal.exportRecovery(),
      recoveryQuarantinePartition: async (_partition, input) => {
        const request = input as JournalQuarantineRequest;
        const preflight = journal.preflightQuarantine(request);
        if (preflight.disposition === "completed") return preflight.receipt;
        return setup.replaceAfter(() => journal.quarantineAndStartFresh(request));
      },
    };
    const token = "recovery-integration-token";
    const control = new DaemonControlApiServer({
      token,
      daemon,
      services,
      pollMs: 5,
    });
    const { host, port } = await control.start();
    const base = `http://${host}:${port}`;
    const auth = {
      authorization: `Bearer ${token}`,
      "x-claudexor-protocol-major": "3",
    };
    const jsonHeaders = { ...auth, "content-type": "application/json" };

    try {
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await responseJson(health)).toEqual({ ok: true });

      const inspectionResponse = await fetch(`${base}/v2/recovery/partitions/global`, {
        headers: auth,
      });
      expect(inspectionResponse.status).toBe(200);
      const inspection = await responseJson(inspectionResponse);
      expect(inspection).toMatchObject({
        partition: "global",
        status: "recovery_required",
        fingerprint: degraded.fingerprint,
      });

      const validation = await fetch(`${base}/v2/recovery/partitions/global/validate`, {
        method: "POST",
        headers: auth,
      });
      expect(validation.status).toBe(200);
      expect(await responseJson(validation)).toMatchObject({
        status: "recovery_required",
        projectionStatus: [{ name: "setup", status: "invalid" }],
      });

      const exported = await fetch(`${base}/v2/recovery/partitions/global/export`, {
        method: "POST",
        headers: auth,
      });
      expect(exported.status).toBe(200);
      expect(await responseJson(exported)).toMatchObject({
        partition: "global",
        fingerprint: degraded.fingerprint,
      });

      const unavailableSetup = await fetch(`${base}/v2/setup/jobs`, {
        method: "POST",
        headers: { ...jsonHeaders, "Idempotency-Key": "setup-while-degraded" },
        body: JSON.stringify({
          harness: "codex",
          action: "login",
          authRequest: "subscription",
        }),
      });
      expect(unavailableSetup.status).toBe(503);
      expect(unavailableSetup.headers.get("content-type")).toBe("application/problem+json");
      expect(await responseJson(unavailableSetup)).toMatchObject({
        code: "journal_recovery_required",
        retryable: false,
      });

      const staleFingerprint = await fetch(`${base}/v2/recovery/partitions/global/quarantine`, {
        method: "POST",
        headers: { ...jsonHeaders, "Idempotency-Key": "wrong-fingerprint" },
        body: JSON.stringify({
          expectedFingerprint: "0".repeat(64),
          confirmation: "quarantine_and_start_fresh",
        }),
      });
      expect(staleFingerprint.status).toBe(409);
      expect(await responseJson(staleFingerprint)).toMatchObject({
        code: "recovery_fingerprint_mismatch",
      });
      expect(journal.inspect().fingerprint).toBe(degraded.fingerprint);
      expect(handles).toHaveLength(0);

      const quarantineRequest = {
        expectedFingerprint: degraded.fingerprint,
        confirmation: "quarantine_and_start_fresh",
      };
      const quarantineOnce = await fetch(`${base}/v2/recovery/partitions/global/quarantine`, {
        method: "POST",
        headers: { ...jsonHeaders, "Idempotency-Key": "recover-global" },
        body: JSON.stringify(quarantineRequest),
      });
      expect(quarantineOnce.status).toBe(200);
      const receipt = await responseJson(quarantineOnce);
      expect(receipt).toMatchObject({
        partition: "global",
        previousFingerprint: degraded.fingerprint,
      });
      expect(journal.inspect().status).toBe("ready");
      expect(setup.generation()).toBe(2);
      expect(handles).toHaveLength(1);

      const quarantineReplay = await fetch(`${base}/v2/recovery/partitions/global/quarantine`, {
        method: "POST",
        headers: { ...jsonHeaders, "Idempotency-Key": "recover-global" },
        body: JSON.stringify(quarantineRequest),
      });
      expect(quarantineReplay.status).toBe(200);
      expect(await responseJson(quarantineReplay)).toEqual(receipt);
      expect(handles).toHaveLength(1);

      const idempotencyConflict = await fetch(`${base}/v2/recovery/partitions/global/quarantine`, {
        method: "POST",
        headers: { ...jsonHeaders, "Idempotency-Key": "recover-global" },
        body: JSON.stringify({
          expectedFingerprint: "0".repeat(64),
          confirmation: "quarantine_and_start_fresh",
        }),
      });
      expect(idempotencyConflict.status).toBe(409);
      expect(await responseJson(idempotencyConflict)).toMatchObject({
        code: "idempotency_conflict",
      });
      expect(handles).toHaveLength(1);

      const previousCodexBin = process.env.CLAUDEXOR_CODEX_BIN;
      process.env.CLAUDEXOR_CODEX_BIN = process.execPath;
      let createLogin: Response;
      try {
        createLogin = await fetch(`${base}/v2/setup/jobs`, {
          method: "POST",
          headers: { ...jsonHeaders, "Idempotency-Key": "setup-after-recovery" },
          body: JSON.stringify({
            harness: "codex",
            action: "login",
            authRequest: "subscription",
            // The legacy Terminal flow is macOS-only, so on linux it terminalizes
            // as launch_failed — a clean fresh-epoch terminal outcome. (The
            // device-code default is not macOS-gated and would stay waiting.)
            loginFlow: "browser_redirect",
          }),
        });
      } finally {
        if (previousCodexBin === undefined) delete process.env.CLAUDEXOR_CODEX_BIN;
        else process.env.CLAUDEXOR_CODEX_BIN = previousCodexBin;
      }
      expect(createLogin.status).toBe(200);
      const created = await responseJson(createLogin);
      expect(created).toMatchObject({
        harness: "codex",
        action: "login",
        state: "failed",
        outcome: { reason: "launch_failed" },
      });
      const jobId = String(created["jobId"]);

      const staleCursor = await fetch(`${base}/v2/setup/jobs/${encodeURIComponent(jobId)}/events`, {
        headers: { ...auth, "Last-Event-ID": oldCursor },
      });
      expect(staleCursor.status).toBe(409);
      expect(staleCursor.headers.get("content-type")).toBe("application/problem+json");
      expect(await responseJson(staleCursor)).toMatchObject({
        code: "journal_cursor_invalid",
        requiredActions: ["resnapshot"],
      });
    } finally {
      await control.stop();
      await setup.shutdown();
      journal.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
