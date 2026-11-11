/**
 * Review repair controls for the continuation evidence contract, on the
 * scripted fake harness (no vendor calls): the usable native carrier is a
 * separate question from the evidence a successor must still receive; a
 * concurrent predecessor's declared terminal source stays authoritative;
 * distinct attempt output survives a winning final answer; a route that
 * cannot read files still receives its complete work order.
 */
import { describe, expect, it, vi } from "vitest";
vi.mock("@claudexor/schema", () => import("../../schema/src/index.js"));
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import { HarnessRunSpec } from "@claudexor/schema";
import {
  WORK_ORDER,
  chainFixture,
  continuing,
  crash,
  limitStop,
  runLabelled,
  type ChainRun,
  type ChainScript,
} from "./continuation-chain.test-support.js";
import { readContinuationEvidence } from "../../workspace/src/continuation-evidence.js";
import { openContinuity } from "./continue-from.js";
import type { InRunContinuityDeps } from "./inrun-continuity-types.js";

const FB_PROSE = "FB-PROSE-7c1: the bug is in parser.ts line 40";
const STEER = "STEER-FB-31: keep the parser.ts public API";

/** Steering the live-message route recorded: admitted, then delivered to one attempt. */
function deliverSteering(run: ChainRun, attemptId: string, text: string): void {
  const file = join(run.result.runDir, "events.jsonl");
  const rows = readFileSync(file, "utf8").trim().split("\n");
  const at = rows.findIndex((line) => /"type":"run\.(failed|completed|blocked)"/.test(line));
  const row = (type: string, extra: Record<string, unknown>) =>
    JSON.stringify({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: run.result.runId,
      task_id: "t",
      type,
      payload: { message_id: "m-steer", text, ...extra },
    });
  rows.splice(
    at,
    0,
    row("message.accepted", {}),
    row("message.delivered", { attempt_id: attemptId }),
  );
  writeFileSync(file, rows.join("\n") + "\n");
}

/** A's Agent run: starts `sid-A`, edits, stops on a typed limit. */
const predecessorA: ChainScript = function* ({ label, spec, emit, seed }) {
  if (label !== "A") return;
  seed("sid-A");
  yield emit({ type: "started", observed_model: "m1", payload: { native_session_id: "sid-A" } });
  writeFileSync(join(spec.cwd, "part1.txt"), "first half\n");
  yield emit({ type: "file_change", payload: { path: "part1.txt" } });
  yield* limitStop(emit);
};

/** An attempt that works (a tool call and its result), says something, then dies. */
function* worked(ctx: Parameters<ChainScript>[0], sid: string, prose: string) {
  ctx.seed(sid);
  yield ctx.emit({ type: "started", observed_model: "m1", payload: { native_session_id: sid } });
  yield ctx.emit({
    type: "tool_call",
    tool: { name: "Read", kind: "file", use_id: "r1", target: "parser.ts" },
  });
  yield ctx.emit({
    type: "tool_result",
    tool: { name: "Read", kind: "file", use_id: "r1", status: "ok" },
  });
  yield ctx.emit({ type: "message", text: prose });
  return yield* crash(ctx.emit);
}

const finish: ChainScript = function* (ctx) {
  yield ctx.emit({ type: "started", payload: { native_session_id: ctx.resume ?? "sid-next" } });
  yield ctx.emit({ type: "message", text: "Next run done.", final: true });
  yield ctx.emit({ type: "completed" });
};

