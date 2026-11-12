import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CredentialProfile, ControlAccountResourcesFreshnessResponse } from "@claudexor/schema";
import { readCursorDashboard } from "@claudexor/harness-cursor";
import { refreshCursorQuota } from "./cursor-quota-source.js";
import { quotaControlServices } from "./quota-services.js";
import { QuotaRegistry, type QuotaRefreshCycle } from "@claudexor/daemon";
import { EngineStore } from "../../daemon/src/store/store.js";
import { SqlEventLedger } from "../../daemon/src/store/event-store.js";
import { BlobFiles } from "../../daemon/src/store/blob-files.js";
import { createPartition, currentGeneration } from "../../daemon/src/store/partitions.js";
import { DaemonControlApiServer } from "../../control-api/src/daemon-server.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

// Offline reproduction of the independent review's real producer/SQL/HTTP falsifiers.
const roots: string[] = [],
  stores: EngineStore[] = [],
  servers: DaemonControlApiServer[] = [];
afterEachClosed(async () => {
  // This test's entries, taken before its closes: a late close or a later test never reaches
  // another test's.
  const ownedRoots = roots.splice(0);
  const ownedStores = stores.splice(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const server of servers.splice(0)) await server.stop();
  for (const store of ownedStores) await store.close();
  return () => {
    for (const root of ownedRoots) rmSync(root, { recursive: true, force: true });
  };
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cursor-pipeline-"));
  roots.push(root);
  let instant = Date.parse("2026-10-15T13:05:00Z");
  const now = () => new Date(instant);
  vi.useFakeTimers({ toFake: ["Date"], now: instant });
  const home = join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", "cursor-fixture");
  mkdirSync(join(home, ".cursor"), { recursive: true });
  const accessToken = `fixture.${Buffer.from(JSON.stringify({ sub: "fixture-subject" })).toString("base64url")}.fixture`;
  writeFileSync(join(home, ".cursor", "auth.json"), JSON.stringify({ accessToken }));
  writeFileSync(
    join(home, ".cursor", "cli-config.json"),
    JSON.stringify({ authInfo: { authId: "fixture-subject" } }),
  );
  const profile = CredentialProfile.parse({
    profile_id: "cursor-fixture",
    display_name: "Fixture",
    harness_id: "cursor",
    credential_kind: "config_dir_login",
    isolation_locator: home,
  });
  const target = { harness: "cursor", profile_id: profile.profile_id };
  const subject = {
    harness: "cursor",
    subject_id: profile.profile_id,
    credential_route: "vendor_native" as const,
    plan_label: null,
  };
  const recorded = JSON.parse(
    readFileSync(new URL("./test-support/cursor-usage-team.json", import.meta.url), "utf8"),
  ).data;
  let response: unknown = recorded;
  let fail429 = false;
  const transport = vi.fn(async () =>
    fail429
      ? new Response("{}", { status: 429, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } }),
  );
  const source = vi.fn((cycle?: QuotaRefreshCycle) =>
    refreshCursorQuota(
      {
        profiles: [profile],
        request: (p) => readCursorDashboard(p, transport as typeof fetch, "darwin"),
        now,
      },
      cycle,
    ),
  );
  const open = async () => {
    const store = await EngineStore.open({
      daemonDir: join(root, "sql"),
      workerEntry: resolve("packages/daemon/dist/store/flusher-worker.js"),
      flusherHooks: { manualTick: true },
      now,
    });
    stores.push(store);
    const gen =
      currentGeneration(store, "global") ??
      store.transaction(() => createPartition(store, "global"));
    const ledger = new SqlEventLedger(store, new BlobFiles(store), gen);
    const registry = new QuotaRegistry(ledger, [{ vendor: "cursor", refresh: source }], now, () => [
      subject,
    ]);
    return { store, registry };
  };
  return {
    now,
    target,
    profile,
    recorded,
    source,
    transport,
    open,
    advance: (ms: number) => {
      instant += ms;
      vi.setSystemTime(instant);
    },
    response: (raw: unknown) => {
      response = raw;
    },
    fail: (value: boolean) => {
      fail429 = value;
    },
  };
}

