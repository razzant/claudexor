import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  agyProfileKeychainPath,
  ensureAgyProfileKeychain,
  isAgyProfileKeychainUnsafe,
  prepareAgyProfileKeychain,
} from "./keychain.js";

describe("agy private profile keychain", () => {
  const roots: string[] = [];
  const previousConfig = process.env.CLAUDEXOR_CONFIG_DIR;

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previousConfig;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  function profileHome(name = "profile"): string {
    const root = mkdtempSync(join(tmpdir(), "agy-keychain-test-"));
    roots.push(root);
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    const home = join(root, name);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return home;
  }

  function fakeSecurity(options: { createStatus?: number; createFile?: boolean } = {}) {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const run = (args: readonly string[], env: NodeJS.ProcessEnv) => {
      calls.push({ args: [...args], env: { ...env } });
      if (args[0] === "create-keychain" && (options.createFile ?? true)) {
        const path = args.at(-1) as string;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "fake-keychain", { mode: 0o644 });
      }
      return { status: args[0] === "create-keychain" ? (options.createStatus ?? 0) : 0 };
    };
    return { calls, run };
  }

  it("creates one canonical private keychain and never touches preference commands", () => {
    const home = profileHome();
    const canonicalHome = realpathSync(home);
    const security = fakeSecurity();
    prepareAgyProfileKeychain(home, { platform: "darwin", runSecurity: security.run });

    const keychain = agyProfileKeychainPath(home);
    expect(existsSync(keychain)).toBe(true);
    expect(statSync(join(home, "Library")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "Library", "Keychains")).mode & 0o777).toBe(0o700);
    expect(statSync(keychain).mode & 0o777).toBe(0o600);
    expect(security.calls.map((call) => call.args[0])).toEqual([
      "create-keychain",
      "unlock-keychain",
      "set-keychain-settings",
    ]);
    expect(security.calls[0]?.args.slice(0, 3)).toEqual(["create-keychain", "-p", ""]);
    expect(security.calls[0]?.args.at(-1)).toMatch(/\/\.agy-profile-bootstrap\.keychain-db$/);
    expect(security.calls[0]?.args.at(-1)).not.toContain("login.keychain");
    expect(security.calls[1]?.args).toEqual(["unlock-keychain", "-p", "", keychain]);
    expect(security.calls[2]?.args).toEqual(["set-keychain-settings", keychain]);
    for (const call of security.calls) {
      expect(call.args).not.toContain("default-keychain");
      expect(call.args).not.toContain("list-keychains");
      if (call.args[0] !== "create-keychain") expect(call.args.at(-1)).toBe(keychain);
      expect(call.env.HOME).toBe(canonicalHome);
      expect(call.env.USERPROFILE).toBe(canonicalHome);
      expect(call.env.CLAUDEXOR_CONFIG_DIR).toBeUndefined();
      expect(call.env.GEMINI_API_KEY).toBeUndefined();
      expect(call.env.GOOGLE_API_KEY).toBeUndefined();
    }
  });

  it("is idempotent on the hot path and keeps two profile paths separate", () => {
    const root = mkdtempSync(join(tmpdir(), "agy-keychain-test-"));
    roots.push(root);
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    const first = join(root, "a");
    const second = join(root, "b");
    mkdirSync(first, { recursive: true, mode: 0o700 });
    mkdirSync(second, { recursive: true, mode: 0o700 });
    const security = fakeSecurity();
    ensureAgyProfileKeychain(first, { platform: "darwin", runSecurity: security.run });
    const callsAfterFirst = security.calls.length;
    ensureAgyProfileKeychain(first, { platform: "darwin", runSecurity: security.run });
    expect(security.calls).toHaveLength(callsAfterFirst + 1);
    ensureAgyProfileKeychain(second, { platform: "darwin", runSecurity: security.run });
    expect(agyProfileKeychainPath(first)).not.toBe(agyProfileKeychainPath(second));
    expect(security.calls.filter((call) => call.args[0] === "create-keychain")).toHaveLength(2);
  });

  it("accepts a concurrent already-exists result only after the file is present", () => {
    const home = profileHome();
    const security = fakeSecurity({ createStatus: 48 });
    expect(() =>
      ensureAgyProfileKeychain(home, { platform: "darwin", runSecurity: security.run }),
    ).not.toThrow();
  });

  it("keeps an unsafe raced target refusal instead of downgrading it", () => {
    const home = profileHome();
    const outside = mkdtempSync(join(tmpdir(), "agy-keychain-raced-outside-"));
    roots.push(outside);
    const security = {
      calls: [] as Array<{ args: string[]; env: NodeJS.ProcessEnv }>,
      run: (args: readonly string[], env: NodeJS.ProcessEnv) => {
        security.calls.push({ args: [...args], env: { ...env } });
        if (args[0] === "create-keychain") {
          const path = args.at(-1) as string;
          mkdirSync(dirname(path), { recursive: true });
          symlinkSync(outside, path);
          return { status: 48, detail: "already exists" };
        }
        return { status: 0 };
      },
    };
    try {
      ensureAgyProfileKeychain(home, { platform: "darwin", runSecurity: security.run });
      throw new Error("expected unsafe target refusal");
    } catch (error) {
      expect(isAgyProfileKeychainUnsafe(error)).toBe(true);
    }
    expect(security.calls.map((call) => call.args[0])).toEqual(["create-keychain"]);
  });

  it("refuses a Library symlink without invoking security", () => {
    const home = profileHome();
    const outside = mkdtempSync(join(tmpdir(), "agy-keychain-outside-"));
    roots.push(outside);
    symlinkSync(outside, join(home, "Library"));
    const security = fakeSecurity();
    expect(() =>
      ensureAgyProfileKeychain(home, { platform: "darwin", runSecurity: security.run }),
    ).toThrow(/canonical|keychain/i);
    expect(security.calls).toHaveLength(0);
  });

  it("refuses a stale bootstrap symlink before invoking security", () => {
    const home = profileHome();
    const bootstrap = join(home, "Library", "Keychains", ".agy-profile-bootstrap.keychain-db");
    const outside = mkdtempSync(join(tmpdir(), "agy-keychain-bootstrap-outside-"));
    roots.push(outside);
    mkdirSync(dirname(bootstrap), { recursive: true, mode: 0o700 });
    symlinkSync(outside, bootstrap);
    const security = fakeSecurity();
    try {
      ensureAgyProfileKeychain(home, { platform: "darwin", runSecurity: security.run });
      throw new Error("expected bootstrap symlink refusal");
    } catch (error) {
      expect(isAgyProfileKeychainUnsafe(error)).toBe(true);
      expect(error).toMatchObject({ code: "agy_profile_keychain_unavailable" });
    }
    expect(security.calls).toHaveLength(0);
  });

  it("does nothing on non-Darwin platforms", () => {
    const home = profileHome();
    const security = fakeSecurity();
    prepareAgyProfileKeychain(home, { platform: "linux", runSecurity: security.run });
    prepareAgyProfileKeychain(home, { platform: "win32", runSecurity: security.run });
    expect(security.calls).toHaveLength(0);
    expect(existsSync(join(home, "Library"))).toBe(false);
  });

  it("does not hide a failed create behind a missing target", () => {
    const home = profileHome();
    const security = fakeSecurity({ createFile: false, createStatus: 1 });
    try {
      ensureAgyProfileKeychain(home, { platform: "darwin", runSecurity: security.run });
      throw new Error("expected missing target refusal");
    } catch (error) {
      expect(isAgyProfileKeychainUnsafe(error)).toBe(true);
      expect(error).toMatchObject({ code: "agy_profile_keychain_unavailable" });
    }
    expect(existsSync(agyProfileKeychainPath(home))).toBe(false);
  });

  it("does not memoize a failed unlock or settings call", () => {
    const home = profileHome();
    let failUnlock = true;
    const security = fakeSecurity();
    const run = (args: readonly string[], env: NodeJS.ProcessEnv) => {
      const result = security.run(args, env);
      if (args[0] === "unlock-keychain" && failUnlock) {
        failUnlock = false;
        return { status: 1 };
      }
      return result;
    };
    expect(() =>
      ensureAgyProfileKeychain(home, { platform: "darwin", runSecurity: run }),
    ).toThrow();
    expect(() =>
      ensureAgyProfileKeychain(home, { platform: "darwin", runSecurity: run }),
    ).not.toThrow();
    expect(security.calls.filter((call) => call.args[0] === "unlock-keychain")).toHaveLength(2);
  });

  it("retries settings after a recoverable first settings failure", () => {
    const home = profileHome();
    let failSettings = true;
    const security = fakeSecurity();
    const run = (args: readonly string[], env: NodeJS.ProcessEnv) => {
      const result = security.run(args, env);
      if (args[0] === "set-keychain-settings" && failSettings) {
        failSettings = false;
        return { status: 1 };
      }
      return result;
    };
    expect(() =>
      ensureAgyProfileKeychain(home, { platform: "darwin", runSecurity: run }),
    ).toThrow();
    expect(() =>
      ensureAgyProfileKeychain(home, { platform: "darwin", runSecurity: run }),
    ).not.toThrow();
    expect(security.calls.filter((call) => call.args[0] === "unlock-keychain")).toHaveLength(2);
    expect(security.calls.filter((call) => call.args[0] === "set-keychain-settings")).toHaveLength(
      2,
    );
  });

  it("tightens an existing regular file without replacing it", () => {
    const home = profileHome();
    const keychain = agyProfileKeychainPath(home);
    mkdirSync(dirname(keychain), { recursive: true, mode: 0o700 });
    writeFileSync(keychain, "existing", { mode: 0o644 });
    chmodSync(keychain, 0o644);
    const security = fakeSecurity();
    ensureAgyProfileKeychain(home, { platform: "darwin", runSecurity: security.run });
    expect(statSync(keychain).mode & 0o777).toBe(0o600);
    expect(security.calls.some((call) => call.args[0] === "create-keychain")).toBe(false);
  });
});
