import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { codexRolloutParts } from "./rollout-file.js";
import { codexTranscriptModel } from "./transcript.js";

// Directory reads are counted through a pass-through mock: the transcript
// readers must stop at the newest day that holds the rollout, as the locator
// before #336 did, while continuity still collects every part.
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readdirSync: vi.fn(fs.readdirSync) };
});

const THREAD = "0199abcd-0000-7111-8222-333344445555";
const home = realpathSync(mkdtempSync(join(tmpdir(), "codex-rollout-locator-")));
afterAll(() => rmSync(home, { recursive: true, force: true }), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

it("finds the newest-day rollout after reading only the directories on its path", () => {
  for (const year of ["2025", "2026"])
    for (const month of ["01", "02", "03"])
      for (const day of ["01", "02", "03", "04", "05"]) {
        const dir = join(home, "sessions", year, month, day);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `rollout-${year}-${month}-${day}T10-00-00-other-${day}.jsonl`), "");
      }
  const newest = join(home, "sessions", "2026", "03", "05");
  writeFileSync(
    join(newest, `rollout-2026-03-05T10-00-00-${THREAD}.jsonl`),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "t1", model: "gpt-x" } }) + "\n",
  );
  const older = join(home, "sessions", "2025", "01", "01");
  writeFileSync(join(older, `rollout-2025-01-01T10-00-00-${THREAD}.jsonl.zst`), "z");
  vi.mocked(readdirSync).mockClear();
  expect(codexTranscriptModel(home, THREAD)).toBe("gpt-x");
  expect(vi.mocked(readdirSync)).toHaveBeenCalledTimes(4); // sessions, 2026, 03, 05
  // Continuity still walks the whole tree and names every part.
  expect(codexRolloutParts(home, THREAD).map((part) => part.path)).toEqual([
    join(newest, `rollout-2026-03-05T10-00-00-${THREAD}.jsonl`),
    join(older, `rollout-2025-01-01T10-00-00-${THREAD}.jsonl.zst`),
  ]);
});
