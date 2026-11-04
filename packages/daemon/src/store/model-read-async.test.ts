import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ModelCallRequest, type ModelPayloadRef } from "@claudexor/schema";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";
import { readModelPayload } from "../model-operation-execution.js";
import type { ModelPayloadStore } from "../model-operations.js";
import { resourceFixture, type ResourceFixture } from "./test-support/resource-fixture.js";

const hold = vi.hoisted(() => ({
  path: "",
  release: null as null | (() => void),
  entered: null as null | (() => void),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (hold.path && String(args[0]) === hold.path) {
        hold.entered?.();
        await new Promise<void>((resolve) => {
          hold.release = resolve;
        });
      }
      return actual.readFile(...args);
    },
  };
});

const roots: string[] = [];
const fixtures: ResourceFixture[] = [];
async function open(): Promise<ResourceFixture> {
  const path = mkdtempSync(join(tmpdir(), "cx-model-read-"));
  roots.push(path);
  const opened = await resourceFixture(path);
  fixtures.push(opened);
  return opened;
}
afterEachClosed(async () => {
  const ownedRoots = roots.splice(0);
  hold.release?.();
  hold.path = "";
  hold.release = null;
  hold.entered = null;
  for (const opened of fixtures.splice(0)) await opened.close();
  return () => {
    for (const path of ownedRoots) rmSync(path, { recursive: true, force: true });
  };
});

describe("model request bytes leave the request thread", () => {
  it("answers while readModelAsync is still in the pool, and still checks the bytes", async () => {
    const f = await open();
    const body = Buffer.from('{"source":"codex","model":"m","messages":[]}');
    const ref = f.resources.publishModel(body);
    hold.path = f.blobs.filePath(ref.sha256.slice(7));
    let settled = false;
    const entered = new Promise<void>((resolve) => {
      hold.entered = resolve;
    });
    const reading = f.resources.readModelAsync(ref).finally(() => {
      settled = true;
    });
    const outcome = await Promise.race([
      entered.then(() => "entered" as const),
      reading.then(
        () => "done" as const,
        () => "failed" as const,
      ),
    ]);
    expect(outcome).toBe("entered");
    expect(settled).toBe(false);
    hold.release?.();
    expect(await reading).toEqual(body);
    expect(f.resources.readModel(ref)).toEqual(body);
    hold.path = "";
    writeFileSync(f.blobs.filePath(ref.sha256.slice(7)), Buffer.from("tampered"));
    await expect(f.resources.readModelAsync(ref)).rejects.toMatchObject({
      code: "resource_digest_mismatch",
    });
    expect(() => f.resources.readModel(ref)).toThrow(
      expect.objectContaining({ code: "resource_digest_mismatch" }),
    );
    rmSync(f.blobs.filePath(ref.sha256.slice(7)));
    await expect(f.resources.readModelAsync(ref)).rejects.toMatchObject({
      code: "resource_unavailable",
    });
  });

  it("keeps the synchronous payload parser on readModel", () => {
    const body = ModelCallRequest.parse({
      source: "codex",
      model: "test-model",
      account: { mode: "pin", profileId: "fixture" },
      messages: [{ role: "system", content: "own conversation" }],
    });
    const ref = {
      resourceId: "res_sync",
      sha256: "sha256:" + "ab".repeat(32),
      sizeBytes: 1,
    } satisfies ModelPayloadRef;
    const unused = (): never => {
      throw new Error("the result parser only reads");
    };
    const store: ModelPayloadStore = {
      readModel: () => Buffer.from(JSON.stringify(body)),
      readModelAsync: () => Promise.reject(new Error("result parse must stay synchronous")),
      publishModel: unused,
      releaseModel: unused,
      expireModel: unused,
      listModelResources: unused,
    };
    expect(readModelPayload(store, ref, ModelCallRequest, "ModelCallRequest")).toEqual(body);
  });
});
