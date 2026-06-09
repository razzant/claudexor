import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnProcess } from "./proc.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-proc-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("spawnProcess", () => {
  it("kills the child when the consumer closes the stream early", async () => {
    const dir = tempDir();
    const marker = join(dir, "survived.txt");
    const script = [
      "console.log('ready')",
      "process.on('SIGINT', () => {})",
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1500)`,
      "setTimeout(() => {}, 5000)",
    ].join(";");

    for await (const ev of spawnProcess(process.execPath, ["-e", script], { cancelKillDelayMs: 100 })) {
      if (ev.type === "stdout" && ev.line === "ready") break;
    }

    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
  });

  it("kills a silent child when the abort signal fires", async () => {
    const dir = tempDir();
    const marker = join(dir, "survived.txt");
    const script = [
      "console.log('ready')",
      "process.on('SIGINT', () => {})",
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1500)`,
      "setTimeout(() => {}, 5000)",
    ].join(";");
    const ac = new AbortController();
    let sawReady = false;
    const done = (async () => {
      for await (const ev of spawnProcess(process.execPath, ["-e", script], { abortSignal: ac.signal, cancelKillDelayMs: 100 })) {
        if (ev.type === "stdout" && ev.line === "ready") {
          sawReady = true;
          ac.abort();
        }
      }
    })();

    await done;
    expect(sawReady).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
  });
});
