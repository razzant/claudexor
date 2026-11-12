#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { packWithSourceModes } from "./lib/pack-with-modes.mjs";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const out = resolve(process.env.RUNNER_TEMP ?? "/tmp", "claudexor-npm-release");
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
const RELEASE_REPOSITORY = "razzant/claudexor";
const NPM_REGISTRY = "https://registry.npmjs.org/";
const NPM_NOT_FOUND = /E404|is not in this registry/i;
const PUBLISH_RETRY_DELAYS_MS = [15_000, 45_000];
const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
]);
const SIGNATURE_AUDIT_STEPS = [
  ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps"],
  ["audit", "signatures"],
];

// Read-only reconciliation (`--reconcile <selection.json>`). All selected
// versions share one exposure window and no registry read (npm view or
// attestations) starts after it closes. Every read and audit command carries
// its own timeout, so waiting ends within one read timeout of the window, and
// a run that reaches the signature audit adds at most its two command timeouts.
const RECONCILE_EXPOSURE_WINDOW_MS = 10 * 60_000;
const RECONCILE_POLL_MS = 10_000;
const REGISTRY_READ_TIMEOUT_MS = 60_000;
const SIGNATURE_AUDIT_TIMEOUT_MS = 10 * 60_000;
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

async function main() {
  // Any spelling of --reconcile selects the read-only mode, which refuses
  // every argument shape but its own instead of falling through to publishing.
  if (process.argv.slice(2).some((arg) => arg.startsWith("--reconcile"))) {
    process.exitCode = await reconcileNpmPublications(process.argv.slice(2));
    return;
  }
  if (!process.argv.includes("--provenance")) fail("--provenance is mandatory");
  // npm publishes through trusted publishing (GitHub OIDC); no stored token is read.
  const candidateSha = process.env.GITHUB_SHA ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const ref = process.env.GITHUB_REF ?? "";
  const releaseVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const win32ConptySha256 = process.env.CLAUDEXOR_WIN32_CONPTY_SHA256 ?? "";
  if (!/^[0-9a-f]{40}$/.test(candidateSha)) fail("GITHUB_SHA must be an exact commit SHA");
  if (repository !== RELEASE_REPOSITORY) fail("GITHUB_REPOSITORY is not the release repository");
  if (ref !== `refs/tags/v${releaseVersion}`) fail("GITHUB_REF must be the exact release tag");
  if (!/^[0-9a-f]{64}$/.test(win32ConptySha256)) {
    fail("CLAUDEXOR_WIN32_CONPTY_SHA256 must bind the promoted candidate helper");
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const packages = discoverPackages();
  const packed = topological(packages).map((pkg) => ({ pkg, tarball: pack(pkg) }));
  for (const { pkg, tarball } of packed) {
    if (pkg.name === "@claudexor/core") {
      run(
        process.execPath,
        [
          resolve(root, "scripts/verify-npm-darwin-package.mjs"),
          "--tarball",
          tarball,
          "--win32-helper-sha256",
          win32ConptySha256,
        ],
        root,
      );
    }
    if (pkg.name === "claudexor") {
      run(
        process.execPath,
        [resolve(root, "scripts/verify-npm-claudexor-package.mjs"), "--tarball", tarball],
        root,
      );
    }
  }
  smokePackedDelegationBelt(packed, releaseVersion);
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
    try {
      await publishNpmPackage(tarball, expected);
    } catch (error) {
      fail(`${spec}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  verifyRegistrySignatures(packed);
  moveNextChannel(packed);
}

/**
 * `latest` moves by itself — `npm publish` with no `--tag` moves it, and the
 * provenance check above REQUIRES it to have moved. `next` does not, so it is
 * moved here, after every package is published, provenance-verified and
 * signature-audited, so a half-finished release never advertises itself on the
 * channel; `npm dist-tag add` is idempotent, so a retry lands here the same way.
 *
 * The move is attempted, never required. Trusted publishing authorizes `npm
 * publish`, but `npm dist-tag` uses GitHub OIDC only from npm 12.2 and only for
 * trusted-publisher configurations with the opt-in dist-tag permission. When the
 * registry refuses, `next` stays behind with a warning instead of stopping the
 * release before its GitHub Release, which carries the runtime archive that
 * Ouroboros pins (it no longer installs `claudexor@next`).
 */
export function moveNextChannel(packed, spawn = spawnSync) {
  const behind = [];
  for (const { pkg } of packed) {
    const spec = `${pkg.name}@${pkg.version}`;
    const result = spawn("npm", ["dist-tag", "add", spec, "next"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) console.log(`npm next channel now resolves to ${spec}`);
    else behind.push(`${spec}: ${npmFailureText(result.stderr)}`);
  }
  if (behind.length > 0) {
    console.warn(
      `::warning::npm next channel was not moved for ${behind.length} package(s); latest is published.\n${behind.join("\n")}`,
    );
  }
  return behind;
}

/** Install the complete exact tarball set and prove the public daemon wrapper
 * serves the scoped belt BEFORE the first irreversible npm publish. Internal
 * workspace dependencies are supplied by their candidate tarballs in the same
 * install, so this never relies on the version already existing in the registry. */
function smokePackedDelegationBelt(packed, releaseVersion) {
  const smokeRoot = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "cx-publish-belt-")));
  try {
    writeFileSync(
      join(smokeRoot, "package.json"),
      `${JSON.stringify({ name: "claudexor-prepublish-belt", version: "0.0.0", private: true })}\n`,
      { mode: 0o600 },
    );
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--legacy-peer-deps",
        ...packed.map(({ tarball }) => tarball),
      ],
      smokeRoot,
    );
    const home = join(smokeRoot, "home");
    mkdirSync(home, { mode: 0o700 });
    run(
      process.execPath,
      [
        resolve(root, "scripts/smoke-delegation-belt-entry.mjs"),
        "--node",
        process.execPath,
        "--entry",
        join(smokeRoot, "node_modules", ".bin", "claudexord"),
        "--config-root",
        join(home, "config"),
      ],
      root,
      {
        ...process.env,
        HOME: home,
        CLAUDEXOR_ROOT_MODE: "explicit",
        CLAUDEXOR_PLUGIN_VERSION: releaseVersion,
      },
    );
  } finally {
    rmSync(smokeRoot, { recursive: true, force: true });
  }
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
  // pnpm pack (workspace: specs rewritten) + source-mirrored executable bits —
  // neither tool alone provides both; see scripts/lib/pack-with-modes.mjs.
  try {
    return packWithSourceModes(pkg.directory, out);
  } catch (error) {
    fail(`packing ${pkg.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Retry only a named network failure, never an arbitrary npm/auth/provenance error. */
function networkFailure(value) {
  const code =
    value?.error?.code ??
    value?.cause?.code ??
    value?.code ??
    String(value?.stderr ?? "").match(/^npm (?:error|ERR!) code (\S+)/m)?.[1];
  return NETWORK_CODES.has(code);
}

async function view(spec, io, deadline = io.now() + RECONCILE_EXPOSURE_WINDOW_MS) {
  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadline - io.now();
    if (remaining <= 0) throw new Error(`npm view exposure window expired for ${spec}`);
    const result = io.spawn("npm", ["view", spec, "--json"], {
      cwd: root,
      encoding: "utf8",
      timeout: Math.max(1, Math.min(REGISTRY_READ_TIMEOUT_MS, Math.ceil(remaining))),
    });
    if (result.status === 0) return JSON.parse(result.stdout);
    if (NPM_NOT_FOUND.test(result.stderr ?? "")) return null;
    if (!networkFailure(result) || attempt === PUBLISH_RETRY_DELAYS_MS.length) {
      throw new Error(`npm view failed for ${spec}: ${npmFailureText(result.stderr)}`);
    }
    await io.sleep(Math.min(PUBLISH_RETRY_DELAYS_MS[attempt], Math.max(0, deadline - io.now())));
  }
}

/** One packed package, at most three network-only publish attempts. npm versions
 * are immutable: a repeated PUT cannot overwrite accepted bytes. A failed request
 * may nevertheless have landed; re-read before retrying and verify strict original
 * integrity after any attempt. An acknowledgement switches permanently to reads. */
export async function publishNpmPackage(tarball, expected, io = registryIo()) {
  const spec = `${expected.packageName}@${expected.version}`;
  let metadata = await view(spec, io);
  if (metadata) {
    await verifyPublished(metadata, expected, spec, io, { allowSameSourceRebuild: true });
    io.log(`npm already published with verified provenance: ${spec}`);
    return;
  }
  for (let attempt = 0; ; attempt += 1) {
    const result = io.spawn("npm", ["publish", tarball, "--access", "public", "--provenance"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) {
      io.log(`npm publish acknowledged: ${spec}; verifying registry exposure and provenance`);
      break;
    }
    if (!networkFailure(result)) {
      throw new Error(`npm publish failed for ${spec}: ${npmFailureText(result.stderr)}`);
    }
    if (attempt === PUBLISH_RETRY_DELAYS_MS.length) {
      metadata = await view(spec, io);
      if (metadata) break;
      throw new Error(
        `npm publish outcome unresolved for ${spec} after ${attempt + 1} attempts: ${npmFailureText(result.stderr)}`,
      );
    }
    io.log(`npm publish network failure for ${spec}; rechecking before another attempt`);
    await io.sleep(PUBLISH_RETRY_DELAYS_MS[attempt]);
    metadata = await view(spec, io);
    if (metadata) break;
  }
  // An accepted publish must never be repeated merely because indexing lags.
  const deadline = io.now() + RECONCILE_EXPOSURE_WINDOW_MS;
  while (!metadata && io.now() < deadline) {
    metadata = await view(spec, io, deadline);
    if (!metadata) await io.sleep(Math.min(RECONCILE_POLL_MS, Math.max(0, deadline - io.now())));
  }
  if (!metadata) throw new Error(`npm did not expose ${spec} after publish; outcome unresolved`);
  await verifyPublished(metadata, expected, spec, io);
  io.log(`npm published with provenance: ${spec}`);
}

/** Where npm serves a version's signed attestations; only the npm registry itself is trusted. */
function trustedAttestationUrl(metadata) {
  const url = metadata?.dist?.attestations?.url;
  if (typeof url !== "string") return { problem: "npm provenance is missing" };
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { problem: "npm provenance URL is invalid" };
  }
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "registry.npmjs.org") {
    return { problem: "npm provenance URL is untrusted" };
  }
  return { url: parsedUrl };
}

async function verifyPublished(
  metadata,
  expected,
  spec,
  io,
  { allowSameSourceRebuild = false } = {},
) {
  const attestations = trustedAttestationUrl(metadata);
  if (attestations.problem) throw new Error(`${attestations.problem} for ${spec}`);
  const parsedUrl = attestations.url;
  // npm's attestation endpoint is eventually consistent like the version
  // listing (v2.1.1 postmortem: fresh publishes 404 here for minutes while
  // the tarball itself is already served). Poll 404s with the same bounded
  // 10-minute window. Named network failures and temporary HTTP failures are reads
  // only; they never cause another publication. A mismatch is never retried.
  let response = null;
  let networkError;
  let attestationDocument;
  const deadline = io.now() + RECONCILE_EXPOSURE_WINDOW_MS;
  while (io.now() < deadline) {
    try {
      response = await io.fetch(parsedUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(REGISTRY_READ_TIMEOUT_MS, Math.ceil(deadline - io.now()))),
        ),
      });
      if (response.ok) {
        attestationDocument = await response.json();
        break;
      }
      if (![404, 408, 429, 500, 502, 503, 504].includes(response.status)) break;
    } catch (error) {
      // Native fetch reports a closed response body through Undici's socket code.
      // This is a read-only retry, never another npm publish.
      if (
        !networkFailure(error) &&
        error?.cause?.code !== "UND_ERR_SOCKET" &&
        error?.name !== "TimeoutError"
      )
        throw error;
      networkError = error;
      response = null;
    }
    await io.sleep(Math.min(RECONCILE_POLL_MS, Math.max(0, deadline - io.now())));
  }
  if (!response?.ok)
    throw new Error(
      `npm provenance fetch failed for ${spec}: ${response ? `HTTP ${response.status}` : (networkError?.message ?? "unavailable")}`,
    );
  const validation = validatePublishedProvenance({
    ...expected,
    metadata,
    attestationDocument,
    allowSameSourceRebuild,
  });
  if (!validation.ok)
    throw new Error(`npm publication mismatch for ${spec}: ${validation.reasons.join("; ")}`);
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
    signatureAuditManifest(packed.map(({ pkg }) => [pkg.name, pkg.version])),
    { mode: 0o600 },
  );
  for (const step of SIGNATURE_AUDIT_STEPS) run("npm", step, auditRoot);
}

