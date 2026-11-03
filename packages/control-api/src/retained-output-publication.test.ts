import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { RETAINED_OUTPUT_PATH } from "@claudexor/event-log";
import { BulkExecutor } from "./bulk-executor.js";
import type { WorkerRequest } from "./bulk-protocol.js";
import { RetainedOutputPublisher } from "./retained-output.js";

const state = vi.hoisted(() => ({
  afterWrite: null as (() => Promise<void>) | null,
  afterCleanup: null as (() => void) | null,
  failedPath: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await actual.writeFile(...args);
      if (String(args[0]).includes(".retained-output-")) await state.afterWrite?.();
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await actual.rm(...args);
      if (String(args[0]).includes(".retained-output-")) state.afterCleanup?.();
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (String(args[0]) === state.failedPath)
        throw Object.assign(new Error("EPERM: injected publication guard failure"), {
          code: "EPERM",
        });
      return actual.lstatSync(...args);
    },
  };
});

describe("main-owned retained output publication", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cx-retained-publication-"));
    mkdirSync(join(root, "final"));
  });
  afterEach(() => {
    state.afterWrite = null;
    state.afterCleanup = null;
    state.failedPath = null;
    rmSync(root, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  it("lets an atomic publication finish after Stop without waiting for it or exposing a partial result", async () => {
    const text = "Recovered bytes: αβ🙂\n".repeat(100);
    const bytes = new TextEncoder().encode(text);
    let entered!: () => void;
    let release!: () => void;
    let completed!: () => void;
    const written = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      completed = resolve;
    });
    state.afterWrite = async () => {
      entered();
      await gate;
    };
    state.afterCleanup = completed;
    class PublicationWorker extends EventEmitter {
      ref() {}
      unref() {}
      terminate = vi.fn(async () => 0);
      postMessage(message: WorkerRequest) {
        if (message.type === "run")
          queueMicrotask(() => {
            this.emit("message", { type: "publish-retained", id: message.id, bytes });
          });
      }
    }
    const worker = new PublicationWorker();
    const executor = new BulkExecutor(() => worker as unknown as Worker);
    const record = { id: "r", state: "interrupted", runDir: root };
    const result = executor
      .execute({
        kind: "detail",
        input: { record, cursor: 0, pending: [], operator: null, children: [] },
      })
      .catch((error: unknown) => error);
    try {
      await written;
      expect(existsSync(join(root, RETAINED_OUTPUT_PATH))).toBe(false);
      expect(readdirSync(join(root, "final"))).toHaveLength(1);
      executor.stop();
      expect(await result).toMatchObject({ code: "daemon_stopping", status: 503 });
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(existsSync(join(root, RETAINED_OUTPUT_PATH))).toBe(false);
    } finally {
      release();
      executor.stop();
      await finished;
    }
    expect(readFileSync(join(root, RETAINED_OUTPUT_PATH), "utf8")).toBe(text);
    expect(readdirSync(join(root, "final"))).toEqual(["retained-output.md"]);
  });

  it("settles a filesystem guard failure as a diagnostic and permits a later healthy publication", async () => {
    const publisher = new RetainedOutputPublisher();
    const record = { id: "r", state: "interrupted", runDir: root };
    const bytes = new TextEncoder().encode("retained\n");
    state.failedPath = root;
    expect(await publisher.publish(record, bytes)).toContain("could not be materialized");
    state.failedPath = null;
    expect(await publisher.publish(record, bytes)).toBeNull();
    expect(readFileSync(join(root, RETAINED_OUTPUT_PATH), "utf8")).toBe("retained\n");
  });

  it.skipIf(process.platform === "win32")(
    "publishes retained bytes with owner-only permissions",
    async () => {
      const publisher = new RetainedOutputPublisher();
      const bytes = new TextEncoder().encode("private retained output\n");
      expect(
        await publisher.publish({ id: "r", state: "interrupted", runDir: root }, bytes),
      ).toBeNull();
      const path = join(root, RETAINED_OUTPUT_PATH);
      expect(readFileSync(path)).toEqual(Buffer.from(bytes));
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );
});
