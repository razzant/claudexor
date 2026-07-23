import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControlSettingsUpdateRequest } from "@claudexor/schema";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

// HERMETIC codex stub: the adapter resolves its binary (CLAUDEXOR_CODEX_BIN)
// at MODULE LOAD, and codex discover() hard-requires `--version` to answer.
// Without this stub the suite silently depended on a real codex install —
// green on dev machines, red on CI runners. The manifest truth source
// (static known_models) is what these tests exercise; the stub only answers
// the liveness probes. Env is set BEFORE the dynamic import below so the
// adapter picks it up.
const stubDir = reapMk(join(tmpdir(), "claudexor-codex-stub-"));
const stubBin = join(stubDir, "codex");
writeFileSync(
  stubBin,
  '#!/bin/sh\ncase "$1" in\n  --version) echo "codex-cli 0.0.0-stub" ;;\n  *) exit 1 ;;\nesac\n',
);
chmodSync(stubBin, 0o755);
process.env["CLAUDEXOR_CODEX_BIN"] = stubBin;
const { applyHarnessSettingsPatches, assertSettingsPatchValid } =
  await import("./settings-service.js");

/** The daemon POST /settings validation core, tested offline
 * against the codex manifest truth source (static known_models). */
describe("assertSettingsPatchValid", () => {
  it("rejects fake harness ids everywhere they could persist", async () => {
    await expect(
      assertSettingsPatchValid(
        ControlSettingsUpdateRequest.parse({ primaryHarness: "fake-success" }),
      ),
    ).rejects.toThrow(/not a real registered harness/);
    await expect(
      assertSettingsPatchValid(
        ControlSettingsUpdateRequest.parse({ eligibleHarnesses: ["codex", "fake-implement"] }),
      ),
    ).rejects.toThrow(/not a real registered harness/);
    await expect(
      assertSettingsPatchValid(
        ControlSettingsUpdateRequest.parse({
          harnesses: { "fake-success": { defaultModel: "fake-model" } },
        }),
      ),
    ).rejects.toThrow(/not persistable/);
  });

  it("refuses a model outside the harness truth source with the actionable message (HTTP 400 path)", async () => {
    await expect(
      assertSettingsPatchValid(
        ControlSettingsUpdateRequest.parse({
          harnesses: { codex: { defaultModel: "ghost-model-9000" } },
        }),
      ),
    ).rejects.toThrow(/refused defaultModel 'ghost-model-9000'.*truth source: manifest/s);
    // A truth-listed model passes.
    await expect(
      assertSettingsPatchValid(
        ControlSettingsUpdateRequest.parse({ harnesses: { codex: { defaultModel: "gpt-5.5" } } }),
      ),
    ).resolves.toBeUndefined();
  }, 30_000); // codex discover() spawns the vendor CLI; its startup latency is environmental

  it("refuses an effort outside the declared ladder", async () => {
    // raw-api discovers without a vendor binary and declares NO effort ladder;
    // its discover() only checks key PRESENCE, so a dummy keeps this hermetic.
    const prev = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-test-canary-dummy";
    try {
      await expect(
        assertSettingsPatchValid(
          ControlSettingsUpdateRequest.parse({ harnesses: { "raw-api": { effort: "high" } } }),
        ),
      ).rejects.toThrow(/declares no effort ladder/);
    } finally {
      if (prev === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = prev;
    }
  });

  it("D-9/#22: merged-effective quality routing with zero tiers is a 4xx config_error at write", async () => {
    const emptyTiers = ControlSettingsUpdateRequest.parse({}).qualityTiers ?? {};
    // (a) Patch flips the goal to quality over empty stored tiers → refused.
    await expect(
      assertSettingsPatchValid(ControlSettingsUpdateRequest.parse({ routingGoal: "quality" }), {
        goal: "auto",
        qualityTiers: emptyTiers,
      }),
    ).rejects.toMatchObject({ status: 400, code: "config_error" });
    // (b) Clearing the tiers while quality is already active → refused.
    const oneTier = ControlSettingsUpdateRequest.parse({
      qualityTiers: { implement: [[{ harness: "codex", model: "gpt-5.5", effort: "high" }]] },
    }).qualityTiers!;
    await expect(
      assertSettingsPatchValid(ControlSettingsUpdateRequest.parse({ qualityTiers: {} }), {
        goal: "quality",
        qualityTiers: oneTier,
      }),
    ).rejects.toMatchObject({ status: 400, code: "config_error" });
    // (c) A valid tier set with a quality goal is accepted.
    await expect(
      assertSettingsPatchValid(
        ControlSettingsUpdateRequest.parse({
          routingGoal: "quality",
          qualityTiers: { implement: [[{ harness: "codex", model: "gpt-5.5", effort: "high" }]] },
        }),
        { goal: "auto", qualityTiers: emptyTiers },
      ),
    ).resolves.toBeUndefined();
    // (d) The stored tiers carry the goal even when the patch omits them.
    await expect(
      assertSettingsPatchValid(ControlSettingsUpdateRequest.parse({ routingGoal: "quality" }), {
        goal: "auto",
        qualityTiers: oneTier,
      }),
    ).resolves.toBeUndefined();
  }, 30_000); // codex discover() spawns the vendor CLI to validate the tier route

  it("rejects the retired Active-account patch key at the strict schema (F1: Active removed)", () => {
    // The Active account concept is gone: the per-harness patch no longer
    // accepts activeProfileId, so a strict parse 400s rather than persisting it.
    expect(() =>
      ControlSettingsUpdateRequest.parse({
        harnesses: { codex: { activeProfileId: "ghost-account" } },
      }),
    ).toThrow();
  });
});

describe("applyHarnessSettingsPatches", () => {
  it("merges real-harness patches and rejects unknown/fake ids", () => {
    const merged = applyHarnessSettingsPatches(
      {},
      {
        codex: ControlSettingsUpdateRequest.parse({ harnesses: { codex: { enabled: false } } })
          .harnesses!["codex"]!,
      },
    );
    expect(merged["codex"]?.enabled).toBe(false);
    expect(() => applyHarnessSettingsPatches({}, { "fake-success": { enabled: false } })).toThrow(
      /unknown harness id 'fake-success'/,
    );
  });
});

describe("profileLimitAction (INV-135 auto-switch toggle)", () => {
  it("patches only profile_policy.limit_action and preserves rotation order + headroom", () => {
    const current = {
      codex: {
        ...applyHarnessSettingsPatches({}, { codex: { enabled: true } })["codex"]!,
        profile_policy: {
          limit_action: "fail" as const,
          rotation_eligible: ["work", "personal"],
          headroom_threshold: 0.8,
        },
      },
    };
    const merged = applyHarnessSettingsPatches(current, {
      codex: ControlSettingsUpdateRequest.parse({
        harnesses: { codex: { profileLimitAction: "rotate" } },
      }).harnesses!["codex"]!,
    });
    expect(merged["codex"]?.profile_policy).toEqual({
      limit_action: "rotate",
      rotation_eligible: ["work", "personal"],
      headroom_threshold: 0.8,
    });
    // Absent field keeps the stored action untouched.
    const untouched = applyHarnessSettingsPatches(merged, {
      codex: ControlSettingsUpdateRequest.parse({
        harnesses: { codex: { enabled: false } },
      }).harnesses!["codex"]!,
    });
    expect(untouched["codex"]?.profile_policy.limit_action).toBe("rotate");
  });
});
