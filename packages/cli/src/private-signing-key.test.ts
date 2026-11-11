import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPrivateSigningKey } from "../../../scripts/lib/private-signing-key.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function fixture(): { key: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "claudexor-signing-key-"));
  roots.push(root);
  const key = join(root, "offline.pem");
  writeFileSync(key, "test-key-bytes", { mode: 0o600 });
  return { key, root };
}

describe("offline private signing-key reads", () => {
  it("reads a same-user regular 0600 file", () => {
    const { key } = fixture();
    expect(readPrivateSigningKey(key)).toBe("test-key-bytes");
  });

  it("refuses group-readable keys and symlink aliases", () => {
    const { key, root } = fixture();
    chmodSync(key, 0o640);
    expect(() => readPrivateSigningKey(key)).toThrow(/exactly 0600/);
    chmodSync(key, 0o600);
    const alias = join(root, "alias.pem");
    symlinkSync(key, alias);
    expect(() => readPrivateSigningKey(alias)).toThrow(/symlink/);
  });

  it("refuses non-regular files", () => {
    const { root } = fixture();
    expect(() => readPrivateSigningKey(root)).toThrow(/regular file/);
  });
});

describe("runtime-manifest signing CLI inputs", () => {
  const script = join(process.cwd(), "scripts/sign-runtime-manifest.mjs");
  const base = [
    script,
    "--in",
    "missing-input.json",
    "--private-key",
    "missing-key.pem",
    "--authority",
    "missing-authority.json",
    "--out",
    "missing-output.json",
  ];

  it("requires an explicit promoted-artifact SHA-256", () => {
    const result = spawnSync(process.execPath, base, { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("missing --sha256");
  });

  it("refuses a digest that is not exactly lowercase hexadecimal", () => {
    const result = spawnSync(process.execPath, [...base, "--sha256", "A".repeat(64)], {
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("exactly 64 lowercase hexadecimal");
  });
});
