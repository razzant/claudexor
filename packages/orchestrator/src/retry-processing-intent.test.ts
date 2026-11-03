import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { ProcessingReceipt } from "@claudexor/schema";
import { recordProcessingIntent, retryProcessingIntent } from "./retry-processing-intent.js";

const roots: string[] = [];
afterEach(
  () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  0,
); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const receipt = (native: string | null, source = "codex.managed_config"): ProcessingReceipt => ({
  requested: null,
  submitted: native === "fast" || native === "priority" ? "fast" : native ? "standard" : null,
  submittedNative: native,
  observed: "unknown",
  observedNative: [],
  reason: null,
  source,
});

function run() {
  const root = mkdtempSync(join(tmpdir(), "retry-intent-"));
  roots.push(root);
  const store = new ArtifactStore(root);
  const paths = store.runPaths("run");
  return { store, runDir: paths.root, contextDir: paths.contextDir };
}

describe("frozen routing-time processing intent", () => {
  it("keeps each harness's first routing and only adds newly routed harnesses", () => {
    const { store, runDir, contextDir } = run();
    recordProcessingIntent(store, contextDir, { codex: receipt("fast") });
    // A later routing in the same run (fallback, another strategy phase) and a
    // later spawn's own receipt never replace the earliest selection.
    recordProcessingIntent(store, contextDir, {
      codex: receipt("default", "codex.service_tier"),
      claude: receipt(null, "claude.settings"),
    });
    expect(retryProcessingIntent(store, runDir)).toEqual({
      codex: receipt("fast"),
      claude: receipt(null, "claude.settings"),
    });
  });

  it("yields nothing without a valid record", () => {
    const { store, runDir, contextDir } = run();
    expect(retryProcessingIntent(store, runDir)).toBeUndefined();
    recordProcessingIntent(store, contextDir, {});
    expect(retryProcessingIntent(store, runDir)).toBeUndefined();
    store.writeYaml(join(contextDir, "processing_intent.yaml"), { schema_version: 9 });
    expect(retryProcessingIntent(store, runDir)).toBeUndefined();
  });
});
