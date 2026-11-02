import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import {
  BETTERLEAKS_RELEASES,
  BETTERLEAKS_VERSION,
} from "../../packages/delivery/src/publication-scanner-pin.ts";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "provision-betterleaks.mjs");
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // Synchronous removal: successful completion has no elapsed-time requirement (#376).
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "provision-betterleaks-"));
  roots.push(root);
  return root;
};
const run = (args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
const key = "linux-x64";

// Everything here is offline: the genuine archive is proved by CI's own
// provisioning step and by the installed-CLI consumer run.

test("--dest keeps the old file and license when the archive is not the pin", () => {
  const root = temp();
  const dest = join(root, "betterleaks");
  writeFileSync(dest, "an older build\n");
  writeFileSync(join(root, "LICENSE"), "its license\n");
  const archive = join(root, "archive.tar.gz");
  writeFileSync(archive, "not the pinned archive");
  const result = run(["--dest", dest, "--platform", key, "--from-archive", archive]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/provisioning failed: .*archive digest/);
  expect(readFileSync(dest, "utf8")).toBe("an older build\n");
  expect(readFileSync(join(root, "LICENSE"), "utf8")).toBe("its license\n");
  expect(readdirSync(root).sort()).toEqual(["LICENSE", "archive.tar.gz", "betterleaks"]);
});

test("--from-archive refuses an archive that is not the pin and activates nothing", () => {
  const root = temp();
  const archive = join(root, "archive.tar.gz");
  writeFileSync(archive, "not the pinned archive");
  const dest = join(root, "bin", "betterleaks");
  const result = run(["--dest", dest, "--platform", key, "--from-archive", archive]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/archive digest/);
  expect(existsSync(dest)).toBe(false);
  expect(existsSync(join(root, "bin", "LICENSE"))).toBe(false);
});

test("without --dest it provisions the config-root copy the pin names", () => {
  const root = temp();
  const dir = join(root, "tools", "betterleaks", BETTERLEAKS_VERSION, key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, BETTERLEAKS_RELEASES[key].binary), "not the build\n");
  const result = run(["--platform", key, "--from-archive", join(root, "not-read.tar.gz")], {
    CLAUDEXOR_CONFIG_DIR: root,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(dir);
  expect(readFileSync(join(dir, BETTERLEAKS_RELEASES[key].binary), "utf8")).toBe("not the build\n");
});

test("--stage still proves every archive named by --archives-dir", () => {
  const root = temp();
  const archives = join(root, "archives");
  mkdirSync(archives);
  writeFileSync(join(archives, BETTERLEAKS_RELEASES[key].asset), "not the pinned archive");
  const result = run([
    "--stage",
    join(root, "native"),
    "--platforms",
    key,
    "--archives-dir",
    archives,
  ]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/archive digest/);
  expect(existsSync(join(root, "native", "betterleaks", key))).toBe(false);
});
