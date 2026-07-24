import { harnessRuntimeEnv, resolveHarnessBinary } from "@claudexor/core";
import { defaultNativeClaudeConfigDir } from "@claudexor/harness-claude";
import { CODEX_FILE_AUTH_ARGS, defaultNativeCodexHome } from "@claudexor/harness-codex";
import { ensureDir } from "@claudexor/util";
import { isAbsolute } from "node:path";

export interface NativeLoginSpec {
  binary: string;
  args: string[];
  displayCommand: string;
  /** D-17: "device_code" = the primary flow hosted by the runner over
   * `codex app-server --stdio` (no Terminal). Absent/"terminal" = the legacy
   * Terminal-hosted vendor login. */
  loginMode?: "terminal" | "device_code";
  /** Which app-server auth flow the device_code runner requests (device_code only). */
  appServerFlow?: "chatgptDeviceCode" | "chatgpt";
}

type LoginDefinition = Omit<NativeLoginSpec, "binary"> & { binaryName: () => string };

/** device_auth = app-server device-code (primary, no Terminal); browser_callback
 * = app-server browser-callback (secondary); browser_redirect = legacy Terminal
 * localhost callback (the typed fallback). */
export type CodexLoginFlow = "device_auth" | "browser_callback" | "browser_redirect";

const NATIVE_LOGIN_DEFINITIONS: Record<string, LoginDefinition> = {
  codex: {
    binaryName: () => process.env.CLAUDEXOR_CODEX_BIN || "codex",
    // D-17: device-code auth is the DEFAULT flow, now driven over the codex
    // app-server (`account/login/start {chatgptDeviceCode}`) with NO Terminal.
    // Completed in an ISOLATED browser context it avoids the
    // session-invalidation trigger the localhost-redirect flow carries (an
    // in-browser account switch revokes sibling sessions server-side).
    // Vendor-side invalidation can never be fully prevented. The real spec is
    // built by nativeLoginSpec (loginMode "device_code"); these fields feed the
    // display-only helper.
    args: [...CODEX_FILE_AUTH_ARGS, "app-server", "--stdio"],
    displayCommand: "codex app-server device-code login (isolated Claudexor profile)",
  },
  claude: {
    binaryName: () => process.env.CLAUDEXOR_CLAUDE_BIN || "claude",
    // No --claudeai flag: it is version-varying (absent on older CLIs, #17)
    // while plain `auth login` already defaults to the claude.ai subscription
    // route; the scoped CLAUDE_CONFIG_DIR isolates us from any user setting
    // that could flip that default, and doctor's native_session check refuses
    // anything but authMethod=claude.ai after the fact.
    args: ["auth", "login"],
    displayCommand: "claude auth login",
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
  loginFlow?: CodexLoginFlow,
): NativeLoginSpec | null {
  const definition = NATIVE_LOGIN_DEFINITIONS[harness];
  if (!definition) return null;
  const resolved = resolver(definition.binaryName());
  if (!resolved || !isAbsolute(resolved)) return null;
  if (harness === "codex") {
    // D-17: the legacy Terminal localhost-callback flow is the explicit opt-in
    // fallback; everything else on codex is the app-server device-code primary.
    if (loginFlow === "browser_redirect") {
      return {
        binary: resolved,
        args: [...CODEX_FILE_AUTH_ARGS, "login"],
        displayCommand: "codex login (browser redirect, isolated Claudexor profile)",
        loginMode: "terminal",
      };
    }
    // Default (absent) and device_auth → device-code; browser_callback → chatgpt.
    const appServerFlow = loginFlow === "browser_callback" ? "chatgpt" : "chatgptDeviceCode";
    return {
      binary: resolved,
      // The runner hosts the app-server; the same file-auth args + app-server
      // transport the codex quota source uses (codex-quota-source.ts).
      args: [...CODEX_FILE_AUTH_ARGS, "app-server", "--stdio"],
      displayCommand:
        appServerFlow === "chatgpt"
          ? "codex app-server browser-callback login (isolated Claudexor profile)"
          : "codex app-server device-code login (isolated Claudexor profile)",
      loginMode: "device_code",
      appServerFlow,
    };
  }
  return {
    binary: resolved,
    args: [...definition.args],
    displayCommand: definition.displayCommand,
    loginMode: "terminal",
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
  configDirOverride?: string,
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
    env.CODEX_HOME = configDirOverride ?? defaultNativeCodexHome();
    ensureDir(env.CODEX_HOME);
  } else if (harness === "claude") {
    env.CLAUDE_CONFIG_DIR = configDirOverride ?? defaultNativeClaudeConfigDir();
    // Default and profile Claude stores are both Claudexor-owned (INV-067 /
    // INV-135); ordinary ~/.claude is never created, read, or mutated here.
    ensureDir(env.CLAUDE_CONFIG_DIR);
  }
  return env;
}
