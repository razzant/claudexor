/**
 * #610: the daemon's one credential-invalidation owner also voids the Codex
 * model and effort catalog cached per (CODEX_HOME, binary). Offline: a stub
 * `codex` on disk answers the app-server's prompt-free `initialize` and
 * `model/list` from a side file in the home it runs under, so the account behind
 * a home can change while both halves of the cache key stay the same. No vendor
 * binary, account, keychain or network.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigParseError } from "@claudexor/config";
import { createAccountEvidence, type QuotaRegistry } from "@claudexor/daemon";
import { clearCodexEffortCache, createCodexAdapter } from "@claudexor/harness-codex";
import { CredentialProfile } from "@claudexor/schema";
import { nativeHarnessStateRoot } from "@claudexor/util";
import { accountObservations } from "./account-observations.js";
import {
  bustCredentialStatusCaches,
  bustGlobalCredentialStatusCaches,
  bustLoginCredentialState,
} from "./credential-status-invalidation.js";

// Select the offline fixture for every dynamic program observation.
const stub = vi.hoisted(() => {
  const dir = `${(process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "")}/claudexor-610-catalog-${process.pid}`;
  process.env.CLAUDEXOR_CODEX_BIN = `${dir}/codex`;
  return { dir, bin: `${dir}/codex` };
});

/**
 * What a vendor child holds after it starts: the store as it read it at launch.
 * The marker is written after that read, so a test that has seen the marker knows
 * the child already holds this account. A `hold` file makes the child wait for
 * `release` before it answers `model/list`, the same way a slow remote fetch does.
 */
