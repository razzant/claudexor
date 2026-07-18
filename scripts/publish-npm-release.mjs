#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const out = resolve(process.env.RUNNER_TEMP ?? "/tmp", "claudexor-npm-release");
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

async function main() {
  if (!process.argv.includes("--provenance")) fail("--provenance is mandatory");
  if (!process.env.NODE_AUTH_TOKEN) fail("NODE_AUTH_TOKEN is required");
  const candidateSha = process.env.GITHUB_SHA ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const ref = process.env.GITHUB_REF ?? "";
  const releaseVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (!/^[0-9a-f]{40}$/.test(candidateSha)) fail("GITHUB_SHA must be an exact commit SHA");
  if (repository !== "razzant/claudexor") fail("GITHUB_REPOSITORY is not the release repository");
  if (ref !== `refs/tags/v${releaseVersion}`) fail("GITHUB_REF must be the exact release tag");

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const packages = discoverPackages();
  const packed = topological(packages).map((pkg) => ({ pkg, tarball: pack(pkg) }));
  for (const { pkg, tarball } of packed) {
    if (pkg.name === "@claudexor/core") {
      run(
        process.execPath,
        [resolve(root, "scripts/verify-npm-darwin-package.mjs"), "--tarball", tarball],
        root,
      );
    }
  }
  for (const { pkg, tarball } of packed) {
    const bytes = readFileSync(tarball);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const sha512Hex = createHash("sha512").update(bytes).digest("hex");
    const spec = `${pkg.name}@${pkg.version}`;
    const expected = {
      packageName: pkg.name,
      version: pkg.version,
      integrity,
      sha512Hex,
      candidateSha,
      repository,
      workflowPath: RELEASE_WORKFLOW_PATH,
      ref,
    };
    const existing = view(spec);
    if (existing) {
      await verifyPublished(existing, expected, spec, { allowSameSourceRebuild: true });
      console.log(`npm already published with verified provenance: ${spec}`);
      continue;
    }
    run("npm", ["publish", tarball, "--access", "public", "--provenance"], root);
    // npm indexing after publish is eventually consistent and has been
    // observed to lag by MINUTES (v2.1.0 postmortem: a 10s window failed a
    // release whose publish had succeeded, and the burned version could
    // never be re-published). Poll for up to 10 minutes before declaring
    // the publish unexposed.
    let published = null;
    for (let attempt = 0; attempt < 60 && !published; attempt += 1) {
      published = view(spec);
      if (!published) {
        if (attempt % 6 === 5) console.log(`waiting for npm to expose ${spec}…`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 10_000));
      }
    }
    if (!published) fail(`npm did not expose ${spec} after publish`);
    await verifyPublished(published, expected, spec);
    console.log(`npm published with provenance: ${spec}`);
  }
  verifyRegistrySignatures(packed);
}

function discoverPackages() {
  const found = new Map();
  for (const directory of readdirSync(join(root, "packages"))) {
    const path = join(root, "packages", directory, "package.json");
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (manifest.private) continue;
    found.set(manifest.name, { ...manifest, directory: join(root, "packages", directory) });
  }
  return found;
}

function topological(packagesByName) {
  const ordered = [];
  const pending = new Map(packagesByName);
  while (pending.size) {
    const ready = [...pending.values()]
      .filter((pkg) =>
        Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).every(
          (name) => !packagesByName.has(name) || !pending.has(name),
        ),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!ready.length) fail(`workspace dependency cycle: ${[...pending.keys()].join(", ")}`);
    for (const pkg of ready) {
      ordered.push(pkg);
      pending.delete(pkg.name);
    }
  }
  return ordered;
}

function pack(pkg) {
  const before = new Set(readdirSync(out));
  run("pnpm", ["pack", "--pack-destination", out], pkg.directory);
  const created = readdirSync(out).filter((file) => file.endsWith(".tgz") && !before.has(file));
  if (created.length !== 1) fail(`expected one tarball for ${pkg.name}, got ${created.join(", ")}`);
  return join(out, created[0]);
}

function view(spec) {
  const result = spawnSync("npm", ["view", spec, "--json"], { cwd: root, encoding: "utf8" });
  if (result.status === 0) return JSON.parse(result.stdout);
  if (/E404|is not in this registry/i.test(result.stderr)) return null;
  fail(`npm view failed for ${spec}: ${lastLine(result.stderr)}`);
}

async function verifyPublished(metadata, expected, spec, { allowSameSourceRebuild = false } = {}) {
  const url = metadata?.dist?.attestations?.url;
  if (typeof url !== "string") fail(`npm provenance is missing for ${spec}`);
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    fail(`npm provenance URL is invalid for ${spec}`);
  }
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "registry.npmjs.org") {
    fail(`npm provenance URL is untrusted for ${spec}`);
  }
  // npm's attestation endpoint is eventually consistent like the version
  // listing (v2.1.1 postmortem: fresh publishes 404 here for minutes while
  // the tarball itself is already served). Poll 404s with the same bounded
  // 10-minute window; any other failure — and a still-missing attestation
  // after the deadline — stays a loud hard failure.
  let response = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    response = await fetch(parsedUrl, { headers: { accept: "application/json" } });
    if (response.status !== 404) break;
    if (attempt % 6 === 5) console.log(`waiting for npm attestations for ${spec}…`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10_000));
  }
  if (!response?.ok) fail(`npm provenance fetch failed for ${spec}: HTTP ${response?.status}`);
  const attestationDocument = await response.json();
  const validation = validatePublishedProvenance({
    metadata,
    attestationDocument,
    allowSameSourceRebuild,
    ...expected,
  });
  if (!validation.ok)
    fail(`npm publication mismatch for ${spec}: ${validation.reasons.join("; ")}`);
}

