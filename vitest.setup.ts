/**
 * Test hermeticity (DEVELOPMENT.md: tests must never touch real user state).
 *
 * The D7 metrics recorder persists per-harness routing metrics under the
 * Claudexor config dir at attempt settlement; without isolation every
 * `pnpm test` run would write fake-harness EMA samples into the operator's
 * REAL ~/.claudexor (live-caught by the Phase-4 exit-gate critics: 23 junk
 * ids). Point the config dir at a fresh per-run temp dir for the whole
 * suite — any test that needs its own dir still overrides per-test.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

// ALWAYS a fresh temp dir — an inherited CLAUDEXOR_CONFIG_DIR (e.g. a
// developer shell pointing at the real ~/.claudexor) must not become the
// suite sandbox.
const sandboxConfigDir = mkdtempSync(join(tmpdir(), "claudexor-vitest-config-"));
process.env.CLAUDEXOR_CONFIG_DIR = sandboxConfigDir;

// Tests that override the config dir restore it in their own finally; any
// test that FORGOT would otherwise leak its dir (or the real ~/.claudexor,
// after a bare `delete`) into every later test in the worker. Force-restore:
// correct tests already restored to the sandbox value by the time afterEach
// runs, so this is a no-op for them and a fence for the rest.
afterEach(() => {
  process.env.CLAUDEXOR_CONFIG_DIR = sandboxConfigDir;
});
