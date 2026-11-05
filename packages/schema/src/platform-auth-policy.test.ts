import { describe, expect, it } from "vitest";
import {
  AgentCapabilityCatalog,
  AuthCapabilities,
  CatalogHarness,
  ControlCredentialProfileDeleteResponse,
  HarnessManifest,
  HarnessStatusDto,
  QuotaAbsence,
  SetupNativeCommandReceipt,
  credentialProfilePolicyForPlatform,
  credentialTransportsForPlatform,
} from "./index.js";

const BASE_MANIFEST = {
  id: "legacy",
  display_name: "Legacy",
  kind: "local_cli" as const,
  provider_family: "unknown" as const,
  capabilities: {},
};

describe("platform-scoped credential policy", () => {
  it("preserves old manifest absence and resolves the backward-compatible defaults", () => {
    const manifest = HarnessManifest.parse(BASE_MANIFEST);
    expect(manifest.capability_profile.auth).not.toHaveProperty("credential_profile_policies");
    expect(manifest.capability_profile.auth).not.toHaveProperty("managed_login");

    expect(
      credentialProfilePolicyForPlatform(
        manifest.capability_profile.auth,
        "native_session",
        "win32",
      ),
    ).toEqual({
      identity_scope: "profile",
      max_enabled_profiles: null,
      cleanup_owner: "claudexor",
    });
  });

  it("filters physical transport candidates by platform without forbidding overlap", () => {
    const auth = AuthCapabilities.parse({
      supported_sources: ["native_session"],
      credential_transports: [
        {
          source: "native_session",
          kind: "config_file",
          relocatable_by: ["HOME"],
          platforms: ["darwin", "linux"],
        },
        {
          source: "native_session",
          kind: "os_keychain",
          relocatable_by: ["none"],
          platforms: ["darwin", "win32"],
        },
      ],
    });
    expect(credentialTransportsForPlatform(auth, "darwin").map((row) => row.kind)).toEqual([
      "config_file",
      "os_keychain",
    ]);
    expect(credentialTransportsForPlatform(auth, "win32").map((row) => row.kind)).toEqual([
      "os_keychain",
    ]);
  });

  it("rejects overlapping same-source profile-policy rows but resolves one exact override", () => {
    const overlapping = AuthCapabilities.safeParse({
      credential_profile_policies: [
        {
          source: "native_session",
          platforms: ["win32"],
          identity_scope: "os_user",
          max_enabled_profiles: 1,
          cleanup_owner: "vendor",
        },
        {
          source: "native_session",
          platforms: ["darwin", "win32"],
          identity_scope: "profile",
          max_enabled_profiles: null,
          cleanup_owner: "claudexor",
        },
      ],
    });
    expect(overlapping.success).toBe(false);

    const auth = AuthCapabilities.parse({
      credential_profile_policies: [
        {
          source: "native_session",
          platforms: ["win32"],
          identity_scope: "os_user",
          max_enabled_profiles: 1,
          cleanup_owner: "vendor",
        },
      ],
      managed_login: { stdin: "terminal" },
    });
    expect(credentialProfilePolicyForPlatform(auth, "native_session", "win32")).toEqual({
      identity_scope: "os_user",
      max_enabled_profiles: 1,
      cleanup_owner: "vendor",
    });
    expect(auth.managed_login).toEqual({ stdin: "terminal" });
  });
});

