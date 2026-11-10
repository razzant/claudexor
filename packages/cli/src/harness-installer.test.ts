import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "./args.js";
import {
  harnessInstallCommand,
  harnessMutationCommand,
  retiredInstallFlags,
} from "./harness-installer.js";
import { executable, result, vendorFixture } from "./test-support/vendor-program-fixture.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);
function capture() {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += chunk;
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return () => output;
}
describe("harness install/update CLI", () => {
  it.each(["--target=local", "--target=remote", "--release-tested"])(
    "hard-errors the retired flag %s with the new spelling",
    async (flag) => {
      const output = capture();
      const args = parseArgs(["harness", "install", "codex", flag, "--json", "--yes"]);
      expect(retiredInstallFlags(args)).toContain("retired");
      expect(await harnessInstallCommand(args, true)).toBe(2);
      expect(output()).toContain("harness install <id> --yes");
    },
  );
  it("requires explicit authorization from a nonterminal caller", async () => {
    const output = capture();
    expect(
      await harnessMutationCommand(parseArgs(["harness", "update", "codex", "--json"]), true),
    ).toBe(2);
    expect(output()).toContain("--yes");
  });
  it("installs missing through the vendor command and prints one full receipt", async () => {
    const w = vendorFixture();
    roots.push(w.home);
    const output = capture();
    w.options.spawn = ((bin, args, opts) => {
      if (args[0] === "--version") return spawnSync(bin, args, opts);
      executable(w.installed, "2.0.0");
      return result("Done");
    }) as typeof spawnSync;
    expect(
      await harnessInstallCommand(
        parseArgs(["harness", "install", "fixture", "--yes", "--json"]),
        true,
        w.options,
      ),
    ).toBe(0);
    expect(JSON.parse(output())).toMatchObject({
      ok: true,
      outcome: "changed",
      installationHome: w.home,
      before: { path: null },
      after: { path: w.installed, version: "2.0.0" },
      commands: [{ script: { sha256: expect.any(String) } }],
    });
  });
  it("install is idempotent when selected; Update still runs the selected verb", async () => {
    const w = vendorFixture();
    roots.push(w.home);
    capture();
    executable(w.installed);
    let mutations = 0;
    w.options.spawn = ((bin, args, opts) => {
      if (args[0] === "--version") return spawnSync(bin, args, opts);
      mutations++;
      return result("Already current");
    }) as typeof spawnSync;
    expect(
      await harnessInstallCommand(
        parseArgs(["harness", "install", "fixture", "--yes"]),
        true,
        w.options,
      ),
    ).toBe(0);
    expect(mutations).toBe(0);
    expect(
      await harnessMutationCommand(
        parseArgs(["harness", "update", "fixture", "--yes"]),
        true,
        w.options,
      ),
    ).toBe(0);
    expect(mutations).toBe(1);
  });
});
