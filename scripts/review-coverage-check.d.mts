export const GENERATED_ARTIFACT_ALLOWLIST: readonly string[];
export function diffAuthoritativeRule(path: string, allowlist?: readonly string[]): string | null;
export function coverageNeedle(path: string, currentText: string): string;
export function fileCoverage(
  path: string,
  currentText: string,
  packContents: readonly string[],
): { covered: boolean; reason: string | null };
export function checkCoverage(input: {
  files: ReadonlyArray<{ path: string; deleted?: boolean }>;
  readCurrentText: (path: string) => string;
  packContents: readonly string[];
  allowlist?: readonly string[];
}): {
  ok: boolean;
  covered: string[];
  uncovered: Array<{ path: string; reason: string }>;
  skipped: Array<{ path: string; rule: string }>;
  deleted: string[];
};
