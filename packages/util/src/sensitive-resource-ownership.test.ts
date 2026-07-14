import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const gate = resolve("scripts/sensitive-resource-ownership-check.mjs");

describe("sensitive-resource ownership gate", () => {
  it("rejects a second path/content classifier and accepts a policy consumer", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-sensitive-owner-"));
    const source = join(root, "packages", "rogue", "src", "filter.ts");
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(
      source,
      [
        'const BLOCKED = ["**/.env", "**/*.key"];',
        "const LOCAL_REDACTION = [/ghp_[a-z]+/g, /Bearer [a-z]+/g];",
        "export { BLOCKED, LOCAL_REDACTION };",
      ].join("\n"),
    );

    try {
      const rejected = spawnSync(process.execPath, [gate, "--root", root], { encoding: "utf8" });
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain("sensitive path marker cluster");
      expect(rejected.stderr).toContain("secret content-signature cluster");

      writeFileSync(
        source,
        'import { sensitiveResourcePolicy } from "@claudexor/util";\nexport const decision = sensitiveResourcePolicy.classifyPath("input");\n',
      );
      const accepted = spawnSync(process.execPath, [gate, "--root", root], { encoding: "utf8" });
      expect(accepted.status).toBe(0);
      expect(accepted.stdout).toContain("sensitive-resource-ownership: OK");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
