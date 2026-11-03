import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import {
  AccountsUnifiedMigrationFile,
  FrozenTaskContractArtifact,
  GlobalConfig,
  HarnessEvent,
  RunEvent,
  RunTelemetry,
} from "../../packages/schema/dist/index.js";
import {
  assertExistingDefaultSecondStartupStable,
  assertNoPreexistingDaemon,
  assertRegularFileUnchanged,
  automaticBatteryHarnesses,
  batteryProfileReady,
  batteryReviewerModels,
  batteryReviewerPanelEntry,
  canonicalBatteryProfileState,
  describeFileSnapshot,
  durableAttemptRouteEvidence,
  evaluateRequiredNativeRoutes,
  isBatteryRepoRoot,
  isCrossFamilyConvergenceRefusal,
  nativeBatteryRowReady,
  probeHarnessAccessRefusal,
  projectBatteryHarnessReadiness,
  projectBatteryDaemonLease,
  relevantRunAttemptKeys,
  resolveRealHarnessBatteryLayout,
  runtimeReplacementIdentityFromHandshake,
  sameDaemonLease,
  selectBatteryProfile,
  selectRealHarnessBatteryModel,
  snapshotRegularFile,
  validateExistingDefaultStartupTransition,
  validateBatteryRunArtifacts,
  validateBatteryTaskIdentity,
  withBatteryReviewerModels,
  withExplicitBatteryModels,
  READONLY_CAPABILITY_HARNESSES,
  evaluateReadonlyCapabilityAnswer,
  readonlyCapabilityFixture,
  readonlyCapabilityPrompt,
  readonlyCapabilityRequest,
  readonlyCapabilityRows,
} from "./real-harness-battery-state.mjs";
import { normalizeRunStartRequest } from "../../packages/control-api/dist/run-start.js";

const fixtureRoots = [];

test("offline adapter refusal accepts the exact typed pre-event error", async () => {
  const adapter = {
    async *run() {
      throw Object.assign(new Error("unsupported access"), {
        code: "access_profile_incompatible",
      });
    },
  };

  await expect(
    probeHarnessAccessRefusal({
      adapter,
      spec: { access: "workspace_write" },
      wantedCode: "access_profile_incompatible",
    }),
  ).resolves.toMatchObject({
    valid: true,
    code: "access_profile_incompatible",
    eventsEmitted: 0,
  });
});

test("offline adapter refusal rejects a wrong code or any emitted event", async () => {
  const wrongCode = {
    async *run() {
      throw Object.assign(new Error("wrong refusal"), { code: "harness_unavailable" });
    },
  };
  const lateRefusal = {
    async *run() {
      yield { type: "started" };
      throw Object.assign(new Error("too late"), { code: "access_profile_incompatible" });
    },
  };

  await expect(
    probeHarnessAccessRefusal({
      adapter: wrongCode,
      spec: { access: "workspace_write" },
      wantedCode: "access_profile_incompatible",
    }),
  ).resolves.toMatchObject({ valid: false, code: "harness_unavailable", eventsEmitted: 0 });
  await expect(
    probeHarnessAccessRefusal({
      adapter: lateRefusal,
      spec: { access: "workspace_write" },
      wantedCode: "access_profile_incompatible",
    }),
  ).resolves.toMatchObject({
    valid: false,
    code: "access_profile_incompatible",
    eventsEmitted: 1,
  });
});

test("real OpenCode public adapter refuses workspace_write before a trap binary spawns", () => {
  const f = fixture();
  const trapBin = join(f.root, "opencode-trap.sh");
  const trapMarker = join(f.root, "opencode-spawned");
  writeFileSync(trapBin, '#!/bin/sh\n: > "$CLAUDEXOR_OPENCODE_TRAP_MARKER"\nexit 91\n', {
    mode: 0o700,
  });
  const adapterUrl = pathToFileURL(resolve("packages/harness-opencode/dist/index.js")).href;
  const helperUrl = pathToFileURL(resolve("scripts/lib/real-harness-battery-state.mjs")).href;
  const source = [
    `import { createOpenCodeAdapter } from ${JSON.stringify(adapterUrl)};`,
    `import { probeHarnessAccessRefusal } from ${JSON.stringify(helperUrl)};`,
    'const result = await probeHarnessAccessRefusal({ adapter: createOpenCodeAdapter(), spec: { access: "workspace_write" }, wantedCode: "access_profile_incompatible" });',
    "process.stdout.write(JSON.stringify(result));",
    "if (!result.valid) process.exitCode = 2;",
  ].join("\n");
  const probeEnv = {
    ...process.env,
    CLAUDEXOR_OPENCODE_BIN: trapBin,
    CLAUDEXOR_OPENCODE_TRAP_MARKER: trapMarker,
  };
  delete probeEnv.OPENCODE_API_KEY;
  delete probeEnv.OPENAI_API_KEY;
  delete probeEnv.ANTHROPIC_API_KEY;
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: resolve("."),
    env: probeEnv,
    encoding: "utf8",
    timeout: 10_000,
  });

  expect(probe.status).toBe(0);
  expect(probe.signal).toBeNull();
  expect(existsSync(trapMarker)).toBe(false);
  expect(JSON.parse(probe.stdout)).toMatchObject({
    valid: true,
    code: "access_profile_incompatible",
    eventsEmitted: 0,
  });
});

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "claudexor-battery-state-")));
  fixtureRoots.push(root);
  const home = join(root, "home");
  const sourceRoot = join(root, "source");
  const defaultConfig = join(home, ".claudexor", "v3");
  mkdirSync(defaultConfig, { recursive: true });
  mkdirSync(sourceRoot);
  return { root, home, sourceRoot, defaultConfig };
}

test("scratch mode keeps its isolated config override", () => {
  const f = fixture();
  const defaultBatteryRoot = join(f.home, ".claudexor", "dogfood", "battery-1");
  expect(
    resolveRealHarnessBatteryLayout({
      home: f.home,
      sourceRoot: f.sourceRoot,
      defaultBatteryRoot,
    }),
  ).toEqual({
    mode: "scratch",
    batteryRoot: defaultBatteryRoot,
    configDir: join(defaultBatteryRoot, "config"),
    exportConfigDir: true,
  });
});

test("existing-default mode accepts only the canonical default root and external battery dir", () => {
  const f = fixture();
  const batteryRoot = join(f.root, "dogfood", "battery-1");
  expect(
    resolveRealHarnessBatteryLayout({
      home: f.home,
      sourceRoot: f.sourceRoot,
      defaultBatteryRoot: join(f.root, "unused"),
      batteryDir: batteryRoot,
      requestedConfigDir: f.defaultConfig,
    }),
  ).toEqual({
    mode: "existing_default",
    batteryRoot,
    configDir: f.defaultConfig,
    exportConfigDir: false,
  });
});

