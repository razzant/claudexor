#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { sealReleaseReviewAttestation } from "./lib/release-review-attestation.mjs";

const argv = process.argv.slice(2);
if (argv.length % 2 !== 0) usage();
const options = {};
for (let index = 0; index < argv.length; index += 2) {
  if (!argv[index].startsWith("--")) usage();
  options[argv[index].slice(2)] = argv[index + 1];
}
for (const name of [
  "packet",
  "packet-manifest-digest",
  "full-gate-receipt",
  "tier1-dir",
  "triad-dir",
  "panel-lock",
  "private-key",
  "authority",
  "out",
]) {
  if (!options[name]) usage(`missing --${name}`);
}

try {
  if (existsSync(options.out) || (options["base64-out"] && existsSync(options["base64-out"]))) {
    throw new Error("attestation output already exists; sealed evidence is never overwritten");
  }
  const attestation = sealReleaseReviewAttestation({
    packetDir: options.packet,
    packetManifestSha256: options["packet-manifest-digest"],
    fullGateReceipt: options["full-gate-receipt"],
    tier1Dir: options["tier1-dir"],
    triadDir: options["triad-dir"],
    panelLock: options["panel-lock"],
    privateKeyPath: options["private-key"],
    authorityPath: options.authority,
  });
  const json = `${JSON.stringify(attestation, null, 2)}\n`;
  atomicWrite(options.out, json, 0o600);
  if (options["base64-out"]) {
    atomicWrite(options["base64-out"], Buffer.from(json.trim(), "utf8").toString("base64"), 0o600);
  }
  console.log(`signed release review attestation sealed: ${options.out}`);
} catch (error) {
  console.error(`release review attestation refused: ${String(error)}`);
  process.exit(1);
}

function atomicWrite(path, data, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  let fd;
  try {
    fd = openSync(temp, "wx", mode);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // Nothing was published.
    }
    throw error;
  }
}

function usage(detail = "") {
  if (detail) console.error(detail);
  console.error(
    "usage: seal-release-review-attestation.mjs --packet DIR --packet-manifest-digest SHA256 --full-gate-receipt FILE --tier1-dir DIR --triad-dir DIR --panel-lock FILE --private-key FILE --authority FILE --out FILE [--base64-out FILE]",
  );
  process.exit(2);
}
