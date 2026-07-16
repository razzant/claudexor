import { describe, expect, it } from "vitest";
import { ConformanceReport, HarnessManifest } from "@claudexor/schema";
import type { HarnessAdapter } from "@claudexor/core";
import { HarnessGateway } from "./gateway.js";

describe("HarnessGateway auth readiness projection", () => {
  it("projects doctor auth_sources without inferring readiness from the manifest", async () => {
    const adapter = {
      id: "fake-auth-projection",
      discover: async () =>
        HarnessManifest.parse({
          id: "fake-auth-projection",
          display_name: "Fake auth projection",
          kind: "fake",
          provider_family: "unknown",
          auth_modes: ["local_session", "api_key"],
        }),
      doctor: async () =>
        ConformanceReport.parse({
          harness_id: "fake-auth-projection",
          status: "degraded",
          auth_sources: [
            { source: "native_session", availability: "unknown", verification: "not_run" },
            { source: "api_key_env", availability: "available", verification: "failed" },
          ],
        }),
      run: async function* () {
        /* not used */
      },
    } satisfies HarnessAdapter;

    const rows = await new HarnessGateway(new Map([[adapter.id, adapter]])).statusAll({
      cwd: "/repo",
    });
    expect(rows[0]?.authSources).toEqual([
      { source: "native_session", availability: "unknown", verification: "not_run" },
      { source: "api_key_env", availability: "available", verification: "failed" },
    ]);
  });

  it("routableIntents is EMPTY for a degraded harness and doctor-gated for an ok one (W_readiness)", async () => {
    const make = (id: string, status: "ok" | "degraded"): HarnessAdapter =>
      ({
        id,
        discover: async () =>
          HarnessManifest.parse({
            id,
            display_name: id,
            kind: "fake",
            provider_family: "unknown",
            capabilities: { implement: true, ask: true },
          }),
        doctor: async () =>
          ConformanceReport.parse({
            harness_id: id,
            status,
            enabled_intents: ["implement", "explain"],
          }),
        run: async function* () {
          /* not used */
        },
      }) satisfies HarnessAdapter;

    const rows = await new HarnessGateway(
      new Map([
        ["ok-lane", make("ok-lane", "ok")],
        ["degraded-lane", make("degraded-lane", "degraded")],
      ]),
    ).statusAll({ cwd: "/repo" });
    const ok = rows.find((r) => r.id === "ok-lane");
    const degraded = rows.find((r) => r.id === "degraded-lane");
    // ok: routable mirrors the doctor-enabled intents.
    expect(ok?.routableIntents.length).toBeGreaterThan(0);
    expect(ok?.routableIntents).toEqual(ok?.enabledIntents);
    // degraded: intents may be declared/enabled, but NOTHING routes (incl. write intents).
    expect(degraded?.routableIntents).toEqual([]);
  });

  it("targets one harness/source without calling discover or unrelated adapters", async () => {
    const seen: Array<{ source?: string; fresh?: boolean }> = [];
    const target = {
      id: "fake-targeted-auth",
      discover: async () => {
        throw new Error("discover must not run");
      },
      doctor: async (spec) => {
        seen.push({ source: spec.authSource, fresh: spec.fresh });
        return ConformanceReport.parse({
          harness_id: "fake-targeted-auth",
          status: "ok",
          auth_sources: [
            { source: "native_session", availability: "available", verification: "passed" },
          ],
        });
      },
      run: async function* () {
        /* not used */
      },
    } satisfies HarnessAdapter;
    let unrelatedCalls = 0;
    const unrelated = {
      ...target,
      id: "fake-unrelated-auth",
      doctor: async () => {
        unrelatedCalls += 1;
        return ConformanceReport.parse({ harness_id: "fake-unrelated-auth", status: "ok" });
      },
    } satisfies HarnessAdapter;
    const gateway = new HarnessGateway(
      new Map([
        [target.id, target],
        [unrelated.id, unrelated],
      ]),
    );

    await expect(
      gateway.probeAuthSource(target.id, "native_session", {
        cwd: "/repo",
        fresh: true,
      }),
    ).resolves.toEqual({
      source: "native_session",
      availability: "available",
      verification: "passed",
    });
    expect(seen).toEqual([{ source: "native_session", fresh: true }]);
    expect(unrelatedCalls).toBe(0);
  });
});
