import { beforeEach, describe, expect, it } from "vitest";
import { invalidateDoctorCache, type DoctorSpec, type HarnessAdapter } from "@claudexor/core";
import { ConformanceReport, HarnessManifest } from "@claudexor/schema";
import { AuthReadinessService } from "./auth-readiness.js";
import { HarnessGateway } from "./gateway.js";

const CWD = "/daemon/no-project";

function manifest(id: string) {
  return HarnessManifest.parse({
    id,
    display_name: id,
    kind: "local_cli",
    provider_family: "unknown",
    auth_modes: ["local_session"],
  });
}

beforeEach(() => invalidateDoctorCache());

describe("AuthReadinessService", () => {
  it("refreshes exactly one harness/source without discovery or unrelated probes", async () => {
    const seen: DoctorSpec[] = [];
    const target = {
      id: "real-exact-auth-target",
      discover: async () => {
        throw new Error("exact refresh must not discover");
      },
      doctor: async (spec) => {
        seen.push(spec);
        return ConformanceReport.parse({
          harness_id: "real-exact-auth-target",
          status: "ok",
          auth_sources: [
            {
              source: "native_session",
              availability: "available",
              verification: "passed",
            },
          ],
        });
      },
      run: async function* () {
        /* not used */
      },
    } satisfies HarnessAdapter;
    let unrelatedDiscoverCalls = 0;
    let unrelatedDoctorCalls = 0;
    const unrelated = {
      id: "real-exact-auth-unrelated",
      discover: async () => {
        unrelatedDiscoverCalls += 1;
        return manifest("real-exact-auth-unrelated");
      },
      doctor: async () => {
        unrelatedDoctorCalls += 1;
        return ConformanceReport.parse({ harness_id: "real-exact-auth-unrelated", status: "ok" });
      },
      run: async function* () {
        /* not used */
      },
    } satisfies HarnessAdapter;
    const gateway = new HarnessGateway(
      new Map<string, HarnessAdapter>([
        [target.id, target],
        [unrelated.id, unrelated],
      ]),
    );
    const service = new AuthReadinessService(gateway, {
      cwd: CWD,
      now: () => new Date("2026-07-14T12:00:00.000Z"),
    });

    await expect(
      service.refresh(target.id, {
        authRequest: "subscription",
        source: "native_session",
      }),
    ).resolves.toEqual({
      harnessId: target.id,
      authRequest: "subscription",
      requestedSource: "native_session",
      observedAt: "2026-07-14T12:00:00.000Z",
      readiness: {
        source: "native_session",
        availability: "available",
        verification: "passed",
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      cwd: CWD,
      fresh: true,
      authPreference: "subscription",
      authSource: "native_session",
    });
    expect(unrelatedDiscoverCalls).toBe(0);
    expect(unrelatedDoctorCalls).toBe(0);
  });

  it("invalidates stale aggregate evidence only for the refreshed harness", async () => {
    const projectCwd = "/project/using-global-login";
    const calls = new Map<string, number>();
    const adapter = (id: string): HarnessAdapter => ({
      id,
      discover: async () => manifest(id),
      doctor: async (spec) => {
        calls.set(id, (calls.get(id) ?? 0) + 1);
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          auth_sources: spec.authSource
            ? [{ source: spec.authSource, availability: "available", verification: "passed" }]
            : [],
        });
      },
      run: async function* () {
        /* not used */
      },
    });
    const target = adapter("real-refresh-cache-target");
    const unrelated = adapter("real-refresh-cache-unrelated");
    const gateway = new HarnessGateway(
      new Map([
        [target.id, target],
        [unrelated.id, unrelated],
      ]),
    );
    const service = new AuthReadinessService(gateway, { cwd: CWD });

    await gateway.statusAll({ cwd: projectCwd });
    await service.refresh(target.id, { authRequest: "subscription", source: "native_session" });
    await gateway.statusAll({ cwd: projectCwd });

    expect(calls).toEqual(
      new Map([
        [target.id, 3], // aggregate before, exact refresh, aggregate after invalidation
        [unrelated.id, 1], // second aggregate read remains cached
      ]),
    );
  });

  it("preserves an exact adapter failure as typed unknown source evidence", async () => {
    const adapter = {
      id: "real-exact-auth-failure",
      discover: async () => manifest("real-exact-auth-failure"),
      doctor: async () => {
        throw new Error("vendor status transport failed");
      },
      run: async function* () {
        /* not used */
      },
    } satisfies HarnessAdapter;
    const service = new AuthReadinessService(new HarnessGateway(new Map([[adapter.id, adapter]])), {
      cwd: CWD,
    });

    await expect(
      service.refresh(adapter.id, {
        authRequest: "subscription",
        source: "native_session",
      }),
    ).resolves.toMatchObject({
      harnessId: adapter.id,
      requestedSource: "native_session",
      readiness: {
        source: "native_session",
        availability: "unknown",
        verification: "not_run",
        detail: "vendor status transport failed",
      },
    });
  });

  it("fails closed when a harness omits the requested source evidence", async () => {
    const adapter = {
      id: "real-missing-auth-source",
      discover: async () => manifest("real-missing-auth-source"),
      doctor: async () =>
        ConformanceReport.parse({
          harness_id: "real-missing-auth-source",
          status: "degraded",
          auth_sources: [
            { source: "api_key_env", availability: "available", verification: "passed" },
          ],
        }),
      run: async function* () {
        /* not used */
      },
    } satisfies HarnessAdapter;
    const service = new AuthReadinessService(new HarnessGateway(new Map([[adapter.id, adapter]])), {
      cwd: CWD,
    });

    await expect(
      service.refresh(adapter.id, {
        authRequest: "subscription",
        source: "native_session",
      }),
    ).rejects.toMatchObject({
      name: "AuthReadinessServiceError",
      code: "auth_source_evidence_missing",
      status: 502,
      retryable: false,
      requiredActions: ["inspect_harness_doctor"],
    });
  });

  it("rejects an unknown harness before probing", async () => {
    const service = new AuthReadinessService(new HarnessGateway(new Map()), { cwd: CWD });

    await expect(
      service.refresh("missing-harness", {
        authRequest: "subscription",
        source: "native_session",
      }),
    ).rejects.toMatchObject({
      name: "AuthReadinessServiceError",
      code: "unknown_harness",
      status: 404,
      retryable: false,
      requiredActions: ["refresh_harness_catalog"],
    });
  });

  it("requires a stable absolute no-project root", () => {
    expect(
      () => new AuthReadinessService(new HarnessGateway(new Map()), { cwd: "relative" }),
    ).toThrow(/cwd must be absolute/);
  });
});
