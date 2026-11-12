/**
 * Lifetime of the shared `claude --help` capture.
 *
 * The parse is covered in `effort.test.ts`; what is proven here is who OWNS the
 * one capture the whole process shares. A long-lived `claudexord` outlives every
 * individual run, so a memo that records a cancelled run's kill, or a moment when
 * the binary could not be spawned, keeps serving that non-answer forever — and
 * the effort ladder's fallback is a snapshot from ONE CLI version, so the
 * consequence is not staleness but `xhigh` forwarded to a binary that rejects it.
 *
 * These tests drive the real spawn against a stub `claude` on disk, because the
 * hazard lives in the interaction between the memo and the process, not in either
 * one alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `claude --help` as the OLDER installed CLI renders it — one level short of the
 * recorded snapshot, so "read the binary" and "fell back" are distinguishable.
 */
const HELP_2_1_89 = [
  "  --effort <level>                      Effort level for the current session",
  "                                        (low, medium, high, max)",
  "  --fallback-model <model>              Fallback model",
].join("\n");

const LADDER_2_1_89 = ["low", "medium", "high", "max"];

/** A help text that satisfies the readonly consumer's whole required flag set. */
const HELP_READONLY = [
  "  --tools <tools>                       Allowed tools",
  "  --setting-sources <sources>           Setting sources",
  "  --strict-mcp-config                   Only the given MCP config",
  '  --permission-mode <mode>              Permission mode ("plan", "acceptEdits")',
  "  --disable-slash-commands              Disable slash commands",
  "  --no-chrome                           Disable the browser",
].join("\n");

let dir: string;
let bin: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudexor-help-probe-"));
  bin = join(dir, "claude-stub");
  // A fresh module registry per test: both the memo and `BIN` are module state.
  vi.resetModules();
  vi.stubEnv("CLAUDEXOR_CLAUDE_BIN", bin);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

/**
 * Put a stub `claude` where the adapter will look for it. `delaySeconds` keeps the
 * child alive long enough that a cancellation aimed at the shared capture lands
 * DURING it — otherwise a stub that exits instantly could outrun the kill and the
 * test would prove nothing on some runs.
 */
function installStub(help: string, delaySeconds = 0): void {
  const sleep = delaySeconds > 0 ? `sleep ${delaySeconds}\n` : "";
  writeFileSync(bin, `#!/bin/sh\n${sleep}cat <<'CLAUDE_HELP_EOF'\n${help}\nCLAUDE_HELP_EOF\n`);
  chmodSync(bin, 0o755);
}

