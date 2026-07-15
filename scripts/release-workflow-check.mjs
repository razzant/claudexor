#!/usr/bin/env node
import { readFileSync } from "node:fs";

const files = [".github/workflows/ci.yml", ".github/workflows/release.yml"];
const errors = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gm)) {
    const action = match[1];
    if (!/@[0-9a-f]{40}$/.test(action))
      errors.push(`${file}: action is not pinned to a full SHA: ${action}`);
  }
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const run = /^(\s*)run:/.exec(lines[index]);
    if (!run) continue;
    if (lines[index].includes("${{")) {
      errors.push(`${file}: GitHub expression is interpolated directly into a shell run line`);
    }
    if (!/run:\s*[>|]\s*$/.test(lines[index])) continue;
    const indent = run[1].length;
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() && line.length - line.trimStart().length <= indent) {
        index -= 1;
        break;
      }
      if (line.includes("${{")) {
        errors.push(`${file}: GitHub expression is interpolated directly into a shell run block`);
      }
    }
  }
}

const release = readFileSync(".github/workflows/release.yml", "utf8");
for (const [label, pattern] of [
  ["workflow has candidate mode", /candidate/],
  ["workflow has publish mode", /publish/],
  ["review attestation is verified", /verify-release-input\.mjs/],
  ["npm provenance is mandatory", /--provenance/],
  ["artifact provenance is emitted", /actions\/attest-build-provenance@[0-9a-f]{40}/],
  ["signing is fail-closed", /Signing and notarization secrets are required/],
  ["release assets use collision checks", /Release asset collision/],
]) {
  if (!pattern.test(release)) errors.push(`release.yml: ${label}`);
}
for (const [label, pattern] of [
  ["--clobber is forbidden", /--clobber/],
  ["unsigned release fallback is forbidden", /continue-on-error:\s*true/],
  ["runtime package downloads are forbidden", /\bnpx\b|@latest/],
  ["tag-push publication is forbidden", /^\s*push:\s*\n\s*tags:/m],
]) {
  if (pattern.test(release)) errors.push(`release.yml: ${label}`);
}

const directInputs = [...release.matchAll(/\$\{\{\s*inputs\.[^}]+\}\}/g)].map((match) => match[0]);
if (directInputs.length !== 3) {
  errors.push(
    `release.yml: expected exactly three input projections into workflow env, got ${directInputs.length}`,
  );
}
if (errors.length) {
  for (const error of errors) console.error(`release workflow check failed: ${error}`);
  process.exit(1);
}
console.log("release workflow check OK");
