import {
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  runProofNpm,
  assertNativeRunSelection,
  verifyVendorUpdateRefusal,
} from "./vendor-program-smoke.mjs";
import { defineHarnessProgram } from "../../packages/core/dist/index.js";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "npm-proof-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);

test("maintenance proof reselects changed programs and compares the final receipt without running a session", async () => {
  const cwd = fixture(),
    bin = join(cwd, process.platform === "win32" ? "fixture.exe" : "fixture");
  const marker = join(cwd, "unexpected-child");
  const image = Buffer.alloc(512);
  image.write("MZ");
  image.writeUInt32LE(128, 60);
  image.write("PE\0\0", 128);
  writeFileSync(bin, process.platform === "win32" ? image : `#!/bin/sh\necho ran > '${marker}'\n`, {
    mode: 0o755,
  });
  const program = defineHarnessProgram({
    id: "proof-fixture",
    overrideEnv: "PROOF_FIXTURE_BIN",
    launchers: [{ name: "fixture" }],
    installationEnv: [],
    platforms: { [process.platform]: { launcherDirs: ["{home}/vendor"] } },
  });
  const env = { HOME: cwd, PATH: cwd };
  expect(await assertNativeRunSelection(program, { path: bin }, env, cwd)).toBe(bin);
  await expect(
    assertNativeRunSelection(program, { path: join(cwd, "another") }, env, cwd),
  ).rejects.toThrow("Native run selection differs");
  const next = join(cwd, "vendor", process.platform === "win32" ? "fixture.exe" : "fixture");
  mkdirSync(join(cwd, "vendor"));
  copyFileSync(bin, next);
  rmSync(bin);
  // Update/conversion can change which entry a run will select. Checking the
  // earlier Install receipt must fail; the final receipt must agree.
  await expect(assertNativeRunSelection(program, { path: bin }, env, cwd)).rejects.toThrow(
    "Native run selection differs",
  );
  expect(await assertNativeRunSelection(program, { path: next }, env, cwd)).toBe(next);
  expect(existsSync(marker)).toBe(false);
});

test.each([0, 1, null])(
  "only a direct nonzero exit confirms a vendor refusal (direct exit %s)",
  (status) => {
    const command = { binary: "/vendor/codex", args: ["update"], env: {}, script: null };
    const receipt = { commands: [command] };
    const spawn = vi.fn(() => ({
      status,
      stdout: "direct vendor output",
      stderr: "",
      ...(status === null
        ? { error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) }
        : {}),
    }));
    const env = {
      OS: "Windows_NT",
      PROCESSOR_ARCHITECTURE: "AMD64",
      PATH: "/runner",
      DYLD_LIBRARY_PATH: "/runner-libraries",
    };
    const run = () => verifyVendorUpdateRefusal(receipt, env, { cwd: fixture(), spawn });
    if (status === 1) expect(run()).toEqual({ exitCode: 1, progress: "direct vendor output" });
    else expect(run).toThrow("direct vendor refusal was not confirmed");
    expect(spawn.mock.calls[0][0]).toBe(command.binary);
    expect(spawn.mock.calls[0][1]).toEqual(command.args);
    expect(spawn.mock.calls[0][2].env).toEqual(env);
  },
);

test("Windows runs the bundled JS entry, bypasses npm.cmd and preserves argument boundaries", () => {
  const cwd = fixture();
  const nodeDir = join(cwd, "Node with spaces");
  const npmDir = join(nodeDir, "node_modules/npm/bin");
  mkdirSync(npmDir, { recursive: true });
  const execPath = join(nodeDir, "node.exe");
  copyFileSync(process.execPath, execPath, constants.COPYFILE_FICLONE);
  writeFileSync(join(nodeDir, "npm.cmd"), "@echo wrong entry\r\n@exit /b 99\r\n");
  writeFileSync(
    join(npmDir, "npm-cli.js"),
    `if (process.argv.includes('--fail')) { console.error('npm refused'); process.exit(7); }
process.stdout.write(JSON.stringify(process.argv.slice(2)));`,
  );
  const env = { ...process.env, PATH: nodeDir };
  const options = { cwd, platform: "win32", execPath };
  const args = ["install", "--prefix", join(cwd, "prefix with spaces"), "literal&%PATH%"];
  expect(JSON.parse(runProofNpm(env, args, options))).toEqual(args);
  expect(() => runProofNpm(env, ["--fail"], options)).toThrow(/exit 7\).*npm refused/s);
});

test("a real spawn failure reports its error instead of undefined output", () => {
  const cwd = fixture();
  let failure;
  try {
    runProofNpm({}, ["view", "fixture", "versions", "--json"], {
      cwd,
      platform: "win32",
      execPath: join(cwd, "missing-node.exe"),
    });
  } catch (error) {
    failure = error;
  }
  expect(failure?.message).toMatch(
    /npm view fixture versions --json failed \(exit null, .*ENOENT/s,
  );
  expect(failure?.message).not.toContain("undefined");
});

test("POSIX keeps the npm command resolver and argument vector without a shell", () => {
  const spawn = vi.fn(() => ({ status: 0, stdout: "[]", stderr: "" }));
  const args = ["view", "fixture", "versions", "--json"];
  expect(runProofNpm({ PATH: "" }, args, { cwd: fixture(), platform: "linux", spawn })).toBe("[]");
  expect(spawn.mock.calls[0][0]).toBe("npm");
  expect(spawn.mock.calls[0][1]).toEqual(args);
  expect(spawn.mock.calls[0][2].shell).toBeUndefined();
});
