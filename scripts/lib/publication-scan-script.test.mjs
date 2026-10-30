import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { locateScanner } from "../../packages/delivery/src/publication-scanner-pin.ts";

// The repository CI/release publication scan (scripts/publication-scan.mjs)
// with the pinned scanner: commit messages of the range and an explicit
// annotated tag's message are scanned too (INV-146). Throwaway repositories
// only; the token-shaped value is assembled at runtime.
const script = fileURLToPath(new URL("../publication-scan.mjs", import.meta.url));
const pinned = locateScanner({ env: process.env, configDir: null });
const token = `ghp_${"q7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Yc2Ae9U"}`;
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), "publication-scan-script-"));
  roots.push(root);
  const g = (...args) =>
    execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      encoding: "utf8",
    }).trim();
  g("init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "base\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  return { root, g, base: g("rev-parse", "HEAD") };
}
const runScan = (root, args) =>
  spawnSync(process.execPath, [script, "--repo", root, ...args], {
    encoding: "utf8",
    env: process.env,
  });

describe.runIf(pinned.ok && process.platform !== "win32")(
  "repository publication scan script",
  () => {
    it("refuses a credential in a commit message of the range; a clean message passes", () => {
      const r = repo();
      writeFileSync(join(r.root, "b.txt"), "b\n");
      r.g("add", "-A");
      r.g("commit", "-qm", "ordinary change");
      const clean = runScan(r.root, ["--range", `${r.base}..HEAD`, "--tree", "HEAD"]);
      expect(clean.status, clean.stderr).toBe(0);
      writeFileSync(join(r.root, "c.txt"), "c\n");
      r.g("add", "-A");
      r.g("commit", "-qm", `rotate ${token}`);
      const sha = r.g("rev-parse", "HEAD");
      const found = runScan(r.root, ["--range", `${r.base}..HEAD`, "--tree", "HEAD"]);
      expect(found.status).toBe(1);
      expect(found.stderr).toContain(`commit message ${sha.slice(0, 12)}`);
      expect(found.stderr + found.stdout).not.toContain(token);
    });

    it("never prints a detected secret through a file name or tag name", () => {
      const r = repo();
      writeFileSync(join(r.root, `config-${token}.txt`), `token = "${token}"\n`);
      r.g("add", "-A");
      r.g("commit", "-qm", "fixture");
      r.g("tag", "-a", `release-${token}`, "-m", `Release notes ${token}`);
      const found = runScan(r.root, [
        "--range",
        `${r.base}..HEAD`,
        "--tree",
        "HEAD",
        "--tag",
        `release-${token}`,
      ]);
      expect(found.status).toBe(1);
      expect(found.stderr).toContain("::error::publication scan found");
      expect(found.stderr).toMatch(/github-pat in withheld location \(sha256 [0-9a-f]{12}\)/);
      expect((found.stderr + found.stdout).includes(token), "output repeats the value").toBe(false);
    });

    it("does not echo an unreadable tag argument in its failure diagnostic", () => {
      const r = repo();
      const found = runScan(r.root, ["--range", `${r.base}..HEAD`, "--tag", `release-${token}`]);
      expect(found.status).toBe(1);
      expect(found.stderr).toContain("selected release tag cannot be read");
      expect((found.stderr + found.stdout).includes(token), "failure repeats the argument").toBe(
        false,
      );
    });

    it("refuses a credential in the message of an explicit annotated tag; a clean tag passes", () => {
      const r = repo();
      r.g("tag", "-a", "v1.0.0", "-m", "Release notes without secrets");
      const clean = runScan(r.root, [
        "--range",
        `${r.base}..HEAD`,
        "--tree",
        "HEAD",
        "--tag",
        "v1.0.0",
      ]);
      expect(clean.status, clean.stderr).toBe(0);
      r.g("tag", "-a", "v1.0.1", "-m", `Release notes ${token}`);
      const found = runScan(r.root, [
        "--range",
        `${r.base}..HEAD`,
        "--tree",
        "HEAD",
        "--tag",
        "v1.0.1",
      ]);
      expect(found.status).toBe(1);
      expect(found.stderr).toContain("tag v1.0.1 message");
      expect(found.stderr + found.stdout).not.toContain(token);
    });

    it("refuses typed when the named tag does not exist", () => {
      const r = repo();
      const missing = runScan(r.root, [
        "--range",
        `${r.base}..HEAD`,
        "--tree",
        "HEAD",
        "--tag",
        "v9.9.9",
      ]);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("selected release tag cannot be read");
    });
  },
);
