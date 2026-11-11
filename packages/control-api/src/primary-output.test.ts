import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunFacts } from "@claudexor/schema";
import { outputReadyState, primaryOutput, truncateUtf8 } from "./primary-output.js";
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
