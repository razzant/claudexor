/**
 * Unified-accounts startup migration (INV-135 rewrite, plan §L.3).
 *
 * At daemon start, a DETECTED legacy default-store login (claude/codex) is
 * auto-registered as an ordinary registry row — reserved machine id
 * `claude-default` / `codex-default`, locator = the existing Claudexor-owned
 * native dir, bytes never move — and the null engine-default subject's
 * continuity state (thread sessions, lane checkpoints, durable lane homes)
 * migrates onto that row id as ONE unit (INV-137). Progress is a
 * crash-recoverable per-harness state machine persisted OUTSIDE config.yaml
 * (`<config>/migration/accounts-unified.json`; a downgraded 3.5.0 engine never
 * reads it): `reserved → registry_written → continuity_migrated → completed`,
 * every phase restart-idempotent. While a harness's record is incomplete, that
 * harness's runs refuse typed (`accountsMigrationGate`) — other harnesses keep
 * working. `rollbackAccountsUnifiedMigration` is the supported downgrade
 * path's first step: it surgically reverses every phase (run it BEFORE
 * installing an engine whose canonicalizers refuse the native locator).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import { normalizeThroughExistingAncestor } from "@claudexor/core";
import { claudeAccountIdentity, defaultNativeClaudeConfigDir } from "@claudexor/harness-claude";
import { codexAccountIdentity, defaultNativeCodexHome } from "@claudexor/harness-codex";
import type {
  AccountsHarnessMigration,
  AccountsUnifiedMigrationFile,
  CredentialProfile,
} from "@claudexor/schema";
import { AccountsUnifiedMigrationFile as MigrationFileSchema } from "@claudexor/schema";
import { migrateDefaultLanes, rollbackProfileLanes } from "@claudexor/workspace";
import { EXTERNAL_DAEMON_REMEDY } from "./daemon-owner.js";
import { invalidateStatusProjections } from "./status-projection-cache.js";
import { noProjectRepoRoot, nowIso, userConfigDir } from "@claudexor/util";

/** The harnesses whose legacy default stores auto-register (cursor's host
 * Keychain login is deliberately NOT migrated — owner decision D-U3: host
 * logins disappear; new cursor logins are ordinary isolated file-store rows). */
export const ACCOUNTS_MIGRATION_HARNESSES = ["claude", "codex"] as const;
export type AccountsMigrationHarness = (typeof ACCOUNTS_MIGRATION_HARNESSES)[number];

export function accountsMigrationFilePath(): string {
  return join(userConfigDir(), "migration", "accounts-unified.json");
}

/** Lenient read for projection/mutation consumers: any unreadable state reads
 * as "no records" (those surfaces fail safe on their own rules). The RUN GATE
 * and the migration itself use the strict variant below — a corrupt phase
 * file must fail CLOSED there, never silently pass runs against unknown
 * migration state or overwrite the evidence with a fresh reservation. */
export function readAccountsMigrationFile(): AccountsUnifiedMigrationFile {
  try {
    return readAccountsMigrationFileStrict();
  } catch {
    return {};
  }
}

/** ENOENT/ENOTDIR = honestly no record ({}); anything else — an unreadable
 * file, a JSON parse failure, a schema violation — THROWS a typed error so
 * the gate and the migration fail closed instead of treating corrupt state
 * as absent. */
export function readAccountsMigrationFileStrict(): AccountsUnifiedMigrationFile {
  const path = accountsMigrationFilePath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return {};
    throw Object.assign(
      new Error(`unified-accounts migration record ${path} is unreadable (${code ?? "io_error"})`),
      { code: "accounts_migration_record_unreadable" },
    );
  }
  try {
    return MigrationFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw Object.assign(
      new Error(
        `unified-accounts migration record ${path} is corrupt: ${
          error instanceof Error ? error.message : String(error)
        }; fix or remove the file before runs of migrated harnesses can proceed`,
      ),
      { code: "accounts_migration_record_unreadable" },
    );
  }
}

