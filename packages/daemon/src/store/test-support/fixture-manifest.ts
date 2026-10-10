import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-api";

const supportRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(supportRoot, "../../../../..");
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
interface SharedSource {
  path: string;
  baselineGitBlob: string;
  baselineSha256: string;
  sha256: string;
  unusedDeclarations?: string[];
  remainderSha256?: string;
}
export interface FixtureManifest {
  schemaVersion: number;
  baseline: string;
  rootFiles: string[];
  snapshots: Snapshot[];
  shared: SharedSource[];
  externalPackages: string[];
  lockfile: { path: string; sha256: string; gitBlob: string };
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

// Shared sources may be checked out as CRLF on Windows; pins name Git's LF text.
// Frozen files/fixture bytes keep LF through their scoped .gitattributes.
const readSharedText = (path: string) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");

function sourceFile(path: string, text: string) {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

/** Only the three enumerated PR-A additions/unused function changed outside the snapshot. */
function remainder(path: string, text: string, ignored: string[]): string {
  const source = sourceFile(path, text);
  return source.statements
    .filter((node) => {
      const names = ts.isVariableStatement(node)
        ? node.declarationList.declarations.map((declaration) => declaration.name.getText(source))
        : (ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name
          ? [node.name.text]
          : [];
      return !names.some((name) => ignored.includes(name));
    })
    .map((node) => node.getFullText(source))
    .join("");
}

function moduleImports(path: string, text: string): Array<{ specifier: string; names: string[] }> {
  const source = sourceFile(path, text);
  const imports: Array<{ specifier: string; names: string[] }> = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        const bindings = ts.isImportDeclaration(node)
          ? node.importClause?.namedBindings
          : undefined;
        imports.push({
          specifier: node.moduleSpecifier.text,
          names:
            bindings && ts.isNamedImports(bindings)
              ? bindings.elements.map((element) => (element.propertyName ?? element.name).text)
              : bindings && ts.isNamespaceImport(bindings)
                ? ["*"]
                : [],
        });
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push({ specifier: node.arguments[0].text, names: ["*"] });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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
  const shared = new Set(manifest.shared.map((row) => row.path));
  const originalPaths = new Set(manifest.snapshots.map((row) => row.sourcePath));
  for (const path of manifest.rootFiles) check(originalPaths.has(path), `missing root: ${path}`);
  const sources: Array<{ path: string; text: string; frozen: boolean }> = [];
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
    sources.push({ path: row.snapshotPath, text, frozen: true });
  }
  for (const row of manifest.shared) {
    const text = readSharedText(resolve(repoRoot, row.path));
    check(sha256(text) === row.sha256, `shared dependency changed: ${row.path}`);
    if (row.unusedDeclarations) {
      check(
        sha256(remainder(row.path, text, row.unusedDeclarations)) === row.remainderSha256,
        `shared used declarations changed: ${row.path}`,
      );
    } else {
      check(
        sha256(text) === row.baselineSha256 && gitBlob(text) === row.baselineGitBlob,
        `shared baseline mismatch: ${row.path}`,
      );
    }
    if (row.path.endsWith(".ts")) sources.push({ path: row.path, text, frozen: false });
  }
  const unused = new Set(
    manifest.shared.flatMap((row) => row.unusedDeclarations ?? []).filter((name) => name !== "ms"),
  );
  for (const source of sources) {
    for (const imported of moduleImports(source.path, source.text)) {
      const { specifier, names } = imported;
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".")) {
        const target = posix
          .normalize(posix.join(posix.dirname(source.path), specifier))
          .replace(/\.js$/, ".ts");
        check(
          (source.frozen ? snapshots : shared).has(target),
          `unsealed local import: ${source.path} -> ${specifier}`,
        );
      } else if (specifier.startsWith("@claudexor/")) {
        check(
          shared.has(`packages/${specifier.split("/")[1]}/src/index.ts`),
          `unsealed package: ${specifier}`,
        );
        check(
          !names.includes("*") && names.every((name) => !unused.has(name)),
          `unused-declaration proof invalid: ${source.path}`,
        );
      } else {
        check(manifest.externalPackages.includes(specifier), `unsealed external: ${specifier}`);
      }
    }
  }
  const lock = readSharedText(resolve(repoRoot, manifest.lockfile.path));
  check(
    sha256(lock) === manifest.lockfile.sha256 && gitBlob(lock) === manifest.lockfile.gitBlob,
    "lockfile drift",
  );
  for (const fixture of manifest.fixtures) {
    check(
      sha256(readFileSync(resolve(supportRoot, fixture.path), "utf8")) === fixture.sha256,
      `fixture changed: ${fixture.path}`,
    );
  }
  return errors;
}
