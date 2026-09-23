import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { HarnessEvent } from "@claudexor/schema";
import { HarnessRunSpec } from "@claudexor/schema";
import { normalizeEffort, resolveEffort } from "@claudexor/core";
import {
  CLAUDE_EFFORT_SNAPSHOT,
  CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST,
  claudeAdvertisedEffortsForRun,
  claudeEffortClampedEvent,
  claudeEffortIgnoredEvent,
  claudeSnapshotTrustedForVersion,
  parseClaudeEffortHelp,
} from "./effort-probe.js";
import { createClaudeAdapter } from "./index.js";

/** Real `claude --help` shape: the values wrap onto the next line. */
const HELP_2_1_165 = [
  "  --debug [filter]                      Enable debug mode",
  "  --effort <level>                      Effort level for the current session",
  "                                        (low, medium, high, xhigh, max)",
  "  --exclude-dynamic-system-prompt-sections",
].join("\n");

/** The older installed CLI: the SAME flag, one level short. */
const HELP_2_1_89 = [
  "  --debug [filter]                      Enable debug mode",
  "  --effort <level>                      Effort level for the current session",
  "                                        (low, medium, high, max)",
  "  --fallback-model <model>              Fallback model",
].join("\n");

/**
 * The SAME 2.1.165 flag rendered at 40 columns: the vendor's help wraps to the
 * width it is rendered at, which pushes the closing paren three lines below the
 * flag. Captured verbatim from `claude --help` under a 40-column terminal.
 */
const HELP_2_1_165_NARROW = [
  "  --debug [filter]",
  "      Enable debug mode",
  "  --effort <level>",
  "      Effort level for the current",
  "      session (low, medium, high, xhigh,",
  "      max)",
  "  --exclude-dynamic-system-prompt-sections",
].join("\n");

