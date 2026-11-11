import { constants, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { runProofNpm } from "./vendor-program-smoke.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "npm-proof-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);

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
