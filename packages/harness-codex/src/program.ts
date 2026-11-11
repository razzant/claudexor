import { defineHarnessProgram } from "@claudexor/core";
import type { HarnessProgramPlatform } from "@claudexor/schema";

const posix: HarnessProgramPlatform = {
  launcherDirs: ["{env:CODEX_INSTALL_DIR}", "{home}/.local/bin"],
  newest: {
    url: "https://releases.openai.com/codex/channels/latest",
    pick: {
      kind: "json",
      field: "tag_name",
      stripPrefix: "rust-v",
    },
  },
  update: {
    kind: "exec",
    command: "{program}",
    args: ["update"],
  },
  install: {
    kind: "script",
    url: "https://chatgpt.com/codex/install.sh",
    interpreter: "/bin/sh",
    interpreterArgs: [],
    args: [],
    env: {
      CODEX_NON_INTERACTIVE: "1",
    },
  },
  exactVersion: {
    kind: "script",
    url: "https://chatgpt.com/codex/install.sh",
    interpreter: "/bin/sh",
    interpreterArgs: [],
    args: [],
    env: {
      CODEX_NON_INTERACTIVE: "1",
      CODEX_RELEASE: "{version}",
    },
  },
};

/** Vendor distribution contract; fixture stamps never select an install. */
export const CODEX_PROGRAM = defineHarnessProgram({
  id: "codex",
  launchers: [
    {
      name: "codex",
    },
  ],
  versionScheme: "semver",
  overrideEnv: "CLAUDEXOR_CODEX_BIN",
  installationEnv: [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "CODEX_HOME",
    "CODEX_INSTALL_DIR",
  ],
  legacyNpmPackage: "@openai/codex",
  platforms: {
    darwin: posix,
    linux: posix,
    win32: {
      launcherDirs: [
        "{env:CODEX_INSTALL_DIR}",
        "{home}/.local/bin",
        "{localAppData}/Microsoft/WinGet/Links",
        "{localAppData}/Programs/OpenAI/Codex/bin",
      ],
      newest: {
        url: "https://releases.openai.com/codex/channels/latest",
        pick: {
          kind: "json",
          field: "tag_name",
          stripPrefix: "rust-v",
        },
      },
      update: {
        kind: "exec",
        command: "{program}",
        args: ["update"],
      },
      install: {
        kind: "script",
        url: "https://chatgpt.com/codex/install.ps1",
        interpreter: "powershell",
        interpreterArgs: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"],
        args: [],
        env: {
          CODEX_NON_INTERACTIVE: "1",
        },
      },
      exactVersion: {
        kind: "script",
        url: "https://chatgpt.com/codex/install.ps1",
        interpreter: "powershell",
        interpreterArgs: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"],
        args: [],
        env: {
          CODEX_NON_INTERACTIVE: "1",
          CODEX_RELEASE: "{version}",
        },
      },
    },
  },
});
