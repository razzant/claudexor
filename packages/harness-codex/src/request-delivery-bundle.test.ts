import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("keeps the bundled accessor lazy and self-contained in a cold native process", async () => {
  const root = mkdtempSync(join(tmpdir(), "cx-delivery-bundle-"));
  try {
    const outfile = join(root, "observer.cjs");
    const result = await build({
      entryPoints: [fileURLToPath(new URL("./request-delivery.ts", import.meta.url))],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      metafile: true,
    });
    expect(
      Object.keys(result.metafile!.inputs).some((name) => name.includes("undici/lib/global.js")),
    ).toBe(true);
    const script = join(root, "cold.cjs");
    writeFileSync(
      script,
      `
const assert = require('node:assert/strict');
const key = Symbol.for('undici.globalDispatcher.1'); // assertion only, never product access
assert.equal(globalThis[key], undefined);
const {RequestDelivery} = require('./observer.cjs');
assert.equal(globalThis[key], undefined, 'loading the bundle must not select a dispatcher');
const delivery = new RequestDelivery(Buffer.from('body'));
const options = delivery.request();
assert.equal(globalThis[key], undefined, 'constructing the observer must remain passive');
const sent = fetch('http://127.0.0.1:0', {method:'POST', ...options, headers:{'content-length':'4'}});
const native = globalThis[key];
assert.ok(native);
sent.catch(() => {}).then(() => {
  assert.equal(globalThis[key], native, 'lazy dependency import must keep the native singleton');
  console.log('PASS cold bundled observer');
});
`,
    );
    expect(
      execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000 }),
    ).toContain("PASS cold bundled observer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
