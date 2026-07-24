#!/usr/bin/env node
/**
 * QA-067 artifact text-extension parity guard.
 *
 * The macOS app hand-maintains `ArtifactCategory.semanticTextExtensions`
 * (ArtifactGalleryView.swift) as a mirror of the server's text-serving decision
 * in `isTextArtifact` (packages/control-api/src/artifact-serve-routes.ts). If the
 * two drift, the app either sends a server-redacted TEXT artifact down the raw
 * "open externally" binary path, or eager-previews a server-binary file as text.
 * A Swift-side test can't read the TS source, so this cross-source check reads
 * BOTH real files and fails loudly on drift.
 *
 * The server treats an artifact as text when EITHER its MIME is `text/*` /
 * `application/json`, OR its extension is in the explicit `SEMANTIC_TEXT_EXTENSIONS`
 * set. The Swift set is the flattened union of both tiers, so the exact relation
 * this guard pins is:
 *
 *   swift == (SEMANTIC_TEXT_EXTENSIONS, dots stripped) ∪ MIME_TEXT_GROUP
 *
 * where MIME_TEXT_GROUP is the small fixed set of extensions the server serves as
 * text via MIME (not via the explicit set). A new server extension not mirrored
 * in Swift, a stray Swift extension, or a change to either list fails here.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsPath = join(root, "packages/control-api/src/artifact-serve-routes.ts");
// The Swift owner of semanticTextExtensions moved once already (gallery →
// support extraction); locate it by MARKER across the app sources so a
// refactor relocates the set without silently breaking this gate.
const swiftSourcesDir = join(root, "apps/macos/ClaudexorApp/Sources/ClaudexorApp");
function findSwiftOwner(marker) {
  const candidates = readdirSync(swiftSourcesDir)
    .filter((name) => name.endsWith(".swift"))
    .map((name) => join(swiftSourcesDir, name))
    .filter((path) => readFileSync(path, "utf8").includes(marker));
  if (candidates.length !== 1) {
    throw new Error(
      `parity check: expected exactly ONE Swift owner of "${marker}", found ${candidates.length}`,
    );
  }
  return candidates[0];
}
const swiftPath = findSwiftOwner("semanticTextExtensions: Set<String> = [");

/** Extensions the server serves as text via MIME (text/* or application/json),
 * NOT via the explicit SEMANTIC_TEXT_EXTENSIONS set. Fixed + documented: adding a
 * new MIME-text extension is a deliberate change that updates this list too. */
const MIME_TEXT_GROUP = new Set(["md", "txt", "yaml", "yml", "json", "log"]);

/** Extract the quoted string tokens inside `<marker> ... <closer>`. */
function extractSet(source, startMarker, closer) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`parity check: could not find "${startMarker}"`);
  const end = source.indexOf(closer, start);
  if (end === -1)
    throw new Error(`parity check: could not find "${closer}" after "${startMarker}"`);
  const body = source.slice(start + startMarker.length, end);
  const tokens = body.match(/"([^"]+)"/g) ?? [];
  return tokens.map((t) => t.slice(1, -1));
}

const serverRaw = extractSet(
  readFileSync(tsPath, "utf8"),
  "SEMANTIC_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([",
  "]);",
);
const server = new Set(serverRaw.map((e) => e.replace(/^\./, "").toLowerCase()));

const swiftRaw = extractSet(
  readFileSync(swiftPath, "utf8"),
  "semanticTextExtensions: Set<String> = [",
  "]",
);
const swift = new Set(swiftRaw.map((e) => e.toLowerCase()));

const failures = [];

// (1) every server explicit-text extension must be Swift-text.
for (const ext of server) {
  if (!swift.has(ext)) {
    failures.push(
      `server SEMANTIC_TEXT_EXTENSIONS has ".${ext}" but the app's semanticTextExtensions does NOT ` +
        `— the app would send a server-redacted text artifact down the raw "open externally" path.`,
    );
  }
}

// (2) Swift's extras over the server set must be EXACTLY the fixed MIME-text group.
for (const ext of swift) {
  if (server.has(ext) || MIME_TEXT_GROUP.has(ext)) continue;
  failures.push(
    `the app's semanticTextExtensions has "${ext}" but the server treats it as neither ` +
      `SEMANTIC_TEXT_EXTENSIONS nor MIME-text — the app would eager-preview a server-binary file as text.`,
  );
}
for (const ext of MIME_TEXT_GROUP) {
  if (!swift.has(ext)) {
    failures.push(
      `MIME_TEXT_GROUP expects the app to list "${ext}" (served as text/* or application/json) but it is missing.`,
    );
  }
}

if (failures.length > 0) {
  console.error("artifact-text-parity-check FAILED (QA-067 drift):\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    `\n  server (SEMANTIC_TEXT_EXTENSIONS): ${[...server].sort().join(", ")}` +
      `\n  app   (semanticTextExtensions):   ${[...swift].sort().join(", ")}` +
      `\n  fixed MIME-text group:            ${[...MIME_TEXT_GROUP].sort().join(", ")}` +
      `\n\nReconcile ArtifactGalleryView.swift, artifact-serve-routes.ts, and MIME_TEXT_GROUP in this script.`,
  );
  process.exit(1);
}

console.log(
  `artifact-text-parity-check: OK (${server.size} server + ${MIME_TEXT_GROUP.size} MIME-text ` +
    `== ${swift.size} app extensions)`,
);
