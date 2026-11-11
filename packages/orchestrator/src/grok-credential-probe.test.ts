/** The credential-differential consumer of the REAL Grok login probe: a
 * scripted stand-in for `grok models` is captured exactly as in production.
 * No Grok binary, account, token or network is involved. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialProfile } from "@claudexor/schema";
import { createGrokAdapter } from "../../harness-grok/src/index.js";
import { probeGrokLogin } from "../../harness-grok/src/models.js";
import { differentialSubjectVerdict } from "./credential-differential.js";

const RECOGNIZED_AUTH = {
  "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": { key: "synthetic-placeholder" },
};
let bins = "";
let home = "";
let previousBin: string | undefined;

beforeEach(() => {
  previousBin = process.env.CLAUDEXOR_GROK_BIN;
  bins = mkdtempSync(join(tmpdir(), "grok-differential-bin-"));
  home = join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", "grok-differential");
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok", "auth.json"), JSON.stringify(RECOGNIZED_AUTH));
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

async function verdict(budgetMs?: number) {
  const profile = CredentialProfile.parse({
    profile_id: "grok-differential",
    harness_id: "grok",
    display_name: "differential",
    credential_kind: "config_dir_login",
    isolation_locator: home,
  });
  const adapter = createGrokAdapter({
    probeLogin: (env, signal) => probeGrokLogin(env, signal, budgetMs),
  });
  return differentialSubjectVerdict({
    harnessId: "grok",
    profile,
    model: null,
    quota: { snapshots: [], absences: [] },
    transients: [],
    probe: (candidate) => adapter.probeCredentialProfile!(candidate),
  });
}

describe.skipIf(process.platform === "win32")(
  "Grok probe evidence in the credential differential",
  () => {
    it("does not record a one-hour dead credential for a probe that timed out", async () => {
      fakeGrok("sleep 30");
      expect(await verdict(300)).toBeNull();
    }, 40_000);

    it("does not record one for a banner followed by a failing exit", async () => {
      fakeGrok('echo "You are logged in with grok.com."; exit 3');
      expect(await verdict()).toBeNull();
    });

    it.each([
      'echo "Error: not logged in. Run grok login." >&2; exit 1',
      'echo "HTTP 401 Unauthorized" >&2; exit 1',
    ])("does not record one for auth wording no vendor transcript defines: %s", async (body) => {
      fakeGrok(body);
      expect(await verdict()).toBeNull();
    });

    it("does not record one for a login line that names another issuer", async () => {
      fakeGrok('echo "You are logged in with Example SSO."');
      expect(await verdict()).toBeNull();
    });

    it("still records a definite refusal the probe reports (contract control)", async () => {
      const profile = CredentialProfile.parse({
        profile_id: "grok-differential",
        harness_id: "grok",
        display_name: "differential",
        credential_kind: "config_dir_login",
        isolation_locator: home,
      });
      const adapter = createGrokAdapter({
        probeLogin: async () => ({ authenticated: false, models: [], detail: "refused" }),
      });
      expect(
        await differentialSubjectVerdict({
          harnessId: "grok",
          profile,
          model: null,
          quota: { snapshots: [], absences: [] },
          transients: [],
          probe: (candidate) => adapter.probeCredentialProfile!(candidate),
        }),
      ).toMatchObject({ code: "verification_failed", source: "local_probe" });
    });
  },
);
