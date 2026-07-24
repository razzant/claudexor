#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";

// Generic hygiene (SHA-pinned action refs, no GitHub-expression injection into
// shell) is enforced across EVERY workflow, not just ci.yml/release.yml (audit
// A-7: pages.yml and the repo-metrics writer must be pinned too). The
// release-specific semantic assertions below still read release.yml directly.
const workflowDir = ".github/workflows";
const files = readdirSync(workflowDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort()
  .map((name) => `${workflowDir}/${name}`);
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
const prepareJob = jobBody(release, "prepare");
const publishNpmJob = jobBody(release, "publish-npm");
const publishReleaseJob = jobBody(release, "publish-release");
for (const [label, pattern] of [
  ["workflow has candidate mode", /candidate/],
  ["workflow has publish mode", /publish/],
  ["review attestation is verified", /verify-release-input\.mjs/],
  [
    // validateReleaseAttestation rejects any non-v3 attestation, so the
    // workflow_dispatch input must document the schema owners actually sign.
    "attestation input is documented as a schema-v3 owner-review attestation",
    /review_attestation_b64:\s*\n\s*description:[^\n]*schema-v3 owner-review attestation/,
  ],
  ["npm provenance is mandatory", /--provenance/],
  ["artifact provenance is emitted", /actions\/attest-build-provenance@[0-9a-f]{40}/],
  ["signing is fail-closed", /Signing and notarization secrets are required/],
  ["release assets use collision checks", /Release asset collision/],
  ["Darwin npm tarball is smoke-tested", /verify-npm-darwin-package\.mjs --tarball/],
  [
    "SBOM inventories the packaged app",
    /generate-release-sbom\.mjs\s+\\\s*\n\s*--app-bundle apps\/macos\/dist\/Claudexor\.app/,
  ],
  ["engine runtime update closure is built (M7)", /build-runtime-closure\.mjs/],
  [
    "runtime closure is built from the signed app bundle",
    /build-runtime-closure\.mjs\s+\\\s*\n\s*--app-bundle apps\/macos\/dist\/Claudexor\.app/,
  ],
  [
    "runtime manifest digest is self-verified before upload",
    /runtime manifest sha256 does not match the tarball/,
  ],
  [
    "runtime closure tarball ships as a release asset",
    /cp "\$RUNNER_TEMP\/runtime-closure\/claudexor-runtime-\$VERSION\.tar\.gz" "\$assets\/"/,
  ],
  [
    "candidate runtime manifest ships as a release asset",
    /cp "\$RUNNER_TEMP\/runtime-closure\/runtime-manifest\.json" "\$assets\/"/,
  ],
  [
    // D-2: publish must verify the owner-signed manifest fail-closed before it
    // ships (pinned-authority signature + promoted-artifact byte-identity).
    "publish verifies the owner-signed runtime manifest",
    /verify-signed-runtime-manifest\.mjs/,
  ],
  [
    "signed runtime manifest input is documented for publish",
    /runtime_manifest_b64:\s*\n\s*description:[^\n]*owner-signed runtime-update manifest/,
  ],
  [
    // A-5: publish must PROMOTE the exact candidate artifact bytes, not rebuild.
    "candidate run id input is documented for publish promotion",
    /candidate_run_id:\s*\n\s*description:[^\n]*promotes/,
  ],
  [
    "publish downloads the promoted candidate artifact by run id",
    /download-artifact@[0-9a-f]{40}[\s\S]*?run-id:\s*\$\{\{\s*needs\.prepare\.outputs\.candidate_run_id\s*\}\}/,
  ],
  [
    "publish verifies the promoted candidate closure provenance",
    /gh attestation verify "candidate-assets\/claudexor-runtime-\$VERSION\.tar\.gz"/,
  ],
  [
    "publish promotes the candidate closure bytes rather than rebuilding",
    /cp "\$cand" "\$tarball"/,
  ],
]) {
  if (!pattern.test(release)) errors.push(`release.yml: ${label}`);
}
if (!/^\s+ref:\s*\$\{\{\s*github\.sha\s*\}\}\s*$/m.test(prepareJob)) {
  errors.push(
    "release.yml: prepare checkout must use the immutable workflow-dispatch github.sha (never hardcoded main)",
  );
}
if (!/^\s{4}runs-on:\s*macos-26\s*$/m.test(publishNpmJob)) {
  errors.push("release.yml: npm publication must run on macos-26");
}
const beforeAssets = publishReleaseJob.indexOf("--phase before");
const uploadAssets = publishReleaseJob.indexOf('gh release upload "$TAG" "$file"');
const afterAssets = publishReleaseJob.indexOf("--phase after");
const publishDraft = publishReleaseJob.indexOf('gh release edit "$TAG" --draft=false --latest');
if (!(beforeAssets >= 0 && beforeAssets < uploadAssets)) {
  errors.push("release.yml: remote asset subset must be verified before upload");
}
if (!(uploadAssets >= 0 && uploadAssets < afterAssets && afterAssets < publishDraft)) {
  errors.push(
    "release.yml: exact remote asset set must be verified after upload and before publish",
  );
}
if (/gh\s+release\s+delete-asset/.test(publishReleaseJob)) {
  errors.push("release.yml: retry flow must never delete unexpected remote assets");
}

const coreManifest = JSON.parse(readFileSync("packages/core/package.json", "utf8"));
if (
  coreManifest.bin?.["claudexor-process-identity"] !== "./dist/native/claudexor-process-identity"
) {
  errors.push("packages/core/package.json: Darwin helper must be an executable npm bin entry");
}
if (!String(coreManifest.scripts?.prepack ?? "").includes("verify-npm-darwin-package.mjs")) {
  errors.push("packages/core/package.json: Darwin helper prepack verification is missing");
}
const npmPublisher = readFileSync("scripts/publish-npm-release.mjs", "utf8");
const verifyDarwinPackage = npmPublisher.indexOf("verify-npm-darwin-package.mjs");
const publishTarball = npmPublisher.indexOf('"publish"');
if (verifyDarwinPackage < 0 || publishTarball < 0 || verifyDarwinPackage > publishTarball) {
  errors.push("publish-npm-release.mjs: Darwin package verification must precede npm publish");
}
for (const [label, pattern] of [
  ["published provenance is bound to source identity", /validatePublishedProvenance/],
  ["published latest dist-tag is verified", /dist-tags.*latest/s],
  ["published package signatures are audited", /audit[",\s]+signatures/],
]) {
  if (!pattern.test(npmPublisher)) errors.push(`publish-npm-release.mjs: ${label}`);
}

const verifier = readFileSync("scripts/verify-release-input.mjs", "utf8");
if (!/validateReleaseAttestation\(attestation, reviewAuthority/.test(verifier)) {
  errors.push("verify-release-input.mjs: signed review authority is not checked before publish");
}
if (!/GITHUB_REF[\s\S]*refs\/tags\/\$\{tag\}/.test(verifier)) {
  errors.push(
    "verify-release-input.mjs: publish mode must require workflow dispatch from the exact tag ref",
  );
}
const authority = JSON.parse(readFileSync("release/review-attestation-authority.json", "utf8"));
if (
  authority.algorithm !== "Ed25519" ||
  !/^claudexor-v2\.0\.0-review-ed25519-[0-9a-f]{16}$/.test(authority.keyId ?? "") ||
  !String(authority.publicKeyPem ?? "").includes("BEGIN PUBLIC KEY")
) {
  errors.push("release/review-attestation-authority.json: invalid pinned Ed25519 authority");
}
// D-2: the runtime-update authority is a SEPARATE pinned Ed25519 key (never the
// review key) with the runtime-update keyId shape.
const runtimeAuthority = JSON.parse(readFileSync("release/runtime-update-authority.json", "utf8"));
if (
  runtimeAuthority.algorithm !== "Ed25519" ||
  !/^claudexor-runtime-update-[0-9a-z.-]+-ed25519-[0-9a-f]{16}$/.test(
    runtimeAuthority.keyId ?? "",
  ) ||
  !String(runtimeAuthority.publicKeyPem ?? "").includes("BEGIN PUBLIC KEY")
) {
  errors.push("release/runtime-update-authority.json: invalid pinned Ed25519 authority");
}
if (
  runtimeAuthority.keyId === authority.keyId ||
  runtimeAuthority.publicKeyPem === authority.publicKeyPem
) {
  errors.push(
    "release/runtime-update-authority.json: must be a SEPARATE key from the review authority",
  );
}
for (const [label, pattern] of [
  ["--clobber is forbidden", /--clobber/],
  ["unsigned release fallback is forbidden", /continue-on-error:\s*true/],
  ["runtime package downloads are forbidden", /\bnpx\b|@latest/],
  ["tag-push publication is forbidden", /^\s*push:\s*\n\s*tags:/m],
  // The attestation is schema v3; the stale v2 wording must never return.
  ["stale schema-v2 attestation wording is forbidden", /schema-v2/],
]) {
  if (pattern.test(release)) errors.push(`release.yml: ${label}`);
}

const directInputs = [...release.matchAll(/\$\{\{\s*inputs\.[^}]+\}\}/g)].map((match) => match[0]);
if (directInputs.length !== 5) {
  errors.push(
    `release.yml: expected exactly five input projections into workflow env, got ${directInputs.length}`,
  );
}
if (errors.length) {
  for (const error of errors) console.error(`release workflow check failed: ${error}`);
  process.exit(1);
}
console.log("release workflow check OK");

function jobBody(workflow, name) {
  const start = workflow.indexOf(`  ${name}:\n`);
  if (start < 0) {
    errors.push(`release.yml: missing ${name} job`);
    return "";
  }
  const next = workflow.slice(start + 2).search(/^  [a-z0-9-]+:\n/m);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 2 + next);
}
