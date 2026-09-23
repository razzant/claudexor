import type { PinnedVendorCliVersion } from "@claudexor/util";

/**
 * The ONE Claude vendor-CLI version this Claudexor release is verified
 * against — the pinned-install SSOT (issue #89). Three readers alias it and
 * therefore can never drift apart:
 * - `CLAUDE_KNOWN_MODELS_VERIFIED_AGAINST` (model-truth freshness gate),
 * - `CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST` (effort-snapshot trust gate),
 * - the remote harness installer's exact `@anthropic-ai/claude-code@<v>` pin.
 * Bump it ONLY while re-verifying the known-model list and re-recording the
 * effort snapshot against the same CLI build — the stamp is a verification
 * claim, not a wish.
 */
export const CLAUDE_VENDOR_CLI_VERSION: PinnedVendorCliVersion = "2.1.280";
