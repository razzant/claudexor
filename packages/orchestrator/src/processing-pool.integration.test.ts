import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HarnessAdapter, PreparedHarnessProcessing } from "@claudexor/core";
import { ConformanceReport, HarnessManifest } from "@claudexor/schema";
import { Orchestrator } from "./orchestrator.js";

const roots: string[] = [];
afterEach(
  () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  0,
); // synchronous removal: no deadline (#376, see vitest.setup.ts)

it("prepares actual mode-qualified costs before pool ranking and width selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudexor-processing-pool-"));
  roots.push(root);
  writeFileSync(
    join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml"),
    "routing:\n  paid_fallback: when_unavailable\n",
  );
  const launches: string[] = [];
  const adapter = (id: string, paid: boolean) => {
    const prepareProcessing = vi.fn(async (): Promise<PreparedHarnessProcessing> => ({
      model: null,
      receipt: {
        requested: "fast",
        submitted: paid ? "fast" : "standard",
        submittedNative: paid ? "fast" : "standard",
        observed: "unknown",
        observedNative: [],
        reason: paid ? null : "not_available",
        source: "fixture",
      },
      costBasis: {
        nativeMode: paid ? "fast" : "standard",
        kind: paid ? "paid_credits" : "included",
        source: "fixture",
      },
    }));
    const harness: HarnessAdapter = {
      id,
      prepareProcessing,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: "local",
          capabilities: { implement: true, repair: true },
          auth_modes: ["local_session"],
          access_profiles_supported: ["workspace_write"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          enabled_intents: ["implement", "repair"],
          auth_sources: [
            { source: "native_session", availability: "available", verification: "passed" },
          ],
        });
      },
      async *run(spec) {
        launches.push(id);
        const ts = new Date().toISOString();
        yield {
          type: "started",
          ts,
          session_id: spec.session_id,
          credential_route: "vendor_native",
        };
        writeFileSync(join(spec.cwd, "result.txt"), id);
        yield {
          type: "file_change",
          ts,
          session_id: spec.session_id,
          payload: { path: "result.txt" },
        };
        yield {
          type: "message",
          ts,
          session_id: spec.session_id,
          text: "Prepared output",
          final: true,
        };
        yield { type: "completed", ts, session_id: spec.session_id };
      },
    };
    return { harness, prepareProcessing };
  };
  const premium = adapter("premium", true),
    ordinary = adapter("ordinary", false);
  const result = await new Orchestrator({
    registry: new Map([
      [premium.harness.id, premium.harness],
      [ordinary.harness.id, ordinary.harness],
    ]),
  }).run({
    repoRoot: root,
    workspaceKind: "directory",
    inPlace: true,
    prompt: "Prepare output",
    harnesses: ["premium", "ordinary"],
    n: 1,
    review: false,
    processingPreference: "fast",
    authPreference: "subscription",
    paidBudget: { kind: "finite", maxUsd: 2 },
  });
  expect(result.facts.lifecycle).toBe("succeeded");
  expect(premium.prepareProcessing).toHaveBeenCalledTimes(1);
  expect(ordinary.prepareProcessing).toHaveBeenCalled();
  expect(launches).toEqual(["ordinary"]);
});