/** A private project depending on exactly these versions, for `npm audit signatures`. */
function signatureAuditManifest(versions) {
  return `${JSON.stringify(
    {
      name: "claudexor-release-signature-audit",
      version: "0.0.0",
      private: true,
      dependencies: Object.fromEntries(versions.map(([name, version]) => [name, `=${version}`])),
    },
    null,
    2,
  )}\n`;
}

/**
 * Continues a stopped publish run without publishing. The selection file names
 * the release identity and the versions to read, each marked with what the
 * stopped run showed: `accepted` (npm acknowledged the publish) or `uncertain`.
 * Selecting a version authorizes reading it and never proves it was published:
 * each one gets the publish path's checks (exposure, signed provenance bound to
 * this repository's release workflow, tag and commit, and the selected original
 * tarball digest when one is given), then the registry signatures of the
 * selected versions and their dependencies are audited. A version npm does not
 * expose stays unresolved, never accepted and never unsent. Nothing is packed,
 * published or moved to a dist-tag, and a package the selection omits gets no
 * verdict. Resolves to the exit code: 0 only when every selected version
 * verified and the audit passed.
 */
export async function reconcileNpmPublications(args, io = registryIo()) {
  let selection;
  let registryArgs;
  try {
    if (args.length !== 2 || args[0] !== "--reconcile") {
      throw new Error("--reconcile takes exactly one selection file and no other argument");
    }
    const publishable = discoverPackages();
    selection = parseSelection(readFileSync(args[1], "utf8"), publishable);
    registryArgs = registryPins(publishable.keys());
  } catch (error) {
    io.error(`npm reconcile refused: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const outcomes = await readSelectedVersions(selection, registryArgs, io);
  let verified = 0;
  for (const entry of selection.packages) {
    const { kind, detail } = outcomes.get(entry);
    if (kind === "verified") verified += 1;
    io.log(
      `npm reconcile: ${entry.name}@${selection.version} (selected as ${entry.prior}) ${kind}: ${detail}`,
    );
  }
  const auditProblem =
    verified === selection.packages.length
      ? auditSelectedSignatures(selection, registryArgs, io)
      : "not run while a selected version is unverified";
  io.log(`npm reconcile: signature audit ${auditProblem ?? "passed"}`);
  const summary = `${verified} of ${selection.packages.length} selected version(s) verified; nothing was published and no dist-tag was moved`;
  if (auditProblem) {
    io.error(`npm reconcile incomplete: ${summary}`);
    return 1;
  }
  io.log(`npm reconcile complete: ${summary}`);
  return 0;
}

function registryIo() {
  return {
    spawn: spawnSync,
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)),
    now: () => performance.now(),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
}

function parseSelection(text, publishable) {
  let selection;
  try {
    selection = JSON.parse(text);
  } catch {
    throw new Error("the selection file is not JSON");
  }
  knownFieldsOnly(selection, "selection", [
    "registry",
    "repository",
    "workflowPath",
    "version",
    "ref",
    "candidateSha",
    "packages",
  ]);
  const { registry, repository, workflowPath, version, ref, candidateSha, packages } = selection;
  const problem =
    (registry !== NPM_REGISTRY && `registry must be ${NPM_REGISTRY}`) ||
    (repository !== RELEASE_REPOSITORY && `repository must be ${RELEASE_REPOSITORY}`) ||
    (workflowPath !== RELEASE_WORKFLOW_PATH && `workflowPath must be ${RELEASE_WORKFLOW_PATH}`) ||
    ((typeof version !== "string" || !EXACT_VERSION.test(version)) &&
      "version must be an exact release version") ||
    (ref !== `refs/tags/v${version}` && "ref must be the version's release tag") ||
    ((typeof candidateSha !== "string" || !/^[0-9a-f]{40}$/.test(candidateSha)) &&
      "candidateSha must be an exact commit SHA") ||
    ((!Array.isArray(packages) || packages.length === 0) &&
      "packages must list at least one package");
  if (problem) throw new Error(`selection ${problem}`);
  const names = new Set();
  packages.forEach((entry, index) => {
    const label = `selection packages[${index}]`;
    knownFieldsOnly(entry, label, ["name", "prior", "integrity"]);
    if (!publishable.has(entry.name)) {
      throw new Error(`${label}.name is not a published package of this checkout`);
    }
    if (names.has(entry.name)) throw new Error(`${label}.name repeats an earlier package`);
    names.add(entry.name);
    if (entry.prior !== "accepted" && entry.prior !== "uncertain") {
      throw new Error(`${label}.prior must be "accepted" or "uncertain"`);
    }
    if (entry.integrity !== undefined && !isSha512Integrity(entry.integrity)) {
      throw new Error(`${label}.integrity must be the original tarball's sha512 integrity`);
    }
  });
  return selection;
}

