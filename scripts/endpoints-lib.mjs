/**
 * Shared endpoint extraction for the docs-truth gate and the generated
 * endpoint inventory (single producer — INV-122). Parses the literal and
 * regex route guards in daemon-server.ts; the extractor self-checks that
 * every declared regex route is bound to a method guard so refactors cannot
 * silently shrink the implemented set.
 *
 * v2 also extracts, per route, the REQUEST schema (the `X.parse(...)` guard
 * on the body) and the RESPONSE schema (the zod DTO passed to the service()
 * helper) when the handler declares them — a machine-readable endpoint map
 * (docs/reference/endpoints.json) for external agents, referencing the
 * generated JSON Schemas in packages/schema/generated/.
 */
import { readFileSync } from "node:fs";

/** Route guard positions + templates (shared by the set and detail views). */
function routeSites(src) {
  const sites = [];
  const litRe = /method === "(GET|POST|DELETE|PUT|PATCH)"\s*&&\s*path === "([^"]+)"/g;
  for (let m = litRe.exec(src); m; m = litRe.exec(src)) {
    sites.push({ method: m[1], path: m[2], index: m.index });
  }
  const regexByName = new Map();
  const declRe = /const (\w+Match) = (\/\^[^;]+\/)\.exec\(path\);/g;
  for (let m = declRe.exec(src); m; m = declRe.exec(src)) regexByName.set(m[1], m[2]);
  const useRe = /method === "(\w+)" && (\w+Match)\b/g;
  for (let m = useRe.exec(src); m; m = useRe.exec(src)) {
    const pattern = regexByName.get(m[2]);
    if (!pattern) continue;
    const template = pattern
      .replace(/^\/\^/, "")
      .replace(/\$\/$/, "")
      .replaceAll("\\/", "/")
      .replace(/\(\[\^\/\]\+\)/g, ":id")
      .replace(/\(\.\+\)/g, "<path>");
    sites.push({ method: m[1], path: template, index: m.index });
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

export function implementedEndpoints(srcPath = "packages/control-api/src/daemon-server.ts") {
  const src = readFileSync(srcPath, "utf8");
  const out = new Set(routeSites(src).map((s) => `${s.method} ${s.path}`));
  out.add("GET /healthz"); // declared before auth with hostIsLoopback guard
  return out;
}

/**
 * Endpoint detail map: [{method, path, mutating, requestSchema, responseSchema}].
 * Schema names are extracted from the handler slice between this guard and the
 * next one: `<Name>.parse(` on the body (request) and `this.service(res, "...",
 * ..., <Name>)` (response). Handlers that hand-build JSON have null schema
 * refs — honest absence, never a guessed shape.
 */
// Non-GET routes that are READ-ONLY by contract (dry checks): the method is
// POST for body transport, not for mutation. Keep in lockstep with the
// handler docs — a new dry-check route must be added here or agents will see
// a false mutating flag.
const READ_ONLY_NON_GET = new Set([
  "POST /runs/:id/apply/check",
  "POST /v2/harnesses/:id/auth-readiness",
]);

// Responses produced through HELPERS the slice-scan cannot see into (e.g.
// `this.json(res, 200, detailFor(...))` where detailFor zod-parses the DTO).
// docs-truth self-checks every named schema exists in generated/, so a rename
// fails loudly instead of shipping a dangling ref.
const ROUTE_RESPONSE_OVERRIDES = new Map([["GET /runs/:id", "ControlRunDetail"]]);

export function endpointDetails(srcPath = "packages/control-api/src/daemon-server.ts") {
  const src = readFileSync(srcPath, "utf8");
  const sites = routeSites(src).sort((a, b) => a.index - b.index);
  const details = sites.map((site, i) => {
    // The handler slice is bounded by the NEXT route guard (or a hard cap for
    // the last route) — no formatting-sensitive sentinels.
    const sliceEnd =
      i + 1 < sites.length ? sites[i + 1].index : Math.min(site.index + 4000, src.length);
    const body = src.slice(site.index, sliceEnd);
    // Request schema: any PascalCase *Request DTO parsed in the handler; the
    // `body = X.parse(` form is preferred when both appear.
    const requestMatch =
      /body = ([A-Z]\w+)\.parse\(/.exec(body) ?? /\b([A-Z]\w*Request)\.parse\(/.exec(body);
    // Response schema, two validated forms (both zod-parse the wire value):
    //  - the service() helper's schema argument (last arg, tolerant of commas
    //    inside the input argument);
    //  - direct `this.json(res, <code>, Schema.parse(...))` responses.
    // Schema DTOs are PascalCase exports; a lowercase arg (err, body, ...) is
    // not a schema reference. Hand-built JSON stays null — honest absence.
    const serviceMatch =
      /this\.service\(\s*res,\s*"\w+",[\s\S]*?,\s*([A-Z]\w+)\s*,?\s*\);/.exec(body) ??
      /this\.json\(res, \w+, (?:await )?([A-Z]\w+)\.parse\(/.exec(body);
    const key = `${site.method} ${site.path}`;
    return {
      method: site.method,
      path: site.path,
      mutating: site.method !== "GET" && !READ_ONLY_NON_GET.has(key),
      requestSchema: requestMatch ? requestMatch[1] : null,
      responseSchema: ROUTE_RESPONSE_OVERRIDES.get(key) ?? (serviceMatch ? serviceMatch[1] : null),
    };
  });
  details.push({
    method: "GET",
    path: "/healthz",
    mutating: false,
    requestSchema: null,
    responseSchema: null,
  });
  const seen = new Set();
  return details
    .filter((d) => {
      const key = `${d.method} ${d.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) =>
      a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
    );
}

/** Deterministic machine artifact for external agents (docs/reference/endpoints.json). */
export function renderEndpointsJson(details) {
  return (
    JSON.stringify(
      {
        $comment:
          "Generated by scripts/gen-endpoints-doc.mjs — do not edit. Schema names reference packages/schema/generated/<Name>.schema.json. Loopback + bearer-token auth applies to every route except GET /healthz.",
        endpoints: details.map((d) => ({
          method: d.method,
          path: d.path,
          mutating: d.mutating,
          request_schema: d.requestSchema,
          response_schema: d.responseSchema,
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
