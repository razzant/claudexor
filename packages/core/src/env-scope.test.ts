import { describe, expect, it } from "vitest";
import { CLEAN_ENV_ALLOWLIST, composeBaseEnv, PROVIDER_SECRET_ENV, providerScrubEnv } from "./env-scope.js";

describe("providerScrubEnv", () => {
  it("scrubs cross-provider secrets (codex must not inherit anthropic; claude not openai)", () => {
    const scrub = providerScrubEnv();
    expect(scrub.OPENAI_API_KEY).toBeNull();
    expect(scrub.ANTHROPIC_API_KEY).toBeNull();
    expect(scrub.CLAUDE_CODE_OAUTH_TOKEN).toBeNull();
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
  const source = { PATH: "/usr/bin", HOME: "/home/x", SECRET_THING: "leak", OPENAI_API_KEY: "sk-xxx", FOO_TOKEN: "bar", HTTPS_PROXY: "http://proxy:8080", NODE_EXTRA_CA_CERTS: "/etc/ca.pem" };

  it("mirror_native copies the whole parent env", () => {
    const env = composeBaseEnv("mirror_native", source);
    expect(env.PATH?.split(":").slice(0, 3)).toEqual(["/home/x/.claudex/node/bin", "/home/x/.claudexor/node/bin", "/home/x/.local/bin"]);
    expect(env.PATH?.split(":")).toContain("/usr/bin");
    expect(env.SECRET_THING).toBe("leak");
    expect(env.OPENAI_API_KEY).toBe("sk-xxx");
  });

  it("clean keeps only the minimal allowlist (agent isolation): no arbitrary or provider vars leak", () => {
    const env = composeBaseEnv("clean", source);
    expect(env.PATH?.split(":").slice(0, 3)).toEqual(["/home/x/.claudex/node/bin", "/home/x/.claudexor/node/bin", "/home/x/.local/bin"]);
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
