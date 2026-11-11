import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectHarness, runHarnessUpdate } from "./harness-maintenance.js";
import {
  SCRIPT,
  executable,
  result,
  vendorFixture,
} from "./test-support/vendor-program-fixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true });
}, 0);
function world() {
  const w = vendorFixture();
  roots.push(w.home);
  return w;
}
function oldCopy(w: ReturnType<typeof world>, remote = false) {
  const prefix = join(w.home, remote ? ".claudexor/remote/vendor" : ".claudexor/node");
  const pkg = join(prefix, "lib/node_modules/@fixture/harness");
  const entry = join(pkg, "bin/fixture-harness");
  executable(entry);
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@fixture/harness",
      version: "9.9.9",
      bin: { "fixture-harness": "bin/fixture-harness" },
    }),
  );
  const launcher = join(prefix, "bin/fixture-harness");
  mkdirSync(dirname(launcher), { recursive: true });
  symlinkSync(entry, launcher);
  if (remote) w.options.sourceEnv!.CLAUDEXOR_REMOTE_RUNTIME = "1";
  return { pkg, entry, launcher };
}

describe("selected vendor operation", () => {
  it.each([false, true])("updates an arbitrary selected entry (override: %s)", async (override) => {
    const w = world();
    const selected = join(w.home, "hand-placed", override ? "wrapper" : "fixture-harness");
    executable(selected);
    w.options.sourceEnv!.PATH = dirname(selected);
    if (override) w.options.sourceEnv!.FIXTURE_BIN = selected;
    const calls: string[] = [];
    w.options.spawn = ((bin, args, opts) => {
      if (args[0] === "--version") return spawnSync(bin, args, opts);
      calls.push(bin);
      executable(selected, "2.0.0");
      return result("Updated selected program");
    }) as typeof spawnSync;
    const receipt = await runHarnessUpdate("fixture", undefined, {
      ...w.options,
      activeRunsAtStart: 3,
      requester: { source: "test", requestId: "a" },
    });
    expect(calls).toEqual([selected]);
    expect(receipt).toMatchObject({
      ok: true,
      outcome: "changed",
      mutation: "applied",
      activeRunsAtStart: 3,
      requester: { source: "test", requestId: "a" },
      before: { path: selected, version: "1.0.0", overrideEnv: override ? "FIXTURE_BIN" : null },
      after: { path: selected, version: "2.0.0" },
    });
  });
  it("runs a hand-placed engine-bin wrapper beside stale npm metadata without replacing it", async () => {
    const w = world();
    const old = oldCopy(w);
    rmSync(old.launcher);
    const wrapper = join(w.home, "custom/wrapper");
    executable(wrapper);
    symlinkSync(wrapper, old.launcher);
    const bytes = readFileSync(wrapper);
    const calls: string[] = [];
    w.options.spawn = ((bin, args, opts) => {
      if (args[0] === "--version") return spawnSync(bin, args, opts);
      calls.push(bin);
      return result("Use your own installer to update this copy.");
    }) as typeof spawnSync;
    const receipt = await runHarnessUpdate("fixture", undefined, w.options);
    expect(calls).toEqual([old.launcher]);
    expect(receipt).toMatchObject({
      ok: true,
      outcome: "not_changed",
      mutation: "none",
      progress: ["Use your own installer to update this copy."],
    });
    expect(readFileSync(wrapper)).toEqual(bytes);
    expect(existsSync(old.pkg)).toBe(true);
  });
  it.each([false, true])(
    "converts a proven old npm copy only after a vendor copy answers (remote: %s)",
    async (remote) => {
      const w = world();
      const old = oldCopy(w, remote);
      const calls: string[] = [];
      w.options.spawn = ((bin, args, opts) => {
        if (args[0] === "--version") return spawnSync(bin, args, opts);
        calls.push(bin);
        executable(w.installed, "2.0.0");
        return result("Installed vendor copy");
      }) as typeof spawnSync;
      const receipt = await runHarnessUpdate("fixture", undefined, w.options);
      expect(calls).toEqual(["/bin/sh"]);
      expect(receipt).toMatchObject({
        ok: true,
        outcome: "changed",
        before: { path: old.launcher, version: "1.0.0" },
        after: { path: w.installed, version: "2.0.0" },
      });
      expect(existsSync(old.pkg)).toBe(false);
      expect(existsSync(old.launcher)).toBe(false);
      expect(receipt.commands[0]!.script).toEqual({
        url: "https://example.invalid/install",
        size: Buffer.byteLength(SCRIPT),
        sha256: createHash("sha256").update(SCRIPT).digest("hex"),
      });
      expect(existsSync(receipt.commands[0]!.args[0]!)).toBe(false);
    },
  );
  it.each(["installer", "missing-version", "explicit-old-override"])(
    "failed conversion preserves the old copy (%s)",
    async (failure) => {
      const w = world();
      const old = oldCopy(w);
      if (failure === "explicit-old-override") w.options.sourceEnv!.FIXTURE_BIN = old.launcher;
      w.options.spawn = ((bin, args, opts) => {
        if (args[0] === "--version") return spawnSync(bin, args, opts);
        if (failure !== "installer")
          executable(w.installed, failure === "missing-version" ? "" : "2.0.0");
        return result(
          failure === "installer" ? "Download failed" : "Installed",
          failure === "installer" ? 9 : 0,
        );
      }) as typeof spawnSync;
      const receipt = await runHarnessUpdate("fixture", undefined, w.options);
      expect(receipt.ok).toBe(false);
      expect(receipt.problem?.message).toMatch(
        failure === "installer" ? /Download failed/ : /old copy is unchanged/,
      );
      expect(existsSync(old.pkg)).toBe(true);
      expect((await inspectHarness("fixture", w.options)).selection).toMatchObject({
        path: old.launcher,
        version: "1.0.0",
      });
    },
  );
  it.each([false, true])(
    "converts before an exact native verb and retains the old copy if that verb fails (%s)",
    async (failExact) => {
      const w = world();
      const old = oldCopy(w);
      const prepared: unknown[] = [];
      w.options.beforeMutation = async (receipt) => {
        prepared.push(structuredClone(receipt.commands));
        expect(existsSync(old.pkg)).toBe(true);
      };
      w.options.spawn = ((bin, args, options) => {
        if (args[0] === "--version") return spawnSync(bin, args, options);
        if (bin === "/bin/sh") {
          executable(w.installed, "2.0.0");
          return result("Native installed");
        }
        expect(bin).toBe(w.installed);
        expect(args).toEqual(["update", "--version", "3.4.5"]);
        if (failExact) return result("Exact release unavailable", 7);
        executable(w.installed, "3.4.5");
        return result("Exact installed");
      }) as typeof spawnSync;
      const receipt = await runHarnessUpdate("fixture", "3.4.5", w.options);
      expect(prepared).toHaveLength(2);
      expect(receipt.commands).toHaveLength(2);
      expect(receipt.ok).toBe(!failExact);
      expect(existsSync(old.pkg)).toBe(failExact);
      expect(receipt.after).toMatchObject({
        path: failExact ? old.launcher : w.installed,
        version: failExact ? "1.0.0" : "3.4.5",
      });
      if (failExact)
        expect(receipt.progress).toEqual(["Native installed", "Exact release unavailable"]);
    },
  );
  it("states the missing vendor installer when a platform cannot convert its old npm copy", async () => {
    const w = world();
    const old = oldCopy(w);
    delete w.program.platforms.darwin!.install;
    w.program.platforms.darwin!.reasons = {
      install: "No unattended vendor installer on this platform (#fixture).",
    };
    const row = await inspectHarness("fixture", w.options);
    expect(row.actions.update).toEqual({
      available: false,
      reason: "No unattended vendor installer on this platform (#fixture).",
      commands: [],
    });
    expect(row.actions.exactVersion).toEqual(row.actions.update);
    expect((await runHarnessUpdate("fixture", "2.0.0", w.options)).ok).toBe(false);
    expect(existsSync(old.pkg)).toBe(true);
  });
  it("a newest read failure cannot block Update", async () => {
    const w = world();
    executable(w.installed);
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    });
    w.options.fetch = fetcher;
    expect((await inspectHarness("fixture", { ...w.options, latest: true })).newest).toMatchObject({
      status: "unavailable",
      problem: { message: "offline" },
    });
    w.options.spawn = ((bin, args, opts) => {
      if (args[0] === "--version") return spawnSync(bin, args, opts);
      executable(w.installed, "2.0.0");
      return result();
    }) as typeof spawnSync;
    expect((await runHarnessUpdate("fixture", undefined, w.options)).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("reports a changed unselected copy while keeping the selected wrapper", async () => {
    const w = world();
    const selected = join(w.home, "wrapper");
    executable(selected);
    executable(w.installed);
    w.options.sourceEnv!.FIXTURE_BIN = selected;
    w.options.spawn = ((bin, args, opts) => {
      if (args[0] === "--version") return spawnSync(bin, args, opts);
      executable(w.installed, "2.0.0");
      return result("Installed another copy");
    }) as typeof spawnSync;
    expect(await runHarnessUpdate("fixture", undefined, w.options)).toMatchObject({
      ok: true,
      outcome: "changed_elsewhere",
      mutation: "applied",
      before: { path: selected, version: "1.0.0" },
      after: { path: selected, version: "1.0.0" },
      elsewhere: { before: { version: "1.0.0" }, after: { version: "2.0.0" } },
    });
  });
  it("uses installation HOME and declared inputs in a clean environment, with bounded redacted vendor advice", async () => {
    const w = world();
    executable(w.installed);
    Object.assign(w.options.sourceEnv!, {
      CODEX_HOME: join(w.home, "codex-state"),
      XDG_CONFIG_HOME: join(w.home, "config"),
      ANTHROPIC_API_KEY: "unrelated-secret",
      RANDOM_SECRET: "also-secret",
    });
    let env: NodeJS.ProcessEnv | undefined;
    w.options.spawn = ((bin, args, opts) => {
      if (args[0] === "--version") return spawnSync(bin, args, opts);
      env = opts.env;
      return result(
        Array.from({ length: 45 }, (_, i) => `line ${i}`).join("\n") +
          "\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n",
      );
    }) as typeof spawnSync;
    const receipt = await runHarnessUpdate("fixture", undefined, w.options);
    expect(env).toMatchObject({
      HOME: w.home,
      CODEX_HOME: join(w.home, "codex-state"),
      XDG_CONFIG_HOME: join(w.home, "config"),
    });
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("RANDOM_SECRET");
    expect(receipt.progress).toHaveLength(40);
    expect(receipt.progress.join("\n")).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });
  it("awaits durable evidence before mutation and does not mutate if it is rejected", async () => {
    const w = world();
    executable(w.installed);
    let mutated = false;
    w.options.spawn = ((bin, args, opts) => {
      if (args[0] === "--version") return spawnSync(bin, args, opts);
      mutated = true;
      return result();
    }) as typeof spawnSync;
    const receipt = await runHarnessUpdate("fixture", undefined, {
      ...w.options,
      beforeMutation: async (evidence) => {
        expect(evidence).toMatchObject({
          phase: "installing",
          before: { version: "1.0.0" },
          commands: [{ binary: w.installed, args: ["update"] }],
        });
        throw new Error("store unavailable");
      },
    });
    expect(mutated).toBe(false);
    expect(receipt).toMatchObject({
      ok: false,
      mutation: "none",
      problem: { message: "store unavailable" },
    });
  });
  it("runs an installer used as update only for a different target read from its own bytes", async () => {
    const w = world();
    executable(w.installed, "2.0.0");
    w.program.platforms.darwin!.update = w.program.platforms.darwin!.install;
    w.program.platforms.darwin!.newest = {
      url: "https://example.invalid/install",
      pick: { kind: "pattern", pattern: "versions/([0-9.]+)" },
    };
    let executions = 0;
    w.options.spawn = ((bin, args, opts) => {
      if (args[0] === "--version") return spawnSync(bin, args, opts);
      executions++;
      executable(w.installed, "2.0.0");
      return result();
    }) as typeof spawnSync;
    const same = await runHarnessUpdate("fixture", undefined, w.options);
    expect(same).toMatchObject({ ok: true, outcome: "not_changed" });
    expect(executions).toBe(0);
    expect(same.commands[0]!.script).not.toBeNull();
    executable(w.installed, "1.0.0");
    expect((await runHarnessUpdate("fixture", undefined, w.options)).outcome).toBe("changed");
    expect(executions).toBe(1);
    w.program.platforms.darwin!.newest!.url = "https://example.invalid/different-source";
    expect((await runHarnessUpdate("fixture", undefined, w.options)).ok).toBe(false);
    expect(executions).toBe(1);
  });
  it("only a declared exact-version command can select an explicit target", async () => {
    const w = world();
    executable(w.installed);
    w.options.spawn = ((bin, args, opts) => {
      if (args[0] === "--version") return spawnSync(bin, args, opts);
      expect(args).toEqual(["update", "--version", "3.4.5"]);
      executable(w.installed, "3.4.5");
      return result();
    }) as typeof spawnSync;
    expect(await runHarnessUpdate("fixture", "3.4.5", w.options)).toMatchObject({
      ok: true,
      after: { version: "3.4.5" },
    });
    for (const target of ["previous", "baseline", "^3.0.0", "$(echo bad)"])
      expect((await runHarnessUpdate("fixture", target, w.options)).problem?.message).toContain(
        "--vendor-version",
      );
  });
});
