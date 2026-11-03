#!/usr/bin/env node
/**
 * Generates the macOS Accounts wire fixture for the opt-in routing evidence
 * (#200): the bodies the Swift client and Accounts surface decode in their tests.
 *
 * Refusals are the Claude adapter's own typed frames through the real dispatch
 * observer and ledgers. Both routing-evidence bodies and the operation entries
 * are what the real Accounts service and control route serve over loopback. The
 * listing composes each row's status with the same call the Accounts service
 * makes, over a fixed doctor status: a fixture must not probe an adapter or touch
 * a credential store. Offline and deterministic: the engine clock is fixed in the
 * far future, because expiry is also judged against the real clock; Swift rebases
 * it onto its own `now`. Relative dist imports, as in scripts/lib/wire-fixtures.mjs
 * (`pnpm build` first).
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(
  repoRoot,
  "apps/macos/ClaudexorApp/Tests/ClaudexorAppTests/Fixtures/accounts-opt-in-wire.json",
);

// Before any engine module loads: the service reads its registry from this root.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cx-accounts-fixture-")));
process.env.HOME = scratch;
process.env.CLAUDEXOR_CONFIG_DIR = scratch;

const CLOCK = "2099-01-01T12:00:00.000Z";
const minutesAgo = (minutes) => new Date(Date.parse(CLOCK) - minutes * 60_000).toISOString();
const row = (id, display_name) => ({
  profile_id: id,
  harness_id: "claude",
  display_name,
  credential_kind: "config_dir_login",
  isolation_locator: `/fixture/profiles/claude-${id}`,
});

async function generate() {
  const dist = (path) => import(join(repoRoot, "packages", path));
  const [schema, core, daemon, harness, orchestrator, accountsServices, controlApi] =
    await Promise.all([
      dist("schema/dist/index.js"),
      dist("core/dist/index.js"),
      dist("daemon/dist/index.js"),
      dist("harness-claude/dist/retry-signals.js"),
      dist("orchestrator/dist/index.js"),
      dist("cli/dist/accounts-services.js"),
      dist("control-api/dist/index.js"),
    ]);
  const rows = [
    row("work", "Claude Work"),
    row("spare", "Claude Spare"),
    row("org-disabled", "Org Disabled"),
    row("logged-out", "Logged Out"),
  ];
  writeFileSync(join(scratch, "config.yaml"), JSON.stringify({ credential_profiles: rows }));
  const profiles = rows.map((value) => schema.CredentialProfile.parse(value));

  let now = minutesAgo(41);
  const clock = () => new Date(now);
  const unmutated = () => false;
  const credentials = new daemon.CredentialGeneration(unmutated);
  const unusable = new daemon.CredentialUnusableLedger(clock, unmutated, credentials);
  const refusals = new daemon.PreProgressRefusalLedger(clock, unmutated, credentials);

  /** One failed native try, observed as a dispatched run observes it. */
  const refusedTry = (profile, model, frames) => {
    const subject = core.credentialExecutionSubject("claude", {
      credential_profile: profile,
      auth_preference: "auto",
      model_hint: model,
    });
    const observer = orchestrator.createCredentialExecutionObserver(
      unusable,
      unusable.bind(subject),
    );
    const base = {
      session_id: "fixture",
      ts: now,
      credential_route: "vendor_native",
      credential_profile_id: profile.profile_id,
    };
    observer.observe({ ...base, type: "started" });
    for (const frame of frames("fixture", now)) observer.observe({ ...frame, ...base });
    observer.observe({ ...base, type: "error", error: "request failed" });
    observer.observe({
      ...base,
      type: "completed",
      payload: { exit_code: 1, harness_reported_error: true },
    });
    observer.finish();
  };
  const [work, spare, orgDisabled, loggedOut] = profiles;
  const modelNotFound = (sessionId, ts) =>
    harness.claudeApiRetryEvents({ error: "model_not_found", attempt: 1 }, sessionId, ts);
  // Spare: typed refusals of two named models with long dated ids. Work: refused
  // before progress on the default model, then a typed refusal of one named
  // model. Org Disabled: refused for the whole subscription.
  refusedTry(spare, "claude-haiku-4-5-20251001", modelNotFound);
  now = minutesAgo(40);
  refusedTry(spare, "claude-sonnet-4-5-20250929", modelNotFound);
  now = minutesAgo(30);
  refusals.record({ harness_id: "claude", profile_id: "work", requested_model: null });
  now = minutesAgo(12);
  refusedTry(work, "claude-opus-5-5", modelNotFound);
  now = minutesAgo(5);
  refusedTry(orgDisabled, null, (sessionId, ts) =>
    harness.claudeEntitlementEvents(
      "Your organization has disabled Claude subscription access for Claude Code",
      false,
      sessionId,
      ts,
    ),
  );
  now = CLOCK;

  const emptyQuota = { snapshots: [], absences: [], refreshed_at: null };
  const service = accountsServices.createCredentialProfilesService(
    () => ({ read: () => emptyQuota }),
    {
      unusable,
      refusals,
      services: {
        latest: () => [
          {
            harness_id: "claude",
            profile_id: "work",
            requested_model: null,
            observed_at: minutesAgo(120),
          },
        ],
      },
    },
  );
  const server = new controlApi.DaemonControlApiServer({
    token: "fixture",
    daemon: {},
    services: { accountRoutingEvidence: service.accountRoutingEvidence },
  });
  const { host, port } = await server.start();
  const read = async (path) => {
    const response = await fetch(`http://${host}:${port}/v2/${path}`, {
      headers: { authorization: "Bearer fixture", "X-Claudexor-Protocol-Major": "3" },
    });
    if (!response.ok) throw new Error(`${path} answered HTTP ${response.status}`);
    return response.json();
  };
  let routingEvidence;
  let operations;
  try {
    routingEvidence = {
      optIn: await read("accounts/routing-evidence?includeCredentialUnusable=true"),
      older: await read("accounts/routing-evidence"),
    };
    const accountOperations = new Set([
      "get:accounts.routing-evidence",
      "get:credential-profiles",
      "get:quota",
    ]);
    operations = (await read("operations")).operations.filter((operation) =>
      accountOperations.has(operation.id),
    );
  } finally {
    await server.stop();
  }

  const doctor = (profile, over = {}) => ({
    profile_id: profile.profile_id,
    harness_id: profile.harness_id,
    availability: "available",
    verification: "passed",
    verification_source: "local_store",
    last_verified_at: minutesAgo(1),
    ...over,
  });
  const composed = (profile, over) =>
    orchestrator.composeCredentialProfileEvidence(doctor(profile, over), {
      quota: { ...emptyQuota, honored: unusable.honored() },
      unusable: unusable.live(),
      model: null,
      route: "vendor_native",
    });
  const listing = schema.ControlCredentialProfilesResponse.parse({
    profiles: [
      {
        profile: work,
        status: composed(work),
        identity: { email: "work@example.test", plan: "Max" },
      },
      {
        profile: spare,
        status: composed(spare),
        identity: { email: "spare@example.test", plan: "Pro" },
      },
      { profile: orgDisabled, status: composed(orgDisabled), identity: null },
      {
        profile: loggedOut,
        status: composed(loggedOut, {
          availability: "unavailable",
          verification: "not_run",
          detail: "No credentials in this account's store.",
          last_verified_at: null,
        }),
        identity: null,
      },
    ],
    harnessAccounts: [],
    accountPools: [{ harness_id: "claude", next_up: { kind: "profile", profileId: "spare" } }],
  });
  const window = (id, label, used_ratio, window_seconds, resets_at) => ({
    id,
    label,
    used_ratio,
    window_seconds,
    resets_at,
    cooldown_until: null,
  });
  const snapshot = (subject_id, plan_label, constraints) => ({
    subject: { harness: "claude", credential_route: "vendor_native", subject_id, plan_label },
    constraints,
    source: "claude_oauth_usage",
    observed_at: minutesAgo(1),
    freshness: "fresh",
  });
  const inHours = (hours) => new Date(Date.parse(CLOCK) + hours * 3_600_000).toISOString();
  const quota = schema.ControlAccountResourcesResponse.parse({
    snapshots: [
      snapshot("work", "Max", [window("five_hour", "5-hour session", 0.42, 18_000, inHours(3))]),
      snapshot("spare", "Pro", [window("five_hour", "5-hour session", 0.08, 18_000, inHours(4))]),
    ],
    absences: [],
    refreshed_at: null,
    resources: [],
  });

  return {
    generatedBy: [
      "claudeApiRetryEvents",
      "createCredentialExecutionObserver",
      "createCredentialProfilesService",
      "DaemonControlApiServer",
    ],
    engineClock: CLOCK,
    operations: { operations },
    credentialProfiles: listing,
    quota,
    routingEvidence,
  };
}

let body;
try {
  body = await format(JSON.stringify(await generate()), { parser: "json", printWidth: 100 });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (process.argv.includes("--check")) {
  if (!existsSync(fixturePath) || readFileSync(fixturePath, "utf8") !== body) {
    console.error("Accounts opt-in wire fixture drift (regenerate: pnpm fixtures:swift)");
    process.exit(1);
  }
  console.log("Accounts opt-in wire fixture fresh");
} else {
  writeFileSync(fixturePath, body);
  console.log(`wrote Accounts opt-in wire fixture to ${fixturePath}`);
}
// The control server's worker pool may keep the loop alive after stop.
process.exit(0);