describe("a native carrier never hides the evidence it does not hold", () => {
  it("an ordinary Ask fallback's prose and the steering it received reach the successor resuming the worked session", async () => {
    const f = chainFixture({ profiles: ["a"], fallbackModel: "m2" }, function* (ctx) {
      if (ctx.label === "B" && ctx.nth === 1)
        return yield* worked(ctx, "sid-A1", "A1-PARTIAL-PROSE");
      if (ctx.label === "B") {
        ctx.seed("sid-FB");
        yield ctx.emit({
          type: "started",
          observed_model: "m2",
          payload: { native_session_id: "sid-FB" },
        });
        yield ctx.emit({ type: "message", text: FB_PROSE });
        return yield* crash(ctx.emit);
      }
      yield* finish(ctx);
    });
    const b = await runLabelled(f, "B", { mode: "ask", access: "readonly" });
    expect(b.result.lifecycle).toBe("failed");
    deliverSteering(b, "a01-fb", STEER);
    await runLabelled(f, "C", {
      mode: "ask",
      access: "readonly",
      prompt: "Continue",
      continuation: continuing(b, WORK_ORDER),
    });
    const c = f.spawns.find((s) => s.label === "C")!;
    // The worked session stays the legitimate native carrier...
    expect(c.resume).toBe("sid-A1");
    // ...and the facts it never saw arrive as labelled evidence, once, never as a command.
    expect(c.prompt).toContain(FB_PROSE);
    expect(c.prompt.match(/STEER-FB-31/g)).toHaveLength(1);
    expect(c.prompt).toContain("not part of the resumed session");
    // The resumed session already holds its own work: no duplicate.
    expect(c.prompt).not.toContain("A1-PARTIAL-PROSE");
  });

  it("a fallback that never started adds nothing to the resumed session", async () => {
    const f = chainFixture({ profiles: ["a"], fallbackModel: "m2" }, function* (ctx) {
      if (ctx.label === "B" && ctx.nth === 1)
        return yield* worked(ctx, "sid-A1", "A1-PARTIAL-PROSE");
      if (ctx.label === "B") return yield* crash(ctx.emit);
      yield* finish(ctx);
    });
    const b = await runLabelled(f, "B", { mode: "ask", access: "readonly" });
    await runLabelled(f, "C", {
      mode: "ask",
      access: "readonly",
      prompt: "Continue",
      continuation: continuing(b, WORK_ORDER),
    });
    const c = f.spawns.find((s) => s.label === "C")!;
    expect(c.resume).toBe("sid-A1");
    expect(c.prompt).not.toContain("not part of the resumed session");
  });

  it("a continued run's prose-only fallback is not lost to an older carrier (A -> B(a01, fallback) -> C)", async () => {
    const f = chainFixture({ profiles: ["a"], fallbackModel: "m2" }, function* (ctx) {
      if (ctx.label === "A") return yield* predecessorA(ctx);
      if (ctx.label === "B" && ctx.nth === 1) return yield* worked(ctx, "sid-A", "B-A01-PROSE");
      if (ctx.label === "B") {
        ctx.seed("sid-FB");
        yield ctx.emit({
          type: "started",
          observed_model: "m2",
          payload: { native_session_id: "sid-FB" },
        });
        yield ctx.emit({ type: "message", text: FB_PROSE });
        return yield* crash(ctx.emit);
      }
      yield* finish(ctx);
    });
    const a = await runLabelled(f, "A", { inPlace: true, continuation: { retain: true } });
    const b = await runLabelled(f, "B", {
      mode: "ask",
      access: "readonly",
      prompt: "Explain what is left",
      continuation: continuing(a, WORK_ORDER),
    });
    deliverSteering(b, "a01-fb", STEER);
    await runLabelled(f, "C", {
      mode: "ask",
      access: "readonly",
      prompt: "Continue",
      continuation: continuing(b, `${WORK_ORDER}\n\nExplain what is left`, [a]),
    });
    const c = f.spawns.find((s) => s.label === "C")!;
    // The fallback's own record is narration only: its inherited `acted` does not
    // make it the carrier, so B's block keeps the worked native session.
    expect(b.resumable).toMatchObject({ session: { nativeSessionId: "sid-A" } });
    expect(c.resume).toBe("sid-A");
    const outside = c.prompt.slice(c.prompt.indexOf("not part of the resumed session"));
    expect(outside).toContain(FB_PROSE);
    expect(c.prompt.match(/STEER-FB-31/g)).toHaveLength(1);
    expect(outside).toContain(STEER);
    expect(c.prompt).not.toContain("B-A01-PROSE");
  });

  it("a continued run's idle fallback that received steering never evicts the worked session", async () => {
    const f = chainFixture({ profiles: ["a"], fallbackModel: "m2" }, function* (ctx) {
      if (ctx.label === "A") return yield* predecessorA(ctx);
      if (ctx.label === "B" && ctx.nth === 1) return yield* worked(ctx, "sid-A", "B-A01-PROSE");
      if (ctx.label === "B") {
        ctx.seed("sid-FB");
        yield ctx.emit({ type: "started", payload: { native_session_id: "sid-FB" } });
        return yield* crash(ctx.emit);
      }
      yield* finish(ctx);
    });
    const a = await runLabelled(f, "A", { inPlace: true, continuation: { retain: true } });
    const b = await runLabelled(f, "B", {
      mode: "ask",
      access: "readonly",
      prompt: "Explain what is left",
      continuation: continuing(a, WORK_ORDER),
    });
    expect(b.result.lifecycle).toBe("failed");
    // The fallback's block still offers `packet`: the chain acted, so a re-brief stays possible.
    expect(b.resumable).toMatchObject({
      carriers: expect.arrayContaining(["native", "packet"]),
      session: { nativeSessionId: "sid-A" },
    });
    deliverSteering(b, "a01-fb", STEER);
    const c = await runLabelled(f, "C", {
      mode: "ask",
      access: "readonly",
      prompt: "Continue",
      continuation: continuing(b, `${WORK_ORDER}\n\nExplain what is left`, [a]),
    });
    const spawn = f.spawns.find((s) => s.label === "C")!;
    expect(spawn.resume).toBe("sid-A");
    expect(c.receipts[0]).toMatchObject({
      carrier: "native",
      from: { runId: b.result.runId, attemptId: "a01" },
    });
    expect(spawn.prompt.match(/STEER-FB-31/g)).toHaveLength(1);
    expect(spawn.prompt.slice(spawn.prompt.indexOf("not part of the resumed session"))).toContain(
      STEER,
    );
    expect(spawn.prompt).not.toContain("may not have been delivered");
  });
});

