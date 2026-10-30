#!/usr/bin/env node
// Repository publication scan for CI and release (INV-146): the SAME adapter
// `pr` delivery uses (packages/delivery/src/publication-scan.ts, loaded with
// Node's type stripping before any dependency install), over the outgoing
// commit range (merges and commit messages included), the complete tracked tree
// (attributes committed in it do not apply; the operator's Git configuration
// does) and, for a release, the annotated tag's message. Findings are reported by rule
// and place only; nonzero exit on findings, unavailable or failed scans alike.
//
//   CLAUDEXOR_BETTERLEAKS_PATH=… node scripts/publication-scan.mjs \
//     [--repo .] [--range "<base>..<head>"] [--tree HEAD] [--tag vX.Y.Z]
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describeFindings, scanPublication } from "../packages/delivery/src/publication-scan.ts";
import { locateScanner } from "../packages/delivery/src/publication-scanner-pin.ts";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

const repoRoot = resolve(arg("--repo") ?? ".");
const range = arg("--range")?.trim();
const scanner = locateScanner({ env: process.env, configDir: null });
if (!scanner.ok) {
  console.error(`::error::publication scanner unavailable: ${scanner.reason}`);
  process.exit(1);
}
// A published tag's message leaves with the tag; a lightweight tag has none.
const metadata = [];
const tag = arg("--tag");
if (tag) {
  const git = (...args) =>
    execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: "pipe" });
  try {
    const ref = `refs/tags/${tag}`;
    if (git("cat-file", "-t", ref).trim() === "tag") {
      const object = git("cat-file", "tag", ref);
      const blank = object.indexOf("\n\n");
      metadata.push({
        label: `tag ${tag} message`,
        text: blank >= 0 ? object.slice(blank + 2) : "",
      });
    }
  } catch {
    console.error("::error::publication scan failed: selected release tag cannot be read");
    process.exit(1);
  }
}
const result = await scanPublication({
  scanner: scanner.path,
  repoRoot,
  // An all-zero or empty base (a new branch push) scans what `origin`'s
  // remote-tracking refs do not have; CI fetches origin before this step.
  logOpts: range && !/^0+\.\./.test(range) ? range : "HEAD --not --remotes=origin",
  treeish: arg("--tree") ?? "HEAD",
  metadata,
});
if (result.status === "clean") {
  console.log("publication scan: clean");
} else if (result.status === "findings") {
  console.error(
    `::error::publication scan found ${result.findings.length} potential secret(s): ${describeFindings(result.findings, 50)}`,
  );
  process.exit(1);
} else {
  console.error(`::error::publication scan failed: ${result.reason}`);
  process.exit(1);
}
