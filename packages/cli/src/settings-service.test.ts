import { describe, expect, it } from "vitest";
import { ControlSettingsUpdateRequest } from "@claudexor/schema";
import { applyHarnessSettingsPatches, assertSettingsPatchValid } from "./settings-service.js";

/** The daemon POST /settings validation core (D3/T1#26), tested offline
 * against the codex manifest truth source (static known_models). */
describe("assertSettingsPatchValid", () => {
  it("rejects fake harness ids everywhere they could persist", async () => {
    await expect(
      assertSettingsPatchValid(ControlSettingsUpdateRequest.parse({ primaryHarness: "fake-success" })),
    ).rejects.toThrow(/not a real registered harness/);
    await expect(
      assertSettingsPatchValid(ControlSettingsUpdateRequest.parse({ eligibleHarnesses: ["codex", "fake-implement"] })),
    ).rejects.toThrow(/not a real registered harness/);
    await expect(
      assertSettingsPatchValid(
        ControlSettingsUpdateRequest.parse({ harnesses: { "fake-success": { defaultModel: "fake-model" } } }),
      ),
    ).rejects.toThrow(/not persistable/);
  });

  it("refuses a model outside the harness truth source with the actionable message (HTTP 400 path)", async () => {
    await expect(
      assertSettingsPatchValid(
        ControlSettingsUpdateRequest.parse({ harnesses: { codex: { defaultModel: "ghost-model-9000" } } }),
      ),
    ).rejects.toThrow(/refused defaultModel 'ghost-model-9000'.*truth source: manifest/s);
    // A truth-listed model passes.
    await expect(
      assertSettingsPatchValid(
        ControlSettingsUpdateRequest.parse({ harnesses: { codex: { defaultModel: "gpt-5.5" } } }),
      ),
    ).resolves.toBeUndefined();
  });

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
});

describe("applyHarnessSettingsPatches", () => {
  it("merges real-harness patches and rejects unknown/fake ids", () => {
    const merged = applyHarnessSettingsPatches(
      {},
      { codex: ControlSettingsUpdateRequest.parse({ harnesses: { codex: { enabled: false } } }).harnesses!["codex"]! },
    );
    expect(merged["codex"]?.enabled).toBe(false);
    expect(() => applyHarnessSettingsPatches({}, { "fake-success": { enabled: false } })).toThrow(
      /unknown harness id 'fake-success'/,
    );
  });
});
