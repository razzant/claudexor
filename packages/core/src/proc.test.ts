import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { labelStreams, spawnProcess } from "./proc.js";

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

    for await (const ev of spawnProcess(process.execPath, ["-e", script], {
      cancelKillDelayMs: 100,
    })) {
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
      for await (const ev of spawnProcess(process.execPath, ["-e", script], {
        abortSignal: ac.signal,
        cancelKillDelayMs: 100,
      })) {
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

describe("labelStreams", () => {
  it("returns null when both streams are blank", () => {
    expect(labelStreams("", "  \n")).toBeNull();
  });

  it("labels which stream said what", () => {
    expect(labelStreams("boom", "")).toBe("stderr: boom");
    expect(labelStreams("", "hello")).toBe("stdout: hello");
    expect(labelStreams("boom", "hello")).toBe("stderr: boom | stdout: hello");
  });

  it("runs the transform (redactor) on the FULL stream BEFORE truncation", () => {
    // The secret sits beyond the truncation budget: redact-after-truncate
    // would slice the token into an unrecognizable, partially visible prefix.
    // (Assembled at runtime so the diff itself never carries a key-shaped literal.)
    const secret = ["sk", "live", "0123456789abcdef".repeat(2)].join("-");
    const noisy = "x".repeat(280) + " token=" + secret;
    const out = labelStreams(noisy, "", {
      maxLen: 100,
      transform: (s) => s.replaceAll(secret, "[redacted]"),
    });
    expect(out).not.toContain(["sk", "live"].join("-"));
    expect([...(out ?? "")].length).toBeLessThanOrEqual(100 + "stderr: ".length);
  });

  it("gives each present stream its own budget so one cannot evict the other", () => {
    const out = labelStreams("e".repeat(500), "o".repeat(500), { maxLen: 100 });
    expect(out).toContain("stderr: ");
    expect(out).toContain("| stdout: ");
    expect(out).toContain("ooo");
  });

  it("never splits a surrogate pair at the truncation boundary", () => {
    const out = labelStreams("🙂".repeat(400), "", { maxLen: 301 });
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});
