import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { updateGlobalConfig } from "@claudexor/config";
import { QuotaRegistry } from "@claudexor/daemon";
import { SecretStore } from "@claudexor/secrets";
import {
  ControlAccountResourcesFreshnessResponse,
  ControlAccountResourcesResponse,
  CredentialProfile,
} from "@claudexor/schema";
import { EngineStore } from "../../daemon/src/store/store.js";
import { SqlEventLedger } from "../../daemon/src/store/event-store.js";
import { BlobFiles } from "../../daemon/src/store/blob-files.js";
import { createPartition, currentGeneration } from "../../daemon/src/store/partitions.js";
import { DaemonControlApiServer } from "../../control-api/src/daemon-server.js";
import { quotaRefreshers } from "./quota-refreshers.js";
import { quotaControlServices } from "./quota-services.js";
import { quotaSubjectUniverseFromConfig } from "./quota-subject-universe.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

// Offline: synthetic keys in the temp secret store, a localhost stand-in for
// OpenRouter's GET /api/v1/key, the real SQL ledger, registry and HTTP routes.
const DEFAULT_KEY = "fixture-openrouter-default-1";
const REPLACED_KEY = "fixture-openrouter-default-2";
const WORK_KEY = "fixture-openrouter-work";
const OFF_KEY = "fixture-openrouter-off";
const roots: string[] = [];
const stores: EngineStore[] = [];
const servers: Array<{ stop(): Promise<void> }> = [];
const savedEnv = { ...process.env };
afterEachClosed(async () => {
  // This test's entries, taken before its closes: a late close or a later test never reaches
  // another test's.
  const ownedRoots = roots.splice(0);
  const ownedStores = stores.splice(0);
  vi.useRealTimers();
  for (const server of servers.splice(0)) await server.stop();
  for (const store of ownedStores) await store.close();
  return () => {
    for (const root of ownedRoots) rmSync(root, { recursive: true, force: true });
    for (const name of ["CLAUDEXOR_OPENROUTER_BASE_URL", "OPENROUTER_API_KEY"])
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
  };
});

// Every figure is a literal the provider would send; the fixture does no arithmetic.
const keyBody = (limit: number | null, remaining: number | null, monthly: number) => ({
  data: {
    label: "sk-or-v1-syn...000",
    limit,
    limit_remaining: remaining,
    limit_reset: limit === null ? null : "monthly",
    include_byok_in_limit: false,
    usage: monthly + 100,
    usage_daily: 1,
    usage_weekly: 2,
    usage_monthly: monthly,
    budgets:
      limit === null
        ? []
        : [
            {
              scope: "key_limit",
              guardrail_id: null,
              budget_id: null,
              limit_usd: limit,
              spend_usd: monthly,
              remaining_usd: remaining,
              reset_interval: "monthly",
              resets_at: "2026-11-01T00:00:00Z",
              include_byok: false,
            },
          ],
  },
});

