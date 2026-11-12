#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { jobSection, stepBody } from "./lib/workflow-sections.mjs";

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

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const release = readFileSync(".github/workflows/release.yml", "utf8");
const win32ConptyBuild = readFileSync(
  "packages/core/scripts/build-win32-conpty-helper.mjs",
  "utf8",
);
const publishMcp = readFileSync(".github/workflows/publish-mcp.yml", "utf8");
const prepareJob = jobBody(release, "prepare");
const packageMacosJob = jobBody(release, "package-macos");
const releaseGates = stepBody(packageMacosJob, "Deterministic release gates");
const freshnessStepName = "Check vendor program freshness";
const freshnessStep = stepBody(packageMacosJob, freshnessStepName);
errors.push(...programFreshnessFindings(release));
for (const [label, mutated] of [
  ["a dropped freshness step", release.replace(freshnessStep, "")],
  [
    "a no-op freshness step",
    release.replace("run: node scripts/harness-program-freshness.mjs", "run: true"),
  ],
  [
    "a candidate-only freshness step",
    release.replace(
      freshnessStep,
      freshnessStep.replace(
        "        env:\n",
        "        if: needs.prepare.outputs.mode == 'candidate'\n        env:\n",
      ),
    ),
  ],
  [
    "a missing source token",
    release.replace(
      freshnessStep,
      freshnessStep.replace("          GITHUB_TOKEN: ${{ github.token }}\n", ""),
    ),
  ],
  [
    "a token under another name in the gates",
    release.replace(
      releaseGates,
      releaseGates.replace(
        "        env:\n",
        "        env:\n          SOURCE_TOKEN: ${{ github.token }}\n",
      ),
    ),
  ],
  [
    "a freshness step before the gates",
    release
      .replace(freshnessStep, "")
      .replace(
        "      - name: Deterministic release gates\n",
        `${freshnessStep}      - name: Deterministic release gates\n`,
      ),
  ],
]) {
  if (mutated === release || programFreshnessFindings(mutated).length === 0)
    errors.push(`release-workflow-check self-test: failed to reject ${label}`);
}
const publishNpmJob = jobBody(release, "publish-npm");
const publishReleaseJob = jobBody(release, "publish-release");
errors.push(...windowsPrLegFindings(ci));
errors.push(...windowsConptyCustodyFindings(release));
errors.push(...windowsConptyBuildFindings(win32ConptyBuild));
const engineResourcesStep = stepBody(
  packageMacosJob,
  "Build shared engine resources before app packaging",
);
const appBuilder = readFileSync("apps/macos/scripts/build-app.sh", "utf8");
const resourceBuilder = readFileSync("scripts/build-engine-resources.sh", "utf8");
if (
  !engineResourcesStep.includes("bash scripts/build-engine-resources.sh") ||
  !engineResourcesStep.includes("CLAUDEXOR_ENGINE_RESOURCES=") ||
  packageMacosJob.indexOf("Build shared engine resources") >
    packageMacosJob.indexOf("Build signed DMG and ZIP") ||
  !appBuilder.includes('ditto "$ENGINE_RESOURCES" "$APP/Contents/Resources"') ||
  appBuilder.includes("pnpm exec esbuild") ||
  !resourceBuilder.includes(
    'codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$helper"',
  ) ||
  !packageMacosJob.includes('diff -r "$CLAUDEXOR_ENGINE_RESOURCES/$entry"')
) {
  errors.push(
    "engine resources must build/sign once before app packaging and be compared before closure publication",
  );
}
const macosPr = jobBody(ci, "swift");
if (
  !macosPr.includes("bash scripts/build-engine-resources.sh") ||
  !macosPr.includes("process-identity.test.ts") ||
  !ci.includes('if [ "$MACOS_RESULT" != "success" ]')
) {
  errors.push(
    "ci.yml: required macOS CI must build/probe the independent engine stage and test native identity",
  );
}
const localSealCall = 'bash "$HERE/sign-local-app.sh" "$APP"';
const localSealIndex = appBuilder.indexOf(localSealCall);
const signedBranchIndex = appBuilder.indexOf('if [ -n "${SIGN_IDENTITY:-}" ]; then');
const localBranchIndex = appBuilder.indexOf("\nelse\n", signedBranchIndex);
const localBranchEnd = appBuilder.indexOf("\nfi\n", localBranchIndex);
const lastBundleWrites = [
  'ditto "$ENGINE_RESOURCES" "$APP/Contents/Resources"',
  'node "$REPO_ROOT/scripts/build-dev-remote-runtime-bundle.mjs"',
  '"$DEV_REMOTE_DIR/remote-runtime-manifest.json"',
];
if (
  localSealIndex < 0 ||
  appBuilder.indexOf(localSealCall, localSealIndex + 1) >= 0 ||
  signedBranchIndex < 0 ||
  localBranchIndex < 0 ||
  localSealIndex < localBranchIndex ||
  localSealIndex > localBranchEnd ||
  lastBundleWrites.some((needle) => {
    const index = appBuilder.lastIndexOf(needle);
    return index < 0 || index > localSealIndex;
  }) ||
  localSealIndex > appBuilder.indexOf('if [ "${MAKE_ZIP:-1}" = "1" ]; then') ||
  !macosPr.includes("build-app-local-signing.test.mjs")
) {
  errors.push(
    "build-app.sh must seal local bundles once, in the non-SIGN_IDENTITY branch after the last bundle write and before ZIP/DMG, and macOS CI must run build-app-local-signing.test.mjs",
  );
}
const exactPromotionPairedNeedles = [
  [
    "SBOM license-input prepared-SHA binding",
    'GITHUB_SHA="$PREPARED_SHA" pnpm licenses list --prod --json',
  ],
  [
    "SBOM generator prepared-SHA binding",
    'GITHUB_SHA="$PREPARED_SHA" node scripts/generate-release-sbom.mjs',
  ],
  ["daemon version probe comparison", "probe.version !== process.argv[2]"],
  ["daemon build-SHA probe comparison", "probe.buildSha !== process.argv[3]"],
  [
    "remote SBOM generator prepared-SHA binding",
    'GITHUB_SHA="$PREPARED_SHA" node scripts/generate-remote-runtime-sbom.mjs',
  ],
];
for (const [label, pattern] of [
  ["workflow has candidate mode", /candidate/],
  ["workflow has publish mode", /publish/],
  ["release input is verified", /verify-release-input\.mjs/],
  [
    "independent review reference is exposed",
    /review_url:\s*\n\s*description:[^\n]*independent review/,
  ],
  [
    "responsible maintainer confirms review",
    /review_confirmed:\s*\n\s*description:[^\n]*responsible/,
  ],
  ["npm provenance is mandatory", /--provenance/],
  [
    "installed npm daemon wrapper serves the scoped delegation belt",
    /smoke-delegation-belt-entry\.mjs[\s\S]*?node_modules\/\.bin\/claudexord/,
  ],
  ["artifact provenance is emitted", /actions\/attest-build-provenance@[0-9a-f]{40}/],
  ["signing is fail-closed", /Signing and notarization secrets are required/],
  ["release assets use collision checks", /Release asset collision/],
  ["Darwin npm tarball is smoke-tested", /verify-npm-darwin-package\.mjs --tarball/],
  [
    "SBOM inventories the packaged app",
    /generate-release-sbom\.mjs\s+\\\s*\n\s*--app-bundle apps\/macos\/dist\/bundle\.noindex\/Claudexor\.app/,
  ],
  ["engine runtime update closure is built (M7)", /build-runtime-closure\.mjs/],
  [
    "runtime closure is built from the common engine-resource stage",
    /build-runtime-closure\.mjs\s+\\\s*\n\s*--resources "\$CLAUDEXOR_ENGINE_RESOURCES"/,
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
    // The remote SSH runtime manifest is the THIRD owner-signed publish input,
    // transported exactly like the engine runtime manifest.
    "signed remote runtime manifest input is documented for publish",
    /remote_runtime_manifest_b64:\s*\n\s*description:[^\n]*owner-signed four-target SSH runtime manifest/,
  ],
  [
    "publish verifies the owner-signed remote runtime manifest",
    /verify-signed-remote-runtime-manifest\.mjs/,
  ],
  [
    "remote runtime archives ship as release assets",
    /cp "\$RUNNER_TEMP\/remote-runtimes"\/claudexor-remote-runtime-"\$VERSION"-\*\.tar\.gz "\$assets\/"/,
  ],
  [
    "remote runtime archives are structurally verified before assembly",
    /for archive in "\$remote"\/claudexor-remote-runtime-"\$VERSION"-\*\.tar\.gz; do\n\s*node scripts\/verify-remote-runtime-archive\.mjs "\$archive"/,
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
    "publish verifies every promoted candidate asset provenance",
    /for file in candidate-assets\/\*; do[\s\S]*?gh attestation verify "\$file"/,
  ],
  [
    "publish promotes the candidate closure bytes rather than rebuilding",
    /cp "\$cand" "\$tarball"/,
  ],
]) {
  if (!pattern.test(release)) errors.push(`release.yml: ${label}`);
}
errors.push(...exactCandidateAppPromotionErrors(packageMacosJob));
const exactPromotionMutationCases = [
  [
    "candidate-only signing guard",
    packageMacosJob.replace(
      "- name: Require and import Apple release credentials\n        if: needs.prepare.outputs.mode == 'candidate'",
      "- name: Require and import Apple release credentials\n        if: always()",
    ),
  ],
  [
    "unconditional release Node pin",
    packageMacosJob.replace(
      "- name: Pin release Node runtime\n        shell: bash",
      "- name: Pin release Node runtime\n        if: needs.prepare.outputs.mode == 'candidate'\n        shell: bash",
    ),
  ],
  [
    "candidate-only build guard",
    packageMacosJob.replace(
      "- name: Build signed DMG and ZIP\n        if: needs.prepare.outputs.mode == 'candidate'",
      "- name: Build signed DMG and ZIP\n        if: always()",
    ),
  ],
  [
    "candidate-only fresh verification guard",
    packageMacosJob.replace(
      "- name: Verify signed and notarized artifacts\n        if: needs.prepare.outputs.mode == 'candidate'",
      "- name: Verify signed and notarized artifacts\n        if: always()",
    ),
  ],
  [
    "candidate DMG source",
    packageMacosJob.replace(
      'cp "candidate-assets/Claudexor-$VERSION.dmg" "$assets/"',
      'cp "apps/macos/dist/Claudexor-$VERSION.dmg" "$assets/"',
    ),
  ],
  [
    "candidate ZIP source",
    packageMacosJob.replace(
      'cp "candidate-assets/Claudexor-$VERSION.zip" "$assets/"',
      'cp "apps/macos/dist/Claudexor-$VERSION.zip" "$assets/"',
    ),
  ],
  [
    "candidate SBOM source",
    packageMacosJob.replace(
      'cp "candidate-assets/Claudexor-$VERSION.spdx.json" "$assets/"',
      'cp "apps/macos/dist/Claudexor-$VERSION.spdx.json" "$assets/"',
    ),
  ],
  [
    "candidate SBOM license-input prepared-SHA binding",
    replaceLastOccurrence(
      packageMacosJob,
      'GITHUB_SHA="$PREPARED_SHA" pnpm licenses list --prod --json',
      "pnpm licenses list --prod --json",
    ),
    "candidate SBOM must bind both license input and document namespace to the prepared SHA",
  ],
  [
    "promoted SBOM license-input prepared-SHA binding",
    packageMacosJob.replace(
      'GITHUB_SHA="$PREPARED_SHA" pnpm licenses list --prod --json',
      "pnpm licenses list --prod --json",
    ),
    "candidate SBOM must be regenerated from the promoted app and compared",
  ],
  [
    "candidate SBOM generator prepared-SHA binding",
    replaceLastOccurrence(
      packageMacosJob,
      'GITHUB_SHA="$PREPARED_SHA" node scripts/generate-release-sbom.mjs',
      "node scripts/generate-release-sbom.mjs",
    ),
    "candidate SBOM must bind both license input and document namespace to the prepared SHA",
  ],
  [
    "promoted SBOM generator prepared-SHA binding",
    packageMacosJob.replace(
      'GITHUB_SHA="$PREPARED_SHA" node scripts/generate-release-sbom.mjs',
      "node scripts/generate-release-sbom.mjs",
    ),
    "candidate SBOM must be regenerated from the promoted app and compared",
  ],
  [
    "candidate run SHA binding",
    packageMacosJob.replace('test "$run_sha" = "$PREPARED_SHA"', 'test -n "$run_sha"'),
  ],
  [
    "candidate provenance source binding",
    `${packageMacosJob.replace('--source-digest "$PREPARED_SHA"', "--source-digest unknown")}\n# --source-digest "$PREPARED_SHA"`,
  ],
  [
    "provenance-before-checksum order",
    packageMacosJob.replace(
      "for file in candidate-assets/*; do",
      "(cd candidate-assets && shasum -a 256 -c SHA256SUMS)\n          for file in candidate-assets/*; do",
    ),
  ],
  [
    "candidate daemon version probe",
    packageMacosJob.replace("probe.version !== process.argv[2]", "false"),
    "candidate ZIP app must probe the exact daemon version and build SHA before upload",
  ],
  [
    "candidate daemon build-SHA probe",
    packageMacosJob.replace("probe.buildSha !== process.argv[3]", "false"),
    "candidate ZIP app must probe the exact daemon version and build SHA before upload",
  ],
  [
    "promoted daemon version probe",
    replaceLastOccurrence(packageMacosJob, "probe.version !== process.argv[2]", "false"),
    "candidate ZIP app must verify signature, version, and exact daemon build SHA",
  ],
  [
    "promoted daemon build-SHA probe",
    replaceLastOccurrence(packageMacosJob, "probe.buildSha !== process.argv[3]", "false"),
    "candidate ZIP app must verify signature, version, and exact daemon build SHA",
  ],
  [
    "isolated belt smoke HOME",
    packageMacosJob.replace(
      'HOME="$promoted_belt_home" node scripts/smoke-delegation-belt-entry.mjs',
      "node scripts/smoke-delegation-belt-entry.mjs",
    ),
  ],
  [
    "publish assembly step scoping",
    `${packageMacosJob.replace(
      'cp "candidate-assets/Claudexor-$VERSION.dmg" "$assets/"',
      'cp "apps/macos/dist/Claudexor-$VERSION.dmg" "$assets/"',
    )}\n# cp "candidate-assets/Claudexor-$VERSION.dmg" "$assets/"`,
  ],
  [
    "twelve-asset candidate allowlist",
    packageMacosJob.replace(
      "            `claudexor-remote-runtime-${version}-linux-x64.tar.gz`,\n",
      "",
    ),
    "exact twelve-asset release set",
  ],
  [
    "remote archive use before provenance",
    packageMacosJob.replace(
      'run_meta="$(gh api',
      'cp candidate-assets/claudexor-remote-runtime-premature.tar.gz "$RUNNER_TEMP/"\n          run_meta="$(gh api',
    ),
    "must come after the single early candidate provenance loop",
  ],
  [
    "late duplicate provenance verifier",
    `${packageMacosJob}\n          gh attestation verify "candidate-assets/late.tar.gz" --repo "$GITHUB_REPOSITORY"`,
    "ONLY provenance verifier",
  ],
  [
    "signed remote manifest promotion",
    packageMacosJob.replace(
      'cp "$remote_signed" "$assets/remote-runtime-manifest.json"',
      'cp "$RUNNER_TEMP/remote-runtimes/remote-runtime-manifest.json" "$assets/"',
    ),
    "unsigned-to-signed",
  ],
  [
    "remote SBOM byte comparison",
    packageMacosJob.replace(
      'cmp "candidate-assets/Claudexor-remote-runtime-$VERSION.spdx.json" \\',
      ": \\",
    ),
    "byte-compared candidate SBOM",
  ],
  [
    "thirteenth assembled asset",
    packageMacosJob.replace(
      '(cd "$assets" && shasum -a 256 * > SHA256SUMS)',
      'cp "$RUNNER_TEMP/debug-notes.txt" "$assets/"\n          (cd "$assets" && shasum -a 256 * > SHA256SUMS)',
    ),
    "assembled release-asset writes",
  ],
  [
    "publish remote SBOM prepared-SHA binding",
    packageMacosJob.replace(
      'GITHUB_SHA="$PREPARED_SHA" node scripts/generate-remote-runtime-sbom.mjs',
      "node scripts/generate-remote-runtime-sbom.mjs",
    ),
    "publish must regenerate the remote SBOM",
  ],
  [
    "candidate remote SBOM prepared-SHA binding",
    replaceLastOccurrence(
      packageMacosJob,
      'GITHUB_SHA="$PREPARED_SHA" node scripts/generate-remote-runtime-sbom.mjs',
      "node scripts/generate-remote-runtime-sbom.mjs",
    ),
    "candidate remote SBOM generation must bind the prepared SHA",
  ],
];
for (const [label, needle] of exactPromotionPairedNeedles) {
  exactPromotionMutationCases.push([
    `${label} occurrence cardinality`,
    `${packageMacosJob}\n# ${needle}`,
    `${label} must occur exactly twice`,
  ]);
}
for (const [label, broken, expectedFinding] of exactPromotionMutationCases) {
  const findings = exactCandidateAppPromotionErrors(broken);
  if (
    findings.length === 0 ||
    (expectedFinding !== undefined &&
      !findings.some((finding) => finding.includes(expectedFinding)))
  ) {
    errors.push(`release-workflow-check self-test: failed to reject ${label}`);
  }
}
if (!/^\s+ref:\s*\$\{\{\s*github\.sha\s*\}\}\s*$/m.test(prepareJob)) {
  errors.push(
    "release.yml: prepare checkout must use the immutable workflow-dispatch github.sha (never hardcoded main)",
  );
}
if (!/^\s{4}runs-on:\s*macos-26\s*$/m.test(publishNpmJob)) {
  errors.push("release.yml: npm publication must run on macos-26");
}
// The Linux SSH smoke is a publication gate: both publish jobs must depend on
// it and it must really exercise the promoted archive (not a no-op).
errors.push(...remoteSmokeGateFindings(release));
const delayedWindowsFixtureCi = ci
  .replace(
    "      - name: Build native ConPTY fixture\n        run: pnpm --filter @claudexor/core build:win32-fixtures\n\n",
    "",
  )
  .replace(
    "          packages/daemon/src/store/store.test.ts\n",
    "          packages/daemon/src/store/store.test.ts\n\n      - name: Build native ConPTY fixture\n        run: pnpm --filter @claudexor/core build:win32-fixtures\n",
  );
