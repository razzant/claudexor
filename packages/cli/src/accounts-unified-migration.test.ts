/**
 * Unified-accounts startup migration battery (plan §K.6): detection,
 * reserved-id policy, collisions, enabled mirroring, crash-phase resumption,
 * repeat-start no-op, lane-home renames, rollback, and the run-refusal gate.
 * The ThreadStore session/checkpoint halves are covered in
 * packages/daemon/src/threads.test.ts; here the stores are typed stubs so the
 * state machine's phase discipline is what's under test.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import { defaultNativeClaudeConfigDir } from "@claudexor/harness-claude";
import { defaultNativeCodexHome } from "@claudexor/harness-codex";
import { laneHomeDir } from "@claudexor/workspace";
import { noProjectRepoRoot, projectRuntimeDir } from "@claudexor/util";
import {
  accountsMigrationFilePath,
  accountsMigrationGate,
  readAccountsMigrationFile,
  rollbackAccountsUnifiedMigration,
  runAccountsUnifiedMigration,
  type AccountsMigrationStores,
} from "./accounts-unified-migration.js";
import { quotaSubjectUniverseFromConfig } from "./quota-subject-universe.js";
import { parseArgs } from "./args.js";
import { findCommand } from "./command-help.js";
import { commandFlagScopeError, commandPositionalError } from "./command-scope.js";
import { EXTERNAL_DAEMON_REMEDY } from "./daemon-owner.js";

const dirs: string[] = [];
let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "claudexor-uam-"));
  dirs.push(configDir);
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function jwt(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
}

function seedCodexLogin(email = "codex-owner@example.com"): string {
  const home = defaultNativeCodexHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { id_token: jwt({ email, "https://api.openai.com/auth": {} }) },
    }),
  );
  return home;
}

function seedClaudeLogin(email = "claude-owner@example.com"): string {
  const dir = defaultNativeClaudeConfigDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: email } }),
  );
  return dir;
}

interface StubCalls {
  migrated: Array<{ harness: string; rowId: string }>;
  rolledBack: Array<{ harness: string; rowId: string }>;
  removedSubjects: Array<{ harness: string; subjectId: string | null }>;
}

function stubStores(roots: string[] = []): { stores: AccountsMigrationStores; calls: StubCalls } {
  const calls: StubCalls = { migrated: [], rolledBack: [], removedSubjects: [] };
  return {
    calls,
    stores: {
      threads: {
        migrateNullProfileContinuity: (harness, rowId) => {
          calls.migrated.push({ harness, rowId });
          return { sessions: 2, checkpoints: 1, skippedPartitions: [] };
        },
        rollbackProfileContinuity: (harness, rowId) => {
          calls.rolledBack.push({ harness, rowId });
          return { sessions: 2, checkpoints: 1, skippedPartitions: [] };
        },
        listThreads: () => roots.map((root) => ({ repo: { root } })),
      },
      quota: {
        removeSubject: (harness, subjectId) => {
          calls.removedSubjects.push({ harness, subjectId });
          return 0;
        },
      },
    },
  };
}

function registryRows() {
  return loadConfig(noProjectRepoRoot()).global.credential_profiles;
}

describe("unified-accounts startup migration (plan §K.6)", () => {
  it("case 1: no detected login fabricates no row and writes no record", () => {
    const { stores, calls } = stubStores();
    const receipts = runAccountsUnifiedMigration(stores);
    expect(receipts).toEqual([]);
    expect(registryRows()).toEqual([]);
    expect(existsSync(accountsMigrationFilePath())).toBe(false);
    expect(calls.migrated).toEqual([]);
    expect(calls.removedSubjects).toEqual([]);
  });

  it("case 2: a detected codex+claude login registers one row each with the reserved id, identity display name, and untouched bytes", () => {
    const codexHome = seedCodexLogin();
    const claudeDir = seedClaudeLogin();
    const codexBytes = readFileSync(join(codexHome, "auth.json"), "utf8");
    const { stores, calls } = stubStores();
    const receipts = runAccountsUnifiedMigration(stores);
    expect(receipts.map((r) => [r.harness_id, r.row_id, r.outcome])).toEqual([
      ["claude", "claude-default", "migrated"],
      ["codex", "codex-default", "migrated"],
    ]);
    const rows = registryRows();
    expect(rows).toHaveLength(2);
    const codexRow = rows.find((r) => r.harness_id === "codex");
    expect(codexRow).toMatchObject({
      profile_id: "codex-default",
      credential_kind: "config_dir_login",
      isolation_locator: codexHome,
      display_name: "codex-owner@example.com",
      enabled: true,
    });
    const claudeRow = rows.find((r) => r.harness_id === "claude");
    expect(claudeRow).toMatchObject({
      profile_id: "claude-default",
      isolation_locator: claudeDir,
      display_name: "claude-owner@example.com",
    });
    // Bytes never move (Claude keys its Keychain item by the exact dir path).
    expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toBe(codexBytes);
    // Continuity migrated as one unit; the legacy null subject retired.
    expect(calls.migrated).toEqual([
      { harness: "claude", rowId: "claude-default" },
      { harness: "codex", rowId: "codex-default" },
    ]);
    expect(calls.removedSubjects).toEqual([
      { harness: "claude", subjectId: null },
      { harness: "codex", subjectId: null },
    ]);
    expect(readAccountsMigrationFile()["codex"]).toMatchObject({
      phase: "completed",
      row_id: "codex-default",
      legacy_aliases: [null],
      locator: codexHome,
    });
  });

  it("case 3: a reserved-id collision with a DIFFERENT locator takes the deterministic -2 suffix", () => {
    seedCodexLogin();
    const foreign = join(configDir, "profiles", "codex-other");
    mkdirSync(foreign, { recursive: true });
    updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: [
        {
          profile_id: "codex-default",
          harness_id: "codex",
          display_name: "hand-made",
          credential_kind: "config_dir_login",
          isolation_locator: foreign,
          secret_ref: null,
          enabled: true,
          created_at: null,
        },
      ],
    }));
    const { stores } = stubStores();
    const receipts = runAccountsUnifiedMigration(stores);
    expect(receipts.map((r) => r.row_id)).toEqual(["codex-default-2"]);
    expect(
      registryRows()
        .map((r) => r.profile_id)
        .sort(),
    ).toEqual(["codex-default", "codex-default-2"]);
  });

  it("case 3 (display half): a login whose auth material carries no identity gets the harness fallback display name", () => {
    // codex: a chatgpt-mode auth.json with NO tokens (no id_token to read an
    // email from); claude: a .credentials.json login with NO .claude.json
    // identity. Both must still register under the reserved id, with the
    // display-name fallback instead of an invented identity.
    const home = defaultNativeCodexHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
    const dir = defaultNativeClaudeConfigDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), "{}");
    runAccountsUnifiedMigration(stubStores().stores);
    const rows = registryRows();
    expect(rows.find((r) => r.harness_id === "codex")).toMatchObject({
      profile_id: "codex-default",
      display_name: "codex default login",
    });
    expect(rows.find((r) => r.harness_id === "claude")).toMatchObject({
      profile_id: "claude-default",
      display_name: "claude default login",
    });
  });

  it("case 4: native_credentials_enabled=false maps to enabled=false and the mirror key survives", () => {
    seedCodexLogin();
    updateGlobalConfig((config) => ({
      ...config,
      harnesses: {
        ...config.harnesses,
        codex: { ...config.harnesses["codex"], native_credentials_enabled: false },
      },
    }));
    runAccountsUnifiedMigration(stubStores().stores);
    const row = registryRows().find((r) => r.harness_id === "codex");
    expect(row?.enabled).toBe(false);
    // The deprecated key remains as the downgrade-window mirror.
    const cfg = loadConfig(noProjectRepoRoot()).global;
    expect(cfg.harnesses["codex"]?.native_credentials_enabled).toBe(false);
  });

  it("case 5: a crash after any persisted phase resumes idempotently (no duplicate rows, no lost steps)", () => {
    const home = seedCodexLogin();
    const { stores, calls } = stubStores();
    // Simulate a crash after RESERVED was persisted but nothing else ran.
    mkdirSync(join(accountsMigrationFilePath(), ".."), { recursive: true });
    writeFileSync(
      accountsMigrationFilePath(),
      JSON.stringify({
        codex: {
          phase: "reserved",
          row_id: "codex-default",
          legacy_aliases: [null],
          locator: home,
          backup_ref: null,
        },
      }),
    );
    expect(accountsMigrationGate("codex")).not.toBeNull();
    expect(accountsMigrationGate("claude")).toBeNull();
    const receipts = runAccountsUnifiedMigration(stores);
    expect(receipts.map((r) => [r.harness_id, r.outcome])).toEqual([["codex", "resumed"]]);
    expect(registryRows().filter((r) => r.harness_id === "codex")).toHaveLength(1);
    expect(calls.migrated).toEqual([{ harness: "codex", rowId: "codex-default" }]);
    expect(readAccountsMigrationFile()["codex"]?.phase).toBe("completed");
    expect(accountsMigrationGate("codex")).toBeNull();

    // Crash after registry_written: resuming must not duplicate the row and
    // must still run continuity + quota retirement.
    const calls2 = stubStores();
    writeFileSync(
      accountsMigrationFilePath(),
      JSON.stringify({
        codex: {
          phase: "registry_written",
          row_id: "codex-default",
          legacy_aliases: [null],
          locator: home,
          backup_ref: null,
        },
      }),
    );
    runAccountsUnifiedMigration(calls2.stores);
    expect(registryRows().filter((r) => r.harness_id === "codex")).toHaveLength(1);
    expect(calls2.calls.migrated).toEqual([{ harness: "codex", rowId: "codex-default" }]);
    expect(calls2.calls.removedSubjects).toEqual([{ harness: "codex", subjectId: null }]);

    // Crash after continuity_migrated: only the quota retirement remains — no
    // duplicate row, no second continuity rewrite.
    const calls3 = stubStores();
    writeFileSync(
      accountsMigrationFilePath(),
      JSON.stringify({
        codex: {
          phase: "continuity_migrated",
          row_id: "codex-default",
          legacy_aliases: [null],
          locator: home,
          backup_ref: null,
        },
      }),
    );
    runAccountsUnifiedMigration(calls3.stores);
    expect(registryRows().filter((r) => r.harness_id === "codex")).toHaveLength(1);
    expect(calls3.calls.migrated).toEqual([]);
    expect(calls3.calls.removedSubjects).toEqual([{ harness: "codex", subjectId: null }]);
    expect(readAccountsMigrationFile()["codex"]?.phase).toBe("completed");
  });

  it("case 6: the second start is byte-identical (no further config mutation, no receipts)", () => {
    seedCodexLogin();
    runAccountsUnifiedMigration(stubStores().stores);
    const configBytes = readFileSync(join(configDir, "config.yaml"), "utf8");
    const migrationBytes = readFileSync(accountsMigrationFilePath(), "utf8");
    const { stores, calls } = stubStores();
    const receipts = runAccountsUnifiedMigration(stores);
    expect(receipts).toEqual([]);
    expect(readFileSync(join(configDir, "config.yaml"), "utf8")).toBe(configBytes);
    expect(readFileSync(accountsMigrationFilePath(), "utf8")).toBe(migrationBytes);
    expect(calls.migrated).toEqual([]);
    expect(calls.removedSubjects).toEqual([]);
  });

  it("reuses a row already registered at the same locator (D-U2 no-op reuse)", () => {
    const home = seedCodexLogin();
    updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: [
        {
          profile_id: "my-codex",
          harness_id: "codex",
          display_name: "mine",
          credential_kind: "config_dir_login",
          isolation_locator: home,
          secret_ref: null,
          enabled: true,
          created_at: null,
        },
      ],
    }));
    const receipts = runAccountsUnifiedMigration(stubStores().stores);
    expect(receipts.map((r) => r.row_id)).toEqual(["my-codex"]);
    expect(registryRows()).toHaveLength(1);
    expect(readAccountsMigrationFile()["codex"]?.row_id).toBe("my-codex");
  });

  it("case 7 (lane half): durable lane homes rename to the row lane and back on rollback", () => {
    seedCodexLogin();
    const projectRoot = mkdtempSync(join(tmpdir(), "claudexor-uam-project-"));
    dirs.push(projectRoot);
    const runtime = projectRuntimeDir(projectRoot);
    const legacyLane = laneHomeDir(runtime, "th_1", "codex", null);
    mkdirSync(legacyLane, { recursive: true });
    writeFileSync(join(legacyLane, "session.txt"), "recorded native session");
    const { stores } = stubStores([projectRoot]);
    const receipts = runAccountsUnifiedMigration(stores);
    expect(receipts[0]?.lanes).toBe(1);
    const rowLane = laneHomeDir(runtime, "th_1", "codex", "codex-default");
    expect(readFileSync(join(rowLane, "session.txt"), "utf8")).toBe("recorded native session");
    expect(existsSync(legacyLane)).toBe(false);

    const rollback = rollbackAccountsUnifiedMigration(stores);
    expect(rollback[0]?.lanes).toBe(1);
    expect(readFileSync(join(legacyLane, "session.txt"), "utf8")).toBe("recorded native session");
    expect(existsSync(rowLane)).toBe(false);
  });

  it("case 10 (rollback): the row leaves the registry, its enabled state returns to the mirror, and the record clears", () => {
    seedCodexLogin();
    const { stores, calls } = stubStores();
    runAccountsUnifiedMigration(stores);
    // Disable the migrated row the unified way first, so rollback must carry
    // that state back onto the deprecated key.
    updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: config.credential_profiles.map((p) =>
        p.profile_id === "codex-default" ? { ...p, enabled: false } : p,
      ),
    }));
    const receipts = rollbackAccountsUnifiedMigration(stores);
    expect(receipts.map((r) => [r.harness_id, r.row_id])).toEqual([["codex", "codex-default"]]);
    expect(registryRows()).toEqual([]);
    const cfg = loadConfig(noProjectRepoRoot()).global;
    expect(cfg.harnesses["codex"]?.native_credentials_enabled).toBe(false);
    expect(readAccountsMigrationFile()).toEqual({});
    expect(calls.rolledBack).toEqual([{ harness: "codex", rowId: "codex-default" }]);
    expect(calls.removedSubjects.at(-1)).toEqual({ harness: "codex", subjectId: "codex-default" });
    // A later new-engine start re-migrates cleanly.
    const again = runAccountsUnifiedMigration(stubStores().stores);
    expect(again.map((r) => r.row_id)).toEqual(["codex-default"]);
  });

  it.each(["missing-harness", "toString", "constructor", "__proto__"])(
    "rollback ignores an absent record %s without changing migration state",
    (harness) => {
      seedCodexLogin();
      runAccountsUnifiedMigration(stubStores().stores);
      const migrationBefore = readFileSync(accountsMigrationFilePath(), "utf8");
      const configBefore = readFileSync(join(configDir, "config.yaml"), "utf8");
      const { stores, calls } = stubStores();

      expect(rollbackAccountsUnifiedMigration(stores, harness)).toEqual([]);
      expect(calls.rolledBack).toEqual([]);
      expect(calls.removedSubjects).toEqual([]);
      expect(readFileSync(accountsMigrationFilePath(), "utf8")).toBe(migrationBefore);
      expect(readFileSync(join(configDir, "config.yaml"), "utf8")).toBe(configBefore);
      expect(accountsMigrationGate("codex")).toBeNull();
    },
  );

  it("retires the null quota subject from the refresh universe for migrated harnesses only", () => {
    seedCodexLogin();
    seedClaudeLogin();
    const before = quotaSubjectUniverseFromConfig();
    expect(before.some((s) => s.harness === "codex" && s.subject_id === null)).toBe(true);
    runAccountsUnifiedMigration(stubStores().stores);
    const after = quotaSubjectUniverseFromConfig();
    // No null subject for ANY harness — the row subject covers the same
    // store (a null duplicate would double-probe one credential), and cursor
    // never emits a null subject at all (D-U3: no default store).
    expect(after.some((s) => s.subject_id === null)).toBe(false);
    expect(after.some((s) => s.harness === "codex" && s.subject_id === "codex-default")).toBe(true);
    expect(after.some((s) => s.harness === "claude" && s.subject_id === "claude-default")).toBe(
      true,
    );
  });

  it("a crash mid-rollback leaves a rolling_back record: gate fires, startup never resumes forward, re-run completes", () => {
    const home = seedCodexLogin();
    const { stores } = stubStores();
    runAccountsUnifiedMigration(stores);
    // First reverse step blows up AFTER the rolling_back marker persisted.
    const crashing: AccountsMigrationStores = {
      ...stores,
      threads: {
        ...stores.threads,
        rollbackProfileContinuity: () => {
          throw new Error("simulated crash mid-rollback");
        },
      },
    };
    expect(() => rollbackAccountsUnifiedMigration(crashing)).toThrow(/simulated crash/);
    expect(readAccountsMigrationFile()["codex"]?.phase).toBe("rolling_back");
    // Restart: the typed gate fires with the re-run instruction...
    expect(accountsMigrationGate("codex")?.reason).toContain("re-run the rollback command");
    // ...and the startup migration never resumes a rollback FORWARD.
    const { stores: startup, calls } = stubStores();
    expect(runAccountsUnifiedMigration(startup)).toEqual([]);
    expect(calls.migrated).toEqual([]);
    expect(readAccountsMigrationFile()["codex"]?.phase).toBe("rolling_back");
    // Re-running the rollback command finishes the job (steps idempotent).
    const receipts = rollbackAccountsUnifiedMigration(stubStores().stores);
    expect(receipts.map((r) => [r.harness_id, r.row_id])).toEqual([["codex", "codex-default"]]);
    expect(readAccountsMigrationFile()).toEqual({});
    expect(accountsMigrationGate("codex")).toBeNull();
    expect(registryRows()).toEqual([]);
    expect(existsSync(join(home, "auth.json"))).toBe(true); // bytes never move
  });

  it("every command the gate names passes CLI preflight; the rollback targets only its harness (#570)", () => {
    seedCodexLogin();
    seedClaudeLogin();
    runAccountsUnifiedMigration(stubStores().stores);
    const writePhase = (phase: string) => {
      const file = readAccountsMigrationFile();
      writeFileSync(
        accountsMigrationFilePath(),
        JSON.stringify({ ...file, codex: { ...file["codex"], phase } }),
      );
    };
    const reasons: string[] = [];
    for (const phase of ["registry_written", "rolling_back"]) {
      writePhase(phase);
      reasons.push(accountsMigrationGate("codex")?.reason ?? "");
    }
    // The startup pass logs the same instruction for the interrupted rollback
    // and nothing for claude's completed migration.
    const logged: string[] = [];
    runAccountsUnifiedMigration({ ...stubStores().stores, log: (line) => logged.push(line) });
    expect(logged).toHaveLength(1);
    reasons.push(...logged);
    for (const reason of reasons) {
      const commands = [...reason.matchAll(/`claudexor ([^`]+)`/g)].map((match) => match[1]!);
      expect(commands, reason).toContain("profiles rollback-migration codex");
      for (const command of commands) {
        const args = parseArgs(command.split(" "));
        const id = args._[0] ?? "";
        expect(findCommand(id), command).toBeDefined();
        expect(commandFlagScopeError(id, Object.keys(args.flags)), command).toBeNull();
        expect(commandPositionalError(id, args._.slice(1)), command).toBeNull();
      }
    }
  });

  it("the gate's restart advice holds for either lifecycle owner, whatever the daemon's own env (#570)", () => {
    seedCodexLogin();
    runAccountsUnifiedMigration(stubStores().stores);
    const file = readAccountsMigrationFile();
    writeFileSync(
      accountsMigrationFilePath(),
      JSON.stringify({ ...file, codex: { ...file["codex"], phase: "registry_written" } }),
    );
    // The gate runs in the daemon; an owning application need not give its
    // daemon the attaching CLI's variable, so the text cannot branch on it. An
    // invalid value there must not turn the typed refusal into a throw either.
    const reasons = ["standalone", "external", "not-an-owner"].map((owner) => {
      vi.stubEnv("CLAUDEXOR_DAEMON_OWNER", owner);
      try {
        return accountsMigrationGate("codex")?.reason;
      } finally {
        vi.unstubAllEnvs();
      }
    });
    expect(new Set(reasons).size).toBe(1);
    const reason = reasons[0] ?? "";
    expect(reason).toContain(`externally owned: ${EXTERNAL_DAEMON_REMEDY}`);
    expect(reason).toContain("standalone: `claudexor daemon stop`, then any command");
    expect(reason).toContain("`claudexor profiles rollback-migration codex`");
    // The only mention of the stop an external reader is refused is that
    // standalone-scoped one.
    expect(reason.match(/daemon stop/g)).toHaveLength(1);
  });

  it("a corrupt migration file fails the run gate CLOSED and is never overwritten by re-migration", () => {
    seedCodexLogin();
    mkdirSync(join(accountsMigrationFilePath(), ".."), { recursive: true });
    writeFileSync(accountsMigrationFilePath(), "not json {{{");
    const gate = accountsMigrationGate("codex");
    expect(gate).not.toBeNull();
    expect(gate?.reason).toContain("corrupt");
    // The migration pass fails loudly instead of treating corrupt state as
    // absent and overwriting the evidence with a fresh reservation.
    expect(() => runAccountsUnifiedMigration(stubStores().stores)).toThrow(/corrupt/);
    expect(readFileSync(accountsMigrationFilePath(), "utf8")).toBe("not json {{{");
    // The lenient reader keeps projection surfaces fail-safe.
    expect(readAccountsMigrationFile()).toEqual({});
    // ENOENT stays an honest pass: no file, no gate.
    rmSync(accountsMigrationFilePath(), { force: true });
    expect(accountsMigrationGate("codex")).toBeNull();
  });

  it("crash-resume of a reserved record whose login vanished skips registration and clears the record", () => {
    // The login disappeared between the reserved-phase crash and the restart:
    // registering the row anyway would fabricate a cold account for nothing.
    mkdirSync(join(accountsMigrationFilePath(), ".."), { recursive: true });
    writeFileSync(
      accountsMigrationFilePath(),
      JSON.stringify({
        codex: {
          phase: "reserved",
          row_id: "codex-default",
          legacy_aliases: [null],
          locator: join(configDir, "native", "codex"),
          backup_ref: null,
        },
      }),
    );
    const { stores, calls } = stubStores();
    expect(runAccountsUnifiedMigration(stores)).toEqual([]);
    expect(registryRows()).toEqual([]);
    expect(calls.migrated).toEqual([]);
    expect(readAccountsMigrationFile()["codex"]).toBeUndefined();
    expect(accountsMigrationGate("codex")).toBeNull();
  });

  it("writes a pre-migration config backup and records its ref", () => {
    seedCodexLogin();
    updateGlobalConfig((config) => config); // materialize config.yaml
    runAccountsUnifiedMigration(stubStores().stores);
    const record = readAccountsMigrationFile()["codex"];
    expect(record?.backup_ref).toBeTruthy();
    expect(existsSync(join(record!.backup_ref!, "config.yaml"))).toBe(true);
  });
});
