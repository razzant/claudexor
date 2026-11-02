#!/usr/bin/env node
// Provision the pinned publication scanner (Betterleaks, INV-146).
//
// Explicit setup/build/CI step only: delivery never downloads. Every mode
// checks the official archive and the extracted binary against the pins in
// packages/delivery/src/publication-scanner-pin.ts (read with Node's type
// stripping), through the code `claudexor scanner prepare` ships. An install
// from npm has no scripts/: that command is its entry.
//
//   # the provisioned copy under the config root (the `claudexor scanner prepare`
//   # layout), or one binary at an explicit path, replacing what is there once the
//   # archive is proved (CI, a developer's CLAUDEXOR_BETTERLEAKS_PATH)
//   node scripts/provision-betterleaks.mjs [--dest FILE] [--platform darwin-arm64]
//     [--from-archive FILE]
//   # a distribution's native/ tree (engine resources, per-target SSH runtime)
//   node scripts/provision-betterleaks.mjs --stage NATIVE_DIR --platforms darwin-arm64,darwin-x64
//     [--archives-dir DIR]
//   # after a release signed the staged binaries in place
//   node scripts/provision-betterleaks.mjs --refresh-provenance NATIVE_DIR
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  downloadArchive,
  pinnedRelease,
  provisionAtPath,
  refreshProvenance,
  stagePlatform,
} from "./lib/betterleaks-stage.mjs";
import {
  BETTERLEAKS_VERSION,
  provisionedScannerPath,
  scannerArchiveUrl,
} from "../packages/delivery/src/publication-scanner-pin.ts";
import { provisionScanner } from "../packages/delivery/src/publication-scanner-provision.ts";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

async function archiveFor(key, archivesDir, scratch) {
  const local = archivesDir ? join(archivesDir, pinnedRelease(key).asset) : null;
  return local && existsSync(local) ? local : downloadArchive(key, scratch);
}

const scratch = mkdtempSync(join(tmpdir(), "claudexor-betterleaks-"));
try {
  const refresh = arg("--refresh-provenance");
  const stage = arg("--stage");
  if (refresh) {
    const keys = refreshProvenance(resolve(refresh));
    console.log(`Betterleaks provenance refreshed for ${keys.join(", ") || "no staged platform"}`);
  } else if (stage) {
    const keys = (arg("--platforms") ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);
    if (!keys.length) throw new Error("--stage needs --platforms");
    for (const key of keys) {
      const layout = await stagePlatform(
        key,
        await archiveFor(key, arg("--archives-dir"), scratch),
        resolve(stage),
      );
      console.log(`Betterleaks ${key} staged at ${layout.binary}`);
    }
  } else {
    const key = arg("--platform") ?? `${process.platform}-${process.arch}`;
    const release = pinnedRelease(key);
    const configDir = process.env.CLAUDEXOR_CONFIG_DIR || join(homedir(), ".claudexor");
    const dest = arg("--dest");
    const local = arg("--from-archive");
    const source = local
      ? { kind: "file", path: resolve(local) }
      : { kind: "download", url: scannerArchiveUrl(release) };
    const controller = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => controller.abort());
    if (dest) {
      const placed = await provisionAtPath(key, source, resolve(dest), {
        signal: controller.signal,
      });
      console.log(
        `Betterleaks ${key} provisioned at ${placed.binary} (sha256 ${release.binarySha256})`,
      );
    } else {
      const result = await provisionScanner({
        key,
        release,
        version: BETTERLEAKS_VERSION,
        source,
        dir: dirname(provisionedScannerPath(configDir, release)),
        signal: controller.signal,
      });
      console.log(
        `Betterleaks ${key} ${result.outcome === "prepared" ? "provisioned" : "already provisioned"} at ${result.binary} (sha256 ${release.binarySha256})`,
      );
    }
  }
} catch (error) {
  console.error(`provisioning failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
