import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeHarnessProgram } from "@claudexor/core";
import { copilot } from "./entry.js";
import { acpCapabilityProfile } from "./manifest.js";
import { acpProbes } from "./probes.js";
import type { acpRunner } from "./run.js";

vi.mock("@claudexor/secrets", async (original) => ({
  ...(await original<object>()),
  resolveSecret: () => "fixture-managed-token",
}));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "acp-program-observation-"));
  roots.push(root);
  const bin = join(root, "wrapper"),
    version = join(root, "version");
  writeFileSync(version, "1.0.0");
  writeFileSync(bin, `#!/bin/sh\n/bin/cat '${version}'\n`, { mode: 0o755 });
  const entry = {
    ...copilot,
    program: {
      ...copilot.program,
      launchers: [{ name: bin }],
      overrideEnv: "CLAUDEXOR_TEST_ACP_OBSERVATION_BIN",
    },
  };
  const profile = acpCapabilityProfile();
  let permission = true;
  let gate: Promise<void> | undefined;
  let entered = false;
  const runner: ReturnType<typeof acpRunner> = {
    async cancel() {},
    async *run(_spec, options) {
      const answer = permission;
      entered = true;
      if (gate) await gate;
      options!.observation!.writePermission = answer;
    },
  };
  return {
    root,
    entry,
    version,
    profile,
    probes: acpProbes(entry, profile, runner),
    setPermission(value: boolean) {
      permission = value;
    },
    setGate(value: Promise<void> | undefined) {
      gate = value;
    },
    entered: () => entered,
  };
}

it("expires paid conformance after a fresh observation of an unchanged wrapper", async () => {
  const f = fixture();
  expect((await f.probes.doctor({ cwd: f.root, conformance: true })).status).toBe("degraded");
  expect(f.profile.access_control.write_mechanism).toBe("tool_policy");
  writeFileSync(f.version, "2.0.0");
  expect((await f.probes.discover()).sourceProgram?.version).toBe("1.0.0");
  expect(f.profile.access_control.write_mechanism).toBe("tool_policy");
  await observeHarnessProgram(f.entry.program, undefined, undefined, { fresh: true });
  const manifest = await f.probes.discover();
  expect(manifest.sourceProgram?.version).toBe("2.0.0");
  expect(manifest.capability_profile?.access_control.write_mechanism).toBe("none");
});

it("does not let a late old paid probe restore the new program's unproven write policy", async () => {
  const f = fixture();
  let release!: () => void;
  f.setGate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const old = f.probes.doctor({ cwd: f.root, conformance: true });
  try {
    await vi.waitFor(() => expect(f.entered()).toBe(true));
    writeFileSync(f.version, "2.0.0");
    f.setPermission(false);
    f.setGate(undefined);
    expect((await f.probes.doctor({ cwd: f.root, conformance: true, fresh: true })).status).toBe(
      "degraded",
    );
    release();
    expect((await old).status).toBe("unavailable");
    expect(f.profile.access_control.write_mechanism).toBe("none");
    expect((await f.probes.discover()).sourceProgram?.version).toBe("2.0.0");
  } finally {
    release();
    await old;
  }
});

it("concurrent first program readers share the observation without invalidating each other", async () => {
  const f = fixture();
  const manifests = await Promise.all(Array.from({ length: 18 }, () => f.probes.discover()));
  expect(manifests.every((m) => m.sourceProgram?.version === "1.0.0")).toBe(true);
});
