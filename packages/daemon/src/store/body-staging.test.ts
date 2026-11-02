import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonServer, type JobRecord } from "@claudexor/daemon";
import { ControlRunStartRequest, RunProcessScopeOutcome } from "@claudexor/schema";
import { processTiming } from "@claudexor/util";
import { settleDeferredPredecessor } from "./test-support/deferred-terminal.js";
import { sqlFixture } from "./test-support/sql-fixture.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Real SQL owners where every external write reports whether it wrote bytes:
 * with each sample treated as slow, the store logs every write's receipt. */
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-body-staging-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const f = await sqlFixture(root);
  cleanup.push(() => f.close());
  vi.spyOn(processTiming, "recordSync").mockReturnValue(true);
  const log = vi.spyOn(f.store, "logSlowWrite");
  /** The synchronous body writes so far: `written` is false when it adopted a staged file. */
  const bodies = () =>
    log.mock.calls
      .map(([line]) => JSON.parse(String(line).slice("store.external_write ".length)))
      .filter((write: { purpose: string }) => write.purpose === "blob_body") as Array<{
      bytes: number;
      written: boolean;
    }>;
  const server = (options: Partial<ConstructorParameters<typeof DaemonServer>[0]> = {}) => {
    const daemon = new DaemonServer({
      socketPath: join(root, "unused.sock"),
      token: "test",
      commands: f.graph.commands,
      runner: async () => ({}),
      ...options,
    });
    cleanup.push(() => daemon.stop());
    return daemon;
  };
  return { ...f, root, bodies, server };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("large bodies are written off the request thread before their synchronous owner", () => {
  it("stages an enqueued acceptance and the run's returned result; the commits only adopt them", async () => {
    const f = await fixture();
    const prompt = "p".repeat(80_000);
    const output = "o".repeat(80_000);
    const daemon = f.server({ runner: async () => ({ lifecycle: "succeeded", output }) });
    const accepted = (await daemon.dispatch("claudexor.enqueue", {
      request: ControlRunStartRequest.parse({ mode: "ask", prompt }),
      clientId: "test",
      idempotencyKey: "large",
    })) as { id: string };
    const status = async () =>
      (await daemon.dispatch("claudexor.status", { id: accepted.id })) as JobRecord;
    await vi.waitFor(async () => expect((await status()).state).toBe("succeeded"));
    const record = await status();
    expect((record.params as { prompt: string }).prompt).toBe(prompt);
    expect((record.result as { output: string }).output).toBe(output);
    // Params, the accepted event, the result and the updated event: all staged.
    expect(f.bodies().length).toBeGreaterThanOrEqual(4);
    expect(f.bodies().filter((write) => write.written)).toEqual([]);
  });

  it("stages a large turn prompt before the turn commits", async () => {
    const f = await fixture();
    const thread = f.graph.threads.createThread({});
    const prompt = "t".repeat(80_000);
    await f.graph.threads.stageTurnPrompt(thread.id, prompt);
    const turn = f.graph.threads.createTurn(thread.id, prompt);
    expect(f.graph.threads.turnsFor(thread.id).map((row) => row.id)).toContain(turn.id);
    expect(f.bodies()).toEqual([expect.objectContaining({ bytes: 80_000, written: false })]);
  });

  it("stages a large deferred draft after its capture and before the draft commits", async () => {
    const f = await fixture();
    const start = ControlRunStartRequest.parse({ mode: "ask", prompt: "first" });
    f.graph.commands
      .current()
      .accept({ id: "job-1", params: start, clientId: "test", idempotencyKey: "first" });
    const daemon = f.server({
      deferredStart: () => ({ capture: async () => start, validate: async () => {} }),
    });
    const before = f.bodies().length;
    await daemon.dispatch("claudexor.deferredMessage", {
      request: {
        action: "create",
        predecessorId: "job-1",
        prompt: "d".repeat(80_000),
        attachments: [],
      },
      idempotencyKey: "draft",
    });
    const draft = f.bodies().slice(before);
    expect(draft.length).toBeGreaterThan(0);
    expect(draft.filter((write) => write.written)).toEqual([]);
  });

  it("stages a promoted draft's acceptance before the promotion commits", async () => {
    const f = await fixture();
    const commands = f.graph.commands.current();
    const start = ControlRunStartRequest.parse({ mode: "ask", prompt: "first" });
    commands.accept({ id: "job-1", params: start, clientId: "test", idempotencyKey: "first" });
    const runDir = join(f.root, "run-1");
    mkdirSync(join(runDir, "final"), { recursive: true });
    // The predecessor's settled process custody, which promotion requires.
    writeFileSync(
      join(runDir, "final/process_scope.yaml"),
      JSON.stringify(
        RunProcessScopeOutcome.parse({
          marker: "CLAUDEXOR_SCOPE_0123456789abcdef0123456789abcdef",
          coverage: "marker+capture",
          census: "ok",
          settled: true,
          incomplete: false,
          survivors: [],
          unreadable: [],
          completeness: "not_provable",
        }),
      ),
    );
    // The fixture's store is the built package's; the helper is typed from source.
    settleDeferredPredecessor(commands as never, "job-1", runDir);
    const daemon = f.server({
      deferredStart: () => ({ capture: async () => start, validate: async () => {} }),
    });
    const before = f.bodies().length;
    // The predecessor is already terminal: creating the draft promotes it at once.
    const result = (await daemon.dispatch("claudexor.deferredMessage", {
      request: {
        action: "create",
        predecessorId: "job-1",
        prompt: "p".repeat(80_000),
        attachments: [],
      },
      idempotencyKey: "draft",
    })) as { draft: { state: string } };
    expect(result.draft, JSON.stringify(result.draft)).toMatchObject({ state: "dispatched" });
    // The draft, then the successor's parameters and its acceptance record.
    const writes = f.bodies().slice(before);
    expect(writes.length).toBeGreaterThanOrEqual(3);
    expect(writes.filter((write) => write.written)).toEqual([]);
  });

  it("lets the blob GC take a staged body only while nothing owns it; its owner then writes it", async () => {
    const f = await fixture();
    const commands = f.graph.commands.current();
    const accept = (id: string, prompt: string) =>
      commands.accept({
        id,
        params: { mode: "ask", prompt },
        clientId: "test",
        idempotencyKey: id,
      });
    const body = (prompt: string) => Buffer.from(JSON.stringify({ mode: "ask", prompt }));

    // Unowned: the GC may remove the staged file, and the owner writes it again.
    const early = "e".repeat(80_000);
    await f.graph.blobs.stageBody(body(early));
    expect(existsSync(f.graph.blobs.filePath(sha256(body(early))))).toBe(true);
    expect(await f.graph.blobs.gc(sha256(body(early)))).toBe("removed");
    accept("job-early", early);
    expect((commands.get("job-early")!.params as { prompt: string }).prompt).toBe(early);
    const params = (prompt: string) =>
      f.bodies().filter((write) => write.bytes === body(prompt).byteLength);
    expect(params(early)).toEqual([expect.objectContaining({ written: true })]);

    // Owned first: the GC keeps the adopted file.
    const late = "l".repeat(81_000);
    await f.graph.blobs.stageBody(body(late));
    accept("job-late", late);
    expect(params(late)).toEqual([expect.objectContaining({ written: false })]);
    expect(await f.graph.blobs.gc(sha256(body(late)))).toBe("owned");
    expect((commands.get("job-late")!.params as { prompt: string }).prompt).toBe(late);
  });
});
