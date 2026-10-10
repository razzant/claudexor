/**
 * An EXACT dotted vendor-CLI version — the compile-time shape behind every
 * remote vendor-install pin (issue #89). Dist-tags (`latest`), ranges
 * (`^1.2.3`), and prerelease suffixes do not typecheck, so a pin can only
 * name one exact version npm verifies registry integrity for: two installs
 * from the same Claudexor build produce the same binary.
 */
export type PinnedVendorCliVersion = `${number}.${number}.${number}`;
