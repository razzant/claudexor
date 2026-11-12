import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireHarnessInstallLease } from "./harness-install-lease.js";

describe("harness install lease", () => {
  it("gives a safe manual remedy when a live-looking lock stays busy", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-install-lease-remedy-"));
    const first = acquireHarnessInstallLease(home, 0);
    try {
      expect(() => acquireHarnessInstallLease(home, 0)).toThrow(
        /if this persists after that installer exits, verify no installer is running, remove that exact directory, and retry/,
      );
    } finally {
      first.release();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

it("reclaims a lease after its recorded owner exited, then excludes a second owner", () => {
  const home = mkdtempSync(join(tmpdir(), "claudexor-dead-install-lease-"));
  const owner = spawnSync(process.execPath, ["-e", ""], { env: {}, timeout: 10_000 });
  expect(owner.status).toBe(0);
  const lock = join(home, ".claudexor", "harness-install.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, "owner.json"),
    JSON.stringify({ pid: owner.pid, token: "exited-owner" }),
  );
  let lease: ReturnType<typeof acquireHarnessInstallLease> | undefined;
  try {
    lease = acquireHarnessInstallLease(home, 0);
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid).toBe(process.pid);
    expect(() => acquireHarnessInstallLease(home, 0)).toThrow(/another claudexor harness install/);
    lease.release();
    lease = acquireHarnessInstallLease(home, 0);
  } finally {
    lease?.release();
    rmSync(home, { recursive: true, force: true });
  }
});
