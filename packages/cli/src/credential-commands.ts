import { interpretedCommand } from "@claudexor/core";
/**
 * Credential surfaces: the managed secret store and INV-135 credential
 * profiles. Thin clients — the daemon owns storage and doctor probes; the
 * Cursor profile login uses the daemon setup lifecycle in this terminal;
 * Claude/AGY retain their direct scoped vendor login. Codex uses device code.
 */
import { spawnSync } from "node:child_process";
import { registerConfigDirProfile } from "./profile-registration.js";
import { readRoutingEvidence, routingEvidenceLines } from "./account-routing-read.js";
import {
  ControlAccountsMigrationRollbackResponse,
  ControlCredentialProfileDeleteResponse,
  ControlCredentialProfileUpdateResponse,
  ControlCredentialProfilesResponse,
  ControlCredentialProfilesSnapshotResponse,
  ControlSecretListResponse,
  ControlSecretMutationResponse,
  ControlSecretSetRequest,
  ControlSetupJob,
} from "@claudexor/schema";
import { streamDurableLogin } from "./setup-login-inline.js";
import { terminalLoginFallback } from "./setup-login-fallback.js";
import { MANAGED_SECRET_NAMES, isManagedSecretName } from "@claudexor/secrets";
import {
  CONFIG_DIR_LOGIN_HARNESSES,
  canonicalProfileLoginDir,
  configDirLoginHarnessList,
  isConfigDirLoginHarness,
} from "./config-dir-login-harnesses.js";
import { type ParsedArgs, flagStr } from "./args.js";
import { print, printJson, printUsageError, quotaRefreshLabel } from "./cli-io.js";
import { ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { daemonGet } from "./ops-commands.js";
import { type ProfileLoginAttachDeps, profileLoginViaSetupJob } from "./profile-login-attach.js";
import { nativeLoginEnv, nativeLoginSpec } from "./native-login.js";
import { isAgyProfileKeychainUnsafe, prepareAgyProfileKeychain } from "@claudexor/harness-agy";
import { credentialProfilePolicyProblem, credentialProfilePolicyState } from "@claudexor/core";
import { buildRegistry } from "./registry.js";
import { CliError, renderCliFailure } from "./cli-error.js";

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/**
 * Thin client over the daemon's credential-profile listing (INV-135): the
 * durable registry lives in the global config; readiness is the daemon
 * doctor's projection — this command never probes vendors itself.
 */
export async function profilesCommand(args: ParsedArgs, json: boolean): Promise<number> {
  return profilesCommandWithDeps(args, json);
}

/**
 * Read-only agent doorway over the server-owned atomic Accounts snapshot.
 * Unlike `profiles`, this never mutates or starts authentication and never
 * rebuilds routing facts on the client. The daemon's snapshot is the SSOT for
 * readiness, quota freshness, and `next_up`.
 */
export async function accountsCommand(args: ParsedArgs, json: boolean): Promise<number> {
  return accountsCommandWithDeps(args, json);
}

export interface AccountsCommandDeps {
  daemonGet?: typeof daemonGet;
}

export async function accountsCommandWithDeps(
  args: ParsedArgs,
  json: boolean,
  deps: AccountsCommandDeps = {},
): Promise<number> {
  const sub = args._[1];
  if (sub !== undefined && sub !== "snapshot") {
    return printUsageError(json, "usage: claudexor accounts [snapshot] [--json]");
  }
  const get = deps.daemonGet ?? daemonGet;
  const snapshot = ControlCredentialProfilesSnapshotResponse.parse(
    await get("/credential-profiles?snapshot=true"),
  );
  const evidence = await readRoutingEvidence(get);
  if (json) {
    printJson({ ...snapshot, ...evidence });
    return 0;
  }
  print(`Accounts snapshot: quota cursor ${snapshot.quotaEventCursor}`);
  print(`  quota refreshed_at: ${snapshot.quota.refreshed_at ?? "unknown"}`);
  for (const skip of snapshot.quota.refresh_skipped ?? []) {
    print(
      `  quota refresh skipped for ${quotaRefreshLabel(skip)}: rate-limit cooldown until ${skip.not_before}`,
    );
  }
  print(`  git: ${snapshot.git.status}`);
  if (snapshot.profiles.length === 0) {
    print("  no registered credential profiles");
  } else {
    for (const { profile, status, identity } of snapshot.profiles) {
      const state = profile.enabled ? status.availability : "disabled";
      const principal = identity?.email ? ` (${identity.email})` : "";
      print(`  ${profile.harness_id}/${profile.profile_id}: ${state}${principal}`);
      if (status.detail) print(`    ${status.detail}`);
      for (const line of routingEvidenceLines(evidence, profile.harness_id, profile.profile_id))
        print(`    ${line}`);
    }
  }
  // next_up is the configured DEFAULT model's verdict, never another model's forecast.
  for (const pool of snapshot.accountPools) {
    const next = pool.next_up;
    const label =
      next.kind === "profile"
        ? next.profileId
        : next.kind === "api_key_route"
          ? "API key route"
          : `none (${next.reason})`;
    print(`  next up (default model) ${pool.harness_id}: ${label}`);
  }
  if (evidence.routingEvidenceProblem) print(`  ${evidence.routingEvidenceProblem}`);
  return 0;
}

export interface ProfilesCommandDeps extends Partial<ProfileLoginAttachDeps> {
  daemonGet?: typeof daemonGet;
  spawnSync?: typeof spawnSync;
  platform?: NodeJS.Platform;
  prepareAgyProfileKeychain?: (home: string) => void;
}

/** Injectable only at the process/vendor boundary so policy ordering has a
 * zero-spawn regression test without contacting a daemon or vendor. */
export async function profilesCommandWithDeps(
  args: ParsedArgs,
  json: boolean,
  deps: ProfilesCommandDeps = {},
): Promise<number> {
  const get = deps.daemonGet ?? daemonGet;
  const spawnVendor = deps.spawnSync ?? spawnSync;
  const sub = args._[1] ?? "list";
  if (sub === "login") {
    // INV-135 profile login: the SAME vendor login command the setup jobs run,
    // spawned interactively in THIS terminal with the profile's scoped state.
    // Some platforms keep the vendor credential at OS-user scope; the doctor
    // probe after exit is the verification truth.
    const harness = args._[2];
    const profileId = args._[3];
    if (!harness || !profileId) {
      return printUsageError(json, "usage: claudexor profiles login <harness> <profile-id>");
    }
    const listing = ControlCredentialProfilesResponse.parse(await get("/credential-profiles"));
    // The listing is the canonical registry projection. Apply the same static
    // platform/cardinality gate as setup jobs before emitting interactive
    // prose, spawning a vendor, or contacting any vendor surface. This closes
    // the direct profile-login bypass without changing the valid TTY flow.
    const adapter = buildRegistry({ includeFakes: false }).get(harness);
    if (adapter) {
      const state = credentialProfilePolicyState({
        adapter,
        registry: listing.profiles.map((row) => row.profile),
        platform: deps.platform,
      });
      if (state.ambiguous) {
        const problem = credentialProfilePolicyProblem(state, "credential_profile_ambiguous");
        return renderCliFailure(
          json,
          new CliError("operational", problem.message, {
            code: problem.code,
            retryable: problem.retryable,
            fieldErrors: problem.fieldErrors,
            requiredActions: problem.requiredActions,
            context: problem.context,
          }),
        );
      }
    }
    // Non-Codex profile login is deliberately the vendor's interactive TTY
    // flow. Refuse JSON only after the static registry policy above so JSON
    // cannot bypass the same typed ambiguity disposition as human mode.
    if (json && harness !== "codex") {
      return printUsageError(
        true,
        `claudexor profiles login ${harness} is interactive and does not support --json`,
      );
    }
    const entry = listing.profiles.find(
      (p) => p.profile.harness_id === harness && p.profile.profile_id === profileId,
    );
    if (!entry) {
      return printUsageError(
        json,
        `no credential profile "${profileId}" for harness "${harness}" (register it in the global config's credential_profiles)`,
      );
    }
    const profile = entry.profile;
    if (!profile.enabled) return printUsageError(json, `profile "${profileId}" is disabled`);
    if (profile.credential_kind !== "config_dir_login") {
      return printUsageError(
        json,
        `profile "${profileId}" is ${profile.credential_kind}; only config_dir_login profiles have a login flow (store its secret instead)`,
      );
    }
    // Only harnesses with a RELOCATABLE native login may profile-login.
    if (!isConfigDirLoginHarness(harness)) {
      return printUsageError(
        json,
        `harness "${harness}" has no isolated config-dir login; only ${configDirLoginHarnessList()} profiles can log in here`,
      );
    }
    // D-17: codex profile login rides the SAME durable setup job as the default
    // store (no more spawnSync bypass) — the device-code flow with inline code
    // display, scoped to the profile's CODEX_HOME. The daemon owns the flow and
    // its doctor-probe verification (INV-135).
    if (harness === "codex") {
      const { addr } = await ensureDaemon();
      const response = await controlApiFetch(addr, "/setup/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          harness,
          action: "login",
          authRequest: "subscription",
          profileId,
        }),
      });
      if (!response.ok) {
        return printUsageError(
          json,
          `could not start codex profile login (${response.status}): ${await response.text()}`,
        );
      }
      const job = ControlSetupJob.parse(await response.json());
      const accepted = !["failed", "cancelled", "timed_out", "not_supported"].includes(job.state);
      // D-17 audit point 8: follow the durable device-code job to its outcome
      // and, on the typed device_auth_unsupported miss, OFFER the legacy
      // Terminal fallback SCOPED to this profile (a y/N prompt on a TTY, a typed
      // `nextAction` in `--json`) — the same one-action fork as the default store.
      if (accepted) {
        if (!json) print(`codex/${profileId} login is managed by claudexord as ${job.jobId}.`);
        return streamDurableLogin(addr, job.jobId, {
          label: `codex/${profileId}`,
          json,
          resumeCommand: `claudexor profiles login codex ${profileId}`,
          fallback: { harness: "codex" },
        });
      }
      if (json) {
        const nextAction = terminalLoginFallback(job);
        printJson({ ok: false, job, ...(nextAction ? { nextAction } : {}) });
        return 1;
      }
      print(`codex/${profileId} login was not started: ${job.message}`);
      return 1;
    }
    // Cursor and Grok share the setup owner and its cache invalidation. Other
    // interactive profile-login paths retain their existing vendor terminal.
    if (harness === "cursor" || harness === "grok") {
      return profileLoginViaSetupJob(
        {
          harness,
          profileId,
          json,
          statusLine: async () => {
            const after = ControlCredentialProfilesResponse.parse(
              await get("/credential-profiles"),
            ).profiles.find(
              (p) => p.profile.harness_id === harness && p.profile.profile_id === profileId,
            );
            const status = after?.status;
            return `${harness}/${profileId}: ${status?.availability ?? "unknown"}${status?.detail ? ` — ${status.detail}` : ""}`;
          },
        },
        { ...deps, ensureDaemon: deps.ensureDaemon ?? ensureDaemon },
      );
    }
    const spec = nativeLoginSpec(harness);
    if (!spec) {
      return printUsageError(json, `no native login command for harness "${harness}"`);
    }
    const configDir = canonicalProfileLoginDir(harness, profile.isolation_locator ?? "");
    if (harness === "agy") {
      try {
        (
          deps.prepareAgyProfileKeychain ??
          ((home: string) => prepareAgyProfileKeychain(home, { platform: deps.platform }))
        )(configDir);
      } catch (error) {
        if (isAgyProfileKeychainUnsafe(error)) {
          return printUsageError(json, error instanceof Error ? error.message : String(error));
        }
        // A custom operational seam may model a recoverable security-tool
        // miss; path and identity failures remain unsafe above.
      }
    }
    if (spec.launchAdvisory) print(spec.launchAdvisory);
    print(`running ${spec.displayCommand} into ${configDir}`);
    const invocation = interpretedCommand(
      spec.binary,
      spec.args,
      nativeLoginEnv(harness, process.env, configDir),
      spec.interpreter,
    );
    const child = spawnVendor(invocation.binary, invocation.args, {
      stdio: "inherit",
      env: invocation.env,
    });
    if (child.status !== 0) {
      print(`login command exited with ${child.status ?? child.signal ?? "unknown"}`);
    }
    const after = ControlCredentialProfilesResponse.parse(
      await get("/credential-profiles"),
    ).profiles.find((p) => p.profile.harness_id === harness && p.profile.profile_id === profileId);
    const status = after?.status;
    if (json) printJson({ profile: after?.profile ?? profile, status: status ?? null });
    else
      print(
        `${harness}/${profileId}: ${status?.availability ?? "unknown"}${status?.detail ? ` — ${status.detail}` : ""}`,
      );
    return status?.verification === "passed" ? 0 : 1;
  }
  if (sub === "add") {
    // ONE registration owner shared with POST /v2/credential-profiles
    // (profile-registration.ts): locked global-config write, duplicate ids
    // refused loudly, login dir created under the engine-owned state root.
    const harness = args._[2];
    const profileId = args._[3];
    if (!harness || !profileId) {
      return printUsageError(
        json,
        `usage: claudexor profiles add <${CONFIG_DIR_LOGIN_HARNESSES.join("|")}> <profile-id> [--display-name NAME]`,
      );
    }
    try {
      const { profile, configPath } = registerConfigDirProfile({
        harnessId: harness,
        profileId,
        displayName: flagStr(args, "display-name"),
      });
      if (json)
        printJson({
          registered: { harness, profileId, locator: profile.isolation_locator },
          config: configPath,
        });
      else {
        print(`registered ${harness}/${profileId} (login dir ${profile.isolation_locator})`);
        print(`next: claudexor profiles login ${harness} ${profileId}`);
      }
      return 0;
    } catch (err) {
      return printUsageError(json, err instanceof Error ? err.message : String(err));
    }
  }
  if (sub === "enable" || sub === "disable") {
    // The Enabled toggle of the accounts symmetry (INV-135): PATCH the
    // profile's durable `enabled` via the daemon (one locked write).
    const harness = args._[2];
    const profileId = args._[3];
    if (!harness || !profileId) {
      return printUsageError(json, `usage: claudexor profiles ${sub} <harness> <profile-id>`);
    }
    const { addr } = await ensureDaemon();
    const response = await controlApiFetch(
      addr,
      `/credential-profiles/${encodeURIComponent(harness)}/${encodeURIComponent(profileId)}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: sub === "enable" }),
      },
    );
    if (!response.ok) {
      return printUsageError(
        json,
        `profile ${sub} failed (${response.status}): ${await response.text()}`,
      );
    }
    const receipt = ControlCredentialProfileUpdateResponse.parse(await response.json());
    if (json) printJson(receipt);
    else
      print(
        `${sub}d ${harness}/${profileId} (${receipt.profile.enabled ? "enabled" : "disabled"})`,
      );
    return 0;
  }
  if (sub === "remove" || sub === "rm") {
    const harness = args._[2];
    const profileId = args._[3];
    if (!harness || !profileId) {
      return printUsageError(json, "usage: claudexor profiles remove <harness> <profile-id>");
    }
    // Daemon-owned removal (one mutation path): registry entry + the profile's
    // binding plus data Claudexor owns; vendor-owned OS-user credentials are
    // reported explicitly and left untouched. Active login jobs still refuse.
    const { addr } = await ensureDaemon();
    const response = await controlApiFetch(
      addr,
      `/credential-profiles/${encodeURIComponent(harness)}/${encodeURIComponent(profileId)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      return printUsageError(
        json,
        `profile removal failed (${response.status}): ${await response.text()}`,
      );
    }
    const receipt = ControlCredentialProfileDeleteResponse.parse(await response.json());
    if (json) printJson(receipt);
    else {
      print(`removed ${harness}/${profileId} (${receipt.credentialCleanup})`);
      if (receipt.vendorCredentialDisposition) {
        print(
          "Claudexor removed the binding and any Claudexor-owned state or managed secret; it did not change any vendor credential for this OS user.",
        );
      }
      if (receipt.cleanupWarning) print(`warning: ${receipt.cleanupWarning}`);
    }
    return 0;
  }
  if (sub === "rollback-migration") {
    // The supported downgrade path of the unified-accounts startup migration:
    // sessions/checkpoints/lane homes return to the engine-default keys and
    // the auto-registered row leaves the registry. Run BEFORE installing an
    // engine whose canonicalizers refuse the migrated row's native locator.
    const harness = args._[2];
    const { addr } = await ensureDaemon();
    const response = await controlApiFetch(addr, "/accounts-migration/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(harness ? { harnessId: harness } : {}),
    });
    if (!response.ok) {
      return printUsageError(
        json,
        `migration rollback failed (${response.status}): ${await response.text()}`,
      );
    }
    const receipt = ControlAccountsMigrationRollbackResponse.parse(await response.json());
    if (json) printJson(receipt);
    else if (receipt.rolledBack.length === 0) print("nothing to roll back (no migrated harness)");
    else {
      for (const entry of receipt.rolledBack) {
        print(
          `rolled back ${entry.harness_id} (row ${entry.row_id}): ${entry.sessions} sessions, ${entry.checkpoints} checkpoints, ${entry.lanes} lane homes`,
        );
        if (entry.skipped_partitions.length > 0) {
          print(
            `warning: quarantined partition(s) not rolled back: ${entry.skipped_partitions.join(", ")} — recover them and rerun before downgrading`,
          );
        }
      }
    }
    return 0;
  }
  if (sub !== "list") {
    return printUsageError(
      json,
      "usage: claudexor profiles [list | add <harness> <profile-id> | login <harness> <profile-id> | enable <harness> <profile-id> | disable <harness> <profile-id> | remove <harness> <profile-id> | rollback-migration [harness]]",
    );
  }
  const result = ControlCredentialProfilesResponse.parse(await get("/credential-profiles"));
  const evidence = await readRoutingEvidence(get);
  if (json) {
    printJson({ ...result, ...evidence });
    return 0;
  }
  // Unified account model (INV-135): every account is a named registry row
  // with an Enabled toggle (the only routing control); routing facts come from
  // the server-owned accountPools projection. This surface never re-derives
  // pool truth, and there is no separate native/CLI-login pseudo-row.
  const byHarness = new Map<string, Array<(typeof result.profiles)[number]>>();
  for (const entry of result.profiles) {
    const list = byHarness.get(entry.profile.harness_id) ?? [];
    list.push(entry);
    byHarness.set(entry.profile.harness_id, list);
  }
  const harnessIds = [
    ...new Set([...result.accountPools.map((pool) => pool.harness_id), ...byHarness.keys()]),
  ].sort();
  if (harnessIds.length === 0) {
    print("no accounts (connect one with `claudexor auth login <harness>`)");
    return 0;
  }
  for (const harnessId of harnessIds) {
    print(`${harnessId}:`);
    const rows = byHarness.get(harnessId) ?? [];
    if (rows.length === 0) print("  (no accounts)");
    for (const { profile, status } of rows) {
      const state = profile.enabled ? status.availability : "disabled";
      print(
        `  ${profile.profile_id} [${profile.credential_kind}] ${state}${status.detail ? ` — ${status.detail}` : ""}`,
      );
      for (const line of routingEvidenceLines(evidence, harnessId, profile.profile_id))
        print(`    ${line}`);
    }
    // Informational: who an UNPINNED run of the configured DEFAULT model routes
    // to next (never a user setting, never a forecast for another model).
    const nextUp = result.accountPools.find((pool) => pool.harness_id === harnessId)?.next_up;
    if (nextUp?.kind === "profile") print(`  next up (default model): ${nextUp.profileId}`);
    else if (nextUp?.kind === "api_key_route")
      print(`  next up (default model): API key (paid route)`);
    else if (nextUp?.kind === "none")
      print(`  next up (default model): nothing routable (${nextUp.reason})`);
  }
  if (evidence.routingEvidenceProblem) print(evidence.routingEvidenceProblem);
  return 0;
}

