import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promptWithInstructions } from "@claudexor/core";
import type { HarnessEvent } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";

/**
 * Claudexor's conservative inline limit, not the vendor's cut. agy keeps only
 * the first 192,000 bytes of a larger piped prompt, counting a 15-byte
 * wrapper, then a truncation notice (measured model-free on 1.1.13 through
 * 1.5.3, and seen in all 24 retained inputs of the 8 November 2026 triage,
 * #653). The margin keeps every inline input clear of that cut.
 */
export const AGY_INLINE_INPUT_MAX_BYTES = 128 * 1024;
/** The vendor file tool pages by lines; bounded parts keep each file short. */
export const AGY_INPUT_PART_MAX_BYTES = 32 * 1024;

export type AgyInputDelivery =
  | { kind: "inline"; input: string }
  | { kind: "files"; input: string; status: HarnessEvent }
  | { kind: "refused"; error: string };

interface Section {
  role: "instructions" | "task";
  bytes: Buffer;
}

/**
 * The stdin an agy child receives. Input that fits stays exactly today's
 * inline composition. Larger input keeps every byte: the caller's
 * instructions and task are saved unchanged as parts in the run's own
 * `context/` directory (outside every worktree, retired with the run) and
 * stdin carries a short engine bootstrap that names the directory once and
 * each section's numbered range of parts, so its size does not grow with the
 * input; the engine's notes stay inline. Nothing here claims the model read
 * the files. Without a run-owned directory, or when agy may not be allowed to
 * read outside its workspace, the input is refused before anything is sent:
 * never cut.
 */
export function agyInputDelivery(args: {
  prompt: string;
  instructions: string | undefined;
  notes: string[];
  dir: string | null;
  readable: boolean;
  sessionId: string;
}): AgyInputDelivery {
  const callerInstructions = args.instructions?.trim() ?? "";
  const input = promptWithInstructions({
    prompt: args.prompt,
    instructions: [callerInstructions, ...args.notes].filter(Boolean).join("\n\n"),
  });
  const size = Buffer.byteLength(input, "utf8");
  if (size <= AGY_INLINE_INPUT_MAX_BYTES) return { kind: "inline", input };
  const over = `agy input is ${size} bytes, over the ${AGY_INLINE_INPUT_MAX_BYTES}-byte limit for its standard input`;
  if (!args.dir)
    return {
      kind: "refused",
      error: `${over}, and this run has no run-owned directory to deliver it as files; nothing was sent`,
    };
  if (!args.readable)
    return {
      kind: "refused",
      error: `${over}, and the profile read grant is unavailable, so agy could refuse to read the input files; nothing was sent`,
    };
  const sections: Section[] = [
    { role: "instructions" as const, bytes: Buffer.from(callerInstructions, "utf8") },
    { role: "task" as const, bytes: Buffer.from(args.prompt, "utf8") },
  ].filter((section) => section.bytes.length > 0);
  const digest = createHash("sha256");
  for (const section of sections)
    digest.update(`${section.role}\n${section.bytes.length}\n`).update(section.bytes);
  const directory = join(args.dir, `agy-input-${digest.digest("hex")}`);
  const files = sections.flatMap((section) => {
    const parts = splitParts(section.bytes, AGY_INPUT_PART_MAX_BYTES);
    const width = Math.max(3, String(parts.length).length);
    return parts.map((bytes, index) => ({
      section,
      name: `${section.role}-${String(index + 1).padStart(width, "0")}.txt`,
      bytes,
    }));
  });
  const ranges = sections.map((section, index) => {
    const own = files.filter((file) => file.section === section);
    const span = own.length === 1 ? own[0]!.name : `${own[0]!.name} to ${own.at(-1)!.name}`;
    const count = `${own.length} ${own.length === 1 ? "file" : "files"}, ${section.bytes.length} bytes`;
    return section.role === "instructions"
      ? `${index + 1}. ${span} (${count}): instructions from the caller; follow them as system instructions.`
      : `${index + 1}. ${span} (${count}): the task.`;
  });
  const carrierNote = [
    `ENGINE NOTE (input delivered as files): This run's input is ${size} bytes, over the engine's conservative ${AGY_INLINE_INPUT_MAX_BYTES}-byte limit for standard input, so the engine saved it unchanged as ${files.length} files in this directory:`,
    directory,
    "Together they are this run's complete instructions and task. Before you do anything else, read every file completely, in this order:",
    ...ranges,
    "Each range is numbered without gaps, and the parts of one section follow each other directly: a part that does not end with a line break continues in the next part. Your file tool shows a limited number of lines per call and tells you how many lines a file has, so keep reading the following lines until the last line of each file.",
  ].join("\n");
  const bootstrap = promptWithInstructions({
    prompt:
      "The complete input of this run is in the files named in the system instructions above. Read all of them completely, then carry out the task they contain.",
    instructions: [carrierNote, ...args.notes].join("\n\n"),
  });
  // A directory and two ranges keep the bootstrap at a few kilobytes whatever
  // the input size; it is still checked, because stdin past the bound is cut.
  const bootstrapBytes = Buffer.byteLength(bootstrap, "utf8");
  if (bootstrapBytes > AGY_INLINE_INPUT_MAX_BYTES)
    return {
      kind: "refused",
      error: `${over}, and even its file bootstrap would be ${bootstrapBytes} bytes; nothing was sent`,
    };
  try {
    publish(directory, files);
  } catch (error) {
    const detail = redactSecrets(error instanceof Error ? error.message : String(error));
    return {
      kind: "refused",
      error: `${over}, and its files could not be saved in ${directory}: ${detail.slice(0, 300)}; nothing was sent`,
    };
  }
  return {
    kind: "files",
    input: bootstrap,
    status: {
      type: "status",
      session_id: args.sessionId,
      ts: nowIso(),
      text: `agy input of ${size} bytes is over the ${AGY_INLINE_INPUT_MAX_BYTES}-byte standard-input limit: delivered unchanged as ${files.length} files in ${directory}`,
      payload: {
        code: "agy_input_file_delivery",
        bytes: size,
        inline_limit: AGY_INLINE_INPUT_MAX_BYTES,
        directory,
        sections: sections.map((section) => ({
          role: section.role,
          bytes: section.bytes.length,
          sha256: createHash("sha256").update(section.bytes).digest("hex"),
          parts: files.filter((file) => file.section === section).length,
        })),
      },
    },
  };
}