async function fakeOpenRouter() {
  const requests: string[] = [];
  const answers = new Map<string, { status: number; body: unknown }>([
    [DEFAULT_KEY, { status: 200, body: keyBody(50, 37.66, 12.34) }],
    [REPLACED_KEY, { status: 200, body: keyBody(10, 0, 10) }],
    // limit 50, remaining 37.66, monthly spend 12.34 are independent literals.
    [WORK_KEY, { status: 200, body: keyBody(null, null, 3.5) }],
    [OFF_KEY, { status: 200, body: keyBody(5, 5, 0) }],
  ]);
  const server: Server = createServer((req, res) => {
    const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    requests.push(`${req.method} ${req.url} ${key}`);
    const answer = req.url === "/api/v1/key" ? answers.get(key) : undefined;
    res.statusCode = answer?.status ?? 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(answer?.body ?? { error: { code: 404 } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push({ stop: () => new Promise<void>((done) => server.close(() => done())) });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  process.env.CLAUDEXOR_OPENROUTER_BASE_URL = `http://127.0.0.1:${address.port}/api/v1`;
  return { requests, answers };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openrouter-key-allowance-"));
  roots.push(root);
  delete process.env.OPENROUTER_API_KEY;
  const provider = await fakeOpenRouter();
  const secrets = new SecretStore();
  secrets.set("openrouter", DEFAULT_KEY);
  secrets.set("openrouter:work", WORK_KEY);
  secrets.set("openrouter:off", OFF_KEY);
  const row = (profile_id: string, enabled: boolean) =>
    CredentialProfile.parse({
      profile_id,
      harness_id: "openrouter",
      display_name: profile_id,
      credential_kind: "api_key",
      secret_ref: `openrouter:${profile_id}`,
      enabled,
    });
  updateGlobalConfig((config) => ({
    ...config,
    credential_profiles: [row("work", true), row("off", false)],
  }));
  let instant = Date.parse("2026-10-29T08:00:00Z");
  vi.useFakeTimers({ toFake: ["Date"], now: instant });
  const now = () => new Date(instant);
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
    // The production registration, alone: no other vendor is probed offline.
    const registry = new QuotaRegistry(
      new SqlEventLedger(store, new BlobFiles(store), gen),
      quotaRefreshers().filter((refresher) => refresher.vendor === "openrouter"),
      now,
      quotaSubjectUniverseFromConfig,
    );
    const server = new DaemonControlApiServer({
      token: "fixture",
      daemon: {} as never,
      services: quotaControlServices(() => registry),
    });
    servers.push(server);
    const { host, port } = await server.start();
    const call = (path: string, body?: unknown) =>
      fetch(`http://${host}:${port}/v2${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: "Bearer fixture",
          "X-Claudexor-Protocol-Major": "3",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { registry, call };
  };
  return {
    ...provider,
    secrets,
    open,
    advance: (ms: number) => {
      instant += ms;
      vi.setSystemTime(instant);
    },
  };
}

const rows = async (response: Response) => {
  expect(response.status).toBe(200);
  return ControlAccountResourcesResponse.parse(await response.json()).resources;
};
const keyRow = (resources: Awaited<ReturnType<typeof rows>>, profileId: string | null) =>
  resources.find(
    (row) => row.target.harness === "openrouter" && row.target.profile_id === profileId,
  );

describe("OpenRouter key allowance through the real registry, SQL ledger and control API", () => {
  it("publishes each key requests can send, bound to that key, only to negotiating clients", async () => {
    const f = await fixture();
    const { registry, call } = await f.open();

    // Strict legacy clients: no API-key row, no new field, before or after a read.
    expect(await rows(await call("/quota?view=resources"))).toEqual([]);

    // Negotiated, never read: one row per current key, every facet unknown.
    const unread = await rows(await call("/quota?view=resources&includeApiKeys=true"));
    expect(unread.map((row) => row.target)).toEqual([
      { harness: "openrouter", profile_id: null },
      { harness: "openrouter", profile_id: "work" },
    ]);
    expect(unread.every((row) => row.spending.freshness === "unknown")).toBe(true);
    expect(f.requests).toEqual([]);

    // Full explicit refresh: one free key read per current key, no generation.
    const refreshed = await rows(await call("/quota?view=resources&includeApiKeys=true", {}));
    expect(f.requests.sort()).toEqual([
      `GET /api/v1/key ${DEFAULT_KEY}`,
      `GET /api/v1/key ${WORK_KEY}`,
    ]);
    expect(keyRow(refreshed, null)?.spending).toMatchObject({
      source: "openrouter_key",
      freshness: "fresh",
      value: [
        expect.objectContaining({
          capped: true,
          limit: "50",
          remaining: "37.66",
          used: "12.34",
          window: "month",
          resets_at: "2026-11-01T00:00:00.000Z",
        }),
      ],
    });
    expect(keyRow(refreshed, "work")?.spending.value?.[0]).toMatchObject({
      capped: false,
      limit: null,
      remaining: null,
      used: "3.5",
    });
    expect(keyRow(refreshed, "off")).toBeUndefined();
    expect(JSON.stringify(refreshed)).not.toContain("sk-or-v1");
    for (const key of [DEFAULT_KEY, REPLACED_KEY, WORK_KEY, OFF_KEY]) {
      expect(JSON.stringify(refreshed)).not.toContain(key);
    }
    // Resource-only: no quota window, absence or routing evidence for the keys.
    expect(registry.read().snapshots).toEqual([]);
    expect(JSON.stringify(registry.read())).not.toContain("openrouter");
    expect(await rows(await call("/quota?view=resources"))).toEqual([]);

    // The passive negotiated freshness view carries the same rows.
    const passive = await call("/quota?view=resources_freshness&includeApiKeys=true");
    const freshness = ControlAccountResourcesFreshnessResponse.parse(await passive.json());
    expect(keyRow(freshness.resources, null)?.spending.value?.[0]?.remaining).toBe("37.66");

    // Exact default-route refresh reads only the default key.
    f.requests.length = 0;
    f.advance(60_000);
    const exact = await call("/quota?view=resources&includeApiKeys=true", {
      target: { harness: "openrouter", profile_id: null },
    });
    expect(exact.status).toBe(200);
    expect(f.requests).toEqual([`GET /api/v1/key ${DEFAULT_KEY}`]);

    // A failed read keeps the same key's figures, marked stale with the cause.
    f.answers.set(WORK_KEY, { status: 500, body: { error: { message: `echo ${WORK_KEY}` } } });
    f.advance(60_000);
    const failed = await rows(
      await call("/quota?view=resources&includeApiKeys=true", {
        target: { harness: "openrouter", profile_id: "work" },
      }),
    );
    expect(keyRow(failed, "work")?.spending).toMatchObject({
      freshness: "stale",
      last_error: "http_status_500",
      value: [expect.objectContaining({ used: "3.5" })],
    });
    expect(JSON.stringify(failed)).not.toContain(WORK_KEY);

    // Replacing the default key never shows the previous key's numbers.
    f.secrets.set("openrouter", REPLACED_KEY);
    const replaced = keyRow(
      await rows(await call("/quota?view=resources&includeApiKeys=true")),
      null,
    );
    expect(replaced?.credential_fingerprint).not.toBe(
      keyRow(refreshed, null)?.credential_fingerprint,
    );
    expect(replaced?.spending).toMatchObject({ value: null, freshness: "unknown" });
    const reread = await rows(
      await call("/quota?view=resources&includeApiKeys=true", {
        target: { harness: "openrouter", profile_id: null },
      }),
    );
    expect(keyRow(reread, null)?.spending.value?.[0]).toMatchObject({
      limit: "10",
      remaining: "0",
    });

    // A removed default key has no row; registered keys keep theirs.
    f.secrets.delete("openrouter");
    const missing = await rows(await call("/quota?view=resources&includeApiKeys=true"));
    expect(keyRow(missing, null)).toBeUndefined();
    expect(keyRow(missing, "work")).toBeDefined();

    // Refusals: undeclared negotiation, a key that is not current, a disabled row.
    expect(
      (await call("/quota?view=resources", { target: { harness: "openrouter", profile_id: null } }))
        .status,
    ).toBe(400);
    for (const profile_id of [null, "off"])
      expect(
        (
          await call("/quota?view=resources&includeApiKeys=true", {
            target: { harness: "openrouter", profile_id },
          })
        ).status,
      ).toBe(404);
    expect((await call("/quota?includeApiKeys=true")).status).toBe(400);
    expect(f.requests.some((line) => line.includes("chat/completions"))).toBe(false);
  });

  it("replays the bound rows after a restart and never attaches them to a new key", async () => {
    const f = await fixture();
    const first = await f.open();
    await first.call("/quota?view=resources&includeApiKeys=true", {});
    const before = keyRow(
      await rows(await first.call("/quota?view=resources&includeApiKeys=true")),
      null,
    );
    expect(before?.spending.value?.[0]?.remaining).toBe("37.66");
    for (const store of stores.splice(0)) await store.close();
    const second = await f.open();
    const after = keyRow(
      await rows(await second.call("/quota?view=resources&includeApiKeys=true")),
      null,
    );
    expect(after?.credential_fingerprint).toBe(before?.credential_fingerprint);
    expect(after?.spending.value).toEqual(before?.spending.value);
    // Changed between runs (e.g. the key variable): the old row is withheld.
    process.env.OPENROUTER_API_KEY = REPLACED_KEY;
    const swapped = keyRow(
      await rows(await second.call("/quota?view=resources&includeApiKeys=true")),
      null,
    );
    expect(swapped?.spending).toMatchObject({ value: null, freshness: "unknown" });
  });
});
