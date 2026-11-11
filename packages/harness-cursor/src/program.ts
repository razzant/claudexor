import { defineHarnessProgram } from "@claudexor/core";
import type { HarnessProgramPlatform } from "@claudexor/schema";

const posix: HarnessProgramPlatform = {
  launcherDirs: ["{home}/.local/bin", "{home}/.cursor/bin"],
  newest: {
    url: "https://cursor.com/install",
    pick: {
      kind: "pattern",
      pattern: "versions/([0-9]{4}\\.[0-9]{2}\\.[0-9]{2}-[A-Za-z0-9]+)",
    },
  },
  update: {
    kind: "exec",
    command: "{program}",
    args: ["update"],
  },
  install: {
    kind: "script",
    url: "https://cursor.com/install",
    interpreter: "/bin/bash",
    interpreterArgs: [],
    args: [],
  },
  reasons: {
    exactVersion: "cursor does not provide an exact-version command.",
  },
};

/** Vendor distribution contract; fixture stamps never select an install. */
export const CURSOR_PROGRAM = defineHarnessProgram({
  id: "cursor",
  launchers: [
    {
      name: "cursor-agent",
    },
    {
      name: "agent",
      realPathPattern: "[/\\\\]cursor-agent[/\\\\]versions[/\\\\][^/\\\\]+[/\\\\]cursor-agent$",
    },
  ],
  versionScheme: "date-hash",
  overrideEnv: "CLAUDEXOR_CURSOR_BIN",
  installationEnv: ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"],
  platforms: {
    darwin: posix,
    linux: posix,
    win32: {
      launcherDirs: [
        "{home}/.local/bin",
        "{home}/.cursor/bin",
        "{localAppData}/Microsoft/WinGet/Links",
      ],
      newest: {
        url: "https://cursor.com/install",
        pick: {
          kind: "pattern",
          pattern: "versions/([0-9]{4}\\.[0-9]{2}\\.[0-9]{2}-[A-Za-z0-9]+)",
        },
      },
      reasons: {
        install: "Cursor Windows launchers are not supported by this engine (#667).",
        update: "Cursor Windows launchers are not supported by this engine (#667).",
        exactVersion: "Cursor does not provide an exact-version command.",
      },
    },
  },
});
