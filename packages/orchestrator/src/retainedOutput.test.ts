import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import { ArtifactStore } from "@claudexor/artifact-store";
import { RETAINED_OUTPUT_PATH, readRunEvents } from "@claudexor/event-log";
import {
  OutputReadyPayload,
  RunFacts,
  WorkProduct,
  type ModeKind,
  type HarnessEvent,
} from "@claudexor/schema";
import { revertInPlaceFromAnchor } from "@claudexor/delivery";
import { Orchestrator } from "./orchestrator.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "cx-retained-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main", root]);
  writeFileSync(join(root, "original.txt"), "before\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "base",
  ]);
  return root;
}

function adapter(run: HarnessAdapter["run"]): HarnessAdapter {
  return { ...createFakeHarness("fake-work-complete"), run };
}

describe("retained output through real mode and terminal owners", () => {
  it("records continuation events exactly once", async () => {
    const root = repo();
    const fake = createFakeHarness("fake-context-then-complete");
    const result = await new Orchestrator({
      registry: new Map([[fake.id, fake]]),
      reviewers: [],
    }).run({
      repoRoot: root,
      mode: "agent",
      prompt: "Continue",
      harnesses: [fake.id],
    });
    const continued = readRunEvents(join(result.runDir, "events.jsonl")).events.filter(
      (event) => event.type === "harness.event" && event.payload["attempt_id"] === "a01c",
    );
    expect(continued.length).toBeGreaterThan(0);
    expect(continued.filter((event) => event.payload["type"] === "started")).toHaveLength(1);
    expect(continued.filter((event) => event.payload["final"] === true)).toHaveLength(1);
  });

  it("keeps synthesized delta bytes exact", async () => {
    const root = repo();
    const fake = adapter(async function* (spec) {
      const base = { session_id: spec.session_id, ts: new Date().toISOString() };
      writeFileSync(join(spec.cwd, "new.txt"), spec.intent + "\n");
      yield { ...base, type: "message", text: "UNIQUE_DELTA", payload: { delta: true } };
      yield { ...base, type: "message", text: "Done" };
    });
    const result = await new Orchestrator({
      registry: new Map([[fake.id, fake]]),
      reviewers: [],
    }).run({
      repoRoot: root,
      mode: "agent",
      prompt: "Synthesize",
      harnesses: [fake.id],
      n: 2,
      synthesis: "always",
    });
    const synthesized = readRunEvents(join(result.runDir, "events.jsonl")).events.filter(
      (event) =>
        event.type === "harness.event" &&
        event.payload["attempt_id"] === "synth" &&
        event.payload["text"] === "UNIQUE_DELTA",
    );
    expect(synthesized).toHaveLength(1);
    expect(readFileSync(join(result.runDir, RETAINED_OUTPUT_PATH), "utf8")).not.toContain(
      "UNIQUE_DELTAUNIQUE_DELTA",
    );
  });

  it.each([false, true])(
    "preserves terminal facts with captured media (cancel=%s)",
    async (cancelled) => {
      const root = repo();
      const cancel = new AbortController();
      const image = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ucAAAAASUVORK5CYII=",
        "base64",
      );
      const base = createFakeHarness("fake-work-complete");
      const media = adapter(async function* (spec) {
        writeFileSync(join(spec.cwd, "screenshot.png"), image);
        writeFileSync(join(spec.cwd, "new.txt"), "change\n");
        yield {
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          type: "message",
          text: "![Result](screenshot.png)",
        };
        if (cancelled) cancel.abort("user_cancelled");
        else yield* base.run(spec);
      });
      const result = await new Orchestrator({
        registry: new Map([[media.id, media]]),
        reviewers: [],
      }).run({
        repoRoot: root,
        mode: "agent",
        prompt: "Image",
        harnesses: [media.id],
        review: false,
        signal: cancel.signal,
      });
      expect(result.lifecycle).toBe(cancelled ? "cancelled" : "succeeded");
      const facts = RunFacts.parse(
        new ArtifactStore(root).readYaml(join(result.runDir, "final/run_facts.yaml")),
      );
      expect(facts.outcome.lifecycle).toBe(cancelled ? "cancelled" : "succeeded");
      if (cancelled) expect(facts.outcome.reason).toBe("user_cancelled");
      expect(facts.presentation).toEqual({
        state: cancelled ? "diagnostic" : "ready",
        primary: cancelled
          ? { kind: "report", path: RETAINED_OUTPUT_PATH }
          : { kind: "answer", path: "final/answer.md" },
      });
      const events = readRunEvents(join(result.runDir, "events.jsonl")).events;
      expect(events.at(-1)?.type).toBe(cancelled ? "run.failed" : "run.completed");
      for (const event of events.filter((row) => row.type === "output.ready"))
        expect(OutputReadyPayload.safeParse(event.payload).success).toBe(true);
      if (!cancelled) expect(facts.deliverable).toMatchObject({ kind: "patch", present: true });
      expect(readFileSync(join(result.runDir, RETAINED_OUTPUT_PATH), "utf8")).toContain(
        "../attempts/a01/produced/screenshot.png",
      );
      expect(readFileSync(join(result.runDir, "attempts/a01/produced/screenshot.png"))).toEqual(
        image,
      );
    },
  );
  it.each(["ask", "plan", "agent"] as ModeKind[])(
    "retains interrupted deltas in %s without accepting them",
    async (mode) => {
      const root = repo();
      let starts = 0;
      const fake = adapter(async function* (spec) {
        starts++;
        const base = { session_id: spec.session_id, ts: new Date().toISOString() };
        yield {
          ...base,
          type: "message",
          text: "# Findings\n\n- useful partial",
          payload: { delta: true },
        };
        yield { ...base, type: "error", error: "native connection closed" };
        yield { ...base, type: "completed", payload: { exit_code: 1 } };
      });
      const result = await new Orchestrator({ registry: new Map([[fake.id, fake]]) }).run({
        repoRoot: root,
        mode,
        prompt: "Inspect",
        harnesses: [fake.id],
        review: false,
      });
      expect(starts).toBe(1);
      expect(result.lifecycle).toBe("failed");
      const facts = RunFacts.parse(
        new ArtifactStore(root).readYaml(join(result.runDir, "final/run_facts.yaml")),
      );
      expect(facts.deliverable.present).toBe(false);
      expect(facts.presentation).toEqual({
        state: "diagnostic",
        primary: { kind: "report", path: RETAINED_OUTPUT_PATH },
      });
      expect(readFileSync(join(result.runDir, RETAINED_OUTPUT_PATH), "utf8")).toContain(
        "# Findings\n\n- useful partial",
      );
      expect(existsSync(join(result.runDir, "final/plan.md"))).toBe(false);
      const events = readRunEvents(join(result.runDir, "events.jsonl")).events;
      expect(events.at(-1)?.type).toBe("run.failed");
      expect(events.at(-2)).toMatchObject({
        type: "output.ready",
        payload: { path: RETAINED_OUTPUT_PATH },
      });
    },
  );

  it.each(["ask", "plan", "agent"] as ModeKind[])(
    "keeps received text when %s is cancelled",
    async (mode) => {
      const root = repo();
      const abort = new AbortController();
      const fake = adapter(async function* (spec) {
        yield {
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          type: "message",
          text: "Useful before Stop",
          payload: { delta: true },
        };
        abort.abort("user_cancelled");
      });
      const result = await new Orchestrator({ registry: new Map([[fake.id, fake]]) }).run({
        repoRoot: root,
        mode,
        prompt: "Inspect",
        harnesses: [fake.id],
        signal: abort.signal,
        review: false,
      });
      expect(result.lifecycle).toBe("cancelled");
      expect(readFileSync(join(result.runDir, RETAINED_OUTPUT_PATH), "utf8")).toContain(
        "Useful before Stop",
      );
    },
  );

  it("retains beyond the Agent display cap while bounding live delta publication", async () => {
    const root = repo();
    let liveDeltas = 0;
    const fake = adapter(async function* (spec) {
      for (let i = 0; i < 4002; i++)
        yield {
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          type: "message" as const,
          text: i === 4001 ? "AFTER_CAP" : "x",
          payload: { delta: true },
        };
      yield {
        session_id: spec.session_id,
        ts: new Date().toISOString(),
        type: "error",
        error: "stream closed",
      };
    });
    const result = await new Orchestrator({ registry: new Map([[fake.id, fake]]) }).run({
      repoRoot: root,
      mode: "agent",
      prompt: "Inspect",
      harnesses: [fake.id],
      review: false,
      onEvent: (event) => {
        if ((event.payload["payload"] as HarnessEvent["payload"])?.["delta"]) liveDeltas++;
      },
    });
    expect(result.lifecycle).toBe("failed");
    expect(liveDeltas).toBe(4000);
    expect(readFileSync(join(result.runDir, RETAINED_OUTPUT_PATH), "utf8")).toContain(
      "x".repeat(4001) + "AFTER_CAP",
    );
  });

  it("keeps the normal accepted answer primary and earlier material secondary", async () => {
    const root = repo();
    const fake = adapter(async function* (spec) {
      const base = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...base, type: "message", text: "Earlier observation", payload: { delta: true } };
      yield {
        ...base,
        type: "message",
        final: true,
        text: JSON.stringify({
          work_report: { state: "completed", required_inputs: [] },
          output: "Final answer",
        }),
      };
    });
    const result = await new Orchestrator({ registry: new Map([[fake.id, fake]]) }).run({
      repoRoot: root,
      mode: "ask",
      prompt: "Inspect",
      harnesses: [fake.id],
    });
    const facts = RunFacts.parse(
      new ArtifactStore(root).readYaml(join(result.runDir, "final/run_facts.yaml")),
    );
    expect(result.lifecycle).toBe("succeeded");
    expect(facts.presentation).toEqual({
      state: "ready",
      primary: { kind: "answer", path: "final/answer.md" },
    });
    expect(readFileSync(join(result.runDir, RETAINED_OUTPUT_PATH), "utf8")).toContain(
      "Earlier observation",
    );
  });

  it.each([false, true])(
    "records cancelled Git effects (live=%s) without automatic apply or rollback",
    async (live) => {
      const root = repo();
      const abort = new AbortController();
      const fake = adapter(async function* (spec) {
        writeFileSync(join(spec.cwd, "original.txt"), "partial\n");
        abort.abort("user_cancelled");
        yield {
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          type: "completed",
          aborted: true,
        };
      });
      const result = await new Orchestrator({ registry: new Map([[fake.id, fake]]) }).run({
        repoRoot: root,
        mode: "agent",
        prompt: "Edit",
        harnesses: [fake.id],
        inPlace: live,
        review: false,
        signal: abort.signal,
      });
      expect(result.lifecycle).toBe("cancelled");
      const wp = WorkProduct.parse(
        new ArtifactStore(root).readYaml(join(result.runDir, "final/work_product.yaml")),
      );
      expect(wp.meta["adopted"]).toBe(live);
      expect(wp.meta["lifecycle"]).toBe("cancelled");
      expect(readFileSync(join(root, "original.txt"), "utf8")).toBe(
        live ? "partial\n" : "before\n",
      );
      if (live) {
        expect(typeof wp.meta["revert_anchor_id"]).toBe("string");
        expect(
          await revertInPlaceFromAnchor(root, String(wp.meta["revert_anchor_id"])),
        ).toMatchObject({ reverted: true });
        expect(readFileSync(join(root, "original.txt"), "utf8")).toBe("before\n");
      } else expect(wp.meta["revert_anchor_id"]).toBeNull();
    },
  );
});
