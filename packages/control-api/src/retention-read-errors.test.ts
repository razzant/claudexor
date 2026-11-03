import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runKeepReason } from "./retention-candidates.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
it.each(["final/work_product.yaml", "final/delivery_state.yaml", "arbitration/decision.yaml"])(
  "names unreadable %s and confines the hold to its run",
  (name) => {
    const root = mkdtempSync(join(tmpdir(), "retention-file-error-"));
    roots.push(root);
    const file = join(root, "held", name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "[unterminated");
    const record = { runId: "held", state: "failed", finishedAt: "2020-01-01" };
    const errors: unknown[] = [];
    const judge = (dir: string) =>
      runKeepReason(dir, "held", record, new Set(), Date.now(), (error) => errors.push(error));
    expect(judge(join(root, "held"))).toBe("actionable");
    expect(errors.map(String).join()).toContain(file);
    expect(judge(join(root, "neighbor"))).toBeNull();
    writeFileSync(file, "kind: report\n");
    errors.length = 0;
    expect(judge(join(root, "held"))).toBeNull();
    expect(errors).toEqual([]);
  },
);
