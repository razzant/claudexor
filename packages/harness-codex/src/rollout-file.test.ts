import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  codexRolloutParts,
  copyCodexRolloutPart,
  openCodexRolloutPart,
  resetRolloutReadStatsForTests,
  rolloutReadStatsForTests,
  scanRolloutLines,
  setRolloutReadLimitsForTests,
  type MarkedLine,
} from "./rollout-file.js";

const THREAD = "0199dddd-eeee-7fff-8000-111122223333";
const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
afterEach(() => setRolloutReadLimitsForTests(null));
const scratch = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `codex-rollout-file-${label}-`));
  roots.push(dir);
  return realpathSync(dir);
};
const posix = process.platform !== "win32";

/** A home with one plain rollout for THREAD on 2026/10/28, returning its path. */
function seed(home: string, content: string, day = ["2026", "10", "28"], name = THREAD): string {
  const dir = join(home, "sessions", ...day);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${day.join("-")}T10-00-00-${name}.jsonl`);
  writeFileSync(file, content);
  return file;
}

describe("codexRolloutParts (shared discovery)", () => {
  it("names every part newest day first, .jsonl.zst included, and canonicalizes a linked home", () => {
    const home = scratch("parts");
    const older = seed(home, "a\n", ["2026", "09", "30"]);
    const newer = seed(home, "b\n");
    const zst = `${newer}.zst`;
    writeFileSync(zst, "z");
    seed(home, "other\n", ["2026", "10", "28"], "0199dddd-eeee-7fff-8000-999999999999");
    expect(codexRolloutParts(home, THREAD)).toEqual([
      { path: zst, plain: true },
      { path: newer, plain: true },
      { path: older, plain: true },
    ]);
    if (!posix) return;
    // A selected home that is itself a link (or under one) stays usable.
    const alias = join(scratch("alias"), "home-link");
    symlinkSync(home, alias);
    expect(codexRolloutParts(alias, THREAD).map((part) => part.path)).toEqual([zst, newer, older]);
    expect(codexRolloutParts(join(home, "absent"), THREAD)).toEqual([]);
  });

  it.runIf(posix)(
    "detects a linked part, a part under a linked day or sessions dir, and non-files — none plain",
    () => {
      const outside = scratch("outside");
      const target = join(outside, "target.jsonl");
      writeFileSync(target, "outside\n");
      const home = scratch("linked");
      const day = join(home, "sessions", "2026", "10", "28");
      mkdirSync(day, { recursive: true });
      symlinkSync(target, join(day, `rollout-a-${THREAD}.jsonl`));
      mkdirSync(join(day, `rollout-b-${THREAD}.jsonl`));
      execFileSync("mkfifo", [join(day, `rollout-c-${THREAD}.jsonl`)]);
      const outsideDay = join(outside, "day");
      mkdirSync(outsideDay);
      writeFileSync(join(outsideDay, `rollout-d-${THREAD}.jsonl`), "outside day\n");
      symlinkSync(outsideDay, join(home, "sessions", "2026", "10", "29"));
      expect(codexRolloutParts(home, THREAD)).toEqual([
        {
          path: join(home, "sessions", "2026", "10", "29", `rollout-d-${THREAD}.jsonl`),
          plain: false,
        },
        { path: join(day, `rollout-c-${THREAD}.jsonl`), plain: false },
        { path: join(day, `rollout-b-${THREAD}.jsonl`), plain: false },
        { path: join(day, `rollout-a-${THREAD}.jsonl`), plain: false },
      ]);
      // A linked sessions directory: found by name, nothing plain.
      const linkedRoot = scratch("linked-root");
      const realSessions = join(scratch("real-sessions"), "sessions");
      mkdirSync(join(realSessions, "2026", "10", "28"), { recursive: true });
      writeFileSync(join(realSessions, "2026", "10", "28", `rollout-e-${THREAD}.jsonl`), "x\n");
      symlinkSync(realSessions, join(linkedRoot, "sessions"));
      expect(codexRolloutParts(linkedRoot, THREAD)).toEqual([
        {
          path: join(linkedRoot, "sessions", "2026", "10", "28", `rollout-e-${THREAD}.jsonl`),
          plain: false,
        },
      ]);
    },
  );
});

describe("openCodexRolloutPart (checked open)", () => {
  it("opens a plain in-tree part, also when named through a linked home, at an end captured now", () => {
    const home = scratch("open");
    const file = seed(home, "0123456789\n");
    const opened = openCodexRolloutPart(home, file);
    expect(opened).toMatchObject({ size: 11, ino: lstatSync(file).ino });
    appendFileSync(file, "later\n");
    expect(opened?.size).toBe(11);
    closeSync(opened!.fd);
    if (!posix) return;
    const alias = join(scratch("open-alias"), "home-link");
    symlinkSync(home, alias);
    const viaAlias = openCodexRolloutPart(
      alias,
      join(alias, "sessions", "2026", "10", "28", file.split("/").at(-1)!),
    );
    expect(viaAlias?.size).toBe(17);
    closeSync(viaAlias!.fd);
  });

  it.runIf(posix)(
    "refuses a link, a path below a link, a FIFO (without blocking), and anything outside sessions",
    () => {
      const home = scratch("refuse");
      const real = seed(home, "real\n");
      const day = join(home, "sessions", "2026", "10", "28");
      const link = join(day, `rollout-link-${THREAD}.jsonl`);
      symlinkSync(real, link);
      expect(openCodexRolloutPart(home, link)).toBeNull();
      symlinkSync(day, join(home, "sessions", "2026", "10", "29"));
      expect(
        openCodexRolloutPart(
          home,
          join(home, "sessions", "2026", "10", "29", real.split("/").at(-1)!),
        ),
      ).toBeNull();
      const fifo = join(day, `rollout-fifo-${THREAD}.jsonl`);
      execFileSync("mkfifo", [fifo]);
      expect(openCodexRolloutPart(home, fifo)).toBeNull();
      writeFileSync(join(home, "auth.json"), "{}");
      expect(openCodexRolloutPart(home, join(home, "auth.json"))).toBeNull();
      expect(openCodexRolloutPart(home, join(home, "sessions", "..", "auth.json"))).toBeNull();
      expect(openCodexRolloutPart(join(home, "absent"), real)).toBeNull();
    },
  );
});

describe("scanRolloutLines (bounded forward scan)", () => {
  const MARKERS = ["turn_context", "rate_limits"];
  const records = [
    { type: "session_meta", payload: { note: "ж€😀 multibyte before any marker" } },
    { type: "turn_context", payload: { turn_id: "t1", model: "gpt-ж" } },
    { type: "response_item", payload: { text: "😀".repeat(9) + " mentions turn_context in text" } },
    {
      type: "event_msg",
      payload: { type: "token_count", rate_limits: { primary: { used_percent: 12.5 } } },
    },
    { type: "response_item", payload: { text: "plain €€€ line" } },
  ];
  const body = records.map((record) => JSON.stringify(record)).join("\r\n") + "\n";

  function scanFile(content: string | Buffer, markers = MARKERS, from = 0) {
    const home = scratch("scan");
    const file = seed(home, "");
    writeFileSync(file, content);
    const fd = openSync(file, "r");
    try {
      const lines: MarkedLine[] = [];
      const result = scanRolloutLines(fd, from, statSync(file).size, markers, (line) =>
        lines.push(line),
      );
      return { lines, ...result };
    } finally {
      closeSync(fd);
    }
  }
  const view = (lines: MarkedLine[]) =>
    lines.map((line) => ({ markers: [...line.markers].sort(), record: line.record }));

  it("hands over the same parsed lines at every chunk size, through UTF-8 and marker splits", () => {
    const whole = view(scanFile(body).lines);
    expect(whole).toEqual([
      { markers: ["turn_context"], record: records[1] },
      { markers: ["turn_context"], record: records[2] },
      { markers: ["rate_limits"], record: records[3] },
    ]);
    for (let chunkBytes = 1; chunkBytes <= 23; chunkBytes++) {
      setRolloutReadLimitsForTests({ chunkBytes });
      const { lines, consumed, tail } = scanFile(body);
      expect(view(lines), `chunk ${chunkBytes}`).toEqual(whole);
      expect(consumed).toBe(Buffer.byteLength(body));
      expect(tail).toBeNull();
    }
  });

  it("weighs an unterminated marked tail without consuming it, and ignores an unmarked one", () => {
    const tc = JSON.stringify(records[1]);
    for (const chunkBytes of [1, 7, 4096]) {
      setRolloutReadLimitsForTests({ chunkBytes });
      const marked = scanFile(body + tc);
      expect(marked.consumed).toBe(Buffer.byteLength(body));
      expect(marked.tail).toEqual({ markers: new Set(["turn_context"]), record: records[1] });
      const torn = scanFile(body + tc.slice(0, 40));
      expect(torn.tail).toEqual({ markers: new Set(["turn_context"]), record: undefined });
      expect(scanFile(body + '{"type":"response_item"').tail).toBeNull();
    }
  });

  it("skips a line over the bound unparsed while noting the markers in it, even across reads", () => {
    setRolloutReadLimitsForTests({ chunkBytes: 5, maxLineBytes: 64 });
    resetRolloutReadStatsForTests();
    const filler = "x".repeat(200);
    const oversizedMarked = JSON.stringify({ type: "turn_context", payload: { model: filler } });
    const oversizedPlain = JSON.stringify({ type: "response_item", payload: { text: filler } });
    const small = JSON.stringify({ type: "turn_context", payload: { model: "m" } });
    const { lines, consumed } = scanFile(
      [oversizedPlain, oversizedMarked, small].join("\n") + "\n",
    );
    expect(view(lines)).toEqual([
      { markers: ["turn_context"], record: undefined },
      { markers: ["turn_context"], record: { type: "turn_context", payload: { model: "m" } } },
    ]);
    expect(consumed).toBe(oversizedPlain.length + oversizedMarked.length + small.length + 3);
    expect(rolloutReadStatsForTests().peakCarryBytes).toBeLessThanOrEqual(64);
    // A marker split exactly at every read boundary inside an oversized line is still seen.
    for (let pad = 0; pad < 13; pad++) {
      const line = "y".repeat(100 + pad) + "rate_limits" + "y".repeat(100);
      expect(view(scanFile(line + "\n").lines), `pad ${pad}`).toEqual([
        { markers: ["rate_limits"], record: undefined },
      ]);
    }
    // The bound applies however the reads split a line: one big read gives the same answer.
    setRolloutReadLimitsForTests({ chunkBytes: 4096, maxLineBytes: 64 });
    expect(
      view(scanFile([oversizedPlain, oversizedMarked, small].join("\n") + "\n").lines),
    ).toEqual(view(lines));
  });

  it("reads each byte once, in fixed chunks, and never past the end it was given", () => {
    setRolloutReadLimitsForTests({ chunkBytes: 64 });
    const content = body.repeat(40);
    const size = Buffer.byteLength(content);
    resetRolloutReadStatsForTests();
    expect(scanFile(content).lines).toHaveLength(40 * 3);
    expect(rolloutReadStatsForTests()).toMatchObject({ bytes: size, reads: Math.ceil(size / 64) });
    // Bytes appended after the end a reader captured are left for its next read.
    const file = seed(scratch("captured"), content);
    const fd = openSync(file, "r");
    appendFileSync(file, JSON.stringify(records[1]) + "\n");
    resetRolloutReadStatsForTests();
    const late: MarkedLine[] = [];
    expect(scanRolloutLines(fd, 0, size, MARKERS, (line) => late.push(line)).consumed).toBe(size);
    closeSync(fd);
    expect(late).toHaveLength(40 * 3);
    expect(rolloutReadStatsForTests().bytes).toBe(size);
  });

  it("stays bounded on a newline-dense file at the default limits", () => {
    resetRolloutReadStatsForTests();
    const dense = Buffer.alloc(24 << 20, "1\n");
    const marker = Buffer.from(JSON.stringify(records[3]) + "\n");
    const { lines, consumed } = scanFile(Buffer.concat([dense, marker, dense]));
    expect(view(lines)).toEqual([{ markers: ["rate_limits"], record: records[3] }]);
    expect(consumed).toBe(2 * dense.length + marker.length);
    const stats = rolloutReadStatsForTests();
    expect(stats.bytes).toBe(consumed);
    expect(stats.reads).toBe(Math.ceil(consumed / (1 << 20)));
    expect(stats.peakCarryBytes).toBeLessThan(1 << 10);
  });
});

describe("copyCodexRolloutPart", () => {
  it("copies every byte in chunks and keeps the source's permission bits", () => {
    setRolloutReadLimitsForTests({ chunkBytes: 3 });
    const home = scratch("copy");
    const content = "ж€😀 line\n".repeat(50);
    const source = seed(home, content);
    chmodSync(source, 0o640);
    const dest = join(scratch("copy-dest"), "copy.jsonl");
    copyCodexRolloutPart(home, source, dest);
    expect(readFileSync(dest, "utf8")).toBe(content);
    if (posix) expect(statSync(dest).mode & 0o777).toBe(0o640);
  });

  it.runIf(posix)(
    "never truncates a destination that is the source itself, however it is spelled",
    () => {
      const home = scratch("copy-self");
      const source = seed(home, "the only history\n");
      const alias = join(scratch("copy-self-alias"), "home-link");
      symlinkSync(home, alias);
      const sameFile = join(alias, relative(home, source));
      expect(() => copyCodexRolloutPart(home, source, sameFile)).toThrow(/is the source/);
      expect(readFileSync(source, "utf8")).toBe("the only history\n");
    },
  );

  it.runIf(posix)(
    "refuses a linked source before touching the destination, and never writes through a linked destination",
    () => {
      const home = scratch("copy-refuse");
      const source = seed(home, "mine\n");
      const outside = join(scratch("copy-outside"), "outside.jsonl");
      writeFileSync(outside, "outside\n");
      const link = join(home, "sessions", "2026", "10", "28", `rollout-link-${THREAD}.jsonl`);
      symlinkSync(outside, link);
      const dest = join(scratch("copy-refuse-dest"), "dest.jsonl");
      writeFileSync(dest, "existing destination\n");
      expect(() => copyCodexRolloutPart(home, link, dest)).toThrow(/not a plain file/);
      expect(readFileSync(dest, "utf8")).toBe("existing destination\n");
      const victim = join(scratch("victim"), "victim.txt");
      writeFileSync(victim, "untouched\n");
      const linkedDest = join(scratch("copy-linked-dest"), "dest.jsonl");
      symlinkSync(victim, linkedDest);
      expect(() => copyCodexRolloutPart(home, source, linkedDest)).toThrow();
      expect(readFileSync(victim, "utf8")).toBe("untouched\n");
      expect(lstatSync(linkedDest).isSymbolicLink()).toBe(true);
    },
  );
});
