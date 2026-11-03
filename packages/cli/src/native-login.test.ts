import { GROK_MANAGED_LOGIN, createGrokAdapter } from "@claudexor/harness-grok";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userConfigDir } from "@claudexor/util";
import {
  NATIVE_LOGIN_INPUTS,
  nativeLoginDisplayCommand,
  nativeLoginEnv,
  nativeLoginSpec,
} from "./native-login.js";
import {
  CLAUDE_MANAGED_LOGIN,
  createClaudeAdapter,
  defaultNativeClaudeConfigDir,
} from "@claudexor/harness-claude";
import {
  CODEX_FILE_AUTH_OVERRIDE,
  CODEX_MANAGED_LOGIN,
  createCodexAdapter,
  defaultNativeCodexHome,
} from "@claudexor/harness-codex";
import { CURSOR_MANAGED_LOGIN, createCursorAdapter } from "@claudexor/harness-cursor";
import { AGY_MANAGED_LOGIN, createAgyAdapter } from "@claudexor/harness-agy";
import { ControlHarnessSetupHarness } from "@claudexor/schema";
import { resolveHarnessBinary } from "@claudexor/core";

describe("native login specs", () => {
  const resolver = (binary: string): string => `/normalized/bin/${binary}`;
  let previousNativeHome: string | undefined;
  let nativeHome: string;

  beforeEach(() => {
    previousNativeHome = process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    // The override must stay inside the Claudexor config root (A4 containment),
    // so seed the disposable native home under the (hermetic) config dir.
    mkdirSync(join(userConfigDir(), "native"), { recursive: true });
    nativeHome = mkdtempSync(join(userConfigDir(), "native", "codex-login-"));
    process.env.CLAUDEXOR_CODEX_NATIVE_HOME = nativeHome;
  });

  afterEach(() => {
    if (previousNativeHome === undefined) delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
    else process.env.CLAUDEXOR_CODEX_NATIVE_HOME = previousNativeHome;
    rmSync(nativeHome, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  it("uses the exact allowlisted vendor commands and absolute resolved binaries", () => {
    const names = [
      "CLAUDEXOR_CODEX_BIN",
      "CLAUDEXOR_CLAUDE_BIN",
      "CLAUDEXOR_CURSOR_BIN",
      "CLAUDEXOR_AGY_BIN",
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    try {
      // D-17 default: codex logs in over the app-server device-code flow (no
      // Terminal), NOT the legacy `codex login --device-auth`.
      expect(nativeLoginSpec("codex", resolver)).toEqual({
        binary: "/normalized/bin/codex",
        args: ["-c", CODEX_FILE_AUTH_OVERRIDE, "app-server", "--stdio"],
        displayCommand: "codex app-server device-code login (isolated Claudexor profile)",
        loginMode: "device_code",
        appServerFlow: "chatgptDeviceCode",
      });
      // Secondary app-server browser-callback flow (codex only).
      expect(nativeLoginSpec("codex", resolver, "browser_callback")).toEqual({
        binary: "/normalized/bin/codex",
        args: ["-c", CODEX_FILE_AUTH_OVERRIDE, "app-server", "--stdio"],
        displayCommand: "codex app-server browser-callback login (isolated Claudexor profile)",
        loginMode: "device_code",
        appServerFlow: "chatgpt",
      });
      // Explicit opt-in legacy Terminal localhost-redirect flow (codex only).
      expect(nativeLoginSpec("codex", resolver, "browser_redirect")).toEqual({
        binary: "/normalized/bin/codex",
        args: ["-c", CODEX_FILE_AUTH_OVERRIDE, "login"],
        displayCommand: "codex login (browser redirect, isolated Claudexor profile)",
        loginMode: "terminal",
      });
      // A flow hint never changes non-codex harnesses.
      expect(nativeLoginSpec("claude", resolver, "browser_redirect")?.args).toEqual([
        "auth",
        "login",
      ]);
      // Owner directive 2026-08-04: claude and cursor never open Terminal —
      // claude's manual OAuth completion takes the one-shot input sidecar,
      // cursor's login self-completes by server-side polling.
      expect(nativeLoginSpec("claude", resolver)).toEqual({
        binary: "/normalized/bin/claude",
        args: ["auth", "login"],
        displayCommand: "claude auth login",
        loginMode: "url_disclosure_with_input",
      });
      expect(nativeLoginSpec("cursor", resolver)).toEqual({
        binary: "/normalized/bin/cursor-agent",
        args: ["login"],
        displayCommand: "cursor-agent login",
        loginMode: "url_disclosure",
      });
      // agy has no login subcommand at all: the bare interactive CLI prints the
      // sign-in URL and takes the pasted code — the same shape as claude, with
      // one difference the runner has to honor, that the vendor reads its code
      // only from a real terminal.
      expect(nativeLoginSpec("agy", resolver)).toEqual({
        binary: "/normalized/bin/agy",
        // Print mode, never the bare TUI: the TUI opens the browser ITSELF on
        // the daemon host and never exits after authenticating.
        args: ["-p", "/model", "--output-format", "json"],
        displayCommand: 'agy -p "/model" (sign-in via printed link + pasted code)',
        loginMode: "url_disclosure_with_input",
        ptyStdin: true,
        // The vendor's OWN paste window, sealed so the card counts down
        // against the process rather than against the engine's 15 minutes.
        loginWindowMs: 60_000,
      });
      // No other harness claims a tty: a needless wrapper process around a
      // login that never reads stdin.
      for (const harness of ["codex", "claude", "cursor"]) {
        expect(nativeLoginSpec(harness, resolver)?.ptyStdin).toBeUndefined();
        // No other vendor caps its own window, so the engine's governs.
        expect(nativeLoginSpec(harness, resolver)?.loginWindowMs).toBeUndefined();
      }
      for (const harness of ["codex", "claude", "cursor", "agy"]) {
        expect(isAbsolute(nativeLoginSpec(harness, resolver)?.binary ?? "")).toBe(true);
      }
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("refuses unresolved or non-absolute binaries and leaves OpenCode out", () => {
    expect(nativeLoginSpec("codex", () => null)).toBeNull();
    expect(nativeLoginSpec("codex", () => "codex")).toBeNull();
    expect(nativeLoginSpec("opencode", resolver)).toBeNull();
    expect(nativeLoginDisplayCommand("codex")).toBe(
      "codex app-server device-code login (isolated Claudexor profile)",
    );
  });

  it("keeps one manifest-owned input declaration for every setup command", () => {
    const manifestDeclarations = {
      codex: createCodexAdapter().capabilityProfile?.auth.managed_login,
      claude: createClaudeAdapter().capabilityProfile?.auth.managed_login,
      cursor: createCursorAdapter().capabilityProfile?.auth.managed_login,
      agy: createAgyAdapter().capabilityProfile?.auth.managed_login,
      grok: createGrokAdapter().capabilityProfile?.auth.managed_login,
    } as const;
    const exportedDeclarations = {
      codex: CODEX_MANAGED_LOGIN,
      claude: CLAUDE_MANAGED_LOGIN,
      cursor: CURSOR_MANAGED_LOGIN,
      agy: AGY_MANAGED_LOGIN,
      grok: GROK_MANAGED_LOGIN,
    } as const;

    expect(Object.keys(NATIVE_LOGIN_INPUTS).sort()).toEqual(
      [...ControlHarnessSetupHarness.options].sort(),
    );
    for (const harness of ControlHarnessSetupHarness.options) {
      expect(NATIVE_LOGIN_INPUTS[harness]).toBe(exportedDeclarations[harness]);
      expect(manifestDeclarations[harness]).toEqual(exportedDeclarations[harness]);
      expect(nativeLoginDisplayCommand(harness)).not.toBeNull();
      const spec = nativeLoginSpec(harness, resolver);
      expect(spec).not.toBeNull();
      expect(spec?.ptyStdin === true).toBe(exportedDeclarations[harness].stdin === "terminal");
    }
  });

  it("resolves the same explicit binary override used by the adapter", () => {
    const previous = process.env.CLAUDEXOR_CODEX_BIN;
    process.env.CLAUDEXOR_CODEX_BIN = "/custom/codex";
    try {
      const requested: string[] = [];
      const spec = nativeLoginSpec("codex", (binary) => {
        requested.push(binary);
        return binary;
      });
      expect(requested).toEqual(["/custom/codex"]);
      expect(spec?.binary).toBe("/custom/codex");
    } finally {
      if (previous === undefined) delete process.env.CLAUDEXOR_CODEX_BIN;
      else process.env.CLAUDEXOR_CODEX_BIN = previous;
    }
  });

  describe("cursor login binary", () => {
    const saved = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      CLAUDEXOR_CURSOR_BIN: process.env.CLAUDEXOR_CURSOR_BIN,
    };
    const roots: string[] = [];
    beforeEach(() => {
      delete process.env.CLAUDEXOR_CURSOR_BIN;
    });
    afterEach(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
    // Resolution only: no case here runs a fixture, so its bytes are inert.
    const exe = (path: string): string => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "resolved, never executed\n");
      chmodSync(path, 0o755);
      return path;
    };
    const link = (target: string, path: string): string => {
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(target, path);
      return path;
    };
    /** `<root>/.local/bin/agent` -> the installer's `versions/<v>/cursor-agent`. */
    const cursorAgent = (root: string): string =>
      link(
        exe(join(root, ".local", "share", "cursor-agent", "versions", "1", "cursor-agent")),
        join(root, ".local", "bin", "agent"),
      );
    const sandbox = (): string => {
      const root = mkdtempSync(join(tmpdir(), "cursor-login-bin-"));
      roots.push(root);
      return root;
    };
    const absoluteOr =
      (names: Record<string, string>) =>
      (binary: string): string | null =>
        names[binary] ?? (isAbsolute(binary) ? binary : null);

    // The installer's `agent` is a symlink, which Windows creates only with a
    // privilege (and Cursor's Windows installer copies instead of linking).
    it.skipIf(process.platform === "win32")(
      "logs in through a verified Cursor agent when cursor-agent is absent, and says so",
      () => {
        const launcher = cursorAgent(sandbox());
        expect(nativeLoginSpec("cursor", absoluteOr({ agent: launcher }))).toEqual({
          binary: launcher,
          args: ["login"],
          displayCommand: "agent login",
          loginMode: "url_disclosure",
        });
      },
    );

    it("never logs in through an unrelated agent", () => {
      const unrelated = exe(join(sandbox(), "bin", "agent"));
      const requested: string[] = [];
      const resolve = absoluteOr({ agent: unrelated });
      const spec = nativeLoginSpec("cursor", (binary) => {
        requested.push(binary);
        return resolve(binary);
      });
      expect(spec).toBeNull();
      expect(requested).not.toContain(unrelated);
    });

    const emptyHome = mkdtempSync(join(tmpdir(), "cursor-login-host-"));
    const hostHasCursorNames = ["cursor-agent", "agent"].some(
      (name) => resolveHarnessBinary(name, { HOME: emptyHome, PATH: "" }) !== null,
    );
    rmSync(emptyHome, { recursive: true, force: true });

    // POSIX-only as well: on Windows the default resolver takes only
    // `.exe`/`.com` images, never the installer's linked `agent`.
    it.skipIf(process.platform === "win32" || hostHasCursorNames)(
      "the default resolver finds the installer's agent on the harness PATH",
      () => {
        const home = sandbox();
        const launcher = cursorAgent(home);
        process.env.HOME = home;
        // The host's own PATH never answers: only the harness PATH prefixes.
        process.env.PATH = "";
        expect(nativeLoginSpec("cursor")).toMatchObject({
          binary: launcher,
          displayCommand: "agent login",
        });
      },
    );
  });

  it("scrubs all provider credentials and redirects while retaining runtime network context", () => {
    const env = nativeLoginEnv("codex", {
      HOME: "/home/user",
      PATH: "/custom/bin",
      HTTPS_PROXY: "http://proxy.example",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
      OPENAI_API_KEY: "secret-openai",
      CODEX_ACCESS_TOKEN: "secret-codex-token",
      ANTHROPIC_API_KEY: "secret-anthropic",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_API_KEY: "secret-foundry",
      ANTHROPIC_FOUNDRY_AUTH_TOKEN: "secret-foundry-token",
      ANTHROPIC_FOUNDRY_RESOURCE: "resource-name",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.invalid",
      AZURE_CLIENT_SECRET: "secret-azure",
      AZURE_FEDERATED_TOKEN_FILE: "/tmp/token",
      CURSOR_API_KEY: "secret-cursor",
      OPENAI_BASE_URL: "https://redirect.invalid",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
    expect(env.ANTHROPIC_FOUNDRY_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_FOUNDRY_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_FOUNDRY_RESOURCE).toBeUndefined();
    expect(env.ANTHROPIC_FOUNDRY_BASE_URL).toBeUndefined();
    expect(env.AZURE_CLIENT_SECRET).toBeUndefined();
    expect(env.AZURE_FEDERATED_TOKEN_FILE).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe("http://proxy.example");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/ca.pem");
    expect(env.PATH).toContain("/custom/bin");
    expect(env.CODEX_HOME).toBe(defaultNativeCodexHome());
  });

  it("pins each vendor login to the same native store its verifier probes", () => {
    const source = {
      HOME: "/daemon/home",
      CODEX_HOME: "/stale/scoped/codex",
      CLAUDE_CONFIG_DIR: "/stale/scoped/claude",
      CURSOR_API_KEY: "must-be-scrubbed",
    };
    expect(nativeLoginEnv("codex", source).CODEX_HOME).toBe(defaultNativeCodexHome());
    expect(nativeLoginEnv("claude", source).CLAUDE_CONFIG_DIR).toBe(defaultNativeClaudeConfigDir());
    // D-U3: cursor has no default store — a login without a row's file-store
    // HOME would land in the HOST Keychain, so it refuses instead.
    expect(() => nativeLoginEnv("cursor", source)).toThrow(/no default credential store/);
  });

  it("pins a named Cursor login to its own file store without changing the default route", () => {
    const profiles = join(userConfigDir(), "profiles");
    mkdirSync(profiles, { recursive: true });
    // realpath: the canonicalizer resolves the macOS /var → /private/var
    // symlink, so the expected paths must use the resolved spelling.
    const profileHome = realpathSync(mkdtempSync(join(profiles, "cursor-login-")));
    try {
      const env = nativeLoginEnv(
        "cursor",
        { HOME: "/daemon/home", PATH: "/custom/bin", CURSOR_API_KEY: "must-scrub" },
        profileHome,
      );
      expect(env).toMatchObject({
        HOME: profileHome,
        USERPROFILE: profileHome,
        APPDATA: join(profileHome, "AppData", "Roaming"),
        XDG_CONFIG_HOME: join(profileHome, ".config"),
        CURSOR_CONFIG_DIR: join(profileHome, ".cursor"),
        CURSOR_DATA_DIR: join(profileHome, ".cursor"),
        AGENT_CLI_CREDENTIAL_STORE: "file",
        NO_OPEN_BROWSER: "1",
      });
      expect(env.CURSOR_API_KEY).toBeUndefined();
      // D-U3: an overrideless cursor login refuses (no host-Keychain target).
      expect(() => nativeLoginEnv("cursor", { HOME: "/daemon/home" })).toThrow(
        /no default credential store/,
      );
    } finally {
      rmSync(profileHome, { recursive: true, force: true });
    }
  });

  it("points a named agy login at the profile HOME and scrubs every Google API route", () => {
    const profiles = join(userConfigDir(), "profiles");
    mkdirSync(profiles, { recursive: true });
    const profileHome = realpathSync(mkdtempSync(join(profiles, "agy-login-")));
    try {
      // agy takes its whole config root from $HOME (no config-dir env var), so
      // HOME/USERPROFILE ARE the isolation. A poisoned parent env must not put
      // a metered API route or a sibling harness's store into the login.
      const env = nativeLoginEnv(
        "agy",
        {
          HOME: "/daemon/home",
          PATH: "/custom/bin",
          GEMINI_API_KEY: "must-scrub",
          GOOGLE_API_KEY: "must-scrub",
          GOOGLE_APPLICATION_CREDENTIALS: "/must/scrub.json",
          AGY_ADC_AUTH: "must-scrub",
          ANTHROPIC_API_KEY: "must-scrub",
          CURSOR_API_KEY: "must-scrub",
          CLAUDE_CONFIG_DIR: "/stale/scoped/claude",
          CODEX_HOME: "/stale/scoped/codex",
        },
        profileHome,
      );
      expect(env).toMatchObject({
        HOME: profileHome,
        USERPROFILE: profileHome,
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      });
      for (const key of [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "AGY_ADC_AUTH",
        "ANTHROPIC_API_KEY",
        "CURSOR_API_KEY",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
      ]) {
        expect(env[key]).toBeUndefined();
      }
      expect(env.PATH).toContain("/custom/bin");
    } finally {
      rmSync(profileHome, { recursive: true, force: true });
    }
  });

  it("pins Grok login to a named profile and disables its updater", () => {
    expect(() => nativeLoginEnv("grok", { GROK_HOME: "/host/.grok" })).toThrow(
      /no default credential store/,
    );
    const profiles = join(userConfigDir(), "profiles");
    mkdirSync(profiles, { recursive: true });
    const profileHome = realpathSync(mkdtempSync(join(profiles, "grok-login-")));
    try {
      const env = nativeLoginEnv(
        "grok",
        {
          GROK_HOME: "/host/.grok",
          GROK_DISABLE_AUTOUPDATER: "0",
          GROK_CONFIG: '{"cli":{"auto_update":true}}',
          GROK_CODE_XAI_API_KEY: "must-scrub",
          GROK_XAI_API_BASE_URL: "https://redirect.invalid",
          GROK_MODELS_BASE_URL: "https://redirect.invalid",
          GROK_MODELS_LIST_URL: "https://redirect.invalid/models",
        },
        profileHome,
      );
      expect(env).toMatchObject({
        HOME: profileHome,
        USERPROFILE: profileHome,
        GROK_HOME: join(profileHome, ".grok"),
        GROK_DISABLE_AUTOUPDATER: "1",
      });
      for (const key of [
        "GROK_CONFIG",
        "GROK_CONFIG_PATH",
        "GROK_CODE_XAI_API_KEY",
        "GROK_XAI_API_BASE_URL",
        "GROK_MODELS_BASE_URL",
        "GROK_MODELS_LIST_URL",
      ])
        expect(env[key], key).toBeUndefined();
    } finally {
      rmSync(profileHome, { recursive: true, force: true });
    }
  });

  it("refuses an agy login with no profile HOME instead of targeting the operator's home", () => {
    // Owner decision Л-4: agy has NO default binding store. Falling through
    // would leave the daemon's own HOME in place and put vendor state/login
    // artifacts in the operator's real home (INV-135).
    expect(() => nativeLoginEnv("agy", { HOME: "/daemon/home" })).toThrow(
      /no default credential store/,
    );
    // The harnesses that DO have a default store keep working unchanged.
    expect(nativeLoginEnv("codex", { HOME: "/daemon/home" }).CODEX_HOME).toBe(
      defaultNativeCodexHome(),
    );
  });
});
