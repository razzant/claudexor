import { describe, expect, it } from "vitest";
import {
  CATALOG_HOLD_MS,
  STATUS_PROJECTION_TTL_MS,
  StatusProjectionCache,
  invalidateStatusProjections,
} from "./status-projection-cache.js";

describe("status projection cache (daemon poll-surface load fix, 2026-08-04)", () => {
  it("serves the cached value inside the TTL and recomputes after it", async () => {
    let nowMs = 0;
    let computes = 0;
    const cache = new StatusProjectionCache<number>({ now: () => nowMs });
    const compute = async () => ++computes;
    expect(await cache.read(compute)).toBe(1);
    // A 5s UI poll inside the TTL must not pay another sweep.
    nowMs += 5_000;
    expect(await cache.read(compute)).toBe(1);
    nowMs += STATUS_PROJECTION_TTL_MS;
    expect(await cache.read(compute)).toBe(2);
  });

  it("coalesces concurrent readers into one in-flight compute", async () => {
    let computes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const cache = new StatusProjectionCache<number>();
    const compute = async () => {
      computes += 1;
      await gate;
      return computes;
    };
    const [a, b, c] = [cache.read(compute), cache.read(compute), cache.read(compute)];
    release();
    expect(await Promise.all([a, b, c])).toEqual([1, 1, 1]);
    expect(computes).toBe(1);
  });

  it("a failed compute does not poison the cache", async () => {
    const cache = new StatusProjectionCache<number>();
    await expect(cache.read(async () => Promise.reject(new Error("sweep died")))).rejects.toThrow(
      "sweep died",
    );
    expect(await cache.read(async () => 7)).toBe(7);
  });

  it("fresh bypasses the TTL and re-primes; invalidation forces the next read to compute", async () => {
    let nowMs = 0;
    let computes = 0;
    const cache = new StatusProjectionCache<number>({ now: () => nowMs });
    const compute = async () => ++computes;
    expect(await cache.read(compute)).toBe(1);
    expect(await cache.read(compute, { fresh: true })).toBe(2);
    expect(await cache.read(compute)).toBe(2);
    // A login/logout invalidates every registered projection at once.
    invalidateStatusProjections();
    expect(await cache.read(compute)).toBe(3);
  });

  it("a version change is an invalidation: config-derived facts never lag the TTL", async () => {
    // The failing gate pin (control-services-profile-update F1) proved this
    // live: a raw updateGlobalConfig write (the Enabled toggle) flowed through
    // no service-layer hook, and a whole-response TTL cache served the
    // pre-mutation projection. The cache now validates a cheap version stamp
    // (the global config file identity) on every read.
    let version = "v1";
    let computes = 0;
    const cache = new StatusProjectionCache<number>({ versionOf: () => version });
    const compute = async () => ++computes;
    expect(await cache.read(compute)).toBe(1);
    expect(await cache.read(compute)).toBe(1);
    version = "v2";
    expect(await cache.read(compute)).toBe(2);
    expect(await cache.read(compute)).toBe(2);
  });

  it("a version change during an in-flight compute never labels pre-change data as current (FF-1)", async () => {
    let version = "v1";
    let computes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const cache = new StatusProjectionCache<string>({ versionOf: () => version });
    const slow = async () => {
      computes += 1;
      await gate;
      return `slow-${computes}`;
    };
    const first = cache.read(slow);
    version = "v2"; // the config write lands mid-computation
    // A reader arriving after the change must not join the v1 in-flight.
    const second = cache.read(async () => "fresh-v2");
    release();
    expect(await first).toBe("slow-1");
    expect(await second).toBe("fresh-v2");
    // The v1 result was stamped with its CAPTURED version, so a v2 read never
    // serves it as current.
    expect(await cache.read(async () => "recomputed-v2")).toBe("fresh-v2");
  });

  it("an invalidation during an in-flight compute keeps that result out of the cache", async () => {
    let computes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const cache = new StatusProjectionCache<number>();
    const slow = async () => {
      computes += 1;
      await gate;
      return computes;
    };
    const first = cache.read(slow);
    // The mutation lands while the pre-mutation sweep is still running.
    invalidateStatusProjections();
    release();
    expect(await first).toBe(1);
    // The stale in-flight result must not have primed the cache.
    expect(await cache.read(async () => ++computes)).toBe(2);
  });
});

