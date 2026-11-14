import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnProcess, type ChildStdin } from "@claudexor/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "./args.js";
import {
  MAINTENANCE_EVIDENCE_PREFIX,
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
  it.each(["previous", "baseline", "latest", "^1.0.0"])(
    "rejects a non-exact vendor-version value %s with the current spelling",
    async (version) => {
      const output = capture();
      expect(
        await harnessMutationCommand(
          parseArgs(["harness", "update", "codex", "--vendor-version", version, "--yes"]),
          true,
        ),
      ).toBe(2);
      expect(output()).toContain("--vendor-version <exact>");
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
    w.options.spawn = ((bin: string, args: readonly string[] = [], opts: SpawnSyncOptions = {}) => {
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
    w.options.spawn = ((bin: string, args: readonly string[] = [], opts: SpawnSyncOptions = {}) => {
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
  it.each([false, true])(
    "shows why npm conversion failed beside a failed installer (json: %s)",
    async (json) => {
      const w = vendorFixture();
      roots.push(w.home);
      const prefix = join(w.home, ".claudexor/node");
      const pkg = join(prefix, "lib/node_modules/@fixture/harness");
      executable(join(pkg, "bin/fixture-harness"));
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "@fixture/harness",
          bin: { "fixture-harness": "bin/fixture-harness" },
        }),
      );
      mkdirSync(join(prefix, "bin"), { recursive: true });
      symlinkSync(join(pkg, "bin/fixture-harness"), join(prefix, "bin/fixture-harness"));
      let errors = "";
      const output = capture();
      vi.mocked(process.stderr.write).mockImplementation((chunk) => {
        errors += chunk;
        return true;
      });
      w.options.spawn = ((
        bin: string,
        args: readonly string[] = [],
        opts: SpawnSyncOptions = {},
      ) =>
        args[0] === "--version"
          ? spawnSync(bin, args, opts)
          : result("No available upgrade found", 7)) as typeof spawnSync;
      const args = ["harness", "update", "fixture", "--yes", ...(json ? ["--json"] : [])];
      expect(await harnessMutationCommand(parseArgs(args), json, w.options)).toBe(7);
      const reason =
        "After the installer exited 7, npm copy conversion failed (conversion_verification_failed): Vendor installation did not produce a selected program with a version while the old npm launcher was masked; conversion removed nothing";
      if (json) {
        expect(JSON.parse(output())).toMatchObject({
          ok: false,
          exitCode: 7,
          problem: { code: "vendor_command_failed", message: "No available upgrade found" },
          limitations: expect.arrayContaining([reason]),
        });
        expect(errors).toBe("No available upgrade found\n");
      } else {
        const lines = output().trimEnd().split("\n");
        expect(lines.slice(-3)).toEqual([
          "No available upgrade found",
          reason,
          "No available upgrade found",
        ]);
      }
    },
  );
});

it("the real CLI child acknowledges both conversion commands and closes its protocol input", async () => {
  const w = vendorFixture();
  roots.push(w.home);
  const entry = join(
    w.home,
    ".claudexor/node/lib/node_modules/@fixture/harness/bin/fixture-harness",
  );
  executable(entry);
  writeFileSync(
    join(dirname(dirname(entry)), "package.json"),
    JSON.stringify({ name: "@fixture/harness", bin: { "fixture-harness": "bin/fixture-harness" } }),
  );
  const launcher = join(w.home, ".claudexor/node/bin/fixture-harness");
  mkdirSync(dirname(launcher), { recursive: true });
  symlinkSync(entry, launcher);
  const script = join(w.home, "cli-fixture.mjs");
  const module = new URL("../dist/harness-installer.js", import.meta.url).href;
  const core = new URL("../../core/dist/index.js", import.meta.url).href;
  writeFileSync(
    script,
    String.raw`
import { harnessMutationCommand } from ${JSON.stringify(module)};
import { defineHarnessProgram } from ${JSON.stringify(core)};
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const options = ${JSON.stringify(w.options)};
defineHarnessProgram(options.program);
options.fetch = async () => new Response("#!/bin/sh\n# fixture installer\n");
options.spawn = (bin, args, opts) => {
  if (args[0] === "--version") return spawnSync(bin, args, opts);
  const version = bin === "/bin/sh" ? "2.0.0" : "3.4.5";
  const path = ${JSON.stringify(w.installed)};
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\necho " + version + "\n", { mode: 0o755 });
  return { status: 0, stdout: "Done", stderr: "" };
};
process.exitCode = await harnessMutationCommand({ _: ["harness", "update", "fixture"], flags: { yes: true, "vendor-version": "3.4.5" } }, true, options);
`,
  );
  const frames: Array<{ commands: unknown[] }> = [];
  let stdout = "";
  let input: ChildStdin | undefined;
  for await (const event of spawnProcess(process.execPath, [script], {
    env: { CLAUDEXOR_MAINTENANCE_PROTOCOL: "1" },
    keepStdinOpen: true,
    onSpawn: (io) => {
      input = io;
    },
    timeoutMs: 10_000,
    cancelKillDelayMs: 0,
  })) {
    if (event.type === "stderr" && event.line.startsWith(MAINTENANCE_EVIDENCE_PREFIX)) {
      frames.push(JSON.parse(event.line.slice(MAINTENANCE_EVIDENCE_PREFIX.length)));
      input!.write("ack\n");
    } else if (event.type === "stdout") stdout += event.line;
    else if (event.type === "exit") expect(event.code).toBe(0);
  }
  expect(frames.map((frame) => frame.commands.length)).toEqual([1, 2]);
  expect(JSON.parse(stdout)).toMatchObject({
    ok: true,
    commands: [{ binary: "/bin/sh" }, { binary: w.installed }],
    after: { path: w.installed, version: "3.4.5" },
  });
});
