/**
 * #610: `clearCodexEffortCache` voids what the cache holds AND what a probe
 * already running would store there. Every ordering below drives the real cache
 * with a probe whose answers the test releases, so nothing spawns. The owner that
 * calls the clear is exercised in packages/cli/src/credential-status-invalidation-codex.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexRunEffortResolution } from "./effort-gate.js";
import {
  CODEX_EFFORT_SNAPSHOT,
  clearCodexEffortCache,
  codexEffortCacheSize,
  codexEffortCapability,
  type CodexEffortCatalog,
  type CodexEffortProbe,
} from "./effort-probe.js";

// These cache tests inject the model/list transport; give the synthetic program
// a known identity too. Real program changes are covered by program-observation tests.
vi.mock("@claudexor/core", async (original) => ({
  ...(await original<typeof import("@claudexor/core")>()),
  observeHarnessProgram: vi.fn(async (_program, _env, bin) => ({
    selection: null,
    program: { path: bin ?? "/fixture/codex", version: "1.0.0" },
    key: `${bin ?? "codex"}:1.0.0`,
  })),
}));

import { observeHarnessProgram } from "@claudexor/core";
const HOME_A = { CODEX_HOME: "/tmp/claudexor-610-home-a" };
const HOME_B = { CODEX_HOME: "/tmp/claudexor-610-home-b" };
const HOME_C = { CODEX_HOME: "/tmp/claudexor-610-home-c" };

const account = (name: string, levels = ["low", "high"]): CodexEffortCatalog => ({
  models: { [name]: { levels, default: levels[0] ?? null } },
  defaultModel: name,
});

/** A probe whose answers the test releases one at a time, in any order. */
function controlledProbe() {
  const running: Array<(answer: CodexEffortCatalog | null) => void> = [];
  const probe: CodexEffortProbe = () =>
    new Promise((resolve) => {
      running.push(resolve);
    });
  return { probe, running };
}

/** A probe that answers at once and counts how often the cache asked it. */
function answering(answer: CodexEffortCatalog | null) {
  let calls = 0;
  const probe: CodexEffortProbe = async () => {
    calls += 1;
    return answer;
  };
  return { probe, calls: () => calls };
}

let clock = 0;
const read = (probe: CodexEffortProbe, env: NodeJS.ProcessEnv = HOME_A) =>
  codexEffortCapability(probe, () => clock, "codex", env);

beforeEach(() => {
  clock = 0;
  clearCodexEffortCache();
});
afterEach(() => clearCodexEffortCache());

