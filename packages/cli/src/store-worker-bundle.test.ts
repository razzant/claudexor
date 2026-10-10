import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
/** The store (and this smoke) runs only where `node:sqlite` exists. */
const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * The store workers ship INSIDE `claudexord.bundle.cjs`: the bundle is the
 * worker entry, its embedded worker modules self-start on `workerData`, and
 * the daemon's direct-entry check must stay inert on a worker thread. This
 * bundles the daemon exactly as `scripts/build-engine-resources.sh` does
 * (CJS, `import.meta.url` defined to the bundle's own URL) and drives the
 * built store with that bundle as the worker entry.
 */
describe("store workers inside the single-file daemon bundle", () => {
  it.skipIf(process.platform === "win32" || !sqliteAvailable)(
    "flusher and maintenance workers run from the bundle without starting a daemon",
    async () => {
      const daemonEntry = join(repoRoot, "packages", "cli", "dist", "claudexord.js");
      const storeDist = join(repoRoot, "packages", "daemon", "dist", "store");
      expect(existsSync(daemonEntry), "run pnpm build first").toBe(true);
      const root = mkdtempSync(join(realpathSync(tmpdir()), "cx-store-bundle-"));
      roots.push(root);
      const bundle = join(root, "claudexord.bundle.cjs");
      await build({
        entryPoints: [daemonEntry],
        outfile: bundle,
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node22",
        banner: {
          js: "const CLAUDEXOR_BUNDLE_URL = require('node:url').pathToFileURL(__filename).href;",
        },
        define: {
          "import.meta.url": "CLAUDEXOR_BUNDLE_URL",
          "process.env.CLAUDEXOR_BUILD_SHA": JSON.stringify(
            "0123456789abcdef0123456789abcdef01234567",
          ),
        },
        logLevel: "silent",
      });
      const configDir = join(root, "config-must-stay-absent");
      const daemonDir = join(root, "daemon");
      const driver = join(root, "driver.mjs");
      writeFileSync(
        driver,
        `
import { EngineStore } from ${JSON.stringify(pathToFileURL(join(storeDist, "store.js")).href)};
import { MaintenanceController } from ${JSON.stringify(pathToFileURL(join(storeDist, "maintenance.js")).href)};
const store = await EngineStore.open({ daemonDir: ${JSON.stringify(daemonDir)}, workerEntry: ${JSON.stringify(bundle)} });
store.transaction(() => {
  store.prepare("INSERT INTO partition(name, epoch, status, next_seq, created_at) VALUES('global','e','ready',1,'t')").run();
});
await store.flushed();
const maintenance = new MaintenanceController(store, { workerEntry: ${JSON.stringify(bundle)} });
const integrity = await maintenance.integrityCheck();
const facts = store.facts();
process.stdout.write(JSON.stringify({ flusher: facts.flusher.state, barriers: facts.flusher.counters.barriers, integrity: integrity.ok, fact: facts.integrity }) + "\\n");
await maintenance.stop();
await store.close();
`,
      );
      const result = spawnSync(process.execPath, [driver], {
        env: { ...process.env, CLAUDEXOR_CONFIG_DIR: configDir, HOME: join(root, "home") },
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        flusher: "up",
        barriers: expect.any(Number),
        integrity: true,
        fact: "ok",
      });
      expect(JSON.parse(result.stdout.trim()).barriers).toBeGreaterThanOrEqual(1);
      // The worker threads loaded the whole daemon bundle and started nothing durable.
      expect(existsSync(configDir)).toBe(false);
      expect(readdirSync(root).sort()).toEqual(["claudexord.bundle.cjs", "daemon", "driver.mjs"]);
    },
  );
});
