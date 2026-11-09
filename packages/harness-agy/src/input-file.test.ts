import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { promptWithInstructions } from "@claudexor/core";
import {
  AGY_INLINE_INPUT_MAX_BYTES,
  AGY_INPUT_PART_MAX_BYTES,
  agyInputDelivery,
  splitParts,
} from "./input-file.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
function contextDir(): string {
  const root = mkdtempSync(join(tmpdir(), "agy-input-file-"));
  roots.push(root);
  return join(root, "run", "context");
}
const strict = new TextDecoder("utf-8", { fatal: true });
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
/** What a reader learns from the bootstrap alone: the directory, then each
 * section's numbered range, expanded to paths in order. */
function listed(bootstrap: string): Record<string, string[]> {
  const lines = bootstrap.split("\n");
  const at = lines.findIndex((line) => line.endsWith("in this directory:"));
  if (at < 0) return {};
  const dir = lines[at + 1]!;
  const out: Record<string, string[]> = {};
  for (const line of lines.slice(at + 2)) {
    const range =
      /^\d+\. (instructions|task)-(\d+)\.txt(?: to (?:instructions|task)-(\d+)\.txt)? \(\d+ files?, \d+ bytes\)/.exec(
        line,
      );
    if (!range) continue;
    const [, role, first, last = first] = range as unknown as [string, string, string, string?];
    const paths: string[] = [];
    for (let n = Number(first); n <= Number(last); n += 1)
      paths.push(join(dir, `${role}-${String(n).padStart(first.length, "0")}.txt`));
    out[role] = paths;
  }
  return out;
}
const join_ = (paths: string[] = []) => Buffer.concat(paths.map((path) => readFileSync(path)));

