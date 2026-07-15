#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function verifyReleaseAssetNames(expectedNames, remoteNames, phase) {
  if (phase !== "before" && phase !== "after") {
    return { ok: false, reasons: [`unknown verification phase: ${phase}`] };
  }
  const expected = normalizedSet(expectedNames, "expected");
  const remote = normalizedSet(remoteNames, "remote");
  const reasons = [...expected.reasons, ...remote.reasons];
  if (!expected.names.size) reasons.push("expected release asset set is empty");

  for (const name of remote.names) {
    if (!expected.names.has(name)) reasons.push(`unexpected remote release asset: ${name}`);
  }
  if (phase === "after") {
    for (const name of expected.names) {
      if (!remote.names.has(name)) reasons.push(`missing remote release asset: ${name}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function normalizedSet(values, label) {
  const names = new Set();
  const reasons = [];
  for (const raw of values) {
    const name = String(raw).trim();
    if (!name) continue;
    if (name !== basename(name) || name === "." || name === "..") {
      reasons.push(`invalid ${label} release asset name: ${name}`);
      continue;
    }
    if (names.has(name)) reasons.push(`duplicate ${label} release asset name: ${name}`);
    names.add(name);
  }
  return { names, reasons };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`invalid argument: ${key ?? ""}`);
    options[key.slice(2)] = value;
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
  const phase = options.phase;
  const expectedDirectory = resolve(options["expected-dir"] ?? "");
  const remoteManifest = resolve(options["remote-manifest"] ?? "");
  if (!phase || !options["expected-dir"] || !options["remote-manifest"]) {
    fail(
      "usage: verify-release-assets.mjs --phase before|after --expected-dir DIR --remote-manifest FILE",
    );
  }
  const expectedNames = readdirSync(expectedDirectory).filter((name) =>
    statSync(resolve(expectedDirectory, name)).isFile(),
  );
  const remoteNames = readFileSync(remoteManifest, "utf8").split("\n");
  const result = verifyReleaseAssetNames(expectedNames, remoteNames, phase);
  if (!result.ok) fail(result.reasons.join("; "));
  process.stdout.write(
    `Release asset set verified (${phase}): expected=${expectedNames.length}, remote=${remoteNames.filter(Boolean).length}\n`,
  );
}

function fail(message) {
  console.error(`Release asset verification failed: ${message}`);
  process.exit(1);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
