import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-api";

const supportRoot = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const LEGACY_BASELINE = "820e849cd15cca47758b700603e156ef29129fbf";

interface Rewrite {
  offset: number;
  from: string;
  to: string;
}
interface Snapshot {
  sourcePath: string;
  snapshotPath: string;
  sourceGitBlob: string;
  sourceSha256: string;
  copiedSha256: string;
  rewrites: Rewrite[];
}
export interface FixtureManifest {
  schemaVersion: number;
  baseline: string;
  rootFiles: string[];
  snapshots: Snapshot[];
  externalPackages: Record<string, string>;
  fixtures: Array<{ path: string; sha256: string }>;
}

export function readFixtureManifest(): FixtureManifest {
  return JSON.parse(readFileSync(resolve(supportRoot, "fixture-manifest.json"), "utf8"));
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const gitBlob = (value: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(value)}\0`)
    .update(value)
    .digest("hex");

function sourceFile(path: string, text: string) {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

function moduleImports(path: string, text: string): string[] {
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile(path, text));
  return imports;
}

/** No Git, download, SQL reducer, or regeneration: verify the checked-in evidence as it is. */
export function verifyFixtureManifest(manifest = readFixtureManifest()): string[] {
  const errors: string[] = [];
  const check = (ok: boolean, detail: string) => {
    if (!ok) errors.push(detail);
  };
  check(manifest.baseline === LEGACY_BASELINE, "wrong legacy baseline");
  check(manifest.rootFiles.length === 25, "the agreed 25 roots are incomplete");
  const snapshots = new Set(manifest.snapshots.map((row) => row.snapshotPath));
  const originalPaths = new Set(manifest.snapshots.map((row) => row.sourcePath));
  for (const path of manifest.rootFiles) check(originalPaths.has(path), `missing root: ${path}`);
  const sources: Array<{ path: string; text: string }> = [];
  for (const row of manifest.snapshots) {
    const text = readFileSync(resolve(supportRoot, row.snapshotPath), "utf8");
    check(sha256(text) === row.copiedSha256, `snapshot changed: ${row.snapshotPath}`);
    let original = "",
      cursor = 0,
      shift = 0;
    for (const rewrite of row.rewrites) {
      const offset = rewrite.offset + shift;
      check(
        text.slice(offset, offset + rewrite.to.length) === rewrite.to,
        `rewrite drift: ${row.snapshotPath}`,
      );
      original += text.slice(cursor, offset) + rewrite.from;
      cursor = offset + rewrite.to.length;
      shift += rewrite.to.length - rewrite.from.length;
    }
    original += text.slice(cursor);
    check(sha256(original) === row.sourceSha256, `original digest mismatch: ${row.sourcePath}`);
    check(gitBlob(original) === row.sourceGitBlob, `original Git blob mismatch: ${row.sourcePath}`);
    if (row.snapshotPath.endsWith(".ts")) sources.push({ path: row.snapshotPath, text });
  }
  for (const source of sources) {
    for (const specifier of moduleImports(source.path, source.text)) {
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".")) {
        const target = posix
          .normalize(posix.join(posix.dirname(source.path), specifier))
          .replace(/\.js$/, ".ts");
        check(snapshots.has(target), `unsealed local import: ${source.path} -> ${specifier}`);
      } else {
        check(
          Object.hasOwn(manifest.externalPackages, specifier),
          `unsealed external: ${specifier}`,
        );
      }
    }
  }
  // Only the two third-party runtime dependencies remain shared. Unrelated
  // workspace, package version and lockfile edits cannot change the oracle.
  for (const [specifier, version] of Object.entries(manifest.externalPackages)) {
    const packageName = specifier.split("/")[0];
    const metadata = JSON.parse(
      readFileSync(require.resolve(`${packageName}/package.json`), "utf8"),
    );
    check(metadata.version === version, `external version changed: ${specifier}`);
  }
  for (const fixture of manifest.fixtures) {
    check(
      sha256(readFileSync(resolve(supportRoot, fixture.path), "utf8")) === fixture.sha256,
      `fixture changed: ${fixture.path}`,
    );
  }
  return errors;
}
