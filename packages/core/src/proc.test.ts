import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { armOrphanExit, labelStreams, spawnProcess } from "./proc.js";

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

  // QA-027: a vendor tool that setsid'd into its OWN process group and then
  // reparents to pid 1 (its CLI exits on the cooperative signal) must still be
  // dead before the generator returns. A group-kill of the direct child alone
  // leaked exactly this — a `/bin/sleep 60` orphan lived ~40s past terminal.
  it("reaps an ESCAPED descendant process group before the generator returns", async () => {
    const dir = tempDir();
    const marker = join(dir, "escaped.txt");
    // Parent (the direct child) spawns a DETACHED grandchild in a new pgid, then
    // exits promptly on SIGINT — orphaning the grandchild. The grandchild
    // ignores SIGINT and would write the marker at 1500ms if it survives.
    const grandchild = [
      "process.on('SIGINT', () => {})",
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1500)`,
      "setTimeout(() => {}, 5000)",
    ].join(";");
    const parent = [
      "const { spawn } = require('node:child_process')",
      `const gc = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: 'ignore' })`,
      "gc.unref()",
      "console.log('ready ' + gc.pid)",
      "process.on('SIGINT', () => process.exit(0))",
      "setTimeout(() => {}, 5000)",
    ].join(";");

    const ac = new AbortController();
    let escapedPgid = 0;
    for await (const ev of spawnProcess(process.execPath, ["-e", parent], {
      abortSignal: ac.signal,
      cancelKillDelayMs: 150,
    })) {
      if (ev.type === "stdout" && ev.line.startsWith("ready ")) {
        escapedPgid = Number(ev.line.slice("ready ".length));
        // Let the grandchild fully establish its own process group.
        await new Promise((resolve) => setTimeout(resolve, 150));
        ac.abort();
      }
    }

    // The for-await completed => the generator returned. Death proof gates that
    // return, so the escaped group must already be gone: NO post-hoc sleep.
    expect(escapedPgid).toBeGreaterThan(0);
    let groupAlive = true;
    try {
      process.kill(-escapedPgid, 0);
    } catch (err) {
      groupAlive = (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
    expect(groupAlive).toBe(false);

    // And the orphan never got to run its side effect.
    await new Promise((resolve) => setTimeout(resolve, 1600));
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

describe("armOrphanExit", () => {
  it("exits when the bridge reparents to pid 1 (dead host) and discloses once", async () => {
    const exits: number[] = [];
    let disclosed = 0;
    let ppid = 777;
    const watchdog = armOrphanExit({
      intervalMs: 5,
      getppid: () => ppid,
      exit: (code) => exits.push(code),
      onOrphaned: () => {
        disclosed += 1;
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(exits).toEqual([]); // live host: never exits
    ppid = 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(exits.length).toBeGreaterThan(0);
    expect(exits[0]).toBe(0);
    expect(disclosed).toBeGreaterThan(0);
    watchdog.stop();
  });

  it("stop() cancels the watchdog", async () => {
    const exits: number[] = [];
    const watchdog = armOrphanExit({
      intervalMs: 5,
      getppid: () => 1,
      exit: (code) => exits.push(code),
    });
    watchdog.stop();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(exits).toEqual([]);
  });
});
