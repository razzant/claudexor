import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { printJson, printJsonLine } from "./cli-io.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const cliIo = new URL("./cli-io.ts", import.meta.url).href;
const tempRoots: string[] = [];

describe("cli-io NDJSON contract (W13/G2)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("printJsonLine emits exactly one line of COMPACT JSON (valid NDJSON)", () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
      chunks.push(String(s));
      return true;
    });
    printJsonLine({ frame: "run.started", runId: "run-1", nested: { a: 1, b: [2, 3] } });
    expect(chunks).toHaveLength(1);
    const line = chunks[0] as string;
    // Exactly one trailing newline, no interior newlines (a single NDJSON line).
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({
      frame: "run.started",
      runId: "run-1",
      nested: { a: 1, b: [2, 3] },
    });
  });

  it("printJson stays PRETTY (multi-line) — the exactly-one-object --json surface", () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
      chunks.push(String(s));
      return true;
    });
    printJson({ a: 1, b: 2 });
    // Pretty output has interior newlines; the two surfaces are distinct.
    expect((chunks[0] as string).slice(0, -1).includes("\n")).toBe(true);
  });
});

/** Run `body` as a CLI tail in a fresh Node process; a forced exit is reported on stderr. */
function runExitTail(body: string) {
  const root = mkdtempSync(join(tmpdir(), "claudexor-cli-exit-"));
  tempRoots.push(root);
  const script = join(root, "tail.mts");
  writeFileSync(
    script,
    [
      `import { exitAfterOutputFlush, printJson } from ${JSON.stringify(cliIo)};`,
      "const exit = process.exit.bind(process);",
      'process.exit = (code) => { process.stderr.write("forced-exit\\n"); return exit(code); };',
      body,
    ].join("\n"),
  );
  return spawnSync(process.execPath, [tsxCli, script], { encoding: "utf8", timeout: 20_000 });
}

describe("exitAfterOutputFlush", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  }, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

  it("drains >64 KiB after fetch() without a forced exit on Windows (nodejs/node#56645)", () => {
    // The doctor shape: fetch() leaves V8 background work behind, then one large JSON
    // object. Under process.exit() Windows Node < 24.20 aborts with 0xC0000409 after
    // the JSON is written; the natural exit disposes the isolate first.
    const result = runExitTail(`
import { createServer } from "node:http";
const server = createServer((_, res) => { res.writeHead(302, { Location: "/" }); res.end(); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let fetchError = null;
try { await fetch(\`http://127.0.0.1:\${server.address().port}/\`); } catch (error) { fetchError = error.name; }
server.closeAllConnections();
server.close();
printJson({ fetchError, tail: "x".repeat(96 * 1024) });
exitAfterOutputFlush(0);
`);
    expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({
      status: 0,
      signal: null,
      stderr: process.platform === "win32" ? "" : "forced-exit\n",
    });
    expect(JSON.parse(result.stdout)).toEqual({
      fetchError: "TypeError",
      tail: "x".repeat(96 * 1024),
    });
  });

  it("still terminates with the command's code when a stray handle keeps the loop alive", () => {
    const result = runExitTail(`
setInterval(() => {}, 60_000);
printJson({ ok: false, exitCode: 4 });
exitAfterOutputFlush(4);
`);
    expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({
      status: 4,
      signal: null,
      stderr: "forced-exit\n",
    });
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, exitCode: 4 });
  });
});