function writeAccountsMigrationFile(file: AccountsUnifiedMigrationFile): void {
  const path = accountsMigrationFilePath();
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * The daemon startup wrapper: run (or crash-resume) the migration, invalidate
 * status projections when anything changed, and NEVER crash startup — a
 * failed pass leaves the phase file mid-state, the affected harness refuses
 * runs typed (accountsMigrationGate), and the next start resumes the
 * remaining phases.
 */
export function runStartupAccountsMigration(
  threads: AccountsMigrationStores["threads"],
  quota: AccountsMigrationStores["quota"] & { noteCredentialChange(): void },
  log: (message: string) => void,
): void {
  try {
    if (runAccountsUnifiedMigration({ threads, quota, log }).length > 0) {
      invalidateStatusProjections();
      quota.noteCredentialChange();
    }
  } catch (error) {
    log(
      `unified-accounts migration pass failed (will resume on the next start): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Retire one harness's migration record (its row was deleted with its
 * material, so a later start detects no legacy login and fabricates nothing). */
export function removeAccountsMigrationRecord(harnessId: string): void {
  const file = { ...readAccountsMigrationFile() };
  if (!(harnessId in file)) return;
  delete file[harnessId];
  writeAccountsMigrationFile(file);
}

/** The CLI spelling of the rollback for one harness. Naming the harness keeps
 * the instruction scoped: the harness-less form reverses EVERY migrated
 * harness, including ones whose migration is complete. */
function rollbackCommand(harnessId: string): string {
  return `claudexor profiles rollback-migration ${harnessId}`;
}

/**
 * Typed per-harness run refusal while this harness's migration is incomplete
 * (plan §L.3): a crash between phases must not let runs route against
 * half-migrated continuity state. Complete (or absent) records never block.
 */
export function accountsMigrationGate(harnessId: string): { reason: string } | null {
  let record: AccountsHarnessMigration | undefined;
  try {
    record = readAccountsMigrationFileStrict()[harnessId];
  } catch (error) {
    // A CORRUPT phase file fails the gate CLOSED: runs must not route
    // against unknown migration state (an absent file passes above via the
    // strict reader's ENOENT branch).
    return { reason: error instanceof Error ? error.message : String(error) };
  }
  if (!record || record.phase === "completed") return null;
  if (record.phase === "rolling_back") {
    return {
      reason:
        `${harnessId} is blocked by an interrupted unified-accounts rollback; ` +
        `re-run the rollback command (\`${rollbackCommand(harnessId)}\`) to finish it`,
    };
  }
  // This runs in the daemon, but CLAUDEXOR_DAEMON_OWNER belongs to the attaching
  // CLI: an owning application need not give it to its daemon. The text therefore
  // names both owners instead of consulting this process's environment.
  return {
    reason:
      `${harnessId} is blocked by an incomplete unified-accounts migration ` +
      `(phase: ${record.phase}); a daemon restart finishes it (standalone: ` +
      `\`claudexor daemon stop\`, then any command; externally owned: ${EXTERNAL_DAEMON_REMEDY}); ` +
      `to reverse it instead, run \`${rollbackCommand(harnessId)}\``,
  };
}

interface DetectedLegacyLogin {
  locator: string;
  displayName: string | null;
}

/** Only ACTUALLY DETECTED logins register — an empty default store writes no
 * record and fabricates no row (§K.6 case 1). */
function detectLegacyLogin(harnessId: AccountsMigrationHarness): DetectedLegacyLogin | null {
  if (harnessId === "claude") {
    const dir = defaultNativeClaudeConfigDir();
    const identity = claudeAccountIdentity(dir);
    // macOS keeps the token in the Keychain (identity in .claude.json);
    // Linux/Windows keep .credentials.json in the dir. Either proves a login.
    if (identity === null && !existsSync(join(dir, ".credentials.json"))) return null;
    return { locator: dir, displayName: identity?.email ?? null };
  }
  const home = defaultNativeCodexHome();
  try {
    const parsed = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as {
      auth_mode?: unknown;
    };
    // Only a subscription login migrates; an api-key auth.json can not exist
    // in the native store (ensureCodexApiAuth refuses to write it there).
    if (parsed.auth_mode !== "chatgpt") return null;
  } catch {
    return null;
  }
  return { locator: home, displayName: codexAccountIdentity(home)?.email ?? null };
}

function sameLocator(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  try {
    return normalizeThroughExistingAncestor(a) === normalizeThroughExistingAncestor(b);
  } catch {
    return a === b;
  }
}

/** The harness's exact Claudexor-owned default native store dir, or null for
 * harnesses without one (D-U3: cursor has no default store; agy is named-only). */
export function defaultNativeStoreLocator(harnessId: string): string | null {
  if (harnessId === "claude") return defaultNativeClaudeConfigDir();
  if (harnessId === "codex") return defaultNativeCodexHome();
  return null;
}

/**
 * The ONE structural "this row IS the harness's default native store" rule,
 * shared by the delete fence and the `native_credentials_enabled` downgrade
 * mirror: true when the locator resolves to the harness's exact
 * defaultNative*Dir() — the same rule the startup migration matches rows by.
 * Bootstrap rows (ensureBootstrapProfile) sit at this locator BEFORE any
 * migration record exists, so record presence must never be the only key.
 */
export function locatorIsDefaultNativeStore(
  harnessId: string,
  locator: string | null | undefined,
): boolean {
  const native = defaultNativeStoreLocator(harnessId);
  return native !== null && sameLocator(locator, native);
}

/** Reserved machine id (§L.3): `<harness>-default`, deterministic `-2`, `-3`…
 * suffix on collision. CROSS-HARNESS unique — the wire's scalar
 * `credentialProfileId` must never match rows of two harnesses. */
function reserveRowId(registry: readonly CredentialProfile[], harnessId: string): string {
  const base = `${harnessId}-default`;
  let candidate = base;
  for (let i = 2; registry.some((p) => p.profile_id === candidate); i += 1) {
    candidate = `${base}-${i}`;
  }
  return candidate;
}

function backupConfig(harnessId: string): string | null {
  try {
    const source = join(userConfigDir(), "config.yaml");
    if (!existsSync(source)) return null;
    const dir = join(userConfigDir(), "migration", `backup-${harnessId}-${Date.now()}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    copyFileSync(source, join(dir, "config.yaml"));
    return dir;
  } catch {
    // Fail-soft: the backup is the manual-recovery half of the downgrade
    // path; the supported rollback command reverses phases surgically and
    // does not depend on it. A null backup_ref is disclosed in the record.
    return null;
  }
}

/** The stores the migration mutates, injected so tests drive temp roots. */
export interface AccountsMigrationStores {
  threads: {
    migrateNullProfileContinuity(
      harnessId: string,
      rowId: string,
    ): { sessions: number; checkpoints: number; skippedPartitions: string[] };
    rollbackProfileContinuity(
      harnessId: string,
      rowId: string,
    ): { sessions: number; checkpoints: number; skippedPartitions: string[] };
    listThreads(): Array<{ repo?: { root: string } | null }>;
  };
  quota: { removeSubject(harness: string, subjectId: string | null): number };
  log?: (message: string) => void;
}

function laneRootsOf(stores: AccountsMigrationStores): string[] {
  const roots = new Set<string>([noProjectRepoRoot()]);
  try {
    for (const thread of stores.threads.listThreads()) {
      if (thread.repo?.root) roots.add(thread.repo.root);
    }
  } catch {
    /* listing failure bounds the rename to the no-project root; sessions are
     * already migrated by the journal step, so an unrenamed lane degrades to
     * a fresh session with the standard continuity disclosure */
  }
  return [...roots];
}

export interface AccountsMigrationReceipt {
  harness_id: string;
  row_id: string;
  outcome: "migrated" | "resumed" | "already_completed";
  sessions: number;
  checkpoints: number;
  lanes: number;
  skipped_partitions: string[];
}

/**
 * Run (or crash-resume) the unified-accounts migration for every harness with
 * a detected legacy login. Idempotent: the second and later starts find
 * completed records (or nothing to detect) and mutate nothing (§K.6 case 6).
 */
export function runAccountsUnifiedMigration(
  stores: AccountsMigrationStores,
): AccountsMigrationReceipt[] {
  const receipts: AccountsMigrationReceipt[] = [];
  for (const harnessId of ACCOUNTS_MIGRATION_HARNESSES) {
    // STRICT read: a corrupt phase file must never be treated as "no record"
    // here — a fresh reservation would overwrite the crash evidence. The
    // throw is caught by runStartupAccountsMigration; the run gate keeps the
    // affected harnesses refusing typed until the file is fixed or removed.
    const file = readAccountsMigrationFileStrict();
    let record = file[harnessId];
    const resumed = record !== undefined && record.phase !== "completed";
    if (record?.phase === "completed") continue;
    if (record?.phase === "rolling_back") {
      // An interrupted ROLLBACK never resumes forward — re-running the
      // rollback command finishes it; the run gate names that instruction.
      stores.log?.(
        `unified-accounts migration: ${harnessId} has an interrupted rollback; ` +
          `re-run \`${rollbackCommand(harnessId)}\` to finish it`,
      );
      continue;
    }
    if (record?.phase === "reserved" && detectLegacyLogin(harnessId) === null) {
      // Crash-resume of a RESERVED record whose login has since vanished:
      // the reserved phase mutated nothing but the record itself, and
      // registering a row now would fabricate a cold account for a login
      // that no longer exists. Skip (and clear the record) — logged.
      const remaining = { ...file };
      delete remaining[harnessId];
      writeAccountsMigrationFile(remaining);
      stores.log?.(
        `unified-accounts migration skipped: ${harnessId} reserved row "${record.row_id}" ` +
          `has no detectable legacy login anymore; the reservation was cleared`,
      );
      continue;
    }
    if (!record) {
      const detected = detectLegacyLogin(harnessId);
      if (!detected) continue;
      const registry = loadConfig(noProjectRepoRoot()).global.credential_profiles;
      const sameLocatorRow = registry.find(
        (p) => p.harness_id === harnessId && sameLocator(p.isolation_locator, detected.locator),
      );
      // Phase RESERVED: id + backup persisted BEFORE any mutation, so a crash
      // can never re-reserve a different id (§K.3). A row already registered
      // at this exact locator is reused as-is (D-U2 no-op reuse).
      record = {
        phase: "reserved",
        row_id: sameLocatorRow?.profile_id ?? reserveRowId(registry, harnessId),
        legacy_aliases: [null],
        locator: detected.locator,
        backup_ref: backupConfig(harnessId),
      };
      writeAccountsMigrationFile({ ...file, [harnessId]: record });
    }
    const rowId = record.row_id;
    if (record.phase === "reserved") {
      registerMigratedRow(harnessId, record);
      record = { ...record, phase: "registry_written" };
      writeAccountsMigrationFile({ ...readAccountsMigrationFileStrict(), [harnessId]: record });
    }
    let continuity = { sessions: 0, checkpoints: 0, skippedPartitions: [] as string[] };
    let lanes = 0;
    if (record.phase === "registry_written") {
      continuity = stores.threads.migrateNullProfileContinuity(harnessId, rowId);
      for (const root of laneRootsOf(stores)) lanes += migrateDefaultLanes(root, harnessId, rowId);
      record = { ...record, phase: "continuity_migrated" };
      writeAccountsMigrationFile({ ...readAccountsMigrationFileStrict(), [harnessId]: record });
    }
    if (record.phase === "continuity_migrated") {
      // No replay alias (§K.3): the legacy null subject is retired here; the
      // new row's subject refreshes fresh on the next quota cycle.
      stores.quota.removeSubject(harnessId, null);
      record = { ...record, phase: "completed" };
      writeAccountsMigrationFile({ ...readAccountsMigrationFileStrict(), [harnessId]: record });
    }
    const receipt: AccountsMigrationReceipt = {
      harness_id: harnessId,
      row_id: rowId,
      outcome: resumed ? "resumed" : "migrated",
      sessions: continuity.sessions,
      checkpoints: continuity.checkpoints,
      lanes,
      skipped_partitions: continuity.skippedPartitions,
    };
    receipts.push(receipt);
    stores.log?.(
      `unified-accounts migration ${receipt.outcome}: ${harnessId} → row "${rowId}" ` +
        `(${receipt.sessions} sessions, ${receipt.checkpoints} checkpoints, ${receipt.lanes} lane homes` +
        (receipt.skipped_partitions.length > 0
          ? `; SKIPPED quarantined partition(s) ${receipt.skipped_partitions.join(", ")} — their sessions migrate after recovery`
          : "") +
        `)`,
    );
  }
  return receipts;
}

/** Phase REGISTRY_WRITTEN's one locked config write. Idempotent: an existing
 * (harness, row_id) row — or a row already holding the locator — is adopted
 * untouched; `native_credentials_enabled=false` maps to `enabled=false`
 * (the deprecated key stays in config as the downgrade-window mirror). */
function registerMigratedRow(harnessId: string, record: AccountsHarnessMigration): void {
  const detected = detectLegacyLogin(harnessId as AccountsMigrationHarness);
  updateGlobalConfig((config) => {
    const existing = config.credential_profiles.find(
      (p) =>
        (p.harness_id === harnessId && p.profile_id === record.row_id) ||
        (p.harness_id === harnessId && sameLocator(p.isolation_locator, record.locator)),
    );
    if (existing) return config;
    const nativeEnabled = config.harnesses[harnessId]?.native_credentials_enabled !== false;
    const entry: CredentialProfile = {
      profile_id: record.row_id,
      harness_id: harnessId,
      display_name: detected?.displayName ?? `${harnessId} default login`,
      credential_kind: "config_dir_login",
      isolation_locator: record.locator,
      secret_ref: null,
      enabled: nativeEnabled,
      created_at: nowIso(),
    };
    return { ...config, credential_profiles: [...config.credential_profiles, entry] };
  });
}

export interface AccountsRollbackReceipt {
  harness_id: string;
  row_id: string;
  sessions: number;
  checkpoints: number;
  lanes: number;
  skipped_partitions: string[];
}

/**
 * The supported downgrade path (run BEFORE installing 3.5.0): surgically
 * reverses every migration phase — sessions/checkpoints/lane homes return to
 * the null engine-default keys, the auto-registered row leaves the registry
 * (its `enabled` state returns to the `native_credentials_enabled` mirror),
 * the row's quota subject retires, and the harness's migration record is
 * removed so a later new-engine start re-migrates cleanly. The pre-migration
 * config backup (`backup_ref`) stays on disk as manual-recovery evidence.
 * Credential bytes were never moved, so nothing is copied back.
 */
export function rollbackAccountsUnifiedMigration(
  stores: AccountsMigrationStores,
  harnessId?: string,
): AccountsRollbackReceipt[] {
  const receipts: AccountsRollbackReceipt[] = [];
  const targets = harnessId ? [harnessId] : Object.keys(readAccountsMigrationFileStrict());
  for (const target of targets) {
    const file = readAccountsMigrationFileStrict();
    const record = Object.prototype.hasOwnProperty.call(file, target) ? file[target] : undefined;
    if (!record) continue;
    const rowId = record.row_id;
    // Phase ROLLING_BACK persists BEFORE the first reverse step: a crash
    // mid-rollback must not leave a record whose phase claims a completed
    // forward migration while continuity is half-reversed. The startup
    // migration never resumes a rolling_back record forward; every reverse
    // step below is idempotent, so re-running this command finishes the job.
    if (record.phase !== "rolling_back") {
      writeAccountsMigrationFile({ ...file, [target]: { ...record, phase: "rolling_back" } });
    }
    const continuity = stores.threads.rollbackProfileContinuity(target, rowId);
    let lanes = 0;
    for (const root of laneRootsOf(stores)) lanes += rollbackProfileLanes(root, target, rowId);
    stores.quota.removeSubject(target, rowId);
    updateGlobalConfig((config) => {
      const row = config.credential_profiles.find(
        (p) => p.harness_id === target && p.profile_id === rowId,
      );
      // Only the row this migration created leaves the registry — matched by
      // the record's exact locator, so a later hand-registered same-id row
      // pointing elsewhere is never silently deleted.
      if (!row || !sameLocator(row.isolation_locator, record.locator)) return config;
      return {
        ...config,
        harnesses: {
          ...config.harnesses,
          [target]: {
            ...config.harnesses[target],
            native_credentials_enabled: row.enabled,
          },
        },
        credential_profiles: config.credential_profiles.filter((p) => p !== row),
      };
    });
    const remaining = { ...readAccountsMigrationFileStrict() };
    delete remaining[target];
    writeAccountsMigrationFile(remaining);
    receipts.push({
      harness_id: target,
      row_id: rowId,
      sessions: continuity.sessions,
      checkpoints: continuity.checkpoints,
      lanes,
      skipped_partitions: continuity.skippedPartitions,
    });
    stores.log?.(
      `unified-accounts migration ROLLED BACK: ${target} row "${rowId}" ` +
        `(${continuity.sessions} sessions, ${continuity.checkpoints} checkpoints, ${lanes} lane homes returned to the engine-default keys)`,
    );
  }
  return receipts;
}
