/** The host changes of the Linux Codex app-server probe, wired to recorded `sudo` runs: the two
 * AppArmor phase controls (Ubuntu noble's packaged bwrap-userns-restrict, installed the
 * documented way; the prior minimal per-binary profile, loaded from a file for one comparison)
 * and the daemon cells' provider route (Codex's system config layer). Each change persists its
 * restore record before it touches the host, so `restoreRecorded` can undo a run that died. */
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyProfile,
  DISTRO_PROFILE,
  loadedNamed,
  loadProfileFile,
  profileNames,
  restoreProfile,
} from "./apparmor-profile-control.mjs";
import {
  applySystemConfig,
  restoreSystemConfig,
  systemConfigInstalled,
} from "./codex-system-config-control.mjs";
import { fileState, json, recorded } from "./linux-codex-appserver-host.mjs";
import {
  APPARMOR_PROFILES,
  hostState,
  MINIMAL_BWRAP_PROFILE,
  SYSTEM_BWRAP,
  USERNS_RESTRICTION,
} from "./linux-codex-appserver-phases.mjs";
import { providerConfigToml } from "./scripted-responses-provider.mjs";

const RECORDS = {
  distro: ["phases", "distro-profile", "apply-record.json"],
  minimal: ["phases", "minimal-profile", "apply-record.json"],
  route: ["codex-system-config", "apply-record.json"],
};
const MINIMAL_FILE = ["phases", "minimal-profile", "bwrap-minimal.apparmor"];

/** Effects of a profile control, shared by `run` and the separate `restore`. */
function profileEffects(out, dir, record) {
  let reads = 0;
  return {
    fileState,
    readBytes: (path) => readFileSync(path),
    saveBackup: (bytes) => {
      const path = join(dir, "prior-installed-profile.bak");
      writeFileSync(path, bytes);
      return path;
    },
    sudo: (step, args) => recorded(dir, step, "sudo", args),
    // Every read keeps its own record.
    loadedProfiles: () => {
      reads += 1;
      const read = recorded(dir, `profiles-read-${reads}`, "sudo", [
        "-n",
        "cat",
        APPARMOR_PROFILES,
      ]);
      return hostState({}, read).profiles;
    },
    persist: (value) => json(join(out, ...RECORDS[record]), value),
  };
}

/** `controls` for runPhases. Both need the restriction on, neither profile name loaded and
 * the managed PATH selecting /usr/bin/bwrap, the file both profiles attach to. */
export function phaseControls({ out, distro, selectedBwrap }) {
  const minimalFile = join(out, ...MINIMAL_FILE);
  json(join(out, "phases", "minimal-profile", "sha256.json"), {
    sha256: createHash("sha256").update(MINIMAL_BWRAP_PROFILE).digest("hex"),
  });
  writeFileSync(minimalFile, MINIMAL_BWRAP_PROFILE);
  const names = { distro: distro.names, minimal: profileNames(MINIMAL_BWRAP_PROFILE) };
  const preconditions = (phase, before) => [
    ...(before.sysctl[USERNS_RESTRICTION] === "1"
      ? []
      : [`${USERNS_RESTRICTION} is ${before.sysctl[USERNS_RESTRICTION]}, not 1`]),
    ...loadedNamed(before.profiles, [...new Set([...names.distro, ...names.minimal])]).map(
      (line) => `already loaded: ${line}`,
    ),
    ...(selectedBwrap?.realpath === SYSTEM_BWRAP
      ? []
      : [`the managed PATH selects ${selectedBwrap?.realpath ?? "no bwrap"}, not ${SYSTEM_BWRAP}`]),
  ];
  const effects = (phase, control) => profileEffects(out, join(out, "phases", phase), control);
  return {
    distro: {
      expected: { names: names.distro, sha256: DISTRO_PROFILE.sha256 },
      preconditions,
      apply: (phase) =>
        applyProfile({
          ...effects(phase, "distro"),
          pinnedFile: distro.file,
          installPath: DISTRO_PROFILE.installPath,
        }),
      restore: (phase, applied, before) =>
        restoreProfile({
          ...effects(phase, "distro"),
          pinnedFile: distro.file,
          names: names.distro,
          applied: applied ?? {
            installPath: DISTRO_PROFILE.installPath,
            before: before.installFile,
            backup: null,
          },
        }),
    },
    minimal: {
      expected: { names: names.minimal, sha256: null },
      preconditions,
      apply: (phase) => loadProfileFile({ ...effects(phase, "minimal"), profileFile: minimalFile }),
      restore: (phase, applied) =>
        restoreProfile({
          ...effects(phase, "minimal"),
          pinnedFile: minimalFile,
          names: names.minimal,
          applied: applied ?? { installPath: null, before: null, backup: null },
        }),
    },
  };
}

/** Where the daemon cells' provider port is taken from: below Linux's default ephemeral range
 * (32768-60999), so no outgoing connection can be holding it as its source port later. */
export const PROVIDER_PORTS = { first: 24337, last: 24999 };

function bindable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** The first loopback port in PROVIDER_PORTS free right now, for the daemon cells' provider
 * and the system config that names it. */
export async function freeLoopbackPort({ first, last } = PROVIDER_PORTS) {
  for (let port = first; port <= last; port += 1) if (await bindable(port)) return port;
  throw new Error(`no free loopback port in ${first}-${last}`);
}

function routeEffects(out) {
  const dir = join(out, "codex-system-config");
  return {
    dir,
    fileState,
    sudo: (step, args) => recorded(dir, step, "sudo", args),
    persist: (value) => json(join(out, ...RECORDS.route), value),
  };
}

/** Installs Codex's system config naming the loopback provider on `port`. */
export function installProviderRoute({ out, port }) {
  const effects = routeEffects(out);
  const toml = providerConfigToml({ baseUrl: `http://127.0.0.1:${port}/v1` });
  const configFile = join(effects.dir, "config.toml");
  json(join(effects.dir, "intent.json"), { port, sha256: sha256(toml) });
  writeFileSync(configFile, toml);
  const applied = applySystemConfig({ ...effects, configFile });
  return { ...applied, port, verified: systemConfigInstalled(applied.after, sha256(toml)) };
}

export function removeProviderRoute({ out, applied }) {
  return restoreSystemConfig({ ...routeEffects(out), applied });
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Undoes every recorded change again (route, minimal profile, distro profile); a no-op once
 * restored. Returns one result per record found. */
export function restoreRecorded(out) {
  const read = (record) => {
    try {
      return JSON.parse(readFileSync(join(out, ...RECORDS[record]), "utf8"));
    } catch {
      return null;
    }
  };
  const stamp = Date.now();
  const results = {};
  const route = read("route");
  if (route) results.route = removeProviderRoute({ out, applied: route });
  for (const [control, pinned] of [
    ["minimal", join(out, ...MINIMAL_FILE)],
    ["distro", join(out, "distro-profile", "bwrap-userns-restrict")],
  ]) {
    const applied = read(control);
    if (!applied) continue;
    const phase = control === "minimal" ? "minimal-profile" : "distro-profile";
    results[control] = restoreProfile({
      ...profileEffects(out, join(out, "phases", phase, `restore-${stamp}`), control),
      pinnedFile: pinned,
      names: profileNames(readFileSync(pinned, "utf8")),
      applied,
    });
  }
  json(join(out, `restore-check-${stamp}.json`), results);
  return results;
}
