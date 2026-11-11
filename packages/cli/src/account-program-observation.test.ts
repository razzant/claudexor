import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  defineHarnessProgram,
  readModelCatalog,
  runDoctor,
  type HarnessAdapter,
} from "@claudexor/core";
import {
  CredentialProfile,
  ConformanceReport,
  ControlHarnessAccountCatalog,
} from "@claudexor/schema";
import { accountObservations } from "./account-observations.js";
import { enumerateAccountCatalogs } from "./account-catalog.js";
import { GlobalConfig } from "@claudexor/schema";

const roots: string[] = [];
afterEach(() => {
  accountObservations.invalidate();
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}, 0);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "catalog-program-"));
  roots.push(root);
  const bin = join(root, "wrapper"),
    versionFile = join(root, "version");
  writeFileSync(bin, `#!/bin/sh\n/bin/cat '${versionFile}'\n`, { mode: 0o755 });
  let version = "1.0.0";
  const setVersion = (next: string) => {
    version = next;
    writeFileSync(versionFile, next);
  };
  setVersion(version);
  const program = defineHarnessProgram({
    id: "catalog-program",
    overrideEnv: "CATALOG_TEST_BIN",
    launchers: [{ name: "catalog-test-missing" }],
    installationEnv: [],
    platforms: {},
  });
  vi.stubEnv("CATALOG_TEST_BIN", bin);
  const profile = CredentialProfile.parse({
    profile_id: "a",
    harness_id: program.id,
    display_name: "A",
    credential_kind: "config_dir_login",
    isolation_locator: root,
  });
  const models = vi.fn(async () => [
    { id: version, label: null, context_window: null, routes: null },
  ]);
  const doctor = vi.fn(async () =>
    ConformanceReport.parse({ harness_id: program.id, status: "ok", reasons: [version] }),
  );
  const adapter = {
    id: program.id,
    program,
    models,
    doctor,
    discover: async () => {
      throw new Error("unused");
    },
    run: async function* () {},
    probeCredentialProfile: async () => ({
      profile_id: "a",
      harness_id: program.id,
      availability: "available" as const,
      verification: "passed" as const,
      verification_source: "local_store" as const,
      detail: "fixture",
      last_verified_at: new Date().toISOString(),
    }),
  } satisfies HarnessAdapter;
  const config = GlobalConfig.parse({
    harnesses: { [program.id]: {} },
    credential_profiles: [profile],
  });
  const catalog = () =>
    enumerateAccountCatalogs({
      observationKey: "models",
      adapter,
      profiles: [profile],
      context: { config, quota: { snapshots: [], absences: [], observations: [] } },
      read: async () => {
        const read = await readModelCatalog(adapter);
        if (read.status !== "listed") throw new Error("unavailable");
        return ControlHarnessAccountCatalog.parse({
          harnessId: program.id,
          credentialProfileId: "a",
          models: read.models,
          source: "api",
          sourceProgram: read.sourceProgram,
          verifiedAgainst: null,
          observedAt: null,
          provenance: "adapter_models",
        });
      },
    });
  return { bin, setVersion, models, catalog, doctor, registry: new Map([[program.id, adapter]]) };
}
it("refreshes a per-account catalog and readiness after a change behind an unchanged wrapper", async () => {
  const f = fixture(),
    stat = statSync(f.bin);
  expect((await f.catalog())[0]!.catalog).toMatchObject({
    models: [{ id: "1.0.0" }],
    sourceProgram: { path: f.bin, version: "1.0.0" },
  });
  await f.catalog();
  expect(f.models).toHaveBeenCalledTimes(1);
  expect((await runDoctor(f.registry, {}))[0]!.reasons).toEqual(["1.0.0"]);
  f.setVersion("2.0.0");
  expect(statSync(f.bin).mtimeMs).toBe(stat.mtimeMs);
  expect((await f.catalog())[0]!.catalog).toMatchObject({
    models: [{ id: "2.0.0" }],
    sourceProgram: { path: f.bin, version: "2.0.0" },
  });
  expect((await runDoctor(f.registry, {}))[0]!.reasons).toEqual(["2.0.0"]);
  expect(f.models).toHaveBeenCalledTimes(2);
  expect(f.doctor).toHaveBeenCalledTimes(2);
});
it("discards a late answer from the old program without replacing the newer account catalog", async () => {
  const f = fixture();
  let release!: (rows: Awaited<ReturnType<typeof f.models>>) => void;
  f.models.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const old = f.catalog();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  f.setVersion("2.0.0");
  expect((await f.catalog())[0]!.catalog?.sourceProgram?.version).toBe("2.0.0");
  release([{ id: "old", label: null, context_window: null, routes: null }]);
  expect((await old)[0]!.catalog).toBeNull();
  expect((await f.catalog())[0]!.catalog?.models[0]!.id).toBe("2.0.0");
  expect(f.models).toHaveBeenCalledTimes(2);
});
