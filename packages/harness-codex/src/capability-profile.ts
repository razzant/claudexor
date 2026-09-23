import {
  HarnessCapabilityProfile as HarnessCapabilityProfileSchema,
  type HarnessCapabilityProfile,
} from "@claudexor/schema";

/** One manifest-owned declaration of the managed login's stdin contract. */
export const CODEX_MANAGED_LOGIN = { stdin: "none" } as const;

/**
 * Manifest model truth for the routes the live `model/list` inventory does not
 * answer (INV-104). Lives beside the capability profile for the same reason
 * the claude adapter's `CLAUDE_KNOWN_MODELS` does: vendor model truth changes
 * when the vendor ships models, which is a different trigger from anything in
 * the adapter's run loop, and both adapters should be read the same way.
 *
 * Codex declares `model_inventory_absence: "advisory"`, so on the native route
 * this list ADMITS without being able to refuse; unscoped consumers (settings
 * writes, the doctor, automatic reviewer selection) still judge against it
 * strictly. Entries are added on vendor evidence and retired only on vendor
 * evidence — a bundled catalog that stops listing an id does not prove an
 * account lost it. The current pin's bundled capture verifies its listed
 * entries; other ids retain their earlier evidence, not a new capture claim.
 */
export const CODEX_KNOWN_MODELS: readonly string[] = [
  "gpt-6-astra",
  // GPT-6 Sol and GPT-6 Luna arrived in codex-cli 0.156.1 (rust-v0.156.1,
  // "[hotfix 0.156.0] Add GPT-6 Sol and Luna to the model catalog").
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
];

export const CODEX_CAPABILITY_PROFILE: HarnessCapabilityProfile =
  HarnessCapabilityProfileSchema.parse({
    auth: {
      supported_sources: ["native_session", "provider_auth_file"],
      preferred_source: null,
      credential_transports: [
        { source: "native_session", kind: "config_file", relocatable_by: ["CONFIG_DIR"] },
        { source: "provider_auth_file", kind: "config_file", relocatable_by: ["CONFIG_DIR"] },
      ],
      managed_login: CODEX_MANAGED_LOGIN,
    },
    access_control: { readonly_mechanism: "fs_sandbox", write_mechanism: "fs_sandbox" },
    isolation: { supported_containment: ["host_user_context", "env_or_file_injection"] },
    mcp_injection: true,
    // Codex's workspace-write seatbelt cancels the belt's daemon-crossing MCP
    // call; only full access lets it through.
    mcp_injection_requires_full_access: true,
    attachment_inputs: [
      {
        kind: "image",
        mime_types: ["image/png", "image/jpeg", "image/gif", "image/webp"],
        max_bytes: 20 * 1024 * 1024,
        max_count: 20,
        transport: "file_path",
      },
    ],
  });
