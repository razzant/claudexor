import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessRunSpec, type CredentialProfile, type HarnessEvent } from "@claudexor/schema";
import type { CliRunLoopOptions } from "@claudexor/core";
import { createCodexAdapter } from "./index.js";
import { withCodexVendorFailure } from "./vendor-failure.js";

// The post-terminal side channel: only a `completed` event on which the run
// loop disclosed that codex VOICED its own error is enriched with the rollout's
// typed failure. Every "quiet" case below runs against a rollout that DOES
// hold a failure for this very turn, so an untouched payload proves the gate,
// not an empty record.

const THREAD = "00000000-0000-7000-0000-000000000000";
const FIXTURE = fileURLToPath(
  new URL("../fixtures/rollout/recorded-server-overloaded-0.153.3.jsonl", import.meta.url),
);
// The recorded turn started at 1789465372 (whole seconds).
const SPAWN_MS = 1789465372_250;
const VENDOR_FAILURE = {
  code: "server_overloaded",
  message: "Selected model is at capacity. Please try a different model.",
  source: "codex_rollout",
};

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "codex-vendor-failure-wrap-"));
  const day = join(home, "sessions", "2026", "09", "15");
  mkdirSync(day, { recursive: true });
  copyFileSync(FIXTURE, join(day, `rollout-2026-09-15T12-42-52-${THREAD}.jsonl`));
});
afterAll(() => rmSync(home, { recursive: true, force: true }), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SPAWN_MS);
});
afterEach(() => vi.useRealTimers());

const spec = (extra: Record<string, unknown> = {}): HarnessRunSpec =>
  HarnessRunSpec.parse({
    session_id: "ses-vf",
    intent: "explain",
    prompt: "hi",
    cwd: process.cwd(),
    ...extra,
  });

const ts = "2026-09-15T09:43:57.973Z";
const started: HarnessEvent = { type: "started", session_id: "ses-vf", ts };
const error: HarnessEvent = { type: "error", session_id: "ses-vf", ts, error: "at capacity" };
const completed = (payload?: Record<string, unknown>, aborted = false): HarnessEvent => ({
  type: "completed",
  session_id: "ses-vf",
  ts,
  ...(aborted ? { aborted: true } : {}),
  ...(payload ? { payload } : {}),
});

async function* stream(events: HarnessEvent[]): AsyncGenerator<HarnessEvent> {
  for (const ev of events) yield ev;
}

async function wrap(
  events: HarnessEvent[],
  opts: { spec?: HarnessRunSpec; codexHome?: string | null; thread?: string | undefined } = {},
): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  const env = { CODEX_HOME: opts.codexHome === undefined ? home : opts.codexHome };
  const thread = "thread" in opts ? opts.thread : THREAD;
  for await (const ev of withCodexVendorFailure(
    stream(events),
    opts.spec ?? spec(),
    env,
    () => thread,
  ))
    out.push(ev);
  return out;
}

