import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  statSync,
  existsSync,
  readFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  defineHarnessProgram,
  observeHarnessProgram,
  invalidateProgramObservations,
  prepareNativeProgram,
  readModelCatalog,
  runDoctor,
  type HarnessAdapter,
} from "@claudexor/core";
import {
  HarnessRunSpec,
  CredentialProfile,
  ConformanceReport,
  ControlHarnessAccountCatalog,
} from "@claudexor/schema";
import { inspectHarness } from "./harness-maintenance.js";
import { accountObservations } from "./account-observations.js";
import { enumerateAccountCatalogs } from "./account-catalog.js";
import { GlobalConfig } from "@claudexor/schema";

const roots: string[] = [];
afterEach(() => {
  accountObservations.invalidate();
  invalidateProgramObservations();
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}, 0);
function fixture(count = 1) {
  const root = mkdtempSync(join(tmpdir(), "catalog-program-"));
  roots.push(root);
  const bin = join(root, "wrapper"),
    versionFile = join(root, "version");
  const counter = join(root, "version-count");
  writeFileSync(bin, `#!/bin/sh\necho x >> '${counter}'\n/bin/cat '${versionFile}'\n`, {
    mode: 0o755,
  });
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
  const profiles = Array.from({ length: count }, (_, i) => ({
    ...profile,
    profile_id: i ? `p${i}` : "a",
    isolation_locator: join(root, `account-${i}`),
  }));
  for (const p of profiles) mkdirSync(p.isolation_locator, { recursive: true });
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
    probeCredentialProfile: async (candidate: CredentialProfile) => ({
      profile_id: candidate.profile_id,
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
    credential_profiles: profiles,
  });
  const catalog = () =>
    enumerateAccountCatalogs({
      observationKey: "models",
      adapter,
      profiles,
      context: { config, quota: { snapshots: [], absences: [] } },
      read: async (candidate) => {
        const read = await readModelCatalog(adapter);
        if (read.status !== "listed") throw new Error("unavailable");
        return ControlHarnessAccountCatalog.parse({
          harnessId: program.id,
          credentialProfileId: candidate.profile_id,
          models: read.models,
          source: "api",
          sourceProgram: read.sourceProgram,
          verifiedAgainst: null,
          observedAt: null,
          provenance: "adapter_models",
        });
      },
    });
  return {
    root,
    program,
    profile,
    calls: () =>
      existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").length : 0,
    refresh: () => observeHarnessProgram(program, undefined, undefined, { fresh: true }),
    inspect: () => inspectHarness(program.id, { program, home: root }),
    bin,
    versionFile,
    setVersion,
    models,
    catalog,
    doctor,
    registry: new Map([[program.id, adapter]]),
  };
}
it("keeps passive wrapper observations until inventory refreshes catalog and readiness", async () => {
  const f = fixture(),
    stat = statSync(f.bin);
  expect((await f.catalog())[0]!.catalog).toMatchObject({
    models: [{ id: "1.0.0" }],
    sourceProgram: { path: f.bin, version: "1.0.0" },
  });
  await f.catalog();
  expect(f.models).toHaveBeenCalledTimes(1);
  expect((await runDoctor(f.registry, { cwd: f.root }))[0]!.reasons).toEqual(["1.0.0"]);
  f.setVersion("2.0.0");
  expect(statSync(f.bin).mtimeMs).toBe(stat.mtimeMs);
  expect((await f.catalog())[0]!.catalog?.sourceProgram?.version).toBe("1.0.0");
  expect(f.calls()).toBe(1);
  await f.inspect();
  expect((await f.catalog())[0]!.catalog).toMatchObject({
    models: [{ id: "2.0.0" }],
    sourceProgram: { path: f.bin, version: "2.0.0" },
  });
  expect((await runDoctor(f.registry, { cwd: f.root }))[0]!.reasons).toEqual(["2.0.0"]);
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
  await f.refresh();
  expect((await f.catalog())[0]!.catalog?.sourceProgram?.version).toBe("2.0.0");
  release([{ id: "old", label: null, context_window: null, routes: null }]);
  expect((await old)[0]!.catalog).toBeNull();
  expect((await f.catalog())[0]!.catalog?.models[0]!.id).toBe("2.0.0");
  expect(f.models).toHaveBeenCalledTimes(2);
});

