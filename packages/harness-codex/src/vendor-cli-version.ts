import type { VendorCliVersionStamp } from "@claudexor/util";

/**
 * The Codex version used to record effort, model-hint and native fixtures.
 * The HTTP catalog declares its separate transport stamp in
 * http-client-version.ts. Bump this value only while re-recording the related
 * snapshots and fixtures. A new version does not inherit native input-limit
 * evidence: re-probe that bound before updating its provenance.
 */
export const CODEX_VENDOR_CLI_VERSION: VendorCliVersionStamp = "0.162.1";