for (const [label, mutated] of [
  [
    "publish-npm without the SSH smoke gate",
    release.replace(
      "needs: [prepare, package-macos, remote-linux-ssh-smoke, windows-conpty-candidate-smoke]",
      "needs: [prepare, package-macos, windows-conpty-candidate-smoke]",
    ),
  ],
  [
    "publish-release without the SSH smoke gate",
    release.replace(
      "needs: [prepare, package-macos, remote-linux-ssh-smoke, publish-npm, npm-smoke]",
      "needs: [prepare, package-macos, publish-npm, npm-smoke]",
    ),
  ],
  [
    "no-op SSH smoke invocation",
    release.replace(
      /scripts\/smoke-remote-runtime-ssh\.sh \\\n\s*"release-assets\/claudexor-remote-runtime-\$VERSION-linux-x64\.tar\.gz"/,
      "true",
    ),
  ],
  ["deleted SSH smoke job", release.replace("  remote-linux-ssh-smoke:\n", "  renamed-job:\n")],
]) {
  if (mutated === release || remoteSmokeGateFindings(mutated).length === 0) {
    errors.push(`release-workflow-check self-test: failed to reject ${label}`);
  }
}
// The stop retry must live in the stop step itself: moving it into any
// neighboring step, named or not, leaves the step without it.
const assembledStopRetry = [
  "              if (-not $stop.retryable -or [DateTime]::UtcNow -ge $stopDeadline) {",
  '                throw "assembled daemon graceful stop failed (exit $stopExit): $($stopText.Trim())"',
  "              }",
  "              Start-Sleep -Milliseconds 500\n",
].join("\n");
const assembledStopWithoutRetry = release.replace(
  assembledStopRetry,
  '              throw "assembled daemon graceful stop failed (exit $stopExit): $($stopText.Trim())"\n',
);
const retryText = "$stop.retryable until $stopDeadline, Start-Sleep, then WaitForExit(15000)";
const withNeighborStep = (step) => {
  const mutated = assembledStopWithoutRetry.replace(
    "\n\n  remote-linux-ssh-smoke:\n",
    `\n${step}\n  remote-linux-ssh-smoke:\n`,
  );
  // A lost insertion point must not pass as a plain removal.
  return mutated === assembledStopWithoutRetry ? release : mutated;
};
const assembledStopRetryFinding =
  "assembled Windows stop must retry the retryable refusals of a just-started daemon";
