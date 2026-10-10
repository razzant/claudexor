import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { ControlJournalEvent, ControlSetupJobEvent, type ControlSetupJob } from "@claudexor/schema";
import { SqlSetupJobStore } from "../../cli/src/sql-setup-store.js";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { builtWorker } from "../../daemon/src/store/test-support/resource-fixture.js";
import { MaintenanceController } from "../../daemon/dist/store/maintenance.js";
import { decodeJournalCursor, encodeJournalCursor } from "../../daemon/src/store/cursors.js";
import type { SqlEventLedger } from "../../daemon/dist/store/event-store.js";
import { DaemonControlApiServer, type DaemonFacadeClient } from "./daemon-server.js";

function setupJob(): ControlSetupJob {
  return {
    jobId: "setup-background-fixture",
    harness: "codex",
    action: "login",
    transport: "daemon",
    state: "queued",
    phase: "preparing",
    command: null,
    guideUrl: null,
    message: "fixture only; no login is launched",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    profileId: null,
    authCapability: {
      attemptId: "fixture-attempt",
      challengeDigest: "a".repeat(64),
      requestDigest: "b".repeat(64),
      disclosure: {
        schemaVersion: 1,
        protocolVersion: 1,
        harness: "codex",
        requested: "subscription",
        requiredRoute: "vendor_native",
        requiredSource: "native_session",
        networkScope: "selected_harness_only",
        billingKnowledge: "unknown",
        incrementalCostKnowledge: "unknown",
        mayConsumeQuota: true,
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      state: "disclosed",
    },
  };
}

async function sse(response: Response) {
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async next(): Promise<unknown> {
      for (;;) {
        const boundary = buffered.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data) return JSON.parse(data.slice(6));
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("journal stream closed before expected event");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    },
    async close() {
      await reader.cancel().catch(() => {});
    },
  };
}

