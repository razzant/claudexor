/**
 * Shared endpoint tooling for the docs-truth gate and the generated endpoint
 * inventory (single producer — INV-122). Two independent halves:
 *
 *  - `implementedEndpoints()` scrapes the literal + regex route guards actually
 *    wired in daemon-server.ts and the `*-routes.ts` modules; it self-checks
 *    that every declared regex route is bound to a method guard so refactors
 *    cannot silently shrink the implemented set. This is the DRIFT DETECTOR the
 *    freshness gate runs against the descriptors.
 *  - `endpointDetails()` DERIVES the machine-readable endpoint map
 *    (docs/reference/endpoints.json) from the code-first route descriptors — the
 *    runtime OPERATION_CATALOG — so schema names, mutability, summary and auth
 *    all come from one source (Zen #4). No handler-flow scraping, no override
 *    maps; a descriptor without a wired guard (or vice versa) fails docs-truth.
 */
import { readdirSync, readFileSync } from "node:fs";

const DEFAULT_ROUTE_SOURCES = [
  "packages/control-api/src/daemon-server.ts",
  ...readdirSync("packages/control-api/src")
    .filter((name) => name.endsWith("-routes.ts"))
    .sort()
    .map((name) => `packages/control-api/src/${name}`),
];

function sourcePaths(input) {
  return input === undefined ? DEFAULT_ROUTE_SOURCES : Array.isArray(input) ? input : [input];
}

/** Route guard positions + templates (shared by the set and detail views). */
function routeSites(src) {
  const sites = [];
  const litRe = /method === "(GET|POST|DELETE|PUT|PATCH)"\s*&&\s*path === "([^"]+)"/g;
  for (let m = litRe.exec(src); m; m = litRe.exec(src)) {
    sites.push({ method: m[1], path: `/v2${m[2]}`, index: m.index });
  }
  const regexByName = new Map();
  const declRe = /const (\w+Match) = (\/\^[^;]+\/)\.exec\(path\);/g;
  for (let m = declRe.exec(src); m; m = declRe.exec(src)) regexByName.set(m[1], m[2]);
  const useRe = /method === "(\w+)" && (\w+Match)\b/g;
  for (let m = useRe.exec(src); m; m = useRe.exec(src)) {
    const pattern = regexByName.get(m[2]);
    if (!pattern) continue;
    let template = pattern
      .replace(/^\/\^/, "")
      .replace(/\$\/$/, "")
      .replaceAll("\\/", "/")
      .replace(/\(\[\^\/\]\+\)/g, ":id")
      .replace(/\(\.\+\)/g, "<path>");
    if (template === "/credential-profiles/:id/:id") {
      template = "/credential-profiles/:harness/:profileId";
    }
    sites.push({ method: m[1], path: `/v2${template}`, index: m.index });
  }
  for (const [name] of regexByName) {
    if (!src.includes(`&& ${name}`)) {
      throw new Error(
        `endpoint extractor: regex route '${name}' is declared but never used with a method guard`,
      );
    }
  }
  return sites;
}

export function implementedEndpoints(input) {
  const out = new Set();
  for (const srcPath of sourcePaths(input)) {
    const src = readFileSync(srcPath, "utf8");
    for (const site of routeSites(src)) out.add(`${site.method} ${site.path}`);
  }
  out.add("POST /v2/handshake");
  out.add("GET /v2/operations");
  out.add("GET /healthz"); // declared before auth with hostIsLoopback guard
  return out;
}

/**
 * Endpoint detail map: [{method, path, mutating, summary, auth, requestSchema,
 * responseSchema, errorSchema}]. This is now DERIVED from the code-first route
 * descriptors — the runtime OPERATION_CATALOG (packages/control-api/src/
 * operation-catalog.ts) — instead of scraping handler control-flow. The
 * descriptors ARE the single source of truth (Zen #4); schema names, mutability
 * and summaries come straight from them, so the fragile regex scrape + hand-kept
 * override maps are gone. `implementedEndpoints()` still scrapes the daemon
 * route guards independently, as the drift detector that fails when a descriptor
 * and its wired handler disagree.
 *
 * The built dist must exist (docs:check builds control-api first). Async because
 * it dynamically imports the compiled catalog module.
 */
export async function endpointDetails() {
  let OPERATION_CATALOG;
  try {
    ({ OPERATION_CATALOG } = await import("../packages/control-api/dist/operation-catalog.js"));
  } catch (error) {
    throw new Error(
      `endpoint descriptors: cannot load the built operation catalog (run \`pnpm --filter @claudexor/control-api build\` first): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const details = OPERATION_CATALOG.operations.map((op) => ({
    method: op.method,
    path: op.path,
    mutating: op.mutability === "mutating",
    summary: op.summary,
    auth: op.auth,
    requestSchema: op.requestSchema,
    responseSchema: op.responseSchema,
    errorSchema: op.errorSchema,
  }));
  // The unversioned loopback health probe is not a product operation, but the
  // machine map documents it (no product error body, loopback-only).
  details.push({
    method: "GET",
    path: "/healthz",
    mutating: false,
    summary: "Loopback liveness probe (pre-auth).",
    auth: "loopback_only",
    requestSchema: null,
    responseSchema: null,
    errorSchema: null,
  });
  return details.sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
  );
}

/** Deterministic machine artifact for external agents (docs/reference/endpoints.json). */
export function renderEndpointsJson(details) {
  return (
    JSON.stringify(
      {
        $comment:
          "Generated by scripts/gen-endpoints-doc.mjs from the code-first route descriptors (packages/control-api operation catalog) — do not edit. Schema names reference packages/schema/generated/<Name>.schema.json. Loopback + bearer-token auth applies to every route except GET /healthz.",
        endpoints: details.map((d) => ({
          method: d.method,
          path: d.path,
          mutating: d.mutating,
          summary: d.summary,
          auth: d.auth,
          request_schema: d.requestSchema,
          response_schema: d.responseSchema,
          error_schema: d.errorSchema,
        })),
      },
      null,
      2,
    ) + "\n"
  );
}

export const GEN_BEGIN =
  "<!-- BEGIN GENERATED ENDPOINTS (node scripts/gen-endpoints-doc.mjs; do not edit by hand) -->";
export const GEN_END = "<!-- END GENERATED ENDPOINTS -->";

/** Deterministic rendering of the generated inventory block. */
export function renderEndpointBlock(endpoints) {
  const sorted = [...endpoints].sort((a, b) => {
    const [, pa] = a.split(" ");
    const [, pb] = b.split(" ");
    return pa === pb ? a.localeCompare(b) : pa.localeCompare(pb);
  });
  const lines = sorted.map((e) => `- \`${e}\``);
  return `${GEN_BEGIN}\n${lines.join("\n")}\n${GEN_END}`;
}
