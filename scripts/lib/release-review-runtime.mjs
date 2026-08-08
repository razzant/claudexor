import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  RELEASE_REVIEW_CLI_ARTIFACT_PATH,
  RELEASE_REVIEW_RUNTIME_ARTIFACT_PATHS,
  RELEASE_REVIEW_VERIFIER_ARTIFACT_PATH,
  pathIsWithin,
  validateReleaseReviewRuntimeArtifacts,
} from "./release-review-contract.mjs";

const REQUIRED_VERIFIER_EXPORTS = Object.freeze([
  "containsSecretLikeToken",
  "parseSealedReviewEnvelopeDetailed",
  "redactSecrets",
  "sealedReviewTranscriptFromEvents",
  "validateFullGateReceipt",
  "verifySealedEvidencePacket",
  "writeEvidencePacket",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function readStableReviewFile(path, label) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error(`${label} is not a regular file`);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      if (before[key] !== after[key]) throw new Error(`${label} changed while it was read`);
    }
    if (bytes.length === 0 || BigInt(bytes.length) !== before.size) {
      throw new Error(`${label} has an invalid byte length`);
    }
    return bytes;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function assertExactCandidateInputs(root, inputs) {
  const candidateRoot = realpathSync(resolve(root));
  for (const input of inputs) {
    const absolute = resolve(candidateRoot, input);
    if (!pathIsWithin(candidateRoot, absolute)) {
      throw new Error(`release review verifier input escapes candidate: ${input}`);
    }
    const repoPath = relative(candidateRoot, absolute).split(sep).join("/");
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(absolute) !== absolute) {
      throw new Error(`release review verifier input is not a regular tracked file: ${repoPath}`);
    }
    let committed;
    try {
      committed = execFileSync("git", ["-C", candidateRoot, "show", `HEAD:${repoPath}`], {
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      throw new Error(`release review verifier input is not tracked at HEAD: ${repoPath}`);
    }
    if (!readFileSync(absolute).equals(committed)) {
      throw new Error(`release review verifier input differs from HEAD: ${repoPath}`);
    }
  }
}

function smokeVerifierApi(bytes) {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`;
  const script = [
    `const runtime = await import(${JSON.stringify(moduleUrl)});`,
    `const expected = ${JSON.stringify(REQUIRED_VERIFIER_EXPORTS)};`,
    "const actual = Object.keys(runtime).sort();",
    "if (JSON.stringify(actual) !== JSON.stringify(expected) || expected.some((name) => typeof runtime[name] !== 'function')) process.exit(1);",
  ].join("\n");
  try {
    execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      maxBuffer: 1024 * 1024,
      stdio: "pipe",
    });
  } catch {
    throw new Error("release review verifier bundle failed its exact API smoke");
  }
}

/** Build the real verifier graph without executing or trusting its output. */
export async function bundleReleaseReviewVerifier(repoRoot, outfile) {
  const root = realpathSync(resolve(repoRoot));
  const entryPath = join(root, "scripts/lib/release-review-runtime-entry.ts");
  const verifierPath = resolve(outfile ?? join(root, RELEASE_REVIEW_VERIFIER_ARTIFACT_PATH));
  const { build } = await import("esbuild");
  const result = await build({
    absWorkingDir: root,
    alias: {
      "@claudexor/core": join(root, "packages/core/src/diff.ts"),
      "@claudexor/schema": join(root, "packages/schema/src/index.ts"),
      "@claudexor/util": join(root, "packages/util/src/index.ts"),
    },
    bundle: true,
    entryPoints: [entryPath],
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    metafile: true,
    outfile: verifierPath,
    platform: "node",
    sourcemap: false,
    target: ["node20"],
    treeShaking: true,
    write: false,
  });
  const output = Object.values(result.metafile.outputs).find(
    (record) => resolve(root, record.entryPoint ?? "") === entryPath,
  );
  if (!output) throw new Error("release review verifier bundle has no entrypoint metadata");
  if (JSON.stringify([...output.exports].sort()) !== JSON.stringify(REQUIRED_VERIFIER_EXPORTS)) {
    throw new Error("release review verifier bundle has an unexpected export surface");
  }
  const forbiddenImports = output.imports.filter(
    (entry) => !entry.external || !entry.path.startsWith("node:"),
  );
  if (forbiddenImports.length > 0) {
    throw new Error(
      `release review verifier bundle is not self-contained: ${forbiddenImports
        .map((entry) => entry.path)
        .join(", ")}`,
    );
  }
  const outputFile = result.outputFiles?.find((file) => resolve(file.path) === verifierPath);
  if (!outputFile || outputFile.contents.length === 0) {
    throw new Error("release review verifier bundle emitted no bytes");
  }
  return { contents: outputFile.contents, inputs: Object.keys(result.metafile.inputs) };
}

/** Build one tiny verifier and copy the exact packaged candidate CLI beside it. */
export async function buildReleaseReviewRuntimeArtifacts(repoRoot, artifactRoot, candidateSha) {
  const root = realpathSync(resolve(repoRoot));
  const outputRoot = realpathSync(resolve(artifactRoot));
  const verifierPath = join(outputRoot, RELEASE_REVIEW_VERIFIER_ARTIFACT_PATH);
  const cliSource = join(
    root,
    "apps/macos/dist/bundle.noindex/Claudexor.app/Contents/Resources/claudexor.bundle.cjs",
  );
  const cliPath = join(outputRoot, RELEASE_REVIEW_CLI_ARTIFACT_PATH);
  for (const path of [verifierPath, cliPath]) {
    if (existsSync(path))
      throw new Error(`release review runtime artifact already exists: ${path}`);
  }
  if (!/^[0-9a-f]{40}$/.test(candidateSha ?? "")) {
    throw new Error("release review runtime requires the exact candidate SHA");
  }

  const verifier = await bundleReleaseReviewVerifier(root, verifierPath);
  assertExactCandidateInputs(root, verifier.inputs);
  smokeVerifierApi(verifier.contents);

  const cliStat = lstatSync(cliSource);
  if (cliStat.isSymbolicLink() || !cliStat.isFile() || realpathSync(cliSource) !== cliSource) {
    throw new Error("packaged release review CLI is not a canonical regular file");
  }
  const cliBytes = readStableReviewFile(cliSource, "packaged release review CLI");
  if (!cliBytes.includes(Buffer.from(candidateSha))) {
    throw new Error("packaged release review CLI is not stamped with the candidate SHA");
  }

  writeFileSync(verifierPath, verifier.contents, { flag: "wx", mode: 0o600 });
  writeFileSync(cliPath, cliBytes, { flag: "wx", mode: 0o700 });
  return snapshotReleaseReviewRuntimeArtifacts(outputRoot);
}

export function snapshotReleaseReviewRuntimeArtifacts(artifactRoot) {
  const root = realpathSync(resolve(artifactRoot));
  return RELEASE_REVIEW_RUNTIME_ARTIFACT_PATHS.map((path) => {
    const absolute = join(root, path);
    if (!pathIsWithin(root, absolute)) {
      throw new Error(`release review runtime artifact escapes receipt directory: ${path}`);
    }
    const bytes = readStableReviewFile(absolute, `release review runtime artifact ${path}`);
    return { path, bytes: bytes.length, sha256: sha256(bytes) };
  });
}

export function releaseReviewRuntimeArtifactRoot(receiptPath) {
  return realpathSync(dirname(resolve(receiptPath)));
}

export function readVerifiedReleaseReviewRuntime(artifactRoot, expected) {
  const reasons = validateReleaseReviewRuntimeArtifacts(expected);
  if (reasons.length > 0) throw new Error(reasons.join("; "));
  const root = realpathSync(resolve(artifactRoot));
  const artifacts = expected.map((bound) => {
    const absolutePath = join(root, bound.path);
    if (!pathIsWithin(root, absolutePath)) {
      throw new Error(`release review runtime artifact escapes receipt directory: ${bound.path}`);
    }
    const bytes = readStableReviewFile(
      absolutePath,
      `release review runtime artifact ${bound.path}`,
    );
    const actual = { path: bound.path, bytes: bytes.length, sha256: sha256(bytes) };
    if (actual.bytes !== bound.bytes || actual.sha256 !== bound.sha256) {
      throw new Error(`release review runtime artifact drifted after full gate: ${bound.path}`);
    }
    return { ...actual, absolutePath, contents: bytes };
  });
  const verifier = artifacts.find(
    (artifact) => artifact.path === RELEASE_REVIEW_VERIFIER_ARTIFACT_PATH,
  );
  const cli = artifacts.find((artifact) => artifact.path === RELEASE_REVIEW_CLI_ARTIFACT_PATH);
  if (!verifier || !cli) throw new Error("release review runtime artifact pair is incomplete");
  return {
    artifacts: artifacts.map(
      ({ contents: _contents, absolutePath: _absolutePath, ...artifact }) => artifact,
    ),
    verifierBytes: verifier.contents,
    cli: { path: cli.path, bytes: cli.bytes, sha256: cli.sha256, absolutePath: cli.absolutePath },
  };
}
