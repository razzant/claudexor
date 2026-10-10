/**
 * Addressed daemon command reads (`claudexor.list` with a query).
 *
 * The unqualified list projects EVERY retained product command through
 * `publicJobRecord`, which recursively walks and redacts each record's params —
 * so a status poll used to serialize every retained prompt in the partition.
 * These tests pin the addressed read over the REAL socket: the selection rules,
 * and two oracles that the unselected records are not merely absent from the
 * answer but never touched at all (byte identity against a production-shaped
 * roster, and a nested params getter that throws the moment it is traversed).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DurableJournal } from "@claudexor/journal";
import { MAX_DELEGATED_CHILDREN } from "@claudexor/schema";
import { afterAll, describe, expect, it } from "vitest";
import { DaemonClient } from "./client.js";
import { CommandStore } from "./command-store.js";
import type { LegacyCommandAuthority } from "./command-authority.js";
import { DaemonServer, type JobRecord } from "./server.js";

const TOKEN = "addressed-read-token";
const BASE_MS = Date.UTC(2026, 8, 15);

const reaped: string[] = [];
afterAll(() => {
  for (const dir of reaped.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `cx-addressed-${name}-`)));
  reaped.push(dir);
  return dir;
}

function iso(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

/** A hand-built retained command: the daemon's record shape, no journal. */
function record(seed: Partial<JobRecord> & { id: string }): JobRecord {
  return {
    state: "succeeded",
    params: { prompt: `prompt for ${seed.id}`, mode: "agent" },
    createdAt: iso(0),
    ...seed,
  };
}

function child(id: string, parentRunId: string, createdAtMs: number): JobRecord {
  return record({
    id: `job-${id}`,
    runId: id,
    createdAt: iso(createdAtMs),
    params: { prompt: `child ${id}`, parentRunId, delegatedFromRunId: parentRunId },
  });
}

/** Command authority over a fixed record set — the projection path under test
 * is the daemon's, not the store's, and this keeps large rosters cheap. */
function staticAuthority(records: readonly JobRecord[]): LegacyCommandAuthority {
  const store = {
    records: () => [...records],
    get: (id: string) => records.find((entry) => entry.id === id),
    prune: () => {},
  } as unknown as CommandStore;
  return { current: () => store };
}

async function withDaemon(
  name: string,
  commands: LegacyCommandAuthority,
  fn: (ctx: { socketPath: string; client: DaemonClient }) => Promise<void>,
): Promise<void> {
  const socketPath = join(tempDir(name), "daemon.sock");
  const server = new DaemonServer({
    socketPath,
    token: TOKEN,
    commands,
    // The roster must survive startup retention: this suite is about reads.
    maxHistory: 100_000,
    runner: async () => ({ lifecycle: "succeeded" }),
  });
  await server.start();
  try {
    await fn({ socketPath, client: new DaemonClient(socketPath, TOKEN) });
  } finally {
    await server.stop();
  }
}

/** One raw RPC round trip returning the daemon's response LINE verbatim, so a
 * test can compare the bytes a caller actually receives. */
function rawRpc(socketPath: string, method: string, params?: unknown): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const sock = connect(socketPath);
    const rl = createInterface({ input: sock });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      rl.close();
      sock.destroy();
      fn();
    };
    sock.on("error", (error) => finish(() => reject(error)));
    sock.on("close", () => finish(() => reject(new Error("daemon closed the socket"))));
    sock.on("connect", () => {
      sock.write(`${JSON.stringify({ id: 1, method, params, token: TOKEN })}\n`);
    });
    rl.on("line", (line) => finish(() => resolve(line)));
  });
}

