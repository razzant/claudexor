import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  run,
  seedSession,
  limit,
  crash,
  fileStoreContinuity,
} from "./inrun-continuity.test-support.js";

describe("native carrier custody", () => {
  it("never requests the source holder's id on a target whose packet died before started", async () => {
    const o = await run({
      mode: "ask",
      profiles: ["a", "b"],
      continuity: null,
      script: function* ({ profile, emit, tryOfProfile }) {
        if (profile === "a") {
          yield emit({ type: "started", payload: { native_session_id: "sid-source" } });
          yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
          yield* limit(emit);
        } else if (tryOfProfile === 1) {
          yield* crash(emit);
        } else {
          yield emit({ type: "started", payload: { native_session_id: "sid-target" } });
          yield emit({ type: "message", text: "finished", final: true });
          yield emit({ type: "completed" });
        }
      },
    });
    expect(o.spawns.map((s) => [s.profile, s.resume])).toEqual([
      ["a", null],
      ["b", null],
      ["b", null],
    ]);
    expect(o.receipts.map((r) => r["carrier"])).toEqual(["packet", "packet"]);
  });

  it("publishes the target capsule before retiring the source", async () => {
    const order: string[] = [];
    const store = fileStoreContinuity();
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      continuity: {
        ...store,
        async move(located, _from, to) {
          const dest = join(String(to.CLAUDEXOR_PROFILE_LOCATOR), "sessions", "sid-order.jsonl");
          mkdirSync(join(dest, ".."), { recursive: true });
          writeFileSync(dest, readFileSync(located.file));
          order.push("copied");
          return {
            ok: true,
            resumeRef: { nativeSessionId: "sid-order" },
            retire() {
              const projects = join(process.env.CLAUDEXOR_CONFIG_DIR!, "projects");
              const capsules = readdirSync(projects).flatMap((project) => {
                const runs = join(projects, project, "runs");
                return readdirSync(runs).flatMap((runId) => {
                  const attempts = join(runs, runId, "attempts");
                  return readdirSync(attempts).map((attempt) =>
                    JSON.parse(
                      readFileSync(join(attempts, attempt, "session-capsule.json"), "utf8"),
                    ),
                  );
                });
              });
              const capsule = capsules.find((c) => c.nativeSessionId === "sid-order");
              expect(capsule).toMatchObject({ holderProfileId: "b", file: dest });
              expect(existsSync(located.file)).toBe(true);
              order.push("published");
              rmSync(located.file);
              order.push("retired");
            },
          };
        },
      },
      script: function* ({ profile, spec, emit }) {
        if (profile === "a") seedSession(spec.cwd, "a", "sid-order");
        yield emit({ type: "started", payload: { native_session_id: "sid-order" } });
        if (profile === "a") {
          yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
          yield* limit(emit);
        } else {
          order.push("spawned");
          yield emit({ type: "message", text: "finished", final: true });
          yield emit({ type: "completed" });
        }
      },
    });
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
    expect(order).toEqual(["copied", "published", "retired", "spawned"]);
    // #411(c): the receipt records the retirement it actually confirmed.
    expect(o.receipts).toMatchObject([{ carrier: "native_moved", sourceRetirement: "retired" }]);
  });

  it("a source that cannot be retired leaves a stale copy, not a failed attempt", async () => {
    const store = fileStoreContinuity();
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      continuity: {
        ...store,
        async move(located, from, to, cwd) {
          const moved = await store.move(located, from, to, cwd);
          if (!moved.ok) return moved;
          return {
            ok: true,
            resumeRef: moved.resumeRef,
            retire() {
              throw Object.assign(new Error("EBUSY: source held"), { code: "EBUSY" });
            },
          };
        },
      },
      script: function* ({ profile, spec, emit }) {
        if (profile === "a") seedSession(spec.cwd, "a", "sid-busy");
        yield emit({ type: "started", payload: { native_session_id: "sid-busy" } });
        if (profile === "a") {
          yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
          yield* limit(emit);
        } else {
          yield emit({ type: "message", text: "finished", final: true });
          yield emit({ type: "completed" });
        }
      },
    });
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
    expect(o.spawns.map((s) => [s.profile, s.resume])).toEqual([
      ["a", null],
      ["b", "sid-busy"],
    ]);
    expect(o.receipts.map((r) => r["carrier"])).toEqual(["native_moved"]);
    // Removal that failed (possibly part-way) is not a confirmed retirement.
    expect(o.receipts[0]).toMatchObject({ sourceRetirement: "not_confirmed" });
  });

  it("a same-account native resume retires nothing and records no retirement fact", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a"],
      script: function* ({ spec, emit, tryOfProfile }) {
        seedSession(spec.cwd, "a", "sid-same");
        yield emit({ type: "started", payload: { native_session_id: "sid-same" } });
        if (tryOfProfile === 1) {
          yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
          return yield* crash(emit);
        }
        yield emit({ type: "message", text: "finished", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
    expect(o.receipts).toHaveLength(1);
    expect(o.receipts[0]).toMatchObject({ carrier: "native" });
    expect(o.receipts[0]).not.toHaveProperty("sourceRetirement");
  });

  it.each([false, true])("pins listed attested models on native carriers (hop=%s)", async (hop) => {
    for (const observed of ["m1", "Display label"]) {
      const o = await run({
        mode: "ask",
        profiles: ["a", "b"],
        model: null,
        script: function* ({ profile, spec, emit, tryOfProfile }) {
          if (profile === "a" && tryOfProfile === 1) {
            seedSession(spec.cwd, "a", "sid-model");
            yield emit({
              type: "started",
              observed_model: observed,
              payload: { native_session_id: "sid-model" },
            });
            yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
            yield* hop ? limit(emit) : crash(emit);
          } else {
            yield emit({ type: "started", payload: { native_session_id: "sid-model" } });
            yield emit({ type: "message", text: "finished", final: true });
            yield emit({ type: "completed" });
          }
        },
      });
      expect(o.result.lifecycle).toBe("succeeded");
      expect(o.spawns.map((s) => s.model)).toEqual([null, observed === "m1" ? "m1" : null]);
      expect(o.receipts[0]?.["carrier"]).toBe(hop ? "native_moved" : "native");
    }
  });
});
