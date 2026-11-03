/** A run admitted under one CLAUDEXOR_CONFIG_DIR, looked up under another: the BUILT CLI, real
 * daemons and SQLite stores, offline fakes only. */
import { afterEach, expect, it } from "vitest";
import { cli, makeSandbox, type Sandbox } from "./support.js";

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.dispose();
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function engine() {
  const sb = makeSandbox();
  sandboxes.push(sb);
  return sb;
}

function ask(sb: Sandbox) {
  const run = cli(sb, ["ask", "Say hello.", "--harness", "fake-success", "--json"]);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  return run.json() as { runId: string; storeId: string };
}

it("[INV-040:absence-names-its-store] another engine's no such run cannot pass for the run's absence", () => {
  const admitting = engine();
  const other = engine();
  const receipt = ask(admitting);
  expect(receipt.storeId).toBeTruthy();
  const otherStore = ask(other).storeId;
  expect(otherStore).toBeTruthy();
  expect(otherStore).not.toBe(receipt.storeId);

  const foreign = cli(other, ["inspect", receipt.runId, "--json"]);
  expect(foreign.code, foreign.stdout + foreign.stderr).toBe(1);
  const message = `no such run ${receipt.runId} in engine store ${otherStore}`;
  expect(foreign.json()).toEqual({
    runId: receipt.runId,
    ok: false,
    exitCode: 1,
    code: "run_not_found",
    retryable: false,
    context: { storeId: otherStore },
    message,
    error: message,
  });

  const owner = cli(admitting, ["inspect", receipt.runId, "--json"]);
  expect(owner.code, owner.stdout + owner.stderr).toBe(0);
  expect(owner.json()).toMatchObject({ runId: receipt.runId });

  // The store that accepted the run still says only what it retains.
  const missing = cli(admitting, ["inspect", "run-never-admitted", "--json"]);
  expect(missing.code).toBe(1);
  expect(missing.json()).toMatchObject({
    code: "run_not_found",
    context: { storeId: receipt.storeId },
  });
});

it("[INV-040:receipts-name-their-store] each accepted CLI receipt names the store that holds its job", () => {
  const sb = engine();
  const first = ask(sb);
  const retried = cli(sb, ["retry", first.runId, "--json"]);
  expect(retried.code, retried.stdout + retried.stderr).toBe(0);
  expect(retried.json()).toMatchObject({ retryOf: first.runId, storeId: first.storeId });
  const rerun = cli(sb, ["decision", first.runId, "--rerun", "--feedback", "Again.", "--json"]);
  expect(rerun.code, rerun.stdout + rerun.stderr).toBe(0);
  expect(rerun.json()).toMatchObject({ status: "requeued", storeId: first.storeId });
});
