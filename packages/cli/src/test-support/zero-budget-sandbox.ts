/**
 * The ONE owned vendor sandbox of the zero-budget diagnostics fixture, created by the test file
 * through `await vi.hoisted(...)`, i.e. before any production module is evaluated: several of them
 * (control-services, request-preflight, orchestrator, ...) capture the projectless root when they
 * load, and the runner resolves it again later, so both must see this HOME. It lives in its own
 * folder under the runner's temp dir, NOT under the suite config dir that vitest.setup.ts reaps at
 * file end even after a timed-out close. Only the keys below are touched; their exact prior values
 * are captured first. The file's last hook restores them, then removes exactly this folder, only
 * when every close of the file returned its tail in time. A close that outlived its deadline leaves
 * both in place for the rest of this worker, so its still-running tail keeps valid paths.
 */
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = [
  "HOME",
  "USERPROFILE",
  "CLAUDEXOR_CLAUDE_BIN",
  "CLAUDEXOR_CODEX_BIN",
  "CLAUDEXOR_CURSOR_BIN",
  "CLAUDEXOR_CLAUDE_NATIVE_DIR",
  "CLAUDEXOR_CODEX_NATIVE_HOME",
] as const;

export function createVendorSandbox() {
  const prior = KEYS.map((key) => [key, process.env[key]] as const);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zero-budget-vendors-")));
  const home = join(root, "home");
  mkdirSync(home);
  // Absolute overrides are exact choices, never a PATH search: no host binary is found or started.
  const absent = (name: string) => join(root, "absent", name);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDEXOR_CLAUDE_BIN = absent("claude");
  process.env.CLAUDEXOR_CODEX_BIN = absent("codex");
  process.env.CLAUDEXOR_CURSOR_BIN = absent("cursor-agent");
  // An inherited native-store override must stay inside an owned root anyway: clear it.
  delete process.env.CLAUDEXOR_CLAUDE_NATIVE_DIR;
  delete process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
  return {
    root,
    home,
    /** Close hooks started whose tail has not yet returned. */
    openCloses: 0,
    /** Puts back exactly the captured values; a key that was unset is unset again. */
    restoreEnv() {
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
