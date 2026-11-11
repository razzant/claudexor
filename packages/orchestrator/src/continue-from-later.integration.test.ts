/**
 * A continued run's LATER attempts and the next link of the chain (#412, with
 * the delivery, steering and history-quality facts it depends on), on the
 * scripted fake harness: A -> B(a01, fallback) -> C, where B's fallback is a
 * new attempt of the same run. The fake's "native history" is a file per
 * session id; nothing here exercises a vendor.
 */
import { describe, expect, it, vi } from "vitest";
vi.mock("@claudexor/schema", () => import("../../schema/src/index.js"));
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import { retainedEnvelopeOfRun } from "@claudexor/workspace";
import { HarnessRunSpec } from "@claudexor/schema";
import {
  WORK_ORDER,
  chainFixture,
  continuing,
  crash,
  limitStop,
  runLabelled,
  type ChainScript,
} from "./continuation-chain.test-support.js";
import { CONTINUATION_PACKET_SENTINEL } from "./continuation.js";
import { openContinuity } from "./continue-from.js";
import type { InRunContinuityDeps } from "./inrun-continuity-types.js";

/** A: an Agent run that starts `sid-A`, edits, and stops on a typed limit. */
const predecessorA: ChainScript = function* ({ label, spec, emit, seed }) {
  if (label !== "A") return;
  seed("sid-A");
  yield emit({ type: "started", observed_model: "m1", payload: { native_session_id: "sid-A" } });
  writeFileSync(join(spec.cwd, "part1.txt"), "first half\n");
  yield emit({ type: "file_change", payload: { path: "part1.txt" } });
  yield* limitStop(emit);
};

/** B's first attempt resumes `sid-A`, reads and answers partially, then dies. */
const bFirst: ChainScript = function* ({ emit }) {
  yield emit({ type: "started", observed_model: "m1", payload: { native_session_id: "sid-A" } });
  yield emit({ type: "message", text: "B-A01-PARTIAL: the first half is in part1.txt" });
  yield emit({
    type: "tool_call",
    tool: { name: "Read", kind: "file", use_id: "r1", target: "part1.txt" },
  });
  yield emit({
    type: "tool_result",
    tool: { name: "Read", kind: "file", use_id: "r1", status: "ok" },
  });
  yield* crash(emit);
};

function askChain(fallback: "succeeds" | "fails" | "never starts") {
  return chainFixture({ profiles: ["a"], fallbackModel: "m2" }, function* (ctx) {
    if (ctx.label === "A") return yield* predecessorA(ctx);
    if (ctx.label === "B" && ctx.nth === 1) return yield* bFirst(ctx);
    if (ctx.label === "B") {
      if (fallback === "never starts") return yield* crash(ctx.emit);
      ctx.seed("sid-FB");
      yield ctx.emit({
        type: "started",
        observed_model: "m2",
        payload: { native_session_id: "sid-FB" },
      });
      yield ctx.emit({
        type: "tool_call",
        tool: { name: "Grep", kind: "search", use_id: "g1", target: "half" },
      });
      yield ctx.emit({
        type: "tool_result",
        tool: { name: "Grep", kind: "search", use_id: "g1", status: "ok" },
      });
      if (fallback === "fails") {
        yield ctx.emit({ type: "message", text: "B-FALLBACK-PARTIAL" });
        return yield* crash(ctx.emit);
      }
      yield ctx.emit({ type: "message", text: "B-FALLBACK-ANSWER: finish part2", final: true });
      return yield ctx.emit({ type: "completed" });
    }
    yield ctx.emit({
      type: "started",
      observed_model: "m1",
      payload: { native_session_id: ctx.resume ?? "sid-C" },
    });
    yield ctx.emit({ type: "message", text: "C done", final: true });
    yield ctx.emit({ type: "completed" });
  });
}

async function runChain(fallback: "succeeds" | "fails" | "never starts") {
  const f = askChain(fallback);
  const a = await runLabelled(f, "A", { inPlace: true, continuation: { retain: true } });
  const b = await runLabelled(f, "B", {
    mode: "ask",
    access: "readonly",
    prompt: "Explain what is left",
    continuation: continuing(a, WORK_ORDER),
  });
  const c = await runLabelled(f, "C", {
    mode: "ask",
    access: "readonly",
    prompt: "Continue",
    continuation: continuing(b, `${WORK_ORDER}\n\nExplain what is left`, [a]),
  });
  return { f, a, b, c };
}

