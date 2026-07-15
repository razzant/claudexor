#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  validateReleaseAttestation,
  validateReleaseInput,
} from "./lib/release-review-contract.mjs";

const reviewAuthority = JSON.parse(
  readFileSync(new URL("../release/review-attestation-authority.json", import.meta.url), "utf8"),
);

const mode = process.env.RELEASE_MODE_INPUT ?? "";
const ref = process.env.RELEASE_REF_INPUT ?? "";
const input = validateReleaseInput(mode, ref);
if (!input.ok) fail(input.reasons);

if (process.argv.includes("--syntax-only")) process.exit(0);

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
let candidateSha;
let tag = "";
if (mode === "candidate") {
  candidateSha = git("rev-parse", `${ref}^{commit}`);
  if (candidateSha !== ref)
    fail(["candidate ref did not resolve to the exact requested commit SHA"]);
  if (candidateSha !== (process.env.GITHUB_SHA ?? "")) {
    fail(["candidate SHA does not match the workflow-dispatch GITHUB_SHA"]);
  }
} else {
  tag = ref;
  if (git("cat-file", "-t", `refs/tags/${tag}`) !== "tag") {
    fail(["publish ref must be an annotated tag"]);
  }
  candidateSha = git("rev-parse", `${tag}^{commit}`);
  const main = git("rev-parse", "origin/main^{commit}");
  if (candidateSha !== main) fail(["publish tag does not point to the exact origin/main commit"]);
}

const candidateTree = git("rev-parse", `${candidateSha}^{tree}`);
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const version = manifest.version;
if (mode === "publish" && tag !== `v${version}`)
  fail(["publish tag does not match package.json version"]);

let attestationText = "";
if (mode === "publish") {
  const encoded = process.env.REVIEW_ATTESTATION_B64_INPUT ?? "";
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    fail(["publish mode requires a base64-encoded review attestation"]);
  }
  try {
    attestationText = Buffer.from(encoded, "base64").toString("utf8");
    const attestation = JSON.parse(attestationText);
    const reviewed = validateReleaseAttestation(attestation, reviewAuthority, {
      candidateSha,
      candidateTree,
    });
    if (!reviewed.ok) fail(reviewed.reasons);
  } catch (error) {
    fail([
      `review attestation is invalid: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (process.env.REVIEW_ATTESTATION_PATH) {
    writeFileSync(process.env.REVIEW_ATTESTATION_PATH, `${attestationText.trim()}\n`, {
      mode: 0o600,
    });
  }
}

if (process.env.GITHUB_OUTPUT) {
  writeFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `mode=${mode}`,
      `sha=${candidateSha}`,
      `tree=${candidateTree}`,
      `tag=${tag}`,
      `version=${version}`,
      "",
    ].join("\n"),
    { flag: "a" },
  );
}
console.log(`release input OK: ${mode} ${candidateSha}`);

function fail(reasons) {
  for (const reason of reasons) console.error(`release input rejected: ${reason}`);
  process.exit(1);
}
