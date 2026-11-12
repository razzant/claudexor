#!/usr/bin/env node
import { checkHarnessPrograms } from "./lib/harness-program-freshness.mjs";
import { harnessPrograms } from "../packages/cli/dist/harness-programs.js";
import { newestSource, pickNewest, readVendorBytes } from "../packages/cli/dist/harness-newest.js";
import {
  resolveSelectedProgramAsync,
  resolveHarnessBinary,
  runCapture,
} from "../packages/core/dist/index.js";

// This is a release command, never a daemon task. --sources-only is useful on
// a shared machine where installed vendor programs must remain untouched.
const checks = await checkHarnessPrograms(
  harnessPrograms(),
  {
    newestSource,
    pickNewest,
    readVendorBytes,
    resolveSelectedProgramAsync,
    resolveHarnessBinary,
    runCapture,
    platform: process.platform,
    arch: process.arch,
  },
  { sourcesOnly: process.argv.includes("--sources-only") },
);
for (const check of checks) console.log(JSON.stringify(check));
const counts = Object.fromEntries(
  ["passed", "skipped", "failed"].map((status) => [
    status,
    checks.filter((c) => c.status === status).length,
  ]),
);
console.log(JSON.stringify({ summary: counts }));
if (counts.failed) process.exitCode = 1;
