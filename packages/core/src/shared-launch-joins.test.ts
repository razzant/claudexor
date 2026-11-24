/**
 * Single flights several runs join launch outside the first caller's run
 * scope (run-deadline/1, `sharedLaunch`): a keyed `SharedRead` acquisition and
 * a program's `--version` probe. Otherwise the child carries the first run's
 * marker (and on Linux enters its cgroup), and that run's stop, settlement or
 * deadline ends a process another run is still waiting on.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineHarnessProgram } from "./program-registry.js";
import { invalidateProgramObservations, observeHarnessProgram } from "./program-observation.js";
import { mintRunScopeMarker } from "./process-scope.js";
import { observeRunOwnedLaunches, spawnRunOwned, withinRunScope } from "./run-spawn.js";
import { SharedRead } from "./shared-read.js";

const roots: string[] = [];
afterEach(() => {
  invalidateProgramObservations();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);

const fakeChild = () => Object.assign(new EventEmitter(), { pid: undefined }) as never;

describe("a single flight joined by two runs", () => {
  it("a keyed SharedRead launches outside both runs' scopes; a null key stays its caller's", async () => {
    const a = mintRunScopeMarker();
    const b = mintRunScopeMarker();
    const launches: Array<{ binary: string; marker: string | undefined; shared?: string }> = [];
    const stop = observeRunOwnedLaunches(({ binary, marker, shared }) =>
      launches.push({ binary, marker, ...(shared ? { shared } : {}) }),
    );
    let finish!: (value: string) => void;
    const reads = new SharedRead<string>();
    let acquired = 0;
    const acquire = () => {
      acquired += 1;
      spawnRunOwned("login-status", [], { env: {} }, { spawnFn: fakeChild });
      return new Promise<string>((resolve) => (finish = resolve));
    };
    try {
      const first = withinRunScope(a, () =>
        reads.read("codex", "profile-1", new AbortController().signal, acquire),
      );
      const second = withinRunScope(b, () =>
        reads.read("codex", "profile-1", new AbortController().signal, acquire),
      );
      await new Promise((resolve) => setImmediate(resolve));
      finish("logged-in");
      expect(await Promise.all([first, second])).toEqual(["logged-in", "logged-in"]);
      expect(acquired, "one flight for both runs").toBe(1);
      // An unkeyed read is never joined: it is its caller's own launch.
      await withinRunScope(a, () =>
        reads.read("codex", null, new AbortController().signal, async () => {
          spawnRunOwned("own-read", [], { env: {} }, { spawnFn: fakeChild });
          return "own";
        }),
      );
    } finally {
      stop();
    }
    expect(launches).toEqual([
      { binary: "login-status", marker: undefined, shared: "shared-read" },
      { binary: "own-read", marker: a },
    ]);
  });

  it("a program's version probe started inside a run launches outside its scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "shared-version-"));
    roots.push(root);
    const bin = join(root, "vendor");
    writeFileSync(bin, `#!/bin/sh\necho 3.1.4\n`, { mode: 0o755 });
    const program = defineHarnessProgram({
      id: "shared-version-fixture",
      overrideEnv: "SHARED_VERSION_FIXTURE_BIN",
      launchers: [{ name: "shared-version-fixture" }],
      installationEnv: [],
      platforms: {},
    });
    const marker = mintRunScopeMarker();
    const launches: Array<{ marker: string | undefined; shared: string | undefined }> = [];
    const stop = observeRunOwnedLaunches(({ binary, marker, shared }) => {
      if (binary === bin) launches.push({ marker, shared });
    });
    try {
      const observed = await withinRunScope(marker, () =>
        observeHarnessProgram(program, { HOME: root }, bin, { fresh: true }),
      );
      expect(observed.program?.version).toBe("3.1.4");
    } finally {
      stop();
    }
    expect(launches).toEqual([{ marker: undefined, shared: "program-version" }]);
  });
});
