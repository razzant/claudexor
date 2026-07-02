/**
 * Shared endpoint extraction for the docs-truth gate and the generated
 * endpoint inventory (single producer — INV-122). Parses the literal and
 * regex route guards in daemon-server.ts; the extractor self-checks that
 * every declared regex route is bound to a method guard so refactors cannot
 * silently shrink the implemented set.
 */
import { readFileSync } from "node:fs";

export function implementedEndpoints(srcPath = "packages/control-api/src/daemon-server.ts") {
  const src = readFileSync(srcPath, "utf8");
  const out = new Set();
  const litRe = /method === "(GET|POST|DELETE|PUT|PATCH)"\s*&&\s*path === "([^"]+)"/g;
  for (let m = litRe.exec(src); m; m = litRe.exec(src)) out.add(`${m[1]} ${m[2]}`);
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
    out.add(`${m[1]} ${template}`);
  }
  for (const [name] of regexByName) {
    if (!src.includes(`&& ${name}`)) {
      throw new Error(`endpoint extractor: regex route '${name}' is declared but never used with a method guard`);
    }
  }
  out.add("GET /healthz"); // declared before auth with hostIsLoopback guard
  return out;
}

export const GEN_BEGIN = "<!-- BEGIN GENERATED ENDPOINTS (node scripts/gen-endpoints-doc.mjs; do not edit by hand) -->";
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
