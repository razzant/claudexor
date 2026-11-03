/** Actual Grok parser -> CLI run loop -> adapter -> Orchestrator. Only the
 * vendor executable (a Node child printing the recorded 1.0.67 frames) and the
 * login probe are replaced; no normalized events are injected. */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { canonicalIsolationLocator, runCliHarness, type CliRunLoopOptions } from "@claudexor/core";
import { CredentialProfile, type HarnessEvent, type RunEvent } from "@claudexor/schema";
import { CredentialUnusableLedger } from "../../daemon/src/credential-unusable-ledger.js";
import { createGrokAdapter } from "../../harness-grok/src/index.js";
import { createCredentialExecutionObserver } from "./credential-execution.js";
import { Orchestrator } from "./orchestrator.js";

const recorded = readFileSync(
  new URL("../../harness-grok/fixtures/ask.jsonl", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Record<string, unknown>);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

/** One pinned account in a plain directory, or (`pool`) two unpinned accounts
 * in a git worktree, where an untouched tree is provable and rotation applies.
 * `stderr` makes the child print that line and exit 1 after its frames;
 * `ledger` wires the daemon's credential evidence exactly as the CLI does. */
async function runGrok(
  frames: Record<string, unknown>[],
  setup: {
    profileConfig?: string;
    model?: string;
    pool?: boolean;
    stderr?: string;
    ledger?: CredentialUnusableLedger;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "cx-grok-subscription-"));
  roots.push(root);
  writeFileSync(join(root, "README.md"), "fixture\n");
  if (setup.pool) {
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base"],
      { cwd: root, stdio: "pipe" },
    );
  }
  const configDir = process.env.CLAUDEXOR_CONFIG_DIR!;
  const profiles = (setup.pool ? ["a", "b"] : ["work"]).map((id) => {
    const home = join(configDir, "profiles", `grok-${id}`);
    mkdirSync(join(home, ".grok"), { recursive: true });
    // Synthetic profile config; any value is a placeholder, never a token.
    rmSync(join(home, ".grok", "config.toml"), { force: true });
    if (setup.profileConfig) writeFileSync(join(home, ".grok", "config.toml"), setup.profileConfig);
    return CredentialProfile.parse({
      profile_id: `grok-${id}`,
      display_name: id,
      harness_id: "grok",
      credential_kind: "config_dir_login",
      isolation_locator: home,
    });
  });
  const profile = profiles[0]!;
  const home = profile.isolation_locator!;
  writeFileSync(
    join(configDir, "config.yaml"),
    JSON.stringify({
      routing: { paid_fallback: "never" },
      credential_profiles: profiles,
    }),
  );
  const launches: CliRunLoopOptions[] = [];
  const adapter = createGrokAdapter({
    detectVersion: async () => "1.0.67",
    probeLogin: async () => ({
      authenticated: true,
      models: [],
      detail: "Grok CLI reported a grok.com login",
    }),
    runCli: (options) => {
      launches.push(options);
      return runCliHarness({
        ...options,
        bin: process.execPath,
        args: [
          "-e",
          `for (const frame of ${JSON.stringify(frames)}) console.log(JSON.stringify(frame));` +
            (setup.stderr
              ? `process.stderr.write(${JSON.stringify(setup.stderr + "\n")}); process.exitCode = 1;`
              : ""),
        ],
      });
    },
  });
  const harnessEvents: HarnessEvent[] = [];
  const runEvents: RunEvent[] = [];
  const ledger = setup.ledger;
  const result = await new Orchestrator({
    registry: new Map([["grok", adapter]]),
    reviewers: [],
    quotaSnapshots: () => [],
    ...(ledger
      ? {
          credentialObserverFactory: (subject: Parameters<CredentialUnusableLedger["bind"]>[0]) =>
            createCredentialExecutionObserver(ledger, ledger.bind(subject)),
          credentialUnusable: () => ledger.live(),
          credentialEvidence: ledger,
        }
      : {}),
  }).run({
    repoRoot: root,
    ...(setup.pool ? {} : { workspaceKind: "directory" as const, inPlace: true }),
    mode: "agent",
    prompt: "Reply with just OK",
    harnesses: ["grok"],
    ...(setup.model ? { models: { grok: setup.model } } : {}),
    ...(setup.pool ? {} : { credentialProfileId: profile.profile_id }),
    review: false,
    effort: "max",
    authPreference: "subscription",
    paidBudget: { kind: "finite", maxUsd: 2 },
    web: "off",
    onHarnessEvent: (event) => harnessEvents.push(event),
    onEvent: (event) => runEvents.push(event),
  });
  const store = new ArtifactStore(root);
  const telemetry = store.readYaml<any>(join(result.runDir, "final", "telemetry.yaml"));
  const failurePath = join(result.runDir, "final", "failure.yaml");
  const failure = existsSync(failurePath) ? store.readYaml<any>(failurePath) : null;
  const attemptsDir = join(result.runDir, "attempts");
  const first = existsSync(attemptsDir) ? readdirSync(attemptsDir)[0] : undefined;
  const attempt = first ? store.readYaml<any>(join(attemptsDir, first, "attempt.yaml")) : null;
  const homes = launches.map((launch) => launch.env?.["HOME"]);
  return {
    result,
    launches,
    homes,
    harnessEvents,
    runEvents,
    telemetry,
    failure,
    attempt,
    home,
    profile,
  };
}

