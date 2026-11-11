import { expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { codexContinuity } from "./continuity.js";

// The move copies through the checked rollout boundary in chunks; a write
// that silently leaves a short destination must fail verification.
const realFs = vi.hoisted(() => ({ writeSync: null as null | typeof writeSync }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  realFs.writeSync = fs.writeSync;
  return { ...fs, writeSync: vi.fn(fs.writeSync) };
});

it("cleans a destination whose copied size fails verification", async () => {
  const config = process.env.CLAUDEXOR_CONFIG_DIR!;
  const a = join(config, "profiles", "a"),
    b = join(config, "profiles", "b");
  const rel = join("sessions", "2026", "10", "06", "rollout-fixture-sid.jsonl");
  mkdirSync(join(a, rel, ".."), { recursive: true });
  mkdirSync(b, { recursive: true });
  const source = join(realpathSync(a), rel),
    target = join(realpathSync(b), rel);
  writeFileSync(source, "complete history");
  vi.mocked(writeSync).mockImplementationOnce((...args: unknown[]) => {
    realFs.writeSync!(args[0] as number, "cut");
    return args[3] as number; // claims the whole chunk, wrote three bytes
  });
  const moved = await codexContinuity.move(
    { file: source, sidecars: [], nativeSessionId: "sid" },
    { CLAUDEXOR_PROFILE_LOCATOR: a },
    { CLAUDEXOR_PROFILE_LOCATOR: b },
    "/w",
  );
  expect(moved).toMatchObject({ ok: false, reason: "rollout copy size mismatch" });
  expect(existsSync(target)).toBe(false);
  expect(readFileSync(source, "utf8")).toBe("complete history");
});
