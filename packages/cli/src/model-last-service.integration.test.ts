import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelAdapter } from "@claudexor/core";
import { createCodexAdapter, parseCodexRateLimitsResponse } from "@claudexor/harness-codex";
import {
  CredentialProfile,
  GlobalConfig,
  ModelCallRequest,
  ModelCallResult,
  type CredentialProfileStatus,
  type ModelCatalogEntry,
} from "@claudexor/schema";
import { accountObservations } from "./account-observations.js";
import { createSqlDaemonRuntime } from "./sql-daemon-runtime.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

// Production-shaped consumer evidence for the raw-model reader of the durable
// last-served order (INV-135): a real engine store and SQL services graph,
// composed by the SQL runtime exactly as the daemon composes it (model queue,
// in-process client, the shared account resolver). Only the model source (its
// catalog and one completed reply per call) and the account probe are offline
// fakes. A service fact is seeded through the store's own writer, as an Agent
// or Ask try leaves it; model operations read it and never write one.

const MODEL = "test-model";

beforeEach(() => accountObservations.invalidate());
const cleanups: Array<() => Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

function entry(id: string): ModelCatalogEntry {
  return {
    id,
    label: null,
    isDefault: id === MODEL,
    contextWindow: 272000,
    maxContextWindow: 872000,
    maxOutputTokens: null,
    inputModalities: ["text"],
    reasoningEfforts: ["medium"],
    defaultReasoningEffort: "medium",
    supportedOptions: [],
  };
}

/** Two ready managed codex rows `a`/`b` with unknown headroom, no pin, binding or mark. */
async function daemon() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-mls-")));
  const sql = await sqlFixture(root);
  const profiles = ["a", "b"].map((id) =>
    CredentialProfile.parse({
      profile_id: id,
      harness_id: "codex",
      display_name: id,
      credential_kind: "config_dir_login",
      isolation_locator: join(root, id),
    }),
  );
  const cfg = GlobalConfig.parse({ credential_profiles: profiles });
  // The model each account's reply discloses; absent = the requested one.
  const served: Record<string, string> = {};
  const probe = async (profile: CredentialProfile): Promise<CredentialProfileStatus> => ({
    profile_id: profile.profile_id,
    harness_id: profile.harness_id,
    availability: "available",
    verification: "passed",
    verification_source: "local_store",
    detail: "test profile ready",
    last_verified_at: null,
  });
  const catalog = vi.fn<ModelAdapter["catalog"]>(async ({ profile }) => ({
    source: "codex",
    credentialProfileId: profile.profile_id,
    accountFingerprint: profile.profile_id,
    observedAt: new Date().toISOString(),
    provenance: "fixture exact catalog",
    sourceProgram: null,
    clientVersion: "0.156.1",
    clientVersionSource: "verified_transport",
    models: [entry(MODEL), entry("other-model")],
  }));
  const invoke = vi.fn<ModelAdapter["invoke"]>(async (request, context) => {
    const id = context.profile.profile_id;
    const route = {
      source: "codex",
      credentialProfileId: id,
      accountFingerprint: id,
      model: request.model,
    };
    await context.onDispatch(route);
    return ModelCallResult.parse({
      outcome: "completed",
      message: { role: "assistant", content: `reply from ${id}` },
      route: { ...route, model: served[id] ?? request.model },
      usage: { input_tokens: 5, output_tokens: 3 },
      cost: {
        knowledge: "unknown",
        billing: "unknown",
        source: "fixture",
        provenance: ["fixture"],
      },
      appliedOptions: {},
      problem: null,
    });
  });
  const runtime = createSqlDaemonRuntime(sql.graph, {
    server: { socketPath: join(root, "unused.sock"), token: "fixture" },
    authReadiness: () => ({ invalidate: () => {} }),
    models: {
      config: () => cfg,
      migrationGate: () => null,
      registry: new Map([["codex", { ...createCodexAdapter(), probeCredentialProfile: probe }]]),
      sources: [
        { adapter: { id: "codex", catalog, invoke }, label: "Codex", credentialHarness: "codex" },
      ],
    },
  });
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(async () => {
    await runtime.stop();
    await sql.close();
  });
  const routes = runtime.models.routes;
  /** One raw-model call through the daemon's queue: the account its reply came from. */
  const call = async (account: ModelCallRequest["account"], model = MODEL) => {
    const request = ModelCallRequest.parse({
      source: "codex",
      model,
      account,
      messages: [{ role: "user", content: "ping" }],
    });
    const ref = sql.graph.resources.publishModel(Buffer.from(JSON.stringify(request)));
    const { id } = await routes.createModelOperation(ref, randomUUID());
    // Dispatch waits on the store's durable barrier (one flusher pass).
    await vi.waitFor(
      async () =>
        expect(["queued", "running"]).not.toContain((await routes.getModelOperation(id)).state),
      { timeout: 10_000 },
    );
    const read = await routes.readModelResult(id);
    const result = ModelCallResult.parse(JSON.parse(read.bytes.toString()));
    expect(result.outcome).toBe("completed");
    return result.route.credentialProfileId;
  };
  const services = sql.graph.accounts.services!;
  return {
    sql,
    served,
    invoke,
    call,
    /** Every durable service fact, as the store holds it. */
    facts: () => sql.store.prepare("SELECT * FROM account_last_service ORDER BY service_seq").all(),
    /** A served try of an earlier Agent run on this row, through the store's own writer. */
    serve: (id: string) =>
      services.serve(
        profiles.find((profile) => profile.profile_id === id)!,
        MODEL,
        {
          runId: "run-agent-earlier",
          attemptId: "a01",
          tryIndex: 0,
        },
      ),
  };
}
type Daemon = Awaited<ReturnType<typeof daemon>>;