describe("a held window answers past the TTL while one recompute refreshes (2026-11-14)", () => {
  const held = (nowMs: { at: number }, version = () => "v") =>
    new StatusProjectionCache<number>({
      now: () => nowMs.at,
      versionOf: version,
      holdMs: CATALOG_HOLD_MS,
    });
  const gated = () => {
    let computes = 0;
    let release!: () => void;
    let gate = new Promise<void>((resolve) => (release = resolve));
    return {
      computes: () => computes,
      release: () => release(),
      rearm: () => (gate = new Promise<void>((resolve) => (release = resolve))),
      compute: async () => {
        computes += 1;
        const mine = computes;
        await gate;
        return mine;
      },
    };
  };

  it("answers the held value at once and runs one recompute for every reader past the TTL", async () => {
    const clock = { at: 0 };
    const cache = held(clock);
    const sweep = gated();
    sweep.release();
    expect(await cache.read(sweep.compute)).toBe(1);
    sweep.rearm();
    clock.at += STATUS_PROJECTION_TTL_MS;
    // Three readers after a quiet spell: none waits, one recompute runs.
    expect(await Promise.all([1, 2, 3].map(() => cache.read(sweep.compute)))).toEqual([1, 1, 1]);
    expect(sweep.computes()).toBe(2);
    sweep.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await cache.read(sweep.compute)).toBe(2);
    expect(sweep.computes()).toBe(2);
  });

  it("past TTL + hold the reader waits for the recompute, as without a hold", async () => {
    const clock = { at: 0 };
    const cache = held(clock);
    let computes = 0;
    expect(await cache.read(async () => ++computes)).toBe(1);
    clock.at += STATUS_PROJECTION_TTL_MS + CATALOG_HOLD_MS;
    expect(await cache.read(async () => ++computes)).toBe(2);
    // No read, no sweep: time alone starts nothing.
    clock.at += 10 * CATALOG_HOLD_MS;
    expect(computes).toBe(2);
  });

  it("a failed held recompute keeps the value and its time, rejects nowhere, and the next read retries", async () => {
    const clock = { at: 0 };
    const cache = held(clock);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      expect(await cache.read(async () => 1)).toBe(1);
      clock.at += STATUS_PROJECTION_TTL_MS;
      expect(await cache.read(async () => Promise.reject(new Error("sweep died")))).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      // Inside the span the failure dropped nothing: the held value answers and
      // this read starts the one retry.
      let retries = 0;
      expect(
        await cache.read(async () => {
          retries += 1;
          return Promise.reject(new Error("sweep died again"));
        }),
      ).toBe(1);
      expect(retries).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      // The held value still counts from its own composition, so the window ends on time.
      clock.at += CATALOG_HOLD_MS;
      let computes = 0;
      expect(await cache.read(async () => 10 + ++computes)).toBe(11);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("an invalidation, a version change and a fresh read are never answered from the held value", async () => {
    const clock = { at: 0 };
    let version = "v1";
    const cache = held(clock, () => version);
    let computes = 0;
    const compute = async () => ++computes;
    expect(await cache.read(compute)).toBe(1);
    clock.at += STATUS_PROJECTION_TTL_MS;
    invalidateStatusProjections();
    expect(await cache.read(compute)).toBe(2);
    clock.at += STATUS_PROJECTION_TTL_MS;
    version = "v2";
    expect(await cache.read(compute)).toBe(3);
    clock.at += STATUS_PROJECTION_TTL_MS;
    expect(await cache.read(compute, { fresh: true })).toBe(4);
  });
});
