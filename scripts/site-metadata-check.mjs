#!/usr/bin/env node
import { readFileSync } from "node:fs";

const productionUrl = "https://claudexor.ai/";
const legacyUrl = "https://razzant.github.io/claudexor";
const socialImageUrl = `${productionUrl}assets/social-preview-v2.png`;
const ouroborosRepositoryUrl = "https://github.com/razzant/ouroboros";
const ouroborosSiteUrl = "https://ouroboros-agent.ai/";
const ouroborosRuntimePinUrl = `${ouroborosRepositoryUrl}/blob/ouroboros/ouroboros/claudexor_runtime_pin.json`;
const failures = [];

const index = readFileSync("site/index.html", "utf8");
const sitemap = readFileSync("site/sitemap.xml", "utf8");
const robots = readFileSync("site/robots.txt", "utf8");
const llms = readFileSync("site/llms.txt", "utf8");
const readme = readFileSync("README.md", "utf8");
const integrations = readFileSync("docs/INTEGRATIONS.md", "utf8");
const pagesWorkflow = readFileSync(".github/workflows/pages.yml", "utf8");

function requireMatch(text, pattern, message) {
  if (!pattern.test(text)) failures.push(message);
}

function requireText(text, value, message) {
  if (!text.includes(value)) failures.push(message);
}

for (const [name, text] of [
  ["site/index.html", index],
  ["site/sitemap.xml", sitemap],
]) {
  if (text.includes(legacyUrl)) failures.push(`${name}: legacy GitHub Pages URL remains`);
}

requireMatch(
  index,
  /<link rel="canonical" href="https:\/\/claudexor\.ai\/"\s*\/?>/,
  "site/index.html: canonical URL must be the production HTTPS origin",
);
requireMatch(
  index,
  /<meta property="og:url" content="https:\/\/claudexor\.ai\/"\s*\/?>/,
  "site/index.html: og:url must be the production HTTPS origin",
);
requireMatch(
  index,
  new RegExp(`<meta\\s+property="og:image"\\s+content="${socialImageUrl.replaceAll(".", "\\.")}"`),
  "site/index.html: og:image must use the production HTTPS origin",
);
requireMatch(
  index,
  new RegExp(`<meta\\s+name="twitter:image"\\s+content="${socialImageUrl.replaceAll(".", "\\.")}"`),
  "site/index.html: twitter:image must use the production HTTPS origin",
);
requireMatch(
  sitemap,
  /<loc>https:\/\/claudexor\.ai\/<\/loc>/,
  "site/sitemap.xml: root URL must use the production HTTPS origin",
);
requireMatch(
  robots,
  /^Sitemap: https:\/\/claudexor\.ai\/sitemap\.xml$/m,
  "site/robots.txt: production sitemap declaration is missing",
);
requireMatch(
  readme,
  /\[Website\]\(https:\/\/claudexor\.ai\/\)/,
  "README.md: production website link is missing",
);
requireMatch(
  pagesWorkflow,
  /run: node scripts\/site-metadata-check\.mjs/,
  ".github/workflows/pages.yml: metadata verification step is missing",
);
requireMatch(
  index,
  /<div class="plane" id="ouroboros">/,
  "site/index.html: Ouroboros production-use section is missing",
);

for (const [name, text] of [
  ["README.md", readme],
  ["site/index.html", index],
  ["site/llms.txt", llms],
]) {
  requireText(text, ouroborosRepositoryUrl, `${name}: Ouroboros repository link is missing`);
  requireText(text, ouroborosSiteUrl, `${name}: Ouroboros website link is missing`);
}

requireText(
  integrations,
  ouroborosRuntimePinUrl,
  "docs/INTEGRATIONS.md: Ouroboros runtime pin example is missing",
);

const jsonLdMatch = index.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/);
if (!jsonLdMatch) {
  failures.push("site/index.html: SoftwareApplication JSON-LD is missing");
} else {
  try {
    const schema = JSON.parse(jsonLdMatch[1]);
    if (schema["@context"] !== "https://schema.org") {
      failures.push("site/index.html: JSON-LD must use the schema.org context");
    }
    if (schema["@type"] !== "SoftwareApplication") {
      failures.push("site/index.html: JSON-LD must describe a SoftwareApplication");
    }
    if (schema.name !== "Claudexor" || schema.url !== productionUrl) {
      failures.push("site/index.html: JSON-LD name or production URL is incorrect");
    }
    if (schema.offers?.price !== 0) {
      failures.push("site/index.html: JSON-LD must describe Claudexor as free software");
    }
    if (schema.image !== socialImageUrl) {
      failures.push("site/index.html: JSON-LD image must use the production HTTPS origin");
    }
  } catch (error) {
    failures.push(`site/index.html: JSON-LD is invalid JSON (${error.message})`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Site metadata is consistent with ${productionUrl}`);
