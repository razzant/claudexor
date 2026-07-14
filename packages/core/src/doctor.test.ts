import { describe, expect, it } from "vitest";
import { ConformanceReport } from "@claudexor/schema";
import type { HarnessAdapter } from "./adapter.js";
import { invalidateDoctorCache, runDoctor } from "./doctor.js";

describe("runDoctor fresh probes", () => {
  it("bypasses cache reads and writes without clearing the shared cached report", async () => {
    invalidateDoctorCache();
    let calls = 0;
    const adapter = {
      id: "real-cache-test",
      discover: async () => {
        throw new Error("not used");
      },
      doctor: async () =>
        ConformanceReport.parse({
          harness_id: "real-cache-test",
          status: "ok",
          reasons: [`call-${++calls}`],
        }),
      run: async function* () {
        /* not used */
      },
    } satisfies HarnessAdapter;
    const registry = new Map([[adapter.id, adapter]]);

    const first = await runDoctor(registry, { cwd: "/repo" });
    const cached = await runDoctor(registry, { cwd: "/repo" });
    const fresh = await runDoctor(registry, { cwd: "/repo", fresh: true });
    const cachedAgain = await runDoctor(registry, { cwd: "/repo" });

    expect(first[0]?.reasons).toEqual(["call-1"]);
    expect(cached[0]?.reasons).toEqual(["call-1"]);
    expect(fresh[0]?.reasons).toEqual(["call-2"]);
    expect(cachedAgain[0]?.reasons).toEqual(["call-1"]);
    expect(calls).toBe(2);
  });

  it("separates cache entries by auth source and never caches an abort-bound probe", async () => {
    invalidateDoctorCache();
    let calls = 0;
    const adapter = {
      id: "real-auth-source-cache-test",
      discover: async () => {
        throw new Error("not used");
      },
      doctor: async (spec: { authSource?: string }) =>
        ConformanceReport.parse({
          harness_id: "real-auth-source-cache-test",
          status: "ok",
          reasons: [`${spec.authSource ?? "all"}-${++calls}`],
        }),
      run: async function* () {
        /* not used */
      },
    } satisfies HarnessAdapter;
    const registry = new Map([[adapter.id, adapter]]);

    const native = await runDoctor(registry, { cwd: "/repo", authSource: "native_session" });
    const api = await runDoctor(registry, { cwd: "/repo", authSource: "api_key_env" });
    const controller = new AbortController();
    const abortBound = await runDoctor(registry, {
      cwd: "/repo",
      authSource: "native_session",
      abortSignal: controller.signal,
    });
    const nativeAgain = await runDoctor(registry, { cwd: "/repo", authSource: "native_session" });

    expect(native[0]?.reasons).toEqual(["native_session-1"]);
    expect(api[0]?.reasons).toEqual(["api_key_env-2"]);
    expect(abortBound[0]?.reasons).toEqual(["native_session-3"]);
    expect(nativeAgain[0]?.reasons).toEqual(["native_session-1"]);
    expect(calls).toBe(3);
  });

  it("invalidates every target-adapter variant without evicting unrelated adapters", async () => {
    invalidateDoctorCache();
    const calls = new Map<string, number>();
    const adapter = (id: string): HarnessAdapter => ({
      id,
      discover: async () => {
        throw new Error("not used");
      },
      doctor: async (spec) => {
        const count = (calls.get(id) ?? 0) + 1;
        calls.set(id, count);
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          reasons: [`${spec.authSource ?? "all"}-${count}`],
          auth_sources: spec.authSource
            ? [{ source: spec.authSource, availability: "available", verification: "passed" }]
            : [],
        });
      },
      run: async function* () {
        /* not used */
      },
    });
    const target = adapter("real-scoped-target");
    const unrelated = adapter("real-scoped-unrelated");

    await runDoctor(new Map([[target.id, target]]), { cwd: "/repo", authSource: "native_session" });
    await runDoctor(new Map([[target.id, target]]), { cwd: "/repo", authSource: "api_key_env" });
    await runDoctor(new Map([[unrelated.id, unrelated]]), {
      cwd: "/repo",
      authSource: "native_session",
    });
    expect(calls).toEqual(
      new Map([
        [target.id, 2],
        [unrelated.id, 1],
      ]),
    );

    invalidateDoctorCache({ adapterId: target.id });

    await runDoctor(new Map([[target.id, target]]), { cwd: "/repo", authSource: "native_session" });
    await runDoctor(new Map([[target.id, target]]), { cwd: "/repo", authSource: "api_key_env" });
    await runDoctor(new Map([[unrelated.id, unrelated]]), {
      cwd: "/repo",
      authSource: "native_session",
    });
    expect(calls).toEqual(
      new Map([
        [target.id, 4],
        [unrelated.id, 1],
      ]),
    );
  });

  it("does not let a late target probe repopulate cache after scoped invalidation", async () => {
    invalidateDoctorCache();
    const calls = new Map<string, number>();
    const releases = new Map<string, () => void>();
    const started = new Map<string, Promise<void>>();
    const adapters = ["real-late-target", "real-late-unrelated"].map((id) => {
      let markStarted!: () => void;
      started.set(
        id,
        new Promise<void>((resolve) => {
          markStarted = resolve;
        }),
      );
      const gate = new Promise<void>((resolve) => releases.set(id, resolve));
      return {
        id,
        discover: async () => {
          throw new Error("not used");
        },
        doctor: async () => {
          const count = (calls.get(id) ?? 0) + 1;
          calls.set(id, count);
          if (count === 1) {
            markStarted();
            await gate;
          }
          return ConformanceReport.parse({
            harness_id: id,
            status: "ok",
            reasons: [`call-${count}`],
          });
        },
        run: async function* () {
          /* not used */
        },
      } satisfies HarnessAdapter;
    });
    const target = adapters[0]!;
    const unrelated = adapters[1]!;
    const targetInFlight = runDoctor(new Map([[target.id, target]]), { cwd: "/repo" });
    const unrelatedInFlight = runDoctor(new Map([[unrelated.id, unrelated]]), { cwd: "/repo" });
    await Promise.all([started.get(target.id), started.get(unrelated.id)]);

    invalidateDoctorCache({ adapterId: target.id });
    releases.get(target.id)!();
    releases.get(unrelated.id)!();
    await Promise.all([targetInFlight, unrelatedInFlight]);

    const targetAfter = await runDoctor(new Map([[target.id, target]]), { cwd: "/repo" });
    const unrelatedAfter = await runDoctor(new Map([[unrelated.id, unrelated]]), { cwd: "/repo" });
    expect(targetAfter[0]?.reasons).toEqual(["call-2"]);
    expect(unrelatedAfter[0]?.reasons).toEqual(["call-1"]);
    expect(calls).toEqual(
      new Map([
        [target.id, 2],
        [unrelated.id, 1],
      ]),
    );
  });

  it("keeps an exact failed source probe typed as unknown instead of omitting it", async () => {
    invalidateDoctorCache();
    const adapter = {
      id: "real-failed-exact-source",
      discover: async () => {
        throw new Error("not used");
      },
      doctor: async () => {
        throw new Error("native status transport failed");
      },
      run: async function* () {
        /* not used */
      },
    } satisfies HarnessAdapter;

    const [report] = await runDoctor(new Map([[adapter.id, adapter]]), {
      cwd: "/repo",
      authSource: "native_session",
      fresh: true,
    });

    expect(report).toMatchObject({
      harness_id: adapter.id,
      status: "unavailable",
      auth_sources: [
        {
          source: "native_session",
          availability: "unknown",
          verification: "not_run",
          detail: "native status transport failed",
        },
      ],
    });
  });

  it("redacts adapter error secrets before projecting reasons or exact source detail", async () => {
    invalidateDoctorCache();
    const secret = `ghp_${"s".repeat(36)}`;
    const adapter = {
      id: "real-secret-bearing-failure",
      discover: async () => {
        throw new Error("not used");
      },
      doctor: async () => {
        throw new Error(`vendor rejected credential ${secret}`);
      },
      run: async function* () {
        /* not used */
      },
    } satisfies HarnessAdapter;

    const [report] = await runDoctor(new Map([[adapter.id, adapter]]), {
      cwd: "/repo",
      authSource: "native_session",
      fresh: true,
    });

    expect(report?.reasons).toEqual(["vendor rejected credential [redacted]"]);
    expect(report?.auth_sources).toEqual([
      {
        source: "native_session",
        availability: "unknown",
        verification: "not_run",
        detail: "vendor rejected credential [redacted]",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain(secret);
  });
});
