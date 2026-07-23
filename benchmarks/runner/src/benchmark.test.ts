import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTasksFromJsonl, writePredictions } from "./swebench.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

function tmp(): string {
  return reapMk(join(tmpdir(), "claudexor-bench-"));
}

describe("swebench predictions", () => {
  it("writes a .json prediction list with instance_id (official harness shape)", () => {
    const path = join(tmp(), "preds.json");
    writePredictions(
      [{ instance_id: "a__b-1", model_name_or_path: "claudexor", model_patch: "diff --git" }],
      path,
    );
    const j = JSON.parse(readFileSync(path, "utf8"));
    expect(Array.isArray(j)).toBe(true);
    expect(j[0].instance_id).toBe("a__b-1");
    expect(j[0].model_patch).toBe("diff --git");
    expect(j[0].model_name_or_path).toBe("claudexor");
  });

  it("writes .jsonl predictions one id-bearing object per line", () => {
    const path = join(tmp(), "preds.jsonl");
    writePredictions(
      [
        { instance_id: "a__b-1", model_name_or_path: "claudexor", model_patch: "p1" },
        { instance_id: "a__b-2", model_name_or_path: "claudexor", model_patch: "p2" },
      ],
      path,
    );
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.instance_id).toBe("a__b-1");
    expect(first.model_patch).toBe("p1");
  });

  it("loads tasks from JSONL", () => {
    const f = join(tmp(), "t.jsonl");
    writeFileSync(
      f,
      JSON.stringify({ instance_id: "x__y-1", problem_statement: "fix it", repo: "x/y" }) + "\n",
    );
    const tasks = loadTasksFromJsonl(f);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.instance_id).toBe("x__y-1");
  });
});
