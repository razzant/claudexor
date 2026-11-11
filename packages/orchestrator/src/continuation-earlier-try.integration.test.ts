/**
 * Recorded output of an earlier native try of the same attempt that what is
 * carried forward does not represent (the D-16d checkpoint holds only the
 * exhausted try's report; `final/answer.md` only the winning try's answer)
 * reaches the successor once, beside that authority, never as a replay.
 *
 * Astra r2 review repros (`.review-evidence/astra-r2/carrier-review/
 * checkpoint-earlier-try.repro.test.ts`, sha256 258bb307…): both scenarios and
 * their assertions verbatim; the stricter once/authority checks after them are
 * this repair's own. Scripted fake harness, isolated roots, no vendor calls.
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
} from "./continuation-chain.test-support.js";
import { CONTINUATION_PACKET_SENTINEL } from "./continuation.js";

const count = (text: string, needle: string) => text.split(needle).length - 1;

// Supported sequence: a continued Ask retains one native retry, then the
// retry exhausts context and triggers D16's fresh checkpoint continuation.
// Every fixture and fake session store is under this test's isolated tmp root.
describe("D16 checkpoint keeps evidence from earlier tries of the exhausted attempt", () => {
  it("retains the earlier native try's distinct report beside the exhausted try's checkpoint", async () => {
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
        yield ctx.emit({
          type: "message",
          text: "EARLIER-TRY-DISCOVERY-712: preserve the old key until migration commits.",
        });
        return yield* crash(ctx.emit);
      }
      if (ctx.nth === 2) {
        yield ctx.emit({
          type: "message",
          text: "EXHAUSTED-TRY-OUTPUT-903: I checked the second module.",
          final: true,
        });
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
    const b = await runLabelled(f, "B", {
      mode: "ask",
      access: "readonly",
      prompt: "Explain remaining work",
      continuation: continuing(a, WORK_ORDER),
    });
    const spawns = f.spawns.filter((s) => s.label === "B");
    expect(spawns.map((s) => s.resume)).toEqual(["sid-A", "sid-A", null]);
    expect(b.events.some((e) => e.type === "run.continuation")).toBe(true);
    const checkpoint = spawns[2]!.prompt;
    expect(checkpoint).toContain(CONTINUATION_PACKET_SENTINEL);
    expect(checkpoint).toContain(WORK_ORDER);
    expect(checkpoint).toContain("EXHAUSTED-TRY-OUTPUT-903");
    // The native retry's history contained this fact; a fresh checkpoint must
    // preserve it too instead of dropping all output of the exhausted attempt.
    expect(checkpoint).toContain("EARLIER-TRY-DISCOVERY-712");
    // Repair's own: once each; the checkpoint (authority) first, the earlier try
    // after it under its attempt and native try; the exhausted report is not repeated.
    expect(count(checkpoint, "EARLIER-TRY-DISCOVERY-712")).toBe(1);
    expect(count(checkpoint, "EXHAUSTED-TRY-OUTPUT-903")).toBe(1);
    const index = checkpoint.indexOf("# Evidence index");
    expect(checkpoint.indexOf("EXHAUSTED-TRY-OUTPUT-903")).toBeLessThan(index);
    const earlier = checkpoint.slice(index);
    expect(earlier).toMatch(
      /## Attempt a01 · fake\n\nSession: `ses-[^`]+`[\s\S]*EARLIER-TRY-DISCOVERY-712/,
    );
  });
});

it("a packet successor preserves the winning attempt's earlier native try output", async () => {
  const f = chainFixture({ profiles: ["a"], maxRetries: 1 }, function* (ctx) {
    if (ctx.label === "A") {
      ctx.seed("sid-A");
      yield ctx.emit({ type: "started", payload: { native_session_id: "sid-A" } });
      yield ctx.emit({
        type: "tool_call",
        tool: { name: "Read", kind: "file", use_id: "read-initial", target: "README.md" },
      });
      return yield* limitStop(ctx.emit);
    }
    yield ctx.emit({ type: "started", payload: { native_session_id: ctx.resume ?? "sid-C" } });
    if (ctx.label === "B" && ctx.nth === 1) {
      yield ctx.emit({
        type: "tool_call",
        tool: { name: "Read", kind: "file", target: "auth.ts", use_id: "read-auth" },
      });
      yield ctx.emit({
        type: "tool_result",
        tool: { name: "Read", kind: "file", use_id: "read-auth", status: "ok" },
      });
      yield ctx.emit({
        type: "message",
        text: "WINNING-ATTEMPT-EARLY-FACT-477: migration must retain the old authentication key.",
      });
      return yield* crash(ctx.emit);
    }
    yield ctx.emit({
      type: "message",
      text: ctx.label === "B" ? "WINNING-ATTEMPT-FINAL-738: tests passed." : "Done",
      final: true,
    });
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
  expect(f.spawns.filter((s) => s.label === "B").map((s) => s.resume)).toEqual(["sid-A", "sid-A"]);
  await runLabelled(f, "C", {
    mode: "ask",
    access: "readonly",
    prompt: "Continue by packet",
    continuation: continuing(b, WORK_ORDER, [a], { preference: "packet" }),
  });
  const packet = f.spawns.find((s) => s.label === "C")!;
  expect(packet.resume).toBeNull();
  expect(packet.prompt).toContain("WINNING-ATTEMPT-FINAL-738");
  expect(packet.prompt).toContain("WINNING-ATTEMPT-EARLY-FACT-477");
  // Repair's own: the final answer keeps its authority first and is not repeated;
  // the earlier try's fact follows once, under its attempt and native try.
  expect(count(packet.prompt, "WINNING-ATTEMPT-FINAL-738")).toBe(1);
  expect(count(packet.prompt, "WINNING-ATTEMPT-EARLY-FACT-477")).toBe(1);
  const authority = packet.prompt.indexOf("Final answer (final/answer.md, attempt a01):");
  expect(authority).toBeGreaterThan(-1);
  expect(authority).toBeLessThan(packet.prompt.indexOf("WINNING-ATTEMPT-EARLY-FACT-477"));
  expect(packet.prompt.slice(authority)).toMatch(
    /## Attempt a01 · fake\n\nSession: `ses-[^`]+`[\s\S]*WINNING-ATTEMPT-EARLY-FACT-477/,
  );
});