describe("#412 a continued Ask's fallback attempt and the next link", () => {
  it.each(["succeeds", "fails"] as const)(
    "the fallback is re-briefed from the chain and this run's earlier work; C resumes the fallback's session when it %s",
    async (fallback) => {
      const { f, b, c } = await runChain(fallback);
      const [bFirstSpawn, bFallback] = f.spawns.filter((s) => s.label === "B");
      expect(bFirstSpawn).toMatchObject({ resume: "sid-A", model: "m1" });
      // The new attempt keeps its explicit fallback model and never re-plans A's session.
      expect(bFallback).toMatchObject({ resume: null, model: "m2" });
      expect(bFallback!.prompt).toContain("Evidence index");
      expect(bFallback!.prompt).toContain(WORK_ORDER);
      expect(bFallback!.prompt).toContain("B-A01-PARTIAL");
      expect(bFallback!.prompt).toContain("- Read — part1.txt (completed)");
      expect(bFallback!.prompt).toContain("Explain what is left");
      const fallbackReceipt = b.receipts.find((r) => r["attemptId"] === "a01-fb");
      expect(fallbackReceipt).toMatchObject({
        tryIndex: 0,
        carrier: "packet",
        memory: "partial",
        from: { runId: b.result.runId, attemptId: "a01" },
        workspace: "same_root",
        inputDelivery: "confirmed",
      });
      if (fallback === "succeeds") {
        expect(b.result.lifecycle).toBe("succeeded");
        // The completed winner speaks for the run: no failed attempt's block survives it.
        expect(b.resumable).toBeUndefined();
        expect(existsSync(join(b.result.runDir, "final", "resumable.yaml"))).toBe(false);
      } else {
        expect(b.resumable).toMatchObject({ session: { nativeSessionId: "sid-FB" } });
      }
      const cSpawn = f.spawns.find((s) => s.label === "C")!;
      expect(cSpawn.resume).toBe("sid-FB");
      expect(c.receipts[0]).toMatchObject({
        carrier: "native",
        memory: "partial",
        from: { runId: b.result.runId, attemptId: "a01-fb" },
      });
    },
  );

  it("a fallback that never started cannot evict the earlier carrier", async () => {
    const { f, b, c } = await runChain("never starts");
    expect(b.result.lifecycle).toBe("failed");
    expect(f.spawns.find((s) => s.label === "C")!.resume).toBe("sid-A");
    expect(c.receipts[0]).toMatchObject({
      carrier: "native",
      memory: "full",
      from: { runId: b.result.runId, attemptId: "a01" },
    });
  });

  it("in an ordinary Ask run, a fallback that started and did nothing leaves the worked session the carrier", async () => {
    const f = chainFixture({ profiles: ["a"], fallbackModel: "m2" }, function* (ctx) {
      if (ctx.label === "A" && ctx.nth === 1) {
        ctx.seed("sid-A1");
        yield ctx.emit({
          type: "started",
          observed_model: "m1",
          payload: { native_session_id: "sid-A1" },
        });
        yield ctx.emit({ type: "message", text: "A1-WORK: half of the answer" });
        yield ctx.emit({
          type: "tool_call",
          tool: { name: "Read", kind: "file", use_id: "r1", target: "a.md" },
        });
        return yield* crash(ctx.emit);
      }
      if (ctx.label === "A") {
        ctx.seed("sid-A2");
        yield ctx.emit({
          type: "started",
          observed_model: "m2",
          payload: { native_session_id: "sid-A2" },
        });
        return yield* crash(ctx.emit);
      }
      yield ctx.emit({ type: "started", payload: { native_session_id: ctx.resume ?? "sid-C" } });
      yield ctx.emit({ type: "message", text: "C done", final: true });
      yield ctx.emit({ type: "completed" });
    });
    const a = await runLabelled(f, "A", { mode: "ask", access: "readonly" });
    expect(f.spawns.filter((s) => s.label === "A").map((s) => s.model)).toEqual(["m1", "m2"]);
    expect(a.resumable).toMatchObject({ session: { nativeSessionId: "sid-A1" } });
    const c = await runLabelled(f, "C", {
      mode: "ask",
      access: "readonly",
      prompt: "Continue",
      continuation: continuing(a, WORK_ORDER),
    });
    expect(f.spawns.find((s) => s.label === "C")!.resume).toBe("sid-A1");
    expect(c.receipts[0]).toMatchObject({
      carrier: "native",
      memory: "full",
      from: { runId: a.result.runId, attemptId: "a01" },
    });
  });

  it("steering is a run fact: a message delivered by the fallback is delivered once, never also uncertain", async () => {
    const { b, f } = await runChain("fails");
    const file = join(b.result.runDir, "events.jsonl");
    const rows = readFileSync(file, "utf8").trim().split("\n");
    const at = rows.findIndex((line) => line.includes('"type":"run.failed"'));
    const message = (type: string, extra: Record<string, unknown>) =>
      JSON.stringify({
        seq: 0,
        ts: new Date().toISOString(),
        run_id: b.result.runId,
        task_id: "t",
        type,
        payload: { message_id: "m1", text: "STEER-ME: keep part1 intact", ...extra },
      });
    rows.splice(
      at,
      0,
      message("message.accepted", {}),
      message("message.delivered", { attempt_id: "a01-fb" }),
    );
    writeFileSync(file, rows.join("\n") + "\n");
    f.label.current = "D";
    const d = await runLabelled(f, "D", {
      mode: "ask",
      access: "readonly",
      prompt: "Packet please",
      continuation: continuing(b, WORK_ORDER, [], { preference: "packet" }),
    });
    const prompt = f.spawns.find((s) => s.label === "D")!.prompt;
    expect(prompt.match(/STEER-ME/g)).toHaveLength(1);
    expect(prompt).toContain("(delivered)\n\nSTEER-ME");
    expect(prompt).not.toContain("may not have been delivered");
    expect(d.receipts[0]).toMatchObject({ carrier: "packet", inputDelivery: "confirmed" });
  });
});

