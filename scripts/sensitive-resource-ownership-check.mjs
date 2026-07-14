#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const OWNER = "packages/util/src/sensitive-resource.ts";
const GATE = "scripts/sensitive-resource-ownership-check.mjs";
const ALLOWED_DELEGATES = new Set([
  "packages/util/src/index.ts:redactSecrets",
  "scripts/commit-review.mjs:redactSecrets",
]);

const OWNED_IDENTIFIER =
  /(?:sensitive|secret|credential).*(?:path|basename|extension|pattern|classifier|redact)|(?:path|basename|extension|pattern|classifier|redact).*(?:sensitive|secret|credential)/i;
const LEGACY_IDENTIFIERS = new Set([
  "SENSITIVE",
  "SECRET_PATTERNS",
  "isReviewerSecretLikePathPart",
  "isSafeEnvTemplateName",
]);

const PATH_MARKERS = [
  /(?:^|[/\\*])\.env(?:rc)?(?:[./\\*]|$)/i,
  /(?:^|[/\\*])\.(?:anthropic|aws|azure|claude|codex|cursor|docker|gcloud|gnupg|kube|openai|ssh)(?:[/\\*]|$)/i,
  /(?:^|[/\\*])\.(?:git-credentials|netrc|npmrc|pypirc)(?:[/\\*]|$)/i,
  /(?:^|[/\\*])(?:credentials|secrets)(?:[./\\*_-]|$)/i,
  /(?:^|[/\\*])id_(?:dsa|ecdsa|ed25519|rsa)(?:[./\\*_-]|$)/i,
  /\.(?:jks|key|keystore|p12|pem|pfx)(?:[/\\*]|$)/i,
];

const CONTENT_MARKERS = [
  /github_pat_|ghp_|gho_|ghs_|ghu_/i,
  /glpat-|sk-ant-|sk-or-v1-|sk-/i,
  /AIza|xai-|AKIA/i,
  /xox\[|xox[abceprs]-|key_/i,
  /ya29|npm_|PRIVATE KEY|Bearer|eyJ/i,
];

export function findSensitiveResourceOwnershipViolations(root = DEFAULT_ROOT) {
  const violations = [];
  for (const file of sourceFiles(root)) {
    const rel = relative(root, file).replaceAll("\\", "/");
    if (rel === OWNER || rel === GATE) continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx")
        ? ts.ScriptKind.TSX
        : file.endsWith(".ts")
          ? ts.ScriptKind.TS
          : ts.ScriptKind.JS,
    );
    visit(source, source, rel, violations);
  }
  return violations;
}

function visit(node, source, rel, violations) {
  const declaredName = declarationName(node);
  if (
    declaredName &&
    !ALLOWED_DELEGATES.has(`${rel}:${declaredName}`) &&
    (LEGACY_IDENTIFIERS.has(declaredName) || OWNED_IDENTIFIER.test(declaredName))
  ) {
    addViolation(
      source,
      node,
      rel,
      `classifier-like declaration '${declaredName}' lives outside ${OWNER}`,
      violations,
    );
  }

  if (ts.isArrayLiteralExpression(node)) {
    const literals = node.elements.map(literalText).filter((value) => value !== null);
    const pathHits = markerHits(literals, PATH_MARKERS);
    const contentHits = markerHits(literals, CONTENT_MARKERS);
    if (pathHits >= 2) {
      addViolation(
        source,
        node,
        rel,
        "sensitive path marker cluster lives outside the policy owner",
        violations,
      );
    }
    if (contentHits >= 2) {
      addViolation(
        source,
        node,
        rel,
        "secret content-signature cluster lives outside the policy owner",
        violations,
      );
    }
  }

  ts.forEachChild(node, (child) => visit(child, source, rel, violations));
}

function declarationName(node) {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  ) {
    return node.name && ts.isIdentifier(node.name) ? node.name.text : null;
  }
  return null;
}

function literalText(node) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) return node.text;
  return null;
}

function markerHits(literals, markers) {
  return markers.filter((marker) => literals.some((value) => marker.test(value))).length;
}

function addViolation(source, node, rel, reason, violations) {
  const location = source.getLineAndCharacterOfPosition(node.getStart(source));
  const key = `${rel}:${location.line + 1}:${reason}`;
  if (violations.some((violation) => violation.key === key)) return;
  violations.push({ key, file: rel, line: location.line + 1, reason });
}

function sourceFiles(root) {
  const roots = [resolve(root, "packages"), resolve(root, "scripts")];
  const files = [];
  for (const candidate of roots) walk(candidate, files);
  return files.filter((file) => {
    const rel = relative(root, file).replaceAll("\\", "/");
    return (
      /\.(?:cjs|js|mjs|ts|tsx)$/.test(file) &&
      !/\.(?:test|spec)\.(?:cjs|js|mjs|ts|tsx)$/.test(file) &&
      !rel.includes("/dist/") &&
      !rel.includes("/fixtures/") &&
      !rel.includes("/generated/")
    );
  });
}

function walk(path, files) {
  let stat;
  try {
    stat = statSync(path, { throwIfNoEntry: false });
  } catch {
    return;
  }
  if (!stat) return;
  if (stat.isFile()) {
    files.push(path);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path)) {
    if (["dist", "node_modules"].includes(entry)) continue;
    walk(resolve(path, entry), files);
  }
}

function requestedRoot(argv) {
  const index = argv.indexOf("--root");
  if (index === -1) return DEFAULT_ROOT;
  const value = argv[index + 1];
  if (!value) throw new Error("--root requires a path");
  return resolve(value);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = requestedRoot(process.argv.slice(2));
  const violations = findSensitiveResourceOwnershipViolations(root);
  if (violations.length > 0) {
    console.error(`sensitive-resource-ownership: FAIL (${violations.length})`);
    for (const violation of violations) {
      console.error(`- ${violation.file}:${violation.line} ${violation.reason}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`sensitive-resource-ownership: OK (owner ${OWNER})`);
  }
}
