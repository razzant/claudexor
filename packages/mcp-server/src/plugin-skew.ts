import { resolve } from "node:path";
import { defaultUserConfigDir, engineBuildIdentity } from "@claudexor/util";

/** Pre-handshake refusal for stale host-plugin artifacts. Hosts observe a
 * spawn failure (stable redacted stderr + nonzero exit), not a typed MCP
 * response — no transport exists yet by design. */
class PluginArtifactSkewError extends Error {
  public readonly code = "plugin_artifact_skew";
  public readonly requiredActions = [
    "run `claudexor plugin repair all`",
    "reload the host so it re-reads the regenerated artifacts",
  ];
  constructor(detail: string) {
    super(
      `plugin_artifact_skew: ${detail}; run \`claudexor plugin repair all\` and reload the host`,
    );
    this.name = "PluginArtifactSkewError";
  }
}

/**
 * Installed host plugins export CLAUDEXOR_PLUGIN_VERSION into the server env
 * (plugins.ts). A mismatch with the running CLI means the host is driving a
 * NEWER/OLDER runtime than the artifacts it discovered; a frozen non-default
 * CLAUDEXOR_CONFIG_DIR without the explicit-override provenance marker means
 * a legacy artifact is pointing this runtime at a data root whose contracts
 * it does not own (the 2026-07-21 incident). Both are hard refusals — a
 * stderr warning proved ignorable. Non-plugin launches (no
 * CLAUDEXOR_PLUGIN_VERSION: dev, tests, manual `mcp serve`) are untouched.
 */
export function assertNoPluginArtifactSkew(serverVersion: string | undefined): void {
  const pluginVersion = process.env["CLAUDEXOR_PLUGIN_VERSION"];
  if (!pluginVersion) return;
  // The env value is environment-sourced: never echo arbitrary content to
  // the log — a non-version-shaped value is disclosed generically.
  const shown = /^[\w.+-]{1,32}$/.test(pluginVersion) ? pluginVersion : "<non-version value>";
  const identity = engineBuildIdentity();
  const diag = `engine ${identity.version} (${identity.sha.slice(0, 12)}) at ${identity.entry}`;
  if (serverVersion && pluginVersion !== serverVersion) {
    throw new PluginArtifactSkewError(
      `host plugin artifacts are version ${shown} but the CLI is ${serverVersion} [${diag}]`,
    );
  }
  const frozenRoot = process.env["CLAUDEXOR_CONFIG_DIR"]?.trim();
  if (
    frozenRoot &&
    process.env["CLAUDEXOR_ROOT_MODE"] !== "explicit" &&
    resolve(frozenRoot) !== resolve(defaultUserConfigDir())
  ) {
    throw new PluginArtifactSkewError(
      `host plugin artifacts freeze a foreign config root (neither this build's default nor a marked explicit override) [${diag}]`,
    );
  }
}
