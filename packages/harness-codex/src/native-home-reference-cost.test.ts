import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCodexAdapter } from "./index.js";

it("normalizes only when the reference set grows while retaining late mixed-case sessions", async () => {
  const profiles = join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles");
  mkdirSync(profiles, { recursive: true });
  const home = realpathSync(mkdtempSync(join(profiles, "reference-cost-")));
  const lifetime = createCodexAdapter().nativeHomeLifetime!;
  if (lifetime.status !== "managed") throw new Error("missing native owner");
  const id = (n: number) => `abcdefab-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const refs = new Set(Array.from({ length: 17000 }, (_, n) => id(n + 10)));
  refs.add(id(1).toUpperCase());
  const walk = vi.spyOn(refs, Symbol.iterator);
  try {
    const day = join(home, "sessions", "2020", "01", "01");
    mkdirSync(day, { recursive: true });
    const paths = [1, 2, 3, 4].map((n) => {
      const path = join(day, `rollout-2020-01-01T00-00-00-${id(n)}.jsonl`);
      writeFileSync(path, `part ${n}`);
      utimesSync(path, new Date("2020-01-01"), new Date("2020-01-01"));
      return path;
    });
    const result = await lifetime.prune({
      home,
      protectedSessionIds: refs,
      olderThan: Date.now() - 30 * 86400000,
      dryRun: false,
      maxDeletions: 500,
      canPrune: () => {
        refs.add(id(2).replace("abcdefab", "aBcDeFaB"));
        return true;
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.deleted_files.sort()).toEqual(paths.slice(2).sort());
    expect(paths.slice(0, 2).every((path) => existsSync(path))).toBe(true);
    expect(walk).toHaveBeenCalledTimes(2); // Initial proof and the one new reference.
  } finally {
    walk.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
});