describe("addressed claudexor.list over the real socket", () => {
  it("addresses one retained command by job id or run id, and reports a miss as absence", async () => {
    const dir = tempDir("ids");
    const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
    const store = new CommandStore(journal, () => new Date(BASE_MS));
    store.recoverAfterStartup();
    const seeds: Array<[string, unknown, Partial<JobRecord>]> = [
      ["job-a", { prompt: "alpha", mode: "agent" }, { state: "succeeded", runId: "run-a" }],
      ["job-b", { prompt: "bravo", mode: "agent" }, { state: "succeeded", runId: "run-b" }],
      // Accepted but never started: it has no runId yet, so the job id is the
      // only handle a caller holds while it waits in the queue.
      ["job-queued", { prompt: "charlie", mode: "agent" }, {}],
      // Retention planes the product list has always excluded.
      ["delivery-x", { prompt: "applied copy", mode: "agent" }, { state: "succeeded" }],
      ["job-model", { kind: "model", prompt: "raw call" }, { state: "succeeded" }],
    ];
    for (const [id, params, patch] of seeds) {
      store.accept({ id, params, idempotencyKey: id, clientId: "test" });
      if (Object.keys(patch).length > 0) store.update(id, patch);
    }

    await withDaemon("ids", { current: () => store }, async ({ client }) => {
      const whole = await client.list({ ids: ["job-a", "job-b", "job-queued"] });
      // Collection projection preserves identities without full prompt bodies.
      expect(whole.map((entry) => entry.id)).toEqual(["job-a", "job-b", "job-queued"]);

      const byJobId = await client.list({ id: "job-a" });
      const byRunId = await client.list({ id: "run-a" });
      // Producer-vs-producer: the addressed record is the SAME projection the
      // whole-list read produces, not a separately synthesized expectation.
      expect(byJobId[0]).toMatchObject({ id: "job-a", params: { prompt: "alpha" } });
      expect(whole[0]).not.toHaveProperty("params.prompt");
      expect(byRunId).toEqual(byJobId);

      expect(await client.list({ id: "job-queued" })).toEqual([
        expect.objectContaining({ id: "job-queued", state: "queued" }),
      ]);
      expect((await client.list({ id: "job-queued" }))[0]).not.toHaveProperty("runId");

      expect(await client.list({ id: "run-missing" })).toEqual([]);
      // Selection happens on the PRODUCT set: an addressed delivery command or
      // model receipt is as absent as it is from the unqualified list.
      expect(await client.list({ id: "delivery-x" })).toEqual([]);
      expect(await client.list({ id: "job-model" })).toEqual([]);
    });
    journal.close();
  });

  it("selects bounded direct Delegate children past a large window of newer unrelated runs", async () => {
    const children = Array.from({ length: 10 }, (_, index) =>
      child(`run-c${index}`, "run-parent", index * 1_000),
    );
    const grandchild = child("run-grandchild", "run-c0", 500);
    const selfEdge = record({
      id: "job-parent-self",
      runId: "run-parent",
      createdAt: iso(-1_000),
      params: { delegatedFromRunId: "run-parent" },
    });
    const duplicateIdentity = { ...children[0]!, id: "job-duplicate", createdAt: iso(50_000) };
    const unrelated = Array.from({ length: 220 }, (_, index) =>
      record({
        id: `job-fill-${index}`,
        runId: `run-fill-${index}`,
        createdAt: iso(100_000 + index),
        params: { prompt: "unrelated", parentRunId: "run-other" },
      }),
    );
    const roster = [
      ...unrelated,
      duplicateIdentity,
      grandchild,
      selfEdge,
      ...[...children].reverse(),
    ];

    await withDaemon("children", staticAuthority(roster), async ({ client }) => {
      const selected = await client.list({ delegatedFromRunId: "run-parent" });
      // Bounded at MAX_DELEGATED_CHILDREN, ordered by createdAt, deduplicated by
      // run identity (the older job wins), and blind to grandchildren, to the
      // malformed self-edge, and to 220 newer unrelated runs.
      expect(selected.map((entry) => entry.runId)).toEqual(
        Array.from({ length: MAX_DELEGATED_CHILDREN }, (_, index) => `run-c${index}`),
      );
      expect(selected[0]!.id).toBe("job-run-c0");
      expect(await client.list({ delegatedFromRunId: "run-c0" })).toEqual([
        expect.objectContaining({ runId: "run-grandchild" }),
      ]);
      expect(await client.list({ delegatedFromRunId: "run-nobody" })).toEqual([]);
      // The parent itself is reachable by id even though it is not its own child.
      expect(await client.list({ id: "run-parent" })).toEqual([
        expect.objectContaining({ id: "job-parent-self" }),
      ]);
    });
  });

  it("breaks a createdAt tie deterministically by run identity, then by job id", async () => {
    const tied = [
      { ...child("run-z", "run-parent", 0), id: "job-z" },
      { ...child("run-a", "run-parent", 0), id: "job-a2" },
      { ...child("run-a", "run-parent", 0), id: "job-a1" },
    ];
    await withDaemon("ties", staticAuthority(tied), async ({ client }) => {
      const forward = await client.list({ delegatedFromRunId: "run-parent" });
      expect(forward.map((entry) => `${entry.runId}:${entry.id}`)).toEqual([
        "run-a:job-a1",
        "run-z:job-z",
      ]);
    });
    await withDaemon("ties-permuted", staticAuthority([...tied].reverse()), async ({ client }) => {
      const reversed = await client.list({ delegatedFromRunId: "run-parent" });
      expect(reversed.map((entry) => `${entry.runId}:${entry.id}`)).toEqual([
        "run-a:job-a1",
        "run-z:job-z",
      ]);
    });
  });

  it("refuses a query that addresses no single subject instead of silently scanning", async () => {
    await withDaemon(
      "strict",
      staticAuthority([record({ id: "job-a", runId: "run-a" })]),
      async ({ client }) => {
        for (const malformed of [
          { id: "run-a", delegatedFromRunId: "run-parent" },
          { runId: "run-a" },
          { id: "" },
        ]) {
          await expect(client.list(malformed as never)).rejects.toMatchObject({
            code: "invalid_command_list_query",
            status: 400,
          });
        }
        // @ts-expect-error An unaddressed call is no longer representable.
        await expect(client.list()).rejects.toMatchObject({ code: "list_query_required" });
        // @ts-expect-error An empty selector is no longer representable.
        await expect(client.list({})).rejects.toMatchObject({ code: "invalid_command_list_query" });
      },
    );
  });
});

