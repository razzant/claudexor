#!/usr/bin/env node
import { constants, accessSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const helperRelativePath = "dist/native/claudexor-process-identity";
const builtIndexRelativePath = "dist/process-identity.js";
const tarHelperPath = `package/${helperRelativePath}`;

const [mode, input] = process.argv.slice(2);
if (!((mode === "--built-package" || mode === "--tarball") && input)) {
  fail("usage: verify-npm-darwin-package.mjs (--built-package DIR | --tarball FILE)");
}
if (process.platform !== "darwin") fail("Darwin package verification requires a macOS runner");

let packageRoot;
let cleanupRoot = null;
if (mode === "--built-package") {
  packageRoot = resolve(input);
} else {
  const tarball = resolve(input);
  const listing = run("/usr/bin/tar", ["-tvzf", tarball]);
  const helperLine = listing.split("\n").find((line) => line.trimEnd().endsWith(tarHelperPath));
  if (!helperLine) fail(`${basename(tarball)} does not contain ${tarHelperPath}`);
  const permissions = helperLine.trimStart().split(/\s+/, 1)[0] ?? "";
  if (!/^-.{2}x/.test(permissions)) {
    fail(
      `${tarHelperPath} is not owner-executable in the npm tarball (${permissions || "unknown"})`,
    );
  }
  cleanupRoot = mkdtempSync(join(tmpdir(), "claudexor-npm-darwin-"));
  run("/usr/bin/tar", ["-xzf", tarball, "-C", cleanupRoot]);
  packageRoot = join(cleanupRoot, "package");
}

try {
  const helper = join(packageRoot, helperRelativePath);
  accessSync(helper, constants.X_OK);
  if ((statSync(helper).mode & 0o100) === 0) fail(`${helperRelativePath} is not executable`);

  const architectures = new Set(run("/usr/bin/lipo", ["-archs", helper]).trim().split(/\s+/));
  if (!architectures.has("arm64") || !architectures.has("x86_64")) {
    fail(`${helperRelativePath} is not a universal arm64+x86_64 binary`);
  }

  const moduleUrl = `${pathToFileURL(join(packageRoot, builtIndexRelativePath)).href}?smoke=${Date.now()}`;
  const { ProcessIdentityService } = await import(moduleUrl);
  const observed = new ProcessIdentityService().read(process.pid);
  if (
    observed.status !== "known" ||
    observed.platform !== "darwin" ||
    observed.source !== "proc_pidinfo"
  ) {
    fail(
      `ProcessIdentityService.read(process.pid) did not use proc_pidinfo (${observed.status}/${observed.source ?? observed.reason ?? "unknown"})`,
    );
  }
  process.stdout.write(
    `Darwin npm package verified: universal executable helper and proc_pidinfo identity (${mode.slice(2)})\n`,
  );
} finally {
  if (cleanupRoot) rmSync(cleanupRoot, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    fail(`${basename(command)} failed: ${lastLine(result.stderr)}`);
  }
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
  console.error(`Darwin npm package verification failed: ${message}`);
  process.exit(1);
}