describe("setup-login wire compatibility", () => {
  it("preserves absent, explicit null, and object as distinct status cases", () => {
    const legacy = HarnessStatusDto.parse({ id: "agy", status: "unavailable" });
    expect(Object.hasOwn(legacy, "setupLogin")).toBe(false);

    const none = HarnessStatusDto.parse({
      id: "fake",
      status: "ok",
      setupLogin: null,
    });
    expect(Object.hasOwn(none, "setupLogin")).toBe(true);
    expect(none.setupLogin).toBeNull();

    const supported = HarnessStatusDto.parse({
      id: "agy",
      status: "ok",
      setupLogin: { mode: "in_app" },
    });
    expect(supported.setupLogin).toEqual({ mode: "in_app" });
    expect(
      HarnessStatusDto.safeParse({
        id: "agy",
        status: "ok",
        setupLogin: { mode: "daemon", requestTransport: "daemon" },
      }).success,
    ).toBe(false);
  });

  it("carries the same optional projection on catalog rows", () => {
    const row = CatalogHarness.parse({
      id: "agy",
      enabled: true,
      displayName: "Antigravity CLI",
      status: "ok",
      providerFamily: "google",
      enabledIntents: [],
      disabledIntents: [],
      reasons: [],
      configuredModel: null,
      configuredModelValid: null,
      models: { source: "none", count: 0, verifiedAgainst: null },
      webPolicy: "uncontrolled",
      attachmentInputs: [],
      effortLevels: [],
      accessProfilesSupported: ["readonly", "workspace_write", "full"],
      readonlyMechanism: "none",
      delegation: {
        available: false,
        reason: "manifest_unsupported",
        remediation: "Choose another harness.",
        requiresFullAccess: false,
      },
      setupLogin: { mode: "external_terminal" },
    });
    expect(row.setupLogin).toEqual({ mode: "external_terminal" });

    const catalog = AgentCapabilityCatalog.safeParse({
      ok: true,
      version: "3.6.0",
      generatedAt: "2026-08-19T00:00:00Z",
      git: {
        status: "missing",
        version: null,
        detail: "Git is not installed.",
        remediation: "Install Git.",
      },
      harnesses: [row],
      availableHarnesses: ["agy"],
      modes: ["ask", "plan", "agent"],
      runControlKeys: [],
      runDecisionActions: [],
      outputSchemaDialects: [
        {
          dialect: "draft-07",
          uri: "http://json-schema.org/draft-07/schema#",
          defaultWhenOmitted: true,
        },
      ],
      mutability: {
        readOnlyModes: ["ask", "plan"],
        writeModes: ["agent"],
        isolationKinds: ["envelope", "live"],
        workspaceModes: ["in_place", "isolated"],
        accessProfiles: ["readonly", "workspace_write", "full"],
        applyModes: ["apply", "commit", "branch", "pr"],
      },
      cliCommands: [],
      mcpTools: [],
      runApplyStates: [],
    });
    expect(catalog.success).toBe(true);
  });
});

describe("frozen typed profile/setup/quota receipts", () => {
  const receipt = {
    executionId: "exec-1",
    commandDigest: "a".repeat(64),
    manifestDigest: "b".repeat(64),
    permitIssuedAt: null,
    commandStarted: false,
    exitCode: null,
    signal: null,
    finishedAt: "2026-08-19T00:00:00Z",
  };

  it("accepts every terminal transport code and enforces its command-start boundary", () => {
    for (const errorCode of [
      "terminal_transport_unavailable",
      "terminal_transport_unsupported",
      "terminal_transport_probe_failed",
      "terminal_transport_failed",
    ] as const) {
      expect(SetupNativeCommandReceipt.safeParse({ ...receipt, errorCode }).success).toBe(true);
    }
    expect(
      SetupNativeCommandReceipt.safeParse({
        ...receipt,
        permitIssuedAt: "2026-08-19T00:00:00Z",
        commandStarted: true,
        errorCode: "terminal_transport_probe_failed",
      }).success,
    ).toBe(false);
    expect(
      SetupNativeCommandReceipt.safeParse({
        ...receipt,
        permitIssuedAt: "2026-08-19T00:00:00Z",
        commandStarted: true,
        errorCode: "terminal_transport_failed",
      }).success,
    ).toBe(true);
  });

  it("admits the exact ambiguity quota reason", () => {
    expect(
      QuotaAbsence.parse({
        subject: {
          harness: "agy",
          credential_route: "vendor_native",
          subject_id: "work",
        },
        reason: "credential_profile_ambiguous",
        observed_at: "2026-08-19T00:00:00Z",
      }).reason,
    ).toBe("credential_profile_ambiguous");
  });

  it("keeps old delete receipts readable and accepts exact vendor custody disclosure", () => {
    const profile = {
      profile_id: "work",
      harness_id: "agy",
      display_name: "Work",
      credential_kind: "config_dir_login" as const,
      isolation_locator: "/profiles/agy-work",
      secret_ref: null,
      enabled: true,
      created_at: null,
    };
    const legacy = ControlCredentialProfileDeleteResponse.parse({
      profile,
      removed: true,
      credentialCleanup: "config_dir_removed",
    });
    expect(legacy).not.toHaveProperty("vendorCredentialDisposition");

    const current = ControlCredentialProfileDeleteResponse.parse({
      profile,
      removed: true,
      credentialCleanup: "config_dir_removed",
      vendorCredentialDisposition: {
        owner: "vendor",
        state: "left_unchanged",
        scope: "os_user",
      },
    });
    expect(current.vendorCredentialDisposition).toEqual({
      owner: "vendor",
      state: "left_unchanged",
      scope: "os_user",
    });
  });
});