it("keeps global, project and setup SSE cursors usable during SQL maintenance and reopen", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "sql-background-sse-")));
  let sql = await sqlFixture(root, () => new Date("2026-01-01T00:00:00.000Z"));
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot);
  const projectId = sql.graph.projects.register({
    root: projectRoot,
    idempotencyKey: "project",
    clientId: "fixture",
  }).project.id;
  let global = sql.graph.globalEvents;
  let project = sql.graph.threads.ledger(sql.graph.projects.partition(projectId)!);
  let setup = new SqlSetupJobStore(root, sql.store, global);
  setup.create(setupJob());
  for (const ledger of [global, project])
    ledger.appendBatch(
      Array.from({ length: 40 }, (_, index) => ({
        type: "fixture.retained",
        payload: { index, text: "retained history ".repeat(4096) },
      })),
    );
  const sequence = (ledger: SqlEventLedger) => {
    const row = sql.store
      .prepare("SELECT next_seq FROM partition WHERE id=?")
      .get(ledger.generation.pid) as { next_seq: number };
    return Number(row.next_seq) - 1;
  };
  const current = (ledger: SqlEventLedger) =>
    encodeJournalCursor(ledger.generation.name, ledger.generation.epoch, sequence(ledger));
  const initialGlobal = current(global),
    initialProject = current(project),
    initialSetup = setup.snapshot("setup-background-fixture").cursor;
  const daemon: DaemonFacadeClient = {
    enqueue: async () => {
      throw new Error("fixture owns SSE only");
    },
    status: async () => {
      throw new Error("no run");
    },
    list: async () => [],
    cancel: async () => {
      throw new Error("no run");
    },
  };
  const server = new DaemonControlApiServer({
    token: "sql-background-fixture-token",
    daemon,
    pollMs: 2,
    services: {
      journalEvents: async (partition, cursor) => sql.graph.journalEvents(partition, cursor),
      setupJobStatus: async () => setup.status("setup-background-fixture"),
      setupJobEvents: async (input) =>
        setup.events("setup-background-fixture", (input as { afterCursor?: string }).afterCursor),
    },
  });
  const streams: Awaited<ReturnType<typeof sse>>[] = [];
  const gate = join(root, "maintenance-gate"),
    entered = join(root, "maintenance-entered"),
    entry = join(root, "maintenance-entry.mjs");
  writeFileSync(gate, "");
  // Hold only the test worker's bootstrap. The existing controller sends its
  // actual request, then the original compiled worker executes it after release.
  writeFileSync(
    entry,
    `import {existsSync,writeFileSync} from 'node:fs'; import {setTimeout} from 'node:timers/promises'; writeFileSync(${JSON.stringify(entered)},'ready'); while(existsSync(${JSON.stringify(gate)})) await setTimeout(5); await import(${JSON.stringify(pathToFileURL(builtWorker("maintenance-worker.js")).href)});`,
  );
  const maintenance = new MaintenanceController(sql.store, {
    workerEntry: entry,
    blobs: sql.graph.blobs,
  });
  let background: Promise<unknown> | null = null;
  const { host, port } = await server.start();
  const base = `http://${host}:${port}`;
  const headers = {
    authorization: "Bearer sql-background-fixture-token",
    "X-Claudexor-Protocol-Major": "3",
  };
  const connect = async (path: string, cursor: string) => {
    const stream = await sse(
      await fetch(`${base}/v2${path}`, {
        headers: { ...headers, "Last-Event-ID": cursor },
        signal: AbortSignal.timeout(20_000),
      }),
    );
    streams.push(stream);
    return stream;
  };
  try {
    const globalStream = await connect("/global/events", initialGlobal);
    const projectPath = `/projects/${projectId}/events`;
    const projectStream = await connect(projectPath, initialProject);
    const setupStream = await connect("/setup/jobs/setup-background-fixture/events", initialSetup);
    let lastSetup = initialSetup,
      lastGlobal = initialGlobal,
      lastProject = initialProject,
      finished = false;
    background = maintenance.exportTo(join(root, "snapshot.sqlite")).then((value) => {
      finished = true;
      return value;
    });
    await vi.waitFor(() => expect(existsSync(entered)).toBe(true));
    for (const [ordinal, ledger] of [global, project].entries()) {
      const acknowledged = ledger.appendBatch([
        { type: "fixture.ack", payload: { ordinal, row: 1 } },
        { type: "fixture.ack", payload: { ordinal, row: 2 } },
      ]);
      setup.update("setup-background-fixture", { message: `during maintenance ${ordinal}` });
      const target = ordinal === 0 ? globalStream : projectStream;
      const first = ControlJournalEvent.parse(await target.next()),
        second = ControlJournalEvent.parse(await target.next());
      expect([first.cursor, second.cursor]).toEqual(
        acknowledged.map((record) => ledger.cursorFor(record)),
      );
      expect([first.payload, second.payload]).toEqual(acknowledged.map((record) => record.payload));
      const setupEvent = ControlSetupJobEvent.parse(await setupStream.next());
      expect(setupEvent.previousCursor).toBe(lastSetup);
      expect(setupEvent.job.message).toBe(`during maintenance ${ordinal}`);
      lastSetup = setupEvent.cursor;
      const setupGlobal = ControlJournalEvent.parse(await globalStream.next());
      expect(setupGlobal.type).toBe("setup.job.saved");
      lastGlobal = setupGlobal.cursor;
      if (ordinal === 1) lastProject = second.cursor;
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect(finished).toBe(false);
    }
    rmSync(gate);
    expect(await background).toMatchObject({
      target: join(root, "snapshot.sqlite"),
      bytes: expect.any(Number),
    });
    background = null;
    expect(await maintenance.integrityCheck()).toMatchObject({ ok: true, problems: [] });
    expect(
      decodeJournalCursor(initialGlobal, "global", global.generation.epoch, sequence(global)),
    ).toBeLessThan(sequence(global));
    expect(
      decodeJournalCursor(
        initialProject,
        project.generation.name,
        project.generation.epoch,
        sequence(project),
      ),
    ).toBeLessThan(sequence(project));
    global.append("fixture.after", { retained: "global" });
    project.append("fixture.after", { retained: "project" });
    expect(ControlJournalEvent.parse(await globalStream.next()).type).toBe("fixture.after");
    expect(ControlJournalEvent.parse(await projectStream.next()).type).toBe("fixture.after");
    const histories = ["global", `project:${projectId}`].map((name) =>
      sql.graph.journalEvents(name),
    );
    await Promise.all(streams.splice(0).map((stream) => stream.close()));
    await maintenance.stop();
    await sql.close();
    sql = await sqlFixture(root);
    global = sql.graph.globalEvents;
    project = sql.graph.threads.ledger(sql.graph.projects.partition(projectId)!);
    setup = new SqlSetupJobStore(root, sql.store, global);
    expect(["global", `project:${projectId}`].map((name) => sql.graph.journalEvents(name))).toEqual(
      histories,
    );
    const resumedGlobal = await connect("/global/events", lastGlobal),
      resumedProject = await connect(projectPath, lastProject);
    expect(ControlJournalEvent.parse(await resumedGlobal.next()).type).toBe("fixture.after");
    expect(ControlJournalEvent.parse(await resumedProject.next()).type).toBe("fixture.after");
    const resumedSetup = await connect("/setup/jobs/setup-background-fixture/events", lastSetup);
    setup.update("setup-background-fixture", { message: "after reopen" });
    const resumed = ControlSetupJobEvent.parse(await resumedSetup.next());
    expect(resumed.previousCursor).toBe(lastSetup);
    expect(resumed.job.message).toBe("after reopen");
    expect(
      (
        await fetch(`${base}/v2/global/events`, {
          headers: { ...headers, "Last-Event-ID": initialProject },
        })
      ).status,
    ).toBe(409);
  } finally {
    rmSync(gate, { force: true });
    await background?.catch(() => {});
    await Promise.all(streams.map((stream) => stream.close()));
    await server.stop();
    await maintenance.stop();
    await sql.close();
    rmSync(root, { recursive: true, force: true });
  }
});
