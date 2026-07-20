import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexAccountIdentity } from "./profile.js";

// Pure, daemon-side codex identity reader (INV-067): projects ONLY the
// allowlisted {email, plan} out of a Claudexor-owned auth.json id_token, never
// token material, and NEVER reads a store outside the Claudexor-owned root.

/** A SYNTHETIC (never real) JWT: base64url header.payload.<dummy-sig>. */
function fakeJwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(payload)}.c2lnbmF0dXJl`;
}

function writeAuth(home: string, idToken: unknown): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken,
        access_token: "synthetic-access-token",
        refresh_token: "synthetic-refresh-token",
        account_id: "acct-123",
      },
      last_refresh: "2026-07-19T00:00:00.000Z",
    }) + "\n",
  );
}

describe("codexAccountIdentity", () => {
  let ownedRoot: string;
  let prevConfig: string | undefined;

  beforeEach(() => {
    ownedRoot = mkdtempSync(join(tmpdir(), "claudexor-codex-id-"));
    prevConfig = process.env.CLAUDEXOR_CONFIG_DIR;
    // Under an explicit override, the override IS the complete owned root.
    process.env.CLAUDEXOR_CONFIG_DIR = ownedRoot;
  });
  afterEach(() => {
    if (prevConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prevConfig;
    rmSync(ownedRoot, { recursive: true, force: true });
  });

  it("projects {email, plan} from a valid id_token in an owned store", () => {
    const home = join(ownedRoot, "profiles", "codex-work");
    writeAuth(
      home,
      fakeJwt({
        email: "dev@example.test",
        "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_user_id: "u-1" },
      }),
    );
    expect(codexAccountIdentity(home)).toEqual({ email: "dev@example.test", plan: "pro" });
  });

  it("returns only the disclosed fields (plan present, email absent)", () => {
    const home = join(ownedRoot, "profiles", "codex-plan-only");
    writeAuth(home, fakeJwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "team" } }));
    expect(codexAccountIdentity(home)).toEqual({ plan: "team" });
  });

  it("never returns token material — only email and plan keys", () => {
    const home = join(ownedRoot, "native", "codex");
    writeAuth(
      home,
      fakeJwt({
        email: "dev@example.test",
        "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
      }),
    );
    const identity = codexAccountIdentity(home);
    expect(Object.keys(identity ?? {}).sort()).toEqual(["email", "plan"]);
    const serialized = JSON.stringify(identity);
    expect(serialized).not.toContain("synthetic-access-token");
    expect(serialized).not.toContain("synthetic-refresh-token");
    expect(serialized).not.toContain("id_token");
  });

  it("is null for a malformed JWT id_token", () => {
    const home = join(ownedRoot, "profiles", "codex-bad-jwt");
    writeAuth(home, "not-a-jwt");
    expect(codexAccountIdentity(home)).toBeNull();
  });

  it("is null when tokens.id_token is absent", () => {
    const home = join(ownedRoot, "profiles", "codex-no-token");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "apikey" }));
    expect(codexAccountIdentity(home)).toBeNull();
  });

  it("is null when the JWT discloses neither email nor plan", () => {
    const home = join(ownedRoot, "profiles", "codex-empty-claims");
    writeAuth(home, fakeJwt({ sub: "u-1", aud: "app" }));
    expect(codexAccountIdentity(home)).toBeNull();
  });

  it("is null for a missing auth.json and for malformed JSON", () => {
    expect(codexAccountIdentity(join(ownedRoot, "profiles", "absent"))).toBeNull();
    const home = join(ownedRoot, "profiles", "codex-bad-json");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), "{ not json");
    expect(codexAccountIdentity(home)).toBeNull();
  });

  it("is null for empty/undefined homes", () => {
    expect(codexAccountIdentity("")).toBeNull();
    expect(codexAccountIdentity("   ")).toBeNull();
    expect(codexAccountIdentity(null)).toBeNull();
    expect(codexAccountIdentity(undefined)).toBeNull();
  });

  it("REFUSES to read a store outside the Claudexor-owned root (never the ordinary ~/.codex), even with a valid auth.json", () => {
    // A vendor-looking home OUTSIDE the owned root, holding a perfectly valid
    // id_token: the reader must return null WITHOUT reading it. This pins the
    // hard line — ordinary vendor homes are never in the probe list.
    const vendorHome = mkdtempSync(join(tmpdir(), "ordinary-dot-codex-"));
    try {
      writeAuth(
        vendorHome,
        fakeJwt({
          email: "leak@example.test",
          "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
        }),
      );
      expect(codexAccountIdentity(vendorHome)).toBeNull();
    } finally {
      rmSync(vendorHome, { recursive: true, force: true });
    }
  });
});
