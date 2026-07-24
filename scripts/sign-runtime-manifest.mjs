#!/usr/bin/env node
/**
 * Sign an engine-runtime-update manifest with the OFFLINE Ed25519 key (D-2).
 *
 * Mirrors seal-owner-review-attestation.mjs conventions: the private key is an
 * external 0600 file the owner keeps off CI, the script refuses to sign a
 * manifest with any unset/placeholder field, self-checks with the exact verifier
 * every consumer runs, and never overwrites sealed output.
 *
 * The candidate release workflow builds the closure + an UNSIGNED manifest
 * (build-runtime-closure.mjs). The owner runs THIS script on a trusted machine,
 * pointing --sha256 at the exact promoted-artifact digest so a signature can
 * only ever bind the artifact the owner verified. The publish workflow then
 * checks byte-identity of the signed manifest against the built closure.
 *
 * usage:
 *   sign-runtime-manifest.mjs \
 *     --in       "$RUNNER_TEMP/runtime-closure/runtime-manifest.json"  (unsigned) \
 *     --sha256   <64 hex of the promoted claudexor-runtime-<v>.tar.gz> \
 *     --private-key ~/.claudexor/keys/runtime-update-ed25519.pem \
 *     --authority   release/runtime-update-authority.json \
 *     --out         runtime-manifest.signed.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import {
  runtimeArchiveName,
  signRuntimeManifest,
  verifyRuntimeManifest,
} from "./lib/runtime-manifest-contract.mjs";

const options = {};
const argv = process.argv.slice(2);
if (argv.length % 2 !== 0) usage();
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i].startsWith("--")) usage();
  options[argv[i].slice(2)] = argv[i + 1];
}
for (const name of ["in", "private-key", "authority", "out"]) {
  if (!options[name]) usage(`missing --${name}`);
}

try {
  if (existsSync(options.out)) {
    throw new Error("signed manifest output already exists; sealed evidence is never overwritten");
  }
  const unsigned = JSON.parse(readFileSync(options.in, "utf8"));
  const authority = JSON.parse(readFileSync(options.authority, "utf8"));

  // The owner-supplied --sha256 binds the signature to the EXACT promoted
  // artifact digest. If the unsigned manifest already carries a sha256 it must
  // match — a divergence means the manifest and the artifact drifted apart.
  if (options.sha256 !== undefined) {
    if (unsigned.sha256 !== undefined && unsigned.sha256 !== options.sha256) {
      throw new Error(
        `--sha256 ${options.sha256} disagrees with the manifest sha256 ${unsigned.sha256}`,
      );
    }
    unsigned.sha256 = options.sha256;
  }
  if (unsigned.archiveName === undefined && typeof unsigned.version === "string") {
    unsigned.archiveName = runtimeArchiveName(unsigned.version);
  }

  const privateKeyPem = readFileSync(options["private-key"], "utf8");
  const signed = signRuntimeManifest(unsigned, privateKeyPem, authority);

  // Belt-and-braces: re-verify the exact object we are about to write.
  const verified = verifyRuntimeManifest(signed, authority);
  if (!verified.ok) {
    throw new Error(`signed manifest fails verification: ${verified.reasons.join("; ")}`);
  }

  atomicWrite(options.out, `${JSON.stringify(signed, null, 2)}\n`);
  console.log(
    `signed runtime manifest sealed: ${options.out}\n` +
      `  version=${signed.version} sha256=${signed.sha256}\n` +
      `  archive=${signed.archiveName} buildSha=${signed.buildSha} keyId=${signed.keyId}`,
  );
} catch (error) {
  console.error(`runtime manifest signing refused: ${String(error)}`);
  process.exit(1);
}

function atomicWrite(path, data) {
  mkdirSync(dirname(path) || ".", { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o644, flag: "wx" });
  execFileSync("mv", [tmp, path]);
}

function usage(detail = "") {
  if (detail) console.error(detail);
  console.error(
    "usage: sign-runtime-manifest.mjs --in UNSIGNED.json [--sha256 HEX] --private-key FILE --authority release/runtime-update-authority.json --out SIGNED.json",
  );
  process.exit(2);
}