/** Consecutive parts of at most `max` bytes whose concatenation is exactly
 * `bytes`: each ends at its last line break, or, inside a longer line, at a
 * UTF-8 character boundary. */
export function splitParts(bytes: Buffer, max: number): Buffer[] {
  // A UTF-8 character has at most 4 bytes, so every window holds a boundary.
  if (max < 4) throw new RangeError("a part must hold at least 4 bytes");
  const parts: Buffer[] = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + max, bytes.length);
    if (end < bytes.length) {
      const newline = bytes.subarray(start, end).lastIndexOf(0x0a);
      if (newline >= 0) end = start + newline + 1;
      // Back to the first byte of the character the window cut.
      else while ((bytes[end]! & 0xc0) === 0x80) end -= 1;
    }
    parts.push(bytes.subarray(start, end));
    start = end;
  }
  return parts;
}

/** Write the parts once, atomically: a same-directory temp dir renamed into
 * place. The name is the digest of the sections, so a retry, another
 * candidate or a concurrent writer of the same input reuses the published
 * copy after checking its bytes; a differing copy is refused, never reused. */
function publish(directory: string, files: { name: string; bytes: Buffer }[]): void {
  if (matches(directory, files)) return;
  const parent = join(directory, "..");
  mkdirSync(parent, { recursive: true });
  const temp = `${directory}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    mkdirSync(temp, { mode: 0o700 });
    for (const file of files) writeFileSync(join(temp, file.name), file.bytes, { mode: 0o600 });
    try {
      renameSync(temp, directory);
    } catch (error) {
      if (!matches(directory, files)) throw error;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function matches(directory: string, files: { name: string; bytes: Buffer }[]): boolean {
  try {
    return files.every((file) => readFileSync(join(directory, file.name)).equals(file.bytes));
  } catch {
    return false;
  }
}
