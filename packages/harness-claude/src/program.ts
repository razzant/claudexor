import { defineHarnessProgram } from "@claudexor/core";
import type { HarnessProgramPlatform } from "@claudexor/schema";

const posix: HarnessProgramPlatform = {
  launcherDirs: ["{home}/.local/bin"],
  newest: {
    url: "https://downloads.claude.ai/claude-code-releases/latest",
    pick: {
      kind: "text",
    },
  },
  update: {
    kind: "exec",
    command: "{program}",
    args: ["update"],
  },
  install: {
    kind: "script",
    url: "https://claude.ai/install.sh",
    interpreter: "/bin/bash",
    interpreterArgs: [],
    args: [],
  },
  exactVersion: {
    kind: "exec",
    command: "{program}",
    args: ["install", "{version}"],
  },
};

/** Vendor distribution contract; fixture stamps never select an install. */
export const CLAUDE_PROGRAM = defineHarnessProgram({
  id: "claude",
  launchers: [
    {
      name: "claude",
    },
  ],
  versionScheme: "semver",
  releaseNotesUrl: "https://api.github.com/repos/anthropics/claude-code/releases",
  overrideEnv: "CLAUDEXOR_CLAUDE_BIN",
  installationEnv: [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "CLAUDE_CONFIG_DIR",
  ],
  legacyNpmPackage: "@anthropic-ai/claude-code",
  platforms: {
    darwin: posix,
    linux: posix,
    win32: {
      launcherDirs: ["{home}/.local/bin", "{localAppData}/Microsoft/WinGet/Links"],
      newest: {
        url: "https://downloads.claude.ai/claude-code-releases/latest",
        pick: {
          kind: "text",
        },
      },
      update: {
        kind: "exec",
        command: "{program}",
        args: ["update"],
      },
      install: {
        kind: "script",
        url: "https://claude.ai/install.ps1",
        interpreter: "powershell",
        interpreterArgs: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"],
        args: [],
      },
      exactVersion: {
        kind: "exec",
        command: "{program}",
        args: ["install", "{version}"],
      },
    },
  },
});
