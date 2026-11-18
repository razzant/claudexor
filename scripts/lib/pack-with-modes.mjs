/**
 * Pack one workspace package for npm release with BOTH properties the release
 * needs, which no single tool provides:
 *
 * - pnpm pack rewrites `workspace:*` dependency specs to the real versions —
 *   npm pack ships them verbatim, and `npm install` of such a tarball fails —
 *   but pnpm's tarball writer normalizes file modes and strips the
 *   owner-executable bit from dist/native payloads, which the Darwin package
 *   verifier (correctly) refuses.
 * - npm pack preserves the on-disk executable bit but not the specs.
 *
 * So: pack with pnpm, then restore the owner-executable bit on exactly the
 * entries whose SOURCE file in the package directory is owner-executable, by
 * extracting and repacking with the system tar. The manifest bytes pnpm wrote
 * are untouched; only entry modes change, mirroring the source tree.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  process.stderr.write(`pack-with-modes failed: ${message}\n`);
  process.exit(1);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? "signal"}`);
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

/** Pack `packageDir` into `destinationDir`; returns the tarball path. */
export function packWithSourceModes(packageDir, destinationDir, { omitMacMetadata = false } = {}) {
  const pkgDir = resolve(packageDir);
  const out = resolve(destinationDir);
  const before = new Set(readdirSync(out));
  run("pnpm", ["pack", "--pack-destination", out], pkgDir);
  const created = readdirSync(out).filter((f) => f.endsWith(".tgz") && !before.has(f));
  if (created.length !== 1) {
    throw new Error(`expected one tarball from ${pkgDir}, got: ${created.join(", ") || "none"}`);
  }
  const tarball = join(out, created[0]);

  const work = mkdtempSync(join(tmpdir(), "cx-pack-modes-"));
  try {
    run("tar", ["-xzf", tarball, "-C", work]);
    const packageRoot = join(work, "package");
    let restored = 0;
    for (const extracted of walk(packageRoot)) {
      const source = join(pkgDir, relative(packageRoot, extracted));
      let sourceMode;
      try {
        sourceMode = statSync(source).mode;
      } catch {
        continue; // generated during pack; no source mode to mirror
      }
      if ((sourceMode & 0o100) !== 0) {
        chmodSync(extracted, 0o755);
        restored += 1;
      }
    }
    const createArgs = ["-czf", tarball, "-C", work, "package"];
    if (omitMacMetadata && process.platform === "darwin") {
      run("/usr/bin/tar", ["--no-mac-metadata", "--no-xattrs", ...createArgs]);
    } else {
      run("tar", createArgs);
    }
    process.stderr.write(
      `pack-with-modes: ${created[0]} — restored exec bit on ${restored} file(s)\n`,
    );
    return tarball;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// CLI form for workflow steps: --package <dir> --destination <dir>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const pkg = value("--package");
  const destination = value("--destination");
  if (!pkg || !destination) fail("usage: --package <dir> --destination <dir>");
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
  } catch {
    fail("system tar is unavailable");
  }
  try {
    process.stdout.write(`${packWithSourceModes(pkg, destination)}\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
