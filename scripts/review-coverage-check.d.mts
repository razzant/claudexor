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
export function parseNameStatusZ(raw: string): Array<{ path: string; deleted: boolean }>;
export function unionWithWholeFileList(
  files: Array<{ path: string; deleted: boolean }>,
  listText: string | null,
): Array<{ path: string; deleted: boolean }>;
export function coverageReceiptBody(
  report: ReturnType<typeof checkCoverage>,
  input: {
    base: string;
    candidate: string;
    packs: readonly string[];
    packContents: readonly string[];
    wholeFileList?: string | null;
  },
): {
  schemaVersion: 1;
  ok: boolean;
  base: string;
  candidate: string;
  packs: Array<{ path: string; sha256: string }>;
  wholeFileList: string | null;
  covered: number;
  uncovered: Array<{ path: string; reason: string }>;
  diffAuthoritativeSkips: number;
  deleted: number;
};
