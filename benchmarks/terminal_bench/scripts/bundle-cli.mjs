#!/usr/bin/env node
/**
 * Bundle the Claudexor CLI **and its daemon** into TWO self-contained sibling files
 * for the Terminal-Bench agent.
 *
 * Why: the TB agent used to clone the monorepo + `pnpm install` + `tsc` (~30 packages)
 * INSIDE every task container. Under Rosetta that setup routinely blew Harbor's
 * AgentSetupTimeout. Prebuilt files the agent just copies in remove the whole
 * in-container build, so install() is a chmod instead of a multi-minute compile.
 *
 * Why TWO files (not one): agent mode (`claudexor run`, what the TB agent invokes)
 * routes through packages/cli/src/daemon-run.ts `ensureDaemon()`, which — when no
 * daemon is already up — AUTO-STARTS one by spawning a SIBLING file resolved as
 * `new URL("./claudexord.js", import.meta.url)` relative to the running CLI bundle
 * (it `existsSync`-checks that path first). There is deliberately NO in-process
 * `--local` fallback (CLI runs are always daemon-tracked). So the single-file
 * deployment MUST place `claudexord.js` right next to `claudexor-cli.js`, or every
 * daemon-backed run fails with "cannot auto-start the daemon: entry not found".
 *
 * What: esbuild bundles the built CLI entry (packages/cli/dist/cli.js) into
 * benchmarks/terminal_bench/dist/claudexor-cli.js AND the built daemon entry
 * (packages/cli/dist/claudexord.js) into a SIBLING dist/claudexord.js — each with
 * its full workspace dependency tree (ESM, node20 target, node shebang banner). This
 * is the same proven pattern apps/macos/scripts/build-app.sh uses to bundle claudexord
 * for the .app. The sibling relationship is exactly what ensureDaemon resolves.
 *
 *   Prereq: the workspace must be built first (`pnpm build`) so dist/cli.js +
 *           dist/claudexord.js exist.
 *   Run:    node benchmarks/terminal_bench/scripts/bundle-cli.mjs
 *           (or `pnpm bench:bundle` from the repo root)
 *   Verify: node benchmarks/terminal_bench/dist/claudexor-cli.js --version  -> 0.10.0
 *           (claudexord.js is the daemon entry; it is spawned by the CLI, not run by hand)
 *
 * No workspace package pulls in a native (.node) addon, so nothing needs to stay
 * external; if that ever changes, add the offending native module to EXTERNALS below
 * and ship it alongside the bundles.
 */
import { build } from "esbuild";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// scripts/ -> terminal_bench -> benchmarks -> repo root.
const repoRoot = resolve(here, "..", "..", "..");
const distDir = join(repoRoot, "packages", "cli", "dist");
const outDir = join(repoRoot, "benchmarks", "terminal_bench", "dist");

// Two SIBLING bundles. The daemon outfile MUST be named exactly `claudexord.js` and
// land in the SAME dir as the CLI bundle, because ensureDaemon() in daemon-run.ts
// auto-starts it via `new URL("./claudexord.js", import.meta.url)` relative to the
// running CLI bundle. Renaming or relocating either breaks daemon-backed runs.
const TARGETS = [
  { name: "cli", entry: join(distDir, "cli.js"), outfile: join(outDir, "claudexor-cli.js") },
  { name: "daemon", entry: join(distDir, "claudexord.js"), outfile: join(outDir, "claudexord.js") },
];

// Only TRUE native addons belong here; the CLI/daemon tree is pure JS, so this is empty.
const EXTERNALS = [];

for (const { entry } of TARGETS) {
  if (!existsSync(entry)) {
    process.stderr.write(
      `[bundle-cli] ERROR: built entry not found at ${entry}\n` +
        `[bundle-cli] Build the workspace first:  (cd ${repoRoot} && pnpm build)\n`,
    );
    process.exit(1);
  }
}

mkdirSync(outDir, { recursive: true });

for (const { name, entry, outfile } of TARGETS) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile,
    external: EXTERNALS,
    // Each entry (cli.js / claudexord.js) already starts with `#!/usr/bin/env node`,
    // which esbuild hoists to line 1; the banner is emitted right after it. So the
    // banner must NOT repeat the shebang (a second one on line 2 is a syntax error) —
    // it only provides the CJS interop shims an ESM bundle needs under node.
    banner: {
      js: "import { createRequire as __cxCreateRequire } from 'node:module';\nimport { fileURLToPath as __cxFileURLToPath } from 'node:url';\nimport { dirname as __cxDirname } from 'node:path';\nconst require = __cxCreateRequire(import.meta.url);\nconst __filename = __cxFileURLToPath(import.meta.url);\nconst __dirname = __cxDirname(__filename);",
    },
    logLevel: "info",
  }).catch((err) => {
    process.stderr.write(`[bundle-cli] esbuild failed for ${name} (${entry}): ${err?.message ?? err}\n`);
    process.exit(1);
  });

  chmodSync(outfile, 0o755); // shebang + exec bit so it can run as `./<name>.js`
  const bytes = statSync(outfile).size;
  process.stderr.write(`[bundle-cli] wrote ${outfile} (${(bytes / 1024 / 1024).toFixed(2)} MiB)\n`);
}

const cliOut = TARGETS[0].outfile;
const daemonOut = TARGETS[1].outfile;
process.stderr.write(
  `[bundle-cli] sibling daemon ${basename(daemonOut)} sits next to ${basename(cliOut)} — ` +
    `ensureDaemon() resolves \`./claudexord.js\` relative to the CLI bundle and finds it.\n` +
    `[bundle-cli] verify: node ${cliOut} --version  # expect ${repoRoot.includes("Clawdexor") ? "0.10.0" : "the CLI version"}\n`,
);
