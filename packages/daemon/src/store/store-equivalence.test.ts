import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runEquivalence } from "./test-support/store-equivalence.js";

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const output = () => {
  const root = mkdtempSync(join(tmpdir(), "cx-equivalence-driver-"));
  roots.push(root);
  return join(root, "run");
};

describe("independent store equivalence driver", () => {
  it("qualifies the sealed portable fixture and metadata companions through actual projection owners", async () => {
    const dir = output();
    const report = await runEquivalence({ output: dir, portable: true });
    expect(report.state, JSON.stringify(report)).toBe("passed");
    expect(report.partitions[0]).toMatchObject({
      cursorChecks: 103,
      commands: 2,
      threads: 1,
      served: true,
    });
    expect(report.resources).toMatchObject({
      resources: 1,
      bindings: 3,
      createAdoptions: 2,
      finalizeAdoptions: 1,
    });
    expect(JSON.parse(readFileSync(join(dir, "comparisons.json"), "utf8")).failures).toEqual([]);
    expect(report.checked).toBeGreaterThan(250);
  });
  it("fails on a changed imported timestamp instead of normalizing it away", async () => {
    const dir = output();
    const report = await runEquivalence({ output: dir, portable: true }, (database) => {
      const db = new DatabaseSync(database);
      try {
        const row = db.prepare("SELECT id,summary FROM command WHERE id='job-success'").get() as {
          id: string;
          summary: Uint8Array;
        };
        const record = JSON.parse(Buffer.from(row.summary).toString("utf8"));
        record.createdAt = "1970-01-01T00:00:00.000Z";
        db.prepare("UPDATE command SET created_at=?,summary=? WHERE id=?").run(
          record.createdAt,
          Buffer.from(JSON.stringify(record)),
          row.id,
        );
      } finally {
        db.close();
      }
    });
    expect(report.state).toBe("failed");
    const findings = JSON.parse(readFileSync(join(dir, "comparisons.json"), "utf8")).failures;
    expect(findings).toContainEqual(
      expect.objectContaining({ label: "command:global:job-success", path: "$.createdAt" }),
    );
    expect(findings.some((row: { label: string }) => row.label.startsWith("originals:"))).toBe(
      false,
    );
  });
});
