/**
 * Test hermeticity (DEVELOPMENT.md: tests must never touch real user state).
 *
 * The routing-metrics recorder persists per-harness routing metrics under the
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
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
// Timeout 0 here and in every per-file W-h reaper (#376): the removal is
// synchronous, so a deadline cannot stop it. It could only fail a removal that
// finished late, skipping the later reapers. A removal that throws still fails
// the file; a hook that closes resources first keeps its deadline.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
// WHY the 0: this hook is synchronous, so vitest's timer cannot interrupt it;
// it measures the hook only after it returns and then fails the file if the
// deletion took the global 10 s hookTimeout or more, after every test passed
// and with the directories already gone. 0 disables only this hook's timer
// (vitest runs a hook with timeout <= 0 untimed); no other hook or limit changes.
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
}, 0);

// ALWAYS a fresh temp dir — an inherited CLAUDEXOR_CONFIG_DIR (e.g. a
// developer shell pointing at the real ~/.claudexor) must not become the
// suite sandbox.
const sandboxConfigDir = reapMk(join(tmpdir(), "claudexor-vitest-config-"));
process.env.CLAUDEXOR_CONFIG_DIR = sandboxConfigDir;

// Tests that override the config dir restore it in their own finally; any
// test that FORGOT would otherwise leak its dir (or the real ~/.claudexor,
// after a bare `delete`) into every later test in the worker. Force-restore:
// correct tests already restored to the sandbox value by the time afterEach
// runs, so this is a no-op for them and a fence for the rest.
afterEach(() => {
  process.env.CLAUDEXOR_CONFIG_DIR = sandboxConfigDir;
});
