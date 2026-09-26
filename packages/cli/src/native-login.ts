import {
  WINDOWS_RUNTIME_ENV_KEYS,
  harnessRuntimeEnv,
  pickAllowlistedEnv,
  resolveHarnessBinary,
} from "@claudexor/core";
import { CLAUDE_MANAGED_LOGIN, defaultNativeClaudeConfigDir } from "@claudexor/harness-claude";
import {
  CODEX_FILE_AUTH_ARGS,
  CODEX_MANAGED_LOGIN,
  defaultNativeCodexHome,
} from "@claudexor/harness-codex";
import {
  CURSOR_MANAGED_LOGIN,
  canonicalCursorProfileHome,
  cursorProfilePathEnv,
  resolveCursorBin,
} from "@claudexor/harness-cursor";
import { AGY_MANAGED_LOGIN, canonicalAgyProfileHome } from "@claudexor/harness-agy";
import type { ManagedLogin } from "@claudexor/schema";
import { ensureDir } from "@claudexor/util";
import { isAbsolute } from "node:path";

export interface NativeLoginSpec {
  binary: string;
  args: string[];
  displayCommand: string;
  /** D-17: "device_code" = the codex app-server flow (no Terminal).
   * "url_disclosure" = daemon-hosted vendor login whose sign-in URL is
   * captured into the disclosure sidecar (cursor). "url_disclosure_with_input"
   * = the same plus the one-shot stdin input sidecar (claude paste-code).
   * "terminal" = a login driven on the operator's own tty (the codex
   * browser_redirect fallback). */
  loginMode?: "terminal" | "device_code" | "url_disclosure" | "url_disclosure_with_input";
  /** Which app-server auth flow the device_code runner requests (device_code only). */
  appServerFlow?: "chatgptDeviceCode" | "chatgpt";
  /** The vendor reads its pasted code only from a real terminal (agy), so the
   * daemon-hosted runner must give stdin a tty instead of a pipe. */
  ptyStdin?: boolean;
  /** How long the VENDOR itself will wait for the code, when that is shorter
   * than Claudexor's own login window. Absent = the engine's window governs. */
  loginWindowMs?: number;
}

type LoginDefinition = Omit<NativeLoginSpec, "binary"> & { binaryName: () => string };

/** device_auth = app-server device-code (primary, no Terminal); browser_callback
 * = app-server browser-callback (secondary); browser_redirect = legacy Terminal
 * localhost callback (the typed fallback). */
export type CodexLoginFlow = "device_auth" | "browser_callback" | "browser_redirect";

/** The vendor's own paste window for agy: 60 seconds, no flag to extend. */
export const AGY_LOGIN_WINDOW_MS = 60_000;

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
    binaryName: () => resolveCursorBin(),
    args: ["login"],
    displayCommand: `${resolveCursorBin().split("/").pop() ?? "cursor-agent"} login`,
  },
  agy: {
    binaryName: () => process.env.CLAUDEXOR_AGY_BIN || "agy",
    // agy has no login subcommand. BARE `agy` is the interactive TUI, which
    // OPENS THE BROWSER ITSELF and stays resident after authenticating — on a
    // daemon host that hijacks a browser nobody is watching and the runner
    // waits forever on a process that never exits (PLAN F7; sol review). The
    // PRINT-MODE shape is the live-proven login vehicle (PLAN F6): an
    // unauthenticated `agy -p …` prints the sign-in URL to stderr, waits
    // exactly 60 seconds for the pasted code on a tty stdin, completes the
    // login, answers the command and EXITS. `/model` is the quota-free
    // command, the same one the doctor probe uses. Both routes run this —
    // `claudexor profiles login agy` on the operator's own tty, the card
    // through the runner's pty (ptyStdin).
    args: ["-p", "/model", "--output-format", "json"],
    displayCommand: 'agy -p "/model" (sign-in via printed link + pasted code)',
  },
};

/**
 * One-to-one bridge from setup command ownership to the manifest-owned input
 * declaration. Command argv/flow/window stay above; stdin class never has a
 * second hand-written owner in this registry.
 */