describe("#412 the D-16d checkpoint continuation of a continued Ask", () => {
  it("carries the chain's work order and ancestral evidence, with the exhausted output only in its checkpoint", async () => {
    const f = chainFixture({ profiles: ["a"] }, function* (ctx) {
      if (ctx.label === "A") return yield* predecessorA(ctx);
      if (ctx.nth === 1) {
        yield ctx.emit({
          type: "started",
          observed_model: "m1",
          payload: { native_session_id: "sid-A" },
        });
        yield ctx.emit({ type: "message", text: "EXHAUSTED-PARTIAL-OUTPUT", final: true });
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
      yield ctx.emit({
        type: "started",
        observed_model: "m1",
        payload: { native_session_id: "sid-CONT" },
      });
      yield ctx.emit({ type: "message", text: "Finished after the checkpoint.", final: true });
      yield ctx.emit({ type: "completed" });
    });
    const a = await runLabelled(f, "A", { inPlace: true, continuation: { retain: true } });
    const b = await runLabelled(f, "B", {
      mode: "ask",
      access: "readonly",
      prompt: "Explain what is left",
      continuation: continuing(a, WORK_ORDER),
    });
    expect(b.events.map((e) => e.type)).toContain("run.continuation");
    const cont = f.spawns.filter((s) => s.label === "B")[1]!;
    expect(cont.prompt).toContain(CONTINUATION_PACKET_SENTINEL);
    expect(cont.prompt).toContain(WORK_ORDER);
    expect(cont.prompt).toContain("Evidence index");
    expect(cont.prompt.match(/EXHAUSTED-PARTIAL-OUTPUT/g)).toHaveLength(1);
    expect(b.receipts.find((r) => r["attemptId"] === "a01-cont")).toMatchObject({
      carrier: "packet",
      cause: "context_exhausted",
      from: { runId: b.result.runId, attemptId: "a01" },
    });
  });
});

describe("#412 the D-16d checkpoint continuation of a continued Agent", () => {
  it("re-grounds the enveloped continuation with the chain's evidence, never a second plan", async () => {
    const f = chainFixture({ profiles: ["a"] }, function* (ctx) {
      if (ctx.label === "A") return yield* predecessorA(ctx);
      if (ctx.nth === 1) {
        yield ctx.emit({
          type: "started",
          observed_model: "m1",
          payload: { native_session_id: "sid-A" },
        });
        writeFileSync(join(ctx.spec.cwd, "part2.txt"), "second half, partial\n");
        yield ctx.emit({ type: "file_change", payload: { path: "part2.txt" } });
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
      yield ctx.emit({
        type: "started",
        observed_model: "m1",
        payload: { native_session_id: "sid-CONT" },
      });
      yield ctx.emit({ type: "message", text: "Finished after the checkpoint.", final: true });
      yield ctx.emit({ type: "completed" });
    });
    const a = await runLabelled(f, "A", { inPlace: false, continuation: { retain: true } });
    const b = await runLabelled(f, "B", {
      inPlace: false,
      prompt: "Finish part two",
      continuation: {
        ...continuing(a, WORK_ORDER),
        adopt: retainedEnvelopeOfRun(a.result.runDir, a.result.runId),
      },
    });
    expect(b.events.map((e) => e.type)).toContain("run.continuation");
    const [first, cont] = f.spawns.filter((s) => s.label === "B");
    expect(first).toMatchObject({ resume: "sid-A" });
    expect(cont).toMatchObject({ resume: null, cwd: first!.cwd });
    expect(cont!.prompt).toContain(CONTINUATION_PACKET_SENTINEL);
    expect(cont!.prompt).toContain(WORK_ORDER);
    expect(cont!.prompt).toContain("Evidence index");
    expect(b.receipts.find((r) => r["attemptId"] === "a01c")).toMatchObject({
      tryIndex: 0,
      carrier: "packet",
      cause: "context_exhausted",
      from: { runId: b.result.runId, attemptId: "a01" },
      workspace: "same_root",
    });
  });
});

describe("delivery and history quality of continued tries", () => {
  it("a mismatched handshake is not delivery: the next try still carries the caller's text as uncertain", async () => {
    const f = chainFixture({ profiles: ["a"], maxRetries: 2 }, function* (ctx) {
      if (ctx.label === "A") return yield* predecessorA(ctx);
      if (ctx.nth === 1) {
        yield ctx.emit({ type: "started", payload: { native_session_id: "sid-STRANGER" } });
        return yield ctx.emit({ type: "completed", aborted: true });
      }
      yield ctx.emit({ type: "started", payload: { native_session_id: "sid-PACKET" } });
      yield ctx.emit({ type: "message", text: "Done", final: true });
      yield ctx.emit({ type: "completed" });
    });
    const a = await runLabelled(f, "A", { inPlace: true, continuation: { retain: true } });
    const b = await runLabelled(f, "B", {
      inPlace: true,
      prompt: "CALLER-CORRECTION-91",
      continuation: continuing(a, WORK_ORDER),
    });
    expect(b.receipts.map((r) => [r["tryIndex"], r["identityCheck"], r["inputDelivery"]])).toEqual([
      [0, "mismatch_before_effects", "confirmed"],
      [1, "not_applicable", "uncertain"],
    ]);
    const second = f.spawns.filter((s) => s.label === "B")[1]!.prompt;
    expect(second).toContain("may not have been delivered");
    expect(second).toContain("CALLER-CORRECTION-91");
  });

  it("a packet-born session stays partial on a successor's native resume and its in-run resume", async () => {
    const f = chainFixture({ profiles: ["a"], maxRetries: 2 }, function* (ctx) {
      if (ctx.label === "A" && ctx.nth === 1) {
        yield ctx.emit({ type: "started", payload: {} });
        writeFileSync(join(ctx.spec.cwd, "part1.txt"), "first half\n");
        yield ctx.emit({ type: "file_change", payload: { path: "part1.txt" } });
        return yield* crash(ctx.emit);
      }
      if (ctx.label === "A") {
        ctx.seed("sid-P");
        yield ctx.emit({ type: "started", payload: { native_session_id: "sid-P" } });
        return yield* limitStop(ctx.emit);
      }
      yield ctx.emit({ type: "started", payload: { native_session_id: "sid-P" } });
      if (ctx.nth === 1) return yield* crash(ctx.emit);
      yield ctx.emit({ type: "message", text: "Done", final: true });
      yield ctx.emit({ type: "completed" });
    });
    const a = await runLabelled(f, "A", { inPlace: true, continuation: { retain: true } });
    expect(a.receipts).toMatchObject([{ carrier: "packet", memory: "partial" }]);
    const b = await runLabelled(f, "B", {
      inPlace: true,
      prompt: "Finish",
      continuation: continuing(a, WORK_ORDER),
    });
    expect(f.spawns.filter((s) => s.label === "B").map((s) => s.resume)).toEqual([
      "sid-P",
      "sid-P",
    ]);
    expect(b.receipts.map((r) => [r["carrier"], r["memory"]])).toEqual([
      ["native", "partial"],
      ["native", "partial"],
    ]);
  });

  it("names the complete work order when its section is cut, with the true size", async () => {
    const long = `${WORK_ORDER}\n${"Spec line. ".repeat(1200)}\nLAST-LINE-OF-THE-WORK-ORDER`;
    const f = chainFixture({ profiles: ["a"] }, function* (ctx) {
      if (ctx.label === "A") return yield* predecessorA(ctx);
      yield ctx.emit({ type: "started", payload: { native_session_id: "sid-B" } });
      yield ctx.emit({ type: "message", text: "Done", final: true });
      yield ctx.emit({ type: "completed" });
    });
    const a = await runLabelled(f, "A", {
      inPlace: true,
      prompt: long,
      continuation: { retain: true },
    });
    const b = await runLabelled(f, "B", {
      inPlace: true,
      prompt: "Finish",
      continuation: continuing(a, long, [], { preference: "packet" }),
    });
    const path = join(b.result.runDir, "context", "work-order.md");
    const prompt = f.spawns.find((s) => s.label === "B")!.prompt;
    expect(prompt).toContain(
      `the whole work order is ${Buffer.byteLength(long)} bytes. It is complete in the file ${path}.]`,
    );
    expect(prompt).toContain(`- Complete work order: ${path}`);
    expect(prompt).not.toContain("LAST-LINE-OF-THE-WORK-ORDER");
    expect(readFileSync(path, "utf8")).toContain("LAST-LINE-OF-THE-WORK-ORDER");
  });
});

describe("an attempt's own model choice", () => {
  it("wins over the inherited predecessor model even when it is the first attempt to plan", async () => {
    const f = chainFixture({ profiles: ["a"] }, predecessorA);
    const a = await runLabelled(f, "A", { inPlace: true, continuation: { retain: true } });
    const spec = HarnessRunSpec.parse({
      session_id: "ses-x",
      intent: "explain",
      prompt: "Explain",
      cwd: f.root,
      access: "readonly",
      model_hint: "m2",
    });
    const plan = async (explicitModel: boolean) => {
      const runDir = join(f.root, `.successor-${explicitModel}`);
      const deps = {
        adapter: f.adapter,
        runId: "run-successor",
        attemptId: "a01-fb",
        runDir,
        attemptDir: join(runDir, "attempts", "a01-fb"),
        cwd: f.root,
        workspace: { kind: "in_place", root: f.root },
        workOrder: "Explain",
        firstPrompt: "Explain",
        registry: [],
        route: { adapter: f.adapter, knownModels: [] },
        newSessionId: () => "ses-y",
        emit: () => {},
        thread: null,
        explicitModel,
      } as unknown as InRunContinuityDeps;
      const telemetry = { requestedModel: "m2" as string | null };
      const opened = await openContinuity(deps, {
        spec,
        continuation: continuing(a, WORK_ORDER, [], { inheritModel: true }),
        store: new ArtifactStore(f.root),
        telemetry,
      });
      return [opened.spec.model_hint, telemetry.requestedModel];
    };
    expect(await plan(false)).toEqual(["m1", "m1"]);
    expect(await plan(true)).toEqual(["m2", "m2"]);
  });
});