test("existing-default mode rejects ambient, foreign, symlinked, and overlapping roots", () => {
  const f = fixture();
  const args = {
    home: f.home,
    sourceRoot: f.sourceRoot,
    defaultBatteryRoot: join(f.root, "unused"),
    batteryDir: join(f.root, "dogfood"),
    requestedConfigDir: f.defaultConfig,
  };
  expect(() =>
    resolveRealHarnessBatteryLayout({ ...args, ambientConfigDir: join(f.root, "ambient") }),
  ).toThrow(/cannot be combined/);
  const foreign = join(f.root, "foreign");
  mkdirSync(foreign);
  expect(() => resolveRealHarnessBatteryLayout({ ...args, requestedConfigDir: foreign })).toThrow(
    /canonical default/,
  );
  const link = join(f.root, "config-link");
  symlinkSync(f.defaultConfig, link);
  expect(() => resolveRealHarnessBatteryLayout({ ...args, requestedConfigDir: link })).toThrow(
    /canonical default/,
  );
  expect(() =>
    resolveRealHarnessBatteryLayout({
      ...args,
      batteryDir: join(f.home, ".claudexor", "dogfood"),
    }),
  ).toThrow(/outside the Claudexor runtime tree/);
  expect(() =>
    resolveRealHarnessBatteryLayout({ ...args, batteryDir: join(f.sourceRoot, "tmp") }),
  ).toThrow(/outside the Claudexor source checkout/);
});

test("protected config snapshot detects byte and mode changes", () => {
  const f = fixture();
  const path = join(f.defaultConfig, "config.yaml");
  writeFileSync(path, "version: 1\n", { mode: 0o600 });
  const before = snapshotRegularFile(path);
  expect(describeFileSnapshot(assertRegularFileUnchanged(path, before))).toEqual({
    exists: true,
    digest: before.digest,
    mode: 0o600,
  });
  writeFileSync(path, "version: 1\nrouting: {}\n");
  expect(() => assertRegularFileUnchanged(path, before)).toThrow(/changed protected state/);
  writeFileSync(path, "version: 1\n");
  chmodSync(path, 0o640);
  expect(() => assertRegularFileUnchanged(path, before)).toThrow(/changed protected state/);
});

function stateSnapshot(f, name, text, mode = 0o600) {
  const path = join(f.root, name);
  writeFileSync(path, text, { mode });
  return snapshotRegularFile(path);
}