export const NATIVE_LOGIN_INPUTS: Record<string, ManagedLogin> = {
  codex: CODEX_MANAGED_LOGIN,
  claude: CLAUDE_MANAGED_LOGIN,
  cursor: CURSOR_MANAGED_LOGIN,
  agy: AGY_MANAGED_LOGIN,
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
  const managedLogin = NATIVE_LOGIN_INPUTS[harness];
  if (!managedLogin) return null;
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
  // Owner directive 2026-08-04: the terminal-based login UX for claude and
  // cursor is an anti-pattern — a fresh user signs in from the card, no
  // Terminal window. Claude's manual OAuth completion needs one line of user
  // input written back (the pasted code); cursor's login self-completes by
  // server-side polling once the URL is followed anywhere.
  // agy takes the same paste-a-code shape as claude; the one difference is
  // that its vendor refuses a piped stdin outright, so the runner must
  // interpose a tty (proven 2026-08-16: with a plain pipe agy answers
  // "authentication required", with a pty it prints the URL and consumes the
  // pasted code).
  const withInput = managedLogin.stdin !== "none";
  return {
    binary: resolved,
    args: [...definition.args],
    displayCommand: definition.displayCommand,
    loginMode: withInput ? "url_disclosure_with_input" : "url_disclosure",
    // agy waits EXACTLY 60 seconds for the pasted code and offers no flag to
    // extend it (measured across four runs, PLAN §1.2 F6). Sealing the vendor's
    // real window instead of the engine's 15 minutes keeps the card's countdown
    // honest and lets it re-issue the link the moment the vendor gives up
    // (Л-23) rather than counting down against a process that already exited.
    ...(managedLogin.stdin === "terminal" ? { ptyStdin: true } : {}),
    ...(harness === "agy" ? { loginWindowMs: AGY_LOGIN_WINDOW_MS } : {}),
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
    ...WINDOWS_RUNTIME_ENV_KEYS,
  ];
  const env = pickAllowlistedEnv(runtime, allowed);
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
  } else if (harness === "agy") {
    // agy takes its whole state root from $HOME; the profile HOME is the named
    // binding's isolation locator. There is NO default agy binding store (owner
    // decision Л-4), so an absent override must REFUSE: falling through would
    // leave the daemon's own HOME in place and put vendor state/login artifacts
    // in the operator's real home directory (INV-135). Credential custody itself
    // remains platform-defined and may be OS-user-scoped.
    if (!configDirOverride) {
      throw new Error(
        "agy has no default credential store: an Antigravity login must target a named profile HOME (INV-135, owner decision Л-4)",
      );
    }
    // HOME scopes vendor state. The effective credential transport remains a
    // platform/version fact (Windows is OS-user scoped), so login never treats
    // a token path as an auth oracle. Pin the closed vendor's auto-updater.
    const home = canonicalAgyProfileHome(configDirOverride);
    ensureDir(home);
    env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
    env.HOME = home;
    env.USERPROFILE = home;
  } else if (harness === "cursor") {
    // url_disclosure: the CLI must print its sign-in URL instead of opening a
    // browser on the daemon host (the user may be on another device). The
    // vendor gates this on NO_OPEN_BROWSER (verified in the shipped bundle).
    env.NO_OPEN_BROWSER = "1";
    // Owner decision D-U3 (unified account model): cursor has NO default
    // credential store — a login without a profile HOME would land in the
    // HOST Keychain, which Claudexor never reads again. Every cursor login
    // targets an isolated file-store row (the bootstrap `cursor-default` row
    // when none was named); an absent override must REFUSE, never fall
    // through to the operator's real HOME.
    if (!configDirOverride) {
      throw new Error(
        "cursor has no default credential store: a Cursor login must target an account row's file-store HOME (D-U3; host Keychain logins are not used)",
      );
    }
    const home = canonicalCursorProfileHome(configDirOverride);
    ensureDir(home);
    Object.assign(env, cursorProfilePathEnv(home));
  }
  return env;
}