/** Unknown fields refuse: a misspelled `integrity` must not quietly weaken the check. */
function knownFieldsOnly(value, label, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const unknown = Object.keys(value).find((key) => !fields.includes(key));
  if (unknown !== undefined)
    throw new Error(`${label} has unknown field ${JSON.stringify(unknown)}`);
}

function isSha512Integrity(value) {
  if (typeof value !== "string" || !value.startsWith("sha512-")) return false;
  const digest = Buffer.from(value.slice("sha512-".length), "base64");
  return digest.length === 64 && `sha512-${digest.toString("base64")}` === value;
}

/** The selected registry on every reconcile npm command. npm resolves a scoped
 * package through `@scope:registry` before `registry`, and a command-line value
 * outranks every npmrc, so each scope this checkout publishes under is pinned
 * too; a scope override in an npmrc would otherwise redirect the read. */
function registryPins(packageNames) {
  const scopes = new Set();
  for (const name of packageNames) if (name.startsWith("@")) scopes.add(name.split("/")[0]);
  const scopePins = [...scopes].sort().map((scope) => `--${scope}:registry=${NPM_REGISTRY}`);
  return ["--registry", NPM_REGISTRY, ...scopePins];
}

async function readSelectedVersions(selection, registryArgs, io) {
  const deadline = io.now() + RECONCILE_EXPOSURE_WINDOW_MS;
  const outcomes = new Map(
    selection.packages.map((entry) => [
      entry,
      { kind: "waiting", detail: "the exposure window closed before this version was read" },
    ]),
  );
  let waiting = selection.packages;
  for (let round = 1; ; round += 1) {
    const next = [];
    for (const entry of waiting) {
      if (io.now() < deadline) {
        outcomes.set(entry, await readSelected(entry, selection, registryArgs, deadline, io));
      }
      if (outcomes.get(entry).kind === "waiting") next.push(entry);
    }
    waiting = next;
    const remaining = deadline - io.now();
    if (waiting.length === 0 || remaining <= 0) break;
    if (round % 6 === 0) {
      const specs = waiting.map((entry) => `${entry.name}@${selection.version}`);
      io.log(`waiting for npm to expose ${specs.join(", ")}…`);
    }
    await io.sleep(Math.min(RECONCILE_POLL_MS, remaining));
  }
  for (const entry of waiting) {
    const unknown =
      entry.prior === "accepted"
        ? "selected as accepted: reconcile again later rather than sending it again"
        : "whether the stopped run's request reached npm is unknown";
    const { detail } = outcomes.get(entry);
    outcomes.set(entry, { kind: "unresolved", detail: `${detail}; ${unknown}` });
  }
  return outcomes;
}