describe("a packet keeps every attempt's output once and labels the final answer", () => {
  it("a winning fallback answer does not erase the earlier attempt's distinct output", async () => {
    const f = chainFixture({ profiles: ["a"], fallbackModel: "m2" }, function* (ctx) {
      if (ctx.label === "A") return yield* predecessorA(ctx);
      if (ctx.label === "B" && ctx.nth === 1)
        return yield* worked(ctx, "sid-A", "B-A01-DISTINCT-PROSE");
      if (ctx.label === "B") {
        ctx.seed("sid-FB");
        yield ctx.emit({
          type: "started",
          observed_model: "m2",
          payload: { native_session_id: "sid-FB" },
        });
        yield ctx.emit({ type: "message", text: "FB-FINAL-ANSWER-9d", final: true });
        return yield ctx.emit({ type: "completed" });
      }
      yield* finish(ctx);
    });
    const a = await runLabelled(f, "A", { inPlace: true, continuation: { retain: true } });
    const b = await runLabelled(f, "B", {
      mode: "ask",
      access: "readonly",
      prompt: "Explain what is left",
      continuation: continuing(a, WORK_ORDER),
    });
    expect(b.result.lifecycle).toBe("succeeded");
    await runLabelled(f, "C", {
      mode: "ask",
      access: "readonly",
      prompt: "Packet please",
      continuation: continuing(b, `${WORK_ORDER}\n\nExplain what is left`, [a], {
        preference: "packet",
      }),
    });
    const c = f.spawns.find((s) => s.label === "C")!;
    expect(c.resume).toBeNull();
    expect(c.prompt).toContain("B-A01-DISTINCT-PROSE");
    expect(c.prompt.match(/FB-FINAL-ANSWER-9d/g)).toHaveLength(1);
    expect(c.prompt).toContain("Final answer (final/answer.md");
  });
});

