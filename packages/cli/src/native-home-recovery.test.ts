// Real SQL journal recovery regressions.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import {
  quarantineGeneration,
  setGenerationStatusInTx,
} from "../../daemon/dist/store/generations.js";
import { createNativeHomeRetention } from "./native-home-retention.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

let root: string;
let before: string | undefined;
let sql: Awaited<ReturnType<typeof sqlFixture>>;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-opus-native-")));
  before = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
  mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
  sql = await sqlFixture(join(root, "sql"));
});
afterEachClosed(async () => {
  await sql.close();
  return () => {
    if (before === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = before;
    rmSync(root, { recursive: true, force: true });
  };
});

it("resumes native pruning after pending project recovery completes", async () => {
  let pruneCalls = 0;
  const home = join(root, "engine", "native", "codex");
  mkdirSync(home, { recursive: true });
  const registry = new Map([
    [
      "codex",
      {
        nativeHomeLifetime: {
          status: "managed",
          preserves: "spy",
          home: () => home,
          prune: async () => {
            pruneCalls++;
            return {
              deleted_files: [],
              errors: [],
              freed_bytes: 0,
              kept_referenced: 0,
              kept_recent: 0,
              kept_unknown: 0,
              truncated: false,
            };
          },
        },
      },
    ],
  ]) as never;
  const native = createNativeHomeRetention({
    threads: sql.graph.threads,
    isBusy: () => false,
    registry: () => registry,
    profiles: () => [],
  });
  const request = {
    dryRun: false,
    olderThan: Date.now(),
    ignoredRunIds: new Set<string>(),
    ignoredThreadIds: new Set<string>(),
  };
  const control = await native(request);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const project = sql.graph.projects.register({
    root: repo,
    idempotencyKey: "r",
    clientId: "f",
  }).project;
  const pid = sql.graph.projects.partition(project.id)!.pid;
  sql.store.transaction(() => setGenerationStatusInTx(sql.store, pid, "recovery_required"));
  const pending = await native(request);
  expect(pruneCalls).toBe(1);
  expect(pending.errors.join("\n")).toContain("awaits journal recovery");
  expect(pending.errors.join("\n")).toContain(`(${pid}, recovery_required)`);
  quarantineGeneration(sql.store, sql.graph.blobs, {
    oldPid: pid,
    keyDigest: "k",
    requestDigest: "k",
    operationId: "o",
    payload: { operationId: "o" },
  });
  const afterRecovery = await native(request);
  console.log(
    "PROBE-Q5",
    JSON.stringify({
      controlErrors: control.errors,
      pruneCallsBefore: 1,
      afterErrors: afterRecovery.errors,
      afterReason: afterRecovery.reports[0]?.reason,
      pruneCalls,
    }),
  );
  expect(pruneCalls).toBe(2);
});
