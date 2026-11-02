/**
 * #568: continuation evidence keeps a run's own recorded output by identity,
 * never by words. A D-16d checkpoint carries the exhausted try's last typed
 * final inside a fresh prompt that also holds the work order, so an earlier
 * try's message whose words that prompt or report contains is still its own
 * evidence. A packet successor's final answer leaves out only the winning
 * try's carried final (with its keyed fragments and exact repeated forms),
 * never another try's equal or contained words, and the bounded section still
 * discloses a cut and names the complete record. Scripted fake harness,
 * isolated roots, no vendor calls.
 */
import { describe, expect, it, vi } from "vitest";
vi.mock("@claudexor/schema", () => import("../../schema/src/index.js"));
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  WORK_ORDER,
  chainFixture,
  continuing,
  crash,
  limitStop,
  runLabelled,
  type ChainScript,
} from "./continuation-chain.test-support.js";
import { EVIDENCE_SECTION_BUDGET_BYTES } from "./continuation-evidence.js";

const count = (text: string, needle: string) => text.split(needle).length - 1;
/** The retained-output section of the evidence index a prompt carries. */
function retainedSection(prompt: string): string {
  const from = prompt.indexOf("## Retained assistant output", prompt.indexOf("# Evidence index"));
  expect(from).toBeGreaterThan(-1);
  return prompt.slice(from, prompt.indexOf("## Tool calls", from));
}
const keyed = (key: string, op: "fragment" | "complete") => ({
  speech: { key, op },
  ...(op === "fragment" ? { payload: { delta: true } } : {}),
});
const REPORT = "EXHAUSTED-TRY-OUTPUT-903: I checked the second module.";

/** Run A stops on a usage limit after it read a file; B resumes its session. */
function predecessor(ctx: Parameters<ChainScript>[0]) {
  ctx.seed("sid-A");
  return [
    ctx.emit({ type: "started", payload: { native_session_id: "sid-A" } }),
    ctx.emit({
      type: "tool_call",
      tool: { name: "Read", kind: "file", use_id: "read-initial", target: "README.md" },
    }),
    ...limitStop(ctx.emit),
  ];
}

