import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableJournal } from "../../daemon/src/store/test-support/fixtures/legacy/journal/index.js";
import { QuotaRegistry } from "@claudexor/daemon";
import type { CredentialExecutionObserverFactory } from "@claudexor/core";
import type { HarnessEvent } from "@claudexor/schema";
import { buildRunOrchestrator, credentialUnusableLedger } from "./run-orchestrator.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  credentialUnusableLedger.noteCredentialChange();
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-intake-")));
  const journal = new DurableJournal({ rootDir: root, partition: "global" });
  const quota = new QuotaRegistry(journal);
  cleanup.push(() => {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
  const orchestrator = buildRunOrchestrator({
    p: {} as Parameters<typeof buildRunOrchestrator>[0]["p"],
    delegationBudgetAuthority: undefined,
    quotaStore: () => quota,
  });
  const factory = (
    orchestrator as unknown as {
      deps: { credentialObserverFactory: CredentialExecutionObserverFactory };
    }
  ).deps.credentialObserverFactory;
  return { quota, factory };
}

const cooldown = (route: "vendor_native" | "managed_api_key"): HarnessEvent => ({
  type: "status",
  session_id: "fixture",
  ts: new Date().toISOString(),
  credential_route: route,
  rate_limit: { resets_at: new Date(Date.now() + 60_000).toISOString(), retry_delay_ms: null },
});

describe("daemon native account observation composition", () => {
  it("retains default/API cooldowns and named windows without a synthetic null-profile stamp", () => {
    const { quota, factory } = fixture();
    for (const profileId of [null, "work"]) {
      const observer = factory({
        harnessId: "claude",
        profileId,
        route: "managed_api_key",
        requestedModel: null,
      });
      observer.observe(cooldown("managed_api_key"));
      observer.finish();
    }
    expect(quota.read().snapshots.map((row) => row.subject)).toEqual([
      {
        harness: "claude",
        credential_route: "managed_api_key",
        subject_id: null,
        plan_label: null,
      },
      {
        harness: "claude",
        credential_route: "managed_api_key",
        subject_id: "work",
        plan_label: null,
      },
    ]);
  });

  it("keeps running-session quota through an unrelated login while refusing stale authentication proof", () => {
    const { quota, factory } = fixture();
    const observer = factory({
      harnessId: "cursor",
      profileId: "work",
      route: "vendor_native",
      requestedModel: "model-a",
    });
    credentialUnusableLedger.noteCredentialChange();
    observer.observe(cooldown("vendor_native"));
    observer.observe({
      ...cooldown("vendor_native"),
      rate_limit: undefined,
      status: { kind: "api_retry", error_category: "authentication_failed" },
    });
    observer.observe({
      type: "completed",
      session_id: "fixture",
      ts: new Date().toISOString(),
      payload: { exit_code: 1 },
    });
    observer.finish();
    expect(quota.read().snapshots).toMatchObject([
      { subject: { harness: "cursor", subject_id: "work" } },
    ]);
    expect(credentialUnusableLedger.live()).toEqual([]);
    expect(credentialUnusableLedger.honored()).toEqual([]);
  });

  it("rejects foreign event identity while preserving the bound profile", () => {
    const { quota, factory } = fixture();
    const observer = factory({
      harnessId: "claude",
      profileId: "work",
      route: "vendor_native",
      requestedModel: null,
    });
    observer.observe({ ...cooldown("vendor_native"), credential_profile_id: "other" });
    observer.observe(cooldown("managed_api_key"));
    expect(quota.read().snapshots).toEqual([]);
    observer.observe(cooldown("vendor_native"));
    expect(quota.read().snapshots).toMatchObject([
      { subject: { subject_id: "work", credential_route: "vendor_native" } },
    ]);
  });
});