async function readSelected(entry, selection, registryArgs, deadline, io) {
  const spec = `${entry.name}@${selection.version}`;
  const viewed = io.spawn("npm", ["view", spec, "--json", ...registryArgs], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: REGISTRY_READ_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (viewed.error) {
    return unresolved(`npm view did not finish (${viewed.error.code ?? viewed.error.message})`);
  }
  if (viewed.status !== 0) {
    return NPM_NOT_FOUND.test(viewed.stderr ?? "")
      ? { kind: "waiting", detail: "npm still did not expose this version when the window closed" }
      : unresolved(`npm view failed: ${npmFailureText(viewed.stderr)}`);
  }
  let metadata;
  try {
    metadata = JSON.parse(viewed.stdout);
  } catch {
    return unresolved("npm view answered without readable metadata");
  }
  const attestations = trustedAttestationUrl(metadata);
  if (attestations.problem) return { kind: "mismatch", detail: attestations.problem };
  // The window bounds the attestation read as well: a slow view can finish
  // after the window closed, and then no further read starts.
  if (io.now() >= deadline) {
    return {
      kind: "waiting",
      detail: "npm served this version, but the window closed before its attestations were read",
    };
  }
  let attestationDocument;
  try {
    const response = await io.fetch(attestations.url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REGISTRY_READ_TIMEOUT_MS),
    });
    if (response.status === 404) {
      return {
        kind: "waiting",
        detail: "npm served this version but not its attestations when the window closed",
      };
    }
    if (!response.ok) return unresolved(`npm attestations answered HTTP ${response.status}`);
    attestationDocument = await response.json();
  } catch (error) {
    return unresolved(`npm attestations were not read (${error?.name ?? "error"})`);
  }
  const { integrity } = entry;
  const validation = validatePublishedProvenance({
    metadata,
    attestationDocument,
    packageName: entry.name,
    version: selection.version,
    integrity,
    sha512Hex:
      integrity && Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex"),
    candidateSha: selection.candidateSha,
    repository: selection.repository,
    workflowPath: selection.workflowPath,
    ref: selection.ref,
    // Without the original digest only the narrower same-source claim is made;
    // nothing is re-packed to stand in for the bytes the stopped run sent.
    allowSameSourceRebuild: integrity === undefined,
  });
  if (!validation.ok) return { kind: "mismatch", detail: validation.reasons.join("; ") };
  return {
    kind: "verified",
    detail: integrity
      ? "the published bytes are the selected original tarball, with matching provenance"
      : "same-source provenance only; no original tarball digest was selected",
  };
}

