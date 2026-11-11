import { HarnessCapabilityProfile, HarnessManifest } from "@claudexor/schema";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import type { AcpEntry } from "./entry.js";

export function acpCapabilityProfile() {
  return HarnessCapabilityProfile.parse({
    auth: {
      supported_sources: ["api_key_env"],
      credential_transports: [{ source: "api_key_env", kind: "env_var", relocatable_by: ["ENV"] }],
    },
    access_control: {
      readonly_mechanism: "tool_allowlist",
      write_mechanism: "none",
      auxiliary_writable_roots: false,
    },
    isolation: { supported_containment: ["env_or_file_injection"] },
    live_input: "none",
    mcp_injection: false,
    attachment_inputs: [],
  });
}

export function acpManifest(entry: AcpEntry, version: string, profile: HarnessCapabilityProfile) {
  return HarnessManifest.parse({
    id: entry.id,
    display_name: entry.displayName,
    kind: "local_cli",
    version,
    adapter_version: CLAUDEXOR_VERSION,
    provider_family: "unknown",
    capability_profile: profile,
    capabilities: {
      plan: true,
      implement: true,
      create_from_scratch: true,
      review: true,
      verify: true,
      synthesize: true,
      read_files: true,
      tool_lists: true,
      json_schema_output: false,
      // The engine instructs and validates a final fenced WorkReport itself.
      work_report_transport: "validated",
      model_inventory_absence: "advisory",
      effort_levels: entry.effortLevels,
      // Unverified fallback ids are models() rows with origin=hint, not a
      // manifest known_models list (which requires a live verification stamp).
      web_policy: "uncontrolled",
    },
    auth_modes: ["api_key"],
    access_profiles_supported: ["readonly", "workspace_write", "full", "inherit_native"],
  });
}
