import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { ConformanceReport, HarnessManifest } from "@claudexor/schema";
import { summarizeThreadPrefix } from "./continuity-summary.js";
import type { ContinuityTurn } from "./continuity.js";

function manifestFor(id: string): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "openai",
        capabilities: { plan: true, review: true, read_files: true, web_policy: "none" },
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["explain"],
      });
    },
    // eslint-disable-next-line require-yield
    async *run() {
      throw new Error("override run");
    },
  };
}

/** A harness that returns a typed final answer echoing the transcript it saw. */
function summarizingLane(id: string, answer: string): HarnessAdapter {
  return {
    ...manifestFor(id),
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts } as never;
      // Prove the collapsed turns actually reach the pass: echo a marker if seen.
      const sawMarker = spec.prompt.includes("MARKER-IN-PROMPT");
      yield {
        type: "message",
        session_id: spec.session_id,
        ts,
        text: sawMarker ? `${answer} (saw marker)` : answer,
        final: true,
      } as never;
      yield { type: "completed", session_id: spec.session_id, ts } as never;
    },
  };
}

/** A harness that errors mid-run. */
function erroringLane(id: string): HarnessAdapter {
  return {
    ...manifestFor(id),
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts } as never;
      yield { type: "error", session_id: spec.session_id, ts, text: "boom" } as never;
    },
  };
}

/** A well-behaved harness that never answers until it is aborted (simulates a hang). */
function hangingLane(id: string): HarnessAdapter {
  return {
    ...manifestFor(id),
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts } as never;
      const signal = spec.extra["abortSignal"] as AbortSignal | undefined;
      await new Promise<void>((resolve) => {
        if (!signal) return; // no signal → resolve never (guarded by test timeout)
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      // Aborted: end the stream with no answer (a cancelled process yields nothing).
    },
  };
}

const TURNS: ContinuityTurn[] = [
  { id: "t1", prompt: "MARKER-IN-PROMPT teach me widgets", outputText: "widgets are gadgets" },
  { id: "t2", prompt: "compare them", outputText: "gadget A beats gadget B" },
];

function params(
  adapter: HarnessAdapter,
  over: Partial<Parameters<typeof summarizeThreadPrefix>[0]> = {},
) {
  return {
    adapter,
    turns: TURNS,
    cwd: "/tmp",
    env: {},
    credentialProfile: null,
    authPreference: "auto" as const,
    envInheritance: "clean" as const,
    ...over,
  };
}

describe("summarizeThreadPrefix (INV-137, V9c)", () => {
  it("returns the harness's typed final answer on success", async () => {
    const text = await summarizeThreadPrefix(params(summarizingLane("lane-a", "SUMMARY OK")));
    expect(text).toBe("SUMMARY OK (saw marker)");
  });

  it("feeds the collapsed turns into the summariser prompt", async () => {
    // The success test already asserts the marker was seen; assert absence too.
    const noMarker: ContinuityTurn[] = [{ id: "t1", prompt: "plain", outputText: "plain out" }];
    const text = await summarizeThreadPrefix(
      params(summarizingLane("lane-a", "SUMMARY OK"), { turns: noMarker }),
    );
    expect(text).toBe("SUMMARY OK");
  });

  it("returns null (mechanical fallback) when the harness errors", async () => {
    const text = await summarizeThreadPrefix(params(erroringLane("lane-a")));
    expect(text).toBeNull();
  });

  it("returns null when the pass times out", async () => {
    const text = await summarizeThreadPrefix(params(hangingLane("lane-a"), { timeoutMs: 25 }));
    expect(text).toBeNull();
  });

  it("returns null when the caller's run signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const text = await summarizeThreadPrefix(
      params(summarizingLane("lane-a", "SHOULD NOT RUN"), { signal: controller.signal }),
    );
    expect(text).toBeNull();
  });

  it("returns null for an empty prefix (nothing to summarise)", async () => {
    const text = await summarizeThreadPrefix(params(summarizingLane("lane-a", "x"), { turns: [] }));
    expect(text).toBeNull();
  });
});
