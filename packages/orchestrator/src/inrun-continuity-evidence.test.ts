import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import { appendRunEvent } from "@claudexor/event-log";
import { HarnessRunSpec } from "@claudexor/schema";
import { orderedAppender } from "@claudexor/util";
import type { ContinuationPlan } from "./continuation-later.js";
import { openContinuity } from "./continue-from.js";
import type { InRunContinuityDeps } from "./inrun-continuity-types.js";
import {
  run,
  seedSession,
  crash,
  limit,
  fileStoreContinuity,
} from "./inrun-continuity.test-support.js";

describe("attempt evidence and begun-try receipts", () => {
  it.each(["agent", "ask"] as const)(
    "%s retains earlier narration across a silent native rejection",
    async (mode) => {
      const o = await run({
        mode,
        profiles: ["a"],
        continuity: fileStoreContinuity({
          rejectsCarriedState: (ev) => ev.payload?.["code"] === "fixture_rejected",
        }),
        script: function* ({ emit, spec, tryOfProfile }) {
          if (tryOfProfile === 1) {
            seedSession(spec.cwd, "a", "sid-good");
            yield emit({ type: "started", payload: { native_session_id: "sid-good" } });
            yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
            yield emit({ type: "message", text: "earlier useful findings" });
            yield* crash(emit);
          } else if (tryOfProfile === 2) {
            yield emit({ type: "error", error: "rejected", payload: { code: "fixture_rejected" } });
          } else {
            yield emit({ type: "message", text: "finished", final: true });
          }
          yield emit({ type: "completed" });
        },
      });
      expect(o.spawns[2]!.prompt).toContain("earlier useful findings");
      expect(o.spawns[2]!.prompt).not.toContain("(no output retained)");
      expect(o.spawns[2]!.prompt).not.toContain(
        "The last instruction sent to the previous process may not have been delivered",
      );
    },
  );

  it("does not emit a receipt for a continuation cancelled during preparation", async () => {
    const stop = new AbortController();
    const store = fileStoreContinuity();
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      input: { signal: stop.signal },
      continuity: {
        ...store,
        async move(...args) {
          const result = await store.move(...args);
          stop.abort("user_cancelled");
          return result;
        },
      },
      script: function* ({ spec, emit }) {
        seedSession(spec.cwd, "a", "sid-good");
        yield emit({
          type: "started",
          observed_model: "m1",
          payload: { native_session_id: "sid-good" },
        });
        yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
        yield* limit(emit);
      },
    });
    expect(o.result.lifecycle).toBe("cancelled");
    expect(o.spawns).toHaveLength(1);
    expect(o.receipts).toEqual([]);
  });
});

it("uncertain initial input quotes only the caller's work order", async () => {
  const o = await run({
    mode: "ask",
    profiles: ["a"],
    continuity: null,
    script: function* ({ tryOfProfile, emit }) {
      if (tryOfProfile === 1) {
        yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
        yield* crash(emit);
      } else {
        yield emit({ type: "message", text: "finished", final: true });
        yield emit({ type: "completed" });
      }
    },
  });
  expect(o.spawns[1]!.prompt).toContain(
    "It was:\n\nWORK-ORDER-7f3a: build the dashboard\n\nReconcile",
  );
});

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

/**
 * Hold the ordered appender's writes to the paths `match` accepts while
 * `holding()` is true, until the first `orderedAppender.settledUnder` call made
 * meanwhile: that barrier releases them and then waits for them as usual.
 * `atBarrier` runs at that call, before the release, to see what had landed.
 */
function holdUntilFirstBarrier(
  match: (path: string) => boolean,
  holding: () => boolean,
  atBarrier: (dir: string) => void,
) {
  let released = false;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const release = () => {
    released = true;
    open();
  };
  const realOpen = promises.open;
  const opens = vi.spyOn(promises, "open").mockImplementation((async (
    ...args: Parameters<typeof promises.open>
  ) => {
    const handle = await realOpen(...args);
    if (released || !match(String(args[0]))) return handle;
    const write = handle.write.bind(handle) as (...writeArgs: unknown[]) => Promise<unknown>;
    handle.write = (async (...writeArgs: unknown[]) => {
      if (!released && holding()) await gate;
      return write(...writeArgs);
    }) as unknown as typeof handle.write;
    return handle;
  }) as typeof promises.open);
  const settledUnder = orderedAppender.settledUnder.bind(orderedAppender);
  const barriers = vi.spyOn(orderedAppender, "settledUnder").mockImplementation((dir) => {
    if (!released && holding()) {
      atBarrier(dir);
      release();
    }
    return settledUnder(dir);
  });
  return {
    restore() {
      release();
      opens.mockRestore();
      barriers.mockRestore();
    },
  };
}