describe("a clear voids a probe already in flight (#610)", () => {
  it("answers its own caller but stores nothing, so the next read probes again", async () => {
    const { probe, running } = controlledProbe();
    const late = read(probe);
    clearCodexEffortCache();
    await vi.waitFor(() => expect(running.length).toBeGreaterThan(0));
    running[0]!(account("old-account"));
    // The caller asked before the change, so it keeps the answer it asked for...
    expect(await late).toEqual({ catalog: account("old-account"), live: true });
    // ...and that answer is not what anyone asking after the change reads.
    expect(codexEffortCacheSize()).toBe(0);
    const next = answering(account("new-account"));
    expect((await read(next.probe)).catalog.defaultModel).toBe("new-account");
    expect(next.calls()).toBe(1);
  });

  it("cannot overwrite the answer a probe after the clear stored", async () => {
    const { probe, running } = controlledProbe();
    const late = read(probe);
    clearCodexEffortCache();
    const fresh = answering(account("new-account"));
    expect((await read(fresh.probe)).catalog.defaultModel).toBe("new-account");
    await vi.waitFor(() => expect(running.length).toBeGreaterThan(0));
    running[0]!(account("old-account"));
    expect((await late).catalog.defaultModel).toBe("old-account");
    const later = answering(account("unexpected"));
    expect((await read(later.probe)).catalog.defaultModel).toBe("new-account");
    expect(later.calls()).toBe(0);
  });

  it("leaves nothing to serve while the probe after the clear is still running", async () => {
    const { probe, running } = controlledProbe();
    const late = read(probe);
    clearCodexEffortCache();
    const newer = read(probe);
    await vi.waitFor(() => expect(running).toHaveLength(2));
    await vi.waitFor(() => expect(running.length).toBeGreaterThan(0));
    running[0]!(account("old-account"));
    await late;
    // A read in the gap asks for itself; it is not handed the earlier account.
    const gap = answering(account("gap-account"));
    expect((await read(gap.probe)).catalog.defaultModel).toBe("gap-account");
    expect(gap.calls()).toBe(1);
    await vi.waitFor(() => expect(running.length).toBeGreaterThan(1));
    running[1]!(account("new-account"));
    await newer;
    const later = answering(account("unexpected"));
    expect((await read(later.probe)).catalog.defaultModel).toBe("new-account");
    expect(later.calls()).toBe(0);
  });

  it("cannot replace a live answer stored after the clear with its own failure", async () => {
    const { probe, running } = controlledProbe();
    const late = read(probe);
    clearCodexEffortCache();
    await read(answering(account("new-account")).probe);
    await vi.waitFor(() => expect(running.length).toBeGreaterThan(0));
    running[0]!(null);
    // Its own caller still degrades to the snapshot, as any failed probe does.
    expect(await late).toEqual({ catalog: CODEX_EFFORT_SNAPSHOT, live: false });
    const later = answering(account("unexpected"));
    expect(await read(later.probe)).toEqual({ catalog: account("new-account"), live: true });
    expect(later.calls()).toBe(0);
  });

  it("cannot replace the fallback a failed probe after the clear stored", async () => {
    const { probe, running } = controlledProbe();
    const late = read(probe);
    clearCodexEffortCache();
    expect((await read(answering(null).probe)).live).toBe(false);
    await vi.waitFor(() => expect(running.length).toBeGreaterThan(0));
    running[0]!(account("old-account"));
    await late;
    // The earlier account's catalog never stands in for the failed read: the
    // fallback keeps its one-minute life and then the home is asked again.
    const inTheMinute = answering(account("new-account"));
    expect(await read(inTheMinute.probe)).toEqual({ catalog: CODEX_EFFORT_SNAPSHOT, live: false });
    expect(inTheMinute.calls()).toBe(0);
    clock = 60_000;
    expect(await read(inTheMinute.probe)).toEqual({ catalog: account("new-account"), live: true });
    expect(inTheMinute.calls()).toBe(1);
  });
});

describe("the clear has no scope, and each home pays one probe to recover (#610)", () => {
  it("drops every home and voids every home's flight, then each home caches again", async () => {
    await read(answering(account("a-before")).probe, HOME_A);
    await read(answering(account("b-before")).probe, HOME_B);
    const { probe, running } = controlledProbe();
    const late = read(probe, HOME_C);
    clearCodexEffortCache();
    expect(codexEffortCacheSize()).toBe(0);
    await vi.waitFor(() => expect(running.length).toBeGreaterThan(0));
    running[0]!(account("c-before"));
    await late;
    expect(codexEffortCacheSize()).toBe(0);

    for (const [env, name] of [
      [HOME_A, "a-after"],
      [HOME_B, "b-after"],
      [HOME_C, "c-after"],
    ] as const) {
      const after = answering(account(name));
      expect((await read(after.probe, env)).catalog.defaultModel).toBe(name);
      expect((await read(after.probe, env)).catalog.defaultModel).toBe(name);
      expect(after.calls()).toBe(1);
    }
    expect(codexEffortCacheSize()).toBe(3);
  });

  it("a late answer for one home leaves what another home stored after the clear", async () => {
    const { probe, running } = controlledProbe();
    const late = read(probe, HOME_A);
    clearCodexEffortCache();
    await read(answering(account("b-after")).probe, HOME_B);
    await vi.waitFor(() => expect(running.length).toBeGreaterThan(0));
    running[0]!(account("a-before"));
    await late;

    const homeB = answering(account("unexpected"));
    expect((await read(homeB.probe, HOME_B)).catalog.defaultModel).toBe("b-after");
    expect(homeB.calls()).toBe(0);
    const homeA = answering(account("a-after"));
    expect((await read(homeA.probe, HOME_A)).catalog.defaultModel).toBe("a-after");
    expect(homeA.calls()).toBe(1);
  });
});

