import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { ConformanceReport, HarnessManifest } from "@claudexor/schema";
import { readThreadSummary } from "@claudexor/workspace";
import { summarizeThreadPrefix } from "./continuity-summary.js";
import { resolveContinuitySummary } from "./continuity-facts.js";
import {
  buildContinuation,
  planContinuation,
  type ContinuityRequest,
  type ContinuityTurn,
} from "./continuity.js";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  reapDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of reapDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

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

  it("names the lane's own model only when it is given one (#395)", async () => {
    const seen: Array<string | null | undefined> = [];
    const lane: HarnessAdapter = {
      ...manifestFor("recording"),
      async *run(spec) {
        seen.push(spec.model_hint);
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts } as never;
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: "ok",
          final: true,
        } as never;
        yield { type: "completed", session_id: spec.session_id, ts } as never;
      },
    };
    await summarizeThreadPrefix(params(lane, { model: "vendor/lane" }));
    await summarizeThreadPrefix(params(lane));
    expect(seen).toEqual(["vendor/lane", null]);
  });

  it("returns null for an empty prefix (nothing to summarise)", async () => {
    const text = await summarizeThreadPrefix(params(summarizingLane("lane-a", "x"), { turns: [] }));
    expect(text).toBeNull();
  });
});

/** A lane that records each prompt it is given and answers with `answer` as its typed final. */
function answeringLane(id: string, answer: string, prompts: string[]): HarnessAdapter {
  return {
    ...manifestFor(id),
    async *run(spec) {
      prompts.push(spec.prompt);
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts } as never;
      yield {
        type: "message",
        session_id: spec.session_id,
        ts,
        text: answer,
        final: true,
      } as never;
      yield { type: "completed", session_id: spec.session_id, ts } as never;
    },
  };
}

/** Characters 2 (Cyrillic), 3 (CJK) and 4 (emoji, a UTF-16 surrogate pair) UTF-8 bytes wide. */
const WIDE_CHARS = ["Ж", "中", "😀"];
const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * A text whose `limit`-byte cut falls `into` bytes inside one `char`, and the
 * whole-character prefix a correct cut keeps. ASCII padding shifts where the
 * characters start; with `into` 0, `kept` is exactly `limit` bytes. The
 * expectations come from this construction, not from the code under test.
 */
function cutInside(char: string, limit: number, into: number): { text: string; kept: string } {
  const room = limit - into;
  const width = utf8Bytes(char);
  const kept = "a".repeat(room % width) + char.repeat(Math.floor(room / width));
  return { text: `${kept}${char.repeat(4)}`, kept };
}

describe("summary pass byte bounds keep whole UTF-8 characters (INV-137, #577)", () => {
  it("cuts each transcript field at 2 KiB and the summary at 8 KiB on a character boundary, through the thread packet", async () => {
    // The summary cache lives under (config dir, project root, thread, boundary
    // turn). A fresh config dir and project root for each execution keep a
    // repeat, retry, restart or parallel worker from reading another
    // execution's cached summary, so every case below reaches the adapter.
    const configDir = reapMk(join(tmpdir(), "claudexor-577-summary-config-"));
    const projectRoot = reapMk(join(tmpdir(), "claudexor-577-summary-project-"));
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      // Long ASCII turns after the probe turn make the packet budget collapse
      // the probe turn, so the real summary consumer sends it to the pass.
      const filler = "f".repeat(5 * 1024);
      for (const char of WIDE_CHARS) {
        for (let into = 1; into < utf8Bytes(char); into += 1) {
          const prompt = cutInside(char, 2048, into);
          const output = cutInside(char, 2048, utf8Bytes(char) - into);
          const answer = cutInside(char, 8192, into);
          const priorTurns: ContinuityTurn[] = [
            { id: "t1", prompt: prompt.text, outputText: output.text },
            ...["t2", "t3", "t4"].map((id) => ({ id, prompt: filler, outputText: filler })),
          ];
          const unchanged = structuredClone(priorTurns);
          const req: ContinuityRequest = {
            lane: { harness: "lane-b", profileId: null },
            priorTurns,
            laneCheckpointTurnId: null,
            nativeResumeAvailable: false,
            priorHeadLane: { harness: "lane-a", profileId: null },
            activePlan: null,
            anchor: null,
          };
          const plan = planContinuation(req);
          expect(plan.collapsedPrefix[0]?.id).toBe("t1");
          const threadId = `th-577-${utf8Bytes(char)}-${into}`;
          expect(readThreadSummary(projectRoot, threadId, plan.summaryUpToTurnId ?? "")).toBeNull();
          const prompts: string[] = [];
          const resolved = await resolveContinuitySummary({
            req,
            threadId,
            projectRoot,
            cwd: projectRoot,
            adapter: answeringLane("lane-b", answer.text, prompts),
            credentialProfile: null,
            authPreference: "auto",
            laneEnv: {},
            envInheritance: "clean",
          });
          const summary = `${answer.kept}…`;
          expect(prompts).toHaveLength(1);
          expect(prompts[0]).toContain(
            `Turn 1\nUser: ${prompt.kept}…\nAssistant: ${output.kept}…\n`,
          );
          expect(resolved?.text).toBe(summary);
          expect(readThreadSummary(projectRoot, threadId, resolved?.upToTurnId ?? "")).toBe(
            summary,
          );
          const packet = buildContinuation({ ...req, cachedSummary: resolved }).packetMarkdown;
          expect(packet).toContain(`## Earlier conversation (summary)\n\n${summary}\n`);
          for (const text of [prompts[0], packet])
            expect(text).not.toMatch(/\uFFFD|\p{Surrogate}/u);
          expect(priorTurns).toEqual(unchanged);
        }
      }
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });

  it("gives the summariser the end of an unfinished turn's output, where its newest text is (#405)", async () => {
    const latest = "LATEST-STATE: the deadline check belongs in retry.ts";
    for (const char of WIDE_CHARS) {
      const output = `${"step: nothing new.\n".repeat(200)}${char.repeat(700)}${latest}`;
      const prompts: string[] = [];
      await summarizeThreadPrefix(
        params(answeringLane("lane-a", "S", prompts), {
          turns: [{ id: "t1", prompt: "p", outputText: output, noFinalAnswer: "ended" }],
        }),
      );
      const said = "Assistant (ended without a final answer): …";
      const kept = prompts[0]!.slice(prompts[0]!.indexOf(said) + said.length);
      expect(prompts[0]).toContain(said);
      expect(output.endsWith(kept)).toBe(true);
      expect(kept).toContain(latest);
      expect(utf8Bytes(kept)).toBeLessThanOrEqual(2048);
      expect(utf8Bytes(kept)).toBeGreaterThan(2048 - utf8Bytes(char));
      expect(kept).not.toMatch(/\p{Surrogate}/u);
    }
  });

  it("leaves exactly fitting fields and summary unchanged and marks a one-byte cut", async () => {
    for (const char of WIDE_CHARS) {
      const fits = cutInside(char, 2048, 0).kept;
      const summary = cutInside(char, 8192, 0).kept;
      const prompts: string[] = [];
      const text = await summarizeThreadPrefix(
        params(answeringLane("lane-a", summary, prompts), {
          turns: [{ id: "t1", prompt: fits, outputText: `${fits}x` }],
        }),
      );
      expect(prompts[0]).toContain(`\nUser: ${fits}\nAssistant: ${fits}…`);
      expect(text).toBe(summary);
    }
  });
});
