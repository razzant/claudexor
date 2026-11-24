import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

const REQUIRED_PATHS = [
  "bin/claudexor",
  "bin/claudexord",
  "lib/claudexor.bundle.cjs",
  "lib/claudexord.bundle.cjs",
  "lib/setup-login-runner.cjs",
  "lib/run-deadline-warden.cjs",
  "lib/browser-mcp-runtime",
  "node/bin/node",
  "runtime.json",
];

export function normalizedArchiveEntry(raw) {
  const value = raw
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (
    value.length === 0 ||
    raw.includes("\n") ||
    raw.includes("\r") ||
    raw.includes("\0") ||
    raw.startsWith("/") ||
    value.split("/").includes("..")
  ) {
    throw new Error(`unsafe archive entry: ${JSON.stringify(raw)}`);
  }
  return value;
}

export function validateArchiveListings(namesOutput, verboseOutput) {
  const rawNames = namesOutput.split(/\r?\n/).filter(Boolean);
  const rawVerbose = verboseOutput.split(/\r?\n/).filter(Boolean);
  if (rawVerbose.length !== rawNames.length) {
    throw new Error("runtime archive listings disagree");
  }
  const isRoot = (name) => name.replaceAll("\\", "/").replace(/\/+$/, "") === ".";
  if (rawNames.filter(isRoot).length > 1) {
    throw new Error("runtime archive contains duplicate root entries");
  }
  for (const row of rawVerbose) {
    // Both bsdtar and GNU tar put the entry type in the first permission
    // character. Check every row, including the optional "./" root entry.
    // Runtime archives deliberately contain only directories and regular
    // files; links, devices, sockets and FIFOs are never valid.
    if (row[0] !== "-" && row[0] !== "d") {
      throw new Error(`runtime archive contains a non-regular entry: ${row}`);
    }
  }
  const keptIndexes = rawNames.map((_, index) => index).filter((index) => !isRoot(rawNames[index]));
  const names = keptIndexes.map((index) => normalizedArchiveEntry(rawNames[index]));
  if (new Set(names).size !== names.length) {
    throw new Error("runtime archive contains duplicate paths");
  }
  for (const required of REQUIRED_PATHS) {
    if (!names.some((name) => name === required || name.startsWith(`${required}/`))) {
      throw new Error(`runtime archive is missing ${required}`);
    }
  }
  return names;
}

export function assertLinkFreeExtractedTree(directory) {
  for (const name of readdirSync(directory)) {
    normalizedArchiveEntry(name);
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`extracted runtime contains a link: ${path}`);
    if (stat.isDirectory()) {
      assertLinkFreeExtractedTree(path);
    } else if (!stat.isFile()) {
      throw new Error(`extracted runtime contains a special file: ${path}`);
    }
  }
}

function isContained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Copy a dependency tree as directories and regular files only. Symlinks are
 * followed only when their real target remains inside the original source
 * root, then materialized at the destination. This preserves pnpm's internal
 * package graph without allowing an external workspace link or archive escape
 * into the remote runtime.
 */
export function copyTreeMaterialized(source, destination) {
  const allowedRoot = realpathSync(source);

  function copyEntry(sourcePath, destinationPath, directoryAncestors) {
    const resolved = realpathSync(sourcePath);
    if (!isContained(allowedRoot, resolved)) {
      throw new Error(`runtime source link escapes its package root: ${sourcePath}`);
    }
    const info = statSync(resolved);
    const mode = info.mode & 0o777;
    if (info.isDirectory()) {
      if (directoryAncestors.has(resolved)) {
        throw new Error(`runtime source contains a directory link cycle: ${sourcePath}`);
      }
      mkdirSync(destinationPath, { mode });
      const nextAncestors = new Set(directoryAncestors);
      nextAncestors.add(resolved);
      for (const name of readdirSync(resolved)) {
        copyEntry(join(resolved, name), join(destinationPath, name), nextAncestors);
      }
      chmodSync(destinationPath, mode);
      return;
    }
    if (!info.isFile()) {
      throw new Error(`runtime source contains a special file: ${sourcePath}`);
    }
    copyFileSync(resolved, destinationPath);
    chmodSync(destinationPath, mode);
  }

  copyEntry(source, destination, new Set());
}

export function remoteRuntimeShellWrapper(body) {
  return `#!/bin/sh
set -eu
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
RUNTIME_DIR=$(CDPATH= cd -- "$SELF_DIR/.." && pwd -P)
export CLAUDEXOR_REMOTE_RUNTIME=1
export PATH="$HOME/.claudexor/remote/vendor/bin:$HOME/.local/bin:$HOME/.cursor/bin:$RUNTIME_DIR/node/bin:$PATH"
${body}
`;
}

export function validateNodeBinaryTarget(path, target) {
  const header = readFileSync(path).subarray(0, 32);
  const [platform, arch] = target.split("-");
  if (platform === "linux") {
    if (
      header.length < 20 ||
      !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      header[4] !== 2 ||
      header[5] !== 1
    ) {
      throw new Error("bundled Node is not a little-endian 64-bit ELF binary");
    }
    const machine = header.readUInt16LE(18);
    const expected = arch === "x64" ? 62 : arch === "arm64" ? 183 : -1;
    if (machine !== expected) {
      throw new Error(`bundled Node ELF architecture ${machine} does not match ${target}`);
    }
    return;
  }
  if (platform === "darwin") {
    if (header.length < 8 || header.readUInt32LE(0) !== 0xfeedfacf) {
      throw new Error("bundled Node is not a little-endian 64-bit Mach-O binary");
    }
    const cpu = header.readUInt32LE(4);
    const expected = arch === "x64" ? 0x01000007 : arch === "arm64" ? 0x0100000c : 0;
    if (cpu !== expected) {
      throw new Error(`bundled Node Mach-O architecture ${cpu} does not match ${target}`);
    }
    return;
  }
  throw new Error(`unsupported runtime target ${target}`);
}