/*
 * The parent's r2 counterexample (`.review-evidence/cx-continuity-repair2/parent-r2-preserved/
 * concurrent-delayed-events.test.ts`, sha256 6c681cd5…): a real n=2 Agent race whose
 * second candidate emits nothing until the first ends. Its declared-carrier assertions
 * are kept verbatim. Its last assertion (`evidence.attempts` equal to ["a01"]) asserted
 * the repair's own exclusion of concurrent alternatives by event timing, which that
 * scenario disproves; the exclusion is withdrawn. The replacement falsifies the chosen
 * contract instead: the declared session carries, and the other candidate's recorded
 * work reaches the successor once, attributed to its attempt and labelled as not part
 * of the resumed session's history, whatever the event interleaving.
 */
async function raceA(
  delayed: boolean,
): Promise<{ f: ReturnType<typeof chainFixture>; a: ChainRun }> {
  const f = chainFixture({ profiles: ["a"] }, function* (ctx) {
    if (ctx.label === "C") return yield* finish(ctx);
    const second = ctx.cwd.includes("/a02/");
    const sid = second ? "sid-independent-two" : "sid-independent-one";
    ctx.seed(sid);
    yield ctx.emit({ type: "started", payload: { native_session_id: sid } });
    yield ctx.emit({
      type: "tool_call",
      tool: { name: "Read", kind: "file", use_id: "r", target: second ? "two.ts" : "one.ts" },
    });
    yield ctx.emit({
      type: "message",
      text: second ? "INDEPENDENT-ALTERNATIVE-TWO" : "DECLARED-CANDIDATE-ONE",
    });
    yield* crash(ctx.emit);
  });
  if (delayed) {
    let release!: () => void;
    const firstEnded = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.adapter.run.bind(f.adapter);
    f.adapter.run = async function* (spec) {
      const second = spec.cwd.includes("/a02/");
      if (second && f.label.current === "A") await firstEnded;
      try {
        yield* original(spec);
      } finally {
        if (!second) release();
      }
    };
  }
  const a = await runLabelled(f, "A", { n: 2, review: undefined });
  return { f, a };
}

describe("a concurrent predecessor's other candidate is separate evidence, never inferred lineage", () => {
  it("concurrent candidates remain concurrent when a vendor emits no events until its peer ends", async () => {
    const { a } = await raceA(true);
    expect(a.result.lifecycle).toBe("failed");
    expect((a.resumable?.["session"] as { nativeSessionId: string }).nativeSessionId).toBe(
      "sid-independent-one",
    );
    const evidence = readContinuationEvidence(a.result.runDir);
    expect(evidence.held?.capsule.nativeSessionId).toBe("sid-independent-one");
    // Replaces the withdrawn `toEqual(["a01"])`: every candidate is evidence, and only
    // the held attempt's own session counts as its history. Their order is event
    // timing (under load the delayed peer's first engine row can still come first),
    // so no assertion depends on it.
    expect([...evidence.attempts].sort()).toEqual(["a01", "a02"]);
    expect(evidence.uncovered).toEqual(["a02"]);
  });

  it.each([true, false])(
    "the successor resumes the declared session and receives the other candidate as attributed evidence (delayed peer: %s)",
    async (delayed) => {
      const { f, a } = await raceA(delayed);
      await runLabelled(f, "C", { continuation: continuing(a, WORK_ORDER), inPlace: true });
      const c = f.spawns.find((s) => s.label === "C")!;
      expect(c.resume).toBe("sid-independent-one");
      const at = c.prompt.indexOf("It is not part of the resumed session's history");
      expect(at).toBeGreaterThan(-1);
      const outside = c.prompt.slice(at);
      expect(outside).toContain("## Attempt a02");
      expect(outside).toContain("INDEPENDENT-ALTERNATIVE-TWO");
      expect(outside).toContain("- Read — two.ts (unresolved: no result recorded) · attempt a02");
      expect(c.prompt.match(/INDEPENDENT-ALTERNATIVE-TWO/g)).toHaveLength(1);
      // The resumed session holds its own work: nothing of it is replayed.
      expect(c.prompt).not.toContain("DECLARED-CANDIDATE-ONE");
      expect(c.prompt).not.toContain("one.ts");
    },
  );

  it("a packet successor keeps both candidates, each attributed to its attempt", async () => {
    const { f, a } = await raceA(true);
    await runLabelled(f, "C", {
      continuation: continuing(a, WORK_ORDER, [], { preference: "packet" }),
      inPlace: true,
    });
    const c = f.spawns.find((s) => s.label === "C")!;
    expect(c.resume).toBeNull();
    expect(c.prompt).toContain("## Attempt a01");
    expect(c.prompt).toContain("## Attempt a02");
    expect(c.prompt).toContain("- Read — one.ts (unresolved: no result recorded) · attempt a01");
    expect(c.prompt).toContain("- Read — two.ts (unresolved: no result recorded) · attempt a02");
  });
});

