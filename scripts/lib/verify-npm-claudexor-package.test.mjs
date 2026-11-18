import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const releaseTest = test.skipIf(process.platform === "win32");

releaseTest("the wrapper verifier rejects unlisted Pi files", () => {
  const source = fileURLToPath(new URL("../../packages/claudexor/", import.meta.url));
  const verifier = fileURLToPath(new URL("../verify-npm-claudexor-package.mjs", import.meta.url));
  const work = mkdtempSync(join(tmpdir(), "claudexor-wrapper-test-"));
  const root = join(work, "package");
  const archive = join(work, "fixture.tgz");
  const verify = () => {
    execFileSync("/usr/bin/tar", ["-czf", archive, "-C", work, "package"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    return spawnSync(process.execPath, [verifier, "--tarball", archive], { encoding: "utf8" });
  };
  try {
    mkdirSync(root);
    for (const path of ["README.md", "LICENSE", "bin", "pi"]) {
      cpSync(join(source, path), join(root, path), { recursive: true });
    }
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    manifest.version = "9.8.7";
    manifest.dependencies["@claudexor/cli"] = manifest.version;
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    const accepted = verify();
    expect(accepted.status, accepted.stderr).toBe(0);

    for (const extra of ["pi/extra.js", "pi/._index.js"]) {
      writeFileSync(join(root, extra), "");
      const rejected = verify();
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain(`package/${extra}`);
      rmSync(join(root, extra));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
