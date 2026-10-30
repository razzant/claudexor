import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { createFakeHarness, FAKE_KINDS } from "./index.js";
import { FAKE_INTERACTIVE_FIRST_OPTIONS, FAKE_INTERACTIVE_FIRST_QUESTION } from "./interactive.js";

function registry() {
  const m = new Map();
  for (const k of FAKE_KINDS) m.set(k, createFakeHarness(k));
  return m;
}

function spec(prompt = "do it"): HarnessRunSpec {
  return HarnessRunSpec.parse({ session_id: "ses-test", intent: "implement", prompt, cwd: "/tmp" });
}

async function collect(events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

// The fake adapters are the conformance fixtures for the typed event contract:
// every adapter must emit usage with cost, file changes, and a terminal completed.
describe("fake harness adapters", () => {
  it("fake-success emits file_change, exact usage cost, and a terminal completed", async () => {
    const events = await collect(createFakeHarness("fake-success").run(spec()));
    expect(
      events.some((e) => e.type === "file_change" && e.payload?.["path"] === "FAKE_CHANGE.txt"),
    ).toBe(true);
    const usage = events.find((e) => e.type === "usage");
    expect(usage?.usage?.cost_usd).toBeCloseTo(0.01);
    expect(events[events.length - 1]?.type).toBe("completed");
  });

  it("forwards access profile and model hint through the run spec", async () => {
    const s = HarnessRunSpec.parse({
      session_id: "ses-fwd",
      intent: "implement",
      prompt: "x",
      cwd: "/tmp",
      access: "full",
      model_hint: "some-model",
    });
    // The spec object IS the adapter contract: what the orchestrator sets is
    // exactly what the adapter receives (no engine middleman since v0.7).
    expect(s.access).toBe("full");
    expect(s.model_hint).toBe("some-model");
    const events = await collect(createFakeHarness("fake-success").run(s));
    expect(events.some((e) => e.type === "completed")).toBe(true);
  });

  it("fake-fail-tests still terminates with completed (failure is gate truth, not stream truth)", async () => {
    const events = await collect(createFakeHarness("fake-fail-tests").run(spec()));
    expect(events[events.length - 1]?.type).toBe("completed");
  });

  it("fake-rate-limit emits a TYPED rate_limit signal (budget cooldown fixture)", async () => {
    const events = await collect(createFakeHarness("fake-rate-limit").run(spec()));
    const errored = events.find((e) => e.type === "error");
    expect(errored?.rate_limit).toBeTruthy();
    expect(errored?.rate_limit?.retry_delay_ms).toBe(2500);
    expect(typeof errored?.rate_limit?.resets_at).toBe("string");
    expect(events[events.length - 1]?.type).toBe("completed");
  });

  it("doctor reports fake-invalid-json as degraded with disabled review", async () => {
    const reports = await runDoctor(registry(), { cwd: "/tmp" });
    const degraded = reports.find((r) => r.harness_id === "fake-invalid-json");
    expect(degraded?.status).toBe("degraded");
    expect(degraded?.disabled_intents).toContain("review");
  });

  it("fake-implement writes a REAL file for producing intents WITHOUT leaking the prompt into the artifact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-impl-"));
    try {
      const promptCanary = "promptLeakCanary-do-the-thing";
      const s = HarnessRunSpec.parse({
        session_id: "ses-impl",
        intent: "implement",
        prompt: promptCanary,
        cwd: dir,
      });
      const events = await collect(createFakeHarness("fake-implement").run(s));
      const file = join(dir, "FAKE_CHANGE.txt");
      expect(existsSync(file)).toBe(true);
      // BIBLE §6: the raw prompt must NEVER land in a worktree file / diff artifact
      // NOR in any emitted event (events persist into the run transcript/artifacts).
      expect(readFileSync(file, "utf8")).not.toContain(promptCanary);
      expect(events.map((e) => e.text ?? "").join("\n")).not.toContain(promptCanary);
      expect(events[events.length - 1]?.type).toBe("completed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fake-session mints a native id, resumes a carried one, and probes engine facts and prompt digests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-session-"));
    try {
      const first = await collect(
        createFakeHarness("fake-session").run(
          HarnessRunSpec.parse({
            session_id: "ses-a",
            intent: "implement",
            prompt: "promptLeakCanary",
            cwd: dir,
            env: { HOME: "/lane/home" },
          }),
        ),
      );
      const started = first.find((e) => e.type === "started");
      expect(started?.payload?.["native_session_id"]).toBe("fake-native-ses-a");
      const probe = first.find((e) => e.payload?.["code"] === "fake_session_probe");
      expect(probe?.payload).toMatchObject({ resumed_from: null, home: "/lane/home", cwd: dir });
      // The prompt is proven by digest, never echoed.
      expect(probe?.payload?.["prompt_line_sha256"]).toEqual([
        createHash("sha256").update("promptLeakCanary").digest("hex"),
      ]);
      expect(existsSync(join(dir, "FAKE_CHANGE.txt"))).toBe(true);
      expect(JSON.stringify(first)).not.toContain("promptLeakCanary");
      const second = await collect(
        createFakeHarness("fake-session").run(
          HarnessRunSpec.parse({
            session_id: "ses-b",
            intent: "explain",
            prompt: "q",
            cwd: dir,
            access: "readonly",
            resume_session_id: "fake-native-ses-a",
          }),
        ),
      );
      expect(second.find((e) => e.type === "started")?.payload?.["native_session_id"]).toBe(
        "fake-native-ses-a",
      );
      expect(
        second.find((e) => e.payload?.["code"] === "fake_session_probe")?.payload,
      ).toMatchObject({ resumed_from: "fake-native-ses-a", cwd_entries: ["FAKE_CHANGE.txt"] });
      expect(second[second.length - 1]?.type).toBe("completed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fake-implement doctor enables create_from_scratch", async () => {
    const reports = await runDoctor(registry(), { cwd: "/tmp" });
    const impl = reports.find((r) => r.harness_id === "fake-implement");
    expect(impl?.status).toBe("ok");
    expect(impl?.enabled_intents).toContain("create_from_scratch");
  });
});

describe("fake-steerable (live-input fixture)", () => {
  it("parks until one live message, receipts it without echoing the text, then answers not_active", async () => {
    const adapter = createFakeHarness("fake-steerable");
    const manifest = await adapter.discover();
    expect(manifest.capability_profile.live_input).toBe("mid_turn");
    const s = HarnessRunSpec.parse({
      session_id: "ses-steer",
      intent: "implement",
      prompt: "do it",
      cwd: "/tmp",
    });
    const secret = "steerTextCanary-never-echoed";
    // Nothing parked yet: the run has not started.
    await expect(
      adapter.message?.("ses-steer", { messageId: "m-early", text: secret }),
    ).resolves.toEqual({ outcome: "not_active", reason: "no_active_turn" });
    const iterator = adapter.run(s)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "started" });
    expect((await iterator.next()).value).toMatchObject({ type: "thinking" });
    const parked = iterator.next();
    await expect(
      adapter.message?.("ses-steer", { messageId: "m-1", text: secret }),
    ).resolves.toEqual({
      outcome: "delivered",
      nativeTurnId: "fake-turn-1",
    });
    const events: HarnessEvent[] = [(await parked).value as HarnessEvent];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    expect(events[0]).toMatchObject({
      type: "status",
      payload: { code: "live_input_delivered", message_id: "m-1", native_turn_id: "fake-turn-1" },
    });
    expect(events.at(-1)?.type).toBe("completed");
    expect(JSON.stringify(events)).not.toContain(secret);
    // Consumed once; the session is over.
    await expect(
      adapter.message?.("ses-steer", { messageId: "m-2", text: secret }),
    ).resolves.toEqual({
      outcome: "not_active",
      reason: "no_active_turn",
    });
  });

  it("terminalizes as cancelled when aborted while parked, and other fakes have no message()", async () => {
    const adapter = createFakeHarness("fake-steerable");
    const abort = new AbortController();
    const s = HarnessRunSpec.parse({
      session_id: "ses-abort",
      intent: "implement",
      prompt: "do it",
      cwd: "/tmp",
      extra: { abortSignal: abort.signal },
    });
    const iterator = adapter.run(s)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    const parked = iterator.next();
    abort.abort();
    expect((await parked).value).toMatchObject({ type: "completed", aborted: true });
    expect((await iterator.next()).done).toBe(true);
    for (const kind of FAKE_KINDS.filter(
      (k) => k !== "fake-steerable" && k !== "fake-interactive",
    )) {
      expect(createFakeHarness(kind).message, kind).toBeUndefined();
      expect((await createFakeHarness(kind).discover()).capability_profile.live_input).toBe("none");
    }
  });
});

