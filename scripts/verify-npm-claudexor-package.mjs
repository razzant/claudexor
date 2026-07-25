#!/usr/bin/env node
import { constants, accessSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [mode, input] = process.argv.slice(2);
if (mode !== "--tarball" || !input) {
  fail("usage: verify-npm-claudexor-package.mjs --tarball FILE");
}

const tarball = resolve(input);
const listing = run("/usr/bin/tar", ["-tvzf", tarball]);
const requiredBins = ["package/bin/claudexor.js", "package/bin/claudexord.js"];
for (const path of requiredBins) {
  const line = listing.split("\n").find((entry) => entry.trimEnd().endsWith(path));
  if (!line) fail(`${basename(tarball)} does not contain ${path}`);
  const permissions = line.trimStart().split(/\s+/, 1)[0] ?? "";
  if (!/^-.{2}x/.test(permissions)) {
    fail(`${path} is not owner-executable in the npm tarball (${permissions || "unknown"})`);
  }
}

const cleanupRoot = mkdtempSync(join(tmpdir(), "claudexor-npm-wrapper-"));
try {
  run("/usr/bin/tar", ["-xzf", tarball, "-C", cleanupRoot]);
  const packageRoot = join(cleanupRoot, "package");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== "claudexor") fail(`unexpected package name: ${manifest.name}`);
  if (manifest.mcpName !== "io.github.razzant/claudexor") {
    fail(`unexpected mcpName: ${manifest.mcpName ?? "missing"}`);
  }
  if (
    manifest.bin?.claudexor !== "bin/claudexor.js" &&
    manifest.bin?.claudexor !== "./bin/claudexor.js"
  ) {
    fail("claudexor bin does not target bin/claudexor.js");
  }
  if (
    manifest.bin?.claudexord !== "bin/claudexord.js" &&
    manifest.bin?.claudexord !== "./bin/claudexord.js"
  ) {
    fail("claudexord bin does not target bin/claudexord.js");
  }
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length !== 1 ||
    manifest.files[0] !== "bin"
  ) {
    fail("published files whitelist must remain exactly ['bin']");
  }
  for (const path of ["bin/claudexor.js", "bin/claudexord.js"]) {
    const file = join(packageRoot, path);
    accessSync(file, constants.X_OK);
    if ((statSync(file).mode & 0o100) === 0) fail(`${path} is not executable`);
  }
  process.stdout.write(
    `Claudexor npm wrapper verified: executable bins and MCP identity (${manifest.version})\n`,
  );
} finally {
  rmSync(cleanupRoot, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) fail(`${basename(command)} failed: ${lastLine(result.stderr)}`);
  return result.stdout ?? "";
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
  console.error(`Claudexor npm package verification failed: ${message}`);
  process.exit(1);
}
