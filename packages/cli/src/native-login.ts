import { harnessRuntimeEnv, resolveHarnessBinary } from "@claudexor/core";
import { defaultNativeClaudeConfigDir } from "@claudexor/harness-claude";
import { CODEX_FILE_AUTH_ARGS, defaultNativeCodexHome } from "@claudexor/harness-codex";
import { ensureDir } from "@claudexor/util";
import { isAbsolute } from "node:path";

export interface NativeLoginSpec {
  binary: string;
  args: string[];
  displayCommand: string;
}

type LoginDefinition = Omit<NativeLoginSpec, "binary"> & { binaryName: () => string };

const NATIVE_LOGIN_DEFINITIONS: Record<string, LoginDefinition> = {
  codex: {
    binaryName: () => process.env.CLAUDEXOR_CODEX_BIN || "codex",
    args: [...CODEX_FILE_AUTH_ARGS, "login"],
    displayCommand: "codex login (isolated Claudexor profile)",
  },
  claude: {
    binaryName: () => process.env.CLAUDEXOR_CLAUDE_BIN || "claude",
    args: ["auth", "login", "--claudeai"],
    displayCommand: "claude auth login --claudeai",
  },
  cursor: {
    binaryName: () => process.env.CLAUDEXOR_CURSOR_BIN || "cursor-agent",
    args: ["login"],
    displayCommand: "cursor-agent login",
  },
};

/**
 * Structured native-login command shared by CLI and setup surfaces. The
 * resolver hook uses the same normalized harness PATH as discovery and makes
 * the spawned executable absolute whenever it is installed.
 */
export function nativeLoginSpec(
  harness: string,
  resolver: (binary: string) => string | null = resolveHarnessBinary,
): NativeLoginSpec | null {
  const definition = NATIVE_LOGIN_DEFINITIONS[harness];
  if (!definition) return null;
  const resolved = resolver(definition.binaryName());
  if (!resolved || !isAbsolute(resolved)) return null;
  return {
    binary: resolved,
    args: [...definition.args],
    displayCommand: definition.displayCommand,
  };
}

export function nativeLoginDisplayCommand(harness: string): string | null {
  return NATIVE_LOGIN_DEFINITIONS[harness]?.displayCommand ?? null;
}

/**
 * Terminal opens a setup script in the GUI app's login environment rather than
 * the daemon's. Restore only non-secret paths that select the same native store
 * post-login verification will probe; provider credentials stay excluded.
 */
export function nativeLoginTerminalExports(
  harness: string,
  source: NodeJS.ProcessEnv = process.env,
): string {
  const keys = [
    "HOME",
    "TMPDIR",
    ...(harness === "codex" ? ["CLAUDEXOR_CODEX_NATIVE_HOME"] : []),
    ...(harness === "claude" ? ["CLAUDEXOR_CLAUDE_NATIVE_DIR"] : []),
  ];
  return keys
    .map((key) => [key, source[key]] as const)
    .filter(
      (entry): entry is readonly [string, string] =>
        typeof entry[1] === "string" && entry[1].length > 0,
    )
    .map(([key, value]) => `export ${key}='${value.replaceAll("'", `'"'"'`)}'\n`)
    .join("");
}

/** Native login must never inherit a provider key or endpoint override. */
export function nativeLoginEnv(
  harness: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const runtime = harnessRuntimeEnv(source);
  const env: NodeJS.ProcessEnv = {};
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "USER",
    "LOGNAME",
    "SHELL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ] as const;
  for (const key of allowed) {
    const value = runtime[key];
    if (value !== undefined) env[key] = value;
  }
  // Login and post-exit verification must address the SAME vendor-owned store.
  // These are paths only; Claudexor never reads or copies credential contents.
  if (harness === "codex") {
    env.CODEX_HOME = defaultNativeCodexHome();
    ensureDir(env.CODEX_HOME);
  } else if (harness === "claude") env.CLAUDE_CONFIG_DIR = defaultNativeClaudeConfigDir();
  return env;
}
