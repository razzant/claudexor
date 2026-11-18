/**
 * Native retention keeps every rollout that a remaining Codex rollout continues
 * from. A fork's first line names its base by physical rollout id
 * (`session_meta.payload.history_base.thread_id`); the base's file name carries
 * that id last, as `rollout-<ts>-<id>` or `rollout-<ts>-<thread>_<rollout>`.
 * Fixtures use temporary homes, real zstd frames and a pair of Codex 0.169.0 headers.
 */
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { CONTINUITY_PROFILE_LOCATOR_ENV } from "@claudexor/core";
import { createCodexAdapter } from "./index.js";
import {
  resetRolloutReadStatsForTests,
  rolloutReadStatsForTests,
  setRolloutReadLimitsForTests,
} from "./rollout-file.js";

const roots: string[] = [];
afterEach(() => {
  setRolloutReadLimitsForTests(null);
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const OLD = new Date("2020-01-01");
const id = (n: number) => `0199aaaa-bbbb-7ccc-8ddd-${String(n).padStart(12, "0")}`;
function header(own: string, base?: string): string {
  const payload = base ? { id: own, history_base: { thread_id: base } } : { id: own };
  return `${JSON.stringify({ type: "session_meta", payload })}\n`;
}

interface Rollout {
  /** The physical id of the rollout this one continues from. */
  base?: string;
  /** The two-id name: this thread id, then the rollout's own id. */
  thread?: string;
  /** Override the generated filename stem. */
  stem?: string;
  /** The header's own id, when it is not the thread's. */
  headerId?: string;
  day?: string;
  zst?: boolean;
  recent?: boolean;
  where?: "sessions" | "archived" | "archived-dated";
  /** Exact file bytes instead of a header. */
  raw?: string | Buffer;
  body?: string;
}
interface PassOptions {
  refs?: Set<string>;
  maxDeletions?: number;
  canPrune?: () => boolean;
  signal?: AbortSignal;
}

function codexHome() {
  const profiles = join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles");
  mkdirSync(profiles, { recursive: true });
  const home = realpathSync(mkdtempSync(join(profiles, "lineage-")));
  roots.push(home);
  const lifetime = createCodexAdapter().nativeHomeLifetime!;
  if (lifetime.status !== "managed") throw new Error("missing native owner");
  const write = (rollout: string, o: Rollout = {}) => {
    const store = o.where?.startsWith("archived") ? "archived_sessions" : "sessions";
    const day = o.day ?? "01";
    const dir = o.where === "archived" ? join(home, store) : join(home, store, "2020", "01", day);
    mkdirSync(dir, { recursive: true });
    const stem = o.stem ?? (o.thread ? `${o.thread}_${rollout}` : rollout);
    const file = join(dir, `rollout-2020-01-${day}T00-00-00-${stem}.jsonl${o.zst ? ".zst" : ""}`);
    const text = header(o.headerId ?? o.thread ?? rollout, o.base) + (o.body ?? "");
    writeFileSync(file, o.raw ?? (o.zst ? zstdCompressSync(Buffer.from(text)) : text));
    const time = o.recent ? new Date() : OLD;
    utimesSync(file, time, time);
    return file;
  };
  const prune = (o: PassOptions = {}) =>
    lifetime.prune({
      home,
      protectedSessionIds: o.refs ?? new Set(),
      olderThan: Date.now() - 30 * 86400000,
      dryRun: false,
      maxDeletions: o.maxDeletions ?? 500,
      canPrune: o.canPrune ?? (() => true),
      ...(o.signal ? { signal: o.signal } : {}),
    });
  return { home, write, prune };
}

it.each<[string, Rollout]>([
  ["recent", { recent: true }],
  ["referenced", {}],
  ["archived", { where: "archived" }],
  ["dated archived", { where: "archived-dated" }],
  ["two-id", { thread: id(9) }],
  ["differently named", { stem: "fork" }],
])("keeps a %s fork's whole history and retires an unrelated old rollout", async (kind, fork) => {
  const h = codexHome();
  // The middle base is compressed: its own base is known only from its decoded header.
  const chain = [
    h.write(id(1), { zst: true }),
    h.write(id(2), { base: id(1), zst: true }),
    h.write(id(3), { base: id(2), ...fork }),
  ];
  const unrelated = h.write(id(4));
  const result = await h.prune({ refs: new Set(kind === "referenced" ? [id(3)] : []) });
  expect(result.errors).toEqual([]);
  expect(result.deleted_files).toEqual([unrelated]);
  for (const file of chain) expect(existsSync(file)).toBe(true);
});

it("retires an old chain one generation per pass, a base only after its fork", async () => {
  const h = codexHome();
  const a = h.write(id(1));
  const b = h.write(id(2), { base: id(1), zst: true });
  const c = h.write(id(3), { base: id(2) });
  const unrelated = h.write(id(4));
  const passes: string[][] = [];
  for (let pass = 0; pass < 4; pass += 1) {
    const result = await h.prune();
    expect(result.errors).toEqual([]);
    passes.push([...result.deleted_files].sort());
  }
  expect(passes).toEqual([[c, unrelated].sort(), [b], [a], []]);
});

it("uses the final hyphen-delimited ID for group age and removes only one-ID files", async () => {
  const h = codexHome();
  const held = h.write(id(1));
  const other = [h.write(id(2)), h.write(id(3))];
  const companion = join(dirname(held), `rollout-${id(2)}-copy-${id(1)}.jsonl`);
  renameSync(h.write(id(1), { stem: "copy", recent: true }), companion);
  const native = h.write(id(3), { thread: id(2), recent: true });
  const imported = h.write(id(3), { stem: `${id(3)}-copy`, recent: true });
  const first = await h.prune();
  expect(first.deleted_files.sort()).toEqual(other.sort());
  expect(first).toMatchObject({ kept_recent: 1, kept_unknown: 3, errors: [] });
  expect(existsSync(held)).toBe(true);

  utimesSync(companion, OLD, OLD);
  expect(await h.prune()).toMatchObject({ deleted_files: [held], errors: [] });
  expect([companion, native, imported].every(existsSync)).toBe(true);
});

it("rechecks a retained hyphenated part before each sibling unlink", async () => {
  const h = codexHome();
  const siblings = [h.write(id(1)), h.write(id(1), { zst: true })];
  const companion = h.write(id(1), { stem: `${id(2)}-copy-${id(1)}` });
  const result = await h.prune({
    canPrune: () => {
      if (siblings.some((path) => !existsSync(path))) {
        const now = new Date();
        utimesSync(companion, now, now);
      }
      return true;
    },
  });
  expect(result).toMatchObject({
    holdReason: `rollout changed: ${companion}`,
    kept_unknown: 0,
    truncated: true,
  });
  expect(result.deleted_files).toHaveLength(1);
  expect(siblings.filter(existsSync)).toHaveLength(1);
  expect(existsSync(companion)).toBe(true);
  expect(await h.prune()).toMatchObject({ deleted_files: [], kept_recent: 1, errors: [] });
});

it.each<[string, string]>([
  ["imported/01/02", `rollout-2020-01-02T00-00-00-${id(2)}.jsonl`],
  ["2020/backup/02", `copy-${id(2)}-part.jsonl.zst`],
  ["2020/01/rollout-backup.jsonl", `copy-${id(2)}-part.jsonl`],
  ["2020/01/02", `copy-${id(2)}-part.jsonl`],
  ["2020/01/02", `rollout-${id(9)}-copy-${id(2)}.jsonl`],
])("keeps the old fork at %s/%s and its dated base", async (layout, name) => {
  const h = codexHome();
  const base = h.write(id(1));
  const original = h.write(id(2), { base: id(1), zst: name.endsWith(".zst") });
  const other = h.write(id(3));
  const dir = join(h.home, "sessions", layout);
  mkdirSync(dir, { recursive: true });
  const fork = join(dir, name);
  renameSync(original, fork);
  writeFileSync(join(dir, "notes.jsonl"), "unrelated text");

  const continuity = createCodexAdapter().continuity!;
  expect(
    await continuity.locate(
      { nativeSessionId: id(2), cwd: "/scratch" },
      { [CONTINUITY_PROFILE_LOCATOR_ENV]: h.home },
    ),
  ).toMatchObject({ found: true, file: fork });
  expect(await h.prune()).toMatchObject({
    errors: [],
    deleted_files: [other],
    kept_referenced: 1,
    kept_unknown: 2,
  });
  expect([base, fork].every(existsSync)).toBe(true);

  writeFileSync(fork, "torn header");
  const held = await h.prune();
  expect(held).toMatchObject({ deleted_files: [], kept_unknown: 1 });
  expect(held.holdReason).toContain(fork);

  const secondFork = join(dir, `copy-${id(5)}.jsonl`);
  writeFileSync(secondFork, "another torn header");
  const bothHeld = await h.prune();
  expect(bothHeld).toMatchObject({ deleted_files: [], kept_unknown: 1 });
  expect(bothHeld.holdReason).toContain(fork);
  expect(bothHeld.holdReason).toContain(secondFork);
  expect([base, fork, secondFork, join(dir, "notes.jsonl")].every(existsSync)).toBe(true);
});

it("keeps the physical base named by a Codex 0.169.0 fork header", async () => {
  const h = codexHome();
  // First records from the native QA pair, with neutral paths and instruction text.
  const baseId = "87d9a2ff-ad0c-4e0e-9fdc-916bf2ed1e02";
  const forkId = "01a1eeb2-6242-71c1-87b2-2cad32e9f504";
  const baseHeader = {
    timestamp: "2026-11-18T12:47:09Z",
    ordinal: 0,
    type: "session_meta",
    payload: {
      id: baseId,
      session_id: baseId,
      timestamp: "2026-11-18T12:47:09Z",
      cwd: "/workspace",
      originator: "codex",
      cli_version: "0.169.0",
      source: "cli",
      model_provider: "qa",
      account_scoped: false,
      history_mode: "paginated",
    },
  };
  const forkHeader = {
    timestamp: "2026-11-18T12:47:10.533Z",
    ordinal: 5,
    type: "session_meta",
    payload: {
      account_scoped: true,
      session_id: forkId,
      id: forkId,
      forked_from_id: baseId,
      forked_from_ordinal_exclusive: 5,
      timestamp: "2026-11-18T12:47:10.508Z",
      cwd: "/workspace",
      runtime_workspace_roots: ["/workspace"],
      originator: "codex",
      cli_version: "0.169.0",
      source: "vscode",
      model_provider: "qa",
      base_instructions: {
        text: "Fixture instructions.",
        provenance: { type: "model", model: "mock-model" },
      },
      history_mode: "paginated",
      history_base: { thread_id: baseId, end_ordinal_exclusive: 5, end_byte_offset: 1429 },
      multi_agent_version: "v1",
      context_window: { window_id: "01a1eeb2-629d-7cc0-893e-e39c46d79d9e" },
    },
  };
  const base = h.write(baseId, { raw: JSON.stringify(baseHeader) + "\n" });
  const fork = h.write(forkId, { raw: JSON.stringify(forkHeader) + "\n" });
  const other = h.write(id(4));
  expect(await h.prune({ refs: new Set([forkId]) })).toMatchObject({
    errors: [],
    deleted_files: [other],
  });
  expect([base, fork].every(existsSync)).toBe(true);
});

it("a reference published during the proof keeps that fork and its base", async () => {
  const h = codexHome();
  const base = h.write(id(1));
  const fork = h.write(id(2), { base: id(1) });
  const unrelated = h.write(id(3));
  const refs = new Set<string>();
  const late = await h.prune({
    refs,
    canPrune: () => {
      refs.add(id(2));
      appendFileSync(fork, '{"type":"event_msg","payload":{"type":"task_started"}}\n');
      return true;
    },
  });
  expect(late.errors).toEqual([]);
  expect(late.deleted_files).toEqual([unrelated]);
  expect(late.kept_referenced).toBe(2);
  expect((await h.prune({ refs })).deleted_files).toEqual([]);
  expect(existsSync(base) && existsSync(fork)).toBe(true);
});

it("defers a harness-wide reference absent from this home for the current pass only", async () => {
  const h = codexHome();
  const base = h.write(id(1));
  const other = h.write(id(2));
  const refs = new Set<string>();
  const result = await h.prune({
    refs,
    canPrune: () => {
      refs.add(id(3));
      return true;
    },
  });
  expect(result.deleted_files).toEqual([]);
  expect(result.errors.join()).toContain(`${id(3)} has no recognized filename ID in inventory`);
  expect(result.truncated).toBe(true);
  expect(result.holdReason).toContain(h.home);
  // While the ID is still absent it is now an initial reference, possibly from another home.
  expect((await h.prune({ refs })).deleted_files.sort()).toEqual([base, other].sort());
  h.write(id(1));
  h.write(id(2));
  const fork = h.write(id(3), { base: id(1) });
  expect(await h.prune({ refs })).toMatchObject({ errors: [], deleted_files: [other] });
  expect([base, fork].every(existsSync)).toBe(true);
});

it("reports an unrecognized late ID even when its imported header was inventoried", async () => {
  const h = codexHome();
  const base = h.write(id(1));
  const fork = h.write(id(2), { stem: "import", base: id(1) });
  const direct = h.write(id(3));
  const other = h.write(id(4));
  const refs = new Set<string>();
  const held = await h.prune({
    refs,
    canPrune: () => {
      refs.add(id(2));
      refs.add(id(3));
      return true;
    },
  });
  expect(held.holdReason).toContain(`${id(2)} has no recognized filename ID in inventory`);
  expect(held).toMatchObject({ deleted_files: [], kept_referenced: 2, truncated: true });
  expect(await h.prune({ refs })).toMatchObject({ deleted_files: [other], errors: [] });
  expect([base, fork, direct].every(existsSync)).toBe(true);
});

it.each<[string, Rollout]>([
  ["empty file", { raw: "" }],
  ["torn header", { raw: header(id(5), id(1)).slice(0, 40) }],
  ["complete JSON without its newline", { raw: header(id(5)).trimEnd() }],
  ["malformed JSON with a newline", { raw: '{"type":"session_meta",}\n' }],
  ["non-header record", { raw: '{"type":"event_msg","payload":{}}\n' }],
  ["missing payload", { raw: '{"type":"session_meta"}\n' }],
  ["empty session metadata", { raw: '{"type":"session_meta","payload":{}}\n' }],
  ["oversized header", { raw: " ".repeat(512) + header(id(5)) }],
  ["invalid physical id", { base: "family" }],
  ["corrupt archived zstd frame", { where: "archived", zst: true, raw: "not a zstd frame" }],
])("defers the home on a %s and resumes once the header is readable", async (_kind, bad) => {
  const h = codexHome();
  const base = h.write(id(1));
  const other = h.write(id(4));
  const file = h.write(id(5), { ...bad, recent: true });
  setRolloutReadLimitsForTests({ maxLineBytes: 256 });
  const held = await h.prune();
  expect(held).toMatchObject({ deleted_files: [], freed_bytes: 0, truncated: false });
  expect(held.holdReason).toContain(file);
  expect(held.errors.join()).toContain(file);
  expect([base, other, file].every(existsSync)).toBe(true);
  const repaired = h.write(id(5), { where: bad.where, zst: bad.zst, base: id(1), recent: true });
  expect(repaired).toBe(file);
  expect(await h.prune()).toMatchObject({ errors: [], deleted_files: [other] });
  expect([base, repaired].every(existsSync)).toBe(true);
});

it("holds two unreadable rollouts through a cap and a late reference until both read", async () => {
  const h = codexHome();
  const a = h.write(id(1), { raw: "" });
  const b = h.write(id(2), { raw: "bad\n" });
  const other = h.write(id(4));
  const capped = await h.prune({ maxDeletions: 1 });
  expect(capped).toMatchObject({ deleted_files: [], truncated: false });
  expect(capped.holdReason).toContain(a);
  expect(capped.holdReason).toContain(b);
  const leaf = h.write(id(3), { base: id(1) });
  const refs = new Set<string>();
  const late = h.prune({ refs });
  refs.add(id(2));
  expect((await late).deleted_files).toEqual([]);
  expect([a, b, leaf, other].every(existsSync)).toBe(true);
  h.write(id(1));
  const stillHeld = await h.prune({ refs });
  expect(stillHeld.deleted_files).toEqual([]);
  expect(stillHeld.errors.join()).toContain(b);
  h.write(id(2), { base: id(1) });
  const resumed = await h.prune({ refs });
  expect(resumed.errors).toEqual([]);
  expect(resumed.deleted_files.sort()).toEqual([leaf, other].sort());
  expect([a, b].every(existsSync)).toBe(true);
});

it.each([true, false])(
  "counts both surviving siblings after a late reference (unreadable zstd: %s)",
  async (zst) => {
    const h = codexHome();
    const parts = [h.write(id(1)), h.write(id(1), { zst: true })];
    const bad = h.write(id(1), { zst, raw: "bad\n" });
    const base = h.write(id(2));
    const recent = h.write(id(3), { recent: true, base: id(2) });
    const refs = new Set([id(2)]);
    const held = await h.prune({
      refs,
      canPrune: () => {
        refs.add(id(1));
        return true;
      },
    });
    expect(held).toMatchObject({
      deleted_files: [],
      freed_bytes: 0,
      kept_referenced: 3,
      kept_recent: 1,
      truncated: false,
    });
    expect(held.holdReason).toContain(bad);
    expect([...parts, base, recent].every(existsSync)).toBe(true);
  },
);

it.each(["cap", "cancellation", "proof failure", "late reference"])(
  "preserves both representations' bases across a %s between unlinks",
  async (stop) => {
    const h = codexHome();
    const bases = [h.write(id(4)), h.write(id(5))];
    const parts = [h.write(id(3), { base: id(4) }), h.write(id(3), { base: id(5), zst: true })];
    const refs = new Set<string>();
    let checks = 0;
    const cancel = new AbortController();
    const first = await h.prune({
      refs,
      signal: cancel.signal,
      maxDeletions: stop === "cap" ? 1 : 500,
      canPrune: () => {
        checks++;
        if (checks === 1 && stop === "cancellation") cancel.abort();
        if (checks === 2) {
          if (stop === "proof failure") throw new Error("SQL read failed");
          refs.add(id(3));
        }
        return true;
      },
    });
    expect(first.deleted_files).toHaveLength(1);
    expect(first.kept_referenced).toBe(stop === "late reference" ? 3 : 2);
    expect(first.truncated).toBe(stop === "cap" || stop === "cancellation");
    if (stop === "proof failure") expect(first.errors.join()).toContain("SQL read failed");
    else if (stop === "cancellation") expect(first.errors.join()).toContain("cancelled");
    else expect(first.errors).toEqual([]);
    expect(bases.every(existsSync)).toBe(true);
    const removed = parts.indexOf(first.deleted_files[0]!);
    expect(removed).toBeGreaterThanOrEqual(0);
    refs.add(id(3));
    expect(await h.prune({ refs })).toMatchObject({ errors: [], deleted_files: [bases[removed]] });
    expect([parts[1 - removed]!, bases[1 - removed]!].every(existsSync)).toBe(true);
  },
);

it.each([true, false])("a recent sibling retains an unreadable file (zstd: %s)", async (zst) => {
  const h = codexHome();
  const base = h.write(id(1));
  const good = h.write(id(2), { zst: !zst, base: id(1), recent: true });
  const bad = h.write(id(2), { zst, raw: "bad\n" });
  const result = await h.prune();
  expect(result.deleted_files).toEqual([]);
  expect(result.errors.join()).toContain(bad);
  expect([base, good, bad].every(existsSync)).toBe(true);
});

it.each([true, false])("retires only the sole unreadable old file (zstd: %s)", async (zst) => {
  const h = codexHome();
  const base = h.write(id(1));
  const good = h.write(id(2), { zst: !zst, base: id(1) });
  const bad = h.write(id(2), { zst, raw: "broken\n" });
  const size = statSync(bad).size;
  const first = await h.prune();
  expect(first).toMatchObject({ deleted_files: [bad], freed_bytes: size, truncated: true });
  expect(first.holdReason).toContain(bad);
  expect(existsSync(bad)).toBe(false);
  expect([base, good].every(existsSync)).toBe(true);
  const next = await h.prune();
  expect(next.deleted_files).toEqual([good]);
  expect(next).toMatchObject({ errors: [], truncated: false });
  expect(next.holdReason).toBeUndefined();
  expect(existsSync(base)).toBe(true);
});

it("completes when only a named base and a newly referenced fork remain", async () => {
  const h = codexHome();
  const base = h.write(id(1));
  const fork = h.write(id(2), { base: id(1) });
  const bad = h.write(id(3), { raw: "bad\n" });
  const refs = new Set<string>();
  const result = await h.prune({
    refs,
    canPrune: () => {
      refs.add(id(2));
      return true;
    },
  });
  expect(result).toMatchObject({
    deleted_files: [bad],
    freed_bytes: 4,
    kept_referenced: 2,
    truncated: false,
    errors: [],
  });
  expect(result.holdReason).toBeUndefined();
  expect([base, fork].every(existsSync)).toBe(true);

  h.write(id(1), { recent: true });
  h.write(id(3), { raw: "bad\n" });
  expect(await h.prune({ refs })).toMatchObject({
    deleted_files: [bad],
    kept_recent: 1,
    kept_referenced: 1,
    truncated: false,
    errors: [],
  });
});

it("holds a sole unreadable base named by a readable old fork", async () => {
  const h = codexHome();
  const base = h.write(id(1), { raw: "bad\n" });
  const fork = h.write(id(2), { base: id(1) });
  const result = await h.prune();
  expect(result).toMatchObject({
    deleted_files: [],
    freed_bytes: 0,
    kept_referenced: 1,
    truncated: false,
  });
  expect(result.holdReason).toContain(base);
  expect([base, fork].every(existsSync)).toBe(true);
  h.write(id(1));
  expect(await h.prune()).toMatchObject({ deleted_files: [fork], kept_referenced: 1, errors: [] });
  expect(existsSync(base)).toBe(true);
});

it.each(["sessions", "an existing archive", "a new archive"])(
  "defers remaining deletions when Codex publishes a new fork in %s during the proof",
  async (store) => {
    const h = codexHome();
    const old = [h.write(id(1)), h.write(id(2))];
    const newDay = join(dirname(dirname(old[0]!)), "02");
    mkdirSync(newDay);
    utimesSync(newDay, OLD, OLD);
    const archive = join(h.home, "archived_sessions");
    if (store === "an existing archive") {
      mkdirSync(archive);
      utimesSync(archive, OLD, OLD);
    }
    let base = "";
    let fork = "";
    const result = await h.prune({
      canPrune: () => {
        const remaining = old.filter(existsSync);
        if (remaining.length === 1) {
          base = remaining[0]!;
          const parent = id(old.indexOf(base) + 1);
          fork =
            store === "sessions"
              ? h.write(id(3), { base: parent, recent: true, day: "02" })
              : h.write(id(3), { base: parent, where: "archived" });
        }
        return true;
      },
    });
    expect(result.deleted_files).toHaveLength(1);
    const changed = store === "sessions" ? newDay : archive;
    expect(result.errors.join()).toContain(`rollout directory changed: ${changed}`);
    expect(result.holdReason).toContain(changed);
    expect(result.truncated).toBe(true);
    expect([base, fork].every(existsSync)).toBe(true);
    const other = h.write(id(4));
    expect(await h.prune()).toMatchObject({ errors: [], deleted_files: [other] });
    expect([base, fork].every(existsSync)).toBe(true);
  },
);

it("finds a base by its file's rollout id and never retires a two-id rollout", async () => {
  const h = codexHome();
  const base = h.write(id(2), { headerId: id(7) });
  // An escaped JSON key denotes the same field as the literal spelling.
  const raw = header(id(8), id(2)).replace("history_base", "history\\u005fbase");
  const fork = h.write(id(3), { thread: id(8), raw });
  const unrelated = h.write(id(4));
  const result = await h.prune();
  expect(result).toMatchObject({ deleted_files: [unrelated], errors: [], kept_unknown: 1 });
  expect(existsSync(base) && existsSync(fork)).toBe(true);
});

it("skips headers and the archive when no old unreferenced group exists", async () => {
  const h = codexHome();
  h.write(id(1), { raw: "" });
  h.write(id(2), { recent: true });
  writeFileSync(join(h.home, "archived_sessions"), "not a directory");
  resetRolloutReadStatsForTests();
  expect(await h.prune({ refs: new Set([id(1)]) })).toMatchObject({
    errors: [],
    deleted_files: [],
    kept_recent: 1,
    kept_referenced: 1,
  });
  expect(rolloutReadStatsForTests()).toMatchObject({ headReads: 0, bytes: 0 });
});

it.each([0, -1])("skips archive and header reads with budget %i", async (maxDeletions) => {
  const h = codexHome();
  const old = h.write(id(1));
  writeFileSync(join(h.home, "archived_sessions"), "not a directory");
  resetRolloutReadStatsForTests();
  expect(await h.prune({ maxDeletions })).toMatchObject({
    errors: [],
    deleted_files: [],
    freed_bytes: 0,
    truncated: true,
  });
  expect(existsSync(old)).toBe(true);
  expect(rolloutReadStatsForTests()).toMatchObject({ headReads: 0, bytes: 0 });
});

it.each(["sessions/2020/01/01", "archived_sessions"])(
  "holds a rollout-shaped directory at file depth in %s",
  async (layout) => {
    const h = codexHome();
    const old = h.write(id(1));
    const dir = join(h.home, layout, "rollout-backup.jsonl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dirname(old), "notes.jsonl"), "unrelated text");
    const held = await h.prune();
    expect(held).toMatchObject({ deleted_files: [], kept_unknown: 1 });
    expect(held.holdReason).toContain(dir);
    expect([old, dir].every(existsSync)).toBe(true);
  },
);

it("records a partial pass and defers the home if a remaining candidate changes", async () => {
  const h = codexHome();
  const files = [h.write(id(1)), h.write(id(2))];
  let changed = "";
  const result = await h.prune({
    canPrune: () => {
      const remaining = files.filter(existsSync);
      if (remaining.length === 1) {
        changed = remaining[0]!;
        appendFileSync(changed, '{"type":"event_msg"}\n');
      }
      return true;
    },
  });
  expect(result.deleted_files).toEqual(files.filter((file) => file !== changed));
  expect(result.freed_bytes).toBe(Buffer.byteLength(header(id(1))));
  expect(result.truncated).toBe(true);
  expect(result.holdReason).toBe(`rollout changed: ${changed}`);
  expect(result.kept_unknown).toBe(0);
  expect(existsSync(changed)).toBe(true);
});

it("reads a bounded prefix once per representation across multiple unlinks", async () => {
  const h = codexHome();
  const body = (bytes: number) => {
    const payload = { text: randomBytes(bytes).toString("base64") };
    return `${JSON.stringify({ type: "response_item", payload })}\n`;
  };
  const base = h.write(id(1), { zst: true, body: body(3 << 20) });
  const fork = h.write(id(2), { base: id(1), recent: true, body: body(3 << 20) });
  const unrelated = [h.write(id(3)), h.write(id(3), { zst: true }), h.write(id(4))];
  resetRolloutReadStatsForTests();
  const result = await h.prune();
  expect(result.deleted_files.sort()).toEqual(unrelated.sort());
  expect(result.errors).toEqual([]);
  expect(existsSync(base)).toBe(true);
  expect(statSync(base).size + statSync(fork).size).toBeGreaterThan(6 << 20);
  expect(rolloutReadStatsForTests().headReads).toBe(5);
  expect(rolloutReadStatsForTests().bytes).toBeLessThan(512 << 10);
  expect(rolloutReadStatsForTests().peakCarryBytes).toBeLessThan(4 << 10);
});

it("bounds compressed input even when it produces no header bytes", async () => {
  const h = codexHome();
  const base = h.write(id(1));
  const skip = Buffer.alloc(64 << 10);
  skip.writeUInt32LE(0x184d2a50); // Zstandard skippable frame
  skip.writeUInt32LE(skip.length - 8, 4);
  const raw = Buffer.concat([skip, zstdCompressSync(Buffer.from(header(id(2), id(1))))]);
  const fork = h.write(id(2), { where: "archived", zst: true, raw });
  setRolloutReadLimitsForTests({ maxLineBytes: 256, chunkBytes: 128 });
  resetRolloutReadStatsForTests();
  const result = await h.prune();
  expect(result.deleted_files).toEqual([]);
  expect(result.errors.join()).toContain(fork);
  expect(rolloutReadStatsForTests().bytes).toBeLessThanOrEqual(statSync(base).size + 384);
  expect([base, fork].every(existsSync)).toBe(true);
});

it.runIf(process.platform !== "win32")(
  "a linked rollout or archive is never read, and keeps the old rollouts",
  async () => {
    const h = codexHome();
    const old = h.write(id(1));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "lineage-outside-")));
    roots.push(outside);
    const target = join(outside, `rollout-target-${id(2)}.jsonl`);
    writeFileSync(target, header(id(2), id(1)));
    const day = join(h.home, "sessions", "2020", "01", "01");
    const link = join(day, `rollout-2020-01-01T00-00-00-${id(2)}.jsonl`);
    symlinkSync(target, link);
    writeFileSync(join(day, ".DS_Store"), "foreign metadata");
    const noCandidates = await h.prune({ refs: new Set([id(1)]) });
    expect(noCandidates).toMatchObject({ kept_unknown: 2, errors: [] });
    const held = await h.prune();
    expect(held.deleted_files).toEqual([]);
    expect(held.errors.join("\n")).toContain(link);
    expect(held.kept_unknown).toBe(1);
    rmSync(link);
    for (const name of ["02", "imported"]) {
      const linkedDay = join(dirname(day), name);
      symlinkSync(outside, linkedDay, "dir");
      const dayHeld = await h.prune();
      expect(dayHeld.deleted_files).toEqual([]);
      expect(dayHeld.errors.join()).toContain(linkedDay);
      expect(dayHeld.kept_unknown).toBe(1);
      rmSync(linkedDay);
    }
    symlinkSync(outside, join(h.home, "archived_sessions"), "dir");
    await expect(h.prune()).rejects.toThrow("archived_sessions");
    expect(existsSync(old) && existsSync(target)).toBe(true);
  },
);
