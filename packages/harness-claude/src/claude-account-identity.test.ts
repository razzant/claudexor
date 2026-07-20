import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeAccountIdentity } from "./native-home.js";

// Pure, daemon-side claude identity reader (INV-067): projects ONLY the
// allowlisted {email, plan} out of a Claudexor-owned .claude.json oauthAccount,
// never token material, and NEVER reads a store outside the owned root.

function writeClaudeConfig(dir: string, oauthAccount: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({
      // A realistic .claude.json also holds sessions/tokens — none of which may
      // ever surface in the projection.
      oauthAccount,
      cachedChangelog: "irrelevant",
    }),
  );
}

const FULL_ACCOUNT = {
  accountUuid: "uuid-secret",
  emailAddress: "dev@example.test",
  organizationUuid: "org-secret",
  billingType: "stripe_subscription",
  organizationType: "claude_max",
  organizationRole: "admin",
  organizationName: "dev@example.test's Organization",
};

describe("claudeAccountIdentity", () => {
  let ownedRoot: string;
  let prevConfig: string | undefined;

  beforeEach(() => {
    ownedRoot = mkdtempSync(join(tmpdir(), "claudexor-claude-id-"));
    prevConfig = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = ownedRoot;
  });
  afterEach(() => {
    if (prevConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prevConfig;
    rmSync(ownedRoot, { recursive: true, force: true });
  });

  it("projects {email, plan} from a valid oauthAccount in an owned store", () => {
    const dir = join(ownedRoot, "profiles", "claude-work");
    writeClaudeConfig(dir, FULL_ACCOUNT);
    expect(claudeAccountIdentity(dir)).toEqual({ email: "dev@example.test", plan: "claude_max" });
  });

  it("returns only email when organizationType is absent", () => {
    const dir = join(ownedRoot, "native", "claude", "default");
    writeClaudeConfig(dir, { emailAddress: "solo@example.test" });
    expect(claudeAccountIdentity(dir)).toEqual({ email: "solo@example.test" });
  });

  it("never returns fields outside the allowlist (no uuids, tokens, org names)", () => {
    const dir = join(ownedRoot, "profiles", "claude-allowlist");
    writeClaudeConfig(dir, FULL_ACCOUNT);
    const identity = claudeAccountIdentity(dir);
    expect(Object.keys(identity ?? {}).sort()).toEqual(["email", "plan"]);
    const serialized = JSON.stringify(identity);
    expect(serialized).not.toContain("uuid-secret");
    expect(serialized).not.toContain("org-secret");
    expect(serialized).not.toContain("Organization");
  });

  it("is null when oauthAccount is missing or not an object", () => {
    const noAccount = join(ownedRoot, "profiles", "claude-no-account");
    writeClaudeConfig(noAccount, undefined);
    expect(claudeAccountIdentity(noAccount)).toBeNull();
    const badAccount = join(ownedRoot, "profiles", "claude-bad-account");
    writeClaudeConfig(badAccount, "not-an-object");
    expect(claudeAccountIdentity(badAccount)).toBeNull();
  });

  it("is null when oauthAccount discloses neither email nor plan", () => {
    const dir = join(ownedRoot, "profiles", "claude-empty");
    writeClaudeConfig(dir, { accountUuid: "uuid-only" });
    expect(claudeAccountIdentity(dir)).toBeNull();
  });

  it("is null for a missing .claude.json and for malformed JSON", () => {
    expect(claudeAccountIdentity(join(ownedRoot, "profiles", "absent"))).toBeNull();
    const dir = join(ownedRoot, "profiles", "claude-bad-json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".claude.json"), "{ not json");
    expect(claudeAccountIdentity(dir)).toBeNull();
  });

  it("is null for empty/undefined config dirs", () => {
    expect(claudeAccountIdentity("")).toBeNull();
    expect(claudeAccountIdentity(null)).toBeNull();
    expect(claudeAccountIdentity(undefined)).toBeNull();
  });

  it("REFUSES to read a store outside the Claudexor-owned root (never the ordinary ~/.claude), even with a valid oauthAccount", () => {
    const vendorDir = mkdtempSync(join(tmpdir(), "ordinary-dot-claude-"));
    try {
      writeClaudeConfig(vendorDir, FULL_ACCOUNT);
      expect(claudeAccountIdentity(vendorDir)).toBeNull();
    } finally {
      rmSync(vendorDir, { recursive: true, force: true });
    }
  });
});