it("refreshes help after an explicit observation of a changed version behind an unchanged wrapper", async () => {
  const version = join(dir, "version"),
    help = join(dir, "help");
  writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then /bin/cat '${version}'; else /bin/cat '${help}'; fi\n`,
    { mode: 0o755 },
  );
  writeFileSync(version, "1.0.0");
  writeFileSync(help, HELP_2_1_89);
  const { probeClaudeEffortLevels } = await import("./effort-probe.js");
  expect((await probeClaudeEffortLevels()).levels).toEqual(LADDER_2_1_89);
  writeFileSync(version, "2.0.0");
  writeFileSync(help, HELP_2_1_89.replace("high, max", "high, xhigh, max"));
  expect((await probeClaudeEffortLevels()).levels).toEqual(LADDER_2_1_89);
  const { observeHarnessProgram } = await import("@claudexor/core");
  const { CLAUDE_PROGRAM } = await import("./program.js");
  await observeHarnessProgram(CLAUDE_PROGRAM, undefined, undefined, { fresh: true });
  expect((await probeClaudeEffortLevels()).levels).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

describe("the shared --help capture belongs to the process, not to its first caller", () => {
  it("survives the cancellation of the run that happened to ask first", async () => {
    installStub(HELP_2_1_89, 0.5);
    const { CLAUDE_EFFORT_SNAPSHOT, probeClaudeEffortLevels } = await import("./effort-probe.js");

    const cancelled = new AbortController();
    cancelled.abort();
    // The cancelled run gives up its own wait and takes the fallback. That is
    // fine: its run is going away.
    expect(await probeClaudeEffortLevels(cancelled.signal)).toEqual({
      levels: CLAUDE_EFFORT_SNAPSHOT,
      live: false,
    });

    // The regression: that run's signal used to reach the shared spawn, so the
    // memo recorded a killed capture and every later run for the lifetime of the
    // daemon read the snapshot — which on this 2.1.89 stub means advertising and
    // forwarding `xhigh` to a binary that does not accept it.
    expect(await probeClaudeEffortLevels()).toEqual({ levels: LADDER_2_1_89, live: true });
  });

  it("re-probes after a capture that never produced an answer", async () => {
    // No stub on disk yet: the spawn itself fails.
    const { CLAUDE_EFFORT_SNAPSHOT, probeClaudeEffortLevels, probeClaudeHelp } =
      await import("./effort-probe.js");
    expect((await probeClaudeHelp()).ok).toBe(false);
    expect(await probeClaudeEffortLevels()).toEqual({
      levels: CLAUDE_EFFORT_SNAPSHOT,
      live: false,
    });

    // A missing or unspawnable binary is a fact about one moment, not about the
    // installation. Once it is there, the next run must actually look again.
    installStub(HELP_2_1_89);
    expect(await probeClaudeEffortLevels()).toEqual({ levels: LADDER_2_1_89, live: true });
  });

  it("re-probes for the readonly consumer too, which used to cache its own failure", async () => {
    const { probeClaudeReadonlyProfile } = await import("./index.js");
    const missing = await probeClaudeReadonlyProfile();
    expect(missing.supported).toBe(false);

    // The second cache repeated the first one's defect one level up: one failed
    // read and the adapter refused every readonly run for the process lifetime.
    installStub(HELP_READONLY);
    expect(await probeClaudeReadonlyProfile()).toMatchObject({
      supported: true,
      missingFlags: [],
    });
  });

  it("re-reads a binary rewritten at the same path, and keeps serving an unchanged one", async () => {
    // The live defect (2026-09-18): a CLI updated in place kept the OLD ladder
    // for the life of the daemon because the memo was keyed by nothing. The
    // memo is now keyed by the binary's identity (realpath, inode, size,
    // mtime), so the next caller after an update reads the new binary — with
    // NO `vi.resetModules()` between the two probes below.
    installStub(HELP_2_1_89);
    const { probeClaudeEffortLevels } = await import("./effort-probe.js");
    expect(await probeClaudeEffortLevels()).toEqual({ levels: LADDER_2_1_89, live: true });
    // Unchanged bytes: still the memo, still the same answer.
    expect(await probeClaudeEffortLevels()).toEqual({ levels: LADDER_2_1_89, live: true });

    const HELP_NEWER = [
      "  --effort <level>                      Effort level for the current session",
      "                                        (low, medium, high, xhigh, max)",
      "  --fallback-model <model>              Fallback model",
    ].join("\n");
    installStub(HELP_NEWER);
    expect(await probeClaudeEffortLevels()).toEqual({
      levels: ["low", "medium", "high", "xhigh", "max"],
      live: true,
    });
  });
});

/**
 * A run whose env patch carries a PATH executes `claude` on that path (the spawn
 * layer applies the patch verbatim over the normalized PATH), so everything the
 * run asks about "the installed binary" — the effort ladder, the readonly flag
 * set, the `--version` behind the snapshot-trust gate — must be read from the
 * same bytes, not from whichever managed `claude` the host PATH resolves first.
 */
describe("the --help memo and its consumers follow a run's PATH patch", () => {
  const HELP_2_1_165 = [
    "  --effort <level>                      Effort level for the current session",
    "                                        (low, medium, high, xhigh, max)",
    "  --fallback-model <model>              Fallback model",
  ].join("\n");
  /** A help text with no `--effort` line at all: the live parse cannot answer. */
  const HELP_UNPARSEABLE = "Usage: claude [options] [command] [prompt]";

  /** A stub `claude` in its own directory, answering `--version` and `--help`. */
  function installPatchBinary(name: string, help: string, version: string): string {
    const pathDir = join(dir, name);
    mkdirSync(pathDir, { recursive: true });
    writeFileSync(
      join(pathDir, "claude"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\n` +
        `echo spawn >> "${join(pathDir, "spawns")}"\n` +
        `/bin/cat <<'CLAUDE_HELP_EOF'\n${help}\nCLAUDE_HELP_EOF\n`,
      { mode: 0o755 },
    );
    return pathDir;
  }
  const spawns = (pathDir: string): number =>
    readFileSync(join(pathDir, "spawns"), "utf8").split("spawn").length - 1;

  beforeEach(() => {
    // A bare `claude`, resolved on PATH, as production spawns it.
    vi.stubEnv("CLAUDEXOR_CLAUDE_BIN", "");
  });

  it("reads the ladder of the binary on the patch PATH, memoises it there, and a second patch binary answers its own", async () => {
    const older = installPatchBinary("patch-older", HELP_2_1_89, "2.1.89 (Claude Code)");
    const newer = installPatchBinary("patch-newer", HELP_2_1_165, "2.1.165 (Claude Code)");
    const { probeClaudeEffortLevels, claudeRunEffortResolution } =
      await import("./effort-probe.js");
    expect(await probeClaudeEffortLevels(undefined, older)).toEqual({
      levels: LADDER_2_1_89,
      live: true,
    });
    // The run-time resolution threads the spec's PATH through the same seam.
    const resolution = await claudeRunEffortResolution(
      { session_id: "ses", effort_hint: "xhigh", env: { PATH: older } },
      { probeEffortLevels: probeClaudeEffortLevels, detectVersion: async () => null },
    );
    expect(resolution.advertised).toEqual(LADDER_2_1_89);
    expect(resolution.disclosure?.text).toContain("effort=xhigh (clamped to high");
    // Same patch PATH again: the memo answers, no second spawn.
    await probeClaudeEffortLevels(undefined, older);
    expect(spawns(older)).toBe(1);
    // A different patch PATH is a different binary: its own ladder, its own spawn.
    expect(await probeClaudeEffortLevels(undefined, newer)).toEqual({
      levels: ["low", "medium", "high", "xhigh", "max"],
      live: true,
    });
    expect(spawns(newer)).toBe(1);
  });

  it("does not evict a newer program's help when an older version read finishes late", async () => {
    const older = installPatchBinary("late-older", HELP_2_1_89, "2.1.89");
    const newer = installPatchBinary("fast-newer", HELP_2_1_165, "2.1.165");
    const entered = join(older, "entered"),
      release = join(older, "release");
    const oldBin = join(older, "claude");
    writeFileSync(
      oldBin,
      readFileSync(oldBin, "utf8").replace(
        "then echo",
        `then : > '${entered}'; while [ ! -f '${release}' ]; do /bin/sleep 0.02; done; echo`,
      ),
    );
    const { probeClaudeEffortLevels } = await import("./effort-probe.js");
    const late = probeClaudeEffortLevels(undefined, older);
    try {
      await vi.waitFor(() => expect(existsSync(entered)).toBe(true));
      expect((await probeClaudeEffortLevels(undefined, newer)).levels).toContain("xhigh");
    } finally {
      writeFileSync(release, "released");
      await late;
    }
    expect((await probeClaudeEffortLevels(undefined, newer)).levels).toContain("xhigh");
    expect(spawns(newer)).toBe(1);
  });

  it("reads the readonly flag set from the binary on the patch PATH", async () => {
    const complete = installPatchBinary("patch-readonly", HELP_READONLY, "2.1.281 (Claude Code)");
    const lacking = installPatchBinary("patch-lacking", HELP_2_1_89, "2.1.89 (Claude Code)");
    const { probeClaudeReadonlyProfile } = await import("./index.js");
    expect(await probeClaudeReadonlyProfile(undefined, complete)).toMatchObject({
      supported: true,
      missingFlags: [],
    });
    const refused = await probeClaudeReadonlyProfile(undefined, lacking);
    expect(refused.supported).toBe(false);
    expect(refused.missingFlags).toContain("--strict-mcp-config");
  });

  it("lets only the patch binary's own --version vouch for the snapshot when its help cannot be parsed", async () => {
    const { CLAUDE_EFFORT_SNAPSHOT, CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST } =
      await import("./effort-probe.js");
    const other = installPatchBinary(
      "patch-other-version",
      HELP_UNPARSEABLE,
      "2.1.89 (Claude Code)",
    );
    const stamped = installPatchBinary(
      "patch-stamped-version",
      HELP_UNPARSEABLE,
      `${CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST} (Claude Code)`,
    );
    const { probeClaudeEffortLevels, claudeRunEffortResolution, detectClaudeVersion } =
      await import("./effort-probe.js");
    expect(await detectClaudeVersion(undefined, other)).toBe("2.1.89 (Claude Code)");
    const deps = { probeEffortLevels: probeClaudeEffortLevels, detectVersion: detectClaudeVersion };
    // A patch binary on another version: the snapshot is distrusted for it even
    // if the HOST install sits on the stamped version — no effort flag is sent.
    const distrusted = await claudeRunEffortResolution(
      { session_id: "ses", effort_hint: "xhigh", env: { PATH: other } },
      deps,
    );
    expect(distrusted.advertised).toEqual([]);
    expect(distrusted.disclosure?.text).toContain("could not be verified");
    // A patch binary on exactly the stamped version: the snapshot is its own
    // ladder, so `xhigh` is advertised and travels without a disclosure.
    const trusted = await claudeRunEffortResolution(
      { session_id: "ses", effort_hint: "xhigh", env: { PATH: stamped } },
      deps,
    );
    expect(trusted.advertised).toEqual(CLAUDE_EFFORT_SNAPSHOT);
    expect(trusted.disclosure).toBeNull();
  });
});

it.each([true, false])(
  "retains completed help for the same file and remembered answer (known: %s)",
  async (known) => {
    const help = join(dir, "help"),
      calls = join(dir, "calls");
    writeFileSync(
      bin,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then ${known ? "echo 1.0.0; exit 0" : "exit 1"}; fi\necho help >> '${calls}'\n/bin/cat '${help}'\n`,
      { mode: 0o755 },
    );
    writeFileSync(help, HELP_2_1_89);
    const { probeClaudeHelp } = await import("./effort-probe.js");
    expect(await probeClaudeHelp()).toMatchObject({
      ok: true,
      help: expect.stringContaining("high, max"),
    });
    writeFileSync(help, HELP_2_1_89.replace("high, max", "high, xhigh, max"));
    const second = await probeClaudeHelp();
    expect(second).toMatchObject({
      ok: true,
      help: expect.stringContaining("high, max"),
    });
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
    writeFileSync(bin, readFileSync(bin, "utf8") + "\n# changed file identity\n");
    expect(await probeClaudeHelp()).toMatchObject({
      ok: true,
      help: expect.stringContaining("high, xhigh, max"),
    });
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
  },
);