export function validatePublishedProvenance(input) {
  const reasons = [];
  // v2.1.1 postmortem: package builds are NOT byte-reproducible across CI
  // runs, so a retry can never re-pack the byte-identical tarball an earlier
  // run published — demanding local byte-identity made every retry a lottery
  // and burned the version. For the already-published skip path the
  // security-meaningful anchor is the PROVENANCE: npm's attestation must
  // prove the published bytes were built by THIS repository's release
  // workflow on THIS tag from THIS exact candidate commit, and the SLSA
  // subject must match the PUBLISHED tarball digest. Fresh publishes keep
  // strict local byte-identity.
  const rebuild = input.allowSameSourceRebuild === true;
  if (!rebuild && input.metadata?.dist?.integrity !== input.integrity)
    reasons.push("tarball integrity mismatch");
  if (input.metadata?.["dist-tags"]?.latest !== input.version) {
    reasons.push("latest dist-tag mismatch");
  }
  if (input.metadata?.dist?.attestations?.provenance?.predicateType !== SLSA_PROVENANCE_V1) {
    reasons.push("npm metadata provenance predicate mismatch");
  }
  if (input.ref !== `refs/tags/v${input.version}`)
    reasons.push("release ref is not the version tag");
  const provenance = input.attestationDocument?.attestations?.find(
    (entry) => entry?.predicateType === SLSA_PROVENANCE_V1,
  );
  let statement = null;
  try {
    statement = JSON.parse(
      Buffer.from(provenance?.bundle?.dsseEnvelope?.payload ?? "", "base64").toString("utf8"),
    );
  } catch {
    reasons.push("SLSA provenance payload is invalid");
  }
  if (!provenance) reasons.push("SLSA provenance attestation is missing");
  if (statement?.predicateType !== SLSA_PROVENANCE_V1) {
    reasons.push("SLSA statement predicate mismatch");
  }
  const purlName = input.packageName.startsWith("@")
    ? `%40${input.packageName.slice(1)}`
    : input.packageName;
  const expectedSubject = `pkg:npm/${purlName}@${input.version}`;
  const subjects = Array.isArray(statement?.subject) ? statement.subject : [];
  const distIntegrity = input.metadata?.dist?.integrity ?? "";
  const publishedSha512Hex = distIntegrity.startsWith("sha512-")
    ? Buffer.from(distIntegrity.slice("sha512-".length), "base64").toString("hex")
    : null;
  const requiredSha512 = rebuild ? publishedSha512Hex : input.sha512Hex;
  if (
    subjects.length !== 1 ||
    subjects[0]?.name !== expectedSubject ||
    !requiredSha512 ||
    subjects[0]?.digest?.sha512 !== requiredSha512
  ) {
    reasons.push(
      rebuild
        ? "SLSA subject does not match the published tarball"
        : "SLSA subject does not match the packed tarball",
    );
  }
  const workflow = statement?.predicate?.buildDefinition?.externalParameters?.workflow;
  const repositoryUrl = `https://github.com/${input.repository}`;
  if (
    workflow?.repository !== repositoryUrl ||
    workflow?.path !== input.workflowPath ||
    workflow?.ref !== input.ref
  ) {
    reasons.push("SLSA workflow identity mismatch");
  }
  const dependencies = statement?.predicate?.buildDefinition?.resolvedDependencies;
  const expectedDependency = `git+${repositoryUrl}@${input.ref}`;
  if (
    !Array.isArray(dependencies) ||
    !dependencies.some(
      (dependency) =>
        dependency?.uri === expectedDependency &&
        dependency?.digest?.gitCommit === input.candidateSha,
    )
  ) {
    reasons.push("SLSA source commit mismatch");
  }
  return { ok: reasons.length === 0, reasons };
}

function verifyRegistrySignatures(packed) {
  const auditRoot = join(out, "signature-audit");
  mkdirSync(auditRoot, { recursive: true });
  writeFileSync(
    join(auditRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "claudexor-release-signature-audit",
        version: "0.0.0",
        private: true,
        dependencies: Object.fromEntries(packed.map(({ pkg }) => [pkg.name, `=${pkg.version}`])),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps"],
    auditRoot,
  );
  run("npm", ["audit", "signatures"], auditRoot);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) fail(`${command} ${args[0]} failed: ${lastLine(result.stderr)}`);
  if (result.stdout.trim()) console.log(`${command}: ${basename(result.stdout.trim())}`);
}

function lastLine(value) {
  return (
    String(value ?? "")
      .trim()
      .split("\n")
      .at(-1) ?? "unknown error"
  );
}

function fail(message) {
  console.error(`npm release failed: ${message}`);
  process.exit(1);
}