function unresolved(detail) {
  return { kind: "unresolved", detail };
}

function auditSelectedSignatures(selection, registryArgs, io) {
  const auditRoot = mkdtempSync(join(tmpdir(), "claudexor-npm-reconcile-"));
  try {
    writeFileSync(
      join(auditRoot, "package.json"),
      signatureAuditManifest(selection.packages.map(({ name }) => [name, selection.version])),
      { mode: 0o600 },
    );
    for (const step of SIGNATURE_AUDIT_STEPS) {
      const result = io.spawn("npm", [...step, ...registryArgs], {
        cwd: auditRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: SIGNATURE_AUDIT_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      if (result.error) {
        return `failed: npm ${step[0]} did not finish (${result.error.code ?? result.error.message})`;
      }
      if (result.status !== 0) return `failed: npm ${step[0]}: ${npmFailureText(result.stderr)}`;
    }
    return null;
  } finally {
    rmSync(auditRoot, { recursive: true, force: true });
  }
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) fail(`${command} ${args[0]} failed: ${npmFailureText(result.stderr)}`);
  if (result.stdout.trim()) console.log(`${command}: ${basename(result.stdout.trim())}`);
}

/** npm ends a failed command with a pointer to its debug log, which vanishes with
 * a hosted runner; the cause is in the `npm error` lines above that pointer. */
export function npmFailureText(value) {
  const lines = String(value ?? "")
    .trim()
    .split("\n");
  const errors = lines.filter(
    (line) => /^npm (error|ERR!)/.test(line) && !/A complete log of this run/.test(line),
  );
  return (errors.length > 0 ? errors.join("\n") : lines.at(-1)) || "unknown error";
}

function fail(message) {
  console.error(`npm release failed: ${message}`);
  process.exit(1);
}