describe("raw-model Auto reads the store graph's last-served order (INV-135)", () => {
  it("prefers the row that last served the requested model and records no service", async () => {
    const f = await daemon();
    f.serve("b");
    const before = f.facts();
    expect(before).toHaveLength(1);
    expect(await f.call({ mode: "auto" })).toBe("b");
    expect(f.invoke.mock.calls.map(([, context]) => context.profile.profile_id)).toEqual(["b"]);
    // The order is per requested model: another model's tie keeps the profile-id order.
    expect(await f.call({ mode: "auto" }, "other-model")).toBe("a");
    expect(f.facts()).toEqual(before);
  });

  it("never outranks a pin or a usable preferred row, while it still orders Auto", async () => {
    const f = await daemon();
    f.serve("b");
    const before = f.facts();
    expect(await f.call({ mode: "pin", profileId: "a" })).toBe("a");
    expect(await f.call({ mode: "auto", preferredProfileId: "a" })).toBe("a");
    expect(await f.call({ mode: "auto" })).toBe("b");
    expect(f.facts()).toEqual(before);
  });

  const superiors: Array<[string, (f: Daemon) => unknown]> = [
    [
      "known headroom on the other row",
      (f) => {
        const resetsAt = Math.floor(Date.now() / 1000) + 3600;
        const response = {
          rateLimitsByLimitId: {
            codex: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt } },
          },
        };
        for (const row of parseCodexRateLimitsResponse(response, new Date(), "a"))
          f.sql.graph.quota.upsert(row);
      },
    ],
    [
      "a cooldown on the served row",
      (f) =>
        f.sql.graph.quota.ingest("codex", {
          type: "error",
          ts: new Date().toISOString(),
          session_id: "quota",
          credential_profile_id: "b",
          credential_route: "vendor_native",
          rate_limit: {
            resets_at: new Date(Date.now() + 60_000).toISOString(),
            retry_delay_ms: null,
          },
        }),
    ],
    [
      "the served row's model-substitution mark",
      async (f) => {
        // The model path's own mark: b answered this request with another model.
        f.served.b = "substituted-model";
        expect(await f.call({ mode: "pin", profileId: "b" })).toBe("b");
      },
    ],
  ];
  it.each(superiors)("never outranks %s", async (_label, arrange) => {
    const f = await daemon();
    f.serve("b");
    const before = f.facts();
    await arrange(f);
    expect(await f.call({ mode: "auto" })).toBe("a");
    expect(f.facts()).toEqual(before);
  });
});
