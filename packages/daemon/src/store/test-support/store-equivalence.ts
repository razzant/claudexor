import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DurableJournal } from "./fixtures/legacy/journal/index.js";
import { legacyOracle } from "./legacy-oracle.js";
import { LEGACY_BASELINE, verifyFixtureManifest } from "./fixture-manifest.js";
import { readLogicalFixture, writeLogicalFixture } from "./fixture-loader.js";
import {
  Comparisons,
  copyInput,
  copyResources,
  hash,
  inventory,
  resourceInventory,
  writeJson,
} from "./equivalence-evidence.js";
import { comparePartition, compareResources, sqlOwners } from "./equivalence-state.js";

const driverRoot = resolve(import.meta.dirname, "../../../../..");
export interface EquivalenceOptions {
  output: string;
  candidateRoot?: string;
  expectedSha?: string;
  journalRoot?: string;
  resourceRoot?: string;
  portable?: boolean;
  now?: string;
}
export async function runEquivalence(
  options: EquivalenceOptions,
  afterImport?: (database: string) => void,
) {
  let output = resolve(options.output);
  const candidateRoot = resolve(options.candidateRoot ?? driverRoot);
  for (const source of [options.journalRoot, options.resourceRoot])
    if (source) {
      const below = relative(resolve(source), output);
      if (below === "" || (below !== ".." && !below.startsWith(`..${sep}`) && !isAbsolute(below)))
        throw new Error("qualification output must be outside each original input root");
    }
  if (existsSync(output)) throw new Error("qualification output must be a new unique path");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  output = realpathSync.native(output);
  const originalConfig = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(output, "isolated-config");
  const c = new Comparisons(output);
  const report: Record<string, any> = {
    state: "started",
    startedAt: new Date().toISOString(),
    baseline: LEGACY_BASELINE,
    candidateRoot,
    runtime: {
      node: process.versions.node,
      sqlite: process.versions.sqlite,
      platform: process.platform,
      arch: process.arch,
    },
    candidateSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: candidateRoot,
      encoding: "utf8",
    }).trim(),
    driverSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: driverRoot,
      encoding: "utf8",
    }).trim(),
    driverFiles: Object.fromEntries(
      [
        "scripts/store-equivalence.mjs",
        "packages/daemon/src/store/test-support/store-equivalence.ts",
        "packages/daemon/src/store/test-support/equivalence-evidence.ts",
        "packages/daemon/src/store/test-support/equivalence-state.ts",
      ].map((name) => [name, hash(readFileSync(join(driverRoot, name)))]),
    ),
    intentionalDifferences: [
      "R5: thread.entities_upserted is absent from retained SQL streams; its complete state is compared separately.",
      "R5: legacy upload bindings stay lazy and are compared by exact point reads; unknown historical finalize target ids are never invented.",
    ],
    partitions: [],
    largeFixtureRun: !options.portable,
  };
  const persist = () => {
    c.save();
    writeJson(join(output, "report.json"), report);
  };
  let store: any,
    graph: any,
    source: string | undefined,
    resources: string | undefined,
    sourceBefore: unknown,
    resourcesBefore: unknown;
  const knownFinalizeTargets = new Map<string, string>();
  try {
    if (options.expectedSha && report.candidateSha !== options.expectedSha)
      throw new Error("candidate SHA differs from the requested pin");
    const seal = verifyFixtureManifest();
    c.equal("oracle:seal", [], seal);
    if (seal.length) throw new Error("frozen oracle seal failed");
    if (options.portable) {
      const logical = readLogicalFixture(join(import.meta.dirname, "fixtures/global.json"));
      const portable = join(output, "portable-input");
      writeLogicalFixture(portable, logical);
      source = join(portable, "journal");
      resources = join(portable, "resource-store");
      const resource = new legacyOracle.daemonResourceStore.ResourceStore(resources);
      const request = {
        purpose: "model",
        kind: "file",
        name: "portable.json",
        mime: "application/json",
        sizeBytes: 4,
      };
      const upload = resource.create(request, "portable-create");
      await resource.write(
        upload.uploadId,
        (async function* () {
          yield Buffer.from("test");
        })(),
      );
      resource.finalize(upload.uploadId, undefined, "portable-finalize");
      knownFinalizeTargets.set("portable-finalize", upload.uploadId);
      resource.create(
        { kind: "file", name: "open.txt", mime: "text/plain", sizeBytes: 0 },
        "portable-open",
      );
      report.now = options.now ?? logical.now;
    } else {
      if (!options.journalRoot) throw new Error("--journal-root or --portable is required");
      source = resolve(options.journalRoot);
      resources = options.resourceRoot ? resolve(options.resourceRoot) : undefined;
      report.now = options.now ?? new Date().toISOString();
    }
    report.sources = { journalRoot: source, resourceRoot: resources ?? null };
    report.scope = {
      journals: "all supplied partitions",
      resourceCompanions: resources ? "supplied" : "not_supplied",
      startupReconciliation: "not_run",
      providers: "not_run",
    };
    if (!Number.isFinite(Date.parse(report.now)))
      throw new Error("qualification clock must be an ISO timestamp");
    sourceBefore = inventory(source);
    resourcesBefore = resourceInventory(resources);
    writeJson(join(output, "source-manifest.json"), {
      journal: sourceBefore,
      resources: resourcesBefore,
    });
    const referenceRoot = join(output, "legacy"),
      sqlRoot = join(output, "sql");
    mkdirSync(referenceRoot, { mode: 0o700 });
    mkdirSync(sqlRoot, { mode: 0o700 });
    copyInput(source, join(referenceRoot, "journal"));
    copyInput(source, join(sqlRoot, "journal"));
    copyResources(resources, join(referenceRoot, "resource-store"));
    copyResources(resources, join(sqlRoot, "resource-store"));
    c.equal("copy:legacy", sourceBefore, inventory(join(referenceRoot, "journal")));
    c.equal("copy:sql", sourceBefore, inventory(join(sqlRoot, "journal")));
    const load = (name: string) =>
      import(pathToFileURL(join(candidateRoot, `packages/daemon/dist/store/${name}.js`)).href);
    const { discoverLegacyPartitions } = await load("import-discovery"),
      { runLegacyImport } = await load("importer");
    const sources = discoverLegacyPartitions(join(sqlRoot, "journal"));
    report.sourceSelection = sources.map((row: { name: string; directory: string }) => ({
      name: row.name,
      directory: row.directory,
    }));
    persist();
    const imported = await runLegacyImport({
      databasePath: join(sqlRoot, "engine.sqlite.import"),
      journalRoot: join(sqlRoot, "journal"),
      resourceStoreDir: join(sqlRoot, "resource-store"),
      partitions: sources,
      now: () => new Date(report.now),
      onProgress: (progress: unknown) => {
        console.log(JSON.stringify({ import: progress }));
      },
    });
    report.import = imported;
    writeJson(join(output, "import-receipt.json"), imported);
    c.equal("import:unclassified", 0, imported.unclassified);
    if (imported.partitions.some((p: { status: string }) => p.status !== "ready"))
      throw new Error(
        "source has a recovery-required partition; qualification cannot claim healthy equivalence",
      );
    afterImport?.(imported.databasePath);
    // Offline fixture handoff only: the importer is closed. No daemon, floor,
    // production root, startup repair or provider can be reached by this driver.
    renameSync(imported.databasePath, join(sqlRoot, "engine.sqlite"));
    const owners = await sqlOwners(candidateRoot);
    store = await owners.EngineStore.open({
      daemonDir: sqlRoot,
      workerEntry: join(candidateRoot, "packages/daemon/dist/store/flusher-worker.js"),
      now: () => new Date(report.now),
    });
    report.unclassified = store
      .prepare("SELECT pid,seq,type,reason FROM unclassified ORDER BY pid,seq")
      .all();
    graph = owners.createSqlDaemonServices(store, {
      purgeFiles: async () => {
        throw new Error("qualification must never purge a workspace");
      },
      log: (line: string) => console.log(JSON.stringify({ storeWarning: line })),
    });
    const headRevisions = new Map<string, unknown>(),
      prunedRoots = new Set<string>(),
      activeProjects = new Set<string>();
    const ordered = [...imported.partitions].sort(
      (a, b) =>
        Number(b.name === "global") - Number(a.name === "global") || a.name.localeCompare(b.name),
    );
    for (const generation of ordered) {
      const journal = DurableJournal.prepare({
        rootDir: join(referenceRoot, "journal"),
        partition: generation.name,
        epochFactory: () => generation.epoch,
        fold: legacyOracle.daemonJournalFoldPolicy.journalFoldPolicy,
        now: () => new Date(report.now),
      });
      try {
        c.equal(`reference-ready:${generation.name}`, "ready", journal.state().status);
        const compared = await comparePartition({
          c,
          owners,
          store,
          graph,
          generation,
          journal,
          referenceRoot,
          sqlRoot,
          now: report.now,
          headRevisions,
          prunedRoots,
          activeProjects,
        });
        report.partitions.push({ name: generation.name, ...compared });
        console.log(JSON.stringify({ compared: report.partitions.at(-1) }));
        persist();
      } catch (error) {
        c.problem(`partition:${generation.name}`, error);
        throw error;
      } finally {
        journal.close();
      }
      global.gc?.();
    }
    c.equal("pruned-roots:all", prunedRoots, new Set(graph.commands.current().prunedScopeRoots()));
    // Legacy ResourceStore restores pending finalization in its constructor.
    // Match only that existing file-effect owner, without command/quota restart mutations.
    report.resourceEffects = await graph.obligations.completeOpen();
    report.resources = compareResources({
      c,
      owners,
      store,
      graph,
      referenceRoot,
      sqlRoot,
      sourcePresent: resources !== undefined,
      knownFinalizeTargets,
    });
    report.state = c.failures.length ? "failed" : "passed";
  } catch (error) {
    c.problem("qualification", error);
    report.state = "failed";
    report.failureFrames = error instanceof Error ? error.stack?.split("\n").slice(1) : [];
  } finally {
    try {
      if (graph) await graph.close();
    } catch (error) {
      c.problem("cleanup:graph", error);
      report.state = "failed";
    }
    try {
      if (store) await store.close();
    } catch (error) {
      c.problem("cleanup:store", error);
      report.state = "failed";
    }
    if (source && sourceBefore) c.equal("originals:journal", sourceBefore, inventory(source));
    if (resourcesBefore)
      c.equal("originals:resources", resourcesBefore, resourceInventory(resources));
    if (c.failures.length) report.state = "failed";
    report.finishedAt = new Date().toISOString();
    report.checked = c.checked;
    report.failures = c.failures.length;
    persist();
    if (originalConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = originalConfig;
  }
  return report;
}

