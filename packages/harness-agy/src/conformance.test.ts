import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  streamExpectationViolations,
  validateTypedStream,
  type FixtureStreamExpectations,
} from "@claudexor/core";
import { parse as parseYaml } from "yaml";
import { parseAgyEvent } from "./parse.js";
import { agyPlatformIsolationDetail } from "./index.js";
import { AGY_CAPABILITY_PROFILE } from "./index.js";
import { needsPrivatePerProfileKeychain, needsScopedHomeKeychainBridge } from "@claudexor/core";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
/** W3.8: per-fixture STREAM SEMANTICS expectations, declared next to the
 * fixture's provenance and asserted through the one core owner. */
const manifest = parseYaml(readFileSync(join(FIXTURES, "manifest.yaml"), "utf8")) as {
  fixtures: Record<string, { expectations?: FixtureStreamExpectations }>;
};

describe("agy adapter conformance fixtures", () => {
  for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"))) {
    it(`parses ${name} into a conformant typed stream`, () => {
      const events = readFileSync(join(FIXTURES, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => parseAgyEvent(JSON.parse(line), "ses-fixture") ?? []);
      const stats = validateTypedStream(events);
      const expectations = manifest.fixtures[name]?.expectations;
      expect(expectations, `manifest expectations missing for ${name}`).toBeTruthy();
      expect(streamExpectationViolations(events, expectations!)).toEqual([]);
      // Every DONE tool result carries a status (never statusless: the
      // conformance stat the engine's tool-hygiene fold depends on).
      expect(stats.statuslessToolResults).toBe(0);
      if (name === "basic-run.jsonl" || name === "schema-envelope-run.jsonl") {
        expect(stats.started).toBe(1);
        expect(stats.toolCalls).toBeGreaterThan(0);
        expect(stats.toolResults).toBeGreaterThan(0);
        // EXACTLY one usage event — the terminal aggregate. The fixtures prove
        // per-step usages sum to it, so a second emission doubles every token.
        expect(stats.usageEvents).toBe(1);
        expect(stats.errors).toBe(0);
      }
      if (name === "error-auth.jsonl") {
        // The real vendor auth-timeout terminal: exit 0 + ERROR envelope must
        // surface as a typed error, never an empty success (PLAN §1.2 F6).
        expect(stats.errors).toBe(1);
        expect(stats.messages).toBe(0);
      }
      if (name === "fragment-error-run.jsonl") {
        // Synthetic: fragments concatenate exactly (whitespace and repeats kept)
        // to the vendor response, which stays retained evidence beside one
        // typed error carrying the vendor's own status and words.
        const fragments = events
          .filter((e) => e.type === "message" && e.payload?.["delta"] === true)
          .map((e) => e.text)
          .join("");
        const evidence = events.filter(
          (e) => e.type === "message" && e.payload?.["buffered"] === true,
        );
        expect(evidence.map((e) => e.text)).toEqual([fragments]);
        expect(fragments).toBe("Checking the file.\nhaha done\n");
        expect(stats.errors).toBe(1);
        expect(events.find((e) => e.type === "error")?.payload?.["vendor_failure"]).toEqual({
          code: "ERROR",
          message: "synthetic terminal failure after streamed text",
          source: "agy_result",
        });
      }
      if (name.startsWith("session-resume")) {
        // The vendor conversation id is surfaced for INV-137 lane resume.
        const started = events.find((e) => (e as { type?: string }).type === "started") as
          { payload?: Record<string, unknown> } | undefined;
        expect(started?.payload?.["native_session_id"]).toBeTruthy();
      }
    });
  }
});

describe("agy platform credential disclosure", () => {
  it("declares Darwin's private keychain alongside the vendor file fallback", () => {
    const darwin = AGY_CAPABILITY_PROFILE.auth.credential_transports.filter((transport) =>
      transport.platforms?.includes("darwin"),
    );
    expect(darwin.map((transport) => transport.kind)).toEqual(["config_file", "os_keychain"]);
    expect(needsPrivatePerProfileKeychain(AGY_CAPABILITY_PROFILE, "darwin")).toBe(true);
    expect(needsScopedHomeKeychainBridge(AGY_CAPABILITY_PROFILE, "darwin")).toBe(false);
  });

  it("derives Windows OS-user scope and cardinality from the capability profile", () => {
    const detail = agyPlatformIsolationDetail("win32");
    expect(detail).toContain("os_keychain");
    expect(detail).toContain("current OS user");
    expect(detail).toContain("maximum 1 enabled binding");
  });

  it("keeps Darwin proven and Linux explicitly unproven", () => {
    expect(agyPlatformIsolationDetail("darwin")).toBeNull();
    expect(agyPlatformIsolationDetail("linux")).toContain("config_file");
    expect(agyPlatformIsolationDetail("linux")).toContain("unverified");
  });
});