describe("withCodexVendorFailure", () => {
  it("attaches the rollout's typed failure to a completed event the harness voiced an error on", async () => {
    const input = [started, error, completed({ exit_code: 1, harness_reported_error: true })];
    const out = await wrap(input);
    expect(out).toHaveLength(3);
    expect(out.slice(0, 2)).toEqual([started, error]);
    expect(out[2]).toEqual(
      completed({ exit_code: 1, harness_reported_error: true, vendor_failure: VENDOR_FAILURE }),
    );
    // The source event is not mutated.
    expect(input[2]?.payload).toEqual({ exit_code: 1, harness_reported_error: true });
  });

  it("stays quiet on a completion the harness did NOT voice an error on (silent exit, clean exit)", async () => {
    for (const payload of [{ exit_code: 1 }, { exit_code: 0 }, undefined]) {
      const input = [started, completed(payload)];
      expect(await wrap(input)).toEqual(input);
    }
  });

  it("stays quiet on an ABORTED completion", async () => {
    const input = [started, error, completed({ exit_code: 1, harness_reported_error: true }, true)];
    expect(await wrap(input)).toEqual(input);
  });

  it("stays quiet under evidence_policy stream_only (the rollout is never read)", async () => {
    const input = [started, error, completed({ exit_code: 1, harness_reported_error: true })];
    expect(await wrap(input, { spec: spec({ evidence_policy: "stream_only" }) })).toEqual(input);
  });

  it("leaves the payload untouched when the read yields nothing (no thread id, no home, a prior turn)", async () => {
    const input = [started, error, completed({ exit_code: 1, harness_reported_error: true })];
    expect(await wrap(input, { thread: undefined })).toEqual(input);
    expect(await wrap(input, { codexHome: null })).toEqual(input);
    // This process spawned AFTER the recorded turn: the record is not its own.
    vi.setSystemTime(SPAWN_MS + 60_000);
    expect(await wrap(input)).toEqual(input);
  });

  it.runIf(process.platform !== "win32")(
    "attaches nothing from a rollout reached through a link (#336)",
    async () => {
      const linked = mkdtempSync(join(tmpdir(), "codex-vendor-failure-link-"));
      const day = join(linked, "sessions", "2026", "09", "15");
      mkdirSync(day, { recursive: true });
      symlinkSync(FIXTURE, join(day, `rollout-2026-09-15T12-42-52-${THREAD}.jsonl`));
      try {
        const input = [started, error, completed({ exit_code: 1, harness_reported_error: true })];
        expect(await wrap(input, { codexHome: linked })).toEqual(input);
      } finally {
        rmSync(linked, { recursive: true, force: true });
      }
    },
  );

  it("passes every other event through identical and in order", async () => {
    const usage: HarnessEvent = {
      type: "usage",
      session_id: "ses-vf",
      ts,
      usage: { input_tokens: 1 },
    };
    const input = [
      started,
      usage,
      error,
      completed({ exit_code: 1, harness_reported_error: true }),
    ];
    const out = await wrap(input);
    expect(out.map((e) => e.type)).toEqual(["started", "usage", "error", "completed"]);
    expect(out[0]).toBe(started);
    expect(out[1]).toBe(usage);
    expect(out[2]).toBe(error);
  });
});

// The wiring: the real adapter run wraps its CLI stream, binds the read to the
// thread id the stream announced and to the run's own resolved CODEX_HOME.
describe("codex adapter run (wiring)", () => {
  // Under the vitest CLAUDEXOR_CONFIG_DIR sandbox the override IS the owned
  // profile-storage root.
  const ownedTmp = join(process.env.CLAUDEXOR_CONFIG_DIR as string, "test-tmp");
  const profileHomes: string[] = [];
  afterAll(() => {
    for (const dir of profileHomes) rmSync(dir, { recursive: true, force: true });
  }, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

  async function run(announceThread: boolean): Promise<HarnessEvent[]> {
    mkdirSync(ownedTmp, { recursive: true });
    const profileHome = mkdtempSync(join(ownedTmp, "claudexor-codex-vendor-failure-"));
    profileHomes.push(profileHome);
    const day = join(profileHome, "sessions", "2026", "09", "15");
    mkdirSync(day, { recursive: true });
    copyFileSync(FIXTURE, join(day, `rollout-2026-09-15T12-42-52-${THREAD}.jsonl`));
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex 0.1-test",
      probeEfforts: async () => null,
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      resolveProfileSecret: () => null,
      runCliHarness: async function* (options: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        const frames: unknown[] = [
          ...(announceThread ? [{ type: "thread.started", thread_id: THREAD }] : []),
          { type: "error", message: "Selected model is at capacity." },
        ];
        for (const raw of frames) for (const ev of options.parseEvent(raw, "s1") ?? []) yield ev;
        yield completed({ exit_code: 1, harness_reported_error: true });
      },
    });
    const events: HarnessEvent[] = [];
    const credential_profile = {
      profile_id: "acc2",
      harness_id: "codex",
      display_name: "Second",
      credential_kind: "config_dir_login",
      isolation_locator: profileHome,
      secret_ref: null,
      enabled: true,
      created_at: null,
    } as CredentialProfile;
    for await (const ev of adapter.run(
      spec({ intent: "implement", access: "workspace_write", credential_profile }),
    ))
      events.push(ev);
    return events;
  }

  it("the terminal event of a voiced failure carries codex's own code from the run's rollout", async () => {
    const events = await run(true);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
    expect(events.at(-1)?.payload?.["vendor_failure"]).toEqual(VENDOR_FAILURE);
  });

  it("without an announced thread id nothing binds the rollout to this run: no vendor_failure", async () => {
    const events = await run(false);
    expect(events.at(-1)?.type).toBe("completed");
    expect(events.at(-1)?.payload).toEqual({ exit_code: 1, harness_reported_error: true });
  });
});