const rotations = (events: RunEvent[]) =>
  events.filter((event) => event.type === "route.profile.rotated");

describe("Grok subscription run through the real Orchestrator", () => {
  it("places max effort, confirms the session source, keeps cash unknown and names the real HOME", async () => {
    const run = await runGrok(recorded);
    expect(run.result.lifecycle, run.result.summary).toBe("succeeded");
    expect(run.launches).toHaveLength(1);
    const args = run.launches[0]!.args;
    expect(args[args.indexOf("--reasoning-effort") + 1]).toBe("xhigh");
    expect(
      run.harnessEvents.find((event) => event.effort_resolution)?.effort_resolution,
    ).toMatchObject({ requested: "max", submitted: "xhigh", resolution: "downward" });
    // web: "off" reaches the vendor's own web_fetch switch, access unchanged.
    expect(run.launches[0]!.env?.["GROK_WEB_FETCH"]).toBe("0");
    expect(run.launches[0]!.spec.processing_cost_basis).toMatchObject({
      kind: "included",
      debit: "unobserved",
    });
    expect(run.harnessEvents.find((event) => event.type === "started")).toMatchObject({
      credential_route: "vendor_native",
      credential_source: "native_session",
      credential_profile_id: "grok-work",
    });
    expect(run.telemetry.attempts[0].auth_source).toBe("native_session");
    // No exact zero: the subscription debit is unobserved; only the cap's
    // controllable part is known.
    expect(run.telemetry.attempts[0].usage_cost.cashKnowledge).toBe("unknown");
    const cash = run.runEvents.filter((event) => event.type === "budget.cash").at(-1)?.payload;
    expect(cash).toMatchObject({
      cash_knowledge: "unknown",
      controllable_cash_knowledge: "exact",
    });
    // The record names exactly the HOME the vendor child was given.
    expect(run.launches[0]!.env?.["HOME"]).toBe(canonicalIsolationLocator(run.home, "test"));
    expect(run.attempt).toMatchObject({
      harness_home_isolated: true,
      harness_home_dir: run.launches[0]!.env?.["HOME"],
      credential_profile_applied: "grok-work",
    });
  });

  // `user` is the guide's API-key value; any other value is unverified too.
  it.each(["user", "api_key"])(
    "stops the run after one launch when init reports source %s; auth and cash stay unknown",
    async (source) => {
      const [init, ...rest] = recorded;
      const run = await runGrok([{ ...init, apiKeySource: source }, ...rest]);
      // A typed request refusal: no same-account re-brief of the plain directory.
      expect(run.launches).toHaveLength(1);
      expect(run.result.lifecycle).not.toBe("succeeded");
      expect(run.failure).toMatchObject({
        category: "harness_unavailable",
        code: "credential_source_unconfirmed",
        requestRefusal: {
          kind: "credential_source_unconfirmed",
          native_code: "grok_credential_source_unconfirmed",
          source: "grok_init",
          reported_source: source,
        },
      });
      expect(run.failure.nextActions.join(" ")).toContain("does not read or change it");
      expect(run.harnessEvents.some((event) => event.final)).toBe(false);
      expect(run.telemetry.attempts[0].auth_source ?? null).toBeNull();
      expect(run.telemetry.attempts[0].usage_cost.cashKnowledge).toBe("unknown");
    },
  );

  it("stops an unpinned pool on a reported key source instead of rotating to the next account", async () => {
    const [init, ...rest] = recorded;
    const run = await runGrok([{ ...init, apiKeySource: "user" }, ...rest], { pool: true });
    expect(run.launches).toHaveLength(1);
    expect(rotations(run.runEvents)).toEqual([]);
    expect(run.failure).toMatchObject({ code: "credential_source_unconfirmed" });
  });

  it("still rotates an unpinned pool past an ordinary failure before progress (control)", async () => {
    // Session login confirmed, then no terminal result: an untyped failure.
    const run = await runGrok([recorded[0]!], { pool: true });
    expect(new Set(run.homes).size).toBe(2);
    expect(rotations(run.runEvents)[0]?.payload).toMatchObject({
      reason: "structural_pre_progress_failure",
    });
    expect(run.failure?.code ?? null).toBeNull();
  });

  it("still retries the same account after an ordinary failure in a plain directory (control)", async () => {
    const run = await runGrok([recorded[0]!]);
    expect(run.launches.length).toBeGreaterThan(1);
    expect(new Set(run.homes).size).toBe(1);
    expect(run.failure?.code ?? null).toBeNull();
  });

  it("keeps the source and cash unknown when the init frame omits apiKeySource", async () => {
    const [init, ...rest] = recorded;
    const { apiKeySource: _omitted, ...silent } = init!;
    const run = await runGrok([silent, ...rest]);
    expect(run.result.lifecycle, run.result.summary).toBe("succeeded");
    expect(run.harnessEvents.some((event) => event.credential_source !== undefined)).toBe(false);
    expect(
      run.harnessEvents.find(
        (event) => event.payload?.code === "grok_credential_source_unreported",
      ),
    ).toBeTruthy();
    // An absent source is unknown, never a refusal.
    expect(run.harnessEvents.some((event) => event.request_refusal)).toBe(false);
    expect(run.telemetry.attempts[0].auth_source ?? null).toBeNull();
    expect(run.telemetry.attempts[0].usage_cost.cashKnowledge).toBe("unknown");
  });

  it("does not pre-screen Grok's own config: the init frame of the one launch stops a keyed model", async () => {
    // The disclosed boundary: Claudexor neither reads nor rewrites vendor
    // config, so a per-model key is caught only by the init frame, after launch.
    const profileConfig = '[model."grok-4.7"]\napi_key = "placeholder"\n';
    const [init, ...rest] = recorded;
    const run = await runGrok([{ ...init, apiKeySource: "user" }, ...rest], {
      profileConfig,
      model: "grok-4.7",
    });
    expect(run.launches).toHaveLength(1);
    const args = run.launches[0]!.args;
    expect(args[args.indexOf("-m") + 1]).toBe("grok-4.7");
    expect(run.failure).toMatchObject({ code: "credential_source_unconfirmed" });
    expect(run.result.lifecycle).not.toBe("succeeded");
    expect(run.harnessEvents.some((event) => event.final)).toBe(false);
    expect(run.telemetry.attempts[0].auth_source ?? null).toBeNull();
    expect(readFileSync(join(run.home, ".grok", "config.toml"), "utf8")).toBe(profileConfig);
    expect(JSON.stringify(run.result)).not.toContain("placeholder");
  });

  // One init frame can contradict both the scoped tool policy and the
  // credential source; the reported source decides, whatever else differs.
  const policyContradictions = [
    ["an extra tool", { tools: ["read_file", "list_dir", "grep", "run_terminal_cmd"] }],
    ["another permission mode", { permissionMode: "default" }],
  ] as const;

  it.each(policyContradictions)(
    "stops a pinned run after one launch when a key source comes with %s",
    async (_, policy) => {
      const [init, ...rest] = recorded;
      const run = await runGrok([{ ...init, ...policy, apiKeySource: "user" }, ...rest]);
      expect(run.launches).toHaveLength(1);
      expect(run.failure).toMatchObject({
        category: "harness_unavailable",
        code: "credential_source_unconfirmed",
        requestRefusal: { kind: "credential_source_unconfirmed", reported_source: "user" },
      });
      expect(run.harnessEvents.some((event) => event.final)).toBe(false);
      expect(run.telemetry.attempts[0].auth_source ?? null).toBeNull();
    },
  );

  it.each(policyContradictions)(
    "stops an unpinned pool instead of rotating when a key source comes with %s",
    async (_, policy) => {
      const [init, ...rest] = recorded;
      const run = await runGrok([{ ...init, ...policy, apiKeySource: "user" }, ...rest], {
        pool: true,
      });
      expect(run.launches).toHaveLength(1);
      expect(rotations(run.runEvents)).toEqual([]);
      expect(run.failure).toMatchObject({ code: "credential_source_unconfirmed" });
    },
  );

  it("keeps the ordinary bounded retry and rotation for a policy contradiction under session login (control)", async () => {
    const [init, ...rest] = recorded;
    const frames = [{ ...init, permissionMode: "default" }, ...rest];
    const ledger = new CredentialUnusableLedger();
    const pinned = await runGrok(frames, { ledger });
    // Same account, bounded like any pre-progress failure (one re-brief here);
    // never typed as a credential refusal or recorded against the account.
    expect(pinned.launches).toHaveLength(2);
    expect(new Set(pinned.homes).size).toBe(1);
    expect(pinned.failure?.code ?? null).toBeNull();
    expect(ledger.live()).toEqual([]);
    const refusals = pinned.harnessEvents.filter((event) => event.type === "error");
    expect(refusals.map((event) => event.payload?.code)).toEqual(
      pinned.launches.map(() => "grok_access_policy_unconfirmed"),
    );
    expect(refusals.some((event) => event.request_refusal)).toBe(false);
    // Another account's own profile configuration can differ, so a pool
    // rotates, at most once per account.
    const pool = await runGrok(frames, { pool: true });
    expect(pool.launches).toHaveLength(2);
    expect(new Set(pool.homes).size).toBe(2);
    expect(rotations(pool.runEvents)[0]?.payload).toMatchObject({
      reason: "structural_pre_progress_failure",
    });
    expect(pool.failure?.code ?? null).toBeNull();
  });

  // Grok documents no authentication error code, and a 401 from a proxy or
  // backend says nothing about the account; only typed evidence may condemn it.
  it.each([
    ["stderr 401 Unauthorized", "HTTP 401 Unauthorized", []],
    ["stderr Proxy Authentication Required", "407 Proxy Authentication Required", []],
    ["stderr unauthenticated", "error: unauthenticated", []],
    [
      "an error frame code containing auth",
      undefined,
      [{ type: "error", error: { code: "auth_proxy_unavailable", message: "upstream failed" } }],
    ],
  ] as const)(
    "does not mark the account unusable for a failed run with %s",
    async (_, stderr, failure) => {
      const ledger = new CredentialUnusableLedger();
      const first = await runGrok([recorded[0]!, ...failure], {
        ledger,
        ...(stderr ? { stderr } : {}),
      });
      expect(first.result.lifecycle).not.toBe("succeeded");
      expect(ledger.live()).toEqual([]);
      expect(
        first.harnessEvents.some(
          (event) => event.status?.error_category === "authentication_failed",
        ),
      ).toBe(false);
      // The next pinned run on the same account still launches and succeeds,
      // and the wired ledger records that success (wiring control).
      const second = await runGrok(recorded, { ledger });
      expect(second.launches).toHaveLength(1);
      expect(second.result.lifecycle, second.result.summary).toBe("succeeded");
      expect(ledger.honored()).toContainEqual(
        expect.objectContaining({ harness_id: "grok", profile_id: "grok-work" }),
      );
    },
  );
});
