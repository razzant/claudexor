import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { detectVersion, resolveCodexBin } from "../../harness-codex/src/missing-cli.js";
import { detectClaudeVersion, resolveClaudeBin } from "../../harness-claude/src/effort-probe.js";
import { detectCursorVersion, resolveCursorBin } from "../../harness-cursor/src/bin.js";
import { detectGrokVersion, resolveGrokBin } from "../../harness-grok/src/bin.js";
import { AGY_BIN } from "../../harness-agy/src/profile.js";
import { executable, vendorFixture } from "./test-support/vendor-program-fixture.js";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);

it("native launchers and version probes read an override changed after module import", async () => {
  const w = vendorFixture();
  roots.push(w.home);
  const first = join(w.home, "first"),
    second = join(w.home, "second");
  executable(first, "1.0.0");
  executable(second, "2.0.0");
  vi.stubEnv("HOME", w.home);
  for (const [id, launcher, probe] of [
    ["codex", resolveCodexBin, detectVersion],
    ["claude", resolveClaudeBin, detectClaudeVersion],
    ["cursor", resolveCursorBin, detectCursorVersion],
    ["grok", resolveGrokBin, detectGrokVersion],
  ] as const) {
    const key = `CLAUDEXOR_${id.toUpperCase()}_BIN`;
    vi.stubEnv(key, first);
    expect(launcher()).toBe(first);
    expect(await probe()).toBe("1.0.0");
    vi.stubEnv(key, second);
    expect(launcher()).toBe(second);
    expect(await probe()).toBe("2.0.0");
  }
  vi.stubEnv("CLAUDEXOR_AGY_BIN", first);
  expect(AGY_BIN()).toBe(first);
  vi.stubEnv("CLAUDEXOR_AGY_BIN", second);
  expect(AGY_BIN()).toBe(second);
});
