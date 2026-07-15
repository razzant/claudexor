#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (!process.argv.includes("--provenance")) fail("--provenance is mandatory");
if (!process.env.NODE_AUTH_TOKEN) fail("NODE_AUTH_TOKEN is required");

const root = resolve(import.meta.dirname, "..");
const out = resolve(process.env.RUNNER_TEMP ?? "/tmp", "claudexor-npm-release");
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
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  const spec = `${pkg.name}@${pkg.version}`;
  const existing = view(spec);
  if (existing) {
    verifyPublished(existing, integrity, spec);
    console.log(`npm already published with identical provenance: ${spec}`);
    continue;
  }
  run("npm", ["publish", tarball, "--access", "public", "--provenance"], root);
  let published = null;
  for (let attempt = 0; attempt < 5 && !published; attempt += 1) {
    published = view(spec);
    if (!published) await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  if (!published) fail(`npm did not expose ${spec} after publish`);
  verifyPublished(published, integrity, spec);
  console.log(`npm published with provenance: ${spec}`);
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

function verifyPublished(metadata, integrity, spec) {
  if (metadata?.dist?.integrity !== integrity) fail(`npm version collision for ${spec}`);
  if (!metadata?.dist?.attestations?.url) fail(`npm provenance is missing for ${spec}`);
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