describe("D16 checkpoint evidence is not filtered by the words its prompt holds", () => {
  it("keeps an earlier try's messages whose words the checkpoint prompt or carried report contains", async () => {
    const f = chainFixture({ profiles: ["a"], maxRetries: 1 }, function* (ctx) {
      if (ctx.label === "A") {
        ctx.seed("sid-A");
        yield ctx.emit({ type: "started", payload: { native_session_id: "sid-A" } });
        writeFileSync(join(ctx.cwd, "part1.txt"), "existing predecessor work\n");
        yield ctx.emit({ type: "file_change", payload: { path: "part1.txt" } });
        return yield* limitStop(ctx.emit);
      }
      yield ctx.emit({
        type: "started",
        payload: { native_session_id: ctx.resume ?? "sid-CHECKPOINT" },
      });
      if (ctx.nth === 1) {
        yield ctx.emit({
          type: "tool_call",
          tool: { name: "Read", kind: "file", target: "auth.ts", use_id: "read-auth" },
        });
        yield ctx.emit({
          type: "tool_result",
          tool: { name: "Read", kind: "file", use_id: "read-auth", status: "ok" },
        });
        // The caller's own words (the checkpoint prompt repeats them) and the
        // carried report's sentence.
        yield ctx.emit({ type: "message", text: "Explain remaining work" });
        yield ctx.emit({ type: "message", text: "I checked the second module." });
        return yield* crash(ctx.emit);
      }
      if (ctx.nth === 2) {
        yield ctx.emit({ type: "message", text: "OK" });
        // The report, streamed as one keyed block, then its unkeyed typed final.
        yield ctx.emit({
          type: "message",
          text: "EXHAUSTED-TRY-",
          ...keyed("k-report", "fragment"),
        });
        yield ctx.emit({
          type: "message",
          text: "OUTPUT-903: I checked the second module.",
          ...keyed("k-report", "fragment"),
        });
        yield ctx.emit({ type: "message", text: REPORT, ...keyed("k-report", "complete") });
        yield ctx.emit({ type: "message", text: REPORT, final: true });
        yield ctx.emit({
          type: "context",
          context: {
            kind: "capacity_exhausted",
            cause: "repeated_refill",
            native_code: null,
            trigger: null,
            pre_tokens: null,
          },
        });
        return yield ctx.emit({ type: "completed" });
      }
      yield ctx.emit({ type: "message", text: "Done", final: true });
      yield ctx.emit({ type: "completed" });
    });
    const a = await runLabelled(f, "A", { inPlace: true, continuation: { retain: true } });
    await runLabelled(f, "B", {
      mode: "ask",
      access: "readonly",
      prompt: "Explain remaining work",
      continuation: continuing(a, WORK_ORDER),
    });
    const spawns = f.spawns.filter((s) => s.label === "B");
    expect(spawns.map((s) => s.resume)).toEqual(["sid-A", "sid-A", null]);
    const checkpoint = spawns[2]!.prompt;
    const retained = retainedSection(checkpoint);
    // This run's own messages, although the checkpoint prompt holds their words.
    expect(retained).toMatch(/### Assistant message · events \d+–\d+\n\nExplain remaining work\n/);
    expect(retained).toMatch(
      /### Assistant message · events \d+–\d+\n\nI checked the second module\.\n/,
    );
    expect(retained).toMatch(/### Assistant message · events \d+–\d+\n\nOK\n/);
    // The exhausted try's last typed final is the checkpoint's report: carried once,
    // before the index, never repeated by its fragments or its final form.
    expect(count(retained, "EXHAUSTED-TRY-")).toBe(0);
    expect(count(checkpoint, REPORT)).toBe(1);
    expect(checkpoint.indexOf(REPORT)).toBeLessThan(checkpoint.indexOf("# Evidence index"));
  });
});

describe("a packet successor's evidence beside the final answer", () => {
  it("keeps another try's equal and contained words; the carried final appears once", async () => {
    const f = chainFixture({ profiles: ["a"], maxRetries: 1 }, function* (ctx) {
      if (ctx.label === "A") return yield* predecessor(ctx);
      yield ctx.emit({ type: "started", payload: { native_session_id: ctx.resume ?? "sid-C" } });
      if (ctx.label === "B" && ctx.nth === 1) {
        yield ctx.emit({ type: "message", text: "NOT OK" });
        yield ctx.emit({ type: "message", text: "OK" });
        return yield* crash(ctx.emit);
      }
      if (ctx.label === "B") {
        yield ctx.emit({ type: "message", text: "OK" });
        yield ctx.emit({ type: "message", text: "NOT", ...keyed("k-final", "fragment") });
        yield ctx.emit({ type: "message", text: " OK", ...keyed("k-final", "fragment") });
        yield ctx.emit({ type: "message", text: "NOT OK", ...keyed("k-final", "complete") });
        yield ctx.emit({ type: "message", text: "NOT OK", final: true });
        return yield ctx.emit({ type: "completed" });
      }
      yield ctx.emit({ type: "message", text: "Done", final: true });
      yield ctx.emit({ type: "completed" });
    });
    const a = await runLabelled(f, "A", { inPlace: true, continuation: { retain: true } });
    const b = await runLabelled(f, "B", {
      mode: "ask",
      access: "readonly",
      prompt: "Explain remaining work",
      continuation: continuing(a, WORK_ORDER),
    });
    expect(b.result.lifecycle).toBe("succeeded");
    expect(f.spawns.filter((s) => s.label === "B").map((s) => s.resume)).toEqual([
      "sid-A",
      "sid-A",
    ]);
    await runLabelled(f, "C", {
      mode: "ask",
      access: "readonly",
      prompt: "Continue by packet",
      continuation: continuing(b, WORK_ORDER, [a], { preference: "packet" }),
    });
    const packet = f.spawns.find((s) => s.label === "C")!;
    expect(packet.resume).toBeNull();
    const retained = retainedSection(packet.prompt);
    expect(retained).toContain(
      "Final answer (final/answer.md, attempt a01):\n\n# Answer\n\nNOT OK\n\n# Retained output",
    );
    const evidence = retained.slice(retained.indexOf("# Retained output"));
    // The earlier try said the answer's own words: separate evidence, once.
    expect(evidence.match(/^### .+\n\nNOT OK$/gm)).toHaveLength(1);
    // "OK" from the earlier try and the winning try's own narration both stay.
    expect(evidence.match(/^### .+\n\nOK$/gm)).toHaveLength(2);
    // The winning final's keyed fragments are that final: never repeated.
    expect(count(evidence, "NOT")).toBe(1);
  });

  it("more surviving evidence is still bounded and disclosed, with the complete record named", async () => {
    const answer = `FINAL-${"a".repeat(6000)}`;
    const f = chainFixture({ profiles: ["a"], maxRetries: 1 }, function* (ctx) {
      if (ctx.label === "A") return yield* predecessor(ctx);
      yield ctx.emit({ type: "started", payload: { native_session_id: ctx.resume ?? "sid-C" } });
      if (ctx.label === "B" && ctx.nth === 1) {
        // An earlier try said the final answer's exact words.
        yield ctx.emit({ type: "message", text: answer });
        return yield* crash(ctx.emit);
      }
      yield ctx.emit({ type: "message", text: ctx.label === "B" ? answer : "Done", final: true });
      yield ctx.emit({ type: "completed" });
    });
    const a = await runLabelled(f, "A", { inPlace: true, continuation: { retain: true } });
    const b = await runLabelled(f, "B", {
      mode: "ask",
      access: "readonly",
      prompt: "Explain remaining work",
      continuation: continuing(a, WORK_ORDER),
    });
    await runLabelled(f, "C", {
      mode: "ask",
      access: "readonly",
      prompt: "Continue by packet",
      continuation: continuing(b, WORK_ORDER, [a], { preference: "packet" }),
    });
    const packet = f.spawns.find((s) => s.label === "C")!;
    const retained = retainedSection(packet.prompt);
    // The authority stays first and whole; the surviving evidence after it is cut, visibly.
    expect(
      retained.startsWith(
        `## Retained assistant output\n\nFinal answer (final/answer.md, attempt a01):\n\n# Answer\n\n${answer}\n\n# Retained output`,
      ),
    ).toBe(true);
    expect(retained.trimEnd().endsWith("…[truncated]")).toBe(true);
    expect(Buffer.byteLength(retained)).toBeLessThan(EVIDENCE_SECTION_BUDGET_BYTES + 128);
    expect(packet.prompt).toContain(`- Event log: ${join(b.result.runDir, "events.jsonl")}`);
  });
});
