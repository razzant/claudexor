import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readFilesWorkProduct } from "./files-work-product.js";
import { inRunProjection } from "./projection-context.js";
import { readRawTextArtifact } from "./run-artifact-read.js";

it.each([true, false])(
  "keeps Files directory errors independent of the raw reader (raw first=%s)",
  (rawFirst) => {
    const runDir = mkdtempSync(join(tmpdir(), "cx-files-reader-"));
    const path = join(runDir, "final/work_product.yaml");
    const record = { id: "r", state: "succeeded", runDir };
    try {
      mkdirSync(path, { recursive: true });
      inRunProjection(() => {
        if (rawFirst) expect(readRawTextArtifact(record, "final/work_product.yaml")).toBeNull();
        else expect(() => readFilesWorkProduct(record)).toThrow();
        expect(readRawTextArtifact(record, "final/work_product.yaml")).toBeNull();
        expect(() => readFilesWorkProduct(record)).toThrow();
      });
      rmSync(path, { recursive: true });
      const text = JSON.stringify({ id: "wp", source_task_id: "task", kind: "report", meta: {} });
      writeFileSync(path, text);
      inRunProjection(() => {
        expect(readRawTextArtifact(record, "final/work_product.yaml")).toBe(text);
        expect(readFilesWorkProduct(record)).toBeNull();
      });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  },
);
