#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const result = spawnSync(
  process.execPath,
  [
    "--max-old-space-size=8192",
    "--expose-gc",
    "--import",
    require.resolve("tsx"),
    join(root, "packages/daemon/src/store/test-support/store-equivalence.ts"),
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: "inherit", env: process.env },
);
if (result.error) throw result.error;
if (result.signal) console.error(`qualification process ended by ${result.signal}`);
process.exitCode = result.status ?? 1;
