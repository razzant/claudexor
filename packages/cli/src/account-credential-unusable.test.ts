import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountEvidence, type QuotaRegistry } from "@claudexor/daemon";
import { createCredentialExecutionObserver } from "@claudexor/orchestrator";
import { ControlAccountRoutingEvidenceResponse, type HarnessEvent } from "@claudexor/schema";
import { createCredentialProfilesService } from "./accounts-services.js";

// The opt-in Accounts read of model-scoped credential refusals (#200): each
// observation is produced by the real dispatch-bound observer from events shaped
// like the Claude adapter's typed retry frame, stored by the real
// credential_unusable ledger and projected by the real Accounts service. Only
// the quota registry is a stub, because this read never refreshes quota.

const dirs: string[] = [];
const sandboxConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
afterEach(() => {
  if (sandboxConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = sandboxConfigDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Two registered Claude rows, `work` and `spare`, in this test's config dir. */
function registerRows(): void {
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), "cx-model-unusable-config-")));
  dirs.push(configDir);
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  writeFileSync(
    join(configDir, "config.yaml"),
    [
      "credential_profiles:",
      ...["work", "spare"].flatMap((id) => [
        `  - profile_id: ${id}`,
        "    harness_id: claude",
        `    display_name: ${id}`,
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", `claude-${id}`))}`,
      ]),
      "",
    ].join("\n"),
  );
}

const quota = {
  read: () => ({ snapshots: [], absences: [], refreshed_at: null }),
} as unknown as QuotaRegistry;

type Accounts = ReturnType<typeof createAccountEvidence>;
type Try = {
  profileId: string;
  requestedModel: string | null;
  route?: "vendor_native" | "managed_api_key";
};

/** One native try, observed exactly as a dispatched run observes it. */
function nativeTry(accounts: Accounts, at: Try, events: Array<Partial<HarnessEvent>>): void {
  const route = at.route ?? "vendor_native";
  const observer = createCredentialExecutionObserver(
    accounts.unusable,
    accounts.unusable.bind({
      harnessId: "claude",
      profileId: at.profileId,
      route,
      requestedModel: at.requestedModel,
    }),
  );
  for (const over of events)
    observer.observe({
      type: "status",
      session_id: "session-1",
      ts: new Date().toISOString(),
      credential_route: route,
      credential_profile_id: at.profileId,
      ...over,
    } as HarnessEvent);
  observer.finish();
}

/** The adapter's typed retry frame for a vendor refusal, then the failed result. */
const refused = (category: "model_not_found" | "authentication_failed") => [
  { type: "started" as const },
  {
    text: `api_retry: ${category}`,
    status: { kind: "api_retry" as const, error_category: category },
    payload: { api_retry: true, retry_delay_ms: null },
  },
  { type: "error" as const, error: "request failed" },
  { type: "completed" as const, payload: { exit_code: 1, harness_reported_error: true } },
];

/** A try that the vendor served under the model it reports. */
const served = (observedModel: string) => [
  { type: "started" as const },
  {
    type: "usage" as const,
    usage: { input_tokens: 12, output_tokens: 3 },
    observed_model: observedModel,
  },
  { type: "completed" as const, payload: { exit_code: 0 } },
];

