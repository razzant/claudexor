import type { VendorCliVersionStamp } from "@claudexor/util";

/**
 * The Claude version used to record the effort snapshot and vendor fixtures.
 * CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST aliases this stamp. Model-hint
 * verification keeps its own stamp: recording effort does not re-check model ids.
 * Bump only while recording those fixtures against the same vendor build.
 */
export const CLAUDE_VENDOR_CLI_VERSION: VendorCliVersionStamp = "2.1.281";