describe("real Cursor producer to SQL registry and passive HTTP", () => {
  it("retains scoped resources and reactive quota independently across bad body, identity mismatch and restart", async () => {
    const f = await fixture();
    const first = await f.open();
    first.registry.ingest("cursor", {
      type: "error",
      session_id: "fixture",
      ts: f.now().toISOString(),
      credential_profile_id: f.profile.profile_id,
      credential_route: "vendor_native",
      rate_limit: {
        resets_at: "2026-10-16T00:00:00Z",
        constraint_id: "reactive_limit",
        retry_delay_ms: null,
      },
    });
    await first.registry.refreshResources(f.target);
    const original = first.registry.readResources()[0]!;
    expect(original.target).toEqual(f.target);
    expect(original).not.toHaveProperty("subject");
    expect(first.registry.read().snapshots).toHaveLength(1);
    f.advance(1000);
    f.response({ ...f.recorded, billingCycleEnd: "invalid-date" });
    await first.registry.refreshResources(f.target);
    let retained = first.registry.readResources()[0]!;
    expect(retained.balances.value).toEqual(original.balances.value);
    expect(retained.balances.observed_at).toBe(original.balances.observed_at);
    expect(retained.spending.last_error).toBe("invalid_dashboard_period");
    f.advance(1000);
    writeFileSync(
      join(f.profile.isolation_locator!, ".cursor", "cli-config.json"),
      JSON.stringify({ authInfo: { authId: "wrong-identity" } }),
    );
    const calls = f.transport.mock.calls.length;
    await first.registry.refreshResources(f.target);
    retained = first.registry.readResources()[0]!;
    expect(f.transport).toHaveBeenCalledTimes(calls);
    expect(retained.balances.observed_at).toBe(original.balances.observed_at);
    expect(retained.balances.last_error).toBe("cursor_dashboard_credential_binding_unavailable");
    await first.store.close();
    const next = await f.open();
    const seq = currentGeneration(next.store, "global")!.nextSeq;
    const server = new DaemonControlApiServer({
      token: "fixture",
      daemon: {} as never,
      services: quotaControlServices(() => next.registry),
    });
    servers.push(server);
    const { host, port } = await server.start();
    const response = await fetch(
      `http://${host}:${port}/v2/quota?view=resources_freshness&model=some-future-model&requestKind=text`,
      { headers: { Authorization: "Bearer fixture", "X-Claudexor-Protocol-Major": "3" } },
    );
    expect(response.status).toBe(200);
    const body = ControlAccountResourcesFreshnessResponse.parse(await response.json());
    expect(body.availability_scope).toEqual({
      basis: "quota_block",
      model: "some-future-model",
      requestKind: "text",
    });
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0]!.constraints).toHaveLength(1);
    expect(body.snapshots[0]!.availability?.state).not.toBe("available");
    expect(body.resources[0]!.balances).toMatchObject({
      value: original.balances.value,
      observed_at: original.balances.observed_at,
      freshness: "stale",
    });
    expect(currentGeneration(next.store, "global")!.nextSeq).toBe(seq);
    expect(f.transport).toHaveBeenCalledTimes(calls);
    expect(JSON.stringify(body)).not.toContain("fixture-subject");
    expect(JSON.stringify(body)).not.toContain("accessToken");
  });
  it("coalesces a selected Cursor refresh joining a full resource-only refresh", async () => {
    const f = await fixture();
    const { registry } = await f.open();
    await Promise.all([registry.refresh(), registry.refreshResources(f.target)]);
    expect(f.source).toHaveBeenCalledTimes(1);
  });
  it("a successful Cursor refresh resets the no-header 429 ladder", async () => {
    const f = await fixture();
    const { registry } = await f.open();
    f.fail(true);
    await registry.refreshResources(f.target);
    f.advance(61_000);
    f.fail(false);
    await registry.refreshResources(f.target);
    f.advance(301_000);
    f.fail(true);
    await registry.refreshResources(f.target);
    const result = await registry.refreshResources(f.target);
    const floor = result.refresh_skipped?.find(
      (r) => r.subject?.subject_id === f.profile.profile_id,
    )?.not_before;
    expect(floor).toBe(new Date(f.now().getTime() + 60_000).toISOString());
  });
});