describe("a continuation reads the journal lines still in flight when it began (#688)", () => {
  const marker = "HeldReadMarker";

  it("afterTry settles the run's journals before a packet continuation reads them", async () => {
    let holding = false;
    const atBarrier: { dir: string; landed: boolean }[] = [];
    const hold = holdUntilFirstBarrier(
      (path) => path.endsWith(`${sep}events.jsonl`),
      () => holding,
      (dir) => {
        const log = join(dir, "events.jsonl");
        atBarrier.push({
          dir,
          landed: existsSync(log) && readFileSync(log, "utf8").includes(marker),
        });
      },
    );
    try {
      const o = await run({
        mode: "agent",
        profiles: ["a"],
        continuity: null,
        script: function* ({ emit, tryOfProfile }) {
          if (tryOfProfile === 1) {
            // From here the run journal's writes are held until a barrier.
            holding = true;
            yield emit({ type: "tool_call", tool: { name: marker, kind: "file" } });
            yield* crash(emit);
          } else {
            yield emit({ type: "message", text: "finished", final: true });
            yield emit({ type: "completed" });
          }
        },
      });
      // Direction 1: the packet that briefed the next try lists the try's tool
      // call once, and that line was still in flight when the continuation began.
      const prompt = o.spawns[1]!.prompt;
      expect(prompt.split(`- ${marker} (unresolved: no result recorded)`)).toHaveLength(2);
      expect(atBarrier).toEqual([{ dir: o.result.runDir, landed: false }]);
      // Direction 2: the packet still carries the work order, and the run ends.
      expect(prompt).toContain("Evidence index of the interrupted work");
      expect(prompt).toContain("WORK-ORDER-7f3a: build the dashboard");
      expect(o.result.lifecycle).toBe("succeeded");
    } finally {
      hold.restore();
    }
  });

  it("openContinuity settles the run's journals before a later attempt's packet reads them", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-later-settle-"));
    roots.push(root);
    const runDir = join(root, "run");
    const journal = join(runDir, "attempts", "a01", "events.jsonl");
    mkdirSync(dirname(journal), { recursive: true });
    const ts = new Date().toISOString();
    const narration = { type: "message", session_id: "ses-a", ts, text: "earlier narration" };
    appendRunEvent(join(runDir, "events.jsonl"), "run-x", "task-x", "harness.event", {
      harness_id: "fake",
      attempt_id: "a01",
      ...narration,
    });
    writeFileSync(journal, `${JSON.stringify(narration)}\n`);
    const adapter = { id: "fake" } as HarnessAdapter;
    const deps = {
      adapter,
      runId: "run-x",
      attemptId: "a01-fb",
      later: "fallback",
      runDir,
      attemptDir: join(runDir, "attempts", "a01-fb"),
      cwd: root,
      workspace: { kind: "in_place", root },
      workOrder: "Explain",
      firstPrompt: "Explain",
      registry: [],
      route: { adapter, knownModels: [] },
      newSessionId: () => "ses-b",
      emit: () => {},
      thread: null,
    } as unknown as InRunContinuityDeps;
    const planned: ContinuationPlan = {
      workOrder: "WORK-ORDER: explain what is left",
      evidenceSources: [],
      acted: true,
      cause: "other",
      completed: false,
      from: { runId: "run-pred", attemptId: "a00" },
      fromProfileId: null,
      workspace: "same_root",
    };
    const spec = HarnessRunSpec.parse({
      session_id: "ses-b",
      intent: "explain",
      prompt: "Explain",
      cwd: root,
      access: "readonly",
    });
    const atBarrier: boolean[] = [];
    const hold = holdUntilFirstBarrier(
      (path) => path === journal,
      () => true,
      () => atBarrier.push(readFileSync(journal, "utf8").includes(marker)),
    );
    try {
      // The earlier attempt's last journal line is still in flight.
      orderedAppender.append(
        journal,
        `${JSON.stringify({ type: "tool_call", session_id: "ses-a", ts, tool: { name: marker, kind: "search", target: "needle" } })}\n`,
      );
      const opened = await openContinuity(deps, {
        spec,
        continuation: { retain: false, planned },
        store: new ArtifactStore(root),
        telemetry: { requestedModel: null },
      });
      // Direction 1: the later attempt's packet lists the line once, and the line
      // had not landed when the attempt opened.
      expect(
        opened.spec.prompt.split(`- ${marker} — needle (unresolved: no result recorded)`),
      ).toHaveLength(2);
      expect(atBarrier).toEqual([false]);
      // Direction 2: the landed evidence is read as before.
      expect(opened.spec.prompt).toContain("earlier narration");
      expect(opened.spec.prompt).toContain("WORK-ORDER: explain what is left");
      expect(opened.spec.resume_session_id).toBeNull();
    } finally {
      hold.restore();
      await orderedAppender.settled(journal);
    }
  });
});
