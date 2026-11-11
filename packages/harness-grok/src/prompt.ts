import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "@claudexor/schema";

/** Avoid Windows argv limits and preserve prompt bytes, including newlines. */
export async function* withGrokPromptFile(
  prompt: string,
  run: (path: string) => AsyncIterable<HarnessEvent>,
): AsyncGenerator<HarnessEvent> {
  const directory = mkdtempSync(join(tmpdir(), "claudexor-grok-prompt-"));
  try {
    const path = join(directory, "prompt.txt");
    writeFileSync(path, prompt, { encoding: "utf8", mode: 0o600 });
    yield* run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
