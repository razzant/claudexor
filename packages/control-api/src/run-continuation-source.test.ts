/**
 * The status projection names the same continuation source the successor's
 * planner uses: a head that recorded its own work is its own source even
 * without a capsule, and only a head with no session and no work defers to
 * an ancestor.
 *
 * Astra r2 coupling repro (`.review-evidence/astra-r2/coupling-review/
 * capsuleless-source-repro.mjs`, sha256 1bd5708b…): the same fixture and the
 * same planner call; its demonstration that the projection advertised the
 * ancestor's `sid-A` while the planner packets B is asserted here as the
 * required agreement. A control with an empty head keeps the inheritance.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../artifact-store/src/index.js";
import { HarnessRunSpec } from "@claudexor/schema";
import { writeContinuationSources } from "@claudexor/workspace";
import { openContinuity } from "../../orchestrator/src/continue-from.js";
import type { InRunContinuityDeps } from "../../orchestrator/src/inrun-continuity-types.js";
import { continuationSummary } from "./run-continuation-projection.js";
import { readRunEventFacts } from "./run-event-facts.js";

const roots: string[] = [];
afterEach(
  () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  0,
); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const event = (seq: number, type: string, payload: Record<string, unknown>) => ({
  seq,
  type,
  payload,
  id: `e-${seq}`,
  ts: "2026-10-29T02:00:00.000Z",
  run_id: "B",
  task_id: "task-B",
});

/** A interrupted with a claude capsule; B continues A and records `bEvents`, then the host crashes. */
function chain(bEvents: ReturnType<typeof event>[]) {
  const root = mkdtempSync(join(tmpdir(), "cx-capsuleless-"));
  roots.push(root);
  const a = join(root, "A");
  const b = join(root, "B");
  const c = join(root, "C");
  mkdirSync(join(a, "attempts", "a01"), { recursive: true });
  mkdirSync(join(b, "final"), { recursive: true });
  writeFileSync(
    join(a, "attempts", "a01", "session-capsule.json"),
    JSON.stringify({
      harness: "claude",
      nativeSessionId: "sid-A",
      holderProfileId: null,
      file: null,
      mtimeMs: null,
      sidecars: [],
      cwd: root,
      requestedModel: null,
    }),
  );
  writeContinuationSources(b, [{ runId: "A", runDir: a, state: "interrupted" }]);
  writeFileSync(join(b, "events.jsonl"), bEvents.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { root, a, b, c };
}

async function planned(paths: ReturnType<typeof chain>) {
  const { root, a, b, c } = paths;
  const deps = {
    adapter: { id: "claude" },
    runId: "C",
    attemptId: "a01",
    runDir: c,
    attemptDir: join(c, "attempts", "a01"),
    cwd: root,
    workspace: { kind: "in_place", root },
    workOrder: "Continue",
    firstPrompt: "Continue",
    registry: [],
    newSessionId: () => "process-C",
    emit: () => {},
    thread: null,
  } as unknown as InRunContinuityDeps;
  const { spec } = await openContinuity(deps, {
    spec: HarnessRunSpec.parse({
      session_id: "process-C",
      intent: "explain",
      prompt: "Continue",
      cwd: root,
      access: "readonly",
    }),
    continuation: {
      retain: true,
      from: {
        runId: "B",
        runDir: b,
        state: "interrupted",
        workOrder: "Investigate",
        preference: "auto",
        ancestors: [{ runId: "A", runDir: a, state: "interrupted" }],
      },
    },
    store: new ArtifactStore(root),
    telemetry: { requestedModel: null },
  });
  return spec;
}

const record = (b: string) => ({
  id: "B",
  runId: "B",
  runDir: b,
  state: "interrupted" as const,
  params: { mode: "ask", continueFrom: "A" },
});

describe("the status projection and the planner name one continuation source", () => {
  it("a capsuleless head that recorded its own output is its own source (raw API, host crash)", async () => {
    const events = [
      event(1, "run.created", { prompt: "Investigate further" }),
      event(2, "harness.event", {
        attempt_id: "a01",
        session_id: "raw-process",
        type: "started",
        payload: { requested_model: "example" },
      }),
      event(3, "harness.event", {
        attempt_id: "a01",
        session_id: "raw-process",
        type: "message",
        text: "B_NEW_FINDING before host crash",
      }),
    ];
    const paths = chain(events);
    const spec = await planned(paths);
    expect(spec.resume_session_id).toBeNull();
    expect(spec.prompt).toContain("B_NEW_FINDING");
    // Detail (its event snapshot) and a list row (no snapshot) agree with the planner.
    for (const projected of [
      continuationSummary(record(paths.b), events),
      continuationSummary(record(paths.b)),
    ]) {
      expect(projected.resumable?.session ?? null).toBeNull();
      expect(projected.resumable?.carriers).toEqual(["packet"]);
      expect(projected.resumable?.cause).toBe("host_restart");
    }
  });

  it("run detail's bounded event fold (#316) carries the head's own source without reading its log again", async () => {
    const paths = chain([
      event(1, "run.created", { prompt: "Investigate further" }),
      event(2, "harness.event", {
        attempt_id: "a01",
        session_id: "raw-process",
        type: "started",
        payload: { requested_model: "example" },
      }),
      event(3, "harness.event", {
        attempt_id: "a01",
        session_id: "raw-process",
        type: "message",
        text: "B_NEW_FINDING before host crash",
      }),
    ]);
    const facts = readRunEventFacts(record(paths.b));
    // Once folded, the log is not needed: projecting without it gives the same
    // planner-agreed answer, so detail reads no extra log for its source.
    rmSync(join(paths.b, "events.jsonl"));
    const detail = continuationSummary(record(paths.b), facts);
    expect(detail.resumable?.session ?? null).toBeNull();
    expect(detail.resumable?.carriers).toEqual(["packet"]);
    // Control: without the fold a row reads the (now missing) log and finds no own work.
    expect(continuationSummary(record(paths.b)).resumable?.session?.nativeSessionId).toBe("sid-A");
  });

  it("a head with no session and no recorded work still defers to its ancestor, as the planner does", async () => {
    const paths = chain([event(1, "run.created", { prompt: "Investigate further" })]);
    const spec = await planned(paths);
    expect(spec.resume_session_id).toBe("sid-A");
    for (const projected of [
      continuationSummary(record(paths.b), [event(1, "run.created", { prompt: "x" })]),
      continuationSummary(record(paths.b)),
    ]) {
      expect(projected.resumable?.session?.nativeSessionId).toBe("sid-A");
      expect(projected.resumable?.carriers).toEqual(["native", "packet"]);
    }
  });
});