function parseArgs(args: string[]): EquivalenceOptions {
  const values: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!;
    if (name === "--portable") values[name] = true;
    else if (
      [
        "--output",
        "--candidate-root",
        "--expected-sha",
        "--journal-root",
        "--resource-root",
        "--now",
      ].includes(name) &&
      args[i + 1]
    )
      values[name] = args[++i]!;
    else throw new Error(`unknown/missing argument ${name}`);
  }
  if (typeof values["--output"] !== "string")
    throw new Error(
      "Usage: node scripts/store-equivalence.mjs --portable|--journal-root PATH --output NEW_PATH [--candidate-root PATH --expected-sha SHA --resource-root PATH --now ISO]",
    );
  return {
    output: values["--output"],
    candidateRoot: values["--candidate-root"] as string | undefined,
    expectedSha: values["--expected-sha"] as string | undefined,
    journalRoot: values["--journal-root"] as string | undefined,
    resourceRoot: values["--resource-root"] as string | undefined,
    portable: values["--portable"] === true,
    now: values["--now"] as string | undefined,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const report = await runEquivalence(parseArgs(process.argv.slice(2)));
  console.log(
    JSON.stringify({ state: report.state, checked: report.checked, failures: report.failures }),
  );
  process.exitCode = report.state === "passed" ? 0 : 1;
}
