/**
 * Credential surfaces: the managed secret store and INV-135 credential
 * profiles. Thin clients — the daemon owns storage and doctor probes; the
 * profile login spawns the SAME vendor command the setup jobs run, in this
 * interactive terminal, scoped to the profile's config dir.
 */
import { spawnSync } from "node:child_process";
import { registerConfigDirProfile } from "./profile-registration.js";
import {
  ControlCredentialProfileDeleteResponse,
  ControlCredentialProfileUpdateResponse,
  ControlCredentialProfilesResponse,
  ControlSecretListResponse,
  ControlSecretMutationResponse,
  ControlSecretSetRequest,
} from "@claudexor/schema";
import { controlProblemError } from "@claudexor/control-api";
import { MANAGED_SECRET_NAMES, isManagedSecretName } from "@claudexor/secrets";
import { canonicalProfileConfigDir } from "@claudexor/harness-claude";
import { canonicalCodexProfileHome } from "@claudexor/harness-codex";
import { type ParsedArgs, flagStr } from "./args.js";
import { print, printCliFailure, printJson, printUsageError } from "./cli-io.js";
import { ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { daemonGet } from "./ops-commands.js";
import { nativeLoginEnv, nativeLoginSpec } from "./native-login.js";

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Thin client over the daemon's credential-profile listing (INV-135): the
 * durable registry lives in the global config; readiness is the daemon
 * doctor's projection — this command never probes vendors itself.
 */
export async function profilesCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "list";
  if (sub === "login") {
    // INV-135 profile login: the SAME vendor login command the setup jobs run,
    // spawned interactively in THIS terminal with the profile's scoped config
    // dir. The default vendor store is never touched; the doctor probe after
    // exit is the verification truth.
    const harness = args._[2];
    const profileId = args._[3];
    if (!harness || !profileId) {
      return printUsageError(json, "usage: claudexor profiles login <harness> <profile-id>");
    }
    if (json) {
      return printUsageError(true, "profiles login is interactive and does not support --json", {
        fallbackCode: "interactive_json_unsupported",
        context: { harness, profileId },
      });
    }
    const listing = ControlCredentialProfilesResponse.parse(
      await daemonGet("/credential-profiles"),
    );
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
    // Only harnesses with a RELOCATABLE config-dir login may profile-login
    // (release wave tier1 #1): cursor's native login is a singleton keychain
    // store — running it here would mutate the operator's real credentials
    // while claiming profile isolation.
    if (harness !== "claude" && harness !== "codex") {
      return printUsageError(
        json,
        `harness "${harness}" has no isolated config-dir login; only claude and codex profiles can log in here`,
      );
    }
    const spec = nativeLoginSpec(harness);
    if (!spec) {
      return printUsageError(json, `no native login command for harness "${harness}"`);
    }
    const configDir =
      harness === "claude"
        ? canonicalProfileConfigDir(profile.isolation_locator ?? "")
        : canonicalCodexProfileHome(profile.isolation_locator ?? "");
    print(`running ${spec.displayCommand} into ${configDir}`);
    const child = spawnSync(spec.binary, spec.args, {
      stdio: "inherit",
      env: nativeLoginEnv(harness, process.env, configDir),
    });
    if (child.status !== 0) {
      print(`login command exited with ${child.status ?? child.signal ?? "unknown"}`);
    }
    const after = ControlCredentialProfilesResponse.parse(
      await daemonGet("/credential-profiles"),
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
    // refused loudly, login dir created under the confinement root.
    const harness = args._[2];
    const profileId = args._[3];
    if (!harness || !profileId) {
      return printUsageError(
        json,
        "usage: claudexor profiles add <claude|codex> <profile-id> [--display-name NAME]",
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
      const status =
        err && typeof err === "object" && "status" in err
          ? (err as { status?: unknown }).status
          : undefined;
      if (status === 400 || status === 409) {
        return printUsageError(json, err, {
          fallbackCode: "invalid_credential_profile",
          context: { harness, profileId, operation: "add" },
        });
      }
      return printCliFailure(json, err, {
        category: "operational",
        fallbackCode: "credential_profile_registration_failed",
        prefix: "claudexor profiles add: ",
        context: { harness, profileId, operation: "add" },
      });
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
          Authorization: `Bearer ${addr.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: sub === "enable" }),
      },
    );
    const body = await responseBody(response);
    if (!response.ok) {
      return printCliFailure(json, controlProblemError(response.status, body), {
        fallbackCode: "credential_profile_update_failed",
        prefix: `claudexor profiles ${sub}: `,
        context: { harness, profileId, operation: sub },
      });
    }
    const receipt = ControlCredentialProfileUpdateResponse.parse(body);
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
    // own credential material (scoped login dir / namespaced secret); refuses
    // while a login job for the account is active.
    const { addr } = await ensureDaemon();
    const response = await controlApiFetch(
      addr,
      `/credential-profiles/${encodeURIComponent(harness)}/${encodeURIComponent(profileId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${addr.token}` } },
    );
    const body = await responseBody(response);
    if (!response.ok) {
      return printCliFailure(json, controlProblemError(response.status, body), {
        fallbackCode: "credential_profile_remove_failed",
        prefix: "claudexor profiles remove: ",
        context: { harness, profileId, operation: "remove" },
      });
    }
    const receipt = ControlCredentialProfileDeleteResponse.parse(body);
    if (json) printJson(receipt);
    else {
      print(`removed ${harness}/${profileId} (${receipt.credentialCleanup})`);
      if (receipt.cleanupWarning) print(`warning: ${receipt.cleanupWarning}`);
    }
    return 0;
  }
  if (sub !== "list") {
    return printUsageError(
      json,
      "usage: claudexor profiles [list | add <harness> <profile-id> | login <harness> <profile-id> | enable <harness> <profile-id> | disable <harness> <profile-id> | remove <harness> <profile-id>]",
    );
  }
  const result = ControlCredentialProfilesResponse.parse(await daemonGet("/credential-profiles"));
  if (json) {
    printJson(result);
    return 0;
  }
  // Symmetric accounts rows (INV-135, D25): per harness, every credential
  // profile (the Enabled toggle — the only routing control) plus the native
  // "CLI login" row, and an informational "next up" line naming who an unpinned
  // run would route to. The server owns native/next-up truth — this surface
  // never re-derives it.
  const byHarness = new Map<string, Array<(typeof result.profiles)[number]>>();
  for (const entry of result.profiles) {
    const list = byHarness.get(entry.profile.harness_id) ?? [];
    list.push(entry);
    byHarness.set(entry.profile.harness_id, list);
  }
  const harnessIds = [
    ...new Set([...result.harnessAccounts.map((h) => h.harness_id), ...byHarness.keys()]),
  ].sort();
  if (harnessIds.length === 0) {
    print(
      "no accounts (add credential_profiles entries to the global config, or log in a harness)",
    );
    return 0;
  }
  for (const harnessId of harnessIds) {
    const authority = result.harnessAccounts.find((h) => h.harness_id === harnessId);
    print(`${harnessId}:`);
    // The native "CLI login" pseudo-row: same Enabled toggle, no Delete.
    const nativeEnabled = authority?.native_credentials_enabled ?? true;
    const nativeState = !nativeEnabled
      ? "disabled"
      : authority?.native_login_detected
        ? "logged-in"
        : "not-logged-in";
    print(`  CLI login [native] ${nativeState}`);
    for (const { profile, status } of byHarness.get(harnessId) ?? []) {
      const state = profile.enabled ? status.availability : "disabled";
      print(
        `  ${profile.profile_id} [${profile.credential_kind}] ${state}${status.detail ? ` — ${status.detail}` : ""}`,
      );
    }
    // Informational: who an UNPINNED run routes to next (never a user setting).
    const nextUp = authority?.next_up;
    if (nextUp?.kind === "native") print(`  next up: CLI login [native]`);
    else if (nextUp?.kind === "profile") print(`  next up: ${nextUp.profileId}`);
    else if (nextUp?.kind === "none") print(`  next up: nothing routable (${nextUp.reason})`);
  }
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
      headers: { Authorization: `Bearer ${addr.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const responsePayload = await responseBody(response);
    if (!response.ok) {
      return printCliFailure(json, controlProblemError(response.status, responsePayload), {
        fallbackCode: "secret_write_failed",
        prefix: "claudexor secrets set: ",
        context: { name, operation: "set" },
      });
    }
    const receipt = ControlSecretMutationResponse.parse(responsePayload);
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
      headers: { Authorization: `Bearer ${addr.token}` },
    });
    const responsePayload = await responseBody(response);
    if (!response.ok) {
      return printCliFailure(json, controlProblemError(response.status, responsePayload), {
        fallbackCode: "secret_delete_failed",
        prefix: "claudexor secrets delete: ",
        context: { name, operation: "delete" },
      });
    }
    const receipt = ControlSecretMutationResponse.parse(responsePayload);
    if (json) printJson(receipt);
    else print(`deleted ${name}`);
    return 0;
  }
  return printUsageError(json, "usage: claudexor secrets list|set|delete");
}