describe("fake-interactive (supervision fixture)", () => {
  function interactiveSpec(channel: unknown, abort?: AbortController) {
    return HarnessRunSpec.parse({
      session_id: "ses-ask",
      intent: "explain",
      prompt: "steerTextCanary prompt never echoed",
      cwd: "/tmp",
      extra: { interactionChannel: channel, ...(abort ? { abortSignal: abort.signal } : {}) },
    });
  }

  it("asks two questions around one accepted live message and never echoes contents", async () => {
    const adapter = createFakeHarness("fake-interactive");
    const manifest = await adapter.discover();
    expect(manifest.capabilities.interactive).toBe(true);
    expect(manifest.capability_profile.live_input).toBe("mid_turn");
    const asked: Array<{ interaction_id: string; questions: Array<{ question: string }> }> = [];
    const channel = {
      request: async (request: (typeof asked)[number]) => {
        asked.push(request);
        return { interaction_id: request.interaction_id, answers: [] };
      },
    };
    const iterator = adapter.run(interactiveSpec(channel))[Symbol.asyncIterator]();
    const events: HarnessEvent[] = [];
    // Run until the fixture parks for its live message.
    for (;;) {
      const next = await iterator.next();
      events.push(next.value as HarnessEvent);
      if (events.at(-1)?.text === "waiting for a live message (fake)") break;
    }
    expect(asked.map((r) => r.interaction_id)).toEqual(["fake-q1-ses-ask"]);
    const first = asked[0]!.questions[0]!.question;
    expect(first).toBe(FAKE_INTERACTIVE_FIRST_QUESTION);
    // Larger than a 32 KiB pending page, still inside one 64 KiB event page.
    expect(Buffer.byteLength(first)).toBeGreaterThan(32_768);
    expect(Buffer.byteLength(JSON.stringify(asked[0]))).toBeLessThan(60_000);
    expect(FAKE_INTERACTIVE_FIRST_OPTIONS).toContain("Продолжить 🚀");
    const parked = iterator.next();
    await expect(
      adapter.message?.("ses-ask", { messageId: "m-1", text: "steerTextCanary message" }),
    ).resolves.toEqual({ outcome: "accepted", nativeTurnId: "fake-turn-1" });
    events.push((await parked).value as HarnessEvent);
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "status",
        payload: { code: "live_input_delivered", message_id: "m-1", native_turn_id: "fake-turn-1" },
      }),
    );
    expect(asked.map((r) => r.interaction_id)).toEqual(["fake-q1-ses-ask", "fake-q2-ses-ask"]);
    expect(events.at(-1)?.type).toBe("completed");
    expect(JSON.stringify(events)).not.toContain("steerTextCanary");
    await expect(adapter.message?.("ses-ask", { messageId: "m-2", text: "late" })).resolves.toEqual(
      { outcome: "not_active", reason: "no_active_turn" },
    );
  });

  it("fails visibly without an interaction channel and stops on abort", async () => {
    const adapter = createFakeHarness("fake-interactive");
    const events = await collect(adapter.run(interactiveSpec(undefined)));
    expect(events.map((e) => e.type)).toEqual(["started", "error", "completed"]);
    const abort = new AbortController();
    const pending = collect(
      adapter.run(
        interactiveSpec(
          {
            request: () =>
              new Promise((resolve) =>
                abort.signal.addEventListener("abort", () => resolve(null), { once: true }),
              ),
          },
          abort,
        ),
      ),
    );
    setTimeout(() => abort.abort(), 10);
    expect((await pending).at(-1)).toMatchObject({ type: "completed", aborted: true });
  });
});