describe("a concurrent predecessor keeps its declared terminal source", () => {
  it("an n=1 successor of a failed n=2 Agent race resumes the session its terminal block names", async () => {
    const f = chainFixture({ profiles: ["a"] }, function* (ctx) {
      if (ctx.label === "A") {
        const second = ctx.cwd.includes("/a02/");
        const sid = second ? "sid-R2" : "sid-R1";
        ctx.seed(sid);
        yield ctx.emit({ type: "started", payload: { native_session_id: sid } });
        if (second) {
          yield ctx.emit({
            type: "tool_call",
            tool: { name: "Read", kind: "file", use_id: "x", target: "a" },
          });
          yield ctx.emit({
            type: "tool_result",
            tool: { name: "Read", kind: "file", use_id: "x", status: "ok" },
          });
        }
        return yield* crash(ctx.emit);
      }
      yield* finish(ctx);
    });
    // best-of needs the review stage enabled (run-strategy); both candidates die before it.
    const a = await runLabelled(f, "A", { n: 2, review: undefined });
    expect(a.result.lifecycle).toBe("failed");
    const declared = (a.resumable?.["session"] as { nativeSessionId: string } | null)
      ?.nativeSessionId;
    expect(declared).toBe("sid-R1");
    await runLabelled(f, "C", { continuation: continuing(a, WORK_ORDER), inPlace: true });
    expect(f.spawns.find((s) => s.label === "C")!.resume).toBe(declared);
  });
});

describe("a route that cannot read files receives the complete work order", () => {
  it("a raw-context-packet successor gets the whole work order inline, not only a path", async () => {
    const long = `${WORK_ORDER}\n${"Requirement line. ".repeat(600)}\nREQUIRED-TAIL-OF-THE-WORK-ORDER`;
    const f = chainFixture({ profiles: ["a"] }, predecessorA);
    const a = await runLabelled(f, "A", {
      inPlace: true,
      prompt: long,
      continuation: { retain: true },
    });
    const plan = async (implementationTransport: "workspace" | "git_patch_envelope") => {
      const runDir = join(f.root, `.successor-${implementationTransport}`);
      const deps = {
        adapter: { id: "raw" },
        runId: "run-successor",
        attemptId: "a01",
        runDir,
        attemptDir: join(runDir, "attempts", "a01"),
        cwd: f.root,
        workspace: { kind: "in_place", root: f.root },
        workOrder: "Finish",
        firstPrompt: "Finish",
        registry: [],
        route: { adapter: { id: "raw" }, knownModels: [], implementationTransport },
        newSessionId: () => "ses-y",
        emit: () => {},
        thread: null,
      } as unknown as InRunContinuityDeps;
      const opened = await openContinuity(deps, {
        spec: HarnessRunSpec.parse({
          session_id: "ses-x",
          intent: "implement",
          prompt: "Finish",
          cwd: f.root,
          access: "workspace_write",
        }),
        continuation: continuing(a, long),
        store: new ArtifactStore(f.root),
        telemetry: { requestedModel: null },
      });
      return opened.spec.prompt;
    };
    // A file-capable route keeps the bounded index plus the readable path.
    expect(await plan("workspace")).not.toContain("REQUIRED-TAIL-OF-THE-WORK-ORDER");
    const readless = await plan("git_patch_envelope");
    expect(readless).toContain("REQUIRED-TAIL-OF-THE-WORK-ORDER");
    expect(readless.match(/REQUIRED-TAIL-OF-THE-WORK-ORDER/g)).toHaveLength(1);
  });
});