describe("agy input delivery (#653)", () => {
  it.each([
    ["prompt only", "Review the change.", undefined, []],
    ["instructions and note", "Review.", "  caller rules\n", ["ENGINE NOTE (read-only): x"]],
    ["note only", "Review.", undefined, ["ENGINE NOTE: y"]],
  ])(
    "keeps %s inline and byte-identical below the bound",
    (_label, prompt, instructions, notes) => {
      const dir = contextDir();
      const delivery = agyInputDelivery({
        prompt,
        instructions,
        notes,
        dir,
        readable: true,
        sessionId: "s",
      });
      expect(delivery).toEqual({
        kind: "inline",
        input: promptWithInstructions({
          prompt,
          instructions: [instructions?.trim(), ...notes].filter(Boolean).join("\n\n"),
        }),
      });
      expect(() => readdirSync(dir)).toThrow();
    },
  );

  it("switches exactly at the bound", () => {
    const dir = contextDir();
    const at = "a".repeat(AGY_INLINE_INPUT_MAX_BYTES);
    expect(
      agyInputDelivery({
        prompt: at,
        instructions: undefined,
        notes: [],
        dir,
        readable: true,
        sessionId: "s",
      }).kind,
    ).toBe("inline");
    expect(
      agyInputDelivery({
        prompt: `${at}b`,
        instructions: undefined,
        notes: [],
        dir,
        readable: true,
        sessionId: "s",
      }).kind,
    ).toBe("files");
  });

  it("delivers every byte of both roles, including the tail past the vendor's 192,000-byte cut", () => {
    const dir = contextDir();
    const unit = 'строка 🙂 "quoted" ü\t ñ — line\n';
    const longLine = `${"é".repeat(60_000)}🙂LONG-LINE-END\n`;
    const tail = "TAIL-NONCE-7f3c91 Ω";
    const prompt = unit.repeat(9_000) + longLine + unit.repeat(500) + tail;
    const instructions = `  ${"Правило: читать всё.\n".repeat(12_000)}  `;
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(400_000);
    const note = "ENGINE NOTE (read-only Antigravity run): denied.";
    const delivery = agyInputDelivery({
      prompt,
      instructions,
      notes: [note],
      dir,
      readable: true,
      sessionId: "s",
    });
    expect(delivery.kind).toBe("files");
    if (delivery.kind !== "files") return;
    const { instructions: instructionFiles = [], task: taskFiles = [] } = listed(delivery.input);
    expect(instructionFiles.length).toBeGreaterThan(1);
    expect(taskFiles.length).toBeGreaterThan(10);
    // Exact bytes per role: instructions trimmed as inline delivery trims them, the task untouched.
    expect(join_(instructionFiles).equals(Buffer.from(instructions.trim()))).toBe(true);
    expect(join_(taskFiles).equals(Buffer.from(prompt))).toBe(true);
    expect(join_(taskFiles).toString("utf8").endsWith(tail)).toBe(true);
    // The ranges name every file and nothing else.
    const published = readdirSync(join(dir, readdirSync(dir)[0]!));
    expect(published.sort()).toEqual(
      [...instructionFiles, ...taskFiles].map((path) => path.split(/[\\/]/).at(-1)!).sort(),
    );
    for (const path of [...instructionFiles, ...taskFiles]) {
      const bytes = readFileSync(path);
      expect(bytes.length).toBeLessThanOrEqual(AGY_INPUT_PART_MAX_BYTES);
      expect(() => strict.decode(bytes)).not.toThrow();
      expect(path.startsWith(join(dir, "agy-input-"))).toBe(true);
    }
    // A short bootstrap: the directory once, the engine notes inline, no task text.
    expect(Buffer.byteLength(delivery.input)).toBeLessThan(4_096);
    expect(
      delivery.input.startsWith("[SYSTEM INSTRUCTIONS]\nENGINE NOTE (input delivered as files)"),
    ).toBe(true);
    expect(delivery.input.split(join(dir, "agy-input-")).length).toBe(2);
    expect(delivery.input).toContain(`\n\n${note}\n[END SYSTEM INSTRUCTIONS]\n\n`);
    expect(delivery.input).toContain("1. instructions-001.txt to instructions-");
    expect(delivery.input).toContain(
      "instructions from the caller; follow them as system instructions.",
    );
    expect(delivery.input).toContain(`2. task-001.txt to task-`);
    expect(delivery.input).not.toContain("TAIL-NONCE");
    expect(delivery.status).toMatchObject({
      type: "status",
      payload: {
        code: "agy_input_file_delivery",
        inline_limit: AGY_INLINE_INPUT_MAX_BYTES,
        sections: [
          {
            role: "instructions",
            bytes: Buffer.byteLength(instructions.trim()),
            sha256: sha(instructions.trim()),
          },
          {
            role: "task",
            bytes: Buffer.byteLength(prompt),
            sha256: sha(prompt),
            parts: taskFiles.length,
          },
        ],
      },
    });
    expect(JSON.stringify(delivery.status)).not.toMatch(/read by|was read/);
  });

  // Review rl-20261108T203611 (Astra): a 9,437,222-byte request under a valid
  // relocated config directory made the old per-file listing 226,723 bytes, so
  // the vendor's 192,000-byte cut dropped 45 of 291 entries and the notes.
  it.skipIf(process.platform === "win32")(
    "keeps the bootstrap a few kilobytes for a 9 MB input under a long valid path",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agy-input-long-"));
      roots.push(root);
      // The fixture components alone exceed 600 chars, even with a short /tmp root.
      const deep = join(root, "c".repeat(200), "o".repeat(200), "n".repeat(200), "runs", "run-x");
      const dir = join(deep, "context");
      mkdirSync(dir, { recursive: true });
      expect(dir.length).toBeGreaterThan(600);
      const line = `Строка ${'ledger entry with "quotes"\tand tabs 🙂 '.repeat(3)}\n`;
      const lineBytes = Buffer.byteLength(line);
      const tail = "TAIL-AFTER-9MB Ω";
      const prompt = line.repeat(Math.ceil((9_437_222 - 64) / lineBytes)) + tail;
      expect(Buffer.byteLength(prompt)).toBeGreaterThan(9_400_000);
      const note = "ENGINE NOTE (read-only Antigravity run): the access note.";
      const delivery = agyInputDelivery({
        prompt,
        instructions: "Answer with the tail marker.",
        notes: [note],
        dir,
        readable: true,
        sessionId: "s",
      });
      expect(delivery.kind).toBe("files");
      if (delivery.kind !== "files") return;
      const bytes = Buffer.byteLength(delivery.input);
      // Size does not grow with the input: the directory once plus fixed text.
      expect(bytes).toBeLessThan(4_096 + dir.length);
      expect(bytes).toBeLessThan(192_000);
      expect(delivery.input).toContain(note);
      expect(delivery.input.endsWith("then carry out the task they contain.")).toBe(true);
      const { instructions = [], task = [] } = listed(delivery.input);
      expect(task.length).toBeGreaterThan(280);
      expect(task.every((path) => existsSync(path))).toBe(true);
      expect(join_(instructions).toString()).toBe("Answer with the tail marker.");
      const all = join_(task);
      expect(all.length).toBe(Buffer.byteLength(prompt));
      expect(sha(all)).toBe(sha(prompt));
    },
  );

  it("refuses before writing anything when even the bootstrap would not fit", () => {
    const dir = contextDir();
    const delivery = agyInputDelivery({
      prompt: "z".repeat(AGY_INLINE_INPUT_MAX_BYTES + 1),
      instructions: undefined,
      // Engine notes are short; an oversized one stands in for any cause.
      notes: ["n".repeat(AGY_INLINE_INPUT_MAX_BYTES)],
      dir,
      readable: true,
      sessionId: "s",
    });
    expect(delivery).toEqual({
      kind: "refused",
      error: expect.stringMatching(/even its file bootstrap would be \d+ bytes; nothing was sent$/),
    });
    expect(() => readdirSync(dir)).toThrow();
  });

  it("names only the sections that have text", () => {
    const dir = contextDir();
    const big = "x\n".repeat(80_000);
    const onlyTask = agyInputDelivery({
      prompt: big,
      instructions: "  ",
      notes: [],
      dir,
      readable: true,
      sessionId: "s",
    });
    const onlyInstructions = agyInputDelivery({
      prompt: "",
      instructions: big,
      notes: [],
      dir,
      readable: true,
      sessionId: "s",
    });
    for (const [delivery, present, absent, text] of [
      [onlyTask, "task", "instructions", big],
      // Instructions are trimmed exactly as inline delivery trims them.
      [onlyInstructions, "instructions", "task", big.trim()],
    ] as const) {
      expect(delivery.kind).toBe("files");
      if (delivery.kind !== "files") continue;
      const sections = listed(delivery.input);
      expect(Object.keys(sections)).toEqual([present]);
      expect(sections[absent]).toBeUndefined();
      expect(delivery.input).toContain(`1. ${present}-001.txt to ${present}-`);
      expect(join_(sections[present]).toString()).toBe(text);
    }
  });

  it("names a single part without a range", () => {
    const dir = contextDir();
    const delivery = agyInputDelivery({
      prompt: "t\n".repeat(70_000),
      instructions: "one small instruction",
      notes: [],
      dir,
      readable: true,
      sessionId: "s",
    });
    expect(delivery.kind).toBe("files");
    if (delivery.kind !== "files") return;
    expect(delivery.input).toContain(
      `1. instructions-001.txt (1 file, ${Buffer.byteLength("one small instruction")} bytes): instructions from the caller`,
    );
    expect(listed(delivery.input).instructions).toHaveLength(1);
  });

  it("reuses an identical published copy and refuses a differing one", () => {
    const dir = contextDir();
    const args = {
      prompt: "y\n".repeat(80_000),
      instructions: undefined,
      notes: [],
      dir,
      readable: true,
      sessionId: "s",
    };
    const first = agyInputDelivery(args);
    const second = agyInputDelivery(args);
    expect(second).toMatchObject({
      kind: "files",
      input: first.kind === "files" ? first.input : "",
    });
    expect(readdirSync(dir)).toEqual([expect.stringMatching(/^agy-input-[0-9a-f]{64}$/)]);
    const part = listed(first.kind === "files" ? first.input : "").task![0]!;
    writeFileSync(part, "tampered");
    const third = agyInputDelivery(args);
    expect(third).toMatchObject({
      kind: "refused",
      error: expect.stringContaining("nothing was sent"),
    });
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("refuses rather than cutting when the files cannot be delivered", () => {
    const big = "z".repeat(AGY_INLINE_INPUT_MAX_BYTES + 1);
    const base = { prompt: big, instructions: undefined, notes: [], sessionId: "s" };
    expect(agyInputDelivery({ ...base, dir: null, readable: true })).toEqual({
      kind: "refused",
      error: expect.stringContaining("no run-owned directory"),
    });
    const unreadable = contextDir();
    expect(agyInputDelivery({ ...base, dir: unreadable, readable: false })).toEqual({
      kind: "refused",
      error: expect.stringContaining("read grant is unavailable"),
    });
    expect(() => readdirSync(unreadable)).toThrow();
    const root = mkdtempSync(join(tmpdir(), "agy-input-blocked-"));
    roots.push(root);
    writeFileSync(join(root, "context"), "a file, not a directory");
    expect(agyInputDelivery({ ...base, dir: join(root, "context"), readable: true })).toEqual({
      kind: "refused",
      error: expect.stringContaining("could not be saved"),
    });
  });
});

describe("splitParts", () => {
  it("keeps exact bytes, the bound and UTF-8 boundaries for any line shape", () => {
    const samples = [
      "",
      "a",
      "🙂".repeat(5000),
      `${"x".repeat(100)}\n${"é".repeat(40_000)}\n`,
      "line\n".repeat(20_000),
      `\n${"ab🙂c\u0301".repeat(9000)}`,
    ];
    const violations: string[] = [];
    for (const text of samples)
      for (const max of [4, 5, 7, 64, 4096, AGY_INPUT_PART_MAX_BYTES]) {
        const bytes = Buffer.from(text, "utf8");
        const parts = splitParts(bytes, max);
        if (!Buffer.concat(parts).equals(bytes)) violations.push(`bytes ${max}`);
        for (const part of parts) {
          if (part.length === 0 || part.length > max) violations.push(`size ${part.length}/${max}`);
          try {
            strict.decode(part);
          } catch {
            violations.push(`utf8 ${max}`);
          }
        }
      }
    expect(violations.slice(0, 5)).toEqual([]);
    expect(() => splitParts(Buffer.from("abc"), 3)).toThrow(RangeError);
  });

  it("ends a part at its last line break when one fits", () => {
    const parts = splitParts(Buffer.from("aaaa\nbbbbbbbbbb\ncc"), 8);
    expect(parts.map((part) => part.toString())).toEqual(["aaaa\n", "bbbbbbbb", "bb\ncc"]);
  });
});