const STUB_SOURCE = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("1.0.0"); process.exit(0); }
const { appendFileSync, existsSync, readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const home = process.env.CODEX_HOME;
const data = JSON.parse(readFileSync(join(home, "account.json"), "utf8"));
const held = existsSync(join(home, "hold"));
if (held) rmSync(join(home, "hold"));
appendFileSync(join(home, "spawns"), "spawn\\n");
const answer = (request) =>
  process.stdout.write(
    JSON.stringify({ id: request.id, result: request.method === "model/list" ? { data } : {} }) + "\\n",
  );
const input = require("node:readline").createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method !== "model/list" || !held) return answer(request);
  const wait = setInterval(() => {
    if (!existsSync(join(home, "release"))) return;
    clearInterval(wait);
    answer(request);
  }, 10);
});
`;

const configDir = () => process.env.CLAUDEXOR_CONFIG_DIR as string;

function profileNamed(id: string) {
  return CredentialProfile.parse({
    profile_id: id,
    harness_id: "codex",
    display_name: id,
    credential_kind: "config_dir_login",
    isolation_locator: join(configDir(), "profiles", "codex", id),
  });
}
const work = profileNamed("work");
const other = profileNamed("other");
const homeOf = (profile: CredentialProfile) => profile.isolation_locator as string;
const nativeHome = () => join(nativeHarnessStateRoot(), "codex");

/** The account whose catalog this home's store now answers with. */
function signIn(home: string, account: string, levels = ["low", "high"]): void {
  writeFileSync(
    join(home, "account.json"),
    JSON.stringify([
      {
        id: account,
        displayName: account,
        isDefault: true,
        defaultReasoningEffort: levels[0],
        supportedReasoningEfforts: levels.map((reasoningEffort) => ({ reasoningEffort })),
        serviceTiers: [],
      },
    ]),
  );
}
const spawns = (home: string) => {
  const path = join(home, "spawns");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0;
};
const holdNextChild = (home: string) => writeFileSync(join(home, "hold"), "");
const releaseHeldChild = (home: string) => writeFileSync(join(home, "release"), "");
/** The child has started and read its account. A hang detector, not a perf gate. */
const childStarted = (home: string) =>
  vi.waitFor(() => expect(spawns(home)).toBe(1), { timeout: 20_000 });

// The real adapter and the real app-server probe; only the executable is a stub.
const adapter = createCodexAdapter();
async function listed(profile: CredentialProfile): Promise<string[]> {
  const rows = await adapter.models!({ cwd: stub.dir, credentialProfile: profile });
  return rows.map((row) => row.id);
}

const accounts = createAccountEvidence();
const readiness = { invalidate() {} };
const quota = () => ({ noteCredentialChange() {} }) as unknown as QuotaRegistry;
/** A later invalidation step can throw while a global quota generation
 * awaits recovery; it must not prevent the earlier catalog clear. */
const failingQuota = () =>
  ({
    noteCredentialChange() {
      throw new Error("quota generation awaiting recovery");
    },
  }) as unknown as QuotaRegistry;

beforeAll(() => {
  mkdirSync(stub.dir, { recursive: true });
  writeFileSync(stub.bin, STUB_SOURCE, { mode: 0o755 });
});
afterAll(() => {
  clearCodexEffortCache();
  rmSync(stub.dir, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

beforeEach(() => {
  clearCodexEffortCache();
  for (const home of [homeOf(work), homeOf(other), nativeHome()]) {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
  }
});

// A POSIX stub; the Windows launch path has its own tests in core and harness-codex.
describe.skipIf(process.platform === "win32")(
  "a credential change the daemon observes voids the cached Codex catalog (#610)",
  () => {
    it.each([
      [
        "a setup-job login window opening or closing, a re-login into the same profile included",
        () => bustLoginCredentialState(failingQuota, accounts, readiness, "codex"),
      ],
      [
        "another harness's login window, because the clear has no scope",
        () => bustLoginCredentialState(failingQuota, accounts, readiness, "claude"),
      ],
      [
        "a daemon-observed login lifecycle",
        () => bustGlobalCredentialStatusCaches(failingQuota, accounts),
      ],
      [
        "the profile's removal before its id is reused",
        () =>
          bustCredentialStatusCaches(failingQuota, accounts, {
            harnessId: "codex",
            profileId: "work",
          }),
      ],
      [
        "a secret stored or deleted",
        () => bustCredentialStatusCaches(failingQuota, accounts, { secretName: "openai:keyed" }),
      ],
      [
        "a mutation without a subject (a settings save, migration rollback, failed cleanup)",
        () => bustCredentialStatusCaches(failingQuota, accounts),
      ],
    ])("%s, even when the quota step after it throws", async (_label, change) => {
      signIn(homeOf(work), "first-account");
      expect(await listed(work)).toEqual(["first-account"]);
      expect(spawns(homeOf(work))).toBe(1);
      // Another account now answers for the same home: same key, same binary.
      signIn(homeOf(work), "second-account");
      expect(await listed(work)).toEqual(["first-account"]);
      expect(spawns(homeOf(work))).toBe(1);
      expect(change).toThrow("quota generation awaiting recovery");
      expect(await listed(work)).toEqual(["second-account"]);
      expect(spawns(homeOf(work))).toBe(2);
      // The probe after the change caches normally.
      expect(await listed(work)).toEqual(["second-account"]);
      expect(spawns(homeOf(work))).toBe(2);
    });

    it("clears before the configuration read that can fail on a secret change", async () => {
      signIn(homeOf(work), "first-account");
      expect(await listed(work)).toEqual(["first-account"]);
      signIn(homeOf(work), "second-account");
      const config = join(configDir(), "config.yaml");
      writeFileSync(config, "credential_profiles: [unterminated\n");
      try {
        expect(() =>
          bustCredentialStatusCaches(quota, accounts, { secretName: "openai:keyed" }),
        ).toThrow(ConfigParseError);
      } finally {
        rmSync(config, { force: true });
      }
      expect(await listed(work)).toEqual(["second-account"]);
      expect(spawns(homeOf(work))).toBe(2);
    });

    it("a child running across the change answers its caller and keeps no answer", async () => {
      signIn(homeOf(work), "first-account");
      holdNextChild(homeOf(work));
      const late = listed(work);
      await childStarted(homeOf(work));
      signIn(homeOf(work), "second-account");
      bustLoginCredentialState(quota, accounts, readiness, "codex");
      releaseHeldChild(homeOf(work));
      // The caller asked before the change, so it gets what that child read...
      expect(await late).toEqual(["first-account"]);
      // ...and the next caller asks the home again rather than reading that answer.
      expect(await listed(work)).toEqual(["second-account"]);
      expect(spawns(homeOf(work))).toBe(2);
    });

    it("a child started inside an open login window keeps no answer past its close", async () => {
      signIn(homeOf(work), "first-account");
      bustLoginCredentialState(quota, accounts, readiness, "codex");
      holdNextChild(homeOf(work));
      const during = listed(work);
      await childStarted(homeOf(work));
      // The vendor login writes the store while that child waits.
      signIn(homeOf(work), "second-account");
      bustLoginCredentialState(quota, accounts, readiness, "codex");
      releaseHeldChild(homeOf(work));
      expect(await during).toEqual(["first-account"]);
      expect(await listed(work)).toEqual(["second-account"]);
      expect(spawns(homeOf(work))).toBe(2);
    });

    it("a child running across the change cannot overwrite the answer read after it", async () => {
      signIn(homeOf(work), "first-account");
      holdNextChild(homeOf(work));
      const late = listed(work);
      await childStarted(homeOf(work));
      signIn(homeOf(work), "second-account");
      bustLoginCredentialState(quota, accounts, readiness, "codex");
      expect(await listed(work)).toEqual(["second-account"]);
      expect(spawns(homeOf(work))).toBe(2);
      releaseHeldChild(homeOf(work));
      expect(await late).toEqual(["first-account"]);
      expect(await listed(work)).toEqual(["second-account"]);
      expect(spawns(homeOf(work))).toBe(2);
    });

    it("costs each home one prompt-free child again and keeps every home's own account", async () => {
      signIn(homeOf(work), "work-first");
      signIn(homeOf(other), "other-account");
      await listed(work);
      await listed(other);
      // Only the work account changes, and only its profile is the named subject.
      signIn(homeOf(work), "work-second");
      bustCredentialStatusCaches(quota, accounts, { harnessId: "codex", profileId: "work" });
      expect(await listed(work)).toEqual(["work-second"]);
      expect(await listed(other)).toEqual(["other-account"]);
      expect(spawns(homeOf(work))).toBe(2);
      expect(spawns(homeOf(other))).toBe(2);
      // Ordinary hits resume in both homes.
      await listed(work);
      await listed(other);
      expect(spawns(homeOf(work))).toBe(2);
      expect(spawns(homeOf(other))).toBe(2);
    });

    it("the discovered manifest carries the new account's models and effort ladders", async () => {
      const discovering = createCodexAdapter({
        detectVersion: async () => "codex-cli fixture",
        probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
        hasApiKey: () => false,
      });
      const ladders = async () => (await discovering.discover()).capabilities.model_effort_levels;
      signIn(nativeHome(), "first-account", ["low", "ultra"]);
      expect(await ladders()).toEqual({
        "first-account": { levels: ["low", "ultra"], default: "low" },
      });
      signIn(nativeHome(), "second-account", ["low", "high"]);
      bustLoginCredentialState(quota, accounts, readiness, "codex");
      expect(await ladders()).toEqual({
        "second-account": { levels: ["low", "high"], default: "low" },
      });
      expect(spawns(nativeHome())).toBe(2);
    });

    it("the account view's retained copy reads the new account after the change", async () => {
      const retained = async () =>
        (await accountObservations.read("agent-models:610", work, () => listed(work))).value;
      signIn(homeOf(work), "first-account");
      expect(await retained()).toEqual(["first-account"]);
      signIn(homeOf(work), "second-account");
      expect(await retained()).toEqual(["first-account"]);
      bustCredentialStatusCaches(quota, accounts, { harnessId: "codex", profileId: "work" });
      expect(await retained()).toEqual(["second-account"]);
      expect(spawns(homeOf(work))).toBe(2);
    });
  },
);
