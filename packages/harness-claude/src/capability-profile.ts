import type { HarnessCapabilityProfile } from "@claudexor/schema";
import { HarnessCapabilityProfile as HarnessCapabilityProfileSchema } from "@claudexor/schema";
import { CLAUDE_VENDOR_CLI_VERSION } from "./vendor-cli-version.js";

/** One manifest-owned declaration of the managed login's stdin contract. */
export const CLAUDE_MANAGED_LOGIN = { stdin: "pipe" } as const;

/**
 * Manifest model truth source (strict model-truth validation: an explicit
 * model outside this list is refused, never forwarded to die as a native
 * error). Stable aliases plus current full ids; verified against the vendor
 * model-config docs and the INSTALLED CLI recorded in
 * `CLAUDE_KNOWN_MODELS_VERIFIED_AGAINST`.
 */
export const CLAUDE_KNOWN_MODELS: readonly string[] = [
  "sonnet",
  "opus",
  "haiku",
  "fable",
  "best",
  // Fable 5.1 requires Claude Code >= 2.1.251. The historical 2.1.261
  // capture observed claude-fable-5-1; this pin bump does not re-date it.
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-sonnet-5",
  // Opus 5.5 arrived in Claude Code 2.1.280 ("Added Claude Opus 5.5
  // (`claude-opus-5-5`), now the default Opus model"). Verified against the
  // pinned binary — the id appears in its own platform model tables — and
  // against the vendor's model overview, which publishes `claude-opus-5-5` as
  // both the Claude API ID and the alias. Added, never substituted: the older
  // full ids below stay admissible on accounts that still serve them.
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
];

/** Translate the vendor quota API's family display name (currently e.g.
 * `Fable`) into the same model ids/aliases the harness manifest admits. The
 * known-model list remains the SSOT: a newly verified full id automatically
 * joins its family without another quota-router patch. */
export function claudeQuotaModelAliases(displayName: string): string[] {
  const family = displayName.trim().toLowerCase();
  if (!family) return [];
  const aliases = CLAUDE_KNOWN_MODELS.filter(
    (model) => model === family || model.startsWith(`claude-${family}-`),
  );
  // Preserve an honest model-scoped constraint even before a newly surfaced
  // family joins the verified manifest. It will not exclude a different known
  // model or refuse an intentional native-default route before the vendor has
  // disclosed which model it actually selected.
  return [...new Set([...(aliases.length > 0 ? aliases : [family]), "best"])];
}

/** Installed vendor CLI the known-model list above was last live-verified
 * against (the strict freshness gate compares this against the live CLI).
 * Aliases the per-package vendor-version SSOT so the freshness gate and the
 * remote installer's pin read the SAME value (vendor-cli-version.ts). */
export const CLAUDE_KNOWN_MODELS_VERIFIED_AGAINST: string = CLAUDE_VENDOR_CLI_VERSION;

export const CLAUDE_CAPABILITY_PROFILE: HarnessCapabilityProfile =
  HarnessCapabilityProfileSchema.parse({
    auth: {
      supported_sources: ["native_session", "oauth_token_env", "api_key_env"],
      preferred_source: null,
      credential_transports: [
        { source: "native_session", kind: "config_file", relocatable_by: ["CONFIG_DIR"] },
        { source: "native_session", kind: "os_keychain", relocatable_by: ["HOME"] },
        { source: "oauth_token_env", kind: "oauth_token_env", relocatable_by: ["ENV"] },
        { source: "api_key_env", kind: "env_var", relocatable_by: ["ENV"] },
      ],
      managed_login: CLAUDE_MANAGED_LOGIN,
    },
    access_control: { readonly_mechanism: "tool_allowlist", write_mechanism: "tool_policy" },
    isolation: {
      supported_containment: ["scoped_home_keychain_bridge", "env_or_file_injection"],
    },
    mcp_injection: true,
    // Claude does not sandbox its MCP servers, so the belt reaches the daemon at
    // workspace_write — no full-access requirement (contrast codex).
    mcp_injection_requires_full_access: false,
    attachment_inputs: [
      {
        kind: "image",
        mime_types: ["image/png", "image/jpeg", "image/gif", "image/webp"],
        max_bytes: 5 * 1024 * 1024,
        max_count: 20,
        transport: "base64_stream",
      },
      {
        kind: "file",
        mime_types: ["text/plain", "text/markdown", "application/json"],
        max_bytes: 1 * 1024 * 1024,
        max_count: 10,
        transport: "text_inline",
      },
    ],
  });
