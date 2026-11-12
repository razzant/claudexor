import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DiskRetentionReferences } from "@claudexor/daemon";
import { oneShotRuntimeDir } from "@claudexor/util";
import { retentionProjects } from "./retention-projects.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);

const references = {
  projectRoots: [],
  registeredProjectRoots: new Set<string>(),
  protectedProjectRoots: new Set<string>(),
} as unknown as DiskRetentionReferences;

async function inventory() {
  const errors: string[] = [];
  const held = new Set<string>();
  const projects = await retentionProjects(
    references,
    join(oneShotRuntimeDir(), "..", "no-project"),
    new Set(),
    errors,
    undefined,
    held,
  );
  const oneShot = projects.filter((project) => project.root === oneShotRuntimeDir());
  return { errors, held, oneShot };
}

it("holds the shared anchor cleanup while a one-shot store is not a plain directory (#503)", async () => {
  const config = realpathSync(mkdtempSync(join(tmpdir(), "retention-stores-")));
  roots.push(config);
  vi.stubEnv("CLAUDEXOR_CONFIG_DIR", config);
  const store = oneShotRuntimeDir();
  // A moved store: its surviving runs are not inventoried, so the anchors they name stay.
  const moved = join(config, "moved-one-shot");
  mkdirSync(join(moved, "runs"), { recursive: true });
  symlinkSync(moved, store);
  const symlinked = await inventory();
  expect(symlinked.oneShot).toEqual([]);
  expect([...symlinked.held]).toEqual([store]);
  expect(symlinked.errors).toEqual([
    `run store ${join(store, "runs")} kept: not a plain directory`,
  ]);

  rmSync(store);
  mkdirSync(store);
  writeFileSync(join(store, "runs"), "not a run store");
  const file = await inventory();
  expect(file.oneShot).toEqual([]);
  expect([...file.held]).toEqual([store]);

  // A plain store is inventoried as its own namespace and holds nothing.
  rmSync(join(store, "runs"));
  mkdirSync(join(store, "runs"));
  const plain = await inventory();
  expect(plain.held.size).toBe(0);
  expect(plain.errors).toEqual([]);
  expect(plain.oneShot).toEqual([
    {
      root: store,
      runsDir: join(store, "runs"),
      reviewsDir: null,
      keepLastRuns: false,
      namespaceMaintenance: true,
    },
  ]);
});
