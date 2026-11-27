import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunFacts } from "@claudexor/schema";
import {
  outputReadyState,
  primaryOutput,
  readRunEarlierAssistantOutputView,
  truncateUtf8,
} from "./primary-output.js";
import { readRunEventFacts } from "./run-event-facts.js";
import type { DaemonRunRecord } from "./run-record.js";
import { inRunProjection } from "./projection-context.js";

function record(runDir: string): DaemonRunRecord {
  return { id: "job-1", state: "succeeded", runDir, params: {} } as unknown as DaemonRunRecord;
}

function facts(path: string): RunFacts {
  return {
    presentation: { state: "ready", primary: { kind: "answer", path } },
  } as unknown as RunFacts;
}

describe("canonical terminal presentation", () => {
  it.each([11 * 1024, 24 * 1024])(
    "reads earlier speech for addressed answers with an independent UTF-8 budget (%s bytes target)",
    (targetBytes) => {
      const runDir = mkdtempSync(join(tmpdir(), "claudexor-earlier-output-"));
      const path = "final/answer.md";
      const earlierPath = "final/earlier-assistant-output.md";
      const earlier = "🟦".repeat(targetBytes / 4) + " end\n";
      const answer = "Accepted answer\n";
      mkdirSync(join(runDir, "final"));
      writeFileSync(join(runDir, earlierPath), earlier);
      writeFileSync(join(runDir, path), answer);
      try {
        const rec = record(runDir);
        const truncated = targetBytes > 16 * 1024;
        const canonical = {
          kind: "answer",
          path,
          text: answer,
          bytes: Buffer.byteLength(answer),
          truncated: false,
        };
        expect(primaryOutput(rec, "ask", null, facts(path))).toEqual(canonical);
        expect(
          primaryOutput(rec, "ask", null, facts(path), { includeEarlierAssistantOutput: true }),
        ).toEqual({
          ...canonical,
          earlierAssistantOutput: {
            path: earlierPath,
            text: truncated ? earlier.slice(0, ((16 * 1024) / 4) * 2) : earlier,
            bytes: Buffer.byteLength(earlier),
            truncated,
          },
        });
        expect(
          primaryOutput(rec, "ask", null, facts(path), {
            maxBytes: 1024,
            includeEarlierAssistantOutput: true,
          }),
        ).toEqual(canonical);
        rmSync(join(runDir, earlierPath));
        for (const [fact, reason] of [
          ["saved", "artifact_unavailable"],
          ["source_gap", "source_gap"],
          ["publication_failed", "publication_failed"],
        ] as const) {
          expect(
            primaryOutput(rec, "ask", null, facts(path), {
              includeEarlierAssistantOutput: true,
              earlierAssistantOutputFact: fact,
            }),
          ).toEqual({ ...canonical, earlierAssistantOutputUnavailable: reason });
        }
        expect(primaryOutput({ ...rec, state: "failed" }, "ask", null, facts(path))).toEqual(
          canonical,
        );
        expect(
          primaryOutput(rec, "ask", null, facts(path.replace("answer", "missing"))),
        ).not.toHaveProperty("earlierAssistantOutput");
      } finally {
        rmSync(runDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["the saved artifact", { earlier_assistant_output_saved: true }, true],
    ["a saved artifact that no longer reads", { earlier_assistant_output_saved: true }, false],
    ["a recorded event gap", { earlier_assistant_output_gap: true }, false],
    ["a failed preparation", { earlier_assistant_output_failed: true }, false],
    ["an unrelated status", { other: true }, false],
    ["no status", null, false],
  ] as const)(
    "gives offline text inspect the earlier view an addressed detail serves for %s",
    (_label, status, artifact) => {
      const runDir = mkdtempSync(join(tmpdir(), "claudexor-earlier-view-"));
      const path = "final/answer.md";
      mkdirSync(join(runDir, "final"));
      writeFileSync(join(runDir, path), "Accepted answer\n");
      if (artifact) writeFileSync(join(runDir, "final/earlier-assistant-output.md"), "Report.\n");
      // The orchestrator's own status shape, as events.jsonl stores it.
      const event = (seq: number, payload: object) =>
        JSON.stringify({
          seq,
          ts: "2026-11-28T00:00:00.000Z",
          type: "harness.event",
          payload: { type: "status", title: "Earlier assistant text", text: "", payload },
        });
      writeFileSync(
        join(runDir, "events.jsonl"),
        status ? `${event(1, { unrelated: true })}\n${event(2, status)}\n` : "",
      );
      try {
        const served = primaryOutput(record(runDir), "ask", null, facts(path), {
          includeEarlierAssistantOutput: true,
          earlierAssistantOutputFact: readRunEventFacts({ runDir }).earlierAssistantOutputFact,
        });
        const offline = readRunEarlierAssistantOutputView(runDir);
        expect(offline).toEqual({
          ...(served?.earlierAssistantOutput
            ? { earlierAssistantOutput: served.earlierAssistantOutput }
            : {}),
          ...(served?.earlierAssistantOutputUnavailable
            ? { earlierAssistantOutputUnavailable: served.earlierAssistantOutputUnavailable }
            : {}),
        });
        const expected =
          artifact && status
            ? { earlierAssistantOutput: expect.objectContaining({ text: "Report.\n" }) }
            : status && "earlier_assistant_output_saved" in status
              ? { earlierAssistantOutputUnavailable: "artifact_unavailable" }
              : status && "earlier_assistant_output_gap" in status
                ? { earlierAssistantOutputUnavailable: "source_gap" }
                : status && "earlier_assistant_output_failed" in status
                  ? { earlierAssistantOutputUnavailable: "publication_failed" }
                  : {};
        expect(offline).toEqual(expected);
        expect(offline).not.toHaveProperty("text");
      } finally {
        rmSync(runDir, { recursive: true, force: true });
      }
    },
  );

  it.each([true, false])(
    "keeps full, byte-bounded and patch-reference previews distinct (full first=%s)",
    (fullFirst) => {
      const runDir = mkdtempSync(join(tmpdir(), "claudexor-primary-policy-"));
      const path = "final/patch.diff";
      const text = "\ufeff" + "+hello🙂\n".repeat(20);
      mkdirSync(join(runDir, "final"));
      writeFileSync(join(runDir, path), text);
      try {
        inRunProjection(() => {
          const rec = record(runDir);
          const full = () => expect(primaryOutput(rec, "agent", null)?.text).toBe(text);
          const bounded = () =>
            expect(primaryOutput(rec, "agent", null, null, { maxBytes: 13 })).toMatchObject({
              kind: "patch",
              text: truncateUtf8(text, 13),
              truncated: true,
            });
          if (fullFirst) full();
          else bounded();
          full();
          bounded();
          expect(
            primaryOutput(rec, "agent", null, null, { patchReferenceOnly: true }),
          ).toMatchObject({
            kind: "patch",
            text: null,
            bytes: Buffer.byteLength(text),
            truncated: true,
          });
          full();
          expect(outputReadyState(rec, "agent", null)).toBe("ready");
        });
      } finally {
        rmSync(runDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["missing", "blank"])("degrades a %s declared primary to diagnostic", (kind) => {
    const runDir = mkdtempSync(join(tmpdir(), "claudexor-primary-output-"));
    const path = "final/answer.md";
    if (kind === "blank") {
      const finalDir = join(runDir, "final");
      // The run tree exists in the ordinary retention case; only the primary
      // payload was removed or emptied.
      mkdirSync(finalDir);
      writeFileSync(join(runDir, path), "\n");
    }
    try {
      expect(primaryOutput(record(runDir), "ask", null, facts(path))).toMatchObject({
        kind: "diagnostic",
        path,
        text: expect.stringContaining("unavailable"),
      });
      expect(outputReadyState(record(runDir), "ask", null, facts(path))).toBe("diagnostic");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("preserves a legitimate ready no-change receipt with no primary", () => {
    const runDir = mkdtempSync(join(tmpdir(), "claudexor-primary-output-"));
    const noPrimary = { presentation: { state: "ready", primary: null } } as unknown as RunFacts;
    try {
      expect(primaryOutput(record(runDir), "agent", null, noPrimary)).toBeNull();
      expect(outputReadyState(record(runDir), "agent", null, noPrimary)).toBe("ready");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("projects a retention tombstone as terminal diagnostic without RunFacts", () => {
    const runDir = mkdtempSync(join(tmpdir(), "claudexor-primary-output-retained-"));
    writeFileSync(
      join(runDir, "tombstone.yaml"),
      "run_id: run-1\ndeleted_at: 2026-07-29T00:00:00.000Z\nreason: retention\n",
    );
    try {
      expect(primaryOutput(record(runDir), "ask", null, null)).toMatchObject({
        kind: "diagnostic",
        path: "tombstone.yaml",
        text: expect.stringContaining("reclaimed by retention"),
      });
      expect(outputReadyState(record(runDir), "ask", null, null)).toBe("diagnostic");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
