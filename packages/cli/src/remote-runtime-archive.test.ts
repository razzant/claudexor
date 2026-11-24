import { describe, expect, it } from "vitest";
import {
  copyTreeMaterialized,
  normalizedArchiveEntry,
  remoteRuntimeShellWrapper,
  validateArchiveListings,
  validateNodeBinaryTarget,
} from "../../../scripts/lib/remote-runtime-archive.mjs";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const required = [
  "./bin/claudexor",
  "./bin/claudexord",
  "./lib/claudexor.bundle.cjs",
  "./lib/claudexord.bundle.cjs",
  "./lib/setup-login-runner.cjs",
  "./lib/run-deadline-warden.cjs",
  "./lib/browser-mcp-runtime/index.cjs",
  "./node/bin/node",
  "./runtime.json",
];

describe("remote runtime archive safety", () => {
  it("accepts a complete regular-file/directory listing", () => {
    const names = ["./", ...required];
    const verbose = names.map((_, index) => `${index === 5 ? "d" : "-"}rwxr-xr-x row`).join("\n");
    expect(validateArchiveListings(names.join("\n"), verbose)).toHaveLength(required.length);
  });

  it("rejects traversal, duplicate, and link entries", () => {
    expect(() => normalizedArchiveEntry("../escape")).toThrow(/unsafe/);
    expect(() =>
      validateArchiveListings(
        [...required, required[0]].join("\n"),
        [...required, required[0]].map(() => "-rw-r--r-- row").join("\n"),
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      validateArchiveListings(
        required.join("\n"),
        required.map((_, index) => `${index === 0 ? "l" : "-"}rw-r--r-- row`).join("\n"),
      ),
    ).toThrow(/non-regular/);
    expect(() =>
      validateArchiveListings(
        ["./", "./", ...required].join("\n"),
        ["./", "./", ...required].map(() => "drwxr-xr-x row").join("\n"),
      ),
    ).toThrow(/duplicate root/);
    expect(() =>
      validateArchiveListings(
        ["./", ...required].join("\n"),
        ["lrwxr-xr-x row", ...required.map(() => "-rw-r--r-- row")].join("\n"),
      ),
    ).toThrow(/non-regular/);
  });

  it("binds Linux Node ELF architecture to the target", () => {
    const directory = mkdtempSync(join(tmpdir(), "claudexor-node-header-"));
    try {
      const path = join(directory, "node");
      const header = Buffer.alloc(32);
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header);
      header[4] = 2;
      header[5] = 1;
      header.writeUInt16LE(62, 18);
      writeFileSync(path, header);
      expect(() => validateNodeBinaryTarget(path, "linux-x64")).not.toThrow();
      expect(() => validateNodeBinaryTarget(path, "linux-arm64")).toThrow(/does not match/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("materializes contained package links and refuses external links", () => {
    const directory = mkdtempSync(join(tmpdir(), "claudexor-materialized-tree-"));
    try {
      const source = join(directory, "source");
      const target = join(source, "packages", "util");
      const destination = join(directory, "destination");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "index.js"), "export const ok = true;\n");
      symlinkSync("packages/util", join(source, "util"));

      copyTreeMaterialized(source, destination);
      expect(lstatSync(join(destination, "util")).isDirectory()).toBe(true);
      expect(lstatSync(join(destination, "util")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(destination, "util", "index.js"), "utf8")).toContain("ok");

      const outside = join(directory, "outside");
      mkdirSync(outside);
      symlinkSync("../outside", join(source, "escape"));
      expect(() => copyTreeMaterialized(source, join(directory, "refused"))).toThrow(/escapes/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("canonicalizes a runtime reached through the current symlink", () => {
    const directory = mkdtempSync(join(tmpdir(), "claudexor-runtime-wrapper-"));
    try {
      const runtime = join(directory, "versions", "v1");
      const bin = join(runtime, "bin");
      mkdirSync(bin, { recursive: true });
      const wrapper = join(bin, "probe");
      writeFileSync(
        wrapper,
        remoteRuntimeShellWrapper('printf "%s\\n%s\\n" "$RUNTIME_DIR" "$CLAUDEXOR_REMOTE_RUNTIME"'),
        { mode: 0o755 },
      );
      symlinkSync("versions/v1", join(directory, "current"));

      const reported = execFileSync(join(directory, "current", "bin", "probe"), {
        encoding: "utf8",
      })
        .trim()
        .split("\n");
      expect(reported[0]).toBe(realpathSync(runtime));
      expect(reported[0]).not.toContain("/current");
      expect(reported[1]).toBe("1");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
