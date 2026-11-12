/**
 * #572: the daemon's one credential-invalidation owner also voids the Claude
 * model picker the adapter caches per profile. Offline: a stub `claude` on disk
 * answers the prompt-free initialize probe from a side file, so the account
 * behind a profile can change while the binary identity, the other half of the
 * cache key, stays the same. No vendor binary, account, keychain or network.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAccountEvidence, type QuotaRegistry } from "@claudexor/daemon";
import { createClaudeAdapter } from "@claudexor/harness-claude";
import type { CredentialProfile } from "@claudexor/schema";
import { CLAUDE_INIT_REQUEST_ID } from "../../harness-claude/src/interactive.js";
import {
  bustCredentialStatusCaches,
  bustGlobalCredentialStatusCaches,
  bustLoginCredentialState,
} from "./credential-status-invalidation.js";

// Select the offline fixture for every dynamic program observation.
const stub = vi.hoisted(() => {
  const dir = `${(process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "")}/claudexor-572-picker-${process.pid}`;
  process.env.CLAUDEXOR_CLAUDE_BIN = `${dir}/claude`;
  return { dir, bin: `${dir}/claude`, answer: `${dir}/answer`, spawns: `${dir}/spawns` };
});

beforeAll(() => {
  mkdirSync(stub.dir, { recursive: true });
  writeFileSync(
    stub.bin,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; exit 0; fi\necho spawn >> "${stub.spawns}"\n/bin/cat "${stub.answer}"\n`,
    { mode: 0o755 },
  );
});
afterAll(() => rmSync(stub.dir, { recursive: true, force: true }));

/** The account whose picker the profile's store now answers with. */
function signIn(account: string): void {
  writeFileSync(
    stub.answer,
    JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: CLAUDE_INIT_REQUEST_ID,
        response: { models: [{ value: account, displayName: account, resolvedModel: account }] },
      },
    }) + "\n",
  );
}
const spawns = () =>
  existsSync(stub.spawns)
    ? readFileSync(stub.spawns, "utf8").split("\n").filter(Boolean).length
    : 0;

const work = {
  profile_id: "work",
  harness_id: "claude",
  display_name: "Work",
  credential_kind: "config_dir_login",
  isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR as string, "profiles", "claude", "work"),
  secret_ref: null,
  enabled: true,
  created_at: null,
} as CredentialProfile;
const keyed = {
  ...work,
  profile_id: "keyed",
  credential_kind: "api_key",
  isolation_locator: null,
  secret_ref: "anthropic:keyed",
} as CredentialProfile;

const adapter = createClaudeAdapter({
  resolveProfileSecret: (ref) => (ref === "anthropic:keyed" ? "placeholder-not-a-key" : null),
});
async function picker(profile: CredentialProfile, fresh = false): Promise<string[]> {
  const rows = await adapter.models!({ cwd: stub.dir, credentialProfile: profile, fresh });
  return rows.filter((row) => row.origin === "live").map((row) => row.id);
}

const accounts = createAccountEvidence();
/** A later invalidation step can throw while a global quota generation
 * awaits recovery; it must not prevent the earlier model-cache clear. */
const failingQuota = () =>
  ({
    noteCredentialChange() {
      throw new Error("quota generation awaiting recovery");
    },
  }) as unknown as QuotaRegistry;
const readiness = { invalidate() {} };

describe("a credential change the daemon observes voids the cached Claude picker (#572)", () => {
  beforeAll(() => mkdirSync(work.isolation_locator as string, { recursive: true }));

  it.each([
    [
      "a setup-job login window opening or closing, a re-login into the same profile included",
      work,
      () => bustLoginCredentialState(failingQuota, accounts, readiness, "claude"),
    ],
    [
      "a daemon-observed login lifecycle",
      work,
      () => bustGlobalCredentialStatusCaches(failingQuota, accounts),
    ],
    [
      "the profile's removal before its id is reused",
      work,
      () =>
        bustCredentialStatusCaches(failingQuota, accounts, {
          harnessId: "claude",
          profileId: "work",
        }),
    ],
    [
      // A deleted key needs no clear: a credential scope without its secret
      // answers the hint rows before the cache is read.
      "a new key stored under the profile's secret",
      keyed,
      () => bustCredentialStatusCaches(failingQuota, accounts, { secretName: "anthropic:keyed" }),
    ],
    [
      "a mutation without a subject (migration rollback, failed cleanup)",
      work,
      () => bustCredentialStatusCaches(failingQuota, accounts),
    ],
  ])("%s, even when the quota step after it throws", async (_label, profile, change) => {
    signIn("first-account");
    expect(await picker(profile, true)).toEqual(["first-account"]);
    const spawned = spawns();
    // Another account now answers for the same profile: same scope key, same binary.
    signIn("second-account");
    expect(await picker(profile)).toEqual(["first-account"]);
    expect(change).toThrow("quota generation awaiting recovery");
    expect(await picker(profile)).toEqual(["second-account"]);
    expect(spawns()).toBe(spawned + 1);
    // The probe after the change caches normally.
    expect(await picker(profile)).toEqual(["second-account"]);
    expect(spawns()).toBe(spawned + 1);
  });
});
