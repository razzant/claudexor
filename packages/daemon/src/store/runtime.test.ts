import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { EngineRuntimeUnsupportedError } from "./errors.js";
import { compareDottedVersions, ENGINE_SQLITE_MIN_VERSION, loadEngineRuntime } from "./runtime.js";

/** The admitting cases need the real module; the refusals run on any Node. */
const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);

describe("engine runtime refusal (Node 20/22 without the WAL-reset fix)", () => {
  it("orders dotted versions numerically", () => {
    expect(compareDottedVersions("3.51.3", "3.51.3")).toBe(0);
    expect(compareDottedVersions("3.51.2", "3.51.3")).toBe(-1);
    expect(compareDottedVersions("3.53.0", "3.51.3")).toBe(1);
    expect(compareDottedVersions("3.6", "3.51.3")).toBe(-1);
    expect(compareDottedVersions("4", "3.51.3")).toBe(1);
  });

  it("refuses a Node without node:sqlite (Node 20 shape) before importing anything", async () => {
    let imported = 0;
    const failure = await loadEngineRuntime({
      versions: { node: "20.19.0" },
      importSqlite: async () => {
        imported += 1;
        throw new Error("Cannot find module 'node:sqlite'");
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngineRuntimeUnsupportedError);
    expect(failure).toMatchObject({
      code: "engine_runtime_unsupported",
      status: 503,
      retryable: false,
      nodeVersion: "20.19.0",
      sqliteVersion: null,
      requiredSqlite: ENGINE_SQLITE_MIN_VERSION,
    });
    expect(imported).toBe(0);
  });

  it.skipIf(!sqliteAvailable)(
    "refuses the WAL-reset-affected SQLite (Node 22.22 / 24.14 shape) and admits the fixed one",
    async () => {
      const affected = await loadEngineRuntime({
        versions: { node: "24.14.1", sqlite: "3.51.2" },
        importSqlite: () => import("node:sqlite"),
      }).catch((error: unknown) => error);
      expect(affected).toBeInstanceOf(EngineRuntimeUnsupportedError);
      expect((affected as Error).message).toContain("WAL-reset");
      expect(affected).toMatchObject({ sqliteVersion: "3.51.2", nodeVersion: "24.14.1" });

      const fixed = await loadEngineRuntime({
        versions: { node: "24.15.0", sqlite: "3.51.3" },
        importSqlite: () => import("node:sqlite"),
      });
      expect(fixed.sqliteVersion).toBe("3.51.3");
      expect(typeof fixed.sqlite.DatabaseSync).toBe("function");
    },
  );

  it("types an import failure on an admitted version (the Node without node:sqlite shape)", async () => {
    const cause = new Error("ERR_UNKNOWN_BUILTIN_MODULE");
    const failure = await loadEngineRuntime({
      versions: { node: "24.16.0", sqlite: "3.53.0" },
      importSqlite: async () => {
        throw cause;
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngineRuntimeUnsupportedError);
    expect((failure as Error).cause).toBe(cause);
  });

  it.skipIf(!sqliteAvailable)("admits the running Node", async () => {
    const runtime = await loadEngineRuntime();
    expect(runtime.sqliteVersion).toBe(process.versions.sqlite);
  });
});

describe("the daemon package without node:sqlite (B1)", () => {
  const dist = resolve(import.meta.dirname, "../../dist");
  const withoutSqlite = process.allowedNodeEnvironmentFlags.has("--no-experimental-sqlite")
    ? ["--no-experimental-sqlite"]
    : [];
  const run = (code: string) =>
    spawnSync(process.execPath, [...withoutSqlite, "--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 60_000,
    });

  it("loads the built package index with no load-time error", () => {
    expect(existsSync(join(dist, "index.js")), "run pnpm build first").toBe(true);
    const result = run(
      `const m = await import(${JSON.stringify(pathToFileURL(join(dist, "index.js")).href)});` +
        `process.stdout.write(JSON.stringify({ exports: Object.keys(m).length }));`,
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout).exports).toBeGreaterThan(10);
    expect(result.stderr).not.toMatch(/ERR_UNKNOWN_BUILTIN_MODULE/);
  });

  it("refuses typed through the real module graph when the store is opened", () => {
    const result = run(
      `const { EngineStore } = await import(${JSON.stringify(pathToFileURL(join(dist, "store", "store.js")).href)});` +
        `try { await EngineStore.open({ daemonDir: process.cwd() + "/never-created-" + process.pid }); process.stdout.write("opened"); }` +
        `catch (error) { process.stdout.write(JSON.stringify({ code: error.code, status: error.status, name: error.name })); }`,
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      code: "engine_runtime_unsupported",
      status: 503,
      name: "EngineRuntimeUnsupportedError",
    });
  });
});
