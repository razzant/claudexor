import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLEAN_ENV_ALLOWLIST,
  composeBaseEnv,
  PROVIDER_SECRET_ENV,
  providerScrubEnv,
} from "./env-scope.js";

// A guaranteed-non-launchable execPath so the QA-022 managed-runner prepend is
// suppressed and these cases keep asserting the HOME-derived preferred order.
const NO_RUNNER = "/no/such/node";

describe("providerScrubEnv", () => {
  it("scrubs cross-provider secrets (codex must not inherit anthropic; claude not openai)", () => {
    const scrub = providerScrubEnv();
    expect(scrub.OPENAI_API_KEY).toBeNull();
    expect(scrub.ANTHROPIC_API_KEY).toBeNull();
    expect(scrub.CLAUDE_CODE_OAUTH_TOKEN).toBeNull();
    expect(scrub.CODEX_ACCESS_TOKEN).toBeNull();
    expect(scrub.CLAUDE_CODE_USE_FOUNDRY).toBeNull();
    expect(scrub.ANTHROPIC_FOUNDRY_AUTH_TOKEN).toBeNull();
    expect(scrub.AZURE_CLIENT_SECRET).toBeNull();
    expect(scrub.OPENROUTER_API_KEY).toBeNull();
    expect(scrub.AWS_SECRET_ACCESS_KEY).toBeNull();
    // base-URL redirects are always scrubbed (cannot exfiltrate a seeded cred).
    expect(scrub.OPENAI_BASE_URL).toBeNull();
    expect(scrub.ANTHROPIC_BASE_URL).toBeNull();
  });

  it("keeps only the one var the chosen route legitimately needs", () => {
    const scrub = providerScrubEnv(["ANTHROPIC_API_KEY"]);
    expect("ANTHROPIC_API_KEY" in scrub).toBe(false); // kept (the adapter sets it)
    expect(scrub.OPENAI_API_KEY).toBeNull(); // every other provider still scrubbed
  });

  it("covers both major provider key vars", () => {
    expect(PROVIDER_SECRET_ENV).toContain("OPENAI_API_KEY");
    expect(PROVIDER_SECRET_ENV).toContain("ANTHROPIC_API_KEY");
  });

  it("scrubs raw-api credentials and redirect config", () => {
    const scrub = providerScrubEnv();
    expect(scrub.CLAUDEXOR_RAWAPI_KEY).toBeNull();
    expect(scrub.CLAUDEXOR_RAWAPI_BASE_URL).toBeNull();
  });
});

describe("composeBaseEnv (env_inheritance)", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    SECRET_THING: "leak",
    OPENAI_API_KEY: "sk-xxx",
    FOO_TOKEN: "bar",
    HTTPS_PROXY: "http://proxy:8080",
    NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
  };

  it("mirror_native copies the whole parent env", () => {
    const env = composeBaseEnv("mirror_native", source, NO_RUNNER);
    expect(env.PATH?.split(":").slice(0, 3)).toEqual([
      "/home/x/.claudexor/node/bin",
      "/home/x/.local/bin",
      "/home/x/.npm-global/bin",
    ]);
    expect(env.PATH?.split(":")).toContain("/usr/bin");
    expect(env.SECRET_THING).toBe("leak");
    expect(env.OPENAI_API_KEY).toBe("sk-xxx");
  });

  it("clean keeps only the minimal allowlist (agent isolation): no arbitrary or provider vars leak", () => {
    const env = composeBaseEnv("clean", source, NO_RUNNER);
    expect(env.PATH?.split(":").slice(0, 3)).toEqual([
      "/home/x/.claudexor/node/bin",
      "/home/x/.local/bin",
      "/home/x/.npm-global/bin",
    ]);
    expect(env.PATH?.split(":")).toContain("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    expect("SECRET_THING" in env).toBe(false);
    expect("FOO_TOKEN" in env).toBe(false);
    expect("OPENAI_API_KEY" in env).toBe(false);
    expect(CLEAN_ENV_ALLOWLIST).toContain("PATH");
    expect(CLEAN_ENV_ALLOWLIST).not.toContain("OPENAI_API_KEY");
    // Proxy + TLS-CA infra vars survive clean mode (egress/TLS must keep working).
    expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ca.pem");
  });
});

describe("composeBaseEnv managed-runner Node prepend rides every lane class (QA-022)", () => {
  let root: string;
  let fakeNode: string;
  let runnerDir: string;

  beforeEach(() => {
    // Canonicalize: the managed-runner prepend now anchors the REAL binary's dir
    // (realpath), and on macOS tmpdir is /var -> /private/var.
    root = realpathSync(mkdtempSync(join(tmpdir(), "env-scope-runner-")));
    runnerDir = join(root, "app-node");
    mkdirSync(runnerDir, { recursive: true });
    fakeNode = join(runnerDir, "node");
    writeFileSync(fakeNode, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeNode, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // The three lane classes (INV-067) differ only in the scoped HOME + per-harness
  // config dirs layered on top of the base env; the base env — and its PATH — is
  // the SAME composeBaseEnv output for all of them. Proving the prepend for each
  // scoped-HOME shape, under both inheritance modes, covers every lane.
  const laneEnv = (homeDir: string): Record<string, string> => ({
    HOME: homeDir,
    CODEX_HOME: join(homeDir, ".codex"),
    CLAUDE_CONFIG_DIR: join(homeDir, ".claude"),
    XDG_CONFIG_HOME: join(homeDir, ".config"),
  });

  // Relative HOME suffix per lane; the absolute dir is built inside each test
  // once the per-test `root` exists.
  const lanes: Array<[string, string[]]> = [
    ["read-only scoped HOME", ["ro-home"]],
    ["isolated envelope", ["envelope", "home"]],
    ["in-place", ["inplace-home"]],
  ];

  for (const mode of ["mirror_native", "clean"] as const) {
    for (const [label, homeSuffix] of lanes) {
      it(`${mode}: ${label} lane env keeps the managed-runner dir first on PATH`, () => {
        const homeDir = join(root, ...homeSuffix);
        // A hostile parent PATH with an ad-hoc Homebrew Node first: the QA-022
        // grandchild-shell hazard. The spawn layer merges the lane's scoped env
        // (HOME etc.) ON TOP of composeBaseEnv, and the lane env carries no PATH.
        const parent = { HOME: "/parent", PATH: "/opt/homebrew/bin:/usr/bin" };
        const base = composeBaseEnv(mode, parent, fakeNode, "darwin");
        const spawnEnv = { ...base, ...laneEnv(homeDir) };
        const entries = (spawnEnv.PATH ?? "").split(delimiter);
        // The exact Node the daemon runs on wins over the killable Homebrew one.
        expect(entries[0]).toBe(runnerDir);
        expect(entries[0]).toBe(dirname(fakeNode));
        // Never removes existing entries — /usr/bin still resolvable downstream.
        expect(entries).toContain("/usr/bin");
        // The lane's scoped HOME is the effective HOME the harness child sees.
        expect(spawnEnv.HOME).toBe(homeDir);
      });
    }
  }

  it("does NOT prepend when the runner Node is itself an at-risk Homebrew build", () => {
    const brewNode = "/opt/homebrew/bin/node";
    const parent = { HOME: "/parent", PATH: "/usr/bin" };
    const base = composeBaseEnv("mirror_native", parent, brewNode, "darwin");
    // Prepending a killable Node's dir would poison the very shell we protect.
    expect((base.PATH ?? "").split(delimiter)[0]).not.toBe(dirname(brewNode));
    expect((base.PATH ?? "").split(delimiter)[0]).toBe("/parent/.claudexor/node/bin");
  });
});