for (const [label, mutated, expectedFinding] of [
  ["assembled stop without its retry", assembledStopWithoutRetry, assembledStopRetryFinding],
  [
    "assembled stop retry in a neighboring named step",
    withNeighborStep(
      `      - name: Describe the stop retry\n        shell: pwsh\n        run: |\n          # ${retryText}\n`,
    ),
    assembledStopRetryFinding,
  ],
  [
    "assembled stop retry in a neighboring unnamed run step",
    withNeighborStep(`      - run: |\n          # ${retryText}\n`),
    assembledStopRetryFinding,
  ],
  [
    "assembled stop retry in a neighboring uses step",
    withNeighborStep(
      `      - uses: actions/github-script@${"0".repeat(40)}\n        with:\n          script: console.log("${retryText}")\n`,
    ),
    assembledStopRetryFinding,
  ],
  [
    "renamed assembled stop step",
    release.replace(
      "      - name: Probe, handshake and gracefully stop the assembled daemon closure\n",
      "      - name: Probe and stop the assembled daemon\n",
    ),
    assembledStopRetryFinding,
  ],
  [
    "missing Windows authority job",
    release.replace("  windows-conpty-authority:\n", "  renamed-conpty-authority:\n"),
  ],
  [
    "authority moved off Windows 2022",
    release.replace(
      "  windows-conpty-authority:\n    name: Build or promote authoritative Windows ConPTY bytes\n    needs: prepare\n    runs-on: windows-2022",
      "  windows-conpty-authority:\n    name: Build or promote authoritative Windows ConPTY bytes\n    needs: prepare\n    runs-on: windows-latest",
    ),
  ],
  [
    "authority Node floor drift",
    release.replace(
      "          node-version: 24.15.0\n\n      - name: Initialize pinned x64 MSVC environment",
      "          node-version: 24.22.3\n\n      - name: Initialize pinned x64 MSVC environment",
    ),
  ],
  [
    "publish rebuilt Windows authority",
    release.replace(
      "          run-id: ${{ needs.prepare.outputs.candidate_run_id }}\n          github-token: ${{ github.token }}",
      "          github-token: ${{ github.token }}",
    ),
  ],
  [
    "macOS package bypassed Windows authority dependency",
    release.replace(
      "  package-macos:\n    name: Build signed, notarized and attested macOS artifacts\n    needs: [prepare, windows-conpty-authority]",
      "  package-macos:\n    name: Build signed, notarized and attested macOS artifacts\n    needs: prepare",
    ),
  ],
  [
    "assembled-byte smoke moved off Windows latest",
    release.replace(
      "  windows-conpty-candidate-smoke:\n    name: Execute assembled Windows ConPTY bytes (Node 24.22)\n    needs: [prepare, windows-conpty-authority, package-macos]\n    runs-on: windows-latest",
      "  windows-conpty-candidate-smoke:\n    name: Execute assembled Windows ConPTY bytes (Node 24.22)\n    needs: [prepare, windows-conpty-authority, package-macos]\n    runs-on: windows-2022",
    ),
  ],
  [
    "npm publish bypassed assembled-byte smoke",
    release.replace(
      "needs: [prepare, package-macos, remote-linux-ssh-smoke, windows-conpty-candidate-smoke]",
      "needs: [prepare, package-macos, remote-linux-ssh-smoke]",
    ),
  ],
  [
    "npm copied fresh authority rather than promoted closure bytes",
    release.replace(
      'cp "$promoted" packages/core/dist/native/claudexor-conpty-helper.exe',
      'cp "$authority" packages/core/dist/native/claudexor-conpty-helper.exe',
    ),
  ],
  [
    "npm rebuilt core after staging the promoted helper",
    release.replace(
      "      - name: Verify packed native helper custody",
      "      - run: pnpm --filter @claudexor/core build\n      - name: Verify packed native helper custody",
    ),
  ],
  [
    "POSIX-only URL disclosure suite re-added to assembled Windows smoke",
    release.replace(
      "          packages/cli/src/setup-login-runner-transport.test.ts\n",
      "          packages/cli/src/setup-login-runner-transport.test.ts\n          packages/cli/src/setup-login-url-disclosure.test.ts\n",
    ),
  ],
]) {
  const findings = mutated === release ? [] : windowsConptyCustodyFindings(mutated);
  if (
    findings.length === 0 ||
    (expectedFinding !== undefined &&
      !findings.some((finding) => finding.includes(expectedFinding)))
  ) {
    errors.push(`release-workflow-check self-test: failed to reject ${label}`);
  }
}
for (const [label, mutated] of [
  ["the common /MT static CRT freeze", win32ConptyBuild.replace('      "/MT",\n', "")],
  [
    "the post-link static CRT dependency assertion",
    win32ConptyBuild.replace(
      "  const dependencyError = verifyStaticCrtDependencies(temporary, buildEnvironment);\n",
      "  const dependencyError = null;\n",
    ),
  ],
]) {
  if (mutated === win32ConptyBuild || windowsConptyBuildFindings(mutated).length === 0) {
    errors.push(`release-workflow-check self-test: failed to reject removal of ${label}`);
  }
}
for (const [label, mutated] of [
  [
    "extra Windows PR matrix leg",
    ci.replace(
      "          - runner: windows-latest\n            node-version: 24.22.3",
      "          - runner: windows-latest\n            node-version: 24.22.3\n          - runner: windows-2022\n            node-version: 24.22.3",
    ),
  ],
  [
    "Windows 2022 Node compatibility floor drift",
    ci.replace(
      "          - runner: windows-2022\n            node-version: 24.15.0",
      "          - runner: windows-2022\n            node-version: 24.22.3",
    ),
  ],
  [
    "deleted native ConPTY PR test",
    ci.replace("          packages/core/src/win32-conpty-helper.test.ts\n", ""),
  ],
  [
    "deleted Windows agy print acceptance",
    ci.replace("          packages/harness-agy/src/win32-print-acceptance.test.ts\n", ""),
  ],
  [
    "deleted release stop-loop consumer test",
    ci.replace("          scripts/lib/release-windows-stop.test.mjs\n", ""),
  ],
  [
    "deleted portable platform-auth declaration test",
    ci.replace("          packages/schema/src/platform-auth-policy.test.ts\n", ""),
  ],
  [
    "deleted SQLite store boundary tests",
    ci.replace("          packages/daemon/src/store/store.test.ts\n", ""),
  ],
  [
    "deleted SQLite storage owner cleanup test",
    ci.replace("          packages/cli/src/sql-daemon-storage-owner.test.ts\n", ""),
  ],
  [
    "deleted native writer birth tests",
    ci.replace("          packages/cli/src/claudexord-writer-birth.test.ts\n", ""),
  ],
  ["Windows agy acceptance ordered before native fixture build", delayedWindowsFixtureCi],
  ["vendor proof removed from required aggregate", ci.replace(", vendor-programs]", "]")],
  [
    "vendor proof status ignored",
    ci.replace('[ "$VENDOR_RESULT" != "success" ]', '[ "success" != "success" ]'),
  ],
  [
    "real vendor proof replaced with a no-op",
    ci.replaceAll("node scripts/vendor-program-smoke.mjs", "node --version"),
  ],
  [
    "Windows matrix removed from required aggregate",
    ci.replace("needs: [build-test, windows-test,", "needs: [build-test,"),
  ],
]) {
  if (mutated === ci || windowsPrLegFindings(mutated).length === 0) {
    errors.push(`release-workflow-check self-test: failed to reject ${label}`);
  }
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
errors.push(...coreNpmLifecycleFindings(coreManifest));
const lifecycleMutation = structuredClone(coreManifest);
lifecycleMutation.scripts.prepare = "pnpm build";
if (coreNpmLifecycleFindings(lifecycleMutation).length === 0) {
  errors.push("release-workflow-check self-test: failed to reject a core prepare rebuild");
}
const npmPublisher = readFileSync("scripts/publish-npm-release.mjs", "utf8");
const verifyDarwinPackage = npmPublisher.indexOf("verify-npm-darwin-package.mjs");
const verifyClaudexorPackage = npmPublisher.indexOf("verify-npm-claudexor-package.mjs");
const smokePackedDelegationBelt = npmPublisher.indexOf("smokePackedDelegationBelt(packed");
const publishTarball = npmPublisher.indexOf('"publish"');
if (verifyDarwinPackage < 0 || publishTarball < 0 || verifyDarwinPackage > publishTarball) {
  errors.push("publish-npm-release.mjs: Darwin package verification must precede npm publish");
}
if (verifyClaudexorPackage < 0 || publishTarball < 0 || verifyClaudexorPackage > publishTarball) {
  errors.push(
    "publish-npm-release.mjs: Claudexor MCP package verification must precede npm publish",
  );
}
if (
  smokePackedDelegationBelt < 0 ||
  publishTarball < 0 ||
  smokePackedDelegationBelt > publishTarball
) {
  errors.push(
    "publish-npm-release.mjs: exact packed delegation belt smoke must precede npm publish",
  );
}
for (const [label, pattern] of [
  ["published provenance is bound to source identity", /validatePublishedProvenance/],
  ["published latest dist-tag is verified", /dist-tags.*latest/s],
  ["published package signatures are audited", /audit[",\s]+signatures/],
  // `latest` rides the publish; `next` has to be moved deliberately (attempted
  // after the publish, never blocking it). Dropping the move strands the channel.
  ["next dist-tag is moved to the published version", /dist-tag[",\s]+add[",\s]+.*next/s],
]) {
  if (!pattern.test(npmPublisher)) errors.push(`publish-npm-release.mjs: ${label}`);
}

const verifier = readFileSync("scripts/verify-release-input.mjs", "utf8");
if (
  !verifier.includes('process.env.REVIEW_CONFIRMED_INPUT !== "true"') ||
  !verifier.includes("process.env.REVIEW_URL_INPUT")
) {
  errors.push(
    "verify-release-input.mjs: publish must require independent review and maintainer confirmation",
  );
}
for (const retired of ["review_attestation_b64:", "waive_cursor_review:", "skip_custom_ed25519:"]) {
  if (release.includes(retired))
    errors.push(`release.yml: retired review/publication input ${retired}`);
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
  ["a stored npm token is retired: npm publishes through trusted publishing", /secrets\.NPM_TOKEN/],
]) {
  if (pattern.test(release)) errors.push(`release.yml: ${label}`);
}

for (const [label, pattern] of [
  ["manual tag input is required", /workflow_dispatch:[\s\S]*?tag:[\s\S]*?required:\s*true/],
  ["GitHub OIDC permission is required", /id-token:\s*write/],
  [
    "tag input is bound to the root package version",
    /root_version=.*package\.json[\s\S]*expected_tag="v\$root_version"[\s\S]*test "\$MCP_TAG_INPUT" = "\$expected_tag"/,
  ],
  ["tag dispatch is bound to GITHUB_REF", /GITHUB_REF[\s\S]*refs\/tags\/\$MCP_TAG_INPUT/],
  ["annotated release tag is required", /git cat-file -e "\$MCP_TAG_INPUT\^\{tag\}"/],
  ["tag commit must be on origin main", /git merge-base --is-ancestor/],
  ["npm MCP metadata is verified", /mcp-registry-check\.mjs --npm/],
  [
    "publisher download is version pinned",
    /releases\/download\/v1\.8\.0\/mcp-publisher_linux_amd64\.tar\.gz/,
  ],
  [
    "publisher archive checksum is pinned",
    /1370446bbe74d562608e8005a6ccce02d146a661fbd78674e11cc70b9618d6cf/,
  ],
  ["publisher validates server metadata", /\.\/mcp-publisher validate/],
  ["registry preflight is idempotent", /mcp-registry-check\.mjs --registry before/],
  ["registry uses GitHub OIDC", /\.\/mcp-publisher login github-oidc/],
  ["registry publishes metadata", /\.\/mcp-publisher publish/],
  ["registry publication is confirmed", /mcp-registry-check\.mjs --registry after/],
]) {
  if (!pattern.test(publishMcp)) errors.push(`publish-mcp.yml: ${label}`);
}
for (const [label, pattern] of [
  ["tag-push trigger is forbidden", /^\s*push:\s*$/m],
  ["floating publisher download is forbidden", /releases\/latest|@latest/],
  [
    "long-lived registry tokens are forbidden",
    /MCP_GITHUB_TOKEN|MCP_REGISTRY_TOKEN|\$\{\{\s*secrets\./,
  ],
  ["failure bypass is forbidden", /continue-on-error:\s*true/],
]) {
  if (pattern.test(publishMcp)) errors.push(`publish-mcp.yml: ${label}`);
}

const mcpPackage = JSON.parse(readFileSync("packages/claudexor/package.json", "utf8"));
const mcpServer = JSON.parse(readFileSync("server.json", "utf8"));
if (mcpPackage.mcpName !== "io.github.razzant/claudexor") {
  errors.push("packages/claudexor/package.json: unexpected mcpName");
}
if (
  mcpServer.name !== mcpPackage.mcpName ||
  mcpServer.packages?.length !== 1 ||
  mcpServer.packages[0]?.identifier !== "claudexor" ||
  JSON.stringify(mcpServer.packages[0]?.packageArguments) !==
    JSON.stringify([
      { type: "positional", value: "mcp" },
      { type: "positional", value: "serve" },
    ])
) {
  errors.push("server.json: executable npm MCP identity or package arguments drifted");
}

// #650: a hung step must fail visibly, not hold a job for GitHub's six-hour
// default. CI jobs and release jobs that neither sign nor publish carry a job
// bound; package-macos bounds its gates step instead, and each full test step
// is followed by a listing of the processes it left. Publication stays unbounded.
errors.push(...hangBoundFindings(ci, release));
const ciListing =
  "      - name: List processes left after the test step failed or timed out\n        if: failure() && steps.test.outcome == 'failure'\n";
const gatesListing =
  "      - name: List processes left after the release gates failed or timed out\n        if: failure() && steps.gates.outcome == 'failure'\n";
for (const [label, mutatedCi, mutatedRelease] of [
  [
    "a CI job without its bound",
    ci.replace("    runs-on: macos-26\n    timeout-minutes: 25\n", "    runs-on: macos-26\n"),
    release,
  ],
  [
    "a new CI job without a bound",
    ci.replace(
      "\n  swift:\n",
      "\n  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n\n  swift:\n",
    ),
    release,
  ],
  [
    "a release smoke job without its bound",
    ci,
    release.replace(
      "    needs: [prepare, package-macos]\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n",
      "    needs: [prepare, package-macos]\n    runs-on: ubuntu-latest\n",
    ),
  ],
  [
    "npm publication cut short by a job bound",
    ci,
    release.replace(
      "    if: needs.prepare.outputs.mode == 'publish'\n    runs-on: macos-26\n",
      "    if: needs.prepare.outputs.mode == 'publish'\n    runs-on: macos-26\n    timeout-minutes: 120\n",
    ),
  ],
  [
    "signing and notarization cut short by a job bound",
    ci,
    release.replace(
      "    runs-on: macos-26\n    permissions:\n      contents: read\n      id-token: write\n      attestations: write\n",
      "    runs-on: macos-26\n    timeout-minutes: 120\n    permissions:\n      contents: read\n      id-token: write\n      attestations: write\n",
    ),
  ],
  [
    "the CI test step without its bound",
    ci.replace("        id: test\n        timeout-minutes: 40\n", "        id: test\n"),
    release,
  ],
  [
    "a CI test step bound the job bound would preempt",
    ci.replace(
      "        id: test\n        timeout-minutes: 40\n",
      "        id: test\n        timeout-minutes: 60\n",
    ),
    release,
  ],
  [
    "the release gates step without its bound",
    ci,
    release.replace(
      "        id: gates\n        shell: bash\n        timeout-minutes: 100\n",
      "        id: gates\n        shell: bash\n",
    ),
  ],
  [
    "a CI test step without its process listing",
    ci.replace(ciListing, "      - name: Unrelated\n        if: failure()\n"),
    release,
  ],
  [
    "a release process listing that runs after every failure",
    ci,
    release.replace(gatesListing, gatesListing.replace(" && steps.gates.outcome == 'failure'", "")),
  ],
]) {
  if (
    (mutatedCi === ci && mutatedRelease === release) ||
    hangBoundFindings(mutatedCi, mutatedRelease).length === 0
  ) {
    errors.push(`release-workflow-check self-test: failed to reject ${label}`);
  }
}

const directInputs = [...release.matchAll(/\$\{\{\s*inputs\.[^}]+\}\}/g)].map((match) => match[0]);
if (directInputs.length !== 7) {
  errors.push(
    `release.yml: expected exactly seven input projections into workflow env, got ${directInputs.length}`,
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

function exactCandidateAppPromotionErrors(job) {
  const findings = [];
  const candidateVerifyStep = stepBody(job, "Verify signed and notarized artifacts");
  const verifyStep = stepBody(job, "Verify promoted candidate app artifacts (publish, A-5)");
  const assembleStep = stepBody(job, "Assemble checksums, SBOM and review evidence");
  const requirePattern = (label, pattern, scope = job) => {
    if (!pattern.test(scope)) findings.push(`release.yml: ${label}`);
  };
  for (const [label, needle] of exactPromotionPairedNeedles) {
    const count = job.split(needle).length - 1;
    if (count !== 2) {
      findings.push(
        `release.yml: ${label} must occur exactly twice for candidate/promoted mutation targeting (got ${count})`,
      );
    }
  }
  requirePattern(
    "release Node runtime must be pinned unconditionally",
    /- name: Pin release Node runtime\n\s+shell: bash\n\s+run: echo "CLAUDEXOR_NODE_BIN=\$\(node -p 'process\.execPath'\)" >> "\$GITHUB_ENV"/,
  );
  requirePattern(
    "app signing credential import must be candidate-only",
    /- name: Require and import Apple release credentials\n\s+if: needs\.prepare\.outputs\.mode == 'candidate'/,
  );
  requirePattern(
    "signed app build must be candidate-only",
    /- name: Build signed DMG and ZIP\n\s+if: needs\.prepare\.outputs\.mode == 'candidate'[\s\S]*?apps\/macos\/scripts\/build-app\.sh/,
  );
  requirePattern(
    "fresh app verification must be candidate-only",
    /- name: Verify signed and notarized artifacts\n\s+if: needs\.prepare\.outputs\.mode == 'candidate'/,
  );
  requirePattern(
    "candidate ZIP app must probe the exact daemon version and build SHA before upload",
    /PREPARED_SHA:[\s\S]*?ditto -x -k "\$zip"[\s\S]*?claudexord\.bundle\.cjs" --probe[\s\S]*?probe\.version !== process\.argv\[2\][\s\S]*?probe\.buildSha !== process\.argv\[3\][\s\S]*?"\$probe" "\$VERSION" "\$PREPARED_SHA"/,
    candidateVerifyStep,
  );
  requirePattern(
    "candidate run must bind the release workflow, exact SHA, and successful conclusion",
    /test "\$run_path" = "\.github\/workflows\/release\.yml"[\s\S]*?test "\$run_sha" = "\$PREPARED_SHA"[\s\S]*?test "\$run_conclusion" = success/,
    verifyStep,
  );
  requirePattern(
    "candidate provenance must bind signer workflow and source digest",
    /gh attestation verify "\$file"[\s\S]*?--signer-workflow "\$GITHUB_REPOSITORY\/\.github\/workflows\/release\.yml"[\s\S]*?--source-digest "\$PREPARED_SHA"/,
    verifyStep,
  );
  requirePattern(
    "candidate file set must be exact and regular before promotion",
    /unexpected candidate asset set[\s\S]*?stat\.isFile\(\)[\s\S]*?stat\.isSymbolicLink\(\)[\s\S]*?stat\.size === 0/,
    verifyStep,
  );
  requirePattern(
    "candidate promotion allowlist must be the exact twelve-asset release set",
    /const expected = \[\n\s*`Claudexor-\$\{version\}\.dmg`,\n\s*`Claudexor-\$\{version\}\.spdx\.json`,\n\s*`Claudexor-\$\{version\}\.zip`,\n\s*`Claudexor-remote-runtime-\$\{version\}\.spdx\.json`,\n\s*"SHA256SUMS",\n\s*`claudexor-remote-runtime-\$\{version\}-darwin-arm64\.tar\.gz`,\n\s*`claudexor-remote-runtime-\$\{version\}-darwin-x64\.tar\.gz`,\n\s*`claudexor-remote-runtime-\$\{version\}-linux-arm64\.tar\.gz`,\n\s*`claudexor-remote-runtime-\$\{version\}-linux-x64\.tar\.gz`,\n\s*`claudexor-runtime-\$\{version\}\.tar\.gz`,\n\s*"remote-runtime-manifest\.json",\n\s*"runtime-manifest\.json",\n\s*\]\.sort\(\);/,
    verifyStep,
  );
  const attestation = verifyStep.indexOf('gh attestation verify "$file"');
  const checksum = verifyStep.indexOf("shasum -a 256 -c SHA256SUMS");
  if (!(attestation >= 0 && attestation < checksum)) {
    findings.push(
      "release.yml: provenance must be verified before candidate SHA256SUMS is trusted",
    );
  }
  // The exact allowlist makes the early loop cover EVERY promoted asset, so it
  // is the SINGLE owner of promoted-candidate provenance: nothing may consume a
  // candidate asset before it, and no later step may re-verify (a late verifier
  // is a duplicate owner that lets uses drift ahead of it unnoticed).
  const provenanceLoop = job.indexOf('gh attestation verify "$file"');
  for (const [useLabel, useNeedle] of [
    ["closure tarball promotion", 'cp "$cand" "$tarball"'],
    ["remote archive promotion", "cp candidate-assets/claudexor-remote-runtime-"],
    ["remote manifest promotion", "cp candidate-assets/remote-runtime-manifest.json"],
  ]) {
    const use = job.indexOf(useNeedle);
    if (!(provenanceLoop >= 0 && use >= 0 && provenanceLoop < use)) {
      findings.push(
        `release.yml: ${useLabel} must come after the single early candidate provenance loop`,
      );
    }
  }
  if (job.split("gh attestation verify").length - 1 !== 1) {
    findings.push(
      "release.yml: the early candidate loop must be the ONLY provenance verifier in package-macos",
    );
  }
  requirePattern(
    "normal publish must ship the engine manifest only after signed verification against the promoted closure",
    /signed="\$RUNNER_TEMP\/runtime-manifest\.signed\.json"\n\s*printf '%s' "\$RUNTIME_MANIFEST_B64_INPUT" \| base64 -d > "\$signed"\n\s*node scripts\/verify-signed-runtime-manifest\.mjs \\\n\s*--signed "\$signed" \\\n\s*--unsigned "\$RUNNER_TEMP\/runtime-closure\/runtime-manifest\.json" \\\n\s*--tarball "\$RUNNER_TEMP\/runtime-closure\/claudexor-runtime-\$VERSION\.tar\.gz" \\\n\s*--version "\$VERSION" \\\n\s*--expected-build-sha "\$PREPARED_SHA"\n\s*cp "\$signed" "\$assets\/runtime-manifest\.json"/,
    assembleStep,
  );
  requirePattern(
    "publish must ship the remote manifest only after unsigned-to-signed verification against promoted archives",
    /remote_signed="\$RUNNER_TEMP\/remote-runtime-manifest\.signed\.json"\n\s*printf '%s' "\$REMOTE_RUNTIME_MANIFEST_B64_INPUT" \| base64 -d > "\$remote_signed"\n\s*node scripts\/verify-signed-remote-runtime-manifest\.mjs \\\n\s*--signed "\$remote_signed" \\\n\s*--unsigned "\$RUNNER_TEMP\/remote-runtimes\/remote-runtime-manifest\.json" \\\n\s*--assets-dir "\$RUNNER_TEMP\/remote-runtimes" \\\n\s*--version "\$VERSION" \\\n\s*--expected-build-sha "\$PREPARED_SHA"\n\s*cp "\$remote_signed" "\$assets\/remote-runtime-manifest\.json"/,
    assembleStep,
  );
  requirePattern(
    "unsigned engine manifest stays candidate-only",
    /if \[ "\$RELEASE_MODE_INPUT" = publish \]; then[\s\S]*?cp "\$signed" "\$assets\/runtime-manifest\.json"\n\s*else\n\s*cp "\$RUNNER_TEMP\/runtime-closure\/runtime-manifest\.json" "\$assets\/"/,
    assembleStep,
  );
  requirePattern(
    "unsigned remote manifest stays candidate-only",
    /if \[ "\$RELEASE_MODE_INPUT" = publish \]; then[\s\S]*?cp "\$remote_signed" "\$assets\/remote-runtime-manifest\.json"\n\s*else\n\s*cp "\$RUNNER_TEMP\/remote-runtimes\/remote-runtime-manifest\.json" "\$assets\/"/,
    assembleStep,
  );
  requirePattern(
    "publish must regenerate the remote SBOM from promoted bytes and ship the byte-compared candidate SBOM",
    /GITHUB_SHA="\$PREPARED_SHA" node scripts\/generate-remote-runtime-sbom\.mjs \\\n\s*"\$RUNNER_TEMP\/remote-runtimes" "\$VERSION" \\\n\s*> "\$RUNNER_TEMP\/promoted-remote-runtime\.spdx\.json"\n\s*cmp "candidate-assets\/Claudexor-remote-runtime-\$VERSION\.spdx\.json" \\\n\s*"\$RUNNER_TEMP\/promoted-remote-runtime\.spdx\.json"\n\s*cp "candidate-assets\/Claudexor-remote-runtime-\$VERSION\.spdx\.json" "\$assets\/"/,
    assembleStep,
  );
  requirePattern(
    "candidate remote SBOM generation must bind the prepared SHA",
    /else\n\s*GITHUB_SHA="\$PREPARED_SHA" node scripts\/generate-remote-runtime-sbom\.mjs \\\n\s*"\$RUNNER_TEMP\/remote-runtimes" "\$VERSION" \\\n\s*> "\$assets\/Claudexor-remote-runtime-\$VERSION\.spdx\.json"/,
    assembleStep,
  );
  requirePattern(
    "candidate ZIP app must verify signature, version, and exact daemon build SHA",
    /ditto -x -k "\$candidate_zip"[\s\S]*?codesign --verify --strict[\s\S]*?PlistBuddy[\s\S]*?test "\$app_version" = "\$VERSION"[\s\S]*?claudexord\.bundle\.cjs" --probe[\s\S]*?probe\.version !== process\.argv\[2\][\s\S]*?probe\.buildSha !== process\.argv\[3\]/,
    verifyStep,
  );
  requirePattern(
    "candidate app must pass packaged belt smoke",
    /promoted_belt_home="\$RUNNER_TEMP\/promoted-belt-home"[\s\S]*?HOME="\$promoted_belt_home" node scripts\/smoke-delegation-belt-entry\.mjs[\s\S]*?--entry "\$promoted_app\/Claudexor\.app\/Contents\/Resources\/claudexord\.bundle\.cjs"[\s\S]*?--config-root "\$promoted_belt_home\/config"/,
    verifyStep,
  );
  requirePattern(
    "candidate SBOM must be regenerated from the promoted app and compared",
    /GITHUB_SHA="\$PREPARED_SHA" pnpm licenses list --prod --json \|[\s\S]*?GITHUB_SHA="\$PREPARED_SHA" node scripts\/generate-release-sbom\.mjs[\s\S]*?--app-bundle "\$promoted_app\/Claudexor\.app"[\s\S]*?cmp "\$candidate_sbom" "\$RUNNER_TEMP\/promoted-candidate\.spdx\.json"/,
    verifyStep,
  );
  requirePattern(
    "publish assembly must copy and compare exact candidate DMG, ZIP, and SBOM",
    /if \[ "\$RELEASE_MODE_INPUT" = publish \]; then[\s\S]*?cp "candidate-assets\/Claudexor-\$VERSION\.dmg" "\$assets\/"[\s\S]*?cp "candidate-assets\/Claudexor-\$VERSION\.zip" "\$assets\/"[\s\S]*?cp "candidate-assets\/Claudexor-\$VERSION\.spdx\.json" "\$assets\/"[\s\S]*?cmp "candidate-assets\/Claudexor-\$VERSION\.dmg" "\$assets\/Claudexor-\$VERSION\.dmg"[\s\S]*?cmp "candidate-assets\/Claudexor-\$VERSION\.zip" "\$assets\/Claudexor-\$VERSION\.zip"[\s\S]*?cmp "candidate-assets\/Claudexor-\$VERSION\.spdx\.json" "\$assets\/Claudexor-\$VERSION\.spdx\.json"/,
    assembleStep,
  );
  requirePattern(
    "candidate SBOM must bind both license input and document namespace to the prepared SHA",
    /else[\s\S]*?GITHUB_SHA="\$PREPARED_SHA" pnpm licenses list --prod --json \|[\s\S]*?GITHUB_SHA="\$PREPARED_SHA" node scripts\/generate-release-sbom\.mjs[\s\S]*?--app-bundle apps\/macos\/dist\/bundle\.noindex\/Claudexor\.app/,
    assembleStep,
  );
  // Every write into "$assets/" is pinned: the released asset set is exactly
  // twelve names, and a new cp/redirect here would ship a 13th asset without
  // touching the candidate allowlist above (which only reads candidate-assets
  // on the publish path). Adding an asset must be a deliberate, reviewed
  // change to BOTH lists.
  const assembledAssetWrites = assembleStep
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) => (line.startsWith("cp ") || line.startsWith("> ")) && line.includes('"$assets/'),
    )
    .sort();
  const expectedAssembledAssetWrites = [
    'cp "candidate-assets/Claudexor-$VERSION.dmg" "$assets/"',
    'cp "candidate-assets/Claudexor-$VERSION.zip" "$assets/"',
    'cp "candidate-assets/Claudexor-$VERSION.spdx.json" "$assets/"',
    'cp "apps/macos/dist/Claudexor-$VERSION.dmg" "$assets/"',
    'cp "apps/macos/dist/Claudexor-$VERSION.zip" "$assets/"',
    '> "$assets/Claudexor-$VERSION.spdx.json"',
    'cp "$RUNNER_TEMP/runtime-closure/claudexor-runtime-$VERSION.tar.gz" "$assets/"',
    'cp "$RUNNER_TEMP/remote-runtimes"/claudexor-remote-runtime-"$VERSION"-*.tar.gz "$assets/"',
    'cp "$signed" "$assets/runtime-manifest.json"',
    'cp "$RUNNER_TEMP/runtime-closure/runtime-manifest.json" "$assets/"',
    'cp "$remote_signed" "$assets/remote-runtime-manifest.json"',
    'cp "$RUNNER_TEMP/remote-runtimes/remote-runtime-manifest.json" "$assets/"',
    'cp "candidate-assets/Claudexor-remote-runtime-$VERSION.spdx.json" "$assets/"',
    '> "$assets/Claudexor-remote-runtime-$VERSION.spdx.json"',
  ].sort();
  if (JSON.stringify(assembledAssetWrites) !== JSON.stringify(expectedAssembledAssetWrites)) {
    findings.push(
      "release.yml: assembled release-asset writes drifted from the pinned exact set (adding a 13th asset needs a deliberate review of the candidate allowlist, SHA256SUMS, provenance, and the publish-release phase checks)",
    );
  }
  const publishArmStart = assembleStep.indexOf('if [ "$RELEASE_MODE_INPUT" = publish ]; then');
  const publishArmEnd = assembleStep.indexOf("\n          else", publishArmStart);
  const publishArm =
    publishArmStart >= 0 && publishArmEnd > publishArmStart
      ? assembleStep.slice(publishArmStart, publishArmEnd)
      : "";
  if (/apps\/macos\/dist\//.test(publishArm)) {
    findings.push("release.yml: publish app assembly must not read fresh app build outputs");
  }
  const download = job.indexOf("Promote the exact candidate release artifact");
  const verify = job.indexOf("Verify promoted candidate app artifacts");
  const assemble = job.indexOf("Assemble checksums, SBOM and review evidence");
  if (!(download >= 0 && download < verify && verify < assemble)) {
    findings.push("release.yml: candidate download, verification, and assembly order is invalid");
  }
  return findings;
}

function windowsPrLegFindings(workflow) {
  const findings = [];
  const windows = jobSection(workflow, "windows-test");
  const gate = jobSection(workflow, "build-test-gate");
  const requirePattern = (label, pattern, scope = windows) => {
    if (!scope || !pattern.test(scope)) findings.push(`ci.yml: ${label}`);
  };
  const matrixRows = [...windows.matchAll(/^\s+- runner:\s*([^\s]+)\s*$/gm)].map(
    (match) => match[1],
  );
  if (JSON.stringify(matrixRows) !== JSON.stringify(["windows-2022", "windows-latest"])) {
    findings.push(
      "ci.yml: Windows PR matrix must contain exactly windows-2022 then windows-latest",
    );
  }
  requirePattern(
    "windows-2022 must run Node 24.15.0 and windows-latest must run Node 24.22.3",
    /- runner: windows-2022\n\s*node-version: 24\.15\.0\n\s*- runner: windows-latest\n\s*node-version: 24\.22\.3/,
  );
  requirePattern(
    "Windows PR legs must initialize the x64 MSVC environment",
    /Initialize pinned x64 MSVC environment[\s\S]*?VsDevCmd\.bat[\s\S]*?-arch=x64 -host_arch=x64/,
  );
  requirePattern(
    "Windows PR legs must build the native ConPTY fixture",
    /pnpm --filter @claudexor\/core build:win32-fixtures/,
  );
  requirePattern(
    "Windows PR legs must run helper, resolver, and runner transport tests",
    /win32-conpty-helper\.test\.ts[\s\S]*?setup-login-pty\.test\.ts[\s\S]*?setup-login-runner-transport\.test\.ts/,
  );
  requirePattern(
    "Windows PR legs must run the real agy print/client_pty acceptance",
    /packages\/harness-agy\/src\/win32-print-acceptance\.test\.ts/,
  );
  requirePattern(
    "Windows PR legs must execute the release smoke's daemon stop loop under pwsh",
    /^\s+scripts\/lib\/release-windows-stop\.test\.mjs$/m,
    stepBody(
      windows,
      "Test (platform auth, agy print, ConPTY, setup transport, SQL recovery, CLI exit)",
    ),
  );
  requirePattern(
    "Windows PR legs must run portable platform-auth declaration and consumer tests",
    /platform-auth-policy\.test\.ts[\s\S]*?capabilities\.test\.ts[\s\S]*?harness-agy\/src\/conformance\.test\.ts[\s\S]*?setup-login-capability\.test\.ts/,
  );
  requirePattern(
    "Windows PR legs must exercise SQLite store, runtime, flush and file-owner boundaries",
    /store\/store\.test\.ts[\s\S]*?store\/runtime\.test\.ts[\s\S]*?store\/flusher\.test\.ts[\s\S]*?store\/blob-files\.test\.ts[\s\S]*?store\/obligations\.test\.ts[\s\S]*?store\/maintenance\.test\.ts/,
  );
  requirePattern(
    "Windows PR legs must exercise SQLite storage owner cleanup",
    /packages\/cli\/src\/sql-daemon-storage-owner\.test\.ts/,
  );
  requirePattern(
    "Windows PR legs must run the native writer birth and built daemon lifecycle tests",
    /writer-lease-pid-reuse\.test\.ts[\s\S]*?claudexord-writer-birth\.test\.ts/,
    stepBody(
      windows,
      "Writer birth identity and built daemon lifecycle (credential-free native processes)",
    ),
  );
  const build = windows.indexOf("      - name: Build\n        run: pnpm build");
  const nativeFixture = windows.indexOf("pnpm --filter @claudexor/core build:win32-fixtures");
  const agyAcceptance = windows.indexOf("packages/harness-agy/src/win32-print-acceptance.test.ts");
  if (!(build >= 0 && build < nativeFixture && nativeFixture < agyAcceptance)) {
    findings.push(
      "ci.yml: Windows agy acceptance must run after pnpm build and the native fixture build",
    );
  }
  requirePattern(
    "required build-test aggregate must depend on and reject a failed Windows matrix",
    /needs:\s*\[[^\]]*\bwindows-test\b[^\]]*\][\s\S]*?WINDOWS_RESULT:[\s\S]*?\[ "\$WINDOWS_RESULT" != "success" \]/,
    gate,
  );
  requirePattern(
    "required aggregate must depend on and reject failed vendor proof",
    /needs:\s*\[[^\]]*\bvendor-programs\b[^\]]*\][\s\S]*?VENDOR_RESULT:[\s\S]*?\[ "\$VENDOR_RESULT" != "success" \]/,
    gate,
  );
  requirePattern(
    "Windows must execute real vendor proof",
    /node scripts\/vendor-program-smoke\.mjs/,
    windows,
  );
  requirePattern(
    "vendor-programs must execute real vendor proof",
    /node scripts\/vendor-program-smoke\.mjs/,
    jobSection(workflow, "vendor-programs"),
  );
  return findings;
}