describe("addressed reads do no work for unrelated commands", () => {
  it("answers an addressed read with bytes identical to a single-record roster", async () => {
    const target = record({
      id: "job-target",
      runId: "run-target",
      params: { prompt: "the addressed run", mode: "agent" },
    });
    // Production-shaped: the measured install carried ~1.6k retained records
    // whose params were ~98.6% of the serialized list.
    const heavy = Array.from({ length: 1_600 }, (_, index) =>
      record({
        id: `job-heavy-${index}`,
        runId: `run-heavy-${index}`,
        createdAt: iso(index),
        params: { prompt: "x".repeat(1_024), mode: "agent", scope: { kind: "none" } },
      }),
    );

    let alone = "";
    let crowdedWholeList = "";
    let crowdedAddressed = "";
    await withDaemon("oracle-small", staticAuthority([target]), async ({ socketPath }) => {
      alone = await rawRpc(socketPath, "claudexor.list", { query: { id: "run-target" } });
    });
    await withDaemon("oracle-big", staticAuthority([...heavy, target]), async ({ socketPath }) => {
      crowdedAddressed = await rawRpc(socketPath, "claudexor.list", {
        query: { id: "run-target" },
      });
      crowdedWholeList = await rawRpc(socketPath, "claudexor.list", {
        query: { page: { limit: 5, state: null, cursor: null } },
      });
    });

    expect(crowdedAddressed).toBe(alone);
    // Negative control: the same daemon really is holding that payload, so the
    // byte identity above is a property of the read, not of an empty roster.
    expect(Buffer.byteLength(crowdedWholeList)).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(JSON.stringify([...heavy, target]))).toBeGreaterThan(1_600_000);
  });

  it("never traverses the params of a record it did not select", async () => {
    // A getter that throws the moment the recursive redactor reaches it. The
    // metadata scan (`kind`, `delegatedFromRunId`, id equality) is shallow and
    // never fires it; the public projection does.
    const poisoned: JobRecord = {
      id: "job-poison",
      // Non-terminal, so startup retention's byte accounting never reaches it
      // either: the only traversal under test is the read's own.
      state: "running",
      createdAt: iso(10),
      params: {
        mode: "agent",
        request: {
          get prompt(): string {
            throw new Error("unrelated command params were traversed");
          },
        },
      },
    };
    const roster = [
      record({ id: "job-target", runId: "run-target" }),
      child("run-child", "run-target", 20),
      poisoned,
    ];

    await withDaemon("poison", staticAuthority(roster), async ({ client }) => {
      expect(await client.list({ id: "run-target" })).toEqual([
        expect.objectContaining({ id: "job-target" }),
      ]);
      expect(await client.list({ delegatedFromRunId: "run-target" })).toEqual([
        expect.objectContaining({ runId: "run-child" }),
      ]);
      // Negative control: a full addressed read still reaches the poison.
      await expect(client.list({ id: "job-poison" })).rejects.toThrow(
        /unrelated command params were traversed/,
      );
    });
  });
});
