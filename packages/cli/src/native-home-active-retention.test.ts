import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { beforeEach, expect, it } from "vitest";
import { CredentialProfile, SessionCapsule } from "@claudexor/schema";
import { createCodexAdapter } from "@claudexor/harness-codex";
import { ArtifactStore } from "@claudexor/artifact-store";
import { writeContinuationSources } from "@claudexor/workspace";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { createNativeHomeRetention } from "./native-home-retention.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";
let root: string;
let before: string | undefined;
let sql: Awaited<ReturnType<typeof sqlFixture>>;
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const old = new Date("2020-01-01");
let busy = false;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-native-retention-")));
  before = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
  mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
  sql = await sqlFixture(join(root, "sql"));
  busy = false;
});
afterEachClosed(async () => {
  await sql?.close();
  return () => {
    if (before === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = before;
    rmSync(root, { recursive: true, force: true });
  };
});
function profile() {
  return CredentialProfile.parse({
    profile_id: "disabled",
    display_name: "Disabled fixture",
    harness_id: "codex",
    credential_kind: "config_dir_login",
    isolation_locator: join(root, "engine", "profiles", "disabled"),
    enabled: false,
  });
}
function seed(n: number) {
  const file = join(
    profile().isolation_locator!,
    "sessions",
    "2020",
    "01",
    "01",
    `rollout-2020-01-01T00-00-00-${id(n)}.jsonl`,
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `rollout ${n}`);
  utimesSync(file, old, old);
  return file;
}
function capsule(n: number) {
  const path = join(
    new ArtifactStore(join(root, "unregistered")).runsDir(),
    `run-${n}`,
    "attempts",
    "a01",
    "session-capsule.json",
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      SessionCapsule.parse({
        harness: "codex",
        nativeSessionId: id(n),
        holderProfileId: "disabled",
        file: null,
        mtimeMs: null,
        cwd: root,
        requestedModel: null,
      }),
    ),
  );
  return path;
}
const request = (dryRun = false) => ({
  dryRun,
  olderThan: Date.now() - 30 * 86400000,
  ignoredRunIds: new Set<string>(),
  ignoredThreadIds: new Set<string>(),
});
function native(duringProfileScan?: () => void) {
  const adapter = createCodexAdapter();
  const lifetime = adapter.nativeHomeLifetime!;
  if (lifetime.status !== "managed") throw new Error("missing native owner");
  adapter.nativeHomeLifetime = {
    ...lifetime,
    prune: async (input) => {
      const pending = lifetime.prune(input);
      if (input.home === profile().isolation_locator && duringProfileScan) {
        await yieldToAdmission();
        duringProfileScan();
      }
      return pending;
    },
  };
  return createNativeHomeRetention({
    threads: sql.graph.threads,
    isBusy: () => busy,
    registry: () => new Map([["codex", adapter]]),
    profiles: () => [profile()],
  });
}

function runDir(n: number) {
  return join(new ArtifactStore(join(root, "unregistered")).runsDir(), `run-${n}`);
}
function command(n: number, state: "running" | "succeeded" | "failed", extra = {}) {
  const commands = sql.graph.commands.current();
  commands.accept({
    id: `command-${n}`,
    params: { prompt: "Work", ...extra },
    idempotencyKey: `command-${n}`,
    clientId: "fixture",
  });
  commands.update(`command-${n}`, {
    state,
    runId: `run-${n}`,
    runDir: runDir(n),
    ...(state === "running" ? {} : { finishedAt: new Date().toISOString() }),
  });
}
it("prunes unrelated cold rollouts while active output and a queued continuation chain stay protected", async () => {
  const held = [seed(1), seed(2), seed(3)];
  for (const n of [1, 2, 3]) capsule(n);
  command(1, "running");
  command(3, "failed");
  command(2, "failed", { continueFrom: "run-3" });
  sql.graph.commands.current().accept({
    id: "queued-successor",
    params: { prompt: "Continue", continueFrom: "run-2" },
    idempotencyKey: "queued-successor",
    clientId: "fixture",
  });
  const cold = seed(4);
  const recent = seed(5);
  utimesSync(recent, new Date(), new Date());
  const receipt = await native()(request());
  expect(receipt.errors).toEqual([]);
  expect(receipt.reports.flatMap((home) => home.deleted_files)).toEqual([cold]);
  for (const file of [...held, recent]) expect(existsSync(file)).toBe(true);
});
it.each(["active capsule", "completed command", "SQL session"] as const)(
  "rechecks a late %s without keeping its unrelated neighbor",
  async (kind) => {
    const held = seed(4),
      cold = seed(5);
    if (kind === "active capsule") command(4, "running");
    let wrote = false;
    const gc = native(() => {
      wrote = true;
      if (kind === "SQL session") {
        const thread = sql.graph.threads.createThread({
          title: "Late native owner",
          workspace: "in_place",
        });
        sql.graph.threads.recordSession(thread.id, "codex", id(4));
      } else {
        capsule(4);
        if (kind === "completed command") command(4, "succeeded");
      }
    });
    const receipt = await gc(request());
    expect(wrote).toBe(true);
    expect(receipt.errors).toEqual([]);
    expect(existsSync(held)).toBe(true);
    expect(existsSync(cold)).toBe(false);
  },
);
it("names uncertain running ownership and resumes once it is settled", async () => {
  const cold = seed(4);
  const commands = sql.graph.commands.current();
  commands.accept({
    id: "unlocated-work",
    params: { prompt: "Work" },
    idempotencyKey: "unlocated-work",
    clientId: "fixture",
  });
  commands.update("unlocated-work", { state: "running" });
  const receipt = await native()(request());
  expect(receipt.errors.join()).toContain("unlocated-work");
  expect(existsSync(cold)).toBe(true);
  commands.update("unlocated-work", { state: "failed", finishedAt: new Date().toISOString() });
  expect((await native()(request())).errors).toEqual([]);
  expect(existsSync(cold)).toBe(false);
});

it("follows active continuation addresses outside the hashed layout through their ancestors", async () => {
  const held = [seed(2), seed(3)];
  const cold = seed(4);
  for (const n of [2, 3]) {
    capsule(n);
    renameSync(runDir(n), join(root, `legacy-${n}`));
  }
  command(1, "running");
  writeContinuationSources(runDir(1), [
    { runId: "run-2", runDir: join(root, "legacy-2"), state: "failed" },
  ]);
  writeContinuationSources(join(root, "legacy-2"), [
    { runId: "run-3", runDir: join(root, "legacy-3"), state: "failed" },
  ]);
  const receipt = await native()(request());
  expect(receipt.errors).toEqual([]);
  expect(receipt.reports.flatMap((home) => home.deleted_files)).toEqual([cold]);
  for (const file of held) expect(existsSync(file)).toBe(true);
});
it("names a corrupt late active capsule and releases the hold after repair", async () => {
  const held = seed(4),
    cold = seed(5);
  command(4, "running");
  const file = join(runDir(4), "attempts", "a01", "session-capsule.json");
  const receipt = await native(() => {
    capsule(4);
    writeFileSync(file, "broken JSON");
  })(request());
  expect(receipt.errors.join()).toContain(file);
  expect(existsSync(held)).toBe(true);
  expect(existsSync(cold)).toBe(true);
  capsule(4);
  expect((await native()(request())).errors).toEqual([]);
  expect(existsSync(held)).toBe(true);
  expect(existsSync(cold)).toBe(false);
});
