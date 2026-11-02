/**
 * #573: every Codex rollout reader starts from the thread's NEWEST logical
 * part. `X.jsonl` and `X.jsonl.zst` are two representations of one part, so a
 * plain sibling is read; a newest part that exists only compressed (or only
 * through a link) leaves the model, quota and vendor failure unknown instead of
 * reading an older part's facts as current. Continuity names that newest part
 * as the holder and still moves every part, compressed history included.
 * Synthetic Claudexor-owned CODEX_HOMEs only; nothing is decompressed.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CONTINUITY_PROFILE_LOCATOR_ENV } from "@claudexor/core";
import { codexContinuity } from "./continuity.js";
import {
  codexRolloutCursor,
  codexTranscriptModel,
  codexTranscriptRateLimits,
  codexTranscriptVendorFailure,
} from "./transcript.js";

/** Every directory the rollout walk lists (an exact pass-through of readdirSync). */
const listed = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const readdirSync = ((path: Parameters<typeof fs.readdirSync>[0], options?: never) => {
    listed.push(String(path));
    return fs.readdirSync(path, options);
  }) as typeof fs.readdirSync;
  return { ...fs, readdirSync };
});

const THREAD = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
const STARTED_S = 1_790_000_000;
const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

const json = (record: unknown) => JSON.stringify(record);
/** One turn's records in the recorded shapes: its model, quota reading and failure. */
const turn = (id: string, model: string, used: number, code: string) =>
  [
    json({ type: "turn_context", payload: { turn_id: id, model } }),
    json({
      type: "event_msg",
      payload: { type: "token_count", rate_limits: { primary: { used_percent: used } } },
    }),
    json({
      type: "event_msg",
      payload: { type: "task_started", turn_id: id, started_at: STARTED_S },
    }),
    json({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: id,
        started_at: STARTED_S,
        error: { message: code, codex_error_info: code },
      },
    }),
  ].join("\n") + "\n";
const OLD = turn("t-old", "gpt-old", 10, "server_overloaded");
const NEW = turn("t-new", "gpt-new", 70, "usage_limit_exceeded");

type Part = [day: string, suffix: ".jsonl" | ".jsonl.zst", content: string];
/** A Claudexor-owned CODEX_HOME (the continuity locator admits only those) holding `parts`. */
function codexHome(parts: Part[]): { home: string; paths: string[] } {
  const profiles = join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles");
  mkdirSync(profiles, { recursive: true });
  const home = realpathSync(mkdtempSync(join(profiles, "codex-newest-")));
  roots.push(home);
  const paths = parts.map(([day, suffix, content]) => {
    const dir = join(home, "sessions", "2026", "10", day);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-2026-10-${day}T10-00-00-${THREAD}${suffix}`);
    writeFileSync(path, content);
    return path;
  });
  return { home, paths };
}
/** The three transcript consumers, each read on its own. */
const facts = (home: string) => ({
  model: codexTranscriptModel(home, THREAD),
  used: codexTranscriptRateLimits(home, THREAD)?.constraints[0]?.used_ratio ?? null,
  vendor: codexTranscriptVendorFailure(home, THREAD, STARTED_S * 1000)?.code ?? null,
});
const UNKNOWN = { model: null, used: null, vendor: null };

describe("Codex rollout readers take the newest logical part (#573)", () => {
  it("a newest part that exists only compressed leaves every fact unknown, never an older part's", () => {
    const { home } = codexHome([
      ["27", ".jsonl", OLD],
      ["28", ".jsonl.zst", "compressed bytes, never decoded"],
    ]);
    expect(facts(home)).toEqual(UNKNOWN);
  });

  it("reads the newest part's plain sibling, and a run's cursor reaches it once it exists", () => {
    const { home, paths } = codexHome([
      ["27", ".jsonl", OLD],
      ["28", ".jsonl.zst", "compressed bytes, never decoded"],
    ]);
    const cursor = codexRolloutCursor();
    expect(codexTranscriptRateLimits(home, THREAD, cursor)).toBeNull();
    // The same part's plain representation: a sibling, not an older part.
    writeFileSync(paths[1]!.slice(0, -".zst".length), NEW);
    expect(codexTranscriptRateLimits(home, THREAD, cursor)?.constraints[0]?.used_ratio).toBe(0.7);
    expect(facts(home)).toEqual({ model: "gpt-new", used: 0.7, vendor: "usage_limit_exceeded" });
  });

  it("decides a newest part without a plain sibling from its own day, never listing older days", () => {
    const { home, paths } = codexHome([
      ["01", ".jsonl", OLD],
      ["28", ".jsonl.zst", "compressed bytes, never decoded"],
    ]);
    // Older days between them hold nothing of this thread; a walk would list every one.
    for (let day = 2; day < 28; day += 1)
      mkdirSync(join(home, "sessions", "2026", "10", String(day).padStart(2, "0")));
    const sessions = join(home, "sessions");
    const walked = () =>
      [...new Set(listed.splice(0))]
        .filter((dir) => dir === sessions || dir.startsWith(sessions + sep))
        .map((dir) => relative(sessions, dir))
        .sort();
    listed.length = 0;
    expect(facts(home)).toEqual(UNKNOWN);
    expect(walked()).toEqual(["", "2026", join("2026", "10"), join("2026", "10", "28")]);
    // Nothing remembers the absence: the sibling is read once it appears, from that day.
    writeFileSync(paths[1]!.slice(0, -".zst".length), NEW);
    expect(facts(home)).toEqual({ model: "gpt-new", used: 0.7, vendor: "usage_limit_exceeded" });
    expect(walked()).toEqual(["", "2026", join("2026", "10"), join("2026", "10", "28")]);
  });

  it.runIf(process.platform !== "win32")(
    "a newest part reachable only through a link is unknown as well",
    () => {
      const { home } = codexHome([["27", ".jsonl", OLD]]);
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "codex-newest-outside-")));
      roots.push(outside);
      writeFileSync(join(outside, `rollout-2026-10-28T10-00-00-${THREAD}.jsonl`), NEW);
      symlinkSync(outside, join(home, "sessions", "2026", "10", "28"));
      expect(facts(home)).toEqual(UNKNOWN);
    },
  );

  it("continuity names the newest part as the holder and moves every part", async () => {
    const source = codexHome([
      ["27", ".jsonl", OLD],
      ["28", ".jsonl.zst", "compressed bytes, never decoded"],
    ]);
    const [older, newest] = source.paths;
    const fromEnv = { [CONTINUITY_PROFILE_LOCATOR_ENV]: source.home };
    const located = await codexContinuity.locate({ nativeSessionId: THREAD, cwd: "/w" }, fromEnv);
    expect(located).toMatchObject({ found: true, file: newest, sidecars: [older] });
    if (!located.found) throw new Error("not located");
    const target = codexHome([]);
    const moved = await codexContinuity.move(
      { file: located.file, sidecars: located.sidecars, nativeSessionId: THREAD },
      fromEnv,
      { [CONTINUITY_PROFILE_LOCATOR_ENV]: target.home },
      "/w",
    );
    expect(moved).toMatchObject({ ok: true, resumeRef: { nativeSessionId: THREAD } });
    for (const part of [older!, newest!])
      expect(existsSync(join(target.home, relative(source.home, part)))).toBe(true);
  });
});
