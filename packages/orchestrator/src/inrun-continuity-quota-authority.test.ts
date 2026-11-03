/**
 * #457: an in-run rotation decides on the quota authority's CURRENT
 * projection, not on an array captured when the attempt began. The authority
 * is a real QuotaRegistry; only `Date` is faked, so the registry's clock-aging
 * and the rotation predicates' reset checks read the same controlled clock.
 * The account script is offline; no vendor is called.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, QuotaConstraint } from "@claudexor/schema";
import { DurableJournal } from "../../daemon/src/store/test-support/fixtures/legacy/journal/index.js";
import { QuotaRegistry } from "../../daemon/src/quota-registry.js";
import { limit, run, seedSession } from "./inrun-continuity.test-support.js";

const HOUR = 3_600_000;
let t0 = 0;
const roots: string[] = [];

beforeEach(() => {
  t0 = Date.now();
  vi.useFakeTimers({ toFake: ["Date"], now: t0 });
});
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

const at = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();

function authority(): QuotaRegistry {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-457-quota-")));
  roots.push(root);
  return new QuotaRegistry(
    new DurableJournal({ rootDir: root, partition: "global" }),
    [],
    () => new Date(),
  );
}

function window(id: string, used: number, resetsInMs: number, seconds: number): QuotaConstraint {
  return {
    id,
    label: id,
    used_ratio: used,
    window_seconds: seconds,
    resets_at: at(resetsInMs),
    cooldown_until: null,
  };
}

function observe(quota: QuotaRegistry, profile: string, constraints: QuotaConstraint[]): void {
  quota.upsert({
    subject: {
      harness: "fake",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: profile,
    },
    constraints,
    source: "claude_oauth_usage",
    observed_at: new Date().toISOString(),
    freshness: "fresh",
  });
}

/** Progress on the current account, then its typed vendor limit. */
function* progressThenLimit(
  emit: (ev: Partial<HarnessEvent>) => HarnessEvent,
  cwd: string,
  profile: string,
): Generator<HarnessEvent> {
  seedSession(cwd, profile, "sid-457");
  yield emit({ type: "started", payload: { native_session_id: "sid-457" } });
  yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
  yield* limit(emit, at(4 * HOUR));
}

function* answer(emit: (ev: Partial<HarnessEvent>) => HarnessEvent): Generator<HarnessEvent> {
  yield emit({ type: "started", payload: { native_session_id: "sid-457" } });
  yield emit({ type: "message", text: "continued", final: true });
  yield emit({ type: "completed" });
}

const exhausted = (o: Awaited<ReturnType<typeof run>>) =>
  o.events.find((e) => e.type === "route.profile.rotation_exhausted")?.payload as
    { candidates: Array<Record<string, unknown>> } | undefined;

describe("in-run rotation reads the current quota authority (#457)", () => {
  it("a short window that reset while candidate readiness was probed no longer excludes the account", async () => {
    const quota = authority();
    observe(quota, "b", [window("five_hour", 1, 60_000, 18_000)]);
    let limited = false;
    const o = await run({
      mode: "ask",
      profiles: ["a", "b"],
      deps: { quotaSnapshots: () => quota.read().snapshots },
      onProbe: () => {
        if (limited) vi.setSystemTime(t0 + 120_000);
      },
      script: function* ({ profile, emit, spec }) {
        if (profile === "a") {
          limited = true;
          yield* progressThenLimit(emit, spec.cwd, "a");
          return;
        }
        yield* answer(emit);
      },
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(o.rotated).toMatchObject([{ from_profile_id: "a", to_profile_id: "b" }]);
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
  });

  it("a replacement observation (an early reset) recorded during the try reaches the decision", async () => {
    const quota = authority();
    observe(quota, "b", [window("five_hour", 1, 4 * HOUR, 18_000)]);
    const o = await run({
      mode: "ask",
      profiles: ["a", "b"],
      deps: { quotaSnapshots: () => quota.read().snapshots },
      script: function* ({ profile, emit, spec }) {
        if (profile === "a") {
          vi.setSystemTime(t0 + 1_000);
          observe(quota, "b", [window("five_hour", 0.1, 5 * HOUR, 18_000)]);
          yield* progressThenLimit(emit, spec.cwd, "a");
          return;
        }
        yield* answer(emit);
      },
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(o.rotated).toMatchObject([{ from_profile_id: "a", to_profile_id: "b" }]);
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
  });

  it("a stale but still live weekly limit keeps blocking after the short window reset", async () => {
    const quota = authority();
    const weeklyReset = 6 * 24 * HOUR;
    observe(quota, "b", [
      window("five_hour", 1, 60_000, 18_000),
      window("seven_day", 1, weeklyReset, 604_800),
    ]);
    let limited = false;
    const o = await run({
      mode: "ask",
      profiles: ["a", "b"],
      deps: { quotaSnapshots: () => quota.read().snapshots },
      onProbe: () => {
        if (limited) vi.setSystemTime(t0 + 120_000);
      },
      script: function* ({ profile, emit, spec }) {
        limited = true;
        yield* progressThenLimit(emit, spec.cwd, profile);
      },
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a"]);
    expect(o.rotated).toEqual([]);
    expect(o.result.lifecycle).toBe("failed");
    expect(exhausted(o)?.candidates).toContainEqual(
      expect.objectContaining({
        profile_id: "b",
        rejected: "cooldown",
        resets_at: at(weeklyReset),
      }),
    );
  });

  it("an already-tried account stays excluded even after its own window reset", async () => {
    const quota = authority();
    const o = await run({
      mode: "ask",
      profiles: ["a", "b"],
      deps: { quotaSnapshots: () => quota.read().snapshots },
      script: function* ({ profile, emit, spec }) {
        if (profile === "a") {
          observe(quota, "a", [window("five_hour", 1, 60_000, 18_000)]);
          yield* progressThenLimit(emit, spec.cwd, "a");
          return;
        }
        // a's recorded window has reset by the time b is limited.
        vi.setSystemTime(t0 + 120_000);
        yield* progressThenLimit(emit, spec.cwd, "b");
      },
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(o.result.lifecycle).toBe("failed");
    expect(exhausted(o)?.candidates).toContainEqual(
      expect.objectContaining({ profile_id: "a", rejected: "already_tried", headroom: null }),
    );
  });

  it("a pinned account never rotates, even onto an account whose window just reset", async () => {
    const quota = authority();
    observe(quota, "b", [window("five_hour", 1, 60_000, 18_000)]);
    const o = await run({
      mode: "ask",
      profiles: ["a", "b"],
      pinned: "a",
      deps: { quotaSnapshots: () => quota.read().snapshots },
      script: function* ({ emit, spec }) {
        vi.setSystemTime(t0 + 120_000);
        yield* progressThenLimit(emit, spec.cwd, "a");
      },
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a"]);
    expect(o.rotated).toEqual([]);
    expect(o.result.lifecycle).toBe("failed");
    expect(o.resumable).toMatchObject({
      cause: "pinned_limit",
      limitCode: "subscription_window_exhausted",
    });
  });
});
