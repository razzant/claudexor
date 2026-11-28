import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { packWithSourceModes } from "./pack-with-modes.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const read = (root, path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const skill = "skills/claudexor/SKILL.md";
const canonical = join(repo, "plugins/copilot");

function files(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + entry.name;
    return entry.isDirectory() ? files(root, path + "/") : [path];
  });
}

test.each([
  ["plugins/hermes", "plugin.json", "mcp.json"],
  ["plugins/claude", ".claude-plugin/plugin.json", ".mcp.json"],
])("%s ships exactly the installable bundle", (bundle, manifest, mcp) => {
  const root = join(repo, bundle);
  const expected = [manifest, mcp, "LICENSE", "README.md", skill];
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "."], {
    cwd: root,
    encoding: "utf8",
  });
  expect(tracked.split("\0").filter(Boolean).sort()).toEqual(expected.sort());
  for (const path of expected) expect(readFileSync(join(root, path)).length).toBeGreaterThan(0);
  expect(read(root, manifest).license).toBe("MIT");
});

test("Pi can load the packaged extension and skill with only its native registration API", async () => {
  const work = mkdtempSync(join(tmpdir(), "claudexor-pi-pack-"));
  try {
    const source = join(work, "source");
    cpSync(join(repo, "packages/claudexor"), source, {
      recursive: true,
      filter: (path) => basename(path) !== "node_modules",
    });
    // pnpm pack reads the installed workspace dependency's manifest to replace workspace:*.
    const cli = join(source, "node_modules/@claudexor/cli");
    mkdirSync(cli, { recursive: true });
    cpSync(join(repo, "packages/cli/package.json"), join(cli, "package.json"));
    const tarball = packWithSourceModes(source, work, { omitMacMetadata: true });
    // The release verifier uses /usr/bin/tar. Pi registration is checked on every platform.
    if (process.platform !== "win32") {
      execFileSync(process.execPath, [
        join(repo, "scripts/verify-npm-claudexor-package.mjs"),
        "--tarball",
        tarball,
      ]);
    }
    execFileSync("tar", ["-xzf", tarball, "-C", work]);
    const packed = join(work, "package");
    const pkg = read(packed, "package.json");
    expect(pkg.name).toBe("claudexor");
    expect(pkg.dependencies).toEqual({
      "@claudexor/cli": read(repo, "packages/cli/package.json").version,
    });
    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.pi.extensions).toHaveLength(1);
    expect(pkg.pi.skills).toHaveLength(1);
    const entry = join(packed, pkg.pi.extensions[0]);
    const calls = [];
    const { default: register } = await import(pathToFileURL(entry).href);
    register({ registerMcpServer: (...args) => calls.push(args) });
    expect(calls).toEqual([
      [
        "claudexor",
        {
          ...read(canonical, ".mcp.json").mcpServers.claudexor,
          description:
            "Local Claudexor control plane: runs, plans and answers on Claude Code, Codex, Cursor and OpenCode accounts.",
          toolExposure: {
            claudexor_ask: "direct",
            claudexor_run_wait: "direct",
            claudexor_run_status: "direct",
            claudexor_run_result: "direct",
          },
        },
      ],
    ]);
    // portable-plugins.test.mjs proves this Skill is composed from the shared one; packing keeps its bytes.
    expect(readFileSync(join(packed, pkg.pi.skills[0], "claudexor/SKILL.md"))).toEqual(
      readFileSync(join(repo, "packages/claudexor/pi", skill)),
    );
    expect(files(join(packed, "pi")).sort()).toEqual(["index.js", "mcp.json", skill]);
    expect(readFileSync(join(packed, pkg.bin.claudexor), "utf8")).toContain("@claudexor/cli/cli");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