it("does not replace a newer cached catalog when an older --version call finishes late", async () => {
  const f = fixture();
  const entered = join(f.root, "entered"),
    release = join(f.root, "release");
  writeFileSync(
    f.bin,
    `#!/bin/sh
value=$(/bin/cat '${f.versionFile}')
if [ "$value" = "1.0.0" ]; then
  : > '${entered}'
  while [ ! -f '${release}' ]; do /bin/sleep 0.02; done
fi
echo "$value"
`,
    { mode: 0o755 },
  );
  const old = f.catalog().catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(existsSync(entered)).toBe(true));
    f.setVersion("2.0.0");
    appendFileSync(f.bin, "\n# new file identity\n");
    expect((await f.catalog())[0]!.catalog?.sourceProgram?.version).toBe("2.0.0");
    writeFileSync(release, "release");
    expect(await old).toMatchObject({
      message: "A newer program observation superseded this account read",
    });
    expect((await f.catalog())[0]!.catalog?.sourceProgram?.version).toBe("2.0.0");
    expect(f.models).toHaveBeenCalledTimes(1);
  } finally {
    writeFileSync(release, "release");
    await old;
  }
});

it.each([true, false])(
  "retries program-change rejections but retains real vendor failures (program change: %s)",
  async (changed) => {
    const f = fixture();
    f.models.mockImplementationOnce(async () => {
      if (changed) {
        f.setVersion("2.0.0");
        await f.refresh();
      } else throw new Error("vendor unavailable");
      return [{ id: "old", label: null, context_window: null, routes: null }];
    });
    expect((await f.catalog())[0]!.catalog).toBeNull();
    f.setVersion("1.0.0"); // Restore the original fingerprint; the catalog itself is not refreshed.
    await f.refresh();
    const next = (await f.catalog())[0]!;
    if (changed) expect(next.catalog?.models[0]?.id).toBe("1.0.0");
    else expect(next.catalog).toBeNull();
    expect(f.models).toHaveBeenCalledTimes(changed ? 2 : 1);
  },
);

it("18 accounts share one first version process, zero on a cached listing, and one after entry replacement", async () => {
  const f = fixture(18);
  const first = await f.catalog();
  expect(first).toHaveLength(18);
  expect(first.every((r) => r.catalog?.sourceProgram?.version === "1.0.0")).toBe(true);
  expect(f.calls()).toBe(1);
  expect(f.models).toHaveBeenCalledTimes(18);
  await f.catalog();
  expect(f.calls()).toBe(1);
  expect(f.models).toHaveBeenCalledTimes(18);
  f.setVersion("2.0.0");
  appendFileSync(f.bin, "\n# replacement identity\n");
  expect((await f.catalog()).every((r) => r.catalog?.sourceProgram?.version === "2.0.0")).toBe(
    true,
  );
  expect(f.calls()).toBe(2);
  expect(f.models).toHaveBeenCalledTimes(36);
});
it("a native startup frame refreshes unchanged wrappers for all 18 accounts without a version process", async () => {
  const f = fixture(18);
  await f.catalog();
  f.setVersion("2.0.0");
  expect((await f.catalog())[0]!.catalog?.sourceProgram?.version).toBe("1.0.0");
  const run = await prepareNativeProgram(
    f.program,
    f.bin,
    HarnessRunSpec.parse({ session_id: "s", intent: "explain", prompt: "fixture", cwd: f.root }),
    undefined,
    true,
  );
  run.observeVersion("2.0.0");
  expect((await f.catalog()).every((r) => r.catalog?.sourceProgram?.version === "2.0.0")).toBe(
    true,
  );
  expect(f.calls()).toBe(1);
  f.setVersion("3.0.0");
  await f.inspect();
  run.observeVersion("2.0.0"); // Old run cannot undo newer inventory evidence.
  expect((await f.catalog())[0]!.catalog?.sourceProgram?.version).toBe("3.0.0");
  expect(f.calls()).toBe(2);
});
it("a fresh account read asks again while a passive read shares its pending process", async () => {
  const f = fixture();
  await f.catalog();
  f.setVersion("2.0.0");
  const acquire = vi.fn(async () => "fresh");
  await Promise.all(
    Array.from({ length: 18 }, () =>
      accountObservations.read("refresh", f.profile, acquire, true, f.program),
    ),
  );
  expect(f.calls()).toBe(2);
  expect(acquire).toHaveBeenCalledOnce();
  expect((await f.catalog())[0]!.catalog?.sourceProgram?.version).toBe("2.0.0");
});