/*
 * Astra r1 review repros, verbatim assertions (`chain-review/later-evidence.repro.test.ts`,
 * sha256 in .review-evidence/cx-continuity-repair/astra-repro-verbatim.sha256); only the
 * import paths are adapted to this package.
 */
describe("review: current evidence must reach successor even with an older native carrier", () => {
  it("preserves a fallback-only partial report on the following native continuation", async () => {
    const f = chainFixture({ profiles: ["a"], fallbackModel: "m2" }, function* (ctx) {
      if (ctx.label === "A") {
        ctx.seed("sid-A");
        yield ctx.emit({ type: "started", payload: { native_session_id: "sid-A" } });
        yield ctx.emit({
          type: "tool_call",
          tool: { name: "Read", kind: "file", use_id: "r1", target: "README.md" },
        });
        return yield* limitStop(ctx.emit);
      }
      if (ctx.label === "B" && ctx.nth === 1) {
        yield ctx.emit({ type: "started", payload: { native_session_id: "sid-A" } });
        yield ctx.emit({
          type: "tool_call",
          tool: { name: "Read", kind: "file", use_id: "r2", target: "README.md" },
        });
        return yield* crash(ctx.emit);
      }
      if (ctx.label === "B") {
        ctx.seed("sid-FB");
        yield ctx.emit({ type: "started", payload: { native_session_id: "sid-FB" } });
        yield ctx.emit({
          type: "message",
          text: "FALLBACK-ONLY-FACT: the auth failure comes from the expired token.",
        });
        return yield* crash(ctx.emit);
      }
      yield ctx.emit({ type: "started", payload: { native_session_id: ctx.resume ?? "sid-C" } });
      yield ctx.emit({ type: "message", final: true, text: "done" });
      yield ctx.emit({ type: "completed" });
    });
    const a = await runLabelled(f, "A", { inPlace: true, continuation: { retain: true } });
    const b = await runLabelled(f, "B", {
      mode: "ask",
      access: "readonly",
      prompt: "Explain what remains",
      continuation: continuing(a, WORK_ORDER),
    });
    await runLabelled(f, "C", {
      mode: "ask",
      access: "readonly",
      prompt: "Continue",
      continuation: continuing(b, WORK_ORDER, [a]),
    });
    const c = f.spawns.find((s) => s.label === "C")!;
    expect(c.resume === "sid-FB" || c.prompt.includes("FALLBACK-ONLY-FACT")).toBe(true);
  });

  it("preserves steering delivered only to a later unworked fallback when resuming the earlier carrier", async () => {
    const f = chainFixture({ profiles: ["a"], fallbackModel: "m2" }, function* (ctx) {
      if (ctx.label === "A") {
        ctx.seed("sid-A");
        yield ctx.emit({ type: "started", payload: { native_session_id: "sid-A" } });
        yield ctx.emit({
          type: "tool_call",
          tool: { name: "Read", kind: "file", use_id: "r1", target: "README.md" },
        });
        return yield* limitStop(ctx.emit);
      }
      if (ctx.label === "B" && ctx.nth === 1) {
        yield ctx.emit({ type: "started", payload: { native_session_id: "sid-A" } });
        yield ctx.emit({
          type: "tool_call",
          tool: { name: "Read", kind: "file", use_id: "r2", target: "README.md" },
        });
        return yield* crash(ctx.emit);
      }
      if (ctx.label === "B") {
        ctx.seed("sid-FB");
        yield ctx.emit({ type: "started", payload: { native_session_id: "sid-FB" } });
        return yield* crash(ctx.emit);
      }
      yield ctx.emit({ type: "started", payload: { native_session_id: ctx.resume ?? "sid-C" } });
      yield ctx.emit({ type: "message", final: true, text: "done" });
      yield ctx.emit({ type: "completed" });
    });
    const a = await runLabelled(f, "A", { inPlace: true, continuation: { retain: true } });
    const b = await runLabelled(f, "B", {
      mode: "ask",
      access: "readonly",
      prompt: "Explain what remains",
      continuation: continuing(a, WORK_ORDER),
    });
    const file = join(b.result.runDir, "events.jsonl");
    const rows = readFileSync(file, "utf8").trim().split("\n");
    const terminal = rows.findIndex((line) => line.includes('"type":"run.failed"'));
    const message = (type: string, extra: Record<string, unknown>) =>
      JSON.stringify({
        seq: 0,
        ts: new Date().toISOString(),
        run_id: b.result.runId,
        task_id: "t",
        type,
        payload: {
          message_id: "m-review",
          text: "STEER-ONLY-TO-FALLBACK: preserve the old authentication key until migration completes",
          ...extra,
        },
      });
    rows.splice(
      terminal,
      0,
      message("message.accepted", {}),
      message("message.delivered", { attempt_id: "a01-fb" }),
    );
    writeFileSync(file, rows.join("\n") + "\n");
    await runLabelled(f, "C", {
      mode: "ask",
      access: "readonly",
      prompt: "Continue",
      continuation: continuing(b, WORK_ORDER, [a]),
    });
    const c = f.spawns.find((s) => s.label === "C")!;
    expect(c.resume === "sid-FB" || c.prompt.includes("STEER-ONLY-TO-FALLBACK")).toBe(true);
  });

  it("preserves both distinct B reports in a packet continuation after fallback success", async () => {
    const f = chainFixture({ profiles: ["a"], fallbackModel: "m2" }, function* (ctx) {
      if (ctx.label === "A") {
        ctx.seed("sid-A");
        yield ctx.emit({ type: "started", payload: { native_session_id: "sid-A" } });
        yield ctx.emit({
          type: "tool_call",
          tool: { name: "Read", kind: "file", use_id: "r1", target: "README.md" },
        });
        return yield* limitStop(ctx.emit);
      }
      if (ctx.label === "B" && ctx.nth === 1) {
        yield ctx.emit({ type: "started", payload: { native_session_id: "sid-A" } });
        yield ctx.emit({
          type: "tool_call",
          tool: { name: "Read", kind: "file", use_id: "r2", target: "README.md" },
        });
        yield ctx.emit({
          type: "message",
          text: "B-FIRST-DISTINCT-FACT: settings use the persisted migration version.",
        });
        return yield* crash(ctx.emit);
      }
      if (ctx.label === "B") {
        ctx.seed("sid-FB");
        yield ctx.emit({ type: "started", payload: { native_session_id: "sid-FB" } });
        yield ctx.emit({
          type: "message",
          text: "B-SECOND-DISTINCT-FACT: tests are ready.",
          final: true,
        });
        return yield ctx.emit({ type: "completed" });
      }
      yield ctx.emit({ type: "started", payload: { native_session_id: "sid-C" } });
      yield ctx.emit({ type: "message", final: true, text: "done" });
      yield ctx.emit({ type: "completed" });
    });
    const a = await runLabelled(f, "A", { inPlace: true, continuation: { retain: true } });
    const b = await runLabelled(f, "B", {
      mode: "ask",
      access: "readonly",
      prompt: "Explain what remains",
      continuation: continuing(a, WORK_ORDER),
    });
    expect(b.result.lifecycle).toBe("succeeded");
    await runLabelled(f, "C", {
      mode: "ask",
      access: "readonly",
      prompt: "Continue",
      continuation: continuing(b, WORK_ORDER, [a], { preference: "packet" }),
    });
    const c = f.spawns.find((s) => s.label === "C")!;
    expect(c.prompt).toContain("B-FIRST-DISTINCT-FACT");
    expect(c.prompt).toContain("B-SECOND-DISTINCT-FACT");
  });
});
