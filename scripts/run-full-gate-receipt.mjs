#!/usr/bin/env node
/**
 * Run the full deterministic release gate (`pnpm release:verify`) and write
 * the hash-bound receipt the release attestation embeds: before/after git
 * identity (candidate must be clean and UNCHANGED by the gate), exit code,
 * and stdout/stderr digests. The receipt is the ONLY input the sealer trusts
 * about the gate — it never re-runs or re-interprets the gate itself.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const outDir = resolve(process.argv[2] ?? "");
if (!outDir || process.argv.length > 3) {
  console.error("usage: run-full-gate-receipt.mjs OUT_DIR");
  process.exit(2);
}
if (existsSync(join(outDir, "full-gate-receipt.json"))) {
  console.error("full-gate receipt already exists; gate evidence is never overwritten");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true, mode: 0o700 });

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const gitState = () => ({
  head: git("rev-parse", "HEAD"),
  tree: git("rev-parse", "HEAD^{tree}"),
  status: git("status", "--porcelain"),
});

const before = gitState();
if (before.status !== "") {
  console.error("candidate worktree is dirty; commit or stash before running the gate");
  process.exit(1);
}

const stdoutPath = join(outDir, "full-gate.stdout.log");
const stderrPath = join(outDir, "full-gate.stderr.log");
const program = "pnpm";
const argv = ["pnpm", "release:verify"];
console.log(`running ${argv.join(" ")} (receipt: ${outDir})`);
const run = spawnSync(argv[0], argv.slice(1), {
  encoding: "utf8",
  maxBuffer: 512 * 1024 * 1024,
});
writeFileSync(stdoutPath, run.stdout ?? "", { mode: 0o600 });
writeFileSync(stderrPath, run.stderr ?? "", { mode: 0o600 });
const exitCode = run.status ?? 1;

const after = gitState();
const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const receipt = {
  program,
  argv,
  exitCode,
  candidateUnchanged:
    before.head === after.head && before.tree === after.tree && after.status === "",
  before,
  after,
  stdout: { path: stdoutPath, sha256: sha256File(stdoutPath) },
  stderr: { path: stderrPath, sha256: sha256File(stderrPath) },
  finishedAt: new Date().toISOString(),
};
writeFileSync(join(outDir, "full-gate-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
  mode: 0o600,
});
console.log(
  `full gate exit ${exitCode}; candidateUnchanged=${receipt.candidateUnchanged}; receipt sealed`,
);
process.exit(exitCode === 0 && receipt.candidateUnchanged ? 0 : 1);
