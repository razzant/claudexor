import type { HarnessCapabilityProfile } from "@claudexor/schema";
import { HarnessCapabilityProfile as HarnessCapabilityProfileSchema } from "@claudexor/schema";

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
    },
    access_control: { readonly_mechanism: "tool_allowlist" },
    isolation: {
      supported_containment: ["scoped_home_keychain_bridge", "env_or_file_injection"],
    },
    mcp_injection: true,
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
