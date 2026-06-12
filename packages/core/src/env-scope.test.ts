import { describe, expect, it } from "vitest";
import { PROVIDER_SECRET_ENV, providerScrubEnv } from "./env-scope.js";

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
});
