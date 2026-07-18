/**
 * Credential surfaces: the managed secret store and INV-135 credential
 * profiles. Thin clients — the daemon owns storage and doctor probes; the
 * profile login spawns the SAME vendor command the setup jobs run, in this
 * interactive terminal, scoped to the profile's config dir.
 */
import { spawnSync } from "node:child_process";
import { registerConfigDirProfile } from "./profile-registration.js";
import {
  ControlCredentialProfilesResponse,
  ControlSecretListResponse,
  ControlSecretMutationResponse,
  ControlSecretSetRequest,
} from "@claudexor/schema";
import { MANAGED_SECRET_NAMES, isManagedSecretName } from "@claudexor/secrets";
import { canonicalProfileConfigDir } from "@claudexor/harness-claude";
import { canonicalCodexProfileHome } from "@claudexor/harness-codex";
import { type ParsedArgs, flagStr } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { daemonGet } from "./ops-commands.js";
import { nativeLoginEnv, nativeLoginSpec } from "./native-login.js";

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
      return printUsageError(json, err instanceof Error ? err.message : String(err));
    }
  }
  if (sub !== "list") {
    return printUsageError(
      json,
      "usage: claudexor profiles [list | add <harness> <profile-id> | login <harness> <profile-id>]",
    );
  }
  const result = ControlCredentialProfilesResponse.parse(await daemonGet("/credential-profiles"));
  if (json) printJson(result);
  else if (result.profiles.length === 0) {
    print(
      "no credential profiles registered (add credential_profiles entries to the global config)",
    );
  } else {
    for (const { profile, status } of result.profiles) {
      const state = profile.enabled ? status.availability : "disabled";
      print(
        `${profile.harness_id}/${profile.profile_id} [${profile.credential_kind}] ${state}${status.detail ? ` — ${status.detail}` : ""}`,
      );
    }
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
      headers: { Authorization: `Bearer ${addr.token}` },
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