describe("the claude ladder is a property of the INSTALLED binary", () => {
  it("keeps the release snapshot equal to the recorded 2.1.280 help ladder", () => {
    const help = readFileSync(new URL("../fixtures/help-2.1.280.txt", import.meta.url), "utf8");
    expect(CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST).toBe("2.1.280");
    expect(parseClaudeEffortHelp(help)).toEqual(CLAUDE_EFFORT_SNAPSHOT);
  });

  it("finds the list however far the help wraps it, so a narrow terminal does not silently cost the ladder", () => {
    // A truncated window returns null, which falls back to the recorded
    // snapshot — i.e. it would advertise ANOTHER version's ladder, the exact
    // defect this probe exists to remove.
    expect(parseClaudeEffortHelp(HELP_2_1_165_NARROW)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("does not reach past the flag's own block for a paren when --effort documents no values", () => {
    const help = [
      "  --effort <level>",
      "      Effort level for the current session",
      "  --model <model>",
      "      Model for the session (opus, sonnet, haiku)",
    ].join("\n");
    expect(parseClaudeEffortHelp(help)).toBeNull();
  });

  it("ends the block on a SHORT-alias flag too, not just a long one", () => {
    // The regression: the terminator only matched a leading `--`, so a help
    // layout that renders aliases ran past the next flag. Within the eight-line
    // window the LAST parenthesized group then came from `--model`, and
    // `(opus, sonnet, haiku)` is comma-separated lowercase slugs, so it passed as
    // a value list — publishing MODEL NAMES as the effort ladder, live and
    // stamped with the installed version, instead of falling back to the snapshot.
    const help = [
      "  --effort <level>",
      "      Effort level for the current session",
      "  -m, --model <model>",
      "      Model for the session (opus, sonnet, haiku)",
    ].join("\n");
    expect(parseClaudeEffortHelp(help)).toBeNull();
  });

  it("still reads a wrapped value list when the NEXT flag renders a short alias", () => {
    // The terminator must not be so eager that it truncates a legitimate wrap.
    const help = [
      "  --effort <level>",
      "      Effort level for the current session (low, medium,",
      "      high, xhigh, max)",
      "  -m, --model <model>",
      "      Model for the session (opus, sonnet, haiku)",
    ].join("\n");
    expect(parseClaudeEffortHelp(help)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("reads xhigh from a CLI whose --help advertises it (2.1.165)", () => {
    expect(parseClaudeEffortHelp(HELP_2_1_165)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("does NOT invent xhigh on a CLI whose --help omits it (2.1.89)", () => {
    expect(parseClaudeEffortHelp(HELP_2_1_89)).toEqual(["low", "medium", "high", "max"]);
  });

  it("xhigh passes through on a CLI that advertises it", () => {
    const advertised = parseClaudeEffortHelp(HELP_2_1_165);
    expect(advertised).not.toBeNull();
    expect(normalizeEffort("xhigh", advertised ?? [])).toBe("xhigh");
  });

  it("the SAME request sends NO flag on a CLI that does not advertise xhigh — no invented downgrade", () => {
    // The claude ladder is a single vendor list: the installed binary's own
    // `--help` order. A level that list has never seen has no honest position
    // on it (there is no rank table to guess with), so the arg builder sends
    // no flag — the vendor default stands — and preflight disclosure
    // (`governRouteEffort`) tells the user the level went nowhere.
    const advertised = parseClaudeEffortHelp(HELP_2_1_89) ?? [];
    expect(advertised).not.toContain("xhigh");
    expect(normalizeEffort("xhigh", advertised)).toBeNull();
    const check = resolveEffort("xhigh", advertised);
    expect(check.status).toBe("rejected");
    if (check.status !== "rejected") throw new Error("expected a rejection");
    expect(check.message).toContain("low, medium, high, max");
  });

  it("refuses a level the binary's advertised list cannot place, naming this binary's set", () => {
    const advertised = parseClaudeEffortHelp(HELP_2_1_165) ?? [];
    const check = resolveEffort("ultracode", advertised);
    expect(check.status).toBe("rejected");
    if (check.status !== "rejected") throw new Error("expected a rejection");
    // "ultracode" is a Claude Code menu item, not an API effort level.
    expect(check.message).toContain("low, medium, high, xhigh, max");
  });

  it("passes an unranked level through when a future CLI advertises it", () => {
    const help = [
      "  --effort <level>                      Effort level for the current session",
      "                                        (low, high, ludicrous)",
    ].join("\n");
    const advertised = parseClaudeEffortHelp(help) ?? [];
    expect(advertised).toEqual(["low", "high", "ludicrous"]);
    expect(normalizeEffort("ludicrous", advertised)).toBe("ludicrous");
  });
});

describe("the claude effort probe degrades gracefully", () => {
  it("returns null when --help documents no --effort flag at all", () => {
    expect(parseClaudeEffortHelp("  --debug [filter]   Enable debug mode")).toBeNull();
  });

  it("returns null when the --effort line carries no value list", () => {
    expect(parseClaudeEffortHelp("  --effort <level>   Effort level for the session")).toBeNull();
  });

  it("skips a leading annotation and reads the real value list, not the first paren", () => {
    // A vendor annotation BEFORE the list is the trap: `beta` is a well-formed
    // slug, so anchoring on the first `(` published ["beta"] as this binary's
    // whole ladder — a bogus one-level ladder that looks live, instead of the
    // snapshot fallback a failed parse is supposed to produce.
    const help = [
      "  --effort <level>                      Effort level (beta) (low, medium, high, xhigh, max)",
      "  --fallback-model <model>              Fallback model",
    ].join("\n");
    expect(parseClaudeEffortHelp(help)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("skips a TRAILING annotation too, rather than taking the last paren blindly", () => {
    const help = [
      "  --effort <level>                      Effort level (low, medium, high, max) (experimental)",
      "  --fallback-model <model>              Fallback model",
    ].join("\n");
    expect(parseClaudeEffortHelp(help)).toEqual(["low", "medium", "high", "max"]);
  });

  it("returns null when the block's only parenthetical is an annotation", () => {
    // No value list at all: fall back to the snapshot instead of advertising a
    // one-item ladder made of prose.
    const help = [
      "  --effort <level>                      Effort level for the session (beta)",
      "  --fallback-model <model>              Fallback model",
    ].join("\n");
    expect(parseClaudeEffortHelp(help)).toBeNull();
  });

  it("treats a single-token group as an annotation, not a one-level ladder", () => {
    // With no rank table, `(high)` is indistinguishable from `(beta)`; the
    // vendor's real value list has always enumerated, so a lone token falls
    // back to the snapshot instead of publishing a one-level ladder.
    const help = ["  --effort <level>                      Effort level (high)", ""].join("\n");
    expect(parseClaudeEffortHelp(help)).toBeNull();
  });

  it("anchors on the --effort flag TOKEN, not any line containing the substring", () => {
    // `--effort-budget` contains "--effort"; a substring match anchored the
    // parse on the WRONG flag's block and read its parenthetical as the ladder.
    const help = [
      "  --effort-budget <n>                   Token budget for effort (tokens, dollars)",
      "  --effort <level>                      Effort level for the current session",
      "                                        (low, medium, high, xhigh, max)",
    ].join("\n");
    expect(parseClaudeEffortHelp(help)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("a malformed token inside the value list fails the WHOLE parse — codex probe policy", () => {
    // Skipping the token instead would publish a silently NARROWED ladder as
    // live (an over-long or prose token next to real levels), so the parse
    // returns null and the recorded snapshot answers — freshness lost, never
    // capability. Same reviewed policy as the codex `model/list` probe.
    const overlong = [
      `  --effort <level>                      Effort level (low, ${"x".repeat(33)})`,
      "",
    ].join("\n");
    expect(parseClaudeEffortHelp(overlong)).toBeNull();
    const prose = [
      "  --effort <level>                      Effort level for the current session",
      "                                        (low, medium, high, default: high)",
    ].join("\n");
    expect(parseClaudeEffortHelp(prose)).toBeNull();
    const badChars = [
      "  --effort <level>                      Effort level (low, HIGH!, max)",
      "",
    ].join("\n");
    expect(parseClaudeEffortHelp(badChars)).toBeNull();
  });

  it("still skips NON-list parentheticals (annotations) — strictness is per value list", () => {
    // `(beta)` does not enumerate, so it is an annotation, not a malformed
    // list: the real list after it still parses.
    const help = [
      "  --effort <level>                      Effort level (beta) (low, medium, high)",
      "",
    ].join("\n");
    expect(parseClaudeEffortHelp(help)).toEqual(["low", "medium", "high"]);
  });

  it("the snapshot fallback drives arg emission ONLY on the version it was captured from", () => {
    // A failed parse falls back to the snapshot, but the snapshot is another
    // CLI version's recorded --help: it is that binary's truth only on the
    // exact version stamped on it. Same-version fallback keeps the full
    // ladder usable end to end...
    expect(parseClaudeEffortHelp("garbage")).toBeNull();
    expect([...CLAUDE_EFFORT_SNAPSHOT]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const fallback = { levels: CLAUDE_EFFORT_SNAPSHOT, live: false };
    const sameVersion = claudeAdvertisedEffortsForRun(
      fallback,
      `${CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST} (Claude Code)`,
    );
    expect([...sameVersion]).toEqual([...CLAUDE_EFFORT_SNAPSHOT]);
    expect(normalizeEffort("xhigh", sameVersion)).toBe("xhigh");
    // ...while a MISMATCHED installed version distrusts the snapshot: the run
    // ladder is honestly empty, so the normalizer sends NO flag rather than a
    // level another version advertised (INV-105 — an installed 2.1.89 must
    // never be handed the current snapshot's xhigh).
    expect(claudeAdvertisedEffortsForRun(fallback, "2.1.89 (Claude Code)")).toEqual([]);
    expect(normalizeEffort("xhigh", claudeAdvertisedEffortsForRun(fallback, "2.1.89"))).toBeNull();
  });

  it("snapshot trust is exact-version, and an unknown/unparseable version never vouches", () => {
    expect(claudeSnapshotTrustedForVersion("2.1.280")).toBe(true);
    expect(claudeSnapshotTrustedForVersion("2.1.280 (Claude Code)")).toBe(true);
    expect(claudeSnapshotTrustedForVersion("2.1.165")).toBe(false);
    expect(claudeSnapshotTrustedForVersion("2.1.89")).toBe(false);
    // A LONGER dotted token is a different version, not a prefix match.
    expect(claudeSnapshotTrustedForVersion("2.1.280.1")).toBe(false);
    expect(claudeSnapshotTrustedForVersion("2.1.2800")).toBe(false);
    expect(claudeSnapshotTrustedForVersion(null)).toBe(false);
    expect(claudeSnapshotTrustedForVersion("claude (version unknown)")).toBe(false);
  });

  it("a LIVE parse is the binary's own answer — trusted on any version, no gate", () => {
    const live = { levels: parseClaudeEffortHelp(HELP_2_1_89) ?? [], live: true };
    expect([...claudeAdvertisedEffortsForRun(live, "9.9.9")]).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
  });
});

describe("an effort dropped AFTER preflight is disclosed on the run (INV-105)", () => {
  it("claudeEffortIgnoredEvent yields the ignored-settings disclosure exactly when the flag is dropped", () => {
    const advertised = ["low", "medium", "high", "max"] as const; // a 2.1.89-shaped binary
    const dropped = claudeEffortIgnoredEvent(
      { session_id: "s1", effort_hint: "xhigh" },
      advertised,
    );
    expect(dropped?.type).toBe("message");
    expect(dropped?.payload?.["ignored_settings"]).toEqual([
      expect.stringContaining("effort=xhigh"),
    ]);
    expect(
      claudeEffortIgnoredEvent({ session_id: "s1", effort_hint: "max" }, advertised),
    ).toBeNull();
    expect(
      claudeEffortIgnoredEvent({ session_id: "s1", effort_hint: null }, advertised),
    ).toBeNull();
  });

  it("the RUN discloses the drop and sends no --effort flag when the installed ladder is narrower", async () => {
    // Preflight passed `xhigh` against the manifest ladder; the INSTALLED
    // binary the run probes stops at `max` — the run must say so, not silently
    // execute at the vendor default.
    let cliArgs: string[] | undefined;
    const adapter = createClaudeAdapter({
      detectVersion: async () => "2.1.89",
      probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "ok" }),
      probeAuthStatus: async () => ({
        loggedIn: true,
        authed: true,
        authMethod: "claude.ai",
        probeError: null,
      }),
      anthropicApiKey: () => null,
      claudeOAuthToken: () => null,
      probeEffortLevels: async () => ({ levels: ["low", "medium", "high", "max"], live: true }),
      runCliHarness: async function* (options): AsyncGenerator<HarnessEvent> {
        cliArgs = options.args;
        yield {
          type: "completed",
          session_id: options.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });
    const spec = HarnessRunSpec.parse({
      session_id: "claude-effort-drop",
      intent: "implement",
      prompt: "do it",
      cwd: "/repo",
      effort_hint: "xhigh",
      auth_preference: "auto",
    });
    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(spec)) events.push(ev);
    const disclosure = events.find((ev) => Array.isArray(ev.payload?.["ignored_settings"]));
    expect(disclosure?.payload?.["ignored_settings"]).toEqual([
      expect.stringContaining("effort=xhigh"),
    ]);
    expect(cliArgs).toBeDefined();
    expect(cliArgs).not.toContain("--effort");
  });

  const snapshotFallbackAdapter = (installedVersion: string, capture: (args: string[]) => void) =>
    createClaudeAdapter({
      detectVersion: async () => installedVersion,
      probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "ok" }),
      probeAuthStatus: async () => ({
        loggedIn: true,
        authed: true,
        authMethod: "claude.ai",
        probeError: null,
      }),
      anthropicApiKey: () => null,
      claudeOAuthToken: () => null,
      // The C1 shape: the live parse FAILED, so the probe answered with the
      // recorded snapshot (live: false) — which advertises xhigh.
      probeEffortLevels: async () => ({ levels: [...CLAUDE_EFFORT_SNAPSHOT], live: false }),
      runCliHarness: async function* (options): AsyncGenerator<HarnessEvent> {
        capture(options.args);
        yield {
          type: "completed",
          session_id: options.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

  const xhighSpec = (sessionId: string) =>
    HarnessRunSpec.parse({
      session_id: sessionId,
      intent: "implement",
      prompt: "do it",
      cwd: "/repo",
      effort_hint: "xhigh",
      auth_preference: "auto",
    });

  it("a MISMATCHED-version snapshot fallback sends NO --effort flag and discloses the drop (INV-105)", async () => {
    // The confirmed C1 defect: installed 2.1.89, --help parse failed, the
    // 2.1.165 snapshot filled in, and `--effort xhigh` went to a binary that
    // rejects the level. The version gate must drop the flag and say so.
    let cliArgs: string[] | undefined;
    const adapter = snapshotFallbackAdapter("2.1.89 (Claude Code)", (args) => {
      cliArgs = args;
    });
    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(xhighSpec("claude-effort-snapshot-mismatch")))
      events.push(ev);
    expect(cliArgs).toBeDefined();
    expect(cliArgs).not.toContain("--effort");
    expect(cliArgs).not.toContain("xhigh");
    const disclosure = events.find((ev) => Array.isArray(ev.payload?.["ignored_settings"]));
    expect(disclosure?.payload?.["ignored_settings"]).toEqual([
      expect.stringContaining("effort=xhigh"),
    ]);
    expect(disclosure?.payload?.["ignored_settings"]).toEqual([
      expect.stringContaining(CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST),
    ]);
  });

  it("a SAME-version snapshot fallback keeps trusting the snapshot: the flag rides, nothing is disclosed", async () => {
    let cliArgs: string[] | undefined;
    const adapter = snapshotFallbackAdapter(
      `${CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST} (Claude Code)`,
      (args) => {
        cliArgs = args;
      },
    );
    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(xhighSpec("claude-effort-snapshot-same-version")))
      events.push(ev);
    expect(cliArgs).toBeDefined();
    expect(cliArgs).toContain("--effort");
    expect(cliArgs).toContain("xhigh");
    expect(events.find((ev) => Array.isArray(ev.payload?.["ignored_settings"]))).toBeUndefined();
  });
});

describe("an effort the resolution CLAMPED is disclosed too (INV-105) — the codex-symmetric seam", () => {
  const maxCapped = ["low", "medium", "high", "xhigh", "max"] as const; // 2.1.165-shaped binary
  const ladderWithUltra = [...maxCapped, "ultra"] as const; // a rank order that places ultra above max

  it("discloses `ultra` clamped onto `max` when a rank ladder places it above a max-capped binary", () => {
    // The claude-shaped clamp: the binary advertises up to `max`, the rank
    // ladder knows `ultra` sits above it, so resolution clamps ultra -> max —
    // and the seam says so, naming both levels.
    const clamped = claudeEffortClampedEvent(
      { session_id: "s1", effort_hint: "ultra" },
      maxCapped,
      ladderWithUltra,
    );
    expect(clamped?.type).toBe("message");
    expect(clamped?.text).toContain("clamped");
    expect(clamped?.payload?.["ignored_settings"]).toEqual([
      expect.stringContaining("effort=ultra"),
    ]);
    expect(clamped?.payload?.["ignored_settings"]).toEqual([expect.stringContaining("max")]);
    // ...and the SAME inputs make the normalizer send exactly that level, so
    // the disclosure and the flag cannot disagree.
    expect(normalizeEffort("ultra", maxCapped, ladderWithUltra)).toBe("max");
  });

  it("a PASS-THROUGH emits nothing; against the binary's OWN ladder a miss is a DROP, not a clamp", () => {
    // Advertised verbatim: neither seam fires.
    expect(
      claudeEffortClampedEvent({ session_id: "s1", effort_hint: "max" }, maxCapped),
    ).toBeNull();
    expect(
      claudeEffortIgnoredEvent({ session_id: "s1", effort_hint: "max" }, maxCapped),
    ).toBeNull();
    // TODAY'S production shape (two-arg resolution, ladder = the advertised
    // list itself): an unadvertised level cannot clamp — it drops, and the
    // existing DROP seam owns the disclosure. Pinned so the two seams stay
    // mutually exclusive.
    expect(
      claudeEffortClampedEvent({ session_id: "s1", effort_hint: "ultra" }, maxCapped),
    ).toBeNull();
    expect(
      claudeEffortIgnoredEvent({ session_id: "s1", effort_hint: "ultra" }, maxCapped)?.payload?.[
        "ignored_settings"
      ],
    ).toEqual([expect.stringContaining("effort=ultra")]);
    // Nothing requested: nothing to disclose.
    expect(
      claudeEffortClampedEvent({ session_id: "s1", effort_hint: null }, maxCapped, ladderWithUltra),
    ).toBeNull();
  });
});