describe("GET /v2/accounts/routing-evidence includeCredentialUnusable (service)", () => {
  it("lists a registered row's model-scoped refusal only to a client that asks", async () => {
    registerRows();
    const accounts = createAccountEvidence();
    nativeTry(accounts, { profileId: "work", requestedModel: "claude-opus-5-5" }, [
      ...refused("model_not_found"),
    ]);
    // Credential-wide: already composed into the row status, never listed here.
    nativeTry(accounts, { profileId: "spare", requestedModel: null }, [
      ...refused("authentication_failed"),
    ]);
    // An account that is not a registered row, and a route the row does not use.
    nativeTry(accounts, { profileId: "ghost", requestedModel: "claude-opus-5-5" }, [
      ...refused("model_not_found"),
    ]);
    nativeTry(
      accounts,
      { profileId: "work", requestedModel: "claude-sonnet-5-5", route: "managed_api_key" },
      [...refused("model_not_found")],
    );
    expect(accounts.unusable.live()).toHaveLength(4);
    const read = createCredentialProfilesService(() => quota, accounts).accountRoutingEvidence;

    // Strict older clients keep the exact earlier shapes.
    expect(Object.keys(await read()).sort()).toEqual(["lastService", "refusals"]);
    expect(Object.keys(await read({ capabilities: true })).sort()).toEqual([
      "capabilities",
      "lastService",
      "refusals",
    ]);

    const asked = ControlAccountRoutingEvidenceResponse.parse(
      await read({ credentialUnusable: true }),
    );
    expect(asked.credentialUnusable).toEqual([
      {
        harness_id: "claude",
        profile_id: "work",
        model: "claude-opus-5-5",
        code: "capability_refused",
        detail: "model_not_found",
        observed_at: expect.any(String),
        expires_at: expect.any(String),
      },
    ]);
    const [mark] = asked.credentialUnusable!;
    // The producer's capability TTL: dated evidence that expires within the hour.
    expect(Date.parse(mark!.expires_at) - Date.parse(mark!.observed_at)).toBe(60 * 60_000);
    // Soft pre-progress refusals and last service are unaffected by the opt-in.
    expect(asked.refusals).toEqual([]);
    expect(asked.lastService).toEqual([]);
  });

  it("clears only when the vendor reports the exact refused model (label-vs-slug limitation)", async () => {
    registerRows();
    const accounts = createAccountEvidence();
    const read = createCredentialProfilesService(() => quota, accounts).accountRoutingEvidence;
    const listed = async () =>
      (
        ControlAccountRoutingEvidenceResponse.parse(await read({ credentialUnusable: true }))
          .credentialUnusable ?? []
      ).map((mark) => `${mark.profile_id}:${mark.model}`);
    nativeTry(accounts, { profileId: "work", requestedModel: "claude-opus-5-5" }, [
      ...refused("model_not_found"),
    ]);
    expect(await listed()).toEqual(["work:claude-opus-5-5"]);
    // The vendor served a request it reports under a dated id or another model:
    // neither proves the requested label, so the observation stays until expiry.
    nativeTry(accounts, { profileId: "work", requestedModel: "claude-opus-5-5" }, [
      ...served("claude-opus-5-5-20261001"),
    ]);
    nativeTry(accounts, { profileId: "work", requestedModel: null }, [
      ...served("claude-sonnet-5-5"),
    ]);
    expect(await listed()).toEqual(["work:claude-opus-5-5"]);
    nativeTry(accounts, { profileId: "work", requestedModel: "claude-opus-5-5" }, [
      ...served("claude-opus-5-5"),
    ]);
    expect(await listed()).toEqual([]);
  });

  it("lists a row's refusals most recent first, whichever model was refused first", async () => {
    registerRows();
    const accounts = createAccountEvidence();
    const read = createCredentialProfilesService(() => quota, accounts).accountRoutingEvidence;
    nativeTry(accounts, { profileId: "work", requestedModel: "older-model" }, [
      ...refused("model_not_found"),
    ]);
    await new Promise((settle) => setTimeout(settle, 2));
    nativeTry(accounts, { profileId: "work", requestedModel: "newer-model" }, [
      ...refused("model_not_found"),
    ]);
    const asked = ControlAccountRoutingEvidenceResponse.parse(
      await read({ credentialUnusable: true }),
    );
    expect(asked.credentialUnusable?.map((mark) => mark.model)).toEqual([
      "newer-model",
      "older-model",
    ]);
  });

  it("a credential change voids the row's observations", async () => {
    registerRows();
    const accounts = createAccountEvidence();
    const read = createCredentialProfilesService(() => quota, accounts).accountRoutingEvidence;
    nativeTry(accounts, { profileId: "work", requestedModel: "claude-opus-5-5" }, [
      ...refused("model_not_found"),
    ]);
    nativeTry(accounts, { profileId: "spare", requestedModel: "claude-opus-5-5" }, [
      ...refused("model_not_found"),
    ]);
    accounts.unusable.clearSubject("claude", "work");
    const asked = ControlAccountRoutingEvidenceResponse.parse(
      await read({ credentialUnusable: true }),
    );
    expect(asked.credentialUnusable?.map((mark) => mark.profile_id)).toEqual(["spare"]);
  });
});
