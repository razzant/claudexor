import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { BlobFiles } from "../blob-files.js";
import { Obligations } from "../obligations.js";
import { SqlResourceStore } from "../resources.js";
import { EngineStore } from "../store.js";

export function builtWorker(name: string): string {
  const path = resolve(import.meta.dirname, "../../../dist/store", name);
  if (!existsSync(path)) throw new Error(`build the daemon before this test: ${path}`);
  return path;
}
export async function resourceFixture(
  root: string,
  options: { manualTick?: boolean; now?: () => Date; clear?: boolean } = {},
) {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: builtWorker("flusher-worker.js"),
    flusherHooks: { manualTick: options.manualTick ?? false },
    ...(options.now ? { now: options.now } : {}),
  });
  const blobs = new BlobFiles(store);
  const logs: string[] = [];
  let resources: SqlResourceStore;
  const obligations = new Obligations(store, {
    log: (line) => logs.push(line),
    onCleared: (rows) => {
      if (options.clear !== false) resources.onObligationsCleared(rows);
    },
  });
  resources = new SqlResourceStore(store, blobs, obligations, (line) => logs.push(line));
  return {
    store,
    blobs,
    obligations,
    resources,
    logs,
    async tick() {
      const done = store.flushed();
      store.flusherControl.tick();
      await done;
    },
    async close() {
      obligations.close();
      await store.close();
      await resources.drainCleanup();
    },
  };
}
export type ResourceFixture = Awaited<ReturnType<typeof resourceFixture>>;
export async function* chunks(...bytes: Array<Uint8Array | string>): AsyncIterable<Uint8Array> {
  for (const value of bytes) yield typeof value === "string" ? Buffer.from(value) : value;
}
export const uploadRequest = {
  purpose: "model" as const,
  kind: "file" as const,
  mime: "application/json",
  name: "request.json",
  sizeBytes: 4,
};
export async function uploaded(f: ResourceFixture, key = "create") {
  const status = f.resources.create(uploadRequest, key);
  await f.resources.write(status.uploadId, chunks("test"));
  return status;
}
