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
const {
  applyHarnessSettingsPatches,
  assertSettingsPatchValid,
  assertRoutingGoalTiersConsistent,
  commitSettingsUpdate,
} = await import("./settings-service.js");
const { loadConfig, updateGlobalConfig } = await import("@claudexor/config");

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

  it("assertRoutingGoalTiersConsistent discriminates the unroutable quality/zero-tier combo", () => {
    const oneTier = ControlSettingsUpdateRequest.parse({
      qualityTiers: { implement: [[{ harness: "codex", model: "gpt-5.5", effort: "high" }]] },
    }).qualityTiers!;
    const emptyTiers = ControlSettingsUpdateRequest.parse({}).qualityTiers ?? {};
    expect(() => assertRoutingGoalTiersConsistent("quality", emptyTiers)).toThrow(
      /quality routing requires at least one configured quality tier/,
    );
    expect(() => assertRoutingGoalTiersConsistent("quality", oneTier)).not.toThrow();
    expect(() => assertRoutingGoalTiersConsistent("auto", emptyTiers)).not.toThrow();
  });

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

describe("commitSettingsUpdate atomic validate+write (A-1 TOCTOU race)", () => {
  const oneTierPatch = () =>
    ControlSettingsUpdateRequest.parse({
      qualityTiers: { implement: [[{ harness: "codex", model: "gpt-5.5", effort: "high" }]] },
    });

  /** Run `fn` against a FRESH isolated config dir seeded with `seedRouting`. */
  async function withSeededConfig(
    seedRouting: { goal: "auto" | "economy" | "quality"; qualityTiers: unknown },
    fn: (root: string) => Promise<void>,
  ): Promise<void> {
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    const dir = reapMk(join(tmpdir(), "claudexor-settings-race-"));
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    try {
      updateGlobalConfig((cfg) => ({
        ...cfg,
        routing: {
          ...cfg.routing,
          goal: seedRouting.goal,
          quality_tiers: seedRouting.qualityTiers as typeof cfg.routing.quality_tiers,
        },
      }));
      // The repo root only supplies (absent) project config; global config lives
      // in the isolated dir above.
      await fn(dir);
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    }
  }

  it("two concurrent writes can never persist quality-with-zero-tiers", async () => {
    await withSeededConfig(
      { goal: "auto", qualityTiers: oneTierPatch().qualityTiers },
      async (root) => {
        // A flips the goal to quality (valid against the seed: the tier is still
        // present). B clears the tiers (valid against the seed: the goal is still
        // auto). Fired together, B validates the STALE auto snapshot but commits
        // AFTER A — the exact A-1 interleaving. Before the fix this persisted
        // quality-with-zero-tiers; the under-lock re-validation now refuses it.
        const results = await Promise.allSettled([
          commitSettingsUpdate(
            root,
            ControlSettingsUpdateRequest.parse({ routingGoal: "quality" }),
          ),
          commitSettingsUpdate(root, ControlSettingsUpdateRequest.parse({ qualityTiers: {} })),
        ]);
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        // Exactly one writer is refused — the one whose commit would have left the
        // invalid final combination — with the typed config_error.
        expect(rejected).toHaveLength(1);
        expect(rejected[0]!.reason).toMatchObject({ status: 400, code: "config_error" });
        // The persisted config is ALWAYS a valid combination.
        const final = loadConfig(root).global.routing;
        const tierCount = Object.values(final.quality_tiers).reduce(
          (n, list) => n + (list?.length ?? 0),
          0,
        );
        expect(final.goal === "quality" && tierCount === 0).toBe(false);
      },
    );
  });

  it("a lone valid write still persists (fix does not over-refuse)", async () => {
    // Seed already carries a tier, so flipping the goal to quality is valid and
    // must persist — the atomic re-check must not reject a legitimate write.
    await withSeededConfig(
      { goal: "auto", qualityTiers: oneTierPatch().qualityTiers },
      async (root) => {
        await commitSettingsUpdate(
          root,
          ControlSettingsUpdateRequest.parse({ routingGoal: "quality" }),
        );
        const final = loadConfig(root).global.routing;
        expect(final.goal).toBe("quality");
        expect(Object.keys(final.quality_tiers)).toContain("implement");
      },
    );
  });
});
