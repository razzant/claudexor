import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CredentialProfile } from "@claudexor/schema";
import { userConfigDir } from "@claudexor/util";
import { detectGrokVersion } from "./bin.js";
import { createGrokAdapter } from "./index.js";
import { probeGrokLogin } from "./models.js";
import { grokProfileEnv } from "./profile.js";

// Real `runCapture` against a scripted stand-in for the vendor CLI: exit
// status, signals, budgets and pipe drain are observed exactly as in
// production. No Grok binary, account, token or network is involved.
// The line the probe expects; no `grok models` transcript is recorded.
const BANNER = "You are logged in with grok.com.";
// The private layout the donor gate recognized. A placeholder, never a token.
const RECOGNIZED_AUTH = {
  "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": { key: "synthetic-placeholder" },
};
const posix = process.platform !== "win32";

let bins = "";
let home = "";
let previousBin: string | undefined;

beforeEach(() => {
  previousBin = process.env.CLAUDEXOR_GROK_BIN;
  bins = mkdtempSync(join(tmpdir(), "grok-probe-bin-"));
  const profiles = join(userConfigDir(), "profiles");
  mkdirSync(profiles, { recursive: true });
  home = mkdtempSync(join(profiles, "grok-probe-"));
});

afterEach(() => {
  if (previousBin === undefined) delete process.env.CLAUDEXOR_GROK_BIN;
  else process.env.CLAUDEXOR_GROK_BIN = previousBin;
  rmSync(bins, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function fakeGrok(body: string): void {
  const path = join(bins, "grok");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  process.env.CLAUDEXOR_GROK_BIN = path;
}

function authFile(content: unknown): void {
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok", "auth.json"), JSON.stringify(content), { mode: 0o600 });
}

const profile = (): CredentialProfile => ({
  profile_id: "grok-probe",
  harness_id: "grok",
  display_name: "probe",
  credential_kind: "config_dir_login",
  isolation_locator: home,
  secret_ref: null,
  enabled: true,
  created_at: null,
});

describe.skipIf(!posix)("Grok login probe outcomes (real process capture)", () => {
  it("asks the official CLI even when the private auth.json layout changed", async () => {
    authFile({ session: { token: "synthetic-placeholder" } });
    fakeGrok(`echo "${BANNER}"; echo " - grok-4.7"; echo " * grok-4.7-build-fast (default)"`);
    const probe = await probeGrokLogin(grokProfileEnv(home));
    expect(probe).toMatchObject({ authenticated: true });
    expect(probe.models.map((model) => model.id)).toEqual(["grok-4.7", "grok-4.7-build-fast"]);
  });

  it.each([
    // Another login method's line, and grok.com as the prefix of another
    // value. An API-key line never verifies a grok.com login either.
    "You are logged in with Example SSO.",
    "You are logged in with grok.com.example.",
    "You are using XAI_API_KEY.",
  ])("verifies only the whole grok.com login line, not: %s", async (line) => {
    fakeGrok(`echo "${line}"; echo " - grok-4.7"`);
    const probe = await probeGrokLogin(grokProfileEnv(home));
    expect(probe).toMatchObject({ authenticated: false, failed: true, models: [] });
    expect(probe.detail).toMatch(/did not confirm a grok\.com login/);
  });

  it("accepts that line indented or with CRLF endings (control)", async () => {
    fakeGrok(`printf '  %s\\r\\n - grok-4.7\\r\\n' "${BANNER}"`);
    const probe = await probeGrokLogin(grokProfileEnv(home));
    expect(probe).toMatchObject({ authenticated: true });
    expect(probe.models.map((model) => model.id)).toEqual(["grok-4.7"]);
  });

  it("does not accept the login banner from a process that then fails", async () => {
    authFile(RECOGNIZED_AUTH);
    fakeGrok(`echo "${BANNER}"; echo " - grok-4.7"; exit 3`);
    const probe = await probeGrokLogin(grokProfileEnv(home));
    expect(probe).toMatchObject({ authenticated: false, failed: true, models: [] });
    expect(probe.detail).toContain("exit 3");
  });

  it("treats a probe that outlives its budget as unknown, never as a refusal", async () => {
    authFile(RECOGNIZED_AUTH);
    fakeGrok("sleep 30");
    const probe = await probeGrokLogin(grokProfileEnv(home), undefined, 300);
    expect(probe).toMatchObject({ authenticated: false, failed: true });
    expect(probe.detail).toMatch(/did not answer/);
  }, 40_000);

  it("does not trust output that a surviving descendant kept open", async () => {
    authFile(RECOGNIZED_AUTH);
    // The background child outlives the 2s post-exit drain window by a margin.
    fakeGrok(`echo "${BANNER}"; sleep 8 &\nexit 0`);
    const probe = await probeGrokLogin(grokProfileEnv(home));
    expect(probe).toMatchObject({ authenticated: false, failed: true });
    expect(probe.detail).toMatch(/truncated/);
  }, 20_000);

  it.each([
    // Synthetic texts: no logged-out transcript of `grok models` is recorded,
    // and a generic 401 may come from a proxy or backend, not this account.
    'echo "Error: not logged in. Run grok login." >&2; exit 1',
    'echo "HTTP 401 Unauthorized" >&2; exit 1',
    'echo "unauthenticated"; exit 0',
  ])("keeps unrecorded auth wording unknown, never a dead credential: %s", async (body) => {
    fakeGrok(body);
    const probe = await probeGrokLogin(grokProfileEnv(home));
    expect(probe).toMatchObject({ authenticated: false, failed: true });
    expect(probe.detail).toMatch(/login state is unknown/);
  });

  it("discovers the version with the vendor auto-updater switched off", async () => {
    fakeGrok('[ "$GROK_DISABLE_AUTOUPDATER" = 1 ] && echo "grok 1.0.67" || exit 1');
    expect(await detectGrokVersion()).toBe("1.0.67");
  });

  it("reports a binary that cannot start as unknown (control)", async () => {
    authFile(RECOGNIZED_AUTH);
    process.env.CLAUDEXOR_GROK_BIN = join(bins, "missing-grok");
    const probe = await probeGrokLogin(grokProfileEnv(home));
    expect(probe).toMatchObject({ authenticated: false, failed: true });
  });

  it("projects the outcomes onto distinct profile statuses", async () => {
    authFile(RECOGNIZED_AUTH);
    const adapter = createGrokAdapter();
    fakeGrok(`echo "${BANNER}"`);
    // The line proves a grok.com login, not a plan or subscription tier.
    expect(await adapter.probeCredentialProfile!(profile())).toMatchObject({
      availability: "available",
      verification: "passed",
      verification_source: "vendor",
      detail: "Grok CLI reported a grok.com login",
    });
    fakeGrok('echo "Error: not logged in. Run grok login." >&2; exit 1');
    expect(await adapter.probeCredentialProfile!(profile())).toMatchObject({
      availability: "unknown",
      verification: "not_run",
    });
    // A login the CLI reports for another issuer is not a grok.com login.
    fakeGrok('echo "You are logged in with Example SSO."');
    expect(await adapter.probeCredentialProfile!(profile())).toMatchObject({
      availability: "unknown",
      verification: "not_run",
    });
    fakeGrok(`echo "${BANNER}"; exit 3`);
    expect(await adapter.probeCredentialProfile!(profile())).toMatchObject({
      availability: "unknown",
      verification: "not_run",
    });
    // Only the hanging case gets a short budget, so the test stays quick.
    fakeGrok("sleep 30");
    const hanging = createGrokAdapter({
      probeLogin: (env, signal) => probeGrokLogin(env, signal, 300),
    });
    expect(await hanging.probeCredentialProfile!(profile())).toMatchObject({
      availability: "unknown",
      verification: "not_run",
    });
  }, 60_000);
});