export async function secretsCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "list";
  if (sub === "list") {
    const result = ControlSecretListResponse.parse(await daemonGet("/secrets"));
    if (json) printJson(result);
    else {
      if (result.secrets.length === 0) print(`no stored secrets (${result.backend})`);
      for (const secret of result.secrets) print(`${secret.name} [${secret.backend}]`);
    }
    return 0;
  }
  if (sub === "set") {
    const name = args._[2];
    if (!name) {
      return printUsageError(
        json,
        "usage: claudexor secrets set <name> --from-env <ENV_VAR>  # or pipe value on stdin",
      );
    }
    if (!isManagedSecretName(name)) {
      return printUsageError(
        json,
        `secret name must be a managed name (${MANAGED_SECRET_NAMES.join(", ")}) or a managed base:profile slot (e.g. claude_oauth:work — profiles REQUIRE the namespaced form)`,
      );
    }
    const envVar = flagStr(args, "from-env");
    const value = envVar ? process.env[envVar] : process.stdin.isTTY ? "" : await stdinText();
    if (!value) {
      return printUsageError(
        json,
        "secret value required via --from-env or stdin; values are not accepted as positional args",
      );
    }
    const body = ControlSecretSetRequest.parse({ name, value });
    const { addr } = await ensureDaemon();
    const response = await controlApiFetch(addr, "/secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(`secret write failed (${response.status}): ${await response.text()}`);
    const receipt = ControlSecretMutationResponse.parse(await response.json());
    if (json) printJson(receipt);
    else {
      print(`stored ${name} in ${receipt.backend}`);
      if (receipt.warning) print(`warning: ${receipt.warning}`);
    }
    return 0;
  }
  if (sub === "delete" || sub === "rm") {
    const name = args._[2];
    if (!name) {
      return printUsageError(json, "usage: claudexor secrets delete <name>");
    }
    if (!isManagedSecretName(name)) {
      return printUsageError(
        json,
        `secret name must be a managed name (${MANAGED_SECRET_NAMES.join(", ")}) or a managed base:profile slot (e.g. claude_oauth:work — profiles REQUIRE the namespaced form)`,
      );
    }
    const { addr } = await ensureDaemon();
    const response = await controlApiFetch(addr, `/secrets/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    if (!response.ok)
      throw new Error(`secret delete failed (${response.status}): ${await response.text()}`);
    const receipt = ControlSecretMutationResponse.parse(await response.json());
    if (json) printJson(receipt);
    else print(`deleted ${name}`);
    return 0;
  }
  return printUsageError(json, "usage: claudexor secrets list|set|delete");
}