function windowsConptyCustodyFindings(workflow) {
  const findings = [];
  const authority = jobSection(workflow, "windows-conpty-authority");
  const packageMacos = jobSection(workflow, "package-macos");
  const assembledSmoke = jobSection(workflow, "windows-conpty-candidate-smoke");
  const assembledStop = stepBody(
    assembledSmoke,
    "Probe, handshake and gracefully stop the assembled daemon closure",
  );
  const publishNpm = jobSection(workflow, "publish-npm");
  const npmSmoke = jobSection(workflow, "npm-smoke");
  const requirePattern = (label, pattern, scope) => {
    if (!scope || !pattern.test(scope)) findings.push(`release.yml: ${label}`);
  };

  requirePattern(
    "Windows ConPTY authority must run on windows-2022",
    /^\s{4}runs-on:\s*windows-2022\s*$/m,
    authority,
  );
  requirePattern(
    "Windows ConPTY authority must use the Node 24.15 compatibility floor",
    /node-version:\s*24\.15\.0/,
    authority,
  );
  requirePattern(
    "candidate authority must build the helper and native fake child with MSVC",
    /Build authoritative helper and native fake child[\s\S]*?build-win32-conpty-helper\.mjs[\s\S]*?--require --out \$helper --fixture-out \$fixture/,
    authority,
  );
  requirePattern(
    "publish authority must download the candidate run's exact internal artifact",
    /Download the candidate authority artifact for exact publish promotion[\s\S]*?download-artifact@[0-9a-f]{40}[\s\S]*?run-id:\s*\$\{\{\s*needs\.prepare\.outputs\.candidate_run_id\s*\}\}/,
    authority,
  );
  requirePattern(
    "Windows authority must pin the exact three-file internal set",
    /"claudexor-conpty-helper\.exe",\n\s*"claudexor-conpty-helper\.exe\.sha256",\n\s*"claudexor-conpty-test-child\.exe"/,
    authority,
  );
  requirePattern(
    "Windows authority must verify its SHA sidecar and PE-x64 shape before upload",
    /Windows ConPTY authority SHA sidecar mismatch[\s\S]*?verify-win32-conpty-helper\.mjs --file \$helper --expected-sha256 \$hash[\s\S]*?verify-win32-conpty-helper\.mjs --file \$fixture/,
    authority,
  );
  requirePattern(
    "macOS packaging must depend on and download the Windows authority artifact",
    /needs:\s*\[prepare, windows-conpty-authority\][\s\S]*?Download authoritative Windows ConPTY bytes/,
    packageMacos,
  );
  requirePattern(
    "macOS packaging must export the authoritative helper path, hash, and required flag",
    /CLAUDEXOR_WIN32_CONPTY_HELPER=\$helper[\s\S]*?CLAUDEXOR_WIN32_CONPTY_SHA256=\$expected[\s\S]*?CLAUDEXOR_REQUIRE_WIN32_CONPTY_HELPER=1/,
    packageMacos,
  );
  requirePattern(
    "candidate app and ZIP must compare embedded Windows helper bytes to authority",
    /verify-win32-conpty-helper\.mjs \\\n\s*--file "\$CLAUDEXOR_WIN32_CONPTY_HELPER" \\\n\s*--file "\$app\/Contents\/Resources\/native\/claudexor-conpty-helper\.exe" \\\n\s*--file "\$zipstage\/Claudexor\.app\/Contents\/Resources\/native\/claudexor-conpty-helper\.exe"/,
    packageMacos,
  );
  requirePattern(
    "runtime closure must bind and re-extract the authoritative Windows helper",
    /build-runtime-closure\.mjs[\s\S]*?--win32-conpty-sha256 "\$CLAUDEXOR_WIN32_CONPTY_SHA256"[\s\S]*?runtime-closure-extract[\s\S]*?closure_extract\/native\/claudexor-conpty-helper\.exe/,
    packageMacos,
  );
  requirePattern(
    "assembled Windows smoke must run on windows-latest with Node 24.22.3",
    /^\s{4}runs-on:\s*windows-latest\s*$[\s\S]*?node-version:\s*24\.22\.3/m,
    assembledSmoke,
  );
  requirePattern(
    "assembled Windows smoke must depend on candidate assembly and authority",
    /needs:\s*\[prepare, windows-conpty-authority, package-macos\]/,
    assembledSmoke,
  );
  requirePattern(
    "assembled Windows smoke must compare authority, app, and closure helper bytes",
    /--file \$authority --file \$appHelper --file \$closureHelper[\s\S]*?--expected-sha256 \$expected/,
    assembledSmoke,
  );
  requirePattern(
    "assembled Windows smoke must execute native helper and setup transport contracts",
    /win32-conpty-helper\.test\.ts[\s\S]*?setup-login-pty\.test\.ts[\s\S]*?setup-login-runner-transport\.test\.ts/,
    assembledSmoke,
  );
  if (/setup-login-url-disclosure\.test\.ts/.test(assembledSmoke)) {
    findings.push(
      "release.yml: assembled Windows smoke must not run the POSIX-only setup-login-url-disclosure suite",
    );
  }
  requirePattern(
    "assembled Windows daemon must pass probe, protocol handshake, and identity-bound stop",
    /--probe[\s\S]*?\/v2\/handshake[\s\S]*?--stop \$env:VERSION \$env:PREPARED_SHA[\s\S]*?WaitForExit\(15000\)/,
    assembledStop,
  );
  requirePattern(
    "assembled Windows stop must retry the retryable refusals of a just-started daemon",
    /--stop \$env:VERSION \$env:PREPARED_SHA[\s\S]*?\$stop\.retryable[\s\S]*?\$stopDeadline[\s\S]*?Start-Sleep[\s\S]*?WaitForExit\(15000\)/,
    assembledStop,
  );
  requirePattern(
    "npm publication must be gated by the assembled Windows smoke",
    /needs:\s*\[[^\]]*windows-conpty-candidate-smoke[^\]]*\]/,
    publishNpm,
  );
  requirePattern(
    "npm must stage the promoted closure helper rather than rebuild or copy fresh authority",
    /tar -xzf "release-assets\/claudexor-runtime-\$VERSION\.tar\.gz"[\s\S]*?--file "\$authority" --file "\$promoted" --expected-sha256 "\$expected"[\s\S]*?cp "\$promoted" packages\/core\/dist\/native\/claudexor-conpty-helper\.exe/,
    publishNpm,
  );
  const npmBuild = publishNpm.indexOf("      - run: pnpm build");
  const npmStage = publishNpm.indexOf(
    "      - name: Stage the promoted closure's exact Windows helper for npm",
  );
  const npmPack = publishNpm.indexOf("      - name: Verify packed native helper custody");
  const npmPublish = publishNpm.indexOf(
    "      - name: Publish only missing, byte-identical packages",
  );
  if (!(npmBuild >= 0 && npmBuild < npmStage && npmStage < npmPack && npmPack < npmPublish)) {
    findings.push(
      "release.yml: npm must build before staging, then only verify/pack/publish the promoted helper",
    );
  }
  if (/\b(?:pnpm|npm)\b[^\n]*\bbuild\b/.test(publishNpm.slice(Math.max(0, npmStage)))) {
    findings.push("release.yml: npm must not rebuild core after staging the promoted helper");
  }
  requirePattern(
    "npm smoke must compare the installed helper to the internal authority",
    /verify-win32-conpty-helper\.mjs[\s\S]*?windows-conpty-authority\/claudexor-conpty-helper\.exe[\s\S]*?--file "\$packaged_conpty" --expected-sha256 "\$expected"/,
    npmSmoke,
  );
  if (/signtool|Authenticode/i.test(workflow)) {
    findings.push(
      "release.yml: Windows helper custody must not claim or introduce Authenticode in this plan",
    );
  }
  return findings;
}

