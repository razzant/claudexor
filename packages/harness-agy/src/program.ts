import { defineHarnessProgram } from "@claudexor/core";
import type { HarnessProgramPlatform } from "@claudexor/schema";

const posix: HarnessProgramPlatform = {
  launcherDirs: ["{home}/.local/bin"],
  newest: {
    url: "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/{arch}.json",
    pick: {
      kind: "json",
      field: "version",
    },
  },
  update: {
    kind: "exec",
    command: "{program}",
    args: ["update"],
  },
  install: {
    kind: "script",
    url: "https://antigravity.google/cli/install.sh",
    interpreter: "/bin/bash",
    interpreterArgs: [],
    args: [],
  },
  reasons: {
    exactVersion: "agy does not provide an exact-version command.",
  },
  architectures: {
    arm64: "darwin_arm64",
    x64: "darwin_amd64",
  },
};

/** Vendor distribution contract; fixture stamps never select an install. */
export const AGY_PROGRAM = defineHarnessProgram({
  id: "agy",
  launchers: [
    {
      name: "agy",
    },
  ],
  versionScheme: "semver",
  overrideEnv: "CLAUDEXOR_AGY_BIN",
  installationEnv: ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"],
  childUpdateEnv: {
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  },
  platforms: {
    darwin: posix,
    linux: { ...posix, architectures: { arm64: "linux_arm64", x64: "linux_amd64" } },
    win32: {
      launcherDirs: [
        "{home}/.local/bin",
        "{localAppData}/Microsoft/WinGet/Links",
        "{localAppData}/agy/bin",
      ],
      newest: {
        url: "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/{arch}.json",
        pick: {
          kind: "json",
          field: "version",
        },
      },
      update: {
        kind: "exec",
        command: "{program}",
        args: ["update"],
      },
      install: {
        kind: "script",
        url: "https://antigravity.google/cli/install.ps1",
        interpreter: "powershell",
        interpreterArgs: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"],
        args: [],
      },
      reasons: {
        exactVersion: "agy does not provide an exact-version command.",
      },
      architectures: {
        arm64: "windows_arm64",
        x64: "windows_amd64",
      },
    },
  },
});
