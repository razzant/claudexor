/**
 * The installer installs the EXACT builds this release verified.
 *
 * `harness-installer.test.ts` already pins the WIRING — the disclosure reads
 * each harness package's `vendor-cli-version.ts` rather than a second table.
 * That is alias-shaped and would stay green for any value, including a stale
 * one. This file pins the VALUES, so a model/effort re-record and the bytes
 * `claudexor harness install` fetches can never be bumped apart: the exact
 * vendor version whose catalog and effort ladder were re-captured is the exact
 * version the npm pin resolves.
 *
 * Bumping a pin is therefore a two-line edit here, deliberately — it is the
 * prompt to re-record the hint sets against the same build.
 */
import { describe, expect, it } from "vitest";
import { CLAUDE_VENDOR_CLI_VERSION } from "@claudexor/harness-claude";
import { CODEX_VENDOR_CLI_VERSION } from "@claudexor/harness-codex";
import { harnessInstallerDisclosure } from "./harness-install-recipes.js";

describe("the vendor pins the installer fetches are the verified ones", () => {
  it.each([
    {
      harness: "codex",
      npmPackage: "@openai/codex",
      // codex-cli 0.156.1 — the build whose bundled model catalog and
      // per-model effort ladders are recorded in
      // packages/harness-codex/fixtures/models-0.156.1.json.
      expected: "0.156.1",
      constant: CODEX_VENDOR_CLI_VERSION,
    },
    {
      harness: "claude",
      npmPackage: "@anthropic-ai/claude-code",
      // Claude Code 2.1.280 — the build that shipped claude-opus-5-5 and whose
      // --help ladder is recorded in
      // packages/harness-claude/fixtures/help-2.1.280.txt.
      expected: "2.1.280",
      constant: CLAUDE_VENDOR_CLI_VERSION,
    },
  ] as const)(
    "installs $npmPackage@$expected on both targets from the one $harness constant",
    ({ harness, npmPackage, expected, constant }) => {
      expect(constant).toBe(expected);
      for (const target of ["local", "remote"] as const) {
        const disclosure = harnessInstallerDisclosure(harness, target);
        expect(disclosure.pinnedVersion).toBe(expected);
        expect(disclosure.command).toContain(`${npmPackage}@${expected}`);
        // Only these two claim the freshness gates exercised the exact build.
        expect(disclosure.verification).toBe("release_verified");
      }
    },
  );
});