describe("with no clear in between, the cache keeps its ordinary behavior", () => {
  it("serves a probe that finished before a clear until that clear, then probes once", async () => {
    const first = answering(account("old-account"));
    await read(first.probe);
    await read(first.probe);
    expect(first.calls()).toBe(1);
    clearCodexEffortCache();
    const second = answering(account("new-account"));
    await read(second.probe);
    expect((await read(second.probe)).catalog.defaultModel).toBe("new-account");
    expect(second.calls()).toBe(1);
  });

  it("keeps two probes that overlap with no clear between them: the last answer serves", async () => {
    const { probe, running } = controlledProbe();
    const first = read(probe);
    const second = read(probe);
    await vi.waitFor(() => expect(running.length).toBeGreaterThan(1));
    running[1]!(account("second-answer"));
    await second;
    await vi.waitFor(() => expect(running.length).toBeGreaterThan(0));
    running[0]!(account("first-answer"));
    await first;
    const later = answering(account("unexpected"));
    expect((await read(later.probe)).catalog.defaultModel).toBe("first-answer");
    expect(later.calls()).toBe(0);
  });

  it("keeps the ten-minute life of a live answer and the one-minute life of a fallback", async () => {
    const live = answering(account("live-account"));
    await read(live.probe);
    clock = 10 * 60_000 - 1;
    await read(live.probe);
    expect(live.calls()).toBe(1);
    clock = 10 * 60_000;
    await read(live.probe);
    expect(live.calls()).toBe(2);

    const failed = answering(null);
    clock = 0;
    await read(failed.probe, HOME_B);
    clock = 60_000 - 1;
    await read(failed.probe, HOME_B);
    expect(failed.calls()).toBe(1);
    clock = 60_000;
    await read(failed.probe, HOME_B);
    expect(failed.calls()).toBe(2);
  });
});

describe("a run's effort follows the catalog of the account now behind its home", () => {
  const spec = { session_id: "codex-610", model_hint: null, effort_hint: "ultra" } as const;
  const resolve = (catalog: CodexEffortCatalog) =>
    codexRunEffortResolution(
      spec,
      {
        probeEfforts: async () => catalog,
        nowMs: () => clock,
        detectVersion: async () => "codex-cli fixture",
      },
      HOME_A,
    );

  it("sends the new account's level once the clear has dropped the earlier ladder", async () => {
    const earlier = account("old-account", ["low", "ultra"]);
    const later = account("new-account", ["low", "high"]);
    expect((await resolve(earlier)).resolution.submitted).toBe("ultra");
    // Same home, same binary: an ordinary cache hit keeps the earlier ladder...
    expect((await resolve(later)).resolution.submitted).toBe("ultra");
    clearCodexEffortCache();
    // ...and after the clear the level is resolved against the new one.
    expect((await resolve(later)).resolution.submitted).toBe("high");
  });
});

it("does not publish a credential observation begun before invalidation while --version is pending", async () => {
  const identity = {
    selection: null,
    program: { path: "/fixture/codex", version: "1.0.0" },
    key: "codex:1.0.0",
    versionSource: "remembered" as const,
  };
  let release!: (value: typeof identity) => void;
  vi.mocked(observeHarnessProgram).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const old = read(answering(account("old-account")).probe);
  clearCodexEffortCache();
  release(identity);
  expect((await old).catalog.defaultModel).toBe("old-account");
  expect(codexEffortCacheSize()).toBe(0);
  const next = answering(account("new-account"));
  await read(next.probe);
  await read(next.probe);
  expect(next.calls()).toBe(1);
});
it.each([true, false])(
  "reuses the same program identity with an answered or mute version (known: %s)",
  async (known) => {
    const observation = {
      selection: null,
      program: { path: "/fixture/codex", version: known ? "1.0.0" : null },
      key: "same",
      versionSource: "remembered" as const,
    };
    vi.mocked(observeHarnessProgram)
      .mockResolvedValueOnce(observation)
      .mockResolvedValueOnce(observation);
    const next = answering(account("account"));
    await read(next.probe);
    await read(next.probe);
    expect(next.calls()).toBe(1);
    vi.mocked(observeHarnessProgram).mockResolvedValueOnce({ ...observation, key: "changed-file" });
    await read(next.probe);
    expect(next.calls()).toBe(2);
  },
);
