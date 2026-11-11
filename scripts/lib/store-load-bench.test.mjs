import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../store-load-bench.mjs", import.meta.url));
const store = new URL("../../packages/daemon/dist/store/store.js", import.meta.url);

function run({ rate, seconds, slow = false, failFlush = false }) {
  expect(existsSync(store), "run pnpm build first").toBe(true);
  const root = mkdtempSync(join(tmpdir(), "cx-load-test-"));
  const preload = join(root, "preload.mjs");
  try {
    if (slow || failFlush)
      writeFileSync(
        preload,
        `import { EngineStore } from ${JSON.stringify(store.href)};
${
  slow
    ? `const transaction = EngineStore.prototype.transaction;
const wait = new Int32Array(new SharedArrayBuffer(4));
EngineStore.prototype.transaction = function (...args) {
  const result = transaction.apply(this, args);
  Atomics.wait(wait, 0, 0, 25);
  return result;
};
`
    : ""
}
${
  failFlush
    ? `EngineStore.prototype.flushed = async function () {
  throw new Error("injected final flush failure");
};`
    : ""
}
`,
      );
    const result = spawnSync(
      process.execPath,
      [...(slow || failFlush ? ["--import", preload] : []), script],
      {
        encoding: "utf8",
        timeout: 25_000,
        env: {
          ...process.env,
          RATE: String(rate),
          SECONDS: String(seconds),
          K: "2",
          KEEP: "0",
          OUT: "",
          TMPDIR: root,
          TMP: root,
          TEMP: root,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    if (failFlush)
      return {
        status: result.status,
        stderr: result.stderr,
        roots: readdirSync(root).filter((name) => name.startsWith("cx-store-bench-")),
      };
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("store load benchmark completion", () => {
  it("lets readers and maintenance run while slow writes catch up", () => {
    const result = run({ rate: 1000, seconds: 0.05, slow: true });
    expect(result.i_commit.n).toBe(50);
    expect(result.sseRead?.n ?? 0).toBeGreaterThan(0);
    expect(result.ii_fileWrite?.n ?? 0).toBeGreaterThan(0);
    expect(result.integrity?.ok).toBe(true);
    expect(result.flushed?.n ?? 0).toBeGreaterThan(0);
    expect(result.flusher.counters.barriers).toBeGreaterThan(0);
  });

  it("awaits integrity and a measured flush even before periodic timers fire", () => {
    const result = run({ rate: 1, seconds: 1 });
    expect(result.i_commit.n).toBe(1);
    expect(result.integrity?.ok).toBe(true);
    expect(result.flushed?.n ?? 0).toBeGreaterThan(0);
    expect(result.flusher.counters.barriers).toBeGreaterThan(0);
  });

  it("preserves a final flush failure and still cleans its temporary store", () => {
    const result = run({ rate: 1, seconds: 1, failFlush: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("injected final flush failure");
    expect(result.roots).toEqual([]);
  });
});
