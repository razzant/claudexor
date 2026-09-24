import type { PinnedVendorCliVersion } from "@claudexor/util";

/**
 * The ONE Codex vendor-CLI version this Claudexor release is verified
 * against — the pinned-install SSOT (issue #89). Readers alias it and
 * therefore can never drift apart:
 * - `CODEX_EFFORT_SNAPSHOT_VERIFIED_AGAINST` (effort-snapshot trust gate),
 * - the remote harness installer's exact `@openai/codex@<v>` pin.
 * Bump it ONLY while re-recording the effort snapshot (and re-checking the
 * manifest's known-model hints) against the same CLI build.
 */
export const CODEX_VENDOR_CLI_VERSION: PinnedVendorCliVersion = "0.156.1";