function configText(profiles = [], extra = "") {
  const rows = profiles
    .map(({ harness = "codex", id = `${harness}-default`, locator = `/tmp/${harness}-home` }) =>
      [
        `  - profile_id: ${id}`,
        `    harness_id: ${harness}`,
        `    display_name: ${harness} default login`,
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${locator}`,
        "    secret_ref: null",
        "    enabled: true",
        "    created_at: 2026-08-19T00:00:00.000Z",
      ].join("\n"),
    )
    .join("\n");
  return `version: 1\n${extra}credential_profiles:${rows ? `\n${rows}` : " []"}\n`;
}

function configValue(profiles = [], extra = {}) {
  return {
    version: 1,
    ...extra,
    credential_profiles: profiles.map(
      ({ harness = "codex", id = `${harness}-default`, locator = `/tmp/${harness}-home` }) => ({
        profile_id: id,
        harness_id: harness,
        display_name: `${harness} default login`,
        credential_kind: "config_dir_login",
        isolation_locator: locator,
        secret_ref: null,
        enabled: true,
        created_at: "2026-08-19T00:00:00.000Z",
      }),
    ),
  };
}

function migrationText({
  harness = "codex",
  id = `${harness}-default`,
  locator = `/tmp/${harness}-home`,
  phase = "completed",
  backup = `/tmp/backup-${harness}`,
} = {}) {
  return `${JSON.stringify(
    {
      [harness]: {
        phase,
        row_id: id,
        legacy_aliases: [null],
        locator,
        backup_ref: backup,
      },
    },
    null,
    2,
  )}\n`;
}

function startupTransitionArgs(f, overrides = {}) {
  const configBefore =
    overrides.configBefore ?? stateSnapshot(f, "config-before.yaml", configText());
  const migrationBefore =
    overrides.migrationBefore ?? snapshotRegularFile(join(f.root, "migration-before-missing.json"));
  const configAfter =
    overrides.configAfter ??
    stateSnapshot(
      f,
      "config-after.yaml",
      configText([{ harness: "codex", locator: "/tmp/codex-home" }]),
    );
  const migrationAfter =
    overrides.migrationAfter ??
    stateSnapshot(f, "migration-after.json", migrationText({ backup: "/tmp/backup-codex" }));
  return {
    configBefore,
    migrationBefore,
    configAfter,
    migrationAfter,
    configBeforeValue: overrides.configBeforeValue ?? configValue(),
    configAfterValue:
      overrides.configAfterValue ?? configValue([{ harness: "codex", locator: "/tmp/codex-home" }]),
    backupSnapshots: overrides.backupSnapshots ?? {
      "/tmp/backup-codex": { ...configBefore, value: configValue() },
    },
    globalConfigSchema: GlobalConfig,
    migrationSchema: AccountsUnifiedMigrationFile,
  };
}

test("existing-default startup accepts one receipt-bound accounts migration exactly once", () => {
  const f = fixture();
  expect(validateExistingDefaultStartupTransition(startupTransitionArgs(f))).toEqual({
    classification: "one_time_accounts_unified_migration",
    validatedRows: [
      {
        harnessId: "codex",
        rowId: "codex-default",
        locator: "/tmp/codex-home",
        backupRef: "/tmp/backup-codex",
      },
    ],
  });
});

test("existing-default startup validates a byte-anchored multi-row backup chain", () => {
  const f = fixture();
  const profiles = [
    { harness: "claude", locator: "/tmp/claude-home" },
    { harness: "codex", locator: "/tmp/codex-home" },
  ];
  const configBefore = stateSnapshot(f, "chain-config-before.yaml", configText());
  const firstIntermediate = stateSnapshot(
    f,
    "chain-config-intermediate.yaml",
    configText(profiles.slice(0, 1)),
  );
  const configAfter = stateSnapshot(f, "chain-config-after.yaml", configText(profiles));
  const migrationAfter = stateSnapshot(
    f,
    "chain-migration-after.json",
    `${JSON.stringify(
      {
        claude: {
          phase: "completed",
          row_id: "claude-default",
          legacy_aliases: [null],
          locator: "/tmp/claude-home",
          backup_ref: "/tmp/backup-claude",
        },
        codex: {
          phase: "completed",
          row_id: "codex-default",
          legacy_aliases: [null],
          locator: "/tmp/codex-home",
          backup_ref: "/tmp/backup-codex",
        },
      },
      null,
      2,
    )}\n`,
  );
  expect(
    validateExistingDefaultStartupTransition(
      startupTransitionArgs(f, {
        configBefore,
        configAfter,
        migrationAfter,
        configBeforeValue: configValue(),
        configAfterValue: configValue(profiles),
        backupSnapshots: {
          "/tmp/backup-claude": { ...configBefore, value: configValue() },
          "/tmp/backup-codex": {
            ...firstIntermediate,
            value: configValue(profiles.slice(0, 1)),
          },
        },
      }),
    ),
  ).toMatchObject({
    classification: "one_time_accounts_unified_migration",
    validatedRows: [
      { harnessId: "claude", rowId: "claude-default" },
      { harnessId: "codex", rowId: "codex-default" },
    ],
  });
});

test("existing-default startup accepts an already migrated byte-identical fixture", () => {
  const f = fixture();
  const config = stateSnapshot(
    f,
    "config-stable.yaml",
    configText([{ harness: "codex", locator: "/tmp/codex-home" }]),
  );
  const migration = stateSnapshot(
    f,
    "migration-stable.json",
    migrationText({ backup: "/tmp/backup-codex" }),
  );
  expect(
    validateExistingDefaultStartupTransition(
      startupTransitionArgs(f, {
        configBefore: config,
        configAfter: config,
        migrationBefore: migration,
        migrationAfter: migration,
        configBeforeValue: configValue([{ harness: "codex", locator: "/tmp/codex-home" }]),
        configAfterValue: configValue([{ harness: "codex", locator: "/tmp/codex-home" }]),
      }),
    ),
  ).toMatchObject({ classification: "already_migrated_unchanged" });
});

test("existing-default startup rejects unrelated config changes and missing migration records", () => {
  const f = fixture();
  const unrelated = stateSnapshot(
    f,
    "config-unrelated.yaml",
    configText([{ harness: "codex", locator: "/tmp/codex-home" }], "interaction_timeout_ms: 1\n"),
  );
  expect(() =>
    validateExistingDefaultStartupTransition(
      startupTransitionArgs(f, {
        configAfter: unrelated,
        configAfterValue: configValue([{ harness: "codex", locator: "/tmp/codex-home" }], {
          interaction_timeout_ms: 1,
        }),
      }),
    ),
  ).toThrow(/outside credential_profiles/);

  const missing = stateSnapshot(f, "migration-empty.json", "{}\n");
  expect(() =>
    validateExistingDefaultStartupTransition(startupTransitionArgs(f, { migrationAfter: missing })),
  ).toThrow(/rows and appended credential profiles do not match/);
});

test("existing-default startup rejects incomplete, locator-mismatched, and backup-mismatched rows", () => {
  const f = fixture();
  const incomplete = stateSnapshot(
    f,
    "migration-incomplete.json",
    migrationText({ phase: "registry_written" }),
  );
  expect(() =>
    validateExistingDefaultStartupTransition(
      startupTransitionArgs(f, { migrationAfter: incomplete }),
    ),
  ).toThrow(/incomplete/);

  const locatorMismatch = stateSnapshot(
    f,
    "migration-locator.json",
    migrationText({ locator: "/tmp/other-home" }),
  );
  expect(() =>
    validateExistingDefaultStartupTransition(
      startupTransitionArgs(f, { migrationAfter: locatorMismatch }),
    ),
  ).toThrow(/matching config_dir_login profile/);

  const args = startupTransitionArgs(f);
  const wrongBackup = stateSnapshot(
    f,
    "wrong-backup.yaml",
    configText([], "interaction_timeout_ms: 1\n"),
  );
  expect(() =>
    validateExistingDefaultStartupTransition({
      ...args,
      backupSnapshots: {
        "/tmp/backup-codex": {
          ...wrongBackup,
          value: configValue([], { interaction_timeout_ms: 1 }),
        },
      },
    }),
  ).toThrow(/backup does not match/);
});

test("existing-default second startup rejects any byte or mode mutation", () => {
  const f = fixture();
  const config = stateSnapshot(f, "config-first.yaml", configText());
  const migration = stateSnapshot(f, "migration-first.json", "{}\n");
  expect(
    assertExistingDefaultSecondStartupStable({
      configAfterFirst: config,
      migrationAfterFirst: migration,
      configAfterSecond: config,
      migrationAfterSecond: migration,
    }),
  ).toEqual({
    config: describeFileSnapshot(config),
    migration: describeFileSnapshot(migration),
  });
  const changed = stateSnapshot(f, "config-second.yaml", `${configText()}# changed\n`);
  expect(() =>
    assertExistingDefaultSecondStartupStable({
      configAfterFirst: config,
      migrationAfterFirst: migration,
      configAfterSecond: changed,
      migrationAfterSecond: migration,
    }),
  ).toThrow(/second startup changed config/);
  const modeChanged = stateSnapshot(f, "migration-second.json", "{}\n", 0o640);
  expect(() =>
    assertExistingDefaultSecondStartupStable({
      configAfterFirst: config,
      migrationAfterFirst: migration,
      configAfterSecond: config,
      migrationAfterSecond: modeChanged,
    }),
  ).toThrow(/second startup changed accounts-unified/);
});

test("daemon preflight fails closed on each live ownership surface", () => {
  const clear = {
    statusCode: 1,
    socketIsAlive: false,
    lease: { startAllowed: true, capableOwner: null, physicallyAbsent: true },
  };
  expect(() => assertNoPreexistingDaemon(clear)).not.toThrow();
  expect(() => assertNoPreexistingDaemon({ ...clear, statusCode: 0 })).toThrow(/pre-existing/);
  expect(() => assertNoPreexistingDaemon({ ...clear, socketIsAlive: true })).toThrow(/live socket/);
  expect(() =>
    assertNoPreexistingDaemon({
      ...clear,
      lease: { startAllowed: false, capableOwner: null, physicallyAbsent: false },
    }),
  ).toThrow(/writer-lease/);
});

test("battery writer authority distinguishes start, cleanup owner, and physical release", () => {
  const owner = { pid: 41, token: "owner" };
  expect(projectBatteryDaemonLease({ status: "absent", path: "/tmp/d.writer" })).toEqual({
    startAllowed: true,
    capableOwner: null,
    physicallyAbsent: true,
  });
  expect(
    projectBatteryDaemonLease({
      status: "owned",
      path: "/tmp/d.writer",
      owner,
      capability: { status: "proven_stale", reason: "linux_zombie" },
    }),
  ).toEqual({ startAllowed: true, capableOwner: null, physicallyAbsent: false });
  expect(
    projectBatteryDaemonLease({
      status: "owned",
      path: "/tmp/d.writer",
      owner,
      capability: { status: "capable", reason: "identity_match" },
    }),
  ).toEqual({ startAllowed: false, capableOwner: owner, physicallyAbsent: false });
  expect(
    projectBatteryDaemonLease({
      status: "owned",
      path: "/tmp/d.writer",
      owner,
      capability: { status: "unknown", reason: "identity_unavailable" },
    }),
  ).toEqual({ startAllowed: false, capableOwner: null, physicallyAbsent: false });
  expect(
    projectBatteryDaemonLease({
      status: "unknown",
      path: "/tmp/d.writer",
      reason: "owner_malformed",
    }),
  ).toEqual({ startAllowed: false, capableOwner: null, physicallyAbsent: false });
});

test("daemon cleanup authority is bound to the exact writer lease", () => {
  const captured = { pid: 41, token: "captured" };
  expect(sameDaemonLease(captured, { ...captured })).toBe(true);
  expect(sameDaemonLease(captured, { pid: 42, token: "captured" })).toBe(false);
  expect(sameDaemonLease(captured, { pid: 41, token: "successor" })).toBe(false);
  expect(sameDaemonLease(captured, null)).toBe(false);
});

test("daemon cleanup keeps the observed identity when the candidate handshake mismatches", () => {
  const observedSha = "a".repeat(40);
  expect(
    runtimeReplacementIdentityFromHandshake({
      engine: { version: "3.2.1", sha: observedSha, entry: "/tmp/claudexord.js" },
    }),
  ).toEqual({ version: "3.2.1", buildSha: observedSha });
  expect(
    runtimeReplacementIdentityFromHandshake({
      engine: { version: "3.2.1", sha: "not-a-sha", entry: "/tmp/claudexord.js" },
    }),
  ).toBeNull();
});

test("native-session acceptance rejects missing and API-fallback routes", () => {
  const required = ["codex", "claude"];
  const codex = {
    harnessId: "codex",
    authMode: "local_session",
    authSource: "native_session",
  };
  const claude = {
    harnessId: "claude",
    authMode: "local_session",
    authSource: "native_session",
  };
  expect(evaluateRequiredNativeRoutes(required, [codex, claude])).toEqual({
    valid: true,
    missing: [],
    nonNative: [],
  });
  expect(evaluateRequiredNativeRoutes(required, [codex])).toMatchObject({
    valid: false,
    missing: ["claude"],
  });
  expect(
    evaluateRequiredNativeRoutes(required, [
      codex,
      { ...claude, authMode: "api_key", authSource: "api_key_env" },
    ]),
  ).toMatchObject({ valid: false, nonNative: [{ harnessId: "claude" }] });
  expect(
    evaluateRequiredNativeRoutes(required, [
      codex,
      { ...claude, authMode: null, authSource: null },
    ]),
  ).toMatchObject({ valid: false, nonNative: [{ harnessId: "claude" }] });
});

function profileEntry(harnessId, profileId, status = {}) {
  return {
    profile: {
      harness_id: harnessId,
      profile_id: profileId,
      enabled: status.enabled ?? true,
      isolation_locator: status.locator ?? null,
    },
    status: {
      availability: status.availability ?? "available",
      verification: status.verification ?? "passed",
    },
  };
}

function profilePool(harnessId, profileId) {
  return [{ harness_id: harnessId, next_up: { kind: "profile", profileId } }];
}

test("pool readiness includes Cursor automatically but keeps Agy named-only", () => {
  const cursorProfile = profileEntry("cursor", "sol-validator");
  const exhausted = profileEntry("agy", "preferred", { availability: "unavailable" });
  const agyProfile = profileEntry("agy", "fallback");
  expect(batteryProfileReady(exhausted)).toBe(false);
  expect(selectBatteryProfile([exhausted, agyProfile], "agy", "preferred")).toBe(agyProfile);
  const cursor = projectBatteryHarnessReadiness({
    harnessId: "cursor",
    doctorReport: { status: "degraded" },
    accountPools: profilePool("cursor", "sol-validator"),
    profileEntries: [cursorProfile],
    requiredProfileEntry: cursorProfile,
  });
  const agy = projectBatteryHarnessReadiness({
    harnessId: "agy",
    doctorReport: { status: "degraded" },
    accountPools: profilePool("agy", "fallback"),
    profileEntries: [exhausted, agyProfile],
    requiredProfileEntry: agyProfile,
  });
  expect(cursor).toMatchObject({
    automaticRouteReady: true,
    requiredRouteReady: true,
    automaticSource: "account_pool_profile",
  });
  expect(agy).toMatchObject({
    automaticRouteReady: false,
    requiredRouteReady: true,
    requiredSource: "named_profile",
  });
  expect(automaticBatteryHarnesses(["cursor", "agy"], { cursor, agy })).toEqual(["cursor"]);
  expect(selectBatteryProfile([exhausted], "agy", "preferred")).toBeNull();
});

test("explicit named battery rows are independent from default-route readiness", () => {
  const ready = profileEntry("codex", "proton0");
  expect(
    nativeBatteryRowReady({
      defaultHarnessReady: false,
      requiresProfile: true,
      profileEntry: ready,
    }),
  ).toBe(true);
  expect(
    nativeBatteryRowReady({
      defaultHarnessReady: false,
      requiresProfile: false,
      profileEntry: ready,
    }),
  ).toBe(false);
  expect(
    nativeBatteryRowReady({
      defaultHarnessReady: true,
      requiresProfile: true,
      profileEntry: profileEntry("codex", "disabled", { enabled: false }),
    }),
  ).toBe(false);
});

test("non-Agy named readiness cannot replace the required automatic route", () => {
  const named = profileEntry("codex", "proton0");
  expect(
    projectBatteryHarnessReadiness({
      harnessId: "codex",
      doctorReport: { status: "degraded" },
      requiredProfileEntry: named,
    }),
  ).toMatchObject({
    automaticRouteReady: false,
    requiredRouteReady: false,
    requiredSource: null,
  });
});

test.each([
  {
    name: "disabled pool profile",
    input: (() => {
      const disabled = profileEntry("cursor", "disabled", { enabled: false });
      return {
        harnessId: "cursor",
        doctorReport: { status: "degraded" },
        accountPools: profilePool("cursor", "disabled"),
        profileEntries: [disabled],
        requiredProfileEntry: disabled,
      };
    })(),
    expected: { automaticRouteReady: false, requiredRouteReady: false },
  },
  {
    name: "missing pool profile",
    input: {
      harnessId: "cursor",
      doctorReport: null,
      accountPools: profilePool("cursor", "missing"),
    },
    expected: { automaticRouteReady: false, requiredRouteReady: false },
  },
  {
    name: "legacy doctor without account pools",
    input: { harnessId: "claude", doctorReport: { status: "ok" } },
    expected: {
      automaticRouteReady: true,
      requiredRouteReady: true,
      automaticSource: "doctor",
    },
  },
])("battery readiness handles $name", ({ input, expected }) => {
  expect(projectBatteryHarnessReadiness(input)).toMatchObject(expected);
});

test("Cursor profile state prioritizes native SQLite/WAL over a large unrelated HOME", () => {
  const f = fixture();
  const profileHome = join(f.root, "cursor-profile");
  const unrelated = join(profileHome, "Ouroboros", "cache");
  const nativeState = join(profileHome, ".cursor", "chats", "project", "run");
  mkdirSync(unrelated, { recursive: true });
  mkdirSync(nativeState, { recursive: true });
  for (let index = 0; index < 32; index += 1) {
    writeFileSync(join(unrelated, `${String(index).padStart(3, "0")}.txt`), "noise");
  }
  writeFileSync(join(nativeState, "store.db"), "sqlite");
  writeFileSync(join(nativeState, "store.db-wal"), "wal");

  const state = canonicalBatteryProfileState(
    profileEntry("cursor", "sol-validator", { locator: profileHome }),
    "cursor",
    { maxEntries: 12 },
  );
  expect(state).toMatchObject({
    valid: true,
    locator: profileHome,
    scan: { exhausted: false, maxEntries: 12 },
  });
  expect(state.files).toEqual([
    ".cursor/chats/project/run/store.db",
    ".cursor/chats/project/run/store.db-wal",
  ]);
  expect(state.scan.entriesVisited).toBeLessThanOrEqual(12);
});

test("Cursor profile state rejects directory and symlink SQLite primaries", () => {
  const f = fixture();
  const profileHome = join(f.root, "cursor-profile-invalid");
  const nativeState = join(profileHome, ".cursor", "chats", "project", "run");
  mkdirSync(join(nativeState, "directory.db"), { recursive: true });
  writeFileSync(join(nativeState, "directory.db-wal"), "wal");
  const target = join(profileHome, "real-but-not-db.txt");
  writeFileSync(target, "not cursor sqlite state");
  symlinkSync(target, join(nativeState, "linked.db"));
  writeFileSync(join(nativeState, "linked.db-wal"), "wal");

  expect(
    canonicalBatteryProfileState(
      profileEntry("cursor", "sol-validator", { locator: profileHome }),
      "cursor",
    ),
  ).toMatchObject({ valid: false, files: [] });
});

test("battery model selection keeps Claude on Haiku and prefers available Agy gpt-oss", () => {
  expect(
    selectRealHarnessBatteryModel("claude", ["claude-fable-5", "claude-haiku-4-5"]),
  ).toMatchObject({ id: "claude-haiku-4-5", source: "preferred" });
  expect(selectRealHarnessBatteryModel("claude", ["claude-fable-5"]).id).toBeNull();
  expect(
    selectRealHarnessBatteryModel("agy", ["gemini-3.7-flash-low", "gpt-oss-120b-medium"]),
  ).toMatchObject({ id: "gpt-oss-120b-medium", source: "preferred" });
  expect(selectRealHarnessBatteryModel("agy", ["vendor-fast-flash"])).toMatchObject({
    id: "vendor-fast-flash",
    source: "cheapest_catalog_fallback",
  });
});

test("every automatic Claude CLI task receives Haiku while explicit non-Fable models are allowed", () => {
  const selectModel = () => ({ id: "claude-haiku-4-5" });
  expect(
    withExplicitBatteryModels(
      ["ask", "2+2", "--harness", "claude", "--effort", "low"],
      selectModel,
    ),
  ).toEqual([
    "ask",
    "2+2",
    "--harness",
    "claude",
    "--effort",
    "low",
    "--model",
    "claude-haiku-4-5",
  ]);
  expect(
    withExplicitBatteryModels(["best-of", "fix", "--harness", "codex,claude,cursor"], selectModel),
  ).toEqual([
    "best-of",
    "fix",
    "--harness",
    "codex,claude,cursor",
    "--reviewer-model",
    "anthropic=claude-haiku-4-5,openai=gpt-5.4-mini",
    "--primary-harness",
    "claude",
    "--model",
    "claude-haiku-4-5",
  ]);
  expect(() =>
    withExplicitBatteryModels(
      ["agent", "fix", "--harness", "claude", "--model", "claude-fable-5"],
      selectModel,
    ),
  ).toThrow(/refuses unsafe Claude model alias/);
  expect(() =>
    withExplicitBatteryModels(
      ["ask", "read image", "--harness", "claude", "--model", "best"],
      selectModel,
    ),
  ).toThrow(/refuses unsafe Claude model alias/);
  expect(
    withExplicitBatteryModels(
      ["ask", "read image", "--harness", "claude", "--model", "claude-sonnet-4-6"],
      selectModel,
    ),
  ).toEqual(["ask", "read image", "--harness", "claude", "--model", "claude-sonnet-4-6"]);
  expect(() =>
    withExplicitBatteryModels(["plan", "fix", "--harness", "claude"], () => ({
      id: null,
    })),
  ).toThrow(/requires an explicit catalog-backed Claude Haiku/);
});

test("mutating CLI and direct bodies cannot omit or select forbidden reviewer models", () => {
  const expected = {
    anthropic: "claude-haiku-4-5",
    openai: "gpt-5.4-mini",
  };
  expect(batteryReviewerModels()).toEqual(expected);
  expect(
    withExplicitBatteryModels(["agent", "fix", "--harness", "codex"], () => ({ id: null })),
  ).toEqual([
    "agent",
    "fix",
    "--harness",
    "codex",
    "--reviewer-model",
    "anthropic=claude-haiku-4-5,openai=gpt-5.4-mini",
  ]);
  expect(() =>
    withExplicitBatteryModels(
      [
        "best-of",
        "fix",
        "--harness",
        "codex,claude",
        "--reviewer-model",
        "anthropic=claude-fable-5,openai=gpt-5.3-codex-spark",
      ],
      () => ({ id: "claude-haiku-4-5" }),
    ),
  ).toThrow(/refuses non-smoke reviewer models/);
  expect(withBatteryReviewerModels({ mode: "agent" })).toEqual({
    mode: "agent",
    reviewerModels: expected,
  });
  expect(() =>
    withBatteryReviewerModels({
      mode: "agent",
      reviewerModels: { anthropic: "claude-fable-5", openai: "gpt-5.3-codex-spark" },
    }),
  ).toThrow(/refuses non-smoke reviewer models/);
  expect(batteryReviewerPanelEntry("claude")).toBe("claude=claude-haiku-4-5:low");
  expect(batteryReviewerPanelEntry("codex")).toBe("codex=gpt-5.4-mini:low");
  expect(batteryReviewerPanelEntry("cursor")).toBe("cursor=gpt-5.3-codex-low:low");
});

test("battery ownership is contained by the synthetic repos root", () => {
  expect(isBatteryRepoRoot("/tmp/battery/repos", "/tmp/battery/repos/phase1")).toBe(true);
  expect(isBatteryRepoRoot("/tmp/battery/repos", "/tmp/foreign/review")).toBe(false);
});

function batteryTask(taskId = "task-1") {
  return {
    schema_version: 2,
    task_id: taskId,
    created_at: "2026-08-06T00:00:00Z",
    repo: { root: "/tmp/battery/repos/phase1", base_ref: "main" },
    mode: { kind: "agent" },
    user_intent: { raw: "exercise native route acceptance" },
    tests: { commands: [] },
  };
}

function batteryHarnessEvent({ runId = "run-1", taskId = "task-1", attemptId = "a01" } = {}) {
  return {
    seq: 1,
    ts: "2026-08-06T00:00:00Z",
    run_id: runId,
    task_id: taskId,
    type: "harness.event",
    payload: {
      harness_id: "codex",
      attempt_id: attemptId,
      session_id: "session-1",
      ts: "2026-08-06T00:00:00Z",
      type: "started",
      title: "started",
      credential_route: "vendor_native",
    },
  };
}

function batteryTelemetry({ runId = "run-1", taskId = "task-1", attemptId = "a01" } = {}) {
  return {
    schema_version: 2,
    run_id: runId,
    task_id: taskId,
    generated_at: "2026-08-06T00:00:00Z",
    mode: "agent",
    requested_access: "workspace_write",
    effective_access: "workspace_write",
    external_context_policy: "off",
    effective_web_mode: "off",
    final_attempt_id: attemptId,
    web: {},
    attempts: [
      {
        attempt_id: attemptId,
        harness_id: "codex",
        auth_mode: "local_session",
        auth_source: "native_session",
        web: {},
      },
    ],
  };
}

const artifactSchemas = {
  runEventSchema: RunEvent,
  harnessEventSchema: HarnessEvent,
  telemetrySchema: RunTelemetry,
};

test("battery evidence validates canonical schemas and binds run/task identity", () => {
  const job = { runId: "run-1", taskId: "task-1" };
  const taskResult = validateBatteryTaskIdentity({
    job,
    task: batteryTask(),
    taskSchema: FrozenTaskContractArtifact,
  });
  expect(taskResult).toMatchObject({ valid: true, reason: null });
  expect(
    validateBatteryRunArtifacts({
      job,
      task: taskResult.task,
      eventText: `${JSON.stringify(batteryHarnessEvent())}\n`,
      telemetry: batteryTelemetry(),
      telemetryPresent: true,
      ...artifactSchemas,
    }),
  ).toMatchObject({ valid: true, reason: null });
});

test("battery evidence rejects partial task contracts and foreign task identities", () => {
  const job = { runId: "run-1", taskId: "task-1" };
  expect(
    validateBatteryTaskIdentity({
      job,
      task: { repo: { root: "/tmp/battery/repos/phase1" } },
      taskSchema: FrozenTaskContractArtifact,
    }),
  ).toMatchObject({ valid: false, reason: "task_contract_missing_or_malformed" });
  expect(
    validateBatteryTaskIdentity({
      job,
      task: batteryTask("task-foreign"),
      taskSchema: FrozenTaskContractArtifact,
    }),
  ).toMatchObject({ valid: false, reason: "artifact_identity_mismatch" });
});

test.each([
  ["empty journal", "", "run_events_missing_or_malformed"],
  ["malformed journal", "{}\n", "run_events_missing_or_malformed"],
  [
    "foreign run event",
    `${JSON.stringify(batteryHarnessEvent({ runId: "run-foreign" }))}\n`,
    "artifact_identity_mismatch",
  ],
  [
    "foreign task event",
    `${JSON.stringify(batteryHarnessEvent({ taskId: "task-foreign" }))}\n`,
    "artifact_identity_mismatch",
  ],
  [
    "non-string attempt id",
    `${JSON.stringify(batteryHarnessEvent({ attemptId: 1 }))}\n`,
    "run_events_missing_or_malformed",
  ],
  [
    "boolean attempt id",
    `${JSON.stringify(batteryHarnessEvent({ attemptId: true }))}\n`,
    "run_events_missing_or_malformed",
  ],
  [
    "malformed nested harness event",
    `${JSON.stringify({
      ...batteryHarnessEvent(),
      payload: { ...batteryHarnessEvent().payload, session_id: undefined },
    })}\n`,
    "run_events_missing_or_malformed",
  ],
])("battery evidence rejects %s", (_label, eventText, reason) => {
  expect(
    validateBatteryRunArtifacts({
      job: { runId: "run-1", taskId: "task-1" },
      task: FrozenTaskContractArtifact.parse(batteryTask()),
      eventText,
      telemetry: null,
      telemetryPresent: false,
      ...artifactSchemas,
    }),
  ).toMatchObject({ valid: false, reason });
});

test("battery evidence rejects malformed and alien telemetry", () => {
  const common = {
    job: { runId: "run-1", taskId: "task-1" },
    task: FrozenTaskContractArtifact.parse(batteryTask()),
    eventText: `${JSON.stringify(batteryHarnessEvent())}\n`,
    telemetryPresent: true,
    ...artifactSchemas,
  };
  expect(validateBatteryRunArtifacts({ ...common, telemetry: { attempts: [] } })).toMatchObject({
    valid: false,
    reason: "attempt_telemetry_missing_or_malformed",
  });
  expect(
    validateBatteryRunArtifacts({
      ...common,
      telemetry: batteryTelemetry({ runId: "run-foreign" }),
    }),
  ).toMatchObject({ valid: false, reason: "artifact_identity_mismatch" });
});

test("valid no-attempt preflight journal stays neutral without telemetry", () => {
  const event = {
    seq: 1,
    ts: "2026-08-06T00:00:00Z",
    run_id: "run-1",
    task_id: "task-1",
    type: "run.created",
    payload: {},
  };
  const noStart = validateBatteryRunArtifacts({
    job: { runId: "run-1", taskId: "task-1" },
    task: FrozenTaskContractArtifact.parse(batteryTask()),
    eventText: `${JSON.stringify(event)}\n`,
    telemetry: null,
    telemetryPresent: false,
    ...artifactSchemas,
  });
  expect(noStart).toMatchObject({ valid: true, reason: null, telemetry: null });
  expect(noStart.events.some((item) => item.type === "harness.started")).toBe(false);

  const started = {
    seq: 2,
    ts: "2026-08-06T00:00:01Z",
    run_id: "run-1",
    task_id: "task-1",
    type: "harness.started",
    payload: {
      harness_id: "cursor",
      attempt_id: "a01",
      external_context_policy: "off",
    },
  };
  const withStart = validateBatteryRunArtifacts({
    job: { runId: "run-1", taskId: "task-1" },
    task: FrozenTaskContractArtifact.parse(batteryTask()),
    eventText: `${JSON.stringify(event)}\n${JSON.stringify(started)}\n`,
    telemetry: null,
    telemetryPresent: false,
    ...artifactSchemas,
  });
  expect(withStart).toMatchObject({ valid: true, reason: null, telemetry: null });
  expect(withStart.events.some((item) => item.type === "harness.started")).toBe(true);
});

test("canonical run events discover admitted and raw required-harness attempts", () => {
  expect(
    relevantRunAttemptKeys(
      [
        {
          type: "harness.started",
          payload: { harness_id: "codex", attempt_id: "a01" },
        },
        {
          type: "harness.event",
          payload: { harness_id: "codex", attempt_id: "a01", type: "started" },
        },
        {
          type: "harness.event",
          payload: { harness_id: "claude", attempt_id: "a02", type: "started" },
        },
        {
          type: "harness.event",
          payload: { harness_id: "cursor", attempt_id: "a03", type: "started" },
        },
      ],
      ["codex", "claude"],
    ),
  ).toEqual([
    { harnessId: "codex", attemptId: "a01" },
    { harnessId: "claude", attemptId: "a02" },
  ]);
});

test("cross-family convergence assertion reads the canonical failure, not nested review fields", () => {
  expect(
    isCrossFamilyConvergenceRefusal({
      code: 1,
      json: {
        status: "failed",
        error:
          "convergence requires a cross-family clean review (>=2 healthy reviewer provider families); found 1.",
      },
    }),
  ).toBe(true);
  expect(
    isCrossFamilyConvergenceRefusal({
      code: 1,
      json: {
        status: "failed",
        error: "no harness remains eligible after budget and quota routing",
        runFacts: { outcome: { review: "not_run" }, review: { state: "not_run" } },
      },
    }),
  ).toBe(false);
  expect(
    isCrossFamilyConvergenceRefusal({
      code: 0,
      json: {
        status: "succeeded",
        summary: "convergence requires a cross-family clean review (fixture prose only)",
      },
    }),
  ).toBe(false);
});

test("durable route evidence catches native to API retries after the first start", () => {
  const evidence = durableAttemptRouteEvidence([
    {
      type: "started",
      credential_route: "vendor_native",
      credential_source: "native_session",
    },
    { type: "completed" },
    {
      type: "message",
      payload: { auth_switched: true, to_auth_mode: "api_key" },
    },
    {
      type: "started",
      credential_route: "managed_api_key",
      credential_source: "api_key_env",
    },
  ]);
  expect(evidence).toEqual({
    sawStarted: true,
    observed: [
      { kind: "started", authMode: "local_session", authSource: "native_session" },
      { kind: "auth_switched", authMode: "api_key", authSource: null },
      { kind: "started", authMode: "api_key", authSource: "api_key_env" },
    ],
  });
});

test("top-level route evidence composes its omitted source with exact telemetry", () => {
  const evidence = durableAttemptRouteEvidence(
    [{ type: "started", credential_route: "vendor_native" }, { type: "completed" }],
    { authMode: "local_session", authSource: "native_session" },
  );
  expect(evidence).toEqual({
    sawStarted: true,
    observed: [{ kind: "started", authMode: "local_session", authSource: "native_session" }],
  });
  expect(
    durableAttemptRouteEvidence([{ type: "started", credential_route: "vendor_native" }], {
      authMode: "local_session",
      authSource: null,
    }).observed,
  ).toEqual([{ kind: "started", authMode: "local_session", authSource: null }]);
});

test("telemetry source composition still exposes a later API interval", () => {
  const evidence = durableAttemptRouteEvidence(
    [
      { type: "started", credential_route: "vendor_native" },
      { type: "message", payload: { auth_switched: true, to_auth_mode: "api_key" } },
      { type: "message", credential_route: "managed_api_key" },
    ],
    { authMode: "local_session", authSource: "native_session" },
  );
  const observed = evidence.observed.map((route) => ({ harnessId: "codex", ...route }));
  expect(evaluateRequiredNativeRoutes(["codex"], observed)).toMatchObject({
    valid: false,
    missing: [],
    nonNative: [
      { harnessId: "codex", kind: "auth_switched", authMode: "api_key" },
      { harnessId: "codex", kind: "api_route_event", authMode: "api_key" },
    ],
  });
});

test("durable route evidence fails closed on an unknown auth switch", () => {
  const evidence = durableAttemptRouteEvidence([
    {
      type: "started",
      credential_route: "vendor_native",
      credential_source: "native_session",
    },
    {
      type: "message",
      payload: { auth_switched: true, to_auth_mode: "unknown" },
    },
  ]);
  expect(evidence.observed).toEqual([
    { kind: "started", authMode: "local_session", authSource: "native_session" },
    { kind: "auth_switched", authMode: null, authSource: null },
  ]);
  const observed = evidence.observed.map((route) => ({ harnessId: "codex", ...route }));
  expect(evaluateRequiredNativeRoutes(["codex"], observed)).toMatchObject({
    valid: false,
    missing: [],
    nonNative: [{ harnessId: "codex", kind: "auth_switched", authMode: null, authSource: null }],
  });
});

test.each(["local_session", "subscription"])(
  "durable route evidence accepts a known native %s auth switch",
  (toAuthMode) => {
    const evidence = durableAttemptRouteEvidence([
      {
        type: "started",
        credential_route: "vendor_native",
        credential_source: "native_session",
      },
      {
        type: "message",
        payload: { auth_switched: true, to_auth_mode: toAuthMode },
      },
    ]);
    const observed = evidence.observed.map((route) => ({ harnessId: "codex", ...route }));
    expect(evaluateRequiredNativeRoutes(["codex"], observed)).toMatchObject({
      valid: true,
      missing: [],
      nonNative: [],
    });
  },
);

test("readonly capability rows cover every first-party harness, agy on its named profile", () => {
  const unnamed = readonlyCapabilityRows();
  expect(unnamed.map((row) => row.harness)).toEqual(READONLY_CAPABILITY_HARNESSES);
  expect(new Set(unnamed.map((row) => row.id)).size).toBe(unnamed.length);
  expect(unnamed.every((row) => row.access === "readonly")).toBe(true);
  expect(unnamed.find((row) => row.harness === "agy")).toMatchObject({
    requiresProfile: true,
    profileId: undefined,
  });
  expect(unnamed.filter((row) => row.requiresProfile)).toHaveLength(1);
  const named = readonlyCapabilityRows({ agy: { profile: { profile_id: "anton-razzhigaev" } } });
  expect(named.find((row) => row.harness === "agy")?.profileId).toBe("anton-razzhigaev");
});

test("the readonly probe names both outside paths and the exact answer shape", () => {
  const prompt = readonlyCapabilityPrompt({
    secretPath: "/tmp/outside/secret.txt",
    listingDir: "/tmp/outside/listing",
  });
  expect(prompt).toContain("/tmp/outside/secret.txt");
  expect(prompt).toContain("/tmp/outside/listing");
  expect(prompt).toContain(
    "WORD=<the secret word>; FILES=<number of files>; FIRST=<alphabetically first file name>",
  );
});

test("a fixture's listing has random distinct names and one alphabetically first name", () => {
  const firsts = new Set();
  for (let round = 0; round < 20; round += 1) {
    const fixture = readonlyCapabilityFixture();
    expect(fixture.word).toMatch(/^word-[0-9a-f]{8}$/);
    expect(fixture.fileCount).toBeGreaterThanOrEqual(3);
    expect(fixture.fileCount).toBeLessThanOrEqual(6);
    expect(fixture.listing).toHaveLength(fixture.fileCount);
    expect(new Set(fixture.listing).size).toBe(fixture.fileCount);
    for (const name of fixture.listing) expect(name).toMatch(/^entry-[a-z]{8}\.txt$/);
    expect(fixture.firstName).toBe([...fixture.listing].sort()[0]);
    firsts.add(fixture.firstName);
  }
  // Random names: the first name differs from fixture to fixture, so it cannot be guessed.
  expect(firsts.size).toBeGreaterThan(1);
});

test("an answer passes only with the word, the exact count and the exact first name", () => {
  const facts = {
    word: "word-1a2b3c4d",
    fileCount: 4,
    firstName: "entry-bcdefgha.txt",
  };
  const pass = { wordFound: true, filesMatch: true, firstMatch: true };
  expect(
    evaluateReadonlyCapabilityAnswer(
      "WORD=word-1a2b3c4d; FILES=4; FIRST=entry-bcdefgha.txt",
      facts,
    ),
  ).toEqual(pass);
  // Markdown around the name and a closing period are formatting, not a different name.
  expect(
    evaluateReadonlyCapabilityAnswer(
      "WORD=word-1a2b3c4d; FILES=4; FIRST=`entry-bcdefgha.txt`.",
      facts,
    ),
  ).toEqual(pass);
  expect(evaluateReadonlyCapabilityAnswer("OK", facts)).toEqual({
    wordFound: false,
    filesMatch: false,
    firstMatch: false,
  });
  expect(evaluateReadonlyCapabilityAnswer(undefined, facts)).toEqual({
    wordFound: false,
    filesMatch: false,
    firstMatch: false,
  });
  expect(
    evaluateReadonlyCapabilityAnswer("WORD=unknown; FILES=4; FIRST=entry-bcdefgha.txt", facts),
  ).toEqual({ ...pass, wordFound: false });
  expect(
    evaluateReadonlyCapabilityAnswer(
      "WORD=word-1a2b3c4d; FILES=5; FIRST=entry-bcdefgha.txt",
      facts,
    ),
  ).toEqual({ ...pass, filesMatch: false });
});

test("a right count without the listing fails: FIRST must name the exact first file", () => {
  const facts = {
    word: "word-1a2b3c4d",
    fileCount: 4,
    firstName: "entry-bcdefgha.txt",
  };
  const guessed = { wordFound: true, filesMatch: true, firstMatch: false };
  expect(
    evaluateReadonlyCapabilityAnswer(
      "WORD=word-1a2b3c4d; FILES=4 (guess; listing unavailable)",
      facts,
    ),
  ).toEqual(guessed);
  expect(
    evaluateReadonlyCapabilityAnswer(
      "WORD=word-1a2b3c4d; FILES=4; FIRST=entry-zzzzzzzz.txt",
      facts,
    ),
  ).toEqual(guessed);
  expect(
    evaluateReadonlyCapabilityAnswer(
      "WORD=word-1a2b3c4d; FILES=4; FIRST=entry-bcdefgha.txt; FIRST=entry-zzzzzzzz.txt",
      facts,
    ),
  ).toEqual(guessed);
  // A caller that lost the first name never passes on an answer without one.
  expect(
    evaluateReadonlyCapabilityAnswer("WORD=word-1a2b3c4d; FILES=4", {
      word: facts.word,
      fileCount: 4,
    }).firstMatch,
  ).toBe(false);
});

test("a count that is not one plain integer fails", () => {
  const facts = {
    word: "word-1a2b3c4d",
    fileCount: 4,
    firstName: "entry-bcdefgha.txt",
  };
  for (const files of ["4.5", "4e0", "4,5", "four", "-4", ""]) {
    expect(
      evaluateReadonlyCapabilityAnswer(
        `WORD=word-1a2b3c4d; FILES=${files}; FIRST=entry-bcdefgha.txt`,
        facts,
      ).filesMatch,
    ).toBe(false);
  }
  expect(
    evaluateReadonlyCapabilityAnswer(
      "WORD=word-1a2b3c4d; FILES=4; FILES=5; FIRST=entry-bcdefgha.txt",
      facts,
    ).filesMatch,
  ).toBe(false);
});

test("the readonly capability request passes the shared run-start admission", () => {
  const root = mkdtempSync(join(tmpdir(), "claudexor-readonly-capability-"));
  fixtureRoots.push(root);
  const prompt = readonlyCapabilityPrompt({
    secretPath: join(root, "..", "secret.txt"),
    listingDir: join(root, "..", "listing"),
  });
  const rows = readonlyCapabilityRows({ agy: { profile: { profile_id: "fixture-agy" } } });
  for (const row of rows) {
    const request = readonlyCapabilityRequest({
      row,
      prompt,
      projectRoot: root,
      modelId: "fixture-model",
      maxUsd: "1.50",
    });
    const admitted = normalizeRunStartRequest(request);
    expect(admitted).toMatchObject({
      mode: "ask",
      access: "readonly",
      primaryHarness: row.harness,
      scope: { kind: "project", root },
    });
    expect(admitted.reviewerModels).toBeUndefined();
    if (row.profileId) expect(admitted.credentialProfileId).toBe(row.profileId);
    // The same body with the Agent-only reviewer models is what every row sent
    // before: the shared admission refuses it before any harness runs.
    expect(() => normalizeRunStartRequest(withBatteryReviewerModels(request))).toThrow(
      /reviewerModels only applies to agent runs/,
    );
  }
});
