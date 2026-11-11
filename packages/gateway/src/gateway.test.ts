import { describe, expect, it } from "vitest";
import { ConformanceReport, HarnessManifest } from "@claudexor/schema";
import type { HarnessAdapter } from "@claudexor/core";
import { HarnessGateway } from "./gateway.js";

describe("HarnessGateway auth readiness projection", () => {
  it("projects Accounts identity from the rich doctor without a second doctor probe", async () => {
    let genericDoctorCalls = 0;
    let accountDoctorCalls = 0;
    let plainDoctorCalls = 0;
    let richDiscoverCalls = 0;
    let plainDiscoverCalls = 0;
    const report = ConformanceReport.parse({
      harness_id: "fake-rich-account",
      status: "ok",
      enabled_intents: ["explain"],
    });
    const rich = {
      id: "fake-rich-account",
      discover: async () => {
        richDiscoverCalls += 1;
        return HarnessManifest.parse({
          id: "fake-rich-account",
          display_name: "Rich account",
          kind: "fake",
          provider_family: "unknown",
          capabilities: { ask: true },
        });
      },
      doctor: async () => {
        genericDoctorCalls += 1;
        return report;
      },
      doctorForAccounts: async () => {
        accountDoctorCalls += 1;
        return { report, identity: { email: "cursor@example.test" } };
      },
      run: async function* () {
        /* not used */
      },
    } satisfies HarnessAdapter;
    const plain = {
      id: "fake-plain-account",
      discover: async () => {
        plainDiscoverCalls += 1;
        return HarnessManifest.parse({
          id: "fake-plain-account",
          display_name: "Plain account",
          kind: "fake",
          provider_family: "unknown",
          capabilities: { ask: true },
        });
      },
      doctor: async () => {
        plainDoctorCalls += 1;
        return ConformanceReport.parse({
          harness_id: "fake-plain-account",
          status: "unavailable",
        });
      },
      run: rich.run,
    } satisfies HarnessAdapter;

    const rows = await new HarnessGateway(
      new Map([
        [rich.id, rich],
        [plain.id, plain],
      ]),
    ).statusAllForAccounts({ cwd: "/repo", fresh: true });

    expect(genericDoctorCalls).toBe(0);
    expect(accountDoctorCalls).toBe(1);
    expect(plainDoctorCalls).toBe(1);
    expect(richDiscoverCalls).toBe(1);
    expect(plainDiscoverCalls).toBe(1);
    expect(rows.find((row) => row.status.id === rich.id)?.identity).toEqual({
      email: "cursor@example.test",
    });
    expect(rows.find((row) => row.status.id === plain.id)?.identity).toBeNull();
    expect(rows[0]?.status).not.toHaveProperty("identity");
  });

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

  it("routableIntents (Auto eligibility) is EMPTY for a degraded harness and doctor-gated for an ok one (W_readiness)", async () => {
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
    // degraded: intents stay enabled for explicit selection, but nothing routes
    // automatically (incl. write intents).
    expect(degraded?.routableIntents).toEqual([]);
  });

  it("a degraded route keeps its doctor-enabled intents and reasons for explicit selection, never for Auto (#133)", async () => {
    // Raw-API shape: a remote route that cannot read files, key present but
    // unsmoked, whose doctor still enables the roles it can serve.
    const remote = {
      id: "remote-degraded",
      discover: async () =>
        HarnessManifest.parse({
          id: "remote-degraded",
          display_name: "Remote",
          kind: "remote_api",
          provider_family: "unknown",
          capabilities: {
            plan: true,
            implement: true,
            implementation_transport: "git_patch_envelope",
            review: true,
            synthesize: true,
            read_files: false,
          },
          access_profiles_supported: ["readonly"],
        }),
      doctor: async () =>
        ConformanceReport.parse({
          harness_id: "remote-degraded",
          status: "degraded",
          enabled_intents: ["implement", "plan", "spec", "review", "synthesize", "explain"],
          disabled_intents: ["create_from_scratch", "repair", "verify", "audit"],
          reasons: ["key present but route unproven (no isolated smoke)"],
        }),
      run: async function* () {
        /* not used */
      },
    } satisfies HarnessAdapter;
    const [row] = await new HarnessGateway(new Map([[remote.id, remote]])).statusAll({
      cwd: "/repo",
    });
    expect(row?.status).toBe("degraded");
    expect(row?.available).toBe(true);
    // Explicit selection: every doctor-enabled role, Ask included without read_files.
    expect(row?.enabledIntents).toEqual([
      "plan",
      "spec",
      "implement",
      "review",
      "synthesize",
      "explain",
    ]);
    expect(row?.reasons).toEqual(["key present but route unproven (no isolated smoke)"]);
    // Auto pool: never.
    expect(row?.routableIntents).toEqual([]);
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