function windowsConptyBuildFindings(source) {
  const findings = [];
  const compileStart = source.indexOf("function compile(");
  const verifyStart = source.indexOf("function verifyStaticCrtDependencies(");
  const verifyProbeStart = source.indexOf("function verifyProbe(");
  const compile =
    compileStart >= 0 && verifyStart > compileStart ? source.slice(compileStart, verifyStart) : "";
  const verifier =
    verifyStart >= 0 && verifyProbeStart > verifyStart
      ? source.slice(verifyStart, verifyProbeStart)
      : "";

  if (!/["']\/MT["']/.test(compile)) {
    findings.push("build-win32-conpty-helper.mjs: common MSVC compile path must freeze /MT");
  }
  if (!/sanitizedMsvcEnvironment\(process\.env\)/.test(compile)) {
    findings.push(
      "build-win32-conpty-helper.mjs: common MSVC compile path must scrub inherited CL and _CL_",
    );
  }
  if (!/spawnSync\([\s\S]*?["']cl\.exe["'][\s\S]*?env:\s*buildEnvironment/.test(compile)) {
    findings.push(
      "build-win32-conpty-helper.mjs: cl.exe must receive the scrubbed build environment",
    );
  }
  const assertion = compile.indexOf("verifyStaticCrtDependencies(temporary, buildEnvironment)");
  const publish = compile.indexOf("renameSync(temporary, output)");
  if (!(assertion >= 0 && publish > assertion)) {
    findings.push(
      "build-win32-conpty-helper.mjs: every linked PE must pass the CRT dependency assertion before publication",
    );
  }
  if (
    !/spawnSync\([\s\S]*?["']dumpbin\.exe["'][\s\S]*?["']\/DEPENDENTS["']/.test(verifier) ||
    !/dumpbinDependencyBasenames/.test(verifier) ||
    !/dynamicCrtDependencies/.test(verifier) ||
    !/dependencies\.length === 0/.test(verifier)
  ) {
    findings.push(
      "build-win32-conpty-helper.mjs: build must fail closed on dumpbin dependency basenames and dynamic VC/UCRT imports",
    );
  }
  return findings;
}

function coreNpmLifecycleFindings(manifest) {
  const findings = [];
  for (const lifecycle of ["prepack", "prepare", "postpack"]) {
    const script = String(manifest.scripts?.[lifecycle] ?? "");
    if (/\b(?:pnpm|npm|turbo)\b[^&|;]*\bbuild\b|\btsc\b|build-win32-conpty-helper/.test(script)) {
      findings.push(
        `packages/core/package.json: ${lifecycle} must verify, not rebuild, after promoted helper staging`,
      );
    }
  }
  return findings;
}

function remoteSmokeGateFindings(workflow) {
  const findings = [];
  const smokeJob = jobSection(workflow, "remote-linux-ssh-smoke");
  if (!smokeJob) {
    findings.push("release.yml: remote-linux-ssh-smoke job is missing");
  } else if (
    !/scripts\/smoke-remote-runtime-ssh\.sh \\\n\s*"release-assets\/claudexor-remote-runtime-\$VERSION-linux-x64\.tar\.gz"/.test(
      smokeJob,
    )
  ) {
    findings.push(
      "release.yml: remote-linux-ssh-smoke must invoke scripts/smoke-remote-runtime-ssh.sh on the promoted linux-x64 archive (a no-op invocation hollows the gate)",
    );
  }
  for (const gate of ["publish-npm", "publish-release"]) {
    if (
      !/^\s+needs:\s*\[[^\]]*\bremote-linux-ssh-smoke\b[^\]]*\]\s*$/m.test(
        jobSection(workflow, gate),
      )
    ) {
      findings.push(
        `release.yml: ${gate} must list remote-linux-ssh-smoke in needs: — publication is gated on the SSH smoke`,
      );
    }
  }
  return findings;
}

function programFreshnessFindings(workflow) {
  const section = jobSection(workflow, "package-macos");
  const gates = stepBody(section, "Deterministic release gates");
  const freshness = stepBody(section, freshnessStepName);
  const findings = [];
  if (
    /GITHUB_TOKEN|RELEASE_SOURCE_TOKEN|\$\{\{\s*github\.token\s*\}\}|harness-program-freshness\.mjs/.test(
      gates,
    )
  )
    findings.push(
      "release.yml: deterministic gates must contain neither the source token nor the freshness command",
    );
  if (
    !freshness ||
    section.indexOf(freshness) !== section.indexOf(gates) + gates.length ||
    !/^ {8}run: node scripts\/harness-program-freshness\.mjs\s*$/m.test(freshness) ||
    !/^ {8}env:\n {10}GITHUB_TOKEN: \$\{\{ github\.token \}\}\s*$/m.test(freshness) ||
    /^ {8}(?:if|continue-on-error):/m.test(freshness)
  )
    findings.push(
      "release.yml: authenticated vendor freshness must run in its own step immediately after the gates, for both candidate and publish, and fail closed",
    );
  return findings;
}

function hangBoundFindings(ciWorkflow, releaseWorkflow) {
  const findings = [];
  const minutes = (text, indent) =>
    Number(
      new RegExp(`^ {${indent}}timeout-minutes: ([1-9][0-9]*)\\s*$`, "m").exec(text)?.[1] ?? 0,
    );
  // Signing, notarization, attestation and publication are never cut short.
  const unbounded = new Set(["package-macos", "publish-npm", "publish-release"]);
  for (const [file, workflow] of [
    ["ci.yml", ciWorkflow],
    ["release.yml", releaseWorkflow],
  ]) {
    for (const job of workflowJobs(workflow)) {
      const bounded = minutes(jobSection(workflow, job), 4) > 0;
      if (file === "release.yml" && unbounded.has(job)) {
        if (bounded)
          findings.push(`${file}: ${job} signs or publishes and must carry no job timeout-minutes`);
      } else if (!bounded) {
        findings.push(`${file}: job ${job} must declare a finite timeout-minutes`);
      }
    }
  }
  for (const [file, workflow, job, step, id] of [
    ["ci.yml", ciWorkflow, "build-test", "Test", "test"],
    ["release.yml", releaseWorkflow, "package-macos", "Deterministic release gates", "gates"],
  ]) {
    const section = jobSection(workflow, job);
    const suite = stepBody(section, step);
    const stepBound = minutes(suite, 8);
    const jobBound = minutes(section, 4);
    if (!new RegExp(`^ {8}id: ${id}\\s*$`, "m").test(suite) || stepBound === 0) {
      findings.push(
        `${file}: the ${step} step of ${job} needs id ${id} and a finite timeout-minutes`,
      );
    } else if (jobBound > 0 && stepBound >= jobBound) {
      findings.push(`${file}: the ${step} step bound must end before the ${job} job bound`);
    }
    let after = suite ? section.slice(section.indexOf(suite) + suite.length) : "";
    // Source authentication is confined to the intervening freshness step.
    const freshness = file === "release.yml" ? stepBody(section, freshnessStepName) : "";
    if (freshness && after.startsWith(freshness)) after = after.slice(freshness.length);
    const next = /^ {6}- [\s\S]*?(?=^ {6}- |(?![\s\S]))/m.exec(after)?.[0] ?? "";
    if (
      !next.includes(`        if: failure() && steps.${id}.outcome == 'failure'\n`) ||
      !/^ {8}run: ps axww -o [^\n]*\bcommand\b/m.test(next)
    ) {
      findings.push(
        `${file}: a process listing must follow ${step} (and release freshness) when that step failed or timed out`,
      );
    }
  }
  return findings;
}

/** The job keys of a workflow, in order. */
function workflowJobs(workflow) {
  const text = workflow.replace(/\r\n/g, "\n");
  const start = text.search(/^jobs:\n/m);
  return start < 0
    ? []
    : [...text.slice(start).matchAll(/^ {2}([a-z0-9-]+):\n/gm)].map((match) => match[1]);
}

function replaceLastOccurrence(text, needle, replacement) {
  const index = text.lastIndexOf(needle);
  return index < 0
    ? text
    : `${text.slice(0, index)}${replacement}${text.slice(index + needle.length)}`;
}
