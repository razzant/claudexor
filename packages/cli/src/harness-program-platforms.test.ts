import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineHarnessProgram, programPath, programPlatform } from "@claudexor/core";
import { harnessPrograms } from "./harness-programs.js";
import { inspectHarness, runHarnessUpdate } from "./harness-maintenance.js";
import { newestSource, observeNewest } from "./harness-newest.js";
import {
  SCRIPT,
  executable,
  result,
  vendorFixture,
} from "./test-support/vendor-program-fixture.js";

const programs = harnessPrograms();
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);
function image(path: string) {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ");
  bytes.writeUInt32LE(128, 60);
  bytes.write("PE\0\0", 128);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

describe("adapter vendor declarations", () => {
  it("derives all seven local programs, with no fixture stamps in install commands", () => {
    expect(programs.map((program) => program.id)).toEqual([
      "agy",
      "claude",
      "codex",
      "copilot",
      "cursor",
      "grok",
      "opencode",
    ]);
    for (const program of programs)
      for (const platform of ["darwin", "linux", "win32"] as const) {
        const data = programPlatform(program, platform)!;
        expect(data.newest?.url).toMatch(/^https:\/\//);
        expect(data.update || data.reasons?.update).toBeTruthy();
        expect(data.install || data.reasons?.install).toBeTruthy();
        expect(
          data.exactVersion || data.reasons?.exactVersion || program.id === "opencode",
        ).toBeTruthy();
        expect(JSON.stringify(data.install ?? null)).not.toMatch(
          /npm|release-tested|vendor-cli-version/,
        );
      }
  });
  it("previews available commands without fetching installers and compares the declared version scheme", async () => {
    const w = vendorFixture();
    roots.push(w.home);
    const fetcher = vi.fn(async () => new Response("1.0.0"));
    const program = { ...w.program, versionScheme: "semver" as const };
    const options = { ...w.options, program, fetch: fetcher };
    const absent = await inspectHarness(program.id, options);
    expect(absent.actions.install.commands).toEqual([program.platforms.darwin!.install]);
    expect(absent.actions.update.commands).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    const path = join(w.home, ".vendor/bin/fixture-harness");
    executable(path, "2.0.0");
    const installed = await inspectHarness(program.id, {
      ...options,
      sourceEnv: { ...options.sourceEnv, FIXTURE_BIN: path },
      latest: true,
    });
    expect(installed.updateAvailable).toBe("no");
    expect(installed.actions.update.commands).toEqual([
      { kind: "exec", command: path, args: ["update"] },
    ]);
    expect(installed.actions.exactVersion.commands).toEqual([
      { kind: "exec", command: path, args: ["update", "--version", "{version}"] },
    ]);
  });
  it.each(["claude", "codex", "agy", "grok", "copilot"])(
    "executes the Windows %s vendor route and finds its installed launcher without restart",
    async (id) => {
      const w = vendorFixture();
      roots.push(w.home);
      const declared = programs.find((program) => program.id === id)!;
      const program = defineHarnessProgram({
        ...declared,
        launchers: [{ name: `fixture-${id}` }],
        overrideEnv: `FIXTURE_${id.toUpperCase()}_BIN`,
      });
      const sourceEnv = {
        HOME: w.home,
        LOCALAPPDATA: join(w.home, "Local"),
        PATH: join(w.home, "tools"),
        SystemRoot: join(w.home, "Windows"),
      };
      image(join(w.home, "tools/powershell.exe"));
      image(join(w.home, "tools/winget.exe"));
      const data = programPlatform(program, "win32")!;
      // Use the distinct vendor directory, including Codex and Antigravity's new Windows homes.
      const folder =
        id === "codex"
          ? "{localAppData}/Programs/OpenAI/Codex/bin"
          : id === "agy"
            ? "{localAppData}/agy/bin"
            : id === "copilot"
              ? "{localAppData}/Microsoft/WinGet/Links"
              : data.launcherDirs[0]!;
      const installed = join(programPath(folder, sourceEnv), `fixture-${id}.exe`);
      const invocations: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
      const fetcher = vi.fn(async () => new Response(SCRIPT));
      const options = {
        ...w.options,
        program,
        platform: "win32" as const,
        sourceEnv,
        fetch: fetcher,
        spawn: ((bin, args, opts) => {
          if (args[0] === "--version") return result("fixture 1.2.3\n");
          invocations.push({ bin, args: [...args], env: opts.env! });
          if (id !== "copilot")
            expect(readFileSync(args[args.indexOf("-File") + 1]!, "utf8")).toBe(SCRIPT);
          image(installed);
          return result("Installed vendor copy");
        }) as typeof spawnSync,
      };
      expect((await inspectHarness(id, options)).selection.path).toBeNull();
      const receipt = await runHarnessUpdate(id, undefined, options);
      expect(receipt).toMatchObject({
        ok: true,
        outcome: "changed",
        after: { path: installed, version: "1.2.3" },
      });
      expect(invocations).toHaveLength(1);
      expect(invocations[0]!.bin).toMatch(id === "copilot" ? /winget\.exe$/ : /powershell\.exe$/);
      expect(invocations[0]!.env).toMatchObject({
        HOME: w.home,
        USERPROFILE: w.home,
        LOCALAPPDATA: sourceEnv.LOCALAPPDATA,
      });
      if (id === "copilot") {
        expect(invocations[0]!.args).toContain("GitHub.Copilot");
        expect(fetcher).not.toHaveBeenCalled();
      } else
        expect(receipt.commands[0]!.script?.url).toBe(
          data.install!.kind === "script" ? data.install!.url : null,
        );
    },
  );
  it("honors the vendor's custom Codex installation directory in execution and subsequent resolution", async () => {
    const w = vendorFixture();
    roots.push(w.home);
    const declared = programs.find((program) => program.id === "codex")!;
    const program = defineHarnessProgram({
      ...declared,
      launchers: [{ name: "fixture-codex-custom" }],
      overrideEnv: "FIXTURE_CODEX_CUSTOM_BIN",
    });
    const folder = join(w.home, "custom/vendor/bin"),
      installed = join(folder, "fixture-codex-custom");
    const sourceEnv = {
      HOME: w.home,
      PATH: "",
      CODEX_HOME: join(w.home, "codex-state"),
      CODEX_INSTALL_DIR: folder,
    };
    const receipt = await runHarnessUpdate("codex", undefined, {
      ...w.options,
      program,
      sourceEnv,
      spawn: ((bin, args, options) => {
        if (args[0] === "--version") return spawnSync(bin, args, options);
        expect(options.env).toMatchObject({
          HOME: w.home,
          CODEX_HOME: sourceEnv.CODEX_HOME,
          CODEX_INSTALL_DIR: folder,
          CODEX_NON_INTERACTIVE: "1",
        });
        executable(installed, "1.2.3");
        return result();
      }) as typeof spawnSync,
    });
    expect(receipt).toMatchObject({
      ok: true,
      outcome: "changed",
      after: { path: installed, version: "1.2.3" },
    });
  });
  it("states Windows limits and holds OpenCode to its V1 command", async () => {
    const w = vendorFixture();
    roots.push(w.home);
    for (const [id, issue] of [
      ["cursor", "#667"],
      ["opencode", "#668"],
    ]) {
      const declared = programs.find((p) => p.id === id)!;
      const program = {
        ...declared,
        launchers: [{ name: `absent-${id}-fixture` }],
        overrideEnv: "ABSENT_FIXTURE_BIN",
      };
      const row = await inspectHarness(id!, { ...w.options, program, platform: "win32" });
      expect(row.actions.install).toMatchObject({
        available: false,
        reason: expect.stringContaining(issue!),
      });
    }
    const opencode = programs.find((p) => p.id === "opencode")!;
    expect(opencode.platforms.darwin!.install).toMatchObject({
      url: "https://opencode.ai/install",
    });
    expect(opencode.platforms.darwin!.update).toMatchObject({ args: ["upgrade"] });
    expect(
      (
        await runHarnessUpdate("opencode", "2.0.0", {
          ...w.options,
          program: { ...opencode, launchers: [{ name: "missing-opencode-fixture" }] },
        })
      ).problem?.message,
    ).toContain("1.x");
    expect(
      await observeNewest(
        opencode,
        "darwin",
        "arm64",
        async () => new Response('{"version":"2.0.0"}'),
      ),
    ).toMatchObject({ status: "unavailable" });
  });
  it("picks newest values with one HTTPS read per declaration, including architecture and script extraction", async () => {
    for (const program of programs) {
      const source = newestSource(program, "darwin", "arm64")!;
      const version = program.id === "cursor" ? "2026.11.10-abc123" : "1.2.3";
      const body =
        source.pick.kind === "text"
          ? version
          : source.pick.kind === "json"
            ? JSON.stringify({ [source.pick.field]: `${source.pick.stripPrefix ?? ""}${version}` })
            : `DOWNLOAD=versions/${version}/linux`;
      const fetcher = vi.fn(async () => new Response(body));
      expect(await observeNewest(program, "darwin", "arm64", fetcher)).toMatchObject({
        status: "available",
        version,
      });
      expect(fetcher).toHaveBeenCalledOnce();
      if (program.id === "agy") expect(source.url).toContain("darwin_arm64.json");
    }
  });
});
