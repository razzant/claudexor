#!/usr/bin/env node
/**
 * Regenerates the canonical control-API endpoint inventory inside
 * docs/ARCHITECTURE.md between the GENERATED ENDPOINTS markers. README and
 * INTEGRATIONS link here instead of maintaining hand-copies (they used to be
 * three drifting duplicates). The docs-truth gate fails when this block is
 * stale, exactly like the schema:gen diff gate.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  GEN_BEGIN,
  GEN_END,
  endpointDetails,
  implementedEndpoints,
  renderEndpointBlock,
  renderEndpointsJson,
} from "./endpoints-lib.mjs";

const DOC = "docs/ARCHITECTURE.md";
const JSON_ARTIFACT = "docs/reference/endpoints.json";

const text = readFileSync(DOC, "utf8");
const begin = text.indexOf(GEN_BEGIN);
const end = text.indexOf(GEN_END);
if (begin === -1 || end === -1) {
  console.error(`gen-endpoints-doc: markers not found in ${DOC}; add ${GEN_BEGIN} … ${GEN_END}`);
  process.exit(1);
}
const block = renderEndpointBlock(implementedEndpoints());
const next = text.slice(0, begin) + block + text.slice(end + GEN_END.length);
if (next !== text) {
  writeFileSync(DOC, next);
  console.log(`gen-endpoints-doc: regenerated the endpoint inventory in ${DOC}`);
} else {
  console.log("gen-endpoints-doc: inventory already current");
}

// The machine-readable endpoint map for external agents (schema refs included),
// derived from the code-first route descriptors in the built operation catalog.
const json = renderEndpointsJson(await endpointDetails());
let current = null;
try {
  current = readFileSync(JSON_ARTIFACT, "utf8");
} catch {
  /* first generation */
}
if (current !== json) {
  mkdirSync(dirname(JSON_ARTIFACT), { recursive: true });
  writeFileSync(JSON_ARTIFACT, json);
  console.log(`gen-endpoints-doc: regenerated ${JSON_ARTIFACT}`);
} else {
  console.log("gen-endpoints-doc: endpoints.json already current");
}
